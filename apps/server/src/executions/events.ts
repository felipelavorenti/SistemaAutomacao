import type { Redis } from 'ioredis';
import type { ExecutionStatus, Item, WaitInfo, WebhookResponse } from '@sa/engine';
import { executionChannel } from './queue.js';

/** O que o worker avisa a quem chamou a execução por HTTP (webhook e formulário). */
export type ExecutionEvent =
  | { type: 'response'; response: WebhookResponse }
  | { type: 'waiting'; wait: WaitInfo }
  | { type: 'finished'; status: Exclude<ExecutionStatus, 'waiting'>; error?: string; lastOutput: Item[] };

/**
 * Escuta os avisos das execuções numa conexão Redis só para isso. Assine antes de pôr a execução na
 * fila, para não perder um aviso que chegue rápido.
 */
export class ExecutionEvents {
  private listeners = new Map<string, Set<(event: ExecutionEvent) => void>>();

  constructor(private subscriber: Redis) {
    subscriber.on('message', (channel: string, message: string) => {
      const set = this.listeners.get(channel);
      if (!set) return;
      let event: ExecutionEvent;
      try {
        event = JSON.parse(message) as ExecutionEvent;
      } catch {
        return;
      }
      for (const fn of set) fn(event);
    });
  }

  /**
   * Assina os avisos de uma execução. `next(filter)` espera o primeiro aviso que o filtro aceitar
   * (ou o tempo acabar: devolve null); `close()` cancela a assinatura.
   */
  async subscribe(executionId: string): Promise<{ next: (accept: (e: ExecutionEvent) => boolean, timeoutMs: number) => Promise<ExecutionEvent | null>; close: () => Promise<void> }> {
    const channel = executionChannel(executionId);
    const queue: ExecutionEvent[] = [];
    let waiter: ((e: ExecutionEvent) => void) | null = null;
    const fn = (event: ExecutionEvent) => {
      if (waiter) waiter(event);
      else queue.push(event);
    };
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.subscriber.subscribe(channel);
    }
    set.add(fn);

    const next = (accept: (e: ExecutionEvent) => boolean, timeoutMs: number) =>
      new Promise<ExecutionEvent | null>((resolve) => {
        while (queue.length) {
          const e = queue.shift()!;
          if (accept(e)) return resolve(e);
        }
        const timer = setTimeout(() => {
          waiter = null;
          resolve(null);
        }, timeoutMs);
        waiter = (e) => {
          if (!accept(e)) return;
          clearTimeout(timer);
          waiter = null;
          resolve(e);
        };
      });

    const close = async () => {
      set!.delete(fn);
      if (!set!.size) {
        this.listeners.delete(channel);
        await this.subscriber.unsubscribe(channel).catch(() => undefined);
      }
    };
    return { next, close };
  }
}
