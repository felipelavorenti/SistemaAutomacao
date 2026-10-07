import { randomBytes } from 'node:crypto';
import type { NodeExecuteContext, NodeType, PropertyDescription } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { BinaryData, Item, JsonObject, JsonValue } from '../types.js';
import { binaryPropertyList, extensionFromMimeType, getBinary, toBinary } from '../binary.js';
import { callApi } from './api.js';
import { GMAIL_API, GMAIL_CONNECTION_TYPES, googleAccessToken } from './google.js';
import { isPlainObject } from './paths.js';

type Operation =
  | 'send'
  | 'reply'
  | 'createDraft'
  | 'sendDraft'
  | 'deleteDraft'
  | 'searchDrafts'
  | 'search'
  | 'get'
  | 'markRead'
  | 'markUnread'
  | 'addLabels'
  | 'removeLabels'
  | 'trash';

const COMPOSE: Operation[] = ['send', 'reply', 'createDraft'];
const BY_MESSAGE: Operation[] = ['reply', 'get', 'markRead', 'markUnread', 'addLabels', 'removeLabels', 'trash'];
const BY_DRAFT: Operation[] = ['sendDraft', 'deleteDraft'];

const when = (...ops: Operation[]) => ({ operation: ops });

const properties: PropertyDescription[] = [
  { name: 'connection', displayName: 'Conexão', type: 'connection', default: '', required: true, connectionTypes: GMAIL_CONNECTION_TYPES },
  {
    name: 'operation',
    displayName: 'Operação',
    type: 'options',
    default: 'send',
    options: [
      { name: 'Enviar e-mail', value: 'send' },
      { name: 'Responder e-mail', value: 'reply' },
      { name: 'Criar rascunho', value: 'createDraft' },
      { name: 'Enviar rascunho', value: 'sendDraft' },
      { name: 'Excluir rascunho', value: 'deleteDraft' },
      { name: 'Buscar rascunhos', value: 'searchDrafts' },
      { name: 'Buscar e-mails', value: 'search' },
      { name: 'Ler e-mail', value: 'get' },
      { name: 'Marcar como lido', value: 'markRead' },
      { name: 'Marcar como não lido', value: 'markUnread' },
      { name: 'Pôr etiquetas', value: 'addLabels' },
      { name: 'Tirar etiquetas', value: 'removeLabels' },
      { name: 'Mover para a lixeira', value: 'trash' },
    ],
  },
  {
    name: 'messageId',
    displayName: 'ID do e-mail',
    type: 'string',
    default: '',
    required: true,
    placeholder: '={{ $json.id }}',
    description: 'O id que a busca ou a leitura devolve.',
    showWhen: when(...BY_MESSAGE),
  },
  {
    name: 'replyToMessageId',
    displayName: 'Em resposta ao e-mail (ID)',
    type: 'string',
    default: '',
    description: 'Opcional. Deixa o rascunho na mesma conversa do e-mail, já com o assunto e os destinatários da resposta.',
    showWhen: when('createDraft'),
  },
  {
    name: 'draftId',
    displayName: 'ID do rascunho',
    type: 'string',
    default: '',
    required: true,
    placeholder: '={{ $json.id }}',
    description: 'O id que Criar rascunho ou Buscar rascunhos devolve.',
    showWhen: when(...BY_DRAFT),
  },
  {
    name: 'replyAll',
    displayName: 'Responder a todos',
    type: 'boolean',
    default: false,
    description: 'Inclui quem estava em Para e Cc no e-mail original, menos a própria conta.',
    showWhen: when('reply'),
  },
  {
    name: 'to',
    displayName: 'Para',
    type: 'string',
    default: '',
    placeholder: 'ana@empresa.com, Bruno <bruno@cliente.com>',
    description: 'Separe os endereços por vírgula. Na resposta, soma aos destinatários da resposta.',
    showWhen: when(...COMPOSE),
  },
  { name: 'cc', displayName: 'Cc', type: 'string', default: '', showWhen: when(...COMPOSE) },
  { name: 'bcc', displayName: 'Cco', type: 'string', default: '', showWhen: when(...COMPOSE) },
  {
    name: 'subject',
    displayName: 'Assunto',
    type: 'string',
    default: '',
    description: 'Na resposta, em branco usa "Re:" e o assunto original.',
    showWhen: when(...COMPOSE),
  },
  {
    name: 'bodyType',
    displayName: 'Formato do texto',
    type: 'options',
    default: 'text',
    options: [
      { name: 'Texto simples', value: 'text' },
      { name: 'HTML', value: 'html' },
    ],
    showWhen: when(...COMPOSE),
  },
  { name: 'body', displayName: 'Texto', type: 'string', default: '', multiline: true, showWhen: when(...COMPOSE) },
  {
    name: 'senderName',
    displayName: 'Nome do remetente',
    type: 'string',
    default: '',
    placeholder: 'Financeiro Empresa',
    description: 'Opcional. O e-mail sai da conta conectada; aqui só muda o nome que aparece.',
    showWhen: when(...COMPOSE),
  },
  { name: 'replyTo', displayName: 'Responder para', type: 'string', default: '', description: 'Opcional. Endereço que recebe as respostas.', showWhen: when(...COMPOSE) },
  {
    name: 'attachments',
    displayName: 'Anexos',
    type: 'list',
    default: [],
    description: 'Escolha um arquivo do computador ou passe o conteúdo em base64, por exemplo vindo da busca com anexos.',
    showWhen: when(...COMPOSE),
    fields: [
      { name: 'file', displayName: 'Arquivo', type: 'file', default: '', description: 'Escolha o arquivo no computador. Ele fica guardado no Info8n junto com o fluxo.' },
      { name: 'fileName', displayName: 'Nome do arquivo', type: 'string', default: '', placeholder: 'boleto.pdf', description: 'Em branco, usa o nome do arquivo escolhido.' },
      { name: 'content', displayName: 'Conteúdo (base64)', type: 'string', default: '', description: 'Só quando não escolher um arquivo.' },
      { name: 'mimeType', displayName: 'Tipo', type: 'string', default: '', placeholder: 'application/pdf', description: 'Em branco, usa o tipo do arquivo escolhido.' },
    ],
  },
  {
    name: 'attachmentProperties',
    displayName: 'Anexos dos arquivos do item',
    type: 'string',
    default: '',
    placeholder: 'data, attachment_0',
    description: 'Nomes dos arquivos do item que vão anexados, separados por vírgula (ex.: o "data" que o HTTP Request ou o Read Files from Disk devolve). Somam aos anexos acima.',
    showWhen: when(...COMPOSE),
  },
  {
    name: 'query',
    displayName: 'Busca',
    type: 'string',
    default: '',
    placeholder: 'from:nf@fornecedor.com is:unread newer_than:2d',
    description: 'Mesma sintaxe da caixa de busca do Gmail. Em branco, traz os mais recentes.',
    showWhen: when('search', 'searchDrafts'),
  },
  {
    name: 'labelFilter',
    displayName: 'Só com as etiquetas',
    type: 'string',
    default: '',
    placeholder: 'INBOX, Notas fiscais',
    description: 'Opcional. Nomes ou IDs das etiquetas, separados por vírgula.',
    showWhen: when('search'),
  },
  {
    name: 'includeSpamTrash',
    displayName: 'Incluir spam e lixeira',
    type: 'boolean',
    default: false,
    showWhen: when('search'),
  },
  {
    name: 'limit',
    displayName: 'Máximo de e-mails',
    type: 'number',
    default: 20,
    description: 'De 1 a 500. Cada e-mail ou rascunho encontrado vira um item.',
    showWhen: when('search', 'searchDrafts'),
  },
  {
    name: 'downloadAttachments',
    displayName: 'Trazer o conteúdo dos anexos',
    type: 'boolean',
    default: false,
    description: 'Cada anexo vira um arquivo do item (attachment_0, attachment_1...), como no n8n. Sem isso, vem só o nome, o tipo e o tamanho.',
    showWhen: when('search', 'searchDrafts', 'get'),
  },
  {
    name: 'attachmentsPrefix',
    displayName: 'Prefixo dos arquivos dos anexos',
    type: 'string',
    default: 'attachment_',
    description: 'O primeiro anexo fica em <prefixo>0, o segundo em <prefixo>1 e assim por diante.',
    showWhen: { operation: ['search', 'searchDrafts', 'get'], downloadAttachments: [true] },
  },
  {
    name: 'attachmentsBase64InJson',
    displayName: 'Também pôr o conteúdo em base64 no JSON',
    type: 'boolean',
    default: false,
    description: 'Como era antes dos arquivos do item: repete o conteúdo de cada anexo em attachments[n].content. Deixa a execução bem maior; ligue só se o fluxo ainda usa esse campo.',
    showWhen: { operation: ['search', 'searchDrafts', 'get'], downloadAttachments: [true] },
  },
  {
    name: 'labels',
    displayName: 'Etiquetas',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'Processado, STARRED',
    description: 'Nomes ou IDs das etiquetas, separados por vírgula. As do sistema: INBOX, STARRED, IMPORTANT, UNREAD, SPAM, TRASH.',
    showWhen: when('addLabels', 'removeLabels'),
  },
];

