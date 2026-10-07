/**
 * Modelo de dados do fluxo e da execução.
 *
 * Os dados trafegam entre os nós como uma lista de itens, como no n8n:
 * cada nó recebe N itens em cada entrada e devolve N itens em cada saída.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * Arquivo dentro de um item, no formato do n8n. `data` é o conteúdo em base64; na execução gravada
 * ele é retirado (`omitted`) ou trocado por uma referência (`ref`) para baixar depois.
 */
export interface BinaryData {
  data: string;
  mimeType: string;
  fileName?: string;
  fileExtension?: string;
  /** Tamanho legível, como no n8n (ex.: "12.3 kB"). */
  fileSize?: string;
  /** Tamanho em bytes. */
  bytes?: number;
  fileType?: string;
  directory?: string;
  /** Conteúdo retirado ao gravar a execução. */
  omitted?: boolean;
  /** Referência para baixar o conteúdo guardado da execução. */
  ref?: string;
}

export interface Item {
  json: JsonObject;
  /** Arquivos do item, pelo nome da propriedade (o padrão do n8n é "data"). */
  binary?: Record<string, BinaryData>;
}

/**
 * Um parâmetro de nó é um valor JSON qualquer. Strings que começam com "="
 * estão no modo Expressão (ex.: "=Bearer {{ $json.token }}"); o resto é Fixo.
 */
export type NodeParameters = { [key: string]: JsonValue };

export interface NodeSettings {
  /** Tenta de novo quando o nó falha. */
  retryOnFail?: boolean;
  /** Número total de tentativas (incluindo a primeira). */
  maxTries?: number;
  /** Espera entre tentativas, em milissegundos. */
  waitBetweenTriesMs?: number;
  /** Em vez de parar o fluxo, devolve o erro como item na saída. */
  continueOnFail?: boolean;
  /** Tempo máximo do nó, em milissegundos. */
  timeoutMs?: number;
}

export interface NodeInstance {
  id: string;
  name: string;
  type: string;
  position: { x: number; y: number };
  parameters: NodeParameters;
  settings?: NodeSettings;
  disabled?: boolean;
  notes?: string;
}

export interface Connection {
  from: string;
  fromOutput: number;
  to: string;
  toInput: number;
}

export interface WorkflowDefinition {
  nodes: NodeInstance[];
  connections: Connection[];
}

export type NodeRunStatus = 'success' | 'error';

export interface NodeError {
  message: string;
  /** Detalhes estruturados, ex.: status e corpo da resposta da API. */
  details?: JsonValue;
}

export interface NodeRun {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: NodeRunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tries: number;
  input: Item[][];
  output: Item[][];
  error?: NodeError;
  /** Informações extras do nó, ex.: logs do Code e IDs das execuções de subfluxo. */
  meta?: JsonObject;
}

export type ExecutionStatus = 'success' | 'error' | 'canceled';

export interface ExecutionResult {
  status: ExecutionStatus;
  startedAt: string;
  finishedAt: string;
  runs: NodeRun[];
  /** Nó e erro que interromperam a execução, quando houver. */
  error?: NodeError & { nodeId?: string; nodeName?: string };
  /** Itens produzidos pelo último nó executado. */
  lastOutput: Item[];
}
