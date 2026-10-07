import ivm from 'isolated-vm';
import type { Item, JsonObject, JsonValue } from '../types.js';
import { isExpression, parseTemplate } from './template.js';

/** Dados que as expressões enxergam durante uma execução. */
export interface ExpressionData {
  /** Saída (primeira saída) de cada nó já executado, pelo nome do nó. */
  nodeOutputs: Record<string, Item[]>;
  execution: { id: string; mode: string; resumeUrl?: string; resumeFormUrl?: string };
  vars: JsonObject;
}

export interface SandboxOptions {
  memoryLimitMb?: number;
  timeoutMs?: number;
}

/** Erro lançado pelo código do usuário no nó Code, com o que ele já tinha logado. */
export class CodeError extends Error {
  constructor(
    message: string,
    readonly logs: string[],
  ) {
    super(message);
  }
}

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly expression: string,
  ) {
    super(message);
  }
}

// Roda dentro do isolate. Monta as variáveis que o usuário usa nas expressões e no nó Code.
// A saída de cada nó só é copiada para o isolate quando alguém a usa.
const BOOTSTRAP = `
const __meta = JSON.parse(__rawMeta);
// Como no n8n: qualquer valor vira texto JSON com .toJsonString().
Object.defineProperty(Object.prototype, 'toJsonString', {
  value: function () { return JSON.stringify(this.valueOf()); },
  enumerable: false,
  writable: true,
  configurable: true,
});
const __nodeCache = {};
const __wrap = (items) => ({
  all: () => items,
  first: () => items[0],
  last: () => items[items.length - 1],
  get item() { return items[__index] ?? items[0]; },
  get json() { return (items[__index] ?? items[0] ?? { json: {} }).json; },
});
const $node = new Proxy({}, {
  get(_, name) {
    if (typeof name !== 'string') return undefined;
    if (!(name in __nodeCache)) {
      const raw = __nodeJson(name);
      if (raw === null) throw new Error('Nó "' + name + '" não foi executado antes deste nó');
      __nodeCache[name] = JSON.parse(raw);
    }
    return __wrap(__nodeCache[name]);
  },
});
const $ = (name) => $node[name];
const $execution = __meta.execution;
const $vars = __meta.vars;
const __logs = [];
const __fmt = (v) => typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
const __log = (...args) => { if (__logs.length < 200) __logs.push(args.map(__fmt).join(' ')); };
globalThis.console = { log: __log, info: __log, warn: __log, error: __log, debug: __log };
let __index = 0;
let __input = [];
let $json = {};
let $binary = {};
let $input = __wrap([]);
let $itemIndex = 0;
const __setItem = (rawInput, index) => {
  if (rawInput !== null) __input = JSON.parse(rawInput);
  __index = index;
  $itemIndex = index;
  $input = __wrap(__input);
  $json = (__input[index] ?? { json: {} }).json;
  $binary = (__input[index] ?? {}).binary ?? {};
};
`;

/**
 * Avalia expressões JavaScript num isolate V8 separado, com limite de memória
 * e de tempo, para que código do usuário não afete o servidor.
 */
export class ExpressionSandbox {
  private isolate: ivm.Isolate;
  private timeoutMs: number;

  constructor(options: SandboxOptions = {}) {
    this.isolate = new ivm.Isolate({ memoryLimit: options.memoryLimitMb ?? 64 });
    this.timeoutMs = options.timeoutMs ?? 2000;
  }

  /** O contexto V8 só é criado quando o nó avalia a primeira expressão. */
  async createScope(data: ExpressionData): Promise<ExpressionScope> {
    return new ExpressionScope(async () => {
      const context = await this.isolate.createContext();
      await context.global.set('__rawMeta', JSON.stringify({ execution: data.execution, vars: data.vars }));
      await context.global.set(
        '__nodeJson',
        new ivm.Callback((name: string) => {
          const items = data.nodeOutputs[name];
          return items ? JSON.stringify(items) : null;
        }),
      );
      await context.eval(BOOTSTRAP + '; globalThis.__setItem = __setItem;', { timeout: this.timeoutMs });
      return context;
    }, this.timeoutMs);
  }

