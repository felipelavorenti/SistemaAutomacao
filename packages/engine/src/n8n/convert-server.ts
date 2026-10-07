import type { JsonObject, JsonValue } from '../types.js';
import { isObject, jsonish, type Converted, type Ctx, type Params } from './import.js';

/**
 * Conversores do importador do n8n para os nós de servidor e protocolos (Fase 4): Send Email,
 * FTP, SSH, Execute Command, Git, RSS Read, n8n (API) e Data Table.
 */

const opts = (params: Params, key = 'options'): Params => (isObject(params[key]) ? (params[key] as Params) : {});
const v = (value: unknown, fallback: JsonValue): JsonValue => (value === undefined || value === null ? fallback : jsonish(value));
const bool = (value: unknown, fallback: boolean): JsonValue => (value === undefined || value === null ? fallback : typeof value === 'string' && value.startsWith('=') ? value : value === true || value === 'true');
/** Valor de um campo "resource locator" do n8n ({ __rl, mode, value }). */
const rl = (value: unknown): unknown => (isObject(value) && '__rl' in value ? value.value : value);

// ---------- Send Email ----------

function emailSend({ node, params, warn }: Ctx): Converted | null {
  const operation = String(params.operation ?? 'send');
  if (operation !== 'send') {
    warn('o envio que espera resposta ("Send and Wait for Response") não existe aqui');
    return null;
  }
  const o = opts(params);
  const version = node.typeVersion ?? 1;
  let format: string;
  if (version < 2) {
    // Versão 1: sem campo de formato; com HTML preenchido, manda os dois.
    format = params.html ? (params.text ? 'both' : 'html') : 'text';
  } else {
    format = String(params.emailFormat ?? (version >= 2.1 ? 'html' : 'text'));
  }
  if (o.appendAttribution !== false && version >= 2.1) warn('o rodapé "This email was sent automatically with n8n" não é incluído aqui');
  return {
    type: 'emailSend',
    parameters: {
      connection: '',
      fromEmail: v(params.fromEmail, ''),
      toEmail: v(params.toEmail, ''),
      subject: v(params.subject, ''),
      emailFormat: ['html', 'text', 'both'].includes(format) ? format : 'html',
      html: v(params.html, ''),
      text: v(params.text, ''),
      ccEmail: v(o.ccEmail ?? params.ccEmail, ''),
      bccEmail: v(o.bccEmail ?? params.bccEmail, ''),
      replyTo: v(o.replyTo, ''),
      attachments: v(o.attachments ?? params.attachments, ''),
      allowUnauthorizedCerts: bool(o.allowUnauthorizedCerts, false),
    },
  };
}

// ---------- FTP ----------

function ftp({ params }: Ctx): Converted {
  const o = opts(params);
  const operation = String(params.operation ?? 'download');
  return {
    type: 'ftp',
    parameters: {
      connection: '',
      operation: ['download', 'upload', 'list', 'rename', 'delete'].includes(operation) ? operation : 'download',
      path: v(params.path, operation === 'list' ? '/' : ''),
      binaryPropertyName: v(params.binaryPropertyName, 'data'),
      binaryData: bool(params.binaryData, true),
      fileContent: v(params.fileContent, ''),
      recursive: bool(params.recursive, false),
      oldPath: v(params.oldPath, ''),
      newPath: v(params.newPath, ''),
      createDirectories: bool(o.createDirectories, false),
      folder: bool(o.folder, false),
      recursiveDelete: bool(o.recursive, false),
    },
  };
}

// ---------- SSH ----------

function ssh({ params }: Ctx): Converted {
  const o = opts(params);
  const resource = String(params.resource ?? 'command');
  return {
    type: 'ssh',
    parameters: {
      connection: '',
      resource: resource === 'file' ? 'file' : 'command',
      operation: String(params.operation ?? (resource === 'file' ? 'upload' : 'execute')),
      command: v(params.command, ''),
      cwd: v(params.cwd, '/'),
      path: v(params.path, ''),
      binaryPropertyName: v(params.binaryPropertyName, 'data'),
      fileName: v(o.fileName, ''),
    },
  };
}

// ---------- Execute Command ----------

function executeCommand({ params }: Ctx): Converted {
  return { type: 'executeCommand', parameters: { executeOnce: bool(params.executeOnce, true), command: v(params.command, '') } };
}

// ---------- Git ----------

const GIT_OPERATIONS = ['add', 'addConfig', 'clone', 'commit', 'fetch', 'listConfig', 'log', 'pull', 'push', 'pushTags', 'status', 'switchBranch', 'tag', 'userSetup'];

function git({ params, warn }: Ctx): Converted | null {
  const o = opts(params);
  const operation = String(params.operation ?? 'log');
  if (!GIT_OPERATIONS.includes(operation)) {
    warn(`a operação "${operation}" do Git não existe aqui`);
    return null;
  }
  if (operation === 'userSetup') warn('informe o nome e o e-mail do usuário no nó (Configurar usuário)');
  warn('a pasta do repositório precisa ficar dentro de FILES_DIRS do servidor');
  return {
    type: 'git',
    parameters: {
      authentication: String(params.authentication ?? 'none') === 'gitPassword' ? 'gitPassword' : 'none',
      connection: '',
      operation,
      repositoryPath: v(params.repositoryPath, ''),
      sourceRepository: v(params.sourceRepository, ''),
      pathsToAdd: v(params.pathsToAdd ?? o.pathsToAdd, ''),
      message: v(params.message, ''),
      key: v(params.key, ''),
      value: v(params.value, ''),
      mode: String(o.mode ?? 'set') === 'append' ? 'append' : 'set',
      returnAll: bool(params.returnAll, false),
      limit: v(params.limit, 100),
      file: v(o.file, ''),
      targetRepository: v(o.targetRepository, ''),
      branch: v(o.branch, ''),
      name: v(params.name, ''),
      branchName: v(params.branchName, ''),
      createBranch: bool(o.createBranch ?? params.createBranch, false),
      startPoint: v(o.startPoint ?? params.startPoint, ''),
      userName: '',
      userEmail: '',
    },
  };
}

