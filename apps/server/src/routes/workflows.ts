import { CronExpressionParser } from 'cron-parser';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { convertN8nWorkflow, defaultRegistry, ExpressionSandbox, readN8nExport, scheduleRepeat, ScheduleError, validateWorkflow, type Item, type N8nWorkflow, type WorkflowDefinition } from '@sa/engine';
import { currentUser, type RouteDeps } from '../app.js';
import { activatableTypes, isActivatable } from '../triggers/manager.js';
import { many, one, transaction } from '../db/db.js';
import { createExecution } from '../executions/store.js';
import { audit } from '../lib/audit.js';
import { canSeeClient, canSeeFolder, forbidden, HttpError, notFound, requireCap, type CurrentUser } from '../lib/permissions.js';

const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue)]));

export const definitionSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().trim().min(1),
      type: z.string(),
      position: z.object({ x: z.number(), y: z.number() }),
      parameters: z.record(jsonValue).default({}),
      settings: z
        .object({
          retryOnFail: z.boolean().optional(),
          maxTries: z.number().int().min(1).max(10).optional(),
          waitBetweenTriesMs: z.number().int().min(0).max(600_000).optional(),
          continueOnFail: z.boolean().optional(),
          timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
        })
        .optional(),
      disabled: z.boolean().optional(),
      notes: z.string().optional(),
    }),
  ),
  connections: z.array(z.object({ from: z.string(), fromOutput: z.number().int().min(0), to: z.string(), toInput: z.number().int().min(0) })),
  settings: z.object({ errorWorkflowId: z.string().uuid().optional() }).optional(),
}) as unknown as z.ZodType<WorkflowDefinition>;

const idParam = z.object({ id: z.string().uuid() });

interface WorkflowRow {
  id: string;
  name: string;
  folder_id: string;
  active: boolean;
  definition: WorkflowDefinition;
  version: number;
  updated_at: Date;
}

