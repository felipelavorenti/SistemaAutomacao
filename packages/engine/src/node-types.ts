import type { Item, JsonObject, JsonValue, NodeInstance } from './types.js';

export type PropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'options'
  | 'json'
  | 'code'
  | 'connection'
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
  signal: AbortSignal;
}

export interface NodeType {
  description: NodeTypeDescription;
  /** Devolve os itens de cada saída. */
  execute(ctx: NodeExecuteContext): Promise<Item[][]>;
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