// ---------- RSS Read ----------

function rssFeedRead({ params }: Ctx): Converted {
  return { type: 'rssFeedRead', parameters: { url: v(params.url, ''), ignoreSSL: bool(opts(params).ignoreSSL, false) } };
}

// ---------- n8n (API) ----------

function n8nApi({ params, warn }: Ctx): Converted | null {
  const resource = String(params.resource ?? 'workflow');
  const operation = String(params.operation ?? 'getAll');
  if (resource === 'audit') {
    warn('a auditoria de segurança do n8n não existe aqui; use a tela Auditoria');
    return null;
  }
  if (resource === 'execution' && operation === 'delete') {
    warn('excluir execução pela API não existe aqui');
    return null;
  }
  const filters = opts(params, 'filters');
  const out: JsonObject = {
    connection: '',
    resource: resource === 'credential' ? 'connection' : resource,
    operation,
    workflowId: v(rl(params.workflowId), ''),
    executionId: v(params.executionId, ''),
    returnAll: bool(params.returnAll, false),
    limit: v(params.limit, 100),
  };
  if (resource === 'workflow') {
    if (operation === 'getAll') {
      out.activeWorkflows = bool(filters.activeWorkflows, false);
      if (filters.tags) warn('o filtro por tags não existe aqui');
    }
    if (operation === 'create' || operation === 'update') {
      out.workflowObject = v(params.workflowObject, '{}');
      warn('o JSON do fluxo precisa estar no formato do Info8n (name, folderId e definition), não no do n8n');
    }
  }
  if (resource === 'execution' && operation === 'getAll') {
    out.workflowFilter = v(rl(filters.workflowId), '');
    const status = String(filters.status ?? '');
    out.statusFilter = status === 'waiting' || status === 'error' || status === 'success' ? status : '';
  }
  if (resource === 'credential') {
    out.name = v(params.name, '');
    out.connectionType = v(params.credentialTypeName, '');
    out.data = v(params.data, '{}');
    out.connectionId = v(params.credentialId, '');
    if (operation === 'create') warn('os tipos e campos de conexão daqui são outros; confira o tipo e os dados (operação Tipos de conexão)');
  }
  warn('crie um token de API em Minha conta e cadastre a conexão "API do Info8n"');
  return { type: 'info8n', parameters: out };
}

// ---------- Data Table ----------

const CONDITION_MAP: Record<string, string> = { eq: 'eq', neq: 'neq', like: 'like', ilike: 'ilike', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', isEmpty: 'isEmpty', isNotEmpty: 'isNotEmpty', isTrue: 'isTrue', isFalse: 'isFalse' };

function dataTable({ params, warn }: Ctx): Converted | null {
  const resource = String(params.resource ?? 'row');
  const operation = String(params.operation ?? 'insert');
  const tableRef = params.dataTableId;
  // O ID do n8n não existe aqui; o nome (cachedResultName) é encontrado se a tabela for criada com o mesmo nome.
  const tableName = isObject(tableRef) ? (tableRef.cachedResultName ?? (tableRef.mode === 'name' ? tableRef.value : undefined)) : undefined;
  const reference = tableName !== undefined ? tableName : rl(tableRef);
  if (tableRef !== undefined) warn(`crie a tabela de dados${tableName ? ` "${String(tableName)}"` : ''} em Tabelas de dados com as mesmas colunas (o n8n não exporta as tabelas)`);

  const columns = isObject(params.columns) ? params.columns : {};
  const values = isObject(columns.value) ? Object.entries(columns.value).map(([column, value]) => ({ column, value: jsonish(value) })) : [];
  const conditions = (isObject(params.filters) && Array.isArray(params.filters.conditions) ? params.filters.conditions : []).filter(isObject).map((c) => ({
    column: String(c.keyName ?? ''),
    condition: CONDITION_MAP[String(c.condition ?? 'eq')] ?? 'eq',
    value: jsonish(c.keyValue ?? ''),
  }));
  const o = opts(params);
  const parameters: JsonObject = {
    resource: resource === 'table' ? 'table' : 'row',
    operation,
    dataTable: v(reference, ''),
    mappingMode: String(columns.mappingMode ?? 'defineBelow') === 'autoMapInputData' ? 'autoMapInputData' : 'defineBelow',
    values,
    matchType: String(params.matchType ?? 'anyCondition') === 'allConditions' ? 'allConditions' : 'anyCondition',
    conditions,
    returnAll: bool(params.returnAll, false),
    limit: v(params.limit, 50),
    dryRun: bool(o.dryRun, false),
  };
  if (resource === 'table') {
    parameters.tableName = v(params.tableName, '');
    const cols = isObject(params.columns) && Array.isArray(params.columns.column) ? params.columns.column : [];
    parameters.tableColumns = cols.filter(isObject).map((c) => ({ name: String(c.name ?? ''), type: ['string', 'number', 'boolean', 'date'].includes(String(c.type)) ? String(c.type) : 'string' }));
    parameters.reuseExisting = bool(o.reuseTable ?? o.reuseExisting, false);
    parameters.newName = v(params.newName, '');
  }
  return { type: 'dataTable', parameters };
}

export const converters: Record<string, (ctx: Ctx) => Converted | null> = {
  emailSend,
  ftp,
  ssh,
  executeCommand,
  git,
  rssFeedRead,
  n8n: n8nApi,
  dataTable,
};
