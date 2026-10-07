import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage, STATUS_LABEL, type ExecutionStatus, type Item, type JsonValue, type NodeRun } from '../api';

/** Carrega dados de forma assíncrona e expõe recarga. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(loader, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon" onClick={onClose} aria-label="Fechar">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function StatusBadge({ status }: { status: ExecutionStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function ErrorBox({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return <div className="error-box">{message}</div>;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-header">
      <h1>{title}</h1>
      <div className="page-actions">{children}</div>
    </div>
  );
}

/** Mostra JSON formatado; chaves podem ser arrastadas para montar expressões. */
export function JsonView({ value, pathPrefix, draggable }: { value: JsonValue | undefined; pathPrefix?: string; draggable?: boolean }) {
  return (
    <div className="json-view">
      <JsonNode value={value ?? null} path={pathPrefix ?? ''} draggable={!!draggable} depth={0} />
    </div>
  );
}

function JsonNode({ value, path, draggable, depth }: { value: JsonValue; path: string; draggable: boolean; depth: number }) {
  const [open, setOpen] = useState(depth < 3);
  if (value === null || typeof value !== 'object') {
    return <span className={`json-${value === null ? 'null' : typeof value}`}>{JSON.stringify(value)}</span>;
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  const [openBr, closeBr] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  if (!entries.length) return <span>{openBr + closeBr}</span>;
  return (
    <span>
      <button className="json-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'}
      </button>
      {openBr}
      {!open && <span className="muted"> {entries.length} … </span>}
      {open && (
        <div className="json-children">
          {entries.map(([key, child]) => {
            const childPath = Array.isArray(value) ? `${path}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}['${key}']`;
            return (
              <div key={key}>
                <span
                  className={`json-key ${draggable ? 'draggable' : ''}`}
                  draggable={draggable}
                  title={draggable ? `Arraste para usar {{ ${childPath} }}` : undefined}
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', `{{ ${childPath} }}`)}
                >
                  {key}
                </span>
                : <JsonNode value={child} path={childPath} draggable={draggable} depth={depth + 1} />
              </div>
            );
          })}
        </div>
      )}
      {closeBr}
    </span>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** Logs do nó Code e links para as execuções dos subfluxos chamados. */
export function RunMeta({ meta }: { meta: NodeRun['meta'] }) {
  if (!meta) return null;
  return (
    <>
      {meta.subExecutionIds && meta.subExecutionIds.length > 0 && (
        <p className="sub-links">
          Execuções do subfluxo:{' '}
          {meta.subExecutionIds.map((id, i) => (
            <span key={id}>
              {i > 0 && ', '}
              <Link to={`/execucoes/${id}`}>{i + 1}</Link>
            </span>
          ))}
        </p>
      )}
      {meta.logs && meta.logs.length > 0 && (
        <details className="logs" open>
          <summary>Logs ({meta.logs.length})</summary>
          <pre>{meta.logs.join('\n')}</pre>
        </details>
      )}
    </>
  );
}

/** Arquivos dos itens (dados binários): nome, tipo, tamanho e, quando guardados, links para abrir e baixar. */
export function BinaryFiles({ items, executionId }: { items: Item[]; executionId?: string }) {
  const rows = items.flatMap((item, index) => Object.entries(item.binary ?? {}).map(([key, file]) => ({ index, key, file })));
  if (!rows.length) return null;
  return (
    <div className="binary-files">
      <div className="muted small">Arquivos</div>
      <ul>
        {rows.map(({ index, key, file }) => {
          const url = executionId && file.ref ? `/api/executions/${executionId}/files/${file.ref}` : null;
          return (
            <li key={`${index}-${key}`}>
              <span className="binary-key">
                {items.length > 1 ? `item ${index} · ` : ''}
                {key}
              </span>{' '}
              <strong>{file.fileName ?? '(sem nome)'}</strong>{' '}
              <span className="muted small">
                {file.mimeType}
                {file.fileSize ? ` · ${file.fileSize}` : ''}
              </span>
              {url ? (
                <span className="binary-links">
                  <a href={url} target="_blank" rel="noreferrer">
                    Abrir
                  </a>
                  <a href={`${url}?download=true`}>Baixar</a>
                </span>
              ) : (
                file.omitted && <span className="muted small"> · conteúdo não guardado</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
