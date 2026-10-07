import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ConnectionData, NodeExecuteContext, NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { Item, JsonObject } from '../types.js';
import { resolveAllowedPath } from './files-disk.js';
import { bool, errMessage, num, str } from './values.js';

/**
 * Git: clona, puxa, faz commit e push em repositórios numa pasta liberada do servidor (FILES_DIRS),
 * como o nó Git do n8n. Usa o git instalado no servidor.
 */

export const GIT_CONNECTION_TYPES = ['gitPassword'];

/**
 * Configurações que o repositório não consegue mudar: sem hooks, sem fsmonitor, sem protocolo ext::
 * e sem pedir senha no terminal. Valem em todo comando.
 */
const SAFE_CONFIG = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.pager=cat',
  'core.sshCommand=ssh -o BatchMode=yes',
  'protocol.ext.allow=never',
  'safe.bareRepository=explicit',
  'credential.helper=',
  // Pastas montadas no Docker costumam ter outro dono; o caminho já foi conferido em FILES_DIRS.
  'safe.directory=*',
];

/** Chaves que a operação "Adicionar configuração" aceita (as outras poderiam rodar comandos). */
const CONFIG_ALLOWED =
  /^(user\.(name|email)|remote\.[^.\s]+\.(url|pushurl|fetch)|branch\.[^.\s]+\.(remote|merge|rebase)|pull\.(rebase|ff)|push\.(default|autosetupremote)|init\.defaultbranch|core\.autocrlf|commit\.gpgsign|fetch\.prune)$/i;

const MAX_OUTPUT = 64 * 1024 * 1024;

interface GitRun {
  stdout: string;
  stderr: string;
}

/** Recusa valores que o git leria como opção (ex.: "--upload-pack=..."). */
function notOption(value: string, what: string): string {
  if (value.startsWith('-')) throw new NodeOperationError(`${what} não pode começar com "-": ${value}`);
  return value;
}

/** Cabeçalho de login para endereços http(s); fica só na linha de comando, nunca no .git/config. */
function authConfig(connection: ConnectionData | null): string[] {
  if (!connection) return [];
  const user = str(connection.data.username);
  const password = str(connection.data.password);
  if (!user && !password) return [];
  return [`http.extraHeader=Authorization: Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`];
}

function git(args: string[], options: { cwd: string; connection: ConnectionData | null; signal: AbortSignal }): Promise<GitRun> {
  const config = [...SAFE_CONFIG, ...authConfig(options.connection)].flatMap((c) => ['-c', c]);
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...config, ...args],
      {
        cwd: options.cwd,
        maxBuffer: MAX_OUTPUT,
        signal: options.signal,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout: String(stdout), stderr: String(stderr) });
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new NodeOperationError('O git não está instalado no servidor do Info8n'));
        }
        // A mensagem não traz os argumentos: eles podem ter o cabeçalho de login.
        const detail = String(stderr).trim() || String(stdout).trim() || errMessage(error).split('\n').pop();
        reject(new NodeOperationError(`O git falhou (${args[0]}): ${detail?.replace(/Authorization: Basic \S+/g, 'Authorization: Basic ***')}`));
      },
    );
  });
}

const list = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Saída do "git status --porcelain=v1 -b" no formato do simple-git, que o n8n usa. */
export function parseStatus(output: string): JsonObject {
  const status = {
    not_added: [] as string[],
    conflicted: [] as string[],
    created: [] as string[],
    deleted: [] as string[],
    modified: [] as string[],
    renamed: [] as JsonObject[],
    files: [] as JsonObject[],
    staged: [] as string[],
    ahead: 0,
    behind: 0,
    current: null as string | null,
    tracking: null as string | null,
    detached: false,
  };
  for (const line of output.split('\n')) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      const m = head.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
      const branch = m?.[1] ?? head;
      if (branch.startsWith('HEAD (no branch)')) status.detached = true;
      status.current = branch.replace(/^No commits yet on /, '');
      status.tracking = m?.[2] ?? null;
      const ahead = m?.[3]?.match(/ahead (\d+)/);
      const behind = m?.[3]?.match(/behind (\d+)/);
      status.ahead = ahead ? Number(ahead[1]) : 0;
      status.behind = behind ? Number(behind[1]) : 0;
      continue;
    }
    const index = line[0]!;
    const workingDir = line[1]!;
    let file = line.slice(3);
    let from: string | undefined;
    if (file.includes(' -> ')) [from, file] = file.split(' -> ') as [string, string];
    status.files.push({ path: file, index, working_dir: workingDir, ...(from ? { from } : {}) });
    if (index === '?' && workingDir === '?') status.not_added.push(file);
    else if (index === 'U' || workingDir === 'U' || (index === 'A' && workingDir === 'A') || (index === 'D' && workingDir === 'D')) status.conflicted.push(file);
    else {
      if (index === 'A') status.created.push(file);
      if (index === 'D' || workingDir === 'D') status.deleted.push(file);
      if (index === 'M' || workingDir === 'M') status.modified.push(file);
      if (index === 'R' && from) status.renamed.push({ from, to: file });
      if (index !== ' ' && index !== '?') status.staged.push(file);
    }
  }
  return status as unknown as JsonObject;
}

