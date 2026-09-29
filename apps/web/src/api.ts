// Tipos espelhados do servidor e do motor (@sa/engine).

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export interface Item {
  json: JsonObject;
}

export interface NodeSettings {
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTriesMs?: number;
  continueOnFail?: boolean;
  timeoutMs?: number;
}

export interface NodeInstance {
  id: string;
  name: string;
  type: string;
  position: { x: number; y: number };
  parameters: { [key: string]: JsonValue };
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

export interface PropertyDescription {
  name: string;
  displayName: string;
  type: 'string' | 'number' | 'boolean' | 'options' | 'json' | 'code' | 'connection' | 'workflow' | 'erpClient' | 'erpEndpoint' | 'erpVariables' | 'list';
  multiline?: boolean;
  default: JsonValue;
  description?: string;
  placeholder?: string;
  required?: boolean;
  options?: { name: string; value: string }[];
  connectionTypes?: string[];
  fields?: PropertyDescription[];
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
  properties: PropertyDescription[];
}

export interface NodeRun {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: 'success' | 'error';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tries: number;
  input: Item[][];
  output: Item[][];
  error?: { message: string; details?: JsonValue };
  meta?: { logs?: string[]; subExecutionIds?: string[] };
}

export interface NodeRunSummary {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: 'success' | 'error';
  startedAt: string;
  durationMs: number;
  tries: number;
  runs?: number;
  inputItems: number;
  outputItems: number[];
  error?: string;
}

export type ExecutionStatus = 'queued' | 'running' | 'success' | 'error' | 'canceled';

export interface ExecutionListItem {
  id: string;
  workflow_id: string;
  workflow_name: string;
  mode: string;
  status: ExecutionStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  error_node: string | null;
  triggered_by_name: string | null;
  duration_ms: number | null;
  data_size: number | null;
  parent_execution_id: string | null;
}

export interface ExecutionDetail extends ExecutionListItem {
  workflow_version: number | null;
  retry_of: string | null;
  definition: WorkflowDefinition;
  input: Item[] | null;
  error: { message: string; details?: JsonValue; nodeName?: string } | null;
  summary: NodeRunSummary[] | null;
  runs: NodeRun[] | null;
  children: { id: string; workflow_id: string; workflow_name: string; status: ExecutionStatus; created_at: string; error_message: string | null }[];
}

export interface WorkflowListItem {
  id: string;
  name: string;
  folder_id: string;
  folder_name: string;
  active: boolean;
  scheduled: boolean;
  callable: boolean;
  version: number;
  updated_at: string;
  updated_by_name: string | null;
  last_execution: { id: string; status: ExecutionStatus; createdAt: string } | null;
}

export interface Workflow {
  id: string;
  name: string;
  folder_id: string;
  active: boolean;
  definition: WorkflowDefinition;
  version: number;
  updated_at: string;
  issues: { nodeId?: string; message: string }[];
}

export interface Me {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'editor' | 'operator' | 'viewer';
  mustChangePassword: boolean;
  permissions: { editWorkflows: boolean; executeWorkflows: boolean; editConnections: boolean; admin: boolean };
}

export interface Folder {
  id: string;
  name: string;
}

export interface Client {
  id: string;
  name: string;
  notes: string;
}

export interface ConnectionField {
  name: string;
  displayName: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
  default?: string;
  options?: { name: string; value: string }[];
  hint?: string;
}

export interface ConnectionType {
  type: string;
  displayName: string;
  testable?: boolean;
  fields: ConnectionField[];
}

export interface ConnectionItem {
  id: string;
  name: string;
  type: string;
  typeName: string;
  clientId: string | null;
  clientName: string | null;
  data: Record<string, string>;
  updatedAt: string;
  updatedByName: string | null;
}

export interface UserItem {
  id: string;
  email: string;
  name: string;
  role: Me['role'];
  active: boolean;
  locked_until: string | null;
  folder_ids: string[];
  client_ids: string[];
}

export interface AuditItem {
  id: number;
  at: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_name: string | null;
  before: JsonValue;
  after: JsonValue;
  ip: string | null;
  user_name: string | null;
  user_email: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Listener = (status: number, code?: string) => void;
let authListener: Listener = () => {};
export function onAuthProblem(listener: Listener): void {
  authListener = listener;
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    credentials: 'include',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const code = (data?.details as { code?: string } | undefined)?.code;
    if (res.status === 401 || code === 'must_change_password') authListener(res.status, code);
    throw new ApiError(res.status, data?.error ?? `Erro ${res.status}`, data?.details);
  }
  return data as T;
}

export const get = <T,>(url: string) => api<T>('GET', url);
export const post = <T,>(url: string, body: unknown = {}) => api<T>('POST', url, body);
export const put = <T,>(url: string, body: unknown) => api<T>('PUT', url, body);
export const del = <T,>(url: string) => api<T>('DELETE', url);

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (Array.isArray(err.details)) {
      const items = (err.details as { message?: string }[]).map((d) => d.message).filter(Boolean);
      if (items.length) return `${err.message}: ${items.join('; ')}`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export const STATUS_LABEL: Record<ExecutionStatus, string> = {
  queued: 'Na fila',
  running: 'Executando',
  success: 'Sucesso',
  error: 'Erro',
  canceled: 'Cancelada',
};

export const MODE_LABEL: Record<string, string> = {
  manual: 'Manual',
  schedule: 'Agendada',
  subworkflow: 'Subfluxo',
  retry: 'Reexecução',
};

export const ROLE_LABEL: Record<Me['role'], string> = {
  admin: 'Administrador',
  editor: 'Editor',
  operator: 'Operador',
  viewer: 'Leitor',
};

export function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

// ---------- Catálogo de APIs por ERP ----------

export interface ClientField {
  name: string;
  label: string;
  secret: boolean;
}

export interface ApiVariable {
  name: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'json';
  required: boolean;
  default: string;
}

export interface Erp {
  id: string;
  name: string;
  baseUrl: string;
  authType: 'none' | 'bearer' | 'basic' | 'header';
  authHeader: string | null;
  clientFields: ClientField[];
  notes: string;
  updatedAt: string;
  endpoints?: number;
  clients?: number;
}

export interface ErpEndpoint {
  id: string;
  name: string;
  description: string;
  method: string;
  path: string;
  headers: { name: string; value: string }[];
  query: { name: string; value: string }[];
  bodyType: 'none' | 'json' | 'form' | 'text';
  body: string;
  variables: ApiVariable[];
  usesAuth: boolean;
}

export interface ErpClientItem {
  id: string;
  clientId: string;
  clientName: string;
  label: string;
  values: Record<string, string>;
  updatedAt: string;
}

export interface ErpDetail extends Erp {
  endpoints: never;
  clients: never;
}

export interface ApiCatalog {
  clients: { id: string; erpId: string; erpName: string; clientName: string; label: string }[];
  endpoints: { id: string; erpId: string; name: string; description: string; method: string; path: string; variables: ApiVariable[] }[];
}

export interface DbCommand {
  id: number;
  at: string;
  execution_id: string | null;
  workflow_id: string | null;
  workflow_name: string | null;
  node_name: string;
  connection_name: string | null;
  client_name: string | null;
  db_type: string;
  operation: string;
  sql: string;
  params: JsonValue;
  rows: number | null;
  rows_affected: number | null;
  duration_ms: number;
  error: string | null;
  triggered_by_name: string | null;
}