export const workflowRoutes =
  ({ db, queue, triggers }: RouteDeps): FastifyPluginAsync =>
  async (app) => {
    const load = async (user: CurrentUser, id: string): Promise<WorkflowRow> => {
      const row = await one<WorkflowRow>(db, 'SELECT id, name, folder_id, active, definition, version, updated_at FROM workflows WHERE id = $1', [id]);
      if (!row || !canSeeFolder(user, row.folder_id)) throw notFound('Fluxo');
      return row;
    };

    const checkFolder = (user: CurrentUser, folderId: string) => {
      if (!canSeeFolder(user, folderId)) throw forbidden('Você não tem acesso a essa pasta');
    };

    /** Um usuário só pode ligar a um fluxo as conexões que ele mesmo enxerga. */
    const checkConnections = async (user: CurrentUser, definition: WorkflowDefinition) => {
      const ids = new Set<string>();
      for (const node of definition.nodes) {
        const connection = node.parameters.connection;
        if (typeof connection === 'string' && connection && !connection.startsWith('=')) ids.add(connection);
      }
      if (ids.size) {
        const rows = await many<{ id: string; client_id: string | null }>(db, 'SELECT id, client_id FROM connections WHERE id = ANY($1)', [[...ids]]);
        for (const id of ids) {
          const row = rows.find((r) => r.id === id);
          if (!row) throw new HttpError(400, 'O fluxo usa uma conexão que não existe mais');
          if (!canSeeClient(user, row.client_id)) throw forbidden('O fluxo usa uma conexão de um cliente ao qual você não tem acesso');
        }
      }

      // Mesma regra para os cadastros de cliente no ERP usados no modo "API cadastrada".
      const erpClients = new Set<string>();
      for (const node of definition.nodes) {
        const value = node.parameters.erpClient;
        if (typeof value === 'string' && value && !value.startsWith('=')) erpClients.add(value);
      }
      if (!erpClients.size) return;
      if ([...erpClients].some((id) => !z.string().uuid().safeParse(id).success)) throw new HttpError(400, 'O fluxo usa um cliente no ERP que não existe');
      const rows = await many<{ id: string; client_id: string }>(db, 'SELECT id, client_id FROM erp_clients WHERE id = ANY($1)', [[...erpClients]]);
      for (const id of erpClients) {
        const row = rows.find((r) => r.id === id);
        if (!row) throw new HttpError(400, 'O fluxo usa um cliente no ERP que não existe mais');
        if (!canSeeClient(user, row.client_id)) throw forbidden('O fluxo usa um cliente no ERP ao qual você não tem acesso');
      }
    };

    /** Os subfluxos chamados com ID fixo precisam existir e estar numa pasta que o usuário enxerga. */
    const checkSubworkflows = async (user: CurrentUser, definition: WorkflowDefinition, selfId?: string) => {
      const ids = new Set<string>();
      for (const node of definition.nodes) {
        if (node.type !== 'executeWorkflow') continue;
        const target = node.parameters.workflowId;
        if (typeof target !== 'string' || !target || target.startsWith('=')) continue;
        if (target === selfId) throw new HttpError(400, `O nó "${node.name}" chama o próprio fluxo`);
        if (!z.string().uuid().safeParse(target).success) throw new HttpError(400, `O nó "${node.name}" aponta para um fluxo que não existe`);
        ids.add(target);
      }
      if (!ids.size) return;
      const rows = await many<{ id: string; folder_id: string }>(db, 'SELECT id, folder_id FROM workflows WHERE id = ANY($1)', [[...ids]]);
      for (const id of ids) {
        const row = rows.find((r) => r.id === id);
        if (!row) throw new HttpError(400, 'O fluxo chama um subfluxo que não existe mais');
        if (!canSeeFolder(user, row.folder_id)) throw forbidden('O fluxo chama um subfluxo de uma pasta à qual você não tem acesso');
      }
    };

    /** Agendamento válido; com o fluxo ativo, a execução única também precisa estar no futuro. */
    const checkSchedule = (definition: WorkflowDefinition, active: boolean) => {
      for (const node of definition.nodes) {
        if (node.type !== 'scheduleTrigger' || node.disabled) continue;
        let repeat;
        try {
          repeat = scheduleRepeat(node.parameters);
          if (repeat.kind === 'cron') CronExpressionParser.parse(repeat.pattern, { tz: repeat.tz });
        } catch (err) {
          if (err instanceof ScheduleError) throw new HttpError(400, `${err.message} no nó "${node.name}"`);
          throw new HttpError(400, `Expressão cron inválida no nó "${node.name}"`);
        }
        if (active && repeat.kind === 'once' && repeat.at <= Date.now()) {
          throw new HttpError(400, `A data e hora da execução única no nó "${node.name}" já passou`);
        }
      }
    };

    /** Fluxo de erro escolhido nas configurações: precisa existir, estar visível e ter o Error Trigger. */
    const checkErrorWorkflow = async (user: CurrentUser, definition: WorkflowDefinition) => {
      const target = definition.settings?.errorWorkflowId;
      if (!target) return;
      const row = await one<{ folder_id: string; definition: WorkflowDefinition }>(db, 'SELECT folder_id, definition FROM workflows WHERE id = $1', [target]);
      if (!row) throw new HttpError(400, 'O fluxo de erro escolhido não existe mais');
      if (!canSeeFolder(user, row.folder_id)) throw forbidden('O fluxo de erro escolhido está numa pasta à qual você não tem acesso');
      if (!row.definition.nodes.some((n) => n.type === 'errorTrigger' && !n.disabled)) {
        throw new HttpError(400, 'O fluxo de erro escolhido não começa pelo gatilho Error Trigger');
      }
    };

    /** Webhook e formulário com caminho já usado por outro fluxo ativo. */
    const checkTriggerConflicts = (wf: { id: string; name: string; version: number; definition: WorkflowDefinition }) => {
      const problems = triggers.conflicts(wf);
      if (problems.length) throw new HttpError(400, problems.join('; '));
    };

    app.get('/node-types', async () => {
      const activatable = new Set(activatableTypes());
      return defaultRegistry.descriptions().map((d) => (activatable.has(d.type) ? { ...d, activatable: true } : d));
    });

    /** Prévia de uma expressão no editor, usando os dados da última execução. */
    app.post('/expressions/preview', async (request) => {
      requireCap(currentUser(request), 'workflow:edit');
      const b = z
        .object({
          value: z.string(),
          input: z.array(z.object({ json: z.record(jsonValue) })).default([]),
          nodeOutputs: z.record(z.array(z.object({ json: z.record(jsonValue) }))).default({}),
          itemIndex: z.number().int().min(0).default(0),
        })
        .parse(request.body);
      const sandbox = new ExpressionSandbox({ timeoutMs: 500, memoryLimitMb: 32 });
      try {
        const scope = await sandbox.createScope({
          nodeOutputs: b.nodeOutputs as Record<string, Item[]>,
          execution: { id: 'previa', mode: 'manual' },
          vars: {},
        });
        return { result: await scope.resolve(b.value, b.input as Item[], b.itemIndex) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      } finally {
        sandbox.dispose();
      }
    });

    app.get('/workflows', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:view');
      const [rows, nextRuns] = await Promise.all([
        many<{ id: string; active: boolean }>(
          db,
          `SELECT w.id, w.name, w.folder_id, f.name AS folder_name, w.active, w.version, w.updated_at, u.name AS updated_by_name,
                  (SELECT jsonb_build_object('id', e.id, 'status', e.status, 'createdAt', e.created_at)
                     FROM executions e WHERE e.workflow_id = w.id ORDER BY e.created_at DESC LIMIT 1) AS last_execution,
                  EXISTS (SELECT 1 FROM jsonb_array_elements(w.definition->'nodes') n WHERE n->>'type' = 'scheduleTrigger') AS scheduled,
                  EXISTS (SELECT 1 FROM jsonb_array_elements(w.definition->'nodes') n WHERE n->>'type' = 'executeWorkflowTrigger') AS callable,
                  EXISTS (SELECT 1 FROM jsonb_array_elements(w.definition->'nodes') n
                           WHERE n->>'type' = ANY($2::text[]) AND COALESCE(n->>'disabled', 'false') <> 'true') AS activatable
           FROM workflows w JOIN folders f ON f.id = w.folder_id LEFT JOIN users u ON u.id = w.updated_by
           WHERE ($1::uuid[] IS NULL OR w.folder_id = ANY($1))
           ORDER BY f.name, w.name`,
          [user.folderIds, activatableTypes()],
        ),
        queue.nextRuns(),
      ]);
      return rows.map((w) => {
        const at = w.active ? nextRuns.get(w.id) : undefined;
        return { ...w, next_run: at === undefined ? null : new Date(at).toISOString() };
      });
    });

    app.get('/workflows/:id', async (request) => {
      const user = currentUser(request);
      const { id } = idParam.parse(request.params);
      const wf = await load(user, id);
      return { ...wf, issues: validateWorkflow(wf.definition) };
    });

    app.post('/workflows', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:edit');
      const b = z
        .object({ name: z.string().trim().min(1), folderId: z.string().uuid(), definition: definitionSchema.optional() })
        .parse(request.body);
      checkFolder(user, b.folderId);
      const definition: WorkflowDefinition = b.definition ?? {
        nodes: [{ id: 'gatilho', name: 'Gatilho manual', type: 'manualTrigger', position: { x: 100, y: 200 }, parameters: {} }],
        connections: [],
      };
      await checkConnections(user, definition);
      await checkSubworkflows(user, definition);
      await checkErrorWorkflow(user, definition);
      const id = await transaction(db, async (tx) => {
        const row = await one<{ id: string }>(
          tx,
          `INSERT INTO workflows (name, folder_id, definition, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING id`,
          [b.name, b.folderId, JSON.stringify(definition), user.id],
        );
        await tx.query('INSERT INTO workflow_versions (workflow_id, version, name, definition, created_by) VALUES ($1, 1, $2, $3, $4)', [
          row!.id,
          b.name,
          JSON.stringify(definition),
          user.id,
        ]);
        await audit(tx, { userId: user.id, action: 'create', entityType: 'workflow', entityId: row!.id, entityName: b.name, ip: request.ip });
        return row!.id;
      });
      return load(user, id);
    });

    app.put('/workflows/:id', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:edit');
      const { id } = idParam.parse(request.params);
      const b = z
        .object({ name: z.string().trim().min(1), folderId: z.string().uuid(), definition: definitionSchema, baseVersion: z.number().int().optional() })
        .parse(request.body);
      const before = await load(user, id);
      checkFolder(user, b.folderId);
      if (b.baseVersion !== undefined && b.baseVersion !== before.version) {
        throw new HttpError(409, 'Outra pessoa salvou este fluxo enquanto você editava. Recarregue para ver a versão atual.');
      }
      await checkConnections(user, b.definition);
      await checkSubworkflows(user, b.definition, id);
      checkSchedule(b.definition, before.active);
      await checkErrorWorkflow(user, b.definition);
      if (before.active) checkTriggerConflicts({ id, name: b.name, version: before.version, definition: b.definition });
      const issues = validateWorkflow(b.definition);
      if (before.active && issues.length) {
        throw new HttpError(400, 'O fluxo está ativo e tem problemas; corrija antes de salvar', issues);
      }

      const version = before.version + 1;
      await transaction(db, async (tx) => {
        await tx.query(
          `UPDATE workflows SET name = $2, folder_id = $3, definition = $4, version = $5, updated_by = $6, updated_at = now() WHERE id = $1`,
          [id, b.name, b.folderId, JSON.stringify(b.definition), version, user.id],
        );
        await tx.query('INSERT INTO workflow_versions (workflow_id, version, name, definition, created_by) VALUES ($1, $2, $3, $4, $5)', [
          id,
          version,
          b.name,
          JSON.stringify(b.definition),
          user.id,
        ]);
        await audit(tx, {
          userId: user.id,
          action: 'update',
          entityType: 'workflow',
          entityId: id,
          entityName: b.name,
          before: { name: before.name, folderId: before.folder_id, version: before.version },
          after: { name: b.name, folderId: b.folderId, version },
          ip: request.ip,
        });
      });
      const saved = await load(user, id);
      if (saved.active) {
        await queue.syncSchedule(saved);
        await triggers.sync(saved);
        await triggers.fireEvent(saved, 'update');
      }
      return { ...saved, issues };
    });

    const setActive = async (request: import('fastify').FastifyRequest, active: boolean) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:edit');
      const { id } = idParam.parse(request.params);
      const wf = await load(user, id);
      if (active) {
        if (!isActivatable(wf.definition)) {
          throw new HttpError(400, 'Só fluxos com gatilho de agendamento, webhook, formulário ou outro gatilho que escuta precisam ser ativados');
        }
        const issues = validateWorkflow(wf.definition);
        if (issues.length) throw new HttpError(400, 'Corrija os problemas do fluxo antes de ativar', issues);
        checkSchedule(wf.definition, true);
        checkTriggerConflicts(wf);
      }
      await db.query('UPDATE workflows SET active = $2, updated_at = now(), updated_by = $3 WHERE id = $1', [id, active, user.id]);
      await queue.syncSchedule({ ...wf, active });
      try {
        await triggers.sync({ ...wf, active }, { strict: true });
      } catch (err) {
        // Um gatilho que não sobe (ex.: pasta fora de FILES_DIRS) não deixa o fluxo ativo.
        await db.query('UPDATE workflows SET active = false WHERE id = $1', [id]);
        await queue.syncSchedule({ ...wf, active: false });
        await triggers.sync({ ...wf, active: false });
        throw new HttpError(400, `O gatilho não iniciou: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (active) await triggers.fireEvent({ ...wf, active }, 'activate');
      await audit(db, { userId: user.id, action: active ? 'activate' : 'deactivate', entityType: 'workflow', entityId: id, entityName: wf.name, ip: request.ip });
      return { ok: true, active };
    };

    app.post('/workflows/:id/activate', (request) => setActive(request, true));
    app.post('/workflows/:id/deactivate', (request) => setActive(request, false));

    app.delete('/workflows/:id', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:edit');
      const { id } = idParam.parse(request.params);
      const wf = await load(user, id);
      const callers = await many<{ name: string }>(
        db,
        `SELECT name FROM workflows WHERE id <> $1 AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(definition->'nodes') n
           WHERE n->>'type' = 'executeWorkflow' AND n->'parameters'->>'workflowId' = $1::text)
         ORDER BY name`,
        [id],
      );
      if (callers.length) {
        throw new HttpError(400, `Este fluxo é chamado por outros fluxos: ${callers.map((c) => c.name).join(', ')}. Remova as chamadas antes de excluir.`);
      }
      await queue.syncSchedule({ ...wf, active: false });
      await triggers.remove(id);
      await db.query('DELETE FROM workflows WHERE id = $1', [id]);
      await audit(db, {
        userId: user.id,
        action: 'delete',
        entityType: 'workflow',
        entityId: id,
        entityName: wf.name,
        before: { name: wf.name, folderId: wf.folder_id, definition: wf.definition },
        ip: request.ip,
      });
      return { ok: true };
    });

    app.post('/workflows/:id/duplicate', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:edit');
      const { id } = idParam.parse(request.params);
      const wf = await load(user, id);
      const row = await one<{ id: string }>(
        db,
        `INSERT INTO workflows (name, folder_id, definition, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING id`,
        [`${wf.name} (cópia)`, wf.folder_id, JSON.stringify(wf.definition), user.id],
      );
      await db.query('INSERT INTO workflow_versions (workflow_id, version, name, definition, created_by) VALUES ($1, 1, $2, $3, $4)', [
        row!.id,
        `${wf.name} (cópia)`,
        JSON.stringify(wf.definition),
        user.id,
      ]);
      await audit(db, { userId: user.id, action: 'duplicate', entityType: 'workflow', entityId: row!.id, entityName: `${wf.name} (cópia)`, after: { from: id }, ip: request.ip });
      return load(user, row!.id);
    });

    /** Fluxos que chamam este como subfluxo. */
    app.get('/workflows/:id/callers', async (request) => {
      const user = currentUser(request);
      const { id } = idParam.parse(request.params);
      await load(user, id);
      return many(
        db,
        `SELECT id, name FROM workflows WHERE ($2::uuid[] IS NULL OR folder_id = ANY($2)) AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(definition->'nodes') n
           WHERE n->>'type' = 'executeWorkflow' AND n->'parameters'->>'workflowId' = $1::text)
         ORDER BY name`,
        [id, user.folderIds],
      );
    });

    app.get('/workflows/:id/versions', async (request) => {
      const user = currentUser(request);
      const { id } = idParam.parse(request.params);
      await load(user, id);
      return many(
        db,
        `SELECT v.version, v.name, v.created_at, u.name AS created_by_name FROM workflow_versions v
         LEFT JOIN users u ON u.id = v.created_by WHERE v.workflow_id = $1 ORDER BY v.version DESC LIMIT 200`,
        [id],
      );
    });

    app.get('/workflows/:id/versions/:version', async (request) => {
      const user = currentUser(request);
      const { id, version } = z.object({ id: z.string().uuid(), version: z.coerce.number().int() }).parse(request.params);
      await load(user, id);
      const row = await one(db, 'SELECT version, name, definition, created_at FROM workflow_versions WHERE workflow_id = $1 AND version = $2', [id, version]);
      if (!row) throw notFound('Versão');
      return row;
    });

    app.get('/workflows/:id/export', async (request) => {
      const user = currentUser(request);
      const { id } = idParam.parse(request.params);
      const wf = await load(user, id);
      return { name: wf.name, definition: wf.definition, exportedAt: new Date().toISOString() };
    });

    app.post('/workflows/import', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:edit');
      const b = z.object({ name: z.string().trim().min(1), folderId: z.string().uuid(), definition: definitionSchema }).parse(request.body);
      checkFolder(user, b.folderId);
      await checkConnections(user, b.definition);
      await checkSubworkflows(user, b.definition);
      const row = await one<{ id: string }>(
        db,
        `INSERT INTO workflows (name, folder_id, definition, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING id`,
        [b.name, b.folderId, JSON.stringify(b.definition), user.id],
      );
      await db.query('INSERT INTO workflow_versions (workflow_id, version, name, definition, created_by) VALUES ($1, 1, $2, $3, $4)', [
        row!.id,
        b.name,
        JSON.stringify(b.definition),
        user.id,
      ]);
      await audit(db, { userId: user.id, action: 'import', entityType: 'workflow', entityId: row!.id, entityName: b.name, ip: request.ip });
      return load(user, row!.id);
    });

    /**
     * Importa fluxos exportados do n8n (um arquivo com um fluxo ou uma lista).
     * Os fluxos entram desativados, e o Execute Workflow aponta para o subfluxo
     * importado agora ou antes, pelo ID que ele tinha no n8n.
     */
    app.post('/workflows/import-n8n', { bodyLimit: 50 * 1024 * 1024 }, async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:edit');
      const b = z.object({ folderId: z.string().uuid(), data: z.unknown() }).parse(request.body);
      checkFolder(user, b.folderId);
      let list: N8nWorkflow[];
      try {
        list = readN8nExport(b.data);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }

      const n8nIds = list.map((w) => (w.id === undefined || w.id === null ? null : String(w.id))).filter((id): id is string => !!id);
      const existing = await many<{ id: string; name: string; n8n_id: string; folder_id: string }>(
        db,
        'SELECT id, name, n8n_id, folder_id FROM workflows WHERE n8n_id IS NOT NULL',
      );
      const known = new Map(existing.filter((w) => canSeeFolder(user, w.folder_id)).map((w) => [w.n8n_id, w.id]));
      const already = new Map(existing.map((w) => [w.n8n_id, w]));
      const fresh = new Map<string, string>();
      for (const id of n8nIds) if (!already.has(id) && !fresh.has(id)) fresh.set(id, randomUUID());

      const results: { n8nId: string | null; name: string; status: 'imported' | 'skipped'; id?: string; wasActive?: boolean; warnings: { node?: string; message: string }[] }[] =
        [];
      await transaction(db, async (tx) => {
        for (const wf of list) {
          const n8nId = wf.id === undefined || wf.id === null ? null : String(wf.id);
          const previous = n8nId ? already.get(n8nId) : undefined;
          if (previous) {
            results.push({ n8nId, name: wf.name ?? previous.name, status: 'skipped', id: previous.id, warnings: [{ message: `já foi importado antes como "${previous.name}"` }] });
            continue;
          }
          if (n8nId && results.some((r) => r.n8nId === n8nId)) continue;
          const converted = convertN8nWorkflow(wf, { workflowId: (id) => known.get(id) ?? fresh.get(id) });
          const id = (n8nId && fresh.get(n8nId)) || randomUUID();
          await tx.query(
            `INSERT INTO workflows (id, name, folder_id, definition, n8n_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
            [id, converted.name, b.folderId, JSON.stringify(converted.definition), n8nId, user.id],
          );
          await tx.query('INSERT INTO workflow_versions (workflow_id, version, name, definition, created_by) VALUES ($1, 1, $2, $3, $4)', [
            id,
            converted.name,
            JSON.stringify(converted.definition),
            user.id,
          ]);
          await audit(tx, {
            userId: user.id,
            action: 'import',
            entityType: 'workflow',
            entityId: id,
            entityName: converted.name,
            after: { origem: 'n8n', n8nId, avisos: converted.warnings.length },
            ip: request.ip,
          });
          results.push({ n8nId, name: converted.name, status: 'imported', id, wasActive: converted.wasActive, warnings: converted.warnings });
        }
      });
      return results;
    });

    /** Executa o fluxo agora. O editor pode mandar a definição ainda não salva. */
    app.post('/workflows/:id/run', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:execute');
      const { id } = idParam.parse(request.params);
      const b = z
        .object({
          definition: definitionSchema.optional(),
          input: z.array(z.object({ json: z.record(jsonValue) })).optional(),
          /** Gatilho de onde começar, em fluxos com mais de um. */
          startNodeId: z.string().min(1).optional(),
        })
        .parse(request.body ?? {});
      const wf = await load(user, id);
      if (b.definition) {
        requireCap(user, 'workflow:edit');
        await checkConnections(user, b.definition);
        await checkSubworkflows(user, b.definition, id);
      }
      const definition = b.definition ?? wf.definition;
      const executionId = await createExecution(db, {
        workflowId: id,
        workflowVersion: b.definition ? null : wf.version,
        mode: 'manual',
        triggeredBy: user.id,
        definition,
        input: (b.input as Item[] | undefined) ?? null,
        startNodeId: b.startNodeId && definition.nodes.some((n) => n.id === b.startNodeId) ? b.startNodeId : null,
      });
      await queue.enqueueRun(executionId);
      return { executionId };
    });

    /**
     * Escuta de teste do editor: abre por 2 minutos as URLs de teste do Webhook e do Form Trigger e os
     * gatilhos que escutam (IMAP, pasta, SSE) ou consultam (RSS, consulta uma vez na hora). O primeiro
     * evento vira uma execução manual da definição enviada (mesmo ainda não salva).
     */
    app.post('/workflows/:id/listen', async (request) => {
      const user = currentUser(request);
      requireCap(user, 'workflow:execute');
      const { id } = idParam.parse(request.params);
      const b = z.object({ definition: definitionSchema.optional() }).parse(request.body ?? {});
      const wf = await load(user, id);
      if (b.definition) {
        requireCap(user, 'workflow:edit');
        await checkConnections(user, b.definition);
        await checkSubworkflows(user, b.definition, id);
      }
      try {
        return await triggers.startTest(wf, b.definition ?? wf.definition, user.id);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    });

    app.get('/workflows/:id/listen', async (request) => {
      const user = currentUser(request);
      const { id } = idParam.parse(request.params);
      await load(user, id);
      return triggers.testStatus(id);
    });

    app.delete('/workflows/:id/listen', async (request) => {
      const user = currentUser(request);
      const { id } = idParam.parse(request.params);
      await load(user, id);
      await triggers.stopTest(id);
      return { ok: true };
    });
  };