const LOG_SEPARATOR = '\x1e';
const FIELD_SEPARATOR = '\x1f';

/** Commits do "git log", com os campos do simple-git (hash, date, message, refs, body, author_name, author_email). */
export function parseLog(output: string): JsonObject[] {
  return output
    .split(LOG_SEPARATOR)
    .map((entry) => entry.replace(/^\n/, ''))
    .filter((entry) => entry.trim())
    .map((entry) => {
      const [hash, date, message, refs, body, authorName, authorEmail] = entry.split(FIELD_SEPARATOR);
      return {
        hash: hash ?? '',
        date: date ?? '',
        message: message ?? '',
        refs: refs ?? '',
        body: (body ?? '').trim(),
        author_name: authorName ?? '',
        author_email: (authorEmail ?? '').trim(),
      };
    });
}

const OPERATIONS = [
  { name: 'Adicionar arquivos (add)', value: 'add' },
  { name: 'Adicionar configuração', value: 'addConfig' },
  { name: 'Clonar', value: 'clone' },
  { name: 'Commit', value: 'commit' },
  { name: 'Buscar do remoto (fetch)', value: 'fetch' },
  { name: 'Listar configuração', value: 'listConfig' },
  { name: 'Histórico (log)', value: 'log' },
  { name: 'Puxar (pull)', value: 'pull' },
  { name: 'Enviar (push)', value: 'push' },
  { name: 'Enviar tags', value: 'pushTags' },
  { name: 'Situação (status)', value: 'status' },
  { name: 'Trocar de branch', value: 'switchBranch' },
  { name: 'Criar tag', value: 'tag' },
  { name: 'Configurar usuário', value: 'userSetup' },
];

const op = (...operations: string[]) => ({ operation: operations });

