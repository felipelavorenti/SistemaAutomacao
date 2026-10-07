import type { ApiEndpointData } from './catalog.js';
import type { DbResult, ProcedureParam } from './database/drivers.js';
import type { Item, JsonObject, JsonValue, NodeInstance, ResumeData, WaitKind, WebhookResponse } from './types.js';

export type PropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'options'
  | 'json'
  | 'code'
  | 'connection'
  | 'workflow'
  | 'erpClient'
  | 'erpEndpoint'
  | 'erpVariables'
  | 'list'
  /** Vários valores de options, marcados em caixas (valor: lista). */
  | 'multiOptions'
  /** Horário hh:mm:ss. */
  | 'time'
  /** Data e hora aaaa-mm-ddThh:mm:ss. */
  | 'dateTime'
  /** Arquivo enviado pela tela e guardado no servidor (valor: o ID do arquivo). */
  | 'file';

/** Descreve um campo de configuração do nó; o editor monta o formulário a partir disso. */
export interface PropertyDescription {
  name: string;
  displayName: string;
  type: PropertyType;
  default: JsonValue;
  description?: string;
  placeholder?: string;
  required?: boolean;
  options?: { name: string; value: string }[];
  /** Tipos de conexão aceitos, para campos do tipo "connection". */
  connectionTypes?: string[];
  /** Campos de cada linha, para campos do tipo "list" (ex.: headers). */
  fields?: PropertyDescription[];
  /** Campos de texto com várias linhas (ex.: SQL). */
  multiline?: boolean;
  /** Mostra o campo só quando outros campos têm certos valores. */
  showWhen?: Record<string, JsonValue[]>;
}

export interface NodeTypeDescription {
  type: string;
  displayName: string;
  description: string;
  group: 'trigger' | 'action' | 'logic' | 'data';
  /** Não aparece na paleta do editor (ex.: nó do n8n não convertido). */
  hidden?: boolean;
  inputs: number;
  outputs: number;
  outputNames?: string[];
  inputNames?: string[];
  /** Saídas que dependem da configuração do nó (ex.: uma por regra do Switch). */
  dynamicOutputs?: DynamicOutputs;
  /** Tempo limite padrão do nó, quando diferente do padrão da execução. */
  defaultTimeoutMs?: number;
  properties: PropertyDescription[];
}

/**
 * Quantidade e nome das saídas tirados dos parâmetros. Com `countFrom`, a quantidade vem de um
 * campo numérico; com `listFrom`, há uma saída por linha da lista (nome em `nameField`), mais a
 * saída `extraName` quando os parâmetros batem com `extraWhen`.
 */
export interface DynamicOutputs {
  countFrom?: string;
  listFrom?: string;
  nameField?: string;
  /** Vale quando o modo do nó (campo `modeField`) tem um destes valores; nos outros, vale `outputs`. */
  modeField?: string;
  listModes?: string[];
  countModes?: string[];
  extraWhen?: Record<string, JsonValue[]>;
  extraName?: string;
}

/** Saídas de um nó com os parâmetros atuais. */
export function resolveOutputs(description: NodeTypeDescription, parameters: Record<string, JsonValue>): { count: number; names?: string[] } {
  const dyn = description.dynamicOutputs;
  if (!dyn) return { count: description.outputs, names: description.outputNames };
  // Campo nunca editado vale o padrão do nó.
  const defaults = Object.fromEntries(description.properties.map((p) => [p.name, p.default]));
  parameters = { ...defaults, ...parameters };
  const mode = dyn.modeField ? String(parameters[dyn.modeField] ?? '') : '';
  if (dyn.countFrom && (!dyn.modeField || dyn.countModes?.includes(mode))) {
    const n = Math.trunc(Number(parameters[dyn.countFrom]));
    return { count: Number.isFinite(n) && n > 0 ? Math.min(n, 64) : 1 };
  }
  if (dyn.listFrom && (!dyn.modeField || dyn.listModes?.includes(mode))) {
    const list = Array.isArray(parameters[dyn.listFrom]) ? (parameters[dyn.listFrom] as JsonValue[]) : [];
    const names = list.map((row, i) => {
      const name = dyn.nameField && row && typeof row === 'object' && !Array.isArray(row) ? String(row[dyn.nameField] ?? '').trim() : '';
      return name || String(i);
    });
    const extra = dyn.extraWhen && Object.entries(dyn.extraWhen).every(([k, allowed]) => allowed.includes(parameters[k] ?? null));
    if (extra) names.push(dyn.extraName ?? 'outros');
    return { count: Math.max(names.length, 1), names: names.length ? names : undefined };
  }
  return { count: description.outputs, names: description.outputNames };
}

/** Arquivo guardado no servidor (ex.: um anexo escolhido no editor). */
export interface FileData {
  id: string;
  name: string;
  mimeType: string;
  content: Buffer;
}

export interface ConnectionData {
  id: string;
  type: string;
  data: JsonObject;
}

