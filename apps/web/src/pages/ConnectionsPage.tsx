import { useState } from 'react';
import { Link } from 'react-router-dom';
import { del, errorMessage, formatDate, get, post, put, type Client, type ConnectionItem, type ConnectionType } from '../api';
import { useMe } from '../App';
import { ErrorBox, Field, Modal, PageHeader, useLoad } from '../components/ui';

export function ConnectionsPage() {
  const me = useMe();
  const { data, error, reload } = useLoad(() => get<ConnectionItem[]>('/connections'));
  const types = useLoad(() => get<ConnectionType[]>('/connection-types'));
  const clients = useLoad(() => get<Client[]>('/clients'));
  const [editing, setEditing] = useState<ConnectionItem | 'new' | null>(null);
  const [usage, setUsage] = useState<{ item: ConnectionItem; workflows: { id: string; name: string; active: boolean }[] } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const remove = async (c: ConnectionItem) => {
    if (!confirm(`Excluir a conexão "${c.name}"?`)) return;
    try {
      await del(`/connections/${c.id}`);
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const showUsage = async (item: ConnectionItem) => setUsage({ item, workflows: await get(`/connections/${item.id}/usage`) });

  return (
    <div>
      <PageHeader title="Conexões">
        {me.permissions.editConnections && (
          <button className="primary" onClick={() => setEditing('new')}>
            Nova conexão
          </button>
        )}
      </PageHeader>
      <p className="muted">Credenciais cadastradas uma vez e usadas nos nós. Senhas e tokens ficam criptografados e nunca aparecem de novo depois de salvos.</p>
      <ErrorBox message={error ?? actionError} />
      <table>
        <thead>
          <tr>
            <th>Nome</th>
            <th>Tipo</th>
            <th>Cliente</th>
            <th>Alterada em</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{c.typeName}</td>
              <td>{c.clientName ?? <span className="muted">Todos</span>}</td>
              <td>
                {formatDate(c.updatedAt)} <span className="muted">{c.updatedByName}</span>
              </td>
              <td className="row-actions">
                <button className="link" onClick={() => showUsage(c)}>
                  Onde é usada
                </button>
                {me.permissions.editConnections && (
                  <>
                    <button className="link" onClick={() => setEditing(c)}>
                      Editar
                    </button>
                    <button className="link danger" onClick={() => remove(c)}>
                      Excluir
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && !data.length && <p className="muted">Nenhuma conexão cadastrada.</p>}
      {editing && types.data && clients.data && (
        <ConnectionModal
          item={editing === 'new' ? null : editing}
          types={types.data}
          clients={clients.data}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
      {usage && (
        <Modal title={`Fluxos que usam "${usage.item.name}"`} onClose={() => setUsage(null)}>
          {usage.workflows.length ? (
            <ul>
              {usage.workflows.map((w) => (
                <li key={w.id}>
                  <Link to={`/fluxos/${w.id}`}>{w.name}</Link> {w.active && <span className="badge badge-success">Ativo</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nenhum fluxo usa esta conexão.</p>
          )}
        </Modal>
      )}
    </div>
  );
}

function ConnectionModal({
  item,
  types,
  clients,
  onClose,
  onSaved,
}: {
  item: ConnectionItem | null;
  types: ConnectionType[];
  clients: Client[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [type, setType] = useState(item?.type ?? types[0].type);
  const [clientId, setClientId] = useState(item?.clientId ?? '');
  const typeDesc = types.find((t) => t.type === type)!;
  const initialData = (desc: ConnectionType) =>
    Object.fromEntries(desc.fields.map((f) => [f.name, f.secret ? '' : (item?.data[f.name] ?? f.default ?? '')]));
  const [data, setData] = useState<Record<string, string>>(() => initialData(typeDesc));
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message?: string; durationMs?: number } | 'running' | null>(null);

  const changeType = (next: string) => {
    setType(next);
    setData(initialData(types.find((t) => t.type === next)!));
    setTest(null);
  };

  const runTest = async () => {
    setTest('running');
    try {
      setTest(await post('/connections/test', { id: item?.id, type, data }));
    } catch (err) {
      setTest({ ok: false, message: errorMessage(err) });
    }
  };

  const save = async () => {
    try {
      const body = { name, type, clientId: clientId || null, data };
      if (item) await put(`/connections/${item.id}`, body);
      else await post('/connections', body);
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal title={item ? 'Editar conexão' : 'Nova conexão'} onClose={onClose}>
      <Field label="Nome">
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Ex.: Consinco - Cliente X" />
      </Field>
      <Field label="Tipo">
        <select value={type} disabled={!!item} onChange={(e) => changeType(e.target.value)}>
          {types.map((t) => (
            <option key={t.type} value={t.type}>
              {t.displayName}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Cliente" hint="Só usuários com acesso ao cliente veem e usam a conexão.">
        <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">Nenhum (todos podem usar)</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      {typeDesc.fields.map((f) => (
        <Field key={f.name} label={f.displayName} hint={f.secret && item ? 'Deixe em branco para manter o valor atual' : f.hint}>
          {f.options ? (
            <select value={data[f.name] ?? ''} onChange={(e) => setData({ ...data, [f.name]: e.target.value })}>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={f.secret ? 'password' : 'text'}
              autoComplete="new-password"
              value={data[f.name] ?? ''}
              placeholder={f.secret && item ? item.data[f.name] : f.placeholder}
              onChange={(e) => setData({ ...data, [f.name]: e.target.value })}
            />
          )}
        </Field>
      ))}
      <ErrorBox message={error} />
      {test && test !== 'running' && (
        <div className={test.ok ? 'ok-box' : 'error-box'}>
          {test.ok ? `Conectou (${test.durationMs} ms).` : `Não conectou: ${test.message}`}
        </div>
      )}
      <div className="modal-actions">
        {typeDesc.testable && (
          <button onClick={runTest} disabled={test === 'running'} className="modal-actions-left">
            {test === 'running' ? 'Testando…' : 'Testar conexão'}
          </button>
        )}
        <button onClick={onClose}>Cancelar</button>
        <button className="primary" onClick={save}>
          Salvar
        </button>
      </div>
    </Modal>
  );
}
