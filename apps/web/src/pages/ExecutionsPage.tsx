import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatDate, formatDuration, get, MODE_LABEL, STATUS_LABEL, type ExecutionListItem, type WorkflowListItem } from '../api';
import { ErrorBox, PageHeader, StatusBadge, useLoad } from '../components/ui';

const PAGE = 50;

interface WaitingRun {
  workflowId: string;
  workflowName: string;
  dueAt: string;
}

export function ExecutionsPage() {
  const [params, setParams] = useSearchParams();
  const workflows = useLoad(() => get<WorkflowListItem[]>('/workflows'));
  const [items, setItems] = useState<ExecutionListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [waiting, setWaiting] = useState<WaitingRun[]>([]);

  const filters = {
    workflowId: params.get('workflowId') ?? '',
    status: params.get('status') ?? '',
    mode: params.get('mode') ?? '',
    search: params.get('search') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    data: params.get('data') ?? '',
  };

  // Agendados esperando vaga só aparecem quando os filtros não os excluiriam.
  const showsWaiting = ['', 'queued'].includes(filters.status) && ['', 'schedule'].includes(filters.mode) && !filters.search && !filters.from && !filters.to && !filters.data;

  const query = (before?: string) => {
    const q = new URLSearchParams();
    if (filters.workflowId) q.set('workflowId', filters.workflowId);
    if (filters.status) q.set('status', filters.status);
    if (filters.mode) q.set('mode', filters.mode);
    if (filters.search) q.set('search', filters.search);
    if (filters.from) q.set('from', new Date(filters.from).toISOString());
    if (filters.to) q.set('to', new Date(filters.to).toISOString());
    if (filters.data) {
      // "chave" acha quem gravou a chave; "chave=valor", o valor exato.
      const at = filters.data.indexOf('=');
      q.set('dataKey', (at < 0 ? filters.data : filters.data.slice(0, at)).trim());
      if (at >= 0) q.set('dataValue', filters.data.slice(at + 1).trim());
    }
    if (before) q.set('before', before);
    q.set('limit', String(PAGE));
    return `/executions?${q}`;
  };

  const load = async (append = false) => {
    try {
      const before = append ? items[items.length - 1]?.created_at : undefined;
      const page = await get<ExecutionListItem[]>(query(before));
      setItems(append ? [...items, ...page] : page);
      if (!append) setWaiting(showsWaiting ? (await get<WaitingRun[]>('/executions/waiting')).filter((w) => !filters.workflowId || w.workflowId === filters.workflowId) : []);
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
        <input
          placeholder="Dado gravado: chave=valor"
          title="Execuções em que o nó Execution Data gravou a chave (e o valor, se informado). Enter para filtrar."
          defaultValue={filters.data}
          onKeyDown={(e) => e.key === 'Enter' && set('data', e.currentTarget.value)}
        />
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
          {waiting.map((w, i) => (
            <tr key={`waiting-${w.workflowId}-${i}`} title="Agendado; começa quando uma das execuções em andamento terminar">
              <td>
                <StatusBadge status="queued" />
              </td>
              <td>
                <Link to={`/fluxos/${w.workflowId}`}>{w.workflowName}</Link>
              </td>
              <td>{MODE_LABEL.schedule}</td>
              <td className="muted">aguardando desde {formatDate(w.dueAt)}</td>
              <td />
              <td />
            </tr>
          ))}
          {items.map((e) => (
            <tr key={e.id}>
              <td>
                <Link to={`/execucoes/${e.id}`}>
                  <StatusBadge status={e.status} />
                </Link>
              </td>
              <td>
                <Link to={`/execucoes/${e.id}`}>{e.workflow_name}</Link>
                {e.custom_data && (
                  <div className="muted small">
                    {Object.entries(e.custom_data)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(' · ')}
                  </div>
                )}
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
      {!items.length && !waiting.length && <p className="muted">Nenhuma execução encontrada.</p>}
      {hasMore && (
        <button className="load-more" onClick={() => load(true)}>
          Carregar mais
        </button>
      )}
    </div>
  );
}
