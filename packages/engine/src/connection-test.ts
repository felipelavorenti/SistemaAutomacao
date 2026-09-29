import { DATABASE_CONNECTION_TYPES, testDatabaseConnection } from './database/drivers.js';
import type { ConnectionData } from './node-types.js';
import { testClickUpConnection } from './nodes/clickup.js';
import { testMetabaseConnection } from './nodes/metabase.js';

/** Tipos de conexão que têm o botão "Testar conexão". */
export const TESTABLE_CONNECTION_TYPES = [...DATABASE_CONNECTION_TYPES, 'metabase', 'clickup'];

/** Conecta com os dados informados e lança o erro quando não funciona. */
export async function testConnection(connection: ConnectionData): Promise<void> {
  if (connection.type === 'metabase') return testMetabaseConnection(connection);
  if (connection.type === 'clickup') return testClickUpConnection(connection);
  return testDatabaseConnection(connection);
}