export const gmail: NodeType = {
  description: {
    type: 'gmail',
    displayName: 'Gmail',
    description: 'Envia e responde e-mails, cria, busca e envia rascunhos, busca e lê e-mails e cuida de etiquetas, uma vez por item.',
    group: 'action',
    inputs: 1,
    outputs: 1,
    properties,
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const output: Item[] = [];
    const labelCache = new Map<string, Promise<Map<string, string>>>();
    for (let i = 0; i < input.length; i++) {
      const connectionId = String((await ctx.getParam('connection', i)) ?? '');
      if (!connectionId) throw new NodeOperationError('Escolha a conexão do Gmail');
      const connection = await ctx.getConnection(connectionId);
      const token = await googleAccessToken(connection, ctx.signal);
      const api = new GmailApi(token, ctx.signal);
      const account = String(connection.data.oauthAccount ?? '');
      const labelIds = (names: string[]) => {
        if (!labelCache.has(connectionId)) labelCache.set(connectionId, api.labels());
        return resolveLabels(names, labelCache.get(connectionId)!);
      };
      const operation = String((await ctx.getParam('operation', i)) ?? 'send') as Operation;
      const param = async (name: string) => text(await ctx.getParam(name, i));
      const required = async (name: string, label: string) => {
        const value = await param(name);
        if (!value) throw new NodeOperationError(`Informe ${label}`, { item: i });
        return value;
      };

      switch (operation) {
        case 'send':
        case 'createDraft':
        case 'reply': {
          let reply: ReplyInfo | null = null;
          if (operation === 'reply') reply = await api.replyInfo(await required('messageId', 'o ID do e-mail'), account, flag(await ctx.getParam('replyAll', i)));
          if (operation === 'createDraft') {
            const original = await param('replyToMessageId');
            if (original) reply = await api.replyInfo(original, account, false);
          }
          const mail = await composeFromParams(ctx, i, reply, account);
          if (!mail.to.length && !mail.cc.length && !mail.bcc.length && operation !== 'createDraft') throw new NodeOperationError('Informe pelo menos um destinatário', { item: i });
          const raw = buildMime(mail);
          const threadId = reply?.threadId;
          if (operation === 'createDraft') {
            output.push({ json: await api.post('/drafts', { message: { raw, ...(threadId ? { threadId } : {}) } }) });
          } else {
            output.push({ json: await api.post('/messages/send', { raw, ...(threadId ? { threadId } : {}) }) });
          }
          break;
        }
        case 'sendDraft':
          output.push({ json: await api.post('/drafts/send', { id: await required('draftId', 'o ID do rascunho') }) });
          break;
        case 'deleteDraft': {
          const id = await required('draftId', 'o ID do rascunho');
          await api.call('DELETE', `/drafts/${encodeURIComponent(id)}`);
          output.push({ json: { id, excluido: true } });
          break;
        }
        case 'search': {
          const limit = Math.min(500, Math.max(1, Math.trunc(Number(await ctx.getParam('limit', i)) || 20)));
          const labels = splitList(await param('labelFilter'));
          const ids = await api.search({
            q: await param('query'),
            labelIds: labels.length ? await labelIds(labels) : [],
            includeSpamTrash: flag(await ctx.getParam('includeSpamTrash', i)),
            limit,
          });
          const download = await downloadOptions(ctx, i);
          for (const id of ids) output.push(await api.readMessage(id, download));
          break;
        }
        case 'searchDrafts': {
          const limit = Math.min(500, Math.max(1, Math.trunc(Number(await ctx.getParam('limit', i)) || 20)));
          const drafts = await api.searchDrafts({ q: await param('query'), limit });
          const download = await downloadOptions(ctx, i);
          for (const draft of drafts) {
            const message = await api.readMessage(draft.messageId, download);
            // id é o do rascunho, o que Enviar e Excluir rascunho pedem; o do e-mail fica em emailId.
            output.push({ ...message, json: { ...message.json, id: draft.id, emailId: draft.messageId } });
          }
          break;
        }
        case 'get':
          output.push(await api.readMessage(await required('messageId', 'o ID do e-mail'), await downloadOptions(ctx, i)));
          break;
        case 'markRead':
        case 'markUnread': {
          const id = await required('messageId', 'o ID do e-mail');
          const change: JsonObject = operation === 'markRead' ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] };
          output.push({ json: await api.post(`/messages/${encodeURIComponent(id)}/modify`, change) });
          break;
        }
        case 'addLabels':
        case 'removeLabels': {
          const id = await required('messageId', 'o ID do e-mail');
          const names = splitList(await required('labels', 'as etiquetas'));
          const ids = await labelIds(names);
          const change: JsonObject = operation === 'addLabels' ? { addLabelIds: ids } : { removeLabelIds: ids };
          output.push({ json: await api.post(`/messages/${encodeURIComponent(id)}/modify`, change) });
          break;
        }
        case 'trash': {
          const id = await required('messageId', 'o ID do e-mail');
          output.push({ json: await api.post(`/messages/${encodeURIComponent(id)}/trash`, {}) });
          break;
        }
        default:
          throw new NodeOperationError(`Operação desconhecida: ${operation}`);
      }
    }
    return [output];
  },
};

