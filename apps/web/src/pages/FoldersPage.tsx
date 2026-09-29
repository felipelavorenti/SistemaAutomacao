import { useState } from 'react';
import { del, errorMessage, get, post, put, type Folder } from '../api';
import { ErrorBox, PageHeader, useLoad } from '../components/ui';

export function FoldersPage() {
  const { data, error, reload } = useLoad(() => get<Folder[]>('/folders'));
  const [name, setName] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

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
      <PageHeader title="Pastas" />
      <p className="muted">As pastas agrupam fluxos. Usuários que não são administradores só enxergam as pastas liberadas no cadastro deles.</p>
      <div className="inline-form">
        <input placeholder="Nome da nova pasta" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary" disabled={!name.trim()} onClick={() => act(async () => (await post('/folders', { name }), setName('')))}>
          Criar pasta
        </button>
      </div>
      <ErrorBox message={error ?? actionError} />
      <table>
        <tbody>
          {data?.map((f) => (
            <tr key={f.id}>
              <td>{f.name}</td>
              <td className="row-actions">
                <button
                  className="link"
                  onClick={() => {
                    const next = prompt('Novo nome da pasta', f.name);
                    if (next && next !== f.name) void act(() => put(`/folders/${f.id}`, { name: next }));
                  }}
                >
                  Renomear
                </button>
                <button className="link danger" onClick={() => confirm(`Excluir a pasta "${f.name}"?`) && act(() => del(`/folders/${f.id}`))}>
                  Excluir
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
