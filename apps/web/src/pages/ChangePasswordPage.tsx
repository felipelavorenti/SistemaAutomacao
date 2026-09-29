import { useState, type FormEvent } from 'react';
import { errorMessage, post } from '../api';
import { ErrorBox, Field } from '../components/ui';

export function ChangePasswordPage({ forced, onDone }: { forced?: boolean; onDone: () => Promise<void> }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError('A confirmação não bate com a nova senha');
    try {
      await post('/auth/change-password', { currentPassword: current, newPassword: next });
      setDone(true);
      await onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className={forced ? 'center' : ''}>
      <form className="card auth-card" onSubmit={submit}>
        <h1>Trocar senha</h1>
        {forced && <p className="muted">Defina uma senha nova para continuar.</p>}
        <Field label="Senha atual">
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <Field label="Nova senha" hint="Pelo menos 10 caracteres">
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} required />
        </Field>
        <Field label="Confirme a nova senha">
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </Field>
        <ErrorBox message={error} />
        {done && !forced && <div className="ok-box">Senha alterada.</div>}
        <button className="primary">Salvar</button>
      </form>
    </div>
  );
}
