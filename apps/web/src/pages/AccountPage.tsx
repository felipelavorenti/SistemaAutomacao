import { useState } from 'react';
import { Link } from 'react-router-dom';
import { del, errorMessage, formatDate, get, post } from '../api';
import { useMe } from '../App';
import { ErrorBox, PageHeader, useLoad } from '../components/ui';
import { ChangePasswordPage } from './ChangePasswordPage';

interface Token {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export function AccountPage() {
  const me = useMe();
  const { data, reload } = useLoad(() => get<Token[]>('/auth/tokens'));
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    try {
      const res = await post<{ token: string }>('/auth/tokens', { name });
      setCreated(res.token);
      setName('');
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div>
      <PageHeader title="Minha conta" />
      <p>
        {me.name} · {me.email}
      </p>
      <ChangePasswordPage onDone={async () => {}} />
      <h2>Tokens de API</h2>
      <p className="muted">
        Para sistemas internos chamarem a API da plataforma com o header Authorization: Bearer seguido do token. As chamadas disponíveis estão na{' '}
        <Link to="/referencia-api">Referência da API</Link>.
      </p>
      <div className="inline-form">
        <input placeholder="Nome do token (ex.: ERP interno)" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary" disabled={!name.trim()} onClick={create}>
          Gerar token
        </button>
      </div>
      <ErrorBox message={error} />
      {created && (
        <div className="ok-box">
          Copie o token agora, ele não aparece de novo: <code>{created}</code>
        </div>
      )}
      <table>
        <tbody>
          {data?.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td className="muted">criado em {formatDate(t.created_at)}</td>
              <td className="muted">{t.last_used_at ? `usado em ${formatDate(t.last_used_at)}` : 'nunca usado'}</td>
              <td className="row-actions">
                <button className="link danger" onClick={async () => (await del(`/auth/tokens/${t.id}`), reload())}>
                  Revogar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
