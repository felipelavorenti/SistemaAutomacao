import { DATABASE_CONNECTION_TYPES, testDatabaseConnection } from './database/drivers.js';
import type { ConnectionData } from './node-types.js';
import { testClickUpConnection } from './nodes/clickup.js';
import { testGmailConnection } from './nodes/google.js';
import { testMetabaseConnection } from './nodes/metabase.js';
import { testSmtpConnection } from './nodes/email-send.js';
import { testFtpConnection } from './nodes/ftp.js';
import { testSshConnection } from './nodes/ssh.js';

/** Tipos de conexão que têm o botão "Testar conexão". */
export const TESTABLE_CONNECTION_TYPES = [...DATABASE_CONNECTION_TYPES, 'metabase', 'clickup', 'gmailOAuth2', 'smtp', 'ftp', 'sftp', 'ssh'];

/** Conecta com os dados informados e lança o erro quando não funciona. */
export async function testConnection(connection: ConnectionData): Promise<void> {
  if (connection.type === 'metabase') return testMetabaseConnection(connection);
  if (connection.type === 'clickup') return testClickUpConnection(connection);
  if (connection.type === 'gmailOAuth2') return testGmailConnection(connection);
  if (connection.type === 'smtp') return testSmtpConnection(connection);
  if (connection.type === 'ftp' || connection.type === 'sftp') return testFtpConnection(connection);
  if (connection.type === 'ssh') return testSshConnection(connection);
  return testDatabaseConnection(connection);
}