async function runOperation(ctx: NodeExecuteContext, i: number, connection: ConnectionData | null): Promise<Item[]> {
  const operation = str(await ctx.getParam('operation', i), 'status');
  const repoParam = str(await ctx.getParam('repositoryPath', i)).trim();
  if (!repoParam) throw new NodeOperationError('Informe a pasta do repositório');
  const repo = await resolveAllowedPath(repoParam, ctx.filesDirs);
  const run = (args: string[], cwd = repo) => git(args, { cwd, connection, signal: ctx.signal });
  const success: Item[] = [{ json: { success: true } }];

  switch (operation) {
    case 'clone': {
      const source = notOption(str(await ctx.getParam('sourceRepository', i)).trim(), 'O repositório de origem');
      if (!source) throw new NodeOperationError('Informe o repositório de origem');
      await mkdir(path.dirname(repo), { recursive: true });
      await run(['clone', '--', source, repo], path.dirname(repo));
      return success;
    }
    case 'add': {
      const paths = list(str(await ctx.getParam('pathsToAdd', i)));
      if (!paths.length) throw new NodeOperationError('Informe os arquivos a adicionar (ex.: README.md, pasta/ ou .)');
      await run(['add', '--', ...paths]);
      return success;
    }
    case 'addConfig': {
      const key = str(await ctx.getParam('key', i)).trim();
      const value = str(await ctx.getParam('value', i));
      if (!CONFIG_ALLOWED.test(key)) {
        throw new NodeOperationError(
          `A configuração "${key}" não pode ser mudada pelo nó. Aceitas: user.name, user.email, remote.<nome>.url, branch.<nome>.remote/merge/rebase, pull.rebase, pull.ff, push.default, push.autoSetupRemote, init.defaultBranch, core.autocrlf, commit.gpgsign e fetch.prune.`,
        );
      }
      const mode = str(await ctx.getParam('mode', i), 'set');
      await run(['config', ...(mode === 'append' ? ['--add'] : []), key, value]);
      return success;
    }
    case 'listConfig': {
      const { stdout } = await run(['config', '--list']);
      // Só a configuração do repositório e do usuário; nada do login.
      return stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf('=');
          return { json: { _key: at < 0 ? line : line.slice(0, at), _value: at < 0 ? '' : line.slice(at + 1) } };
        })
        .filter((item) => !/extraheader|password|token/i.test(String(item.json._key)));
    }
    case 'commit': {
      const message = str(await ctx.getParam('message', i));
      if (!message.trim()) throw new NodeOperationError('Informe a mensagem do commit');
      const paths = list(str(await ctx.getParam('pathsToAdd', i)));
      if (paths.length) await run(['add', '--', ...paths]);
      await run(['commit', '-m', message, ...(paths.length ? ['--', ...paths] : [])]);
      return success;
    }
    case 'fetch':
      await run(['fetch']);
      return success;
    case 'pull':
      await run(['pull']);
      return success;
    case 'push': {
      const target = str(await ctx.getParam('targetRepository', i)).trim();
      const branch = str(await ctx.getParam('branch', i)).trim();
      const args = ['push'];
      if (target || branch) args.push('--', target ? notOption(target, 'O repositório de destino') : 'origin');
      if (branch) args.push(notOption(branch, 'A branch'));
      await run(args);
      return success;
    }
    case 'pushTags':
      await run(['push', '--tags']);
      return success;
    case 'tag': {
      const name = notOption(str(await ctx.getParam('name', i)).trim(), 'O nome da tag');
      if (!name) throw new NodeOperationError('Informe o nome da tag');
      await run(['tag', name]);
      return success;
    }
    case 'status': {
      const { stdout } = await run(['status', '--porcelain=v1', '-b']);
      return [{ json: parseStatus(stdout) }];
    }
    case 'log': {
      const returnAll = bool(await ctx.getParam('returnAll', i));
      const limit = Math.max(1, Math.trunc(num(await ctx.getParam('limit', i), 100)));
      const file = str(await ctx.getParam('file', i)).trim();
      const format = ['%H', '%aI', '%s', '%D', '%b', '%an', '%ae'].join(FIELD_SEPARATOR);
      const args = ['log', `--format=${LOG_SEPARATOR}${format}`, ...(returnAll ? [] : [`-n${limit}`])];
      if (file) args.push('--', file);
      const { stdout } = await run(args);
      return parseLog(stdout).map((json) => ({ json }));
    }
    case 'switchBranch': {
      const branch = notOption(str(await ctx.getParam('branchName', i)).trim(), 'A branch');
      if (!branch) throw new NodeOperationError('Informe a branch');
      const create = bool(await ctx.getParam('createBranch', i));
      const startPoint = str(await ctx.getParam('startPoint', i)).trim();
      const args = ['switch', ...(create ? ['-c', branch] : [branch])];
      if (create && startPoint) args.push(notOption(startPoint, 'O ponto de partida'));
      await run(args);
      return success;
    }
    case 'userSetup': {
      const name = str(await ctx.getParam('userName', i)).trim();
      const email = str(await ctx.getParam('userEmail', i)).trim();
      if (!name && !email) throw new NodeOperationError('Informe o nome ou o e-mail do usuário');
      if (name) await run(['config', 'user.name', name]);
      if (email) await run(['config', 'user.email', email]);
      return success;
    }
    default:
      throw new NodeOperationError(`Operação desconhecida: ${operation}`);
  }
}

