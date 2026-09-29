import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatDate, formatDuration, get, type Client, type ConnectionItem, type DbCommand } from '../api';
import { ErrorBox, JsonView, PageHeader, useLoad } from '../components/ui';

const PAGE = 50;

const OPERATION_LABEL: Record<string, string> = {
  query: 'Consulta',
  insert: 'Insert',
  procedure: 'Procedure',
};

/** Auditoria dos comandos executados nos bancos dos clientes. */
export function DbCommandsPage() {
  const [params, setParams] = useSearchParams();
  const clients = useLoad(() => get<Client[]>('/clients'));
  const connections = useLoad(() => get<ConnectionItem[]>('/connections'));
  const [items, setItems] = useState<DbCommand[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  const filters = {
    clientId: params.get('clientId') ?? '',
    connectionId: params.get('connectionId') ?? '',
    executionId: params.get('executionId') ?? '',
    status: params.get('status') ?? '',
    search: params.get('search') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  };

  const load = async (append = false) => {
    try {
      const q = new URLSearchParams();
      for (const key of ['clientId', 'connectionId', 'executionId', 'status', 'search'] as const) {
        if (filters[key]) q.set(key, filters[key]);
      }
      if (filters.from) q.set('from', new Date(filters.from).toISOString());
      if (filters.to) q.set('to', new Date(filters.to).toISOString());
      const last = items[items.length - 1];
      if (append && last) q.set('beforeId', String(last.id));
      q.set('limit', String(PAGE));
      const page = await get<DbCommand[]>(`/db-commands?${q}`);
      setItems(append ? [...items, ...page] : page);
      setHasMore(page.length === PAGE);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const dbConnections = connections.data?.filter((c) => ['postgres', 'mssql', 'oracle'].includes(c.type)) ?? [];

  return (
    <div>
      <PageHeader title="Comandos SQL" />
      <div className="filters">
        <select value={filters.clientId} onChange={(e) => set('clientId', e.target.value)}>
          <option value="">Todos os clientes</option>
          {clients.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select value={filters.connectionId} onChange={(e) => set('connectionId', e.target.value)}>
          <option value="">Todas as conexões</option>
          {dbConnections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select value={filters.status} onChange={(e) => set('status', e.target.value)}>
          <option value="">Com e sem erro</option>
          <option value="ok">Sucesso</option>
          <option value="error">Erro</option>
        </select>
        <input type="datetime-local" value={filters.from} onChange={(e) => set('from', e.target.value)} title="De" />
        <input type="datetime-local" value={filters.to} onChange={(e) => set('to', e.target.value)} title="Até" />
        <input placeholder="Buscar no SQL, fluxo ou erro" defaultValue={filters.search} onKeyDown={(e) => e.key === 'Enter' && set('search', e.currentTarget.value)} />
        {filters.executionId && (
          <button onClick={() => set('executionId', '')}>
            Só da execução {filters.executionId.slice(0, 8)} ✕
          </button>
        )}
      </div>
      <ErrorBox message={error} />
      <table>
        <thead>
          <tr>
            <th>Quando</th>
            <th>Cliente / conexão</th>
            <th>Fluxo / nó</th>
            <th>Comando</th>
            <th>Resultado</th>
            <th>Duração</th>
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id} className="clickable" onClick={() => setOpen(open === d.id ? null : d.id)}>
              <td>{formatDate(d.at)}</td>
              <td>
                {d.client_name ?? <span className="muted">sem cliente</span>}
                <div className="muted small">{d.connection_name}</div>
              </td>
              <td>
                {d.execution_id ? <Link to={`/execucoes/${d.execution_id}`} onClick={(e) => e.stopPropagation()}>{d.workflow_name ?? 'execução'}</Link> : (d.workflow_name ?? '')}
                <div className="muted small">
                  {d.node_name}
                  {d.triggered_by_name && ` · ${d.triggered_by_name}`}
                </div>
              </td>
              <td className="sql-cell">
                <strong>{OPERATION_LABEL[d.operation] ?? d.operation}</strong>
                <div>{open === d.id ? d.sql : d.sql.length > 160 ? `${d.sql.slice(0, 160)}…` : d.sql}</div>
                {open === d.id && d.params !== null && <JsonView value={d.params} />}
              </td>
              <td className={d.error ? 'error-cell' : undefined}>
                {d.error ?? commandResult(d)}
              </td>
              <td>{formatDuration(d.duration_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && <p className="muted">Nenhum comando encontrado.</p>}
      {hasMore && (
        <button className="load-more" onClick={() => load(true)}>
          Carregar mais
        </button>
      )}
    </div>
  );
}

function commandResult(d: DbCommand): string {
  if (d.rows !== null && (d.rows > 0 || d.operation === 'query')) return `${d.rows} linha(s)`;
  if (d.rows_affected !== null && d.rows_affected > 0) return `${d.rows_affected} afetada(s)`;
  return 'ok';
}