// ---------- API do Gmail ----------

interface ReplyInfo {
  threadId: string;
  subject: string;
  messageId: string;
  references: string;
  to: string[];
  cc: string[];
}

class GmailApi {
  constructor(
    private token: string,
    private signal?: AbortSignal,
  ) {}

  async call(method: string, path: string, body?: JsonValue): Promise<JsonValue> {
    return callApi({
      service: 'Gmail',
      method,
      url: `${GMAIL_API}${path}`,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: this.signal,
    });
  }

  async post(path: string, body: JsonValue): Promise<JsonObject> {
    const result = await this.call('POST', path, body);
    return isPlainObject(result) ? result : { resposta: result };
  }

  async get(path: string): Promise<JsonObject> {
    const result = await this.call('GET', path);
    return isPlainObject(result) ? result : {};
  }

  /** Nome (em minúsculas) e ID → ID de todas as etiquetas da conta. */
  async labels(): Promise<Map<string, string>> {
    const result = await this.get('/labels');
    const map = new Map<string, string>();
    for (const label of (Array.isArray(result.labels) ? result.labels : []).filter(isPlainObject)) {
      if (typeof label.id !== 'string') continue;
      map.set(label.id.toLowerCase(), label.id);
      if (typeof label.name === 'string') map.set(label.name.toLowerCase(), label.id);
    }
    return map;
  }

