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
  expires_at: string | null;
}

/** Opções de validade do token, em dias (null: não vence). */
const VALIDITY: { label: string; days: number | null }[] = [
  { label: 'Vence em 30 dias', days: 30 },
  { label: 'Vence em 90 dias', days: 90 },
  { label: 'Vence em 1 ano', days: 365 },
  { label: 'Não vence', days: null },
];

export function AccountPage() {
  const me = useMe();
  const { data, reload } = useLoad(() => get<Token[]>('/auth/tokens'));
  const [name, setName] = useState('');
  const [days, setDays] = useState<number | null>(365);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    try {
      const res = await post<{ token: string }>('/auth/tokens', { name, expiresInDays: days });
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
        <select value={days === null ? '' : String(days)} onChange={(e) => setDays(e.target.value ? Number(e.target.value) : null)}>
          {VALIDITY.map((v) => (
            <option key={v.label} value={v.days === null ? '' : String(v.days)}>
              {v.label}
            </option>
          ))}
        </select>
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
              <td className="muted">
                {!t.expires_at ? 'não vence' : new Date(t.expires_at) < new Date() ? `venceu em ${formatDate(t.expires_at)}` : `vence em ${formatDate(t.expires_at)}`}
              </td>
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
