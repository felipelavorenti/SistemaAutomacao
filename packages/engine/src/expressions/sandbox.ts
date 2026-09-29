import ivm from 'isolated-vm';
import type { Item, JsonObject, JsonValue } from '../types.js';
import { isExpression, parseTemplate } from './template.js';

/** Dados que as expressões enxergam durante uma execução. */
export interface ExpressionData {
  /** Saída (primeira saída) de cada nó já executado, pelo nome do nó. */
  nodeOutputs: Record<string, Item[]>;
  execution: { id: string; mode: string };
  vars: JsonObject;
}

export interface SandboxOptions {
  memoryLimitMb?: number;
  timeoutMs?: number;
}

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly expression: string,
  ) {
    super(message);
  }
}

// Roda dentro do isolate. Monta as variáveis que o usuário usa nas expressões.
const BOOTSTRAP = `
const __data = JSON.parse(__rawData);
const __wrap = (items) => ({
  all: () => items,
  first: () => items[0],
  last: () => items[items.length - 1],
  get item() { return items[__index] ?? items[0]; },
  get json() { return (items[__index] ?? items[0] ?? { json: {} }).json; },
});
const $node = new Proxy({}, {
  get(_, name) {
    const items = __data.nodeOutputs[name];
    if (!items) throw new Error('Nó "' + String(name) + '" não foi executado antes deste nó');
    return __wrap(items);
  },
});
const $ = (name) => $node[name];
const $execution = __data.execution;
const $vars = __data.vars;
let __index = 0;
let __input = [];
let $json = {};
let $input = __wrap([]);
let $itemIndex = 0;
const __setItem = (rawInput, index) => {
  __input = JSON.parse(rawInput);
  __index = index;
  $itemIndex = index;
  $input = __wrap(__input);
  $json = (__input[index] ?? { json: {} }).json;
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

  async createScope(data: ExpressionData): Promise<ExpressionScope> {
    const context = await this.isolate.createContext();
    await context.global.set('__rawData', JSON.stringify(data));
    await context.eval(BOOTSTRAP + '; globalThis.__setItem = __setItem;', { timeout: this.timeoutMs });
    return new ExpressionScope(context, this.timeoutMs);
  }

  dispose(): void {
    if (!this.isolate.isDisposed) this.isolate.dispose();
  }
}

export class ExpressionScope {
  private currentInput: Item[] | null = null;
  private currentIndex = -1;

  constructor(
    private context: ivm.Context,
    private timeoutMs: number,
  ) {}

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
    await this.setItem(input, index);
    const wrapped = `(() => { const __r = (${code}\n); return __r === undefined ? 'null' : JSON.stringify(__r); })()`;
    try {
      const raw = (await this.context.eval(wrapped, { timeout: this.timeoutMs, copy: true })) as string;
      return JSON.parse(raw) as JsonValue;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ExpressionError(`Erro na expressão {{ ${code} }}: ${message}`, code);
    }
  }

  private async setItem(input: Item[], index: number): Promise<void> {
    if (input === this.currentInput && index === this.currentIndex) return;
    const fn = (await this.context.global.get('__setItem', { reference: true })) as ivm.Reference;
    await fn.apply(undefined, [JSON.stringify(input), index], { timeout: this.timeoutMs });
    this.currentInput = input;
    this.currentIndex = index;
  }

  release(): void {
    this.context.release();
  }
}
