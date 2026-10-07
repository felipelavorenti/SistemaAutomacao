import path from 'node:path';
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import type { ConnectionData, NodeExecuteContext, NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { Item } from '../types.js';
import { getBinary, toBinary, withBinary } from '../binary.js';
import { errMessage, num, str } from './values.js';

/**
 * SSH: roda comandos e envia ou baixa arquivos num servidor por SSH, como o nó SSH do n8n.
 * Só o perfil Administrador pode criar ou alterar este nó, e cada comando vai para a Auditoria.
 */

export const SSH_CONNECTION_TYPES = ['ssh'];
/** Saída guardada de cada comando (stdout e stderr, cada um). */
const MAX_OUTPUT = 64 * 1024 * 1024;

export function sshConnectConfig(connection: ConnectionData): ConnectConfig {
  const d = connection.data;
  const host = str(d.host).trim();
  if (!host) throw new NodeOperationError('A conexão SSH está sem o servidor');
  const config: ConnectConfig = { host, port: num(d.port, 22), username: str(d.user), readyTimeout: 60_000, keepaliveInterval: 30_000 };
  if (str(d.privateKey).trim()) {
    config.privateKey = str(d.privateKey);
    if (str(d.passphrase)) config.passphrase = str(d.passphrase);
  }
  if (str(d.password)) config.password = str(d.password);
  if (!config.privateKey && !config.password) throw new NodeOperationError('A conexão SSH precisa da senha ou da chave privada');
  return config;
}

/** Abre a sessão SSH; o erro diz o servidor. */
export function connectSsh(connection: ConnectionData, signal?: AbortSignal): Promise<Client> {
  const config = sshConnectConfig(connection);
  return new Promise((resolve, reject) => {
    const client = new Client();
    const onAbort = () => {
      client.end();
      reject(new NodeOperationError('A conexão SSH foi cancelada'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    client
      .on('ready', () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(client);
      })
      .on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(new NodeOperationError(`Não foi possível entrar por SSH em ${config.host}:${config.port}: ${errMessage(err)}`));
      })
      .connect(config);
  });
}

export async function testSshConnection(connection: ConnectionData): Promise<void> {
  (await connectSsh(connection)).end();
}

export interface CommandResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** Roda o comando e espera terminar; o cancelamento da execução fecha o canal. */
export function sshExec(client: Client, command: string, signal: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(new NodeOperationError(`O servidor não aceitou o comando: ${errMessage(err)}`));
      const out: Buffer[] = [];
      const errOut: Buffer[] = [];
      let size = 0;
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_OUTPUT * 2) target.push(chunk);
      };
      const onAbort = () => stream.close();
      signal.addEventListener('abort', onAbort, { once: true });
      stream.on('data', collect(out));
      stream.stderr.on('data', collect(errOut));
      stream.on('close', (code: number | null, sig: string | null) => {
        signal.removeEventListener('abort', onAbort);
        resolve({
          code: code ?? null,
          signal: sig ?? null,
          stdout: Buffer.concat(out).toString('utf8').slice(0, MAX_OUTPUT),
          stderr: Buffer.concat(errOut).toString('utf8').slice(0, MAX_OUTPUT),
        });
      });
    });
  });
}

function sftpOf(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => client.sftp((err, sftp) => (err ? reject(new NodeOperationError(`O servidor não liberou o SFTP: ${errMessage(err)}`)) : resolve(sftp))));
}

const readRemote = (sftp: SFTPWrapper, file: string) =>
  new Promise<Buffer>((resolve, reject) => sftp.readFile(file, (err, data) => (err ? reject(new NodeOperationError(`Não foi possível baixar "${file}": ${errMessage(err)}`)) : resolve(data))));
const writeRemote = (sftp: SFTPWrapper, file: string, data: Buffer) =>
  new Promise<void>((resolve, reject) => sftp.writeFile(file, data, (err) => (err ? reject(new NodeOperationError(`Não foi possível gravar "${file}": ${errMessage(err)}`)) : resolve())));

/** Escapa um texto para o shell do servidor (entre aspas simples). */
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const show = (resource: string, ...operations: string[]) => ({ resource: [resource], operation: operations });

async function runCommand(ctx: NodeExecuteContext, client: Client, connection: ConnectionData, i: number): Promise<Item> {
  const command = str(await ctx.getParam('command', i));
  if (!command.trim()) throw new NodeOperationError('Informe o comando');
  const cwd = str(await ctx.getParam('cwd', i), '/').trim();
  // Como no n8n: entra na pasta e roda o comando nela.
  const full = cwd ? `cd ${/^[\w~/.-]+$/.test(cwd) ? cwd : shellQuote(cwd)} && ${command}` : command;
  const host = `${str(connection.data.user)}@${str(connection.data.host)}:${num(connection.data.port, 22)}`;
  const started = Date.now();
  try {
    const result = await sshExec(client, full, ctx.signal);
    await ctx.logCommand({ command: full, host, exitCode: result.code, durationMs: Date.now() - started });
    return { json: { code: result.code, signal: result.signal, stdout: result.stdout.trim(), stderr: result.stderr.trim() } };
  } catch (err) {
    await ctx.logCommand({ command: full, host, exitCode: null, durationMs: Date.now() - started, error: errMessage(err) });
    throw err;
  }
}

