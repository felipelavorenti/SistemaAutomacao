import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatDate, formatDuration, get, MODE_LABEL, STATUS_LABEL, type ExecutionListItem, type WorkflowListItem } from '../api';
import { ErrorBox, PageHeader, StatusBadge, useLoad } from '../components/ui';

const PAGE = 50;

export function ExecutionsPage() {
  const [params, setParams] = useSearchParams();
  const workflows = useLoad(() => get<WorkflowListItem[]>('/workflows'));
  const [items, setItems] = useState<ExecutionListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const filters = {
    workflowId: params.get('workflowId') ?? '',
    status: params.get('status') ?? '',
    mode: params.get('mode') ?? '',
    search: params.get('search') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  };

  const query = (before?: string) => {
    const q = new URLSearchParams();
    if (filters.workflowId) q.set('workflowId', filters.workflowId);
    if (filters.status) q.set('status', filters.status);
    if (filters.mode) q.set('mode', filters.mode);
    if (filters.search) q.set('search', filters.search);
    if (filters.from) q.set('from', new Date(filters.from).toISOString());
    if (filters.to) q.set('to', new Date(filters.to).toISOString());
    if (before) q.set('before', before);
    q.set('limit', String(PAGE));
    return `/executions?${q}`;
  };

  const load = async (append = false) => {
    try {
      const before = append ? items[items.length - 1]?.created_at : undefined;
      const page = await get<ExecutionListItem[]>(query(before));
      setItems(append ? [...items, ...page] : page);
      setHasMore(page.length === PAGE);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void load();
    // Atualiza sozinho enquanto houver execução em andamento.
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader title="Execuções" />
      <div className="filters">
        <select value={filters.workflowId} onChange={(e) => set('workflowId', e.target.value)}>
          <option value="">Todos os fluxos</option>
          {workflows.data?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <select value={filters.status} onChange={(e) => set('status', e.target.value)}>
          <option value="">Todos os status</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select value={filters.mode} onChange={(e) => set('mode', e.target.value)}>
          <option value="">Todos os tipos</option>
          {Object.entries(MODE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <input type="datetime-local" value={filters.from} onChange={(e) => set('from', e.target.value)} title="De" />
        <input type="datetime-local" value={filters.to} onChange={(e) => set('to', e.target.value)} title="Até" />
        <input placeholder="Buscar no fluxo, nó ou erro" defaultValue={filters.search} onKeyDown={(e) => e.key === 'Enter' && set('search', e.currentTarget.value)} />
      </div>
      <ErrorBox message={error} />
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Fluxo</th>
            <th>Tipo</th>
            <th>Início</th>
            <th>Duração</th>
            <th>Erro</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id}>
              <td>
                <Link to={`/execucoes/${e.id}`}>
                  <StatusBadge status={e.status} />
                </Link>
              </td>
              <td>
                <Link to={`/execucoes/${e.id}`}>{e.workflow_name}</Link>
              </td>
              <td>
                {MODE_LABEL[e.mode] ?? e.mode}
                {e.triggered_by_name && <span className="muted"> · {e.triggered_by_name}</span>}
              </td>
              <td>{formatDate(e.started_at ?? e.created_at)}</td>
              <td>{formatDuration(e.duration_ms)}</td>
              <td className="error-cell">{e.error_message && `${e.error_node ? `${e.error_node}: ` : ''}${e.error_message}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && <p className="muted">Nenhuma execução encontrada.</p>}
      {hasMore && (
        <button className="load-more" onClick={() => load(true)}>
          Carregar mais
        </button>
      )}
    </div>
  );
}
