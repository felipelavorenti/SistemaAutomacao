import { defaultRegistry, isExpression, NodeOperationError, type PropertyType, type WorkflowDefinition } from '@sa/engine';
import { one, type Db } from '../db/db.js';
import { loadUser } from './auth.js';
import { canSeeClient, canSeeFolder, type CurrentUser } from './permissions.js';

/** Conexões, clientes no ERP e subfluxos que o fluxo escolhe com valor fixo (sem expressão). */
export interface FixedReferences {
  connections: Set<string>;
  erpClients: Set<string>;
  workflows: Set<string>;
}

/** Campo do nó que guarda o ID de cada tipo de cadastro; o nome antigo vale para tipos que não estão no catálogo. */
const REFERENCE_FIELDS: { kind: keyof FixedReferences; type: PropertyType; fallback: string }[] = [
  { kind: 'connections', type: 'connection', fallback: 'connection' },
  { kind: 'erpClients', type: 'erpClient', fallback: 'erpClient' },
  { kind: 'workflows', type: 'workflow', fallback: 'workflowId' },
];

/**
 * Valores fixos dos campos de conexão, cliente no ERP e fluxo. São conferidos quando o fluxo é salvo
 * (e quando o editor roda uma versão não salva); o que vem de expressão só se conhece na hora de rodar.
 */
export function fixedReferences(definition: WorkflowDefinition): FixedReferences {
  const refs: FixedReferences = { connections: new Set(), erpClients: new Set(), workflows: new Set() };
  for (const node of definition.nodes) {
    const properties = defaultRegistry.get(node.type)?.description.properties ?? [];
    for (const field of REFERENCE_FIELDS) {
      // O ID do subfluxo só conta no Execute Workflow; em outro nó, um campo "workflowId" é só texto.
      if (field.kind === 'workflows' && node.type !== 'executeWorkflow') continue;
      const names = new Set([field.fallback, ...properties.filter((p) => p.type === field.type).map((p) => p.name)]);
      for (const name of names) {
        const value = node.parameters[name];
        if (typeof value === 'string' && value && !isExpression(value)) refs[field.kind].add(value);
      }
    }
  }
  return refs;
}

/**
 * Quem responde pelo que a execução usa por expressão: quem disparou (teste, Executar, Tentar de novo)
 * ou, nas automáticas (agendamento, webhook, gatilho, fluxo de erro), quem salvou a versão que roda.
 */
export async function executionOwner(
  db: Db,
  execution: { triggeredBy: string | null; workflowId: string; workflowVersion: number | null },
): Promise<CurrentUser | null> {
  if (execution.triggeredBy) return loadUser(db, execution.triggeredBy);
  const row =
    execution.workflowVersion === null
      ? undefined
      : await one<{ created_by: string | null }>(db, 'SELECT created_by FROM workflow_versions WHERE workflow_id = $1 AND version = $2', [
          execution.workflowId,
          execution.workflowVersion,
        ]);
  const userId = row?.created_by ?? (await one<{ updated_by: string | null }>(db, 'SELECT updated_by FROM workflows WHERE id = $1', [execution.workflowId]))?.updated_by;
  return userId ? loadUser(db, userId) : null;
}

/**
 * Confere, na hora de rodar, as conexões, os clientes no ERP e os subfluxos escolhidos por expressão:
 * sem isso, quem não tem acesso a um cliente usaria a conexão dele escrevendo o ID numa expressão.
 */
export class ExecutionAccess {
  private readonly fixed: FixedReferences;
  private owner: Promise<CurrentUser | null> | null = null;

  constructor(
    private readonly db: Db,
    definition: WorkflowDefinition,
    private readonly loadOwner: () => Promise<CurrentUser | null>,
  ) {
    this.fixed = fixedReferences(definition);
  }

  private async responsible(what: string): Promise<CurrentUser> {
    this.owner ??= this.loadOwner();
    const user = await this.owner;
    if (!user) {
      throw new NodeOperationError(`${what} veio de uma expressão, e esta execução não tem um usuário ativo responsável por ela para conferir o acesso`);
    }
    return user;
  }

  /** `clientId` é o cliente da conexão (null: conexão sem cliente, que todos enxergam). */
  async checkConnection(id: string, clientId: string | null): Promise<void> {
    if (this.fixed.connections.has(id) || clientId === null) return;
    const user = await this.responsible('A conexão');
    if (!canSeeClient(user, clientId)) {
      throw new NodeOperationError(`A conexão escolhida por expressão é de um cliente ao qual ${user.name} não tem acesso`);
    }
  }

  async checkErpClient(id: string): Promise<void> {
    if (this.fixed.erpClients.has(id)) return;
    const user = await this.responsible('O cliente no ERP');
    if (user.clientIds === null) return;
    const row = await one<{ client_id: string }>(this.db, 'SELECT client_id FROM erp_clients WHERE id = $1', [id]);
    if (row && !canSeeClient(user, row.client_id)) {
      throw new NodeOperationError(`O cliente no ERP escolhido por expressão é de um cliente ao qual ${user.name} não tem acesso`);
    }
  }

  /** `folderId` é a pasta do subfluxo chamado. */
  async checkWorkflow(id: string, folderId: string): Promise<void> {
    if (this.fixed.workflows.has(id)) return;
    const user = await this.responsible('O subfluxo');
    if (!canSeeFolder(user, folderId)) {
      throw new NodeOperationError(`O subfluxo escolhido por expressão está numa pasta à qual ${user.name} não tem acesso`);
    }
  }
}
