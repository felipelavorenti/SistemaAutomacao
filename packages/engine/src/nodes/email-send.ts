import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { ConnectionData, NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { Item, JsonObject } from '../types.js';
import { binaryPropertyList, getBinary } from '../binary.js';
import { bool, errMessage, num, str, toJson } from './values.js';

/**
 * Send Email (SMTP): envia e-mail por qualquer servidor SMTP, como o nó Send Email do n8n.
 * Cada item vira um e-mail; a saída é a resposta do servidor para cada um.
 */

export const SMTP_CONNECTION_TYPES = ['smtp'];

/** Monta o transporte do nodemailer com os dados da conexão SMTP. */
export function smtpTransportOptions(connection: ConnectionData, allowUnauthorizedCerts: boolean): SMTPTransport.Options {
  const d = connection.data;
  const host = str(d.host).trim();
  if (!host) throw new NodeOperationError('A conexão SMTP está sem o servidor');
  const options: SMTPTransport.Options = {
    host,
    port: num(d.port, 465),
    secure: bool(d.secure, true),
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 120_000,
    tls: { rejectUnauthorized: !allowUnauthorizedCerts },
  };
  if (bool(d.disableStartTls)) options.ignoreTLS = true;
  if (str(d.hostName).trim()) options.name = str(d.hostName).trim();
  if (str(d.user)) options.auth = { user: str(d.user), pass: str(d.password) };
  return options;
}

export async function testSmtpConnection(connection: ConnectionData): Promise<void> {
  const transport = nodemailer.createTransport(smtpTransportOptions(connection, false));
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

const formatShow = (...formats: string[]) => ({ emailFormat: formats });

export const emailSend: NodeType = {
  description: {
    type: 'emailSend',
    displayName: 'Send Email',
    description: 'Envia e-mail por um servidor SMTP (a empresa, Outlook, Gmail com senha de app e outros). Cada item vira um e-mail.',
    group: 'action',
    inputs: 1,
    outputs: 1,
    defaultTimeoutMs: 300_000,
    properties: [
      { name: 'connection', displayName: 'Conexão SMTP', type: 'connection', default: '', required: true, connectionTypes: SMTP_CONNECTION_TYPES },
      {
        name: 'fromEmail',
        displayName: 'De',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'Info8n <automacao@empresa.com.br>',
        description: 'Remetente. Aceita "Nome <email>". O servidor costuma exigir o mesmo endereço do usuário da conexão.',
      },
      {
        name: 'toEmail',
        displayName: 'Para',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'cliente@empresa.com.br, outro@empresa.com.br',
        description: 'Um ou mais endereços separados por vírgula.',
      },
      { name: 'subject', displayName: 'Assunto', type: 'string', default: '' },
      {
        name: 'emailFormat',
        displayName: 'Formato',
        type: 'options',
        default: 'html',
        options: [
          { name: 'HTML', value: 'html' },
          { name: 'Texto', value: 'text' },
          { name: 'Os dois (HTML e texto)', value: 'both' },
        ],
        description: 'Com os dois, o programa de e-mail mostra o HTML e usa o texto quando não consegue mostrar HTML.',
      },
      { name: 'html', displayName: 'Corpo (HTML)', type: 'string', default: '', multiline: true, showWhen: formatShow('html', 'both') },
      { name: 'text', displayName: 'Corpo (texto)', type: 'string', default: '', multiline: true, showWhen: formatShow('text', 'both') },
      { name: 'ccEmail', displayName: 'Cópia (CC)', type: 'string', default: '', placeholder: 'gestor@empresa.com.br' },
      { name: 'bccEmail', displayName: 'Cópia oculta (CCO)', type: 'string', default: '' },
      { name: 'replyTo', displayName: 'Responder para', type: 'string', default: '', description: 'Endereço que recebe as respostas, quando diferente do remetente.' },
      {
        name: 'attachments',
        displayName: 'Anexos (campos de arquivo)',
        type: 'string',
        default: '',
        placeholder: 'data, relatorio',
        description: 'Campos de arquivo do item que vão anexados, separados por vírgula. Vazio: sem anexos.',
      },
      {
        name: 'allowUnauthorizedCerts',
        displayName: 'Aceitar certificado inválido',
        type: 'boolean',
        default: false,
        description: 'Aceita servidor com certificado vencido ou próprio. Use só com servidores internos de confiança.',
      },
    ],
  },

  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const transports = new Map<string, Transporter<SMTPTransport.SentMessageInfo>>();
    const out: Item[] = [];
    try {
      for (let i = 0; i < input.length; i++) {
        const item = input[i]!;
        const connectionId = str(await ctx.getParam('connection', i));
        if (!connectionId) throw new NodeOperationError('Escolha a conexão SMTP');
        const allowUnauthorized = bool(await ctx.getParam('allowUnauthorizedCerts', i));
        const key = `${connectionId}|${allowUnauthorized}`;
        let transport = transports.get(key);
        if (!transport) {
          const connection = await ctx.getConnection(connectionId);
          if (!SMTP_CONNECTION_TYPES.includes(connection.type)) throw new NodeOperationError('A conexão escolhida não é do tipo SMTP');
          transport = nodemailer.createTransport(smtpTransportOptions(connection, allowUnauthorized));
          transports.set(key, transport);
        }

        const from = str(await ctx.getParam('fromEmail', i)).trim();
        const to = str(await ctx.getParam('toEmail', i)).trim();
        if (!from) throw new NodeOperationError('Informe o remetente (De)');
        if (!to) throw new NodeOperationError('Informe o destinatário (Para)');
        const format = str(await ctx.getParam('emailFormat', i), 'html');
        const message: SendMailOptions = { from, to, subject: str(await ctx.getParam('subject', i)) };
        if (format === 'text' || format === 'both') message.text = str(await ctx.getParam('text', i));
        if (format === 'html' || format === 'both') message.html = str(await ctx.getParam('html', i));
        const cc = str(await ctx.getParam('ccEmail', i)).trim();
        const bcc = str(await ctx.getParam('bccEmail', i)).trim();
        const replyTo = str(await ctx.getParam('replyTo', i)).trim();
        if (cc) message.cc = cc;
        if (bcc) message.bcc = bcc;
        if (replyTo) message.replyTo = replyTo;

        const attachments = binaryPropertyList(await ctx.getParam('attachments', i));
        if (attachments.length) {
          message.attachments = attachments.map((property) => {
            const binary = getBinary(item, property, i);
            return { filename: binary.fileName ?? property, content: Buffer.from(binary.data, 'base64'), contentType: binary.mimeType };
          });
        }

        let info: SMTPTransport.SentMessageInfo;
        try {
          info = await transport.sendMail(message);
        } catch (err) {
          throw new NodeOperationError(`O servidor SMTP não aceitou o e-mail: ${errMessage(err)}`);
        }
        out.push({ json: toJson<JsonObject>(info) });
      }
    } finally {
      for (const t of transports.values()) t.close();
    }
    return [out];
  },
};
