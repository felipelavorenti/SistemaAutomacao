/** Migrações do banco, aplicadas em ordem e registradas em schema_migrations. */
export const migrations: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'operator', 'viewer')),
  active boolean NOT NULL DEFAULT true,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  must_change_password boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_folders (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, folder_id)
);

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_clients (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, client_id)
);

CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type text NOT NULL,
  client_id uuid REFERENCES clients(id) ON DELETE RESTRICT,
  data_encrypted bytea NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT false,
  definition jsonb NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflows_folder_idx ON workflows(folder_id);

CREATE TABLE workflow_versions (
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version int NOT NULL,
  name text NOT NULL,
  definition jsonb NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_id, version)
);

CREATE TABLE executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workflow_version int,
  mode text NOT NULL CHECK (mode IN ('manual', 'schedule', 'subworkflow', 'retry')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'success', 'error', 'canceled')),
  triggered_by uuid REFERENCES users(id) ON DELETE SET NULL,
  retry_of uuid REFERENCES executions(id) ON DELETE SET NULL,
  definition jsonb NOT NULL,
  input jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  error_message text,
  error_node text,
  error jsonb,
  summary jsonb,
  data bytea,
  data_size int
);
CREATE INDEX executions_workflow_idx ON executions(workflow_id, created_at DESC);
CREATE INDEX executions_status_idx ON executions(status, created_at DESC);
CREATE INDEX executions_created_idx ON executions(created_at DESC);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  entity_name text,
  before jsonb,
  after jsonb,
  ip text
);
CREATE INDEX audit_at_idx ON audit_log(at DESC);
CREATE INDEX audit_entity_idx ON audit_log(entity_type, entity_id);

INSERT INTO folders (name) VALUES ('Geral');
`,
  },
  {
    id: '002_subfluxos',
    sql: `
ALTER TABLE executions ADD COLUMN parent_execution_id uuid REFERENCES executions(id) ON DELETE SET NULL;
CREATE INDEX executions_parent_idx ON executions(parent_execution_id) WHERE parent_execution_id IS NOT NULL;
`,
  },
  {
    id: '003_bancos_e_catalogo',
    sql: `
-- Comandos executados nos bancos dos clientes. Os nomes ficam copiados para
-- o registro continuar legível mesmo depois de excluir fluxo, conexão ou cliente.
CREATE TABLE db_commands (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  execution_id uuid REFERENCES executions(id) ON DELETE SET NULL,
  workflow_id uuid,
  workflow_name text,
  node_name text NOT NULL,
  connection_id uuid,
  connection_name text,
  client_id uuid,
  client_name text,
  db_type text NOT NULL,
  operation text NOT NULL,
  sql text NOT NULL,
  params jsonb,
  rows int,
  rows_affected int,
  duration_ms int NOT NULL,
  error text,
  triggered_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX db_commands_at_idx ON db_commands(at DESC);
CREATE INDEX db_commands_client_idx ON db_commands(client_id, at DESC);
CREATE INDEX db_commands_execution_idx ON db_commands(execution_id);

-- Catálogo de APIs por ERP.
CREATE TABLE erps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  base_url text NOT NULL,
  auth_type text NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'basic', 'header')),
  auth_header text,
  client_fields jsonb NOT NULL DEFAULT '[]',
  notes text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE erp_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  erp_id uuid NOT NULL REFERENCES erps(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  method text NOT NULL,
  path text NOT NULL,
  headers jsonb NOT NULL DEFAULT '[]',
  query jsonb NOT NULL DEFAULT '[]',
  body_type text NOT NULL DEFAULT 'none' CHECK (body_type IN ('none', 'json', 'form', 'text')),
  body text NOT NULL DEFAULT '',
  variables jsonb NOT NULL DEFAULT '[]',
  uses_auth boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (erp_id, name)
);

-- Cliente no ERP: host, porta e credenciais cadastrados uma vez (criptografados).
CREATE TABLE erp_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  erp_id uuid NOT NULL REFERENCES erps(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  label text NOT NULL DEFAULT '',
  values_encrypted bytea NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (erp_id, client_id, label)
);
`,
  },
  {
    id: '004_importacao_n8n',
    sql: `
-- ID que o fluxo tinha no n8n, para ligar os subfluxos importados em momentos diferentes.
ALTER TABLE workflows ADD COLUMN n8n_id text UNIQUE;
`,
  },
  {
    id: '005_arquivos',
    sql: `
-- Arquivos escolhidos na tela (ex.: anexos do Gmail); os fluxos guardam só o ID.
CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  mime_type text NOT NULL,
  size int NOT NULL,
  content bytea NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    id: '006_dados_execucao',
    sql: `
-- Pares chave e valor gravados pelo nó Execution Data, para achar a execução depois.
ALTER TABLE executions ADD COLUMN custom_data jsonb;
CREATE INDEX executions_custom_data_idx ON executions USING gin (custom_data jsonb_path_ops);
`,
  },
];