export const gitNode: NodeType = {
  description: {
    type: 'git',
    displayName: 'Git',
    description: 'Clona, puxa, faz commit e push em repositórios Git numa pasta liberada do servidor (FILES_DIRS).',
    group: 'action',
    inputs: 1,
    outputs: 1,
    defaultTimeoutMs: 600_000,
    properties: [
      {
        name: 'authentication',
        displayName: 'Login',
        type: 'options',
        default: 'none',
        options: [
          { name: 'Sem login', value: 'none' },
          { name: 'Usuário e senha (ou token)', value: 'gitPassword' },
        ],
        description: 'O login vale para endereços http(s). Para GitHub e GitLab, use um token no lugar da senha.',
      },
      { name: 'connection', displayName: 'Conexão Git', type: 'connection', default: '', required: true, connectionTypes: GIT_CONNECTION_TYPES, showWhen: { authentication: ['gitPassword'] } },
      { name: 'operation', displayName: 'Operação', type: 'options', default: 'status', options: OPERATIONS },
      {
        name: 'repositoryPath',
        displayName: 'Pasta do repositório',
        type: 'string',
        default: '',
        required: true,
        placeholder: '/files/repositorio',
        description: 'Pasta dentro de FILES_DIRS. No Clonar, a pasta que vai ser criada.',
      },
      { name: 'sourceRepository', displayName: 'Repositório de origem', type: 'string', default: '', required: true, placeholder: 'https://github.com/empresa/projeto.git', showWhen: op('clone') },
      {
        name: 'pathsToAdd',
        displayName: 'Arquivos',
        type: 'string',
        default: '',
        placeholder: 'README.md, relatorios/',
        description: 'Separados por vírgula. No Commit, vazio faz o commit do que já foi adicionado.',
        showWhen: op('add', 'commit'),
      },
      { name: 'message', displayName: 'Mensagem', type: 'string', default: '', required: true, multiline: true, showWhen: op('commit') },
      { name: 'key', displayName: 'Chave', type: 'string', default: '', required: true, placeholder: 'user.email', showWhen: op('addConfig') },
      { name: 'value', displayName: 'Valor', type: 'string', default: '', showWhen: op('addConfig') },
      {
        name: 'mode',
        displayName: 'Modo',
        type: 'options',
        default: 'set',
        options: [
          { name: 'Trocar o valor', value: 'set' },
          { name: 'Acrescentar outro valor', value: 'append' },
        ],
        showWhen: op('addConfig'),
      },
      { name: 'returnAll', displayName: 'Trazer todos', type: 'boolean', default: false, showWhen: op('log') },
      { name: 'limit', displayName: 'Quantidade', type: 'number', default: 100, showWhen: { operation: ['log'], returnAll: [false] } },
      { name: 'file', displayName: 'Só deste arquivo', type: 'string', default: '', showWhen: op('log') },
      { name: 'targetRepository', displayName: 'Repositório de destino', type: 'string', default: '', placeholder: 'origin', description: 'Vazio: o remoto configurado.', showWhen: op('push') },
      { name: 'branch', displayName: 'Branch', type: 'string', default: '', description: 'Vazio: a branch atual.', showWhen: op('push') },
      { name: 'name', displayName: 'Nome da tag', type: 'string', default: '', required: true, placeholder: 'v1.0.0', showWhen: op('tag') },
      { name: 'branchName', displayName: 'Branch', type: 'string', default: '', required: true, showWhen: op('switchBranch') },
      { name: 'createBranch', displayName: 'Criar a branch', type: 'boolean', default: false, showWhen: op('switchBranch') },
      { name: 'startPoint', displayName: 'A partir de', type: 'string', default: '', placeholder: 'origin/main', showWhen: { operation: ['switchBranch'], createBranch: [true] } },
      { name: 'userName', displayName: 'Nome', type: 'string', default: '', showWhen: op('userSetup') },
      { name: 'userEmail', displayName: 'E-mail', type: 'string', default: '', showWhen: op('userSetup') },
    ],
  },

  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const out: Item[] = [];
    for (let i = 0; i < input.length; i++) {
      let connection: ConnectionData | null = null;
      if (str(await ctx.getParam('authentication', i), 'none') === 'gitPassword') {
        const id = str(await ctx.getParam('connection', i));
        if (!id) throw new NodeOperationError('Escolha a conexão Git');
        connection = await ctx.getConnection(id);
        if (!GIT_CONNECTION_TYPES.includes(connection.type)) throw new NodeOperationError('A conexão escolhida não é do tipo Git');
      }
      out.push(...(await runOperation(ctx, i, connection)));
    }
    return [out];
  },
};