export interface NodeExecuteContext {
  node: NodeInstance;
  /** Itens recebidos em cada entrada. */
  inputs: Item[][];
  /** Valor de um parâmetro já com as expressões resolvidas para o item informado. */
  getParam(name: string, itemIndex?: number): Promise<JsonValue>;
  getConnection(id: string): Promise<ConnectionData>;
  /** Arquivo guardado no servidor, pelo ID. */
  getFile(id: string): Promise<FileData>;
  /** Pastas do servidor que os nós Read/Write Files from Disk podem usar (vazio: nenhuma). */
  filesDirs: string[];
  /** Endpoint do catálogo de APIs combinado com o cadastro do cliente no ERP. */
  getApiEndpoint(erpClientId: string, endpointId: string): Promise<ApiEndpointData>;
  /** Sessão no banco da conexão; cada comando fica registrado na auditoria. */
  database(connectionId: string): Promise<DatabaseSession>;
  /** Roda código JavaScript do usuário no isolate da execução. */
  runCode(code: string, itemIndex: number): Promise<{ result: JsonValue; logs: string[] }>;
  /** Roda código Python num processo isolado: uma vez com todos os itens ou uma vez por item. */
  runPython(code: string, mode: 'all' | 'each'): Promise<{ results: JsonValue[]; logs: string[] }>;
  /** Executa outro fluxo e devolve a saída dele. */
  executeWorkflow(workflowId: string, items: Item[]): Promise<SubworkflowResult>;
  /** Estado do nó que dura a execução inteira (ex.: os lotes pendentes do Loop). */
  state: Record<string, unknown>;
  /** Informações extras que ficam registradas na execução do nó. */
  meta: JsonObject;
  signal: AbortSignal;
  /** Modo da execução (manual, schedule, webhook, trigger, error, subworkflow, retry). */
  mode: string;
  /** Endereços para retomar esta execução pausada (Wait e Form). */
  resumeUrl: string;
  resumeFormUrl: string;
  /** Endereço público do Info8n (para montar URLs de webhook e formulário). */
  publicUrl: string;
  /**
   * Pausa a execução depois deste nó: a vaga do worker fica livre e o nó roda de novo na retomada,
   * com `resumeData`. Devolve false quando a execução não pode pausar (subfluxo); aí o nó decide.
   */
  putToWait(wait: { kind: WaitKind; until?: number; config?: JsonObject }): boolean;
  /** Dados da retomada, quando o nó roda de novo depois de uma pausa que ele pediu. */
  resumeData?: ResumeData;
  /** Responde o pedido HTTP que iniciou (ou retomou) a execução: Respond to Webhook e Form. */
  sendResponse(response: WebhookResponse): void;
}

/** O que um gatilho que escuta (IMAP, arquivo, SSE) ou consulta (RSS) recebe enquanto o fluxo está ativo. */
export interface TriggerContext {
  node: NodeInstance;
  workflowId: string;
  /** Parâmetro do nó; expressões são resolvidas sem itens. */
  getParam(name: string): Promise<JsonValue>;
  getConnection(id: string): Promise<ConnectionData>;
  filesDirs: string[];
  /** Dados que o gatilho guarda entre disparos (ex.: a data do último item do RSS). */
  staticData: JsonObject;
  saveStaticData(): Promise<void>;
  /** Dispara uma execução com estes itens. */
  emit(items: Item[]): Promise<void>;
  /** Avisa um erro do gatilho (fica no log do servidor; o gatilho continua tentando). */
  emitError(err: Error): void;
  /** Abortado quando o fluxo é desativado ou o servidor para. */
  signal: AbortSignal;
  /** Teste pelo editor ("Escutar"): consultas trazem o item mais recente mesmo que já tenha sido visto. */
  testing: boolean;
}

/** Horários de consulta de um gatilho que consulta (RSS): os mesmos campos do n8n (pollTimes). */
export interface PollTimes {
  /** Expressões cron de 6 campos (com segundos). */
  crons: string[];
}

export interface DatabaseSession {
  dialect: 'postgres' | 'mssql' | 'oracle';
  query(sql: string, params: Record<string, JsonValue>, operation?: 'query' | 'insert'): Promise<DbResult>;
  procedure(name: string, params: ProcedureParam[]): Promise<DbResult>;
}

/** Registro de um comando executado num banco, para a auditoria. */
export interface DatabaseCommandLog {
  nodeName: string;
  connectionId: string;
  connectionType: string;
  operation: 'query' | 'insert' | 'procedure';
  sql: string;
  params: JsonValue;
  rows: number | null;
  rowsAffected: number | null;
  durationMs: number;
  error?: string;
}

export interface SubworkflowResult {
  executionId: string;
  status: 'success' | 'error' | 'canceled';
  output: Item[];
  error?: { message: string; nodeName?: string; details?: JsonValue };
}

export interface NodeType {
  description: NodeTypeDescription;
  /** Devolve os itens de cada saída. */
  execute(ctx: NodeExecuteContext): Promise<Item[][]>;
  /**
   * Nós que recebem os itens de volta (Loop) dizem aqui se ainda têm trabalho.
   * Se o ramo do loop terminar sem devolver nada, o executor chama o nó de novo
   * com a entrada vazia para seguir para o próximo lote.
   */
  hasPendingWork?(state: Record<string, unknown>): boolean;
  /**
   * Gatilho que escuta algo enquanto o fluxo está ativo (IMAP, pasta, SSE). Devolve a função que
   * para de escutar. O execute do nó só repassa os itens que o gatilho emitiu.
   */
  listen?(ctx: TriggerContext): Promise<() => Promise<void>>;
  /** Gatilho que consulta de tempos em tempos (RSS): devolve os itens novos, ou nada. */
  poll?(ctx: TriggerContext): Promise<Item[] | null>;
  /** Gatilho chamado por HTTP (Webhook, Form Trigger). O servidor monta os itens a partir do pedido. */
  webhook?: 'webhook' | 'form';
}

/** Erro de um nó, com detalhes estruturados (ex.: a resposta da API que falhou). */
export class NodeOperationError extends Error {
  constructor(
    message: string,
    readonly details?: JsonValue,
  ) {
    super(message);
  }
}
