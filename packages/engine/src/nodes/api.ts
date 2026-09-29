import { NodeOperationError } from '../node-types.js';
import type { JsonValue } from '../types.js';

export interface ApiCall {
  /** Nome do serviço, para as mensagens de erro (ex.: "Metabase"). */
  service: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * Chama a API de uma integração e devolve o corpo já lido. Quando a API responde
 * com erro, o erro traz o status e o corpo da resposta, como no HTTP Request.
 */
export async function callApi(call: ApiCall): Promise<JsonValue> {
  const target = new URL(call.url);
  const request = { method: call.method, url: `${target.origin}${target.pathname}` };
  let response: Response;
  try {
    response = await fetch(call.url, { method: call.method, headers: call.headers, body: call.body, signal: call.signal });
  } catch (err) {
    if (call.signal?.aborted) throw err;
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw new NodeOperationError(`Falha ao chamar o ${call.service} (${request.url}): ${cause}`, { request });
  }
  const text = await response.text();
  let body: JsonValue = text || null;
  if (text && ((response.headers.get('content-type') ?? '').includes('json') || /^\s*[[{]/.test(text))) {
    try {
      body = JSON.parse(text) as JsonValue;
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new NodeOperationError(`O ${call.service} respondeu com status ${response.status} ${response.statusText}`.trim(), {
      statusCode: response.status,
      statusText: response.statusText,
      body,
      request,
    });
  }
  return body;
}
