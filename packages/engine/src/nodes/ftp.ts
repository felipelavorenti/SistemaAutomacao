import { PassThrough, Readable } from 'node:stream';
import path from 'node:path';
import { Client as FtpClient, FileType, type FileInfo } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import type { ConnectionData, NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { Item, JsonObject } from '../types.js';
import { getBinaryBuffer, toBinary, withBinary } from '../binary.js';
import { bool, errMessage, num, str } from './values.js';

/**
 * FTP: lista, baixa, envia, renomeia e apaga arquivos num servidor FTP ou SFTP, como o nó FTP do
 * n8n. O protocolo vem do tipo da conexão escolhida.
 */

export const FTP_CONNECTION_TYPES = ['ftp', 'sftp'];

/** Arquivo ou pasta listado, no formato do n8n: type "-" arquivo, "d" pasta, "l" atalho. */
export interface RemoteEntry {
  type: string;
  name: string;
  size: number;
  modifyTime: string | null;
  accessTime?: string | null;
  rights?: JsonObject;
  owner?: string | number;
  group?: string | number;
  path: string;
}

/** O que cada operação precisa do servidor; uma implementação por protocolo. */
export interface RemoteFiles {
  list(dir: string): Promise<RemoteEntry[]>;
  download(file: string): Promise<Buffer>;
  upload(file: string, content: Buffer): Promise<void>;
  mkdirs(dir: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  deleteFile(file: string): Promise<void>;
  deleteDir(dir: string, recursive: boolean): Promise<void>;
  close(): Promise<void>;
}

const join = (dir: string, name: string) => path.posix.join(dir || '/', name);
const timeOf = (value: Date | number | undefined): string | null => {
  if (value === undefined) return null;
  const date = typeof value === 'number' ? new Date(value) : value;
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

class FtpFiles implements RemoteFiles {
  constructor(private client: FtpClient) {}

  static async open(connection: ConnectionData): Promise<FtpFiles> {
    const d = connection.data;
    const client = new FtpClient(60_000);
    try {
      await client.access({
        host: str(d.host),
        port: num(d.port, 21),
        user: str(d.user) || 'anonymous',
        password: str(d.password) || 'anonymous@',
        secure: bool(d.secure),
        secureOptions: { rejectUnauthorized: !bool(d.allowUnauthorizedCerts) },
      });
    } catch (err) {
      client.close();
      throw new NodeOperationError(`Não foi possível entrar no FTP ${str(d.host)}: ${errMessage(err)}`);
    }
    return new FtpFiles(client);
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const list = await this.client.list(dir);
    return list.map((f: FileInfo) => ({
      type: f.type === FileType.Directory ? 'd' : f.type === FileType.SymbolicLink ? 'l' : '-',
      name: f.name,
      size: f.size,
      modifyTime: timeOf(f.modifiedAt) ?? (f.rawModifiedAt || null),
      ...(f.permissions ? { rights: { user: String(f.permissions.user), group: String(f.permissions.group), other: String(f.permissions.world) } } : {}),
      ...(f.user ? { owner: f.user } : {}),
      ...(f.group ? { group: f.group } : {}),
      path: join(dir, f.name),
    }));
  }

  async download(file: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (c: Buffer) => chunks.push(c));
    await this.client.downloadTo(sink, file);
    return Buffer.concat(chunks);
  }

  async upload(file: string, content: Buffer): Promise<void> {
    await this.client.uploadFrom(Readable.from([content]), file);
  }

  async mkdirs(dir: string): Promise<void> {
    if (!dir || dir === '/' || dir === '.') return;
    // ensureDir entra na pasta criada; volta para a pasta inicial para os caminhos relativos.
    const cwd = await this.client.pwd();
    await this.client.ensureDir(dir);
    await this.client.cd(cwd);
  }

  rename(from: string, to: string) {
    return this.client.rename(from, to).then(() => undefined);
  }

  deleteFile(file: string) {
    return this.client.remove(file).then(() => undefined);
  }

  async deleteDir(dir: string, recursive: boolean): Promise<void> {
    if (recursive) await this.client.removeDir(dir);
    else await this.client.send(`RMD ${dir}`);
  }

  async close(): Promise<void> {
    this.client.close();
  }
}

class SftpFiles implements RemoteFiles {
  constructor(private client: SftpClient) {}

  static async open(connection: ConnectionData): Promise<SftpFiles> {
    const d = connection.data;
    const client = new SftpClient();
    try {
      await client.connect({
        host: str(d.host),
        port: num(d.port, 22),
        username: str(d.user),
        ...(str(d.password) ? { password: str(d.password) } : {}),
        ...(str(d.privateKey) ? { privateKey: str(d.privateKey), passphrase: str(d.passphrase) || undefined } : {}),
        readyTimeout: 60_000,
      });
    } catch (err) {
      await client.end().catch(() => undefined);
      throw new NodeOperationError(`Não foi possível entrar no SFTP ${str(d.host)}: ${errMessage(err)}`);
    }
    return new SftpFiles(client);
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const list = await this.client.list(dir);
    return list.map((f) => ({
      type: f.type,
      name: f.name,
      size: f.size,
      modifyTime: timeOf(f.modifyTime),
      accessTime: timeOf(f.accessTime),
      rights: { user: f.rights.user, group: f.rights.group, other: f.rights.other },
      owner: f.owner,
      group: f.group,
      path: join(dir, f.name),
    }));
  }

  async download(file: string): Promise<Buffer> {
    return (await this.client.get(file)) as Buffer;
  }

  async upload(file: string, content: Buffer): Promise<void> {
    await this.client.put(content, file);
  }

  async mkdirs(dir: string): Promise<void> {
    if (!dir || dir === '/' || dir === '.') return;
    if (!(await this.client.exists(dir))) await this.client.mkdir(dir, true);
  }

  rename(from: string, to: string) {
    return this.client.rename(from, to).then(() => undefined);
  }

  deleteFile(file: string) {
    return this.client.delete(file).then(() => undefined);
  }

  deleteDir(dir: string, recursive: boolean) {
    return this.client.rmdir(dir, recursive).then(() => undefined);
  }

  async close(): Promise<void> {
    await this.client.end().catch(() => undefined);
  }
}

export async function openRemoteFiles(connection: ConnectionData): Promise<RemoteFiles> {
  if (connection.type === 'ftp') return FtpFiles.open(connection);
  if (connection.type === 'sftp') return SftpFiles.open(connection);
  throw new NodeOperationError('A conexão escolhida não é de FTP nem de SFTP');
}

export async function testFtpConnection(connection: ConnectionData): Promise<void> {
  const files = await openRemoteFiles(connection);
  await files.close();
}

/** Lista as pastas abaixo; como no n8n, a lista recursiva traz só os arquivos (com o caminho completo). */
async function listRecursive(files: RemoteFiles, dir: string, depth = 0): Promise<RemoteEntry[]> {
  if (depth > 50) throw new NodeOperationError(`A pasta "${dir}" passa de 50 níveis de subpastas`);
  const out: RemoteEntry[] = [];
  for (const entry of await files.list(dir)) {
    if (entry.name === '.' || entry.name === '..') continue;
    if (entry.type === 'd') out.push(...(await listRecursive(files, entry.path, depth + 1)));
    else out.push(entry);
  }
  return out;
}

const op = (...operations: string[]) => ({ operation: operations });

export const ftp: NodeType = {
  description: {
    type: 'ftp',
    displayName: 'FTP',
    description: 'Lista, baixa, envia, renomeia e apaga arquivos num servidor FTP ou SFTP.',
    group: 'action',
    inputs: 1,
    outputs: 1,
    defaultTimeoutMs: 600_000,
    properties: [
      {
        name: 'connection',
        displayName: 'Conexão',
        type: 'connection',
        default: '',
        required: true,
        connectionTypes: FTP_CONNECTION_TYPES,
        description: 'Uma conexão FTP ou SFTP; o protocolo vem dela.',
      },
      {
        name: 'operation',
        displayName: 'Operação',
        type: 'options',
        default: 'download',
        options: [
          { name: 'Baixar arquivo', value: 'download' },
          { name: 'Enviar arquivo', value: 'upload' },
          { name: 'Listar pasta', value: 'list' },
          { name: 'Renomear ou mover', value: 'rename' },
          { name: 'Apagar', value: 'delete' },
        ],
      },
      {
        name: 'path',
        displayName: 'Caminho',
        type: 'string',
        default: '',
        required: true,
        placeholder: '/pasta/arquivo.csv',
        description: 'Arquivo a baixar, enviar ou apagar; pasta a listar ou apagar.',
        showWhen: op('download', 'upload', 'list', 'delete'),
      },
      { name: 'binaryPropertyName', displayName: 'Campo do arquivo', type: 'string', default: 'data', showWhen: op('download', 'upload') },
      {
        name: 'binaryData',
        displayName: 'Enviar arquivo do item',
        type: 'boolean',
        default: true,
        description: 'Desligado, envia o texto do campo abaixo como conteúdo do arquivo.',
        showWhen: op('upload'),
      },
      { name: 'fileContent', displayName: 'Conteúdo (texto)', type: 'string', default: '', multiline: true, showWhen: { operation: ['upload'], binaryData: [false] } },
      { name: 'recursive', displayName: 'Incluir subpastas', type: 'boolean', default: false, description: 'Traz os arquivos de todas as subpastas (só arquivos).', showWhen: op('list') },
      { name: 'oldPath', displayName: 'Caminho atual', type: 'string', default: '', required: true, showWhen: op('rename') },
      { name: 'newPath', displayName: 'Caminho novo', type: 'string', default: '', required: true, showWhen: op('rename') },
      { name: 'createDirectories', displayName: 'Criar as pastas que faltarem', type: 'boolean', default: false, showWhen: op('rename') },
      { name: 'folder', displayName: 'É uma pasta', type: 'boolean', default: false, showWhen: op('delete') },
      { name: 'recursiveDelete', displayName: 'Apagar o que tem dentro', type: 'boolean', default: false, showWhen: { operation: ['delete'], folder: [true] } },
    ],
  },

  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const sessions = new Map<string, RemoteFiles>();
    const out: Item[] = [];
    try {
      for (let i = 0; i < input.length; i++) {
        const item = input[i]!;
        const connectionId = str(await ctx.getParam('connection', i));
        if (!connectionId) throw new NodeOperationError('Escolha a conexão FTP ou SFTP');
        let files = sessions.get(connectionId);
        if (!files) {
          files = await openRemoteFiles(await ctx.getConnection(connectionId));
          sessions.set(connectionId, files);
        }
        const operation = str(await ctx.getParam('operation', i), 'download');
        const remotePath = str(await ctx.getParam('path', i)).trim();
        const needPath = ['download', 'upload', 'list', 'delete'].includes(operation);
        if (needPath && !remotePath && operation !== 'list') throw new NodeOperationError('Informe o caminho');
        try {
          if (operation === 'download') {
            const property = str(await ctx.getParam('binaryPropertyName', i), 'data');
            const content = await files.download(remotePath);
            out.push(withBinary({ json: item.json, binary: item.binary }, property, toBinary(content, { fileName: path.posix.basename(remotePath), directory: path.posix.dirname(remotePath) })));
          } else if (operation === 'upload') {
            const content = bool(await ctx.getParam('binaryData', i), true)
              ? getBinaryBuffer(item, str(await ctx.getParam('binaryPropertyName', i), 'data'), i)
              : Buffer.from(str(await ctx.getParam('fileContent', i)), 'utf8');
            await files.mkdirs(path.posix.dirname(remotePath));
            await files.upload(remotePath, content);
            out.push({ json: { success: true } });
          } else if (operation === 'list') {
            const dir = remotePath || '/';
            const list = bool(await ctx.getParam('recursive', i)) ? await listRecursive(files, dir) : await files.list(dir);
            for (const entry of list) out.push({ json: entry as unknown as JsonObject });
          } else if (operation === 'rename') {
            const from = str(await ctx.getParam('oldPath', i)).trim();
            const to = str(await ctx.getParam('newPath', i)).trim();
            if (!from || !to) throw new NodeOperationError('Informe o caminho atual e o caminho novo');
            if (bool(await ctx.getParam('createDirectories', i))) await files.mkdirs(path.posix.dirname(to));
            await files.rename(from, to);
            out.push({ json: { success: true } });
          } else if (operation === 'delete') {
            if (bool(await ctx.getParam('folder', i))) await files.deleteDir(remotePath, bool(await ctx.getParam('recursiveDelete', i)));
            else await files.deleteFile(remotePath);
            out.push({ json: { success: true } });
          } else {
            throw new NodeOperationError(`Operação desconhecida: ${operation}`);
          }
        } catch (err) {
          if (err instanceof NodeOperationError) throw err;
          throw new NodeOperationError(`O servidor recusou a operação em "${remotePath || str(await ctx.getParam('oldPath', i))}": ${errMessage(err)}`);
        }
      }
    } finally {
      for (const s of sessions.values()) await s.close();
    }
    return [out];
  },
};
