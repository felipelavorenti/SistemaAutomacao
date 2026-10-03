import { Fragment, useState } from 'react';
import { formatDate, get, type AuditItem } from '../api';
import { ErrorBox, JsonView, PageHeader, useLoad } from '../components/ui';

const ENTITY_LABEL: Record<string, string> = {
  workflow: 'Fluxo',
  connection: 'Conexão',
  user: 'Usuário',
  folder: 'Pasta',
  client: 'Cliente',
  execution: 'Execução',
  session: 'Login',
  api_token: 'Token de API',
  erp: 'ERP',
  erp_endpoint: 'Endpoint de ERP',
  erp_client: 'Cliente no ERP',
  file: 'Arquivo',
};

const ACTION_LABEL: Record<string, string> = {
  create: 'criou',
  update: 'alterou',
  delete: 'excluiu',
  activate: 'ativou',
  deactivate: 'desativou',
  duplicate: 'duplicou',
  import: 'importou',
  login: 'entrou',
  login_failed: 'errou a senha',
  change_password: 'trocou a senha',
  update_and_reset_password: 'alterou e redefiniu a senha',
  unlock: 'desbloqueou',
  cancel: 'cancelou',
  retry: 'reexecutou',
};

export function AuditPage() {
  const [entityType, setEntityType] = useState('');
  const [items, setItems] = useState<AuditItem[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const { error } = useLoad(async () => {
    const page = await get<AuditItem[]>(`/audit?limit=100${entityType ? `&entityType=${entityType}` : ''}`);
    setItems(page);
    return page;
  }, [entityType]);

  const more = async () => {
    const last = items[items.length - 1];
    const page = await get<AuditItem[]>(`/audit?limit=100&before=${last.id}${entityType ? `&entityType=${entityType}` : ''}`);
    setItems([...items, ...page]);
  };

  return (
    <div>
      <PageHeader title="Auditoria">
        <select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
          <option value="">Tudo</option>
          {Object.entries(ENTITY_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </PageHeader>
      <ErrorBox message={error} />
      <table>
        <thead>
          <tr>
            <th>Quando</th>
            <th>Quem</th>
            <th>O quê</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <Fragment key={a.id}>
              <tr className={a.before || a.after ? 'clickable' : ''} onClick={() => setOpen(open === a.id ? null : a.id)}>
                <td>{formatDate(a.at)}</td>
                <td>{a.user_name ?? <span className="muted">Sistema</span>}</td>
                <td>
                  {ACTION_LABEL[a.action] ?? a.action} {ENTITY_LABEL[a.entity_type]?.toLowerCase() ?? a.entity_type} <strong>{a.entity_name}</strong>
                </td>
                <td className="muted">{a.ip}</td>
              </tr>
              {open === a.id && (
                <tr>
                  <td colSpan={4}>
                    <div className="io-columns">
                      <div>
                        <h4>Antes</h4>
                        <JsonView value={a.before} />
                      </div>
                      <div>
                        <h4>Depois</h4>
                        <JsonView value={a.after} />
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {items.length > 0 && items.length % 100 === 0 && (
        <button className="load-more" onClick={more}>
          Carregar mais
        </button>
      )}
    </div>
  );
}
