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
  /** Mostra o campo só quando outros campos têm certos valores. */
  showWhen?: Record<string, JsonValue[]>;
}

export interface NodeTypeDescription {
  type: string;
  displayName: string;
  description: string;
  group: 'trigger' | 'action' | 'logic' | 'data';
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
  /** Roda código JavaScript do usuário no isolate da execução. */
  runCode(code: string, itemIndex: number): Promise<{ result: JsonValue; logs: string[] }>;
  /** Executa outro fluxo e devolve a saída dele. */
  executeWorkflow(workflowId: string, items: Item[]): Promise<SubworkflowResult>;
  /** Estado do nó que dura a execução inteira (ex.: os lotes pendentes do Loop). */
  state: Record<string, unknown>;
  /** Informações extras que ficam registradas na execução do nó. */
  meta: JsonObject;
  signal: AbortSignal;
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
