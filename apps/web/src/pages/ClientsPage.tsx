import { useState } from 'react';
import { del, errorMessage, get, post, put, type Client } from '../api';
import { useMe } from '../App';
import { ErrorBox, Field, Modal, PageHeader, useLoad } from '../components/ui';

export function ClientsPage() {
  const me = useMe();
  const { data, error, reload } = useLoad(() => get<Client[]>('/clients'));
  const [editing, setEditing] = useState<Client | 'new' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const remove = async (c: Client) => {
    if (!confirm(`Excluir o cliente "${c.name}"?`)) return;
    try {
      await del(`/clients/${c.id}`);
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  return (
    <div>
      <PageHeader title="Clientes">
        {me.permissions.admin && (
          <button className="primary" onClick={() => setEditing('new')}>
            Novo cliente
          </button>
        )}
      </PageHeader>
      <ErrorBox message={error ?? actionError} />
      <table>
        <thead>
          <tr>
            <th>Nome</th>
            <th>Observações</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td className="muted">{c.notes}</td>
              <td className="row-actions">
                {me.permissions.admin && (
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
      {editing && <ClientModal item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => (setEditing(null), await reload())} />}
    </div>
  );
}

function ClientModal({ item, onClose, onSaved }: { item: Client | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(item?.name ?? '');
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      if (item) await put(`/clients/${item.id}`, { name, notes });
      else await post('/clients', { name, notes });
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Modal title={item ? 'Editar cliente' : 'Novo cliente'} onClose={onClose}>
      <Field label="Nome">
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label="Observações">
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <ErrorBox message={error} />
      <div className="modal-actions">
        <button onClick={onClose}>Cancelar</button>
        <button className="primary" onClick={save}>
          Salvar
        </button>
      </div>
    </Modal>
  );
}
