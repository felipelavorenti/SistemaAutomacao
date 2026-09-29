import { useState } from 'react';
import { errorMessage, get, post, put, ROLE_LABEL, type Client, type Folder, type Me, type UserItem } from '../api';
import { ErrorBox, Field, Modal, PageHeader, useLoad } from '../components/ui';

const ROLE_HELP: Record<Me['role'], string> = {
  admin: 'Tudo, incluindo usuários, pastas, clientes e auditoria',
  editor: 'Cria, edita, executa e ativa fluxos; cadastra conexões',
  operator: 'Executa fluxos e vê os logs, sem editar',
  viewer: 'Vê fluxos e logs, sem executar',
};

export function UsersPage() {
  const { data, error, reload } = useLoad(() => get<UserItem[]>('/users'));
  const folders = useLoad(() => get<Folder[]>('/folders'));
  const clients = useLoad(() => get<Client[]>('/clients'));
  const [editing, setEditing] = useState<UserItem | 'new' | null>(null);

  return (
    <div>
      <PageHeader title="Usuários">
        <button className="primary" onClick={() => setEditing('new')}>
          Novo usuário
        </button>
      </PageHeader>
      <ErrorBox message={error} />
      <table>
        <thead>
          <tr>
            <th>Nome</th>
            <th>E-mail</th>
            <th>Perfil</th>
            <th>Situação</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>{ROLE_LABEL[u.role]}</td>
              <td>
                {!u.active ? (
                  <span className="badge">Desativado</span>
                ) : u.locked_until && new Date(u.locked_until) > new Date() ? (
                  <>
                    <span className="badge badge-error">Bloqueado</span>{' '}
                    <button className="link" onClick={async () => (await post(`/users/${u.id}/unlock`), reload())}>
                      Desbloquear
                    </button>
                  </>
                ) : (
                  <span className="badge badge-success">Ativo</span>
                )}
              </td>
              <td className="row-actions">
                <button className="link" onClick={() => setEditing(u)}>
                  Editar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && folders.data && clients.data && (
        <UserModal
          item={editing === 'new' ? null : editing}
          folders={folders.data}
          clients={clients.data}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function UserModal({
  item,
  folders,
  clients,
  onClose,
  onSaved,
}: {
  item: UserItem | null;
  folders: Folder[];
  clients: Client[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: item?.name ?? '',
    email: item?.email ?? '',
    role: item?.role ?? ('editor' as Me['role']),
    active: item?.active ?? true,
    password: '',
    folderIds: item?.folder_ids ?? [],
    clientIds: item?.client_ids ?? [],
  });
  const [error, setError] = useState<string | null>(null);

  const toggle = (key: 'folderIds' | 'clientIds', id: string) =>
    setForm({ ...form, [key]: form[key].includes(id) ? form[key].filter((x) => x !== id) : [...form[key], id] });

  const save = async () => {
    try {
      const body = { ...form, password: form.password || undefined };
      if (item) await put(`/users/${item.id}`, body);
      else await post('/users', body);
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal title={item ? 'Editar usuário' : 'Novo usuário'} onClose={onClose} wide>
      <div className="grid-2">
        <Field label="Nome">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        </Field>
        <Field label="E-mail">
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Perfil" hint={ROLE_HELP[form.role]}>
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Me['role'] })}>
            {Object.entries(ROLE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label={item ? 'Nova senha (opcional)' : 'Senha inicial'} hint="O usuário troca no primeiro acesso">
          <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Usuário ativo
      </label>
      {form.role !== 'admin' && (
        <div className="grid-2">
          <fieldset>
            <legend>Pastas que pode ver</legend>
            {folders.map((f) => (
              <label key={f.id} className="check">
                <input type="checkbox" checked={form.folderIds.includes(f.id)} onChange={() => toggle('folderIds', f.id)} /> {f.name}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Clientes cujas conexões pode usar</legend>
            {clients.map((c) => (
              <label key={c.id} className="check">
                <input type="checkbox" checked={form.clientIds.includes(c.id)} onChange={() => toggle('clientIds', c.id)} /> {c.name}
              </label>
            ))}
            {!clients.length && <p className="muted">Nenhum cliente cadastrado.</p>}
          </fieldset>
        </div>
      )}
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
