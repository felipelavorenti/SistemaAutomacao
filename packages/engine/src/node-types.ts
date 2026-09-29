import type { ApiEndpointData } from './catalog.js';
import type { DbResult, ProcedureParam } from './database/drivers.js';
import type { Item, JsonObject, JsonValue, NodeInstance } from './types.js';

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
  | 'list';

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
  /** Tempo limite padrão do nó, quando diferente do padrão da execução. */
  defaultTimeoutMs?: number;
  properties: PropertyDescription[];
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
