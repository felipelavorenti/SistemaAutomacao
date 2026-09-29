import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodeError } from '../expressions/sandbox.js';
import type { Item, JsonObject, JsonValue } from '../types.js';

export interface PythonRunRequest {
  code: string;
  /** "all": roda uma vez com todos os itens; "each": uma vez por item. */
  mode: 'all' | 'each';
  input: Item[];
  /** Saída dos nós que o código usa com _('Nome') ou _node['Nome']. */
  nodeOutputs: Record<string, Item[]>;
  execution: JsonObject;
  vars: JsonObject;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface PythonRunResult {
  /** Um resultado por execução do código (um só no modo "all"). */
  results: JsonValue[];
  logs: string[];
}

export interface PythonRunnerOptions {
  /** Quantos processos Python podem rodar ao mesmo tempo. */
  size?: number;
  /** Memória máxima da parte JavaScript de cada processo, em MB. */
  memoryLimitMb?: number;
  /** Processo parado há mais que isso é encerrado para liberar memória. */
  idleMs?: number;
}

interface Worker {
  child: ChildProcess;
  ready: Promise<void>;
  busy: boolean;
  idleTimer?: NodeJS.Timeout;
}

interface Reply {
  id?: number;
  type?: string;
  ok?: boolean;
  results?: JsonValue[];
  message?: string;
  logs?: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
// Compilado, o filho é child.js; nos testes (código-fonte), o Node roda o child.ts direto.
const PYODIDE = join(dirname(createRequire(import.meta.url).resolve('pyodide')), 'pyodide.mjs');
const CHILD = existsSync(join(here, 'child.js')) ? join(here, 'child.js') : join(here, 'child.ts');

/**
 * Roda o Python do nó Code em processos separados, cada um com o Pyodide já
 * carregado. Os processos rodam com o modelo de permissões do Node: não leem
 * arquivos além do Pyodide, não gravam, não criam processos e não recebem as
 * variáveis de ambiente do servidor. Um código que passa do tempo limite tem o
 * processo encerrado.
 */
export class PythonRunner {
  private workers: Worker[] = [];
  private queue: ((worker: Worker) => void)[] = [];
  private nextId = 1;
  private closed = false;
  private readonly size: number;
  private readonly memoryLimitMb: number;
  private readonly idleMs: number;

  constructor(options: PythonRunnerOptions = {}) {
    this.size = Math.max(1, options.size ?? 2);
    this.memoryLimitMb = options.memoryLimitMb ?? 512;
    this.idleMs = options.idleMs ?? 10 * 60_000;
  }

  async run(req: PythonRunRequest): Promise<PythonRunResult> {
    if (this.closed) throw new CodeError('O Python não está disponível', []);
    const worker = await this.acquire();
    try {
      await worker.ready;
    } catch (err) {
      this.discard(worker);
      throw new CodeError(err instanceof Error ? err.message : String(err), []);
    }
    const id = this.nextId++;
    return new Promise<PythonRunResult>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void, keep: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        worker.child.off('message', onMessage);
        worker.child.off('exit', onExit);
        if (keep) this.release(worker);
        else this.discard(worker);
        fn();
      };
      const onMessage = (msg: Reply) => {
        if (msg.id !== id) return;
        if (msg.ok) finish(() => resolve({ results: msg.results ?? [], logs: msg.logs ?? [] }), true);
        else finish(() => reject(new CodeError(msg.message ?? 'Erro no código Python', msg.logs ?? [])), true);
      };
      const onExit = () =>
        finish(() => reject(new CodeError('O processo do Python parou durante a execução (memória esgotada?)', [])), false);
      const onAbort = () => finish(() => reject(new CodeError('Execução do Python interrompida', [])), false);
      const timer = setTimeout(
        () => finish(() => reject(new CodeError(`O código passou do tempo limite de ${req.timeoutMs / 1000} s`, [])), false),
        req.timeoutMs,
      );
      if (req.signal?.aborted) return onAbort();
      req.signal?.addEventListener('abort', onAbort, { once: true });
      worker.child.on('message', onMessage);
      worker.child.once('exit', onExit);
      worker.child.send({
        id,
        code: req.code,
        mode: req.mode,
        input: req.input,
        nodeOutputs: req.nodeOutputs,
        execution: req.execution,
        vars: req.vars,
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const worker of [...this.workers]) this.discard(worker);
  }

  private acquire(): Promise<Worker> {
    const idle = this.workers.find((w) => !w.busy);
    if (idle) {
      idle.busy = true;
      clearTimeout(idle.idleTimer);
      return Promise.resolve(idle);
    }
    if (this.workers.length < this.size) {
      const worker = this.spawn();
      worker.busy = true;
      return Promise.resolve(worker);
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private release(worker: Worker): void {
    const next = this.queue.shift();
    if (next) return next(worker);
    worker.busy = false;
    worker.idleTimer = setTimeout(() => this.discard(worker), this.idleMs);
    worker.idleTimer.unref();
  }

  private discard(worker: Worker): void {
    clearTimeout(worker.idleTimer);
    this.workers = this.workers.filter((w) => w !== worker);
    worker.child.removeAllListeners('message');
    if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
    // Quem estava na fila ganha um processo novo.
    const next = this.queue.shift();
    if (next && !this.closed) {
      const fresh = this.spawn();
      fresh.busy = true;
      next(fresh);
    }
  }

  private spawn(): Worker {
    const pyodide = PYODIDE;
    const child = fork(CHILD, [new URL(`file://${pyodide}`).href], {
      execArgv: ['--permission', `--allow-fs-read=${dirname(pyodide)}${'/'}`, `--max-old-space-size=${this.memoryLimitMb}`],
      env: { TZ: process.env.TZ ?? '' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
    const ready = new Promise<void>((resolve, reject) => {
      const onMessage = (msg: Reply) => {
        if (msg.type !== 'ready') return;
        child.off('message', onMessage);
        child.off('exit', onExit);
        resolve();
      };
      const onExit = () => reject(new Error(`Não foi possível iniciar o Python: ${stderr.trim().split('\n').slice(-3).join(' ') || 'o processo parou'}`));
      child.on('message', onMessage);
      child.once('exit', onExit);
    });
    ready.catch(() => undefined);
    const worker: Worker = { child, ready, busy: false };
    this.workers.push(worker);
    return worker;
  }
}

/** Nomes dos nós que o código Python usa, para enviar só a saída deles. */
export function referencedNodes(code: string): string[] {
  const names = new Set<string>();
  for (const m of code.matchAll(/_(?:node)?\s*[[(]\s*(["'])(.+?)\1\s*[\])]/g)) names.add(m[2]!);
  return [...names];
}
