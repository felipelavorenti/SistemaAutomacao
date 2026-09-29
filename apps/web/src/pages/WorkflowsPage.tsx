import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { del, errorMessage, formatDate, get, post, type Folder, type Workflow, type WorkflowDefinition, type WorkflowListItem } from '../api';
import { useMe } from '../App';
import { ErrorBox, Field, Modal, PageHeader, StatusBadge, useLoad } from '../components/ui';

export function WorkflowsPage() {
  const me = useMe();
  const navigate = useNavigate();
  const { data, error, reload } = useLoad(() => get<WorkflowListItem[]>('/workflows'));
  const folders = useLoad(() => get<Folder[]>('/folders'));
  const [creating, setCreating] = useState<'new' | 'import' | null>(null);
  const [filter, setFilter] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const list = (data ?? []).filter((w) => w.name.toLowerCase().includes(filter.toLowerCase()));
  const byFolder = new Map<string, WorkflowListItem[]>();
  for (const w of list) byFolder.set(w.folder_name, [...(byFolder.get(w.folder_name) ?? []), w]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      setActionError(null);
      await fn();
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  return (
    <div>
      <PageHeader title="Fluxos">
        <input placeholder="Buscar fluxo" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {me.permissions.editWorkflows && (
          <>
            <button onClick={() => setCreating('import')}>Importar JSON</button>
            <button className="primary" onClick={() => setCreating('new')}>
              Novo fluxo
            </button>
          </>
        )}
      </PageHeader>
      <ErrorBox message={error ?? actionError} />
      {data && !data.length && <p className="muted">Nenhum fluxo ainda.</p>}
      {[...byFolder.entries()].map(([folder, items]) => (
        <section key={folder} className="folder-section">
          <h2>{folder}</h2>
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Agendamento</th>
                <th>Última execução</th>
                <th>Alterado em</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((w) => (
                <tr key={w.id}>
                  <td>
                    <Link to={`/fluxos/${w.id}`}>{w.name}</Link>
                  </td>
                  <td>{w.scheduled ? w.active ? <span className="badge badge-success">Ativo</span> : <span className="badge">Inativo</span> : <span className="muted">Manual</span>}</td>
                  <td>
                    {w.last_execution ? (
                      <Link to={`/execucoes/${w.last_execution.id}`}>
                        <StatusBadge status={w.last_execution.status} /> <span className="muted">{formatDate(w.last_execution.createdAt)}</span>
                      </Link>
                    ) : (
                      <span className="muted">Nunca executado</span>
                    )}
                  </td>
                  <td>
                    {formatDate(w.updated_at)} <span className="muted">{w.updated_by_name}</span>
                  </td>
                  <td className="row-actions">
                    {me.permissions.editWorkflows && (
                      <>
                        <button className="link" onClick={() => act(async () => navigate(`/fluxos/${(await post<Workflow>(`/workflows/${w.id}/duplicate`)).id}`))}>
                          Duplicar
                        </button>
                        <button
                          className="link danger"
                          onClick={() => confirm(`Excluir o fluxo "${w.name}" e todo o histórico de execuções?`) && act(() => del(`/workflows/${w.id}`))}
                        >
                          Excluir
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      {creating && folders.data && (
        <NewWorkflowModal mode={creating} folders={folders.data} onClose={() => setCreating(null)} onCreated={(id) => navigate(`/fluxos/${id}`)} />
      )}
    </div>
  );
}

function NewWorkflowModal({
  mode,
  folders,
  onClose,
  onCreated,
}: {
  mode: 'new' | 'import';
  folders: Folder[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [folderId, setFolderId] = useState(folders[0]?.id ?? '');
  const [json, setJson] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    try {
      if (mode === 'new') {
        onCreated((await post<Workflow>('/workflows', { name, folderId })).id);
        return;
      }
      let parsed: { name?: string; definition?: WorkflowDefinition };
      try {
        parsed = JSON.parse(json);
      } catch {
        throw new Error('O texto colado não é um JSON válido');
      }
      if (!parsed.definition) throw new Error('O JSON precisa ter o campo "definition" (use a exportação de um fluxo desta plataforma)');
      onCreated((await post<Workflow>('/workflows/import', { name: name || parsed.name || 'Fluxo importado', folderId, definition: parsed.definition })).id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal title={mode === 'new' ? 'Novo fluxo' : 'Importar fluxo'} onClose={onClose}>
      <Field label="Nome">
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder={mode === 'import' ? 'Usa o nome do arquivo se vazio' : ''} />
      </Field>
      <Field label="Pasta">
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </Field>
      {mode === 'import' && (
        <Field label="JSON exportado">
          <textarea className="code" rows={10} value={json} onChange={(e) => setJson(e.target.value)} />
        </Field>
      )}
      <ErrorBox message={error} />
      <div className="modal-actions">
        <button onClick={onClose}>Cancelar</button>
        <button className="primary" onClick={submit} disabled={mode === 'new' && !name.trim()}>
          {mode === 'new' ? 'Criar' : 'Importar'}
        </button>
      </div>
    </Modal>
  );
}
