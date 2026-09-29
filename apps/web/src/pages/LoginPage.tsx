import { useState, type FormEvent } from 'react';
import { errorMessage, post } from '../api';
import { ErrorBox, Field } from '../components/ui';

export function LoginPage({ onLogin }: { onLogin: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post('/auth/login', { email, password });
      await onLogin();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <form className="card auth-card" onSubmit={submit}>
        <h1>Automações</h1>
        <Field label="E-mail">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        </Field>
        <Field label="Senha">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <ErrorBox message={error} />
        <button className="primary" disabled={busy}>
          Entrar
        </button>
      </form>
    </div>
  );
}