  dispose(): void {
    if (!this.isolate.isDisposed) this.isolate.dispose();
  }
}

export class ExpressionScope {
  private currentInput: Item[] | null = null;
  private currentIndex = -1;
  private context: Promise<ivm.Context> | null = null;

  constructor(
    private createContext: () => Promise<ivm.Context>,
    private timeoutMs: number,
  ) {}

  private getContext(): Promise<ivm.Context> {
    this.context ??= this.createContext();
    return this.context;
  }

  /** Resolve um valor de parâmetro: expressões são avaliadas, o resto passa direto. */
  async resolve(value: JsonValue, input: Item[], index: number): Promise<JsonValue> {
    if (isExpression(value)) return this.evaluateTemplate(value.slice(1), input, index);
    if (Array.isArray(value)) {
      const out: JsonValue[] = [];
      for (const v of value) out.push(await this.resolve(v, input, index));
      return out;
    }
    if (value !== null && typeof value === 'object') {
      const out: JsonObject = {};
      for (const [k, v] of Object.entries(value)) out[k] = await this.resolve(v, input, index);
      return out;
    }
    return value;
  }

  async evaluateTemplate(template: string, input: Item[], index: number): Promise<JsonValue> {
    const parts = parseTemplate(template);
    const code = parts.filter((p) => p.kind === 'code');
    const onlyCode = code.length === 1 && parts.every((p) => p.kind === 'code' || p.value.trim() === '');

    if (onlyCode) return this.evaluate(code[0].value, input, index);

    let result = '';
    for (const part of parts) {
      if (part.kind === 'text') {
        result += part.value;
      } else {
        const value = await this.evaluate(part.value, input, index);
        result += value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      }
    }
    return result;
  }

  async evaluate(code: string, input: Item[], index: number): Promise<JsonValue> {
    const context = await this.getContext();
    await this.setItem(input, index);
    const wrapped = `(() => { const __r = (${code}\n); return __r === undefined ? 'null' : JSON.stringify(__r); })()`;
    try {
      const raw = (await context.eval(wrapped, { timeout: this.timeoutMs, copy: true })) as string;
      return JSON.parse(raw) as JsonValue;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ExpressionError(`Erro na expressão {{ ${code} }}: ${message}`, code);
    }
  }

  /**
   * Roda o corpo de uma função assíncrona escrita pelo usuário (nó Code).
   * Devolve o que o código retornou e o que ele escreveu com console.log.
   */
  async runCode(code: string, input: Item[], index: number, timeoutMs: number): Promise<{ result: JsonValue; logs: string[] }> {
    const context = await this.getContext();
    await this.setItem(input, index);
    const wrapped = `(async () => {
      __logs.length = 0;
      try {
        const __r = await (async () => {\n${code}\n})();
        return JSON.stringify({ ok: true, result: __r === undefined ? null : __r, logs: __logs });
      } catch (e) {
        return JSON.stringify({ ok: false, message: e instanceof Error ? e.message : String(e), logs: __logs });
      }
    })()`;
    let raw: string;
    try {
      raw = (await context.eval(wrapped, { timeout: timeoutMs, promise: true, copy: true })) as string;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CodeError(/timed out/i.test(message) ? `O código passou do tempo limite de ${timeoutMs / 1000} s` : message, []);
    }
    const out = JSON.parse(raw) as { ok: boolean; result?: JsonValue; message?: string; logs: string[] };
    if (!out.ok) throw new CodeError(out.message ?? 'Erro no código', out.logs);
    return { result: out.result ?? null, logs: out.logs };
  }

  private async setItem(input: Item[], index: number): Promise<void> {
    if (input === this.currentInput && index === this.currentIndex) return;
    const context = await this.getContext();
    const fn = (await context.global.get('__setItem', { reference: true })) as ivm.Reference;
    const raw = input === this.currentInput ? null : JSON.stringify(input);
    await fn.apply(undefined, [raw, index], { timeout: this.timeoutMs });
    this.currentInput = input;
    this.currentIndex = index;
  }

  release(): void {
    if (!this.context) return;
    void this.context.then((c) => c.release()).catch(() => undefined);
  }
}
