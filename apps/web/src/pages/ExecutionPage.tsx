import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { errorMessage, formatDate, formatDuration, get, MODE_LABEL, post, type ExecutionDetail, type NodeRun } from '../api';
import { useMe } from '../App';
import { ErrorBox, JsonView, PageHeader, StatusBadge, useLoad } from '../components/ui';

export function ExecutionPage() {
  const { id } = useParams();
  const me = useMe();
  const navigate = useNavigate();
  const { data: ex, error, reload } = useLoad(() => get<ExecutionDetail>(`/executions/${id}`), [id]);
  const [selected, setSelected] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const inProgress = ex?.status === 'queued' || ex?.status === 'running';
  useEffect(() => {
    if (!inProgress) return;
    const t = setInterval(() => void reload(), 1500);
    return () => clearInterval(t);
  }, [inProgress, reload]);

  if (!ex) return <ErrorBox message={error} />;

  const run: NodeRun | undefined = ex.runs?.find((r, i) => `${r.nodeId}-${i}` === selected) ?? ex.runs?.[0];

  const retry = async () => {
    try {
      const { executionId } = await post<{ executionId: string }>(`/executions/${ex.id}/retry`);
      navigate(`/execucoes/${executionId}`);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const cancel = async () => {
    try {
      await post(`/executions/${ex.id}/cancel`);
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  return (
    <div>
      <PageHeader title={`Execução de ${ex.workflow_name}`}>
        <Link to={`/fluxos/${ex.workflow_id}`}>Abrir fluxo</Link>
        {me.permissions.executeWorkflows && inProgress && <button onClick={cancel}>Cancelar</button>}
        {me.permissions.executeWorkflows && !inProgress && (
          <button className="primary" onClick={retry}>
            Executar de novo
          </button>
        )}
      </PageHeader>
      <ErrorBox message={actionError} />
      <div className="facts">
        <div>
          <span className="muted">Status</span>
          <StatusBadge status={ex.status} />
        </div>
        <div>
          <span className="muted">Tipo</span>
          {MODE_LABEL[ex.mode] ?? ex.mode}
          {ex.retry_of && (
            <>
              {' '}
              de <Link to={`/execucoes/${ex.retry_of}`}>outra execução</Link>
            </>
          )}
        </div>
        <div>
          <span className="muted">Disparada por</span>
          {ex.triggered_by_name ?? 'Agendamento'}
        </div>
        <div>
          <span className="muted">Início</span>
          {formatDate(ex.started_at ?? ex.created_at)}
        </div>
        <div>
          <span className="muted">Duração</span>
          {formatDuration(ex.duration_ms ?? (ex.started_at && ex.finished_at ? Date.parse(ex.finished_at) - Date.parse(ex.started_at) : null))}
        </div>
        <div>
          <span className="muted">Versão do fluxo</span>
          {ex.workflow_version ?? 'não salva (editor)'}
        </div>
      </div>

      {ex.error && (
        <div className="error-panel">
          <h2>
            Erro{ex.error.nodeName ? ` em "${ex.error.nodeName}"` : ''}: {ex.error.message}
          </h2>
          {ex.error.details !== undefined && ex.error.details !== null && <JsonView value={ex.error.details} />}
        </div>
      )}

      <h2>Nós executados</h2>
      <div className="run-layout">
        <table className="run-list">
          <tbody>
            {(ex.runs ?? []).map((r, i) => (
              <tr key={`${r.nodeId}-${i}`} className={run === r ? 'selected' : ''} onClick={() => setSelected(`${r.nodeId}-${i}`)}>
                <td>
                  <span className={`dot dot-${r.status}`} /> {r.nodeName}
                </td>
                <td className="muted">{r.output.map((o) => o.length).join(' / ')} itens</td>
                <td className="muted">{formatDuration(r.durationMs)}</td>
              </tr>
            ))}
            {!ex.runs &&
              (ex.summary ?? []).map((s, i) => (
                <tr key={`${s.nodeId}-${i}`}>
                  <td>
                    <span className={`dot dot-${s.status}`} /> {s.nodeName}
                  </td>
                  <td className="muted">{s.outputItems.join(' / ')} itens</td>
                  <td className="muted">{formatDuration(s.durationMs)}</td>
                </tr>
              ))}
          </tbody>
        </table>
        <div className="run-data">
          {!ex.runs && ex.summary && (
            <p className="muted">
              Para economizar espaço, execuções agendadas que terminam com sucesso guardam só o resumo, sem a entrada e a saída de cada nó.
            </p>
          )}
          {run && (
            <>
              <h3>
                {run.nodeName} <span className="muted">· {run.tries > 1 ? `${run.tries} tentativas · ` : ''}{formatDate(run.startedAt)}</span>
              </h3>
              {run.error && <ErrorBox message={run.error.message} />}
              <div className="io-columns">
                <div>
                  <h4>Entrada</h4>
                  <JsonView value={run.input.map((list) => list.map((i) => i.json))} />
                </div>
                <div>
                  <h4>Saída</h4>
                  <JsonView value={run.output.map((list) => list.map((i) => i.json))} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
