import { exec } from 'node:child_process';
import type { NodeExecuteContext, NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { Item } from '../types.js';
import { readFeed } from './triggers-listen.js';
import { bool, errMessage, str } from './values.js';

/**
 * Execute Command: roda um comando no shell do servidor do Info8n (no Docker, o contêiner),
 * como o nó do n8n. Só o perfil Administrador pode criar ou alterar este nó, e cada comando vai
 * para a Auditoria.
 */

const MAX_OUTPUT = 64 * 1024 * 1024;

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: Error;
}

function runShell(command: string, signal: AbortSignal): Promise<ShellResult> {
  return new Promise((resolve) => {
    exec(command, { maxBuffer: MAX_OUTPUT, signal, windowsHide: true }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : error ? 1 : 0;
      resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr), error: error ?? undefined });
    });
  });
}

async function runOne(ctx: NodeExecuteContext, itemIndex: number): Promise<Item> {
  const command = str(await ctx.getParam('command', itemIndex));
  if (!command.trim()) throw new NodeOperationError('Informe o comando');
  const started = Date.now();
  const result = await runShell(command, ctx.signal);
  await ctx.logCommand({
    command,
    exitCode: ctx.signal.aborted ? null : result.exitCode,
    durationMs: Date.now() - started,
    ...(result.error ? { error: result.stderr.trim().slice(0, 2000) || errMessage(result.error) } : {}),
  });
  if (result.error) {
    // Como no n8n: saída diferente de 0 é erro; os detalhes trazem o que o comando escreveu.
    throw new NodeOperationError(`O comando terminou com o código ${result.exitCode}: ${result.stderr.trim().split('\n').pop() || errMessage(result.error)}`, {
      exitCode: result.exitCode,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    });
  }
  return { json: { exitCode: result.exitCode, stderr: result.stderr.trim(), stdout: result.stdout.trim() } };
}

export const executeCommand: NodeType = {
  description: {
    type: 'executeCommand',
    displayName: 'Execute Command',
    description: 'Roda um comando no servidor do Info8n. Só o Administrador edita este nó; cada comando vai para a Auditoria.',
    group: 'action',
    inputs: 1,
    outputs: 1,
    defaultTimeoutMs: 600_000,
    properties: [
      {
        name: 'executeOnce',
        displayName: 'Rodar uma vez só',
        type: 'boolean',
        default: true,
        description: 'Ligado, roda o comando uma vez com o primeiro item. Desligado, roda uma vez por item.',
      },
      {
        name: 'command',
        displayName: 'Comando',
        type: 'string',
        default: '',
        required: true,
        multiline: true,
        placeholder: 'ls -la /files',
        description: 'Roda no shell do servidor (sh no Linux e no Docker). Expressões entram no texto antes de rodar.',
      },
    ],
  },

  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const once = bool(await ctx.getParam('executeOnce', 0), true);
    const count = once ? Math.min(input.length, 1) || 1 : input.length;
    const out: Item[] = [];
    for (let i = 0; i < count; i++) out.push(await runOne(ctx, i));
    return [out];
  },
};

/** RSS Read: lê os itens de um feed RSS ou Atom, um item por notícia, como o nó do n8n. */
export const rssFeedRead: NodeType = {
  description: {
    type: 'rssFeedRead',
    displayName: 'RSS Read',
    description: 'Lê os itens de um feed RSS ou Atom. Cada notícia vira um item.',
    group: 'action',
    inputs: 1,
    outputs: 1,
    properties: [
      { name: 'url', displayName: 'URL do feed', type: 'string', default: '', required: true, placeholder: 'https://site.com.br/feed.xml' },
      {
        name: 'ignoreSSL',
        displayName: 'Ignorar erros de certificado (SSL)',
        type: 'boolean',
        default: false,
        description: 'Aceita sites com certificado vencido ou próprio. Use só com feeds internos de confiança.',
      },
    ],
  },

  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const out: Item[] = [];
    // Como no n8n: lê o feed uma vez para cada item que chega (cada um pode ter a sua URL).
    for (let i = 0; i < Math.max(input.length, 1); i++) {
      const items = await readFeed(str(await ctx.getParam('url', i)), bool(await ctx.getParam('ignoreSSL', i)));
      for (const json of items) out.push({ json });
    }
    return [out];
  },
};