  async search(options: { q: string; labelIds: string[]; includeSpamTrash: boolean; limit: number }): Promise<string[]> {
    const ids: string[] = [];
    let pageToken = '';
    while (ids.length < options.limit) {
      const params = new URLSearchParams({ maxResults: String(Math.min(500, options.limit - ids.length)) });
      if (options.q) params.set('q', options.q);
      for (const id of options.labelIds) params.append('labelIds', id);
      if (options.includeSpamTrash) params.set('includeSpamTrash', 'true');
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.get(`/messages?${params}`);
      for (const m of (Array.isArray(page.messages) ? page.messages : []).filter(isPlainObject)) if (typeof m.id === 'string') ids.push(m.id);
      if (typeof page.nextPageToken !== 'string' || !page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
    return ids.slice(0, options.limit);
  }

  /** ID de cada rascunho e do e-mail que ele guarda. */
  async searchDrafts(options: { q: string; limit: number }): Promise<{ id: string; messageId: string }[]> {
    const drafts: { id: string; messageId: string }[] = [];
    let pageToken = '';
    while (drafts.length < options.limit) {
      const params = new URLSearchParams({ maxResults: String(Math.min(500, options.limit - drafts.length)) });
      if (options.q) params.set('q', options.q);
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.get(`/drafts?${params}`);
      for (const d of (Array.isArray(page.drafts) ? page.drafts : []).filter(isPlainObject)) {
        const message = isPlainObject(d.message) ? d.message : {};
        if (typeof d.id === 'string' && typeof message.id === 'string') drafts.push({ id: d.id, messageId: message.id });
      }
      if (typeof page.nextPageToken !== 'string' || !page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
    return drafts.slice(0, options.limit);
  }

  async readMessage(id: string, download: DownloadOptions): Promise<Item> {
    const message = await this.get(`/messages/${encodeURIComponent(id)}?format=full`);
    const parsed = parseMessage(message);
    if (!download.enabled) {
      for (const attachment of parsed.attachments) delete attachment.content;
      return { json: parsed as unknown as JsonObject };
    }
    // Como no n8n: cada anexo vira um arquivo do item, em <prefixo>0, <prefixo>1...
    const binary: Record<string, BinaryData> = {};
    for (const [index, attachment] of parsed.attachments.entries()) {
      if (attachment.content === undefined && typeof attachment.attachmentId === 'string') {
        const data = await this.get(`/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachment.attachmentId)}`);
        attachment.content = typeof data.data === 'string' ? fromBase64Url(data.data).toString('base64') : '';
      }
      const property = `${download.prefix}${index}`;
      binary[property] = toBinary(Buffer.from(attachment.content ?? '', 'base64'), {
        fileName: attachment.fileName || undefined,
        mimeType: attachment.mimeType || undefined,
      });
      attachment.binaryProperty = property;
      if (!download.base64InJson) delete attachment.content;
    }
    const json = parsed as unknown as JsonObject;
    return Object.keys(binary).length ? { json, binary } : { json };
  }

  async replyInfo(messageId: string, account: string, replyAll: boolean): Promise<ReplyInfo> {
    const fields = ['Subject', 'From', 'Reply-To', 'To', 'Cc', 'Message-ID', 'References'];
    const message = await this.get(`/messages/${encodeURIComponent(messageId)}?format=metadata&${fields.map((f) => `metadataHeaders=${f}`).join('&')}`);
    const headers = headerMap(message);
    const self = account.toLowerCase();
    const notSelf = (address: string) => emailOf(address) !== self;
    const sender = splitAddresses(headers['reply-to'] || headers.from || '');
    const to = replyAll ? [...sender, ...splitAddresses(headers.to ?? '').filter(notSelf)] : sender;
    const cc = replyAll ? splitAddresses(headers.cc ?? '').filter(notSelf) : [];
    const original = headers['message-id'] ?? '';
    return {
      threadId: typeof message.threadId === 'string' ? message.threadId : '',
      subject: headers.subject ?? '',
      messageId: original,
      references: [headers.references ?? '', original].filter(Boolean).join(' '),
      to: unique(to),
      cc: unique(cc),
    };
  }
}

interface DownloadOptions {
  enabled: boolean;
  prefix: string;
  base64InJson: boolean;
}

async function downloadOptions(ctx: NodeExecuteContext, i: number): Promise<DownloadOptions> {
  const enabled = flag(await ctx.getParam('downloadAttachments', i));
  if (!enabled) return { enabled, prefix: '', base64InJson: false };
  return {
    enabled,
    prefix: text(await ctx.getParam('attachmentsPrefix', i)) || 'attachment_',
    base64InJson: flag(await ctx.getParam('attachmentsBase64InJson', i)),
  };
}

async function resolveLabels(names: string[], labels: Promise<Map<string, string>>): Promise<string[]> {
  const map = await labels;
  return names.map((name) => {
    const id = map.get(name.toLowerCase());
    if (!id) throw new NodeOperationError(`Nenhuma etiqueta do Gmail chamada "${name}"`);
    return id;
  });
}

// ---------- Montagem do e-mail ----------

export interface Attachment {
  fileName: string;
  content: string;
  mimeType: string;
}

export interface Mail {
  from?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: string;
  subject: string;
  body: string;
  html: boolean;
  inReplyTo?: string;
  references?: string;
  attachments: Attachment[];
}

async function composeFromParams(ctx: NodeExecuteContext, i: number, reply: ReplyInfo | null, account: string): Promise<Mail> {
  const param = async (name: string) => text(await ctx.getParam(name, i));
  let subject = await param('subject');
  if (!subject && reply) subject = /^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`;
  const senderName = await param('senderName');
  return {
    // O e-mail sai sempre da conta conectada; o nome do remetente só muda o que aparece.
    from: senderName && account ? `${encodeWord(senderName)} <${account}>` : undefined,
    to: unique([...(reply?.to ?? []), ...splitAddresses(await param('to'))]),
    cc: unique([...(reply?.cc ?? []), ...splitAddresses(await param('cc'))]),
    bcc: splitAddresses(await param('bcc')),
    replyTo: (await param('replyTo')) || undefined,
    subject,
    body: await param('body'),
    html: (await param('bodyType')) === 'html',
    inReplyTo: reply?.messageId || undefined,
    references: reply?.references || undefined,
    attachments: [...(await attachmentsFrom(ctx, await ctx.getParam('attachments', i))), ...binaryAttachments(ctx.inputs[0]?.[i], await param('attachmentProperties'), i)],
  };
}

/** Anexos tirados dos arquivos do item (n8n: attachmentsUi.attachmentsBinary[].property). */
function binaryAttachments(item: Item | undefined, properties: string, itemIndex: number): Attachment[] {
  return binaryPropertyList(properties).map((property, index) => {
    const file = getBinary(item ?? { json: {} }, property, itemIndex);
    const extension = file.fileExtension ?? extensionFromMimeType(file.mimeType);
    return {
      fileName: file.fileName || `anexo-${index + 1}${extension ? `.${extension}` : ''}`,
      content: file.data,
      mimeType: file.mimeType || 'application/octet-stream',
    };
  });
}

async function attachmentsFrom(ctx: NodeExecuteContext, value: JsonValue): Promise<Attachment[]> {
  if (!Array.isArray(value)) return [];
  const attachments: Attachment[] = [];
  const rawRows = Array.isArray(ctx.node.parameters.attachments) ? ctx.node.parameters.attachments : [];
  for (const [index, row] of value.filter(isPlainObject).entries()) {
    const fileId = text(row.file ?? null);
    if (fileId) {
      // Arquivo escolhido na tela: nome e tipo vêm dele, a menos que o nó informe outros.
      const file = await ctx.getFile(fileId);
      attachments.push({
        fileName: text(row.fileName ?? null) || file.name,
        content: file.content.toString('base64'),
        mimeType: text(row.mimeType ?? null) || file.mimeType || 'application/octet-stream',
      });
      continue;
    }
    const content = text(row.content ?? null).replace(/\s+/g, '');
    const fileName = text(row.fileName ?? null) || `anexo-${index + 1}`;
    if (!content) {
      // Fluxo antigo que lia o base64 dos anexos baixados: agora o conteúdo fica nos arquivos do item.
      const raw = rawRows[index];
      const expression = isPlainObject(raw) && typeof raw.content === 'string' && raw.content.startsWith('=') ? raw.content : '';
      if (/attachments\b[\s\S]*\.content\b/.test(expression)) {
        throw new NodeOperationError(
          `O anexo ${fileName} veio vazio: o base64 dos anexos baixados não fica mais em attachments[n].content. Use "Anexos dos arquivos do item" (ex.: attachment_0) ou ligue "Também pôr o conteúdo em base64 no JSON" no nó que baixa os anexos.`,
        );
      }
      continue;
    }
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(content)) throw new NodeOperationError(`O conteúdo do anexo ${fileName} não está em base64`);
    attachments.push({ fileName, content: content.replace(/-/g, '+').replace(/_/g, '/'), mimeType: text(row.mimeType ?? null) || 'application/octet-stream' });
  }
  return attachments;
}

/** Monta o e-mail no formato MIME e devolve em base64url, como a API do Gmail pede em "raw". */
export function buildMime(mail: Mail): string {
  const lines: string[] = [];
  if (mail.from) lines.push(`From: ${mail.from}`);
  if (mail.to.length) lines.push(`To: ${mail.to.map(encodeAddress).join(', ')}`);
  if (mail.cc.length) lines.push(`Cc: ${mail.cc.map(encodeAddress).join(', ')}`);
  if (mail.bcc.length) lines.push(`Bcc: ${mail.bcc.map(encodeAddress).join(', ')}`);
  if (mail.replyTo) lines.push(`Reply-To: ${encodeAddress(mail.replyTo)}`);
  lines.push(`Subject: ${encodeWord(mail.subject)}`);
  if (mail.inReplyTo) lines.push(`In-Reply-To: ${mail.inReplyTo}`);
  if (mail.references) lines.push(`References: ${mail.references}`);
  lines.push('MIME-Version: 1.0');

  const bodyPart = [
    `Content-Type: ${mail.html ? 'text/html' : 'text/plain'}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(mail.body, 'utf8').toString('base64')),
  ];
  if (!mail.attachments.length) {
    lines.push(...bodyPart);
  } else {
    const boundary = `info8n_${randomBytes(12).toString('hex')}`;
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...bodyPart);
    for (const attachment of mail.attachments) {
      const name = encodeWord(attachment.fileName);
      lines.push(
        `--${boundary}`,
        `Content-Type: ${attachment.mimeType}; name="${name}"`,
        `Content-Disposition: attachment; filename="${name}"`,
        'Content-Transfer-Encoding: base64',
        '',
        wrap(attachment.content),
      );
    }
    lines.push(`--${boundary}--`);
  }
  return toBase64Url(Buffer.from(lines.join('\r\n'), 'utf8'));
}

/** Cabeçalho com acento vira "encoded-word" (RFC 2047); ASCII puro fica como está. */
function encodeWord(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ');
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/** "Nome <email>" com o nome codificado quando tem acento. */
function encodeAddress(address: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(address);
  if (!match || !match[1]) return address.trim();
  return `${encodeWord(match[1])} <${match[2]}>`;
}

function wrap(base64: string): string {
  return base64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

// ---------- Leitura do e-mail ----------

interface ParsedAttachment {
  fileName: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
  content?: string;
  /** Arquivo do item com o conteúdo do anexo, quando baixado. */
  binaryProperty?: string;
}

interface ParsedMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  from: string;
  to: string;
  cc: string;
  replyTo: string;
  subject: string;
  date: string | null;
  messageId: string;
  text: string;
  html: string;
  attachments: ParsedAttachment[];
}

/** Resume a mensagem do Gmail (formato "full") nos campos que os fluxos usam. */
export function parseMessage(message: JsonObject): ParsedMessage {
  const headers = headerMap(message);
  const parsed: ParsedMessage = {
    id: typeof message.id === 'string' ? message.id : '',
    threadId: typeof message.threadId === 'string' ? message.threadId : '',
    labelIds: Array.isArray(message.labelIds) ? message.labelIds.map(String) : [],
    snippet: typeof message.snippet === 'string' ? message.snippet : '',
    from: headers.from ?? '',
    to: headers.to ?? '',
    cc: headers.cc ?? '',
    replyTo: headers['reply-to'] ?? '',
    subject: headers.subject ?? '',
    date: typeof message.internalDate === 'string' ? new Date(Number(message.internalDate)).toISOString() : null,
    messageId: headers['message-id'] ?? '',
    text: '',
    html: '',
    attachments: [],
  };
  const walk = (part: JsonValue) => {
    if (!isPlainObject(part)) return;
    const mimeType = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
    const body = isPlainObject(part.body) ? part.body : {};
    const fileName = typeof part.filename === 'string' ? part.filename : '';
    if (fileName || typeof body.attachmentId === 'string') {
      parsed.attachments.push({
        fileName,
        mimeType,
        size: typeof body.size === 'number' ? body.size : 0,
        ...(typeof body.attachmentId === 'string' ? { attachmentId: body.attachmentId } : {}),
        ...(typeof body.data === 'string' ? { content: fromBase64Url(body.data).toString('base64') } : {}),
      });
    } else if (typeof body.data === 'string' && (mimeType === 'text/plain' || mimeType === 'text/html')) {
      const content = fromBase64Url(body.data).toString('utf8');
      if (mimeType === 'text/plain' && !parsed.text) parsed.text = content;
      if (mimeType === 'text/html' && !parsed.html) parsed.html = content;
    }
    if (Array.isArray(part.parts)) part.parts.forEach(walk);
  };
  walk(message.payload ?? null);
  return parsed;
}

function headerMap(message: JsonObject): Record<string, string> {
  const payload = isPlainObject(message.payload) ? message.payload : {};
  const map: Record<string, string> = {};
  for (const h of (Array.isArray(payload.headers) ? payload.headers : []).filter(isPlainObject)) {
    if (typeof h.name === 'string' && typeof h.value === 'string' && !(h.name.toLowerCase() in map)) map[h.name.toLowerCase()] = h.value;
  }
  return map;
}

// ---------- Utilitários ----------

function text(value: JsonValue): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value.trim() : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function flag(value: JsonValue): boolean {
  return value === true || (typeof value === 'string' && ['true', 'sim', '1'].includes(value.trim().toLowerCase())) || value === 1;
}

function splitList(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Separa endereços por vírgula, sem quebrar "Sobrenome, Nome" <email>. */
export function splitAddresses(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<') angle = true;
    else if (ch === '>') angle = false;
    if ((ch === ',' || ch === ';' || ch === '\n') && !quoted && !angle) {
      if (current.trim()) out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function emailOf(address: string): string {
  return (/<([^>]+)>/.exec(address)?.[1] ?? address).trim().toLowerCase();
}

function unique(addresses: string[]): string[] {
  const seen = new Set<string>();
  return addresses.filter((a) => {
    const key = emailOf(a);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toBase64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