export const ssh: NodeType = {
  description: {
    type: 'ssh',
    displayName: 'SSH',
    description: 'Roda comandos e envia ou baixa arquivos num servidor por SSH. Só o Administrador edita este nó; cada comando vai para a Auditoria.',
    group: 'action',
    inputs: 1,
    outputs: 1,
    defaultTimeoutMs: 600_000,
    properties: [
      { name: 'connection', displayName: 'Conexão SSH', type: 'connection', default: '', required: true, connectionTypes: SSH_CONNECTION_TYPES },
      {
        name: 'resource',
        displayName: 'Recurso',
        type: 'options',
        default: 'command',
        options: [
          { name: 'Comando', value: 'command' },
          { name: 'Arquivo', value: 'file' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operação',
        type: 'options',
        default: 'execute',
        options: [
          { name: 'Rodar comando', value: 'execute', showWhen: { resource: ['command'] } },
          { name: 'Enviar arquivo', value: 'upload', showWhen: { resource: ['file'] } },
          { name: 'Baixar arquivo', value: 'download', showWhen: { resource: ['file'] } },
        ],
        description: 'Com o recurso Comando vale Rodar comando; com Arquivo, Enviar ou Baixar.',
      },
      { name: 'command', displayName: 'Comando', type: 'string', default: '', required: true, multiline: true, placeholder: 'ls -la', showWhen: show('command', 'execute') },
      { name: 'cwd', displayName: 'Pasta onde rodar', type: 'string', default: '/', showWhen: show('command', 'execute') },
      {
        name: 'path',
        displayName: 'Caminho',
        type: 'string',
        default: '',
        required: true,
        placeholder: '/home/usuario/arquivo.csv',
        description: 'No envio, a pasta de destino no servidor; no download, o arquivo.',
        showWhen: { resource: ['file'] },
      },
      { name: 'binaryPropertyName', displayName: 'Campo do arquivo', type: 'string', default: 'data', showWhen: { resource: ['file'] } },
      { name: 'fileName', displayName: 'Nome do arquivo no servidor', type: 'string', default: '', description: 'Vazio: o nome do arquivo do item.', showWhen: show('file', 'upload') },
    ],
  },

  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const sessions = new Map<string, { client: Client; connection: ConnectionData; sftp?: SFTPWrapper }>();
    const out: Item[] = [];
    try {
      for (let i = 0; i < input.length; i++) {
        const item = input[i]!;
        const connectionId = str(await ctx.getParam('connection', i));
        if (!connectionId) throw new NodeOperationError('Escolha a conexão SSH');
        let session = sessions.get(connectionId);
        if (!session) {
          const connection = await ctx.getConnection(connectionId);
          if (!SSH_CONNECTION_TYPES.includes(connection.type)) throw new NodeOperationError('A conexão escolhida não é do tipo SSH');
          session = { client: await connectSsh(connection, ctx.signal), connection };
          sessions.set(connectionId, session);
        }
        const resource = str(await ctx.getParam('resource', i), 'command');
        const operation = str(await ctx.getParam('operation', i), 'execute');
        if (resource === 'command') {
          out.push(await runCommand(ctx, session.client, session.connection, i));
          continue;
        }
        const remote = str(await ctx.getParam('path', i)).trim();
        if (!remote) throw new NodeOperationError('Informe o caminho');
        const property = str(await ctx.getParam('binaryPropertyName', i), 'data');
        session.sftp ??= await sftpOf(session.client);
        if (operation === 'download') {
          const content = await readRemote(session.sftp, remote);
          out.push(withBinary({ json: item.json, binary: item.binary }, property, toBinary(content, { fileName: path.posix.basename(remote), directory: path.posix.dirname(remote) })));
        } else if (operation === 'upload') {
          const binary = getBinary(item, property, i);
          const name = str(await ctx.getParam('fileName', i)).trim() || binary.fileName || property;
          await writeRemote(session.sftp, path.posix.join(remote, name), Buffer.from(binary.data, 'base64'));
          out.push({ json: { success: true } });
        } else {
          throw new NodeOperationError(`O recurso Arquivo não tem a operação "${operation}"; use Enviar ou Baixar arquivo`);
        }
      }
    } finally {
      for (const s of sessions.values()) s.client.end();
    }
    return [out];
  },
};
