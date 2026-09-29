import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  del,
  errorMessage,
  formatDate,
  get,
  post,
  put,
  type ApiVariable,
  type Client,
  type ClientField,
  type Erp,
  type ErpClientItem,
  type ErpEndpoint,
} from '../api';
import { useMe } from '../App';
import { ErrorBox, Field, Modal, PageHeader, useLoad } from '../components/ui';

const AUTH_LABEL: Record<Erp['authType'], string> = {
  none: 'Sem autenticação',
  bearer: 'Bearer token (vindo do login)',
  basic: 'Usuário e senha (Basic)',
  header: 'Token num header próprio',
};

export function ErpsPage() {
  const me = useMe();
  const navigate = useNavigate();
  const { data, error } = useLoad(() => get<Erp[]>('/erps'));
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <PageHeader title="APIs de ERP">
        {me.permissions.editConnections && (
          <button className="primary" onClick={() => setCreating(true)}>
            Novo ERP
          </button>
        )}
      </PageHeader>
      <p className="muted">
        Cadastre os endpoints de cada ERP uma vez e o host, a porta e as credenciais de cada cliente nele. No nó HTTP Request, escolha "API cadastrada" e
        preencha só as variáveis.
      </p>
      <ErrorBox message={error} />
      <table>
        <thead>
          <tr>
            <th>ERP</th>
            <th>Autenticação</th>
            <th>Endpoints</th>
            <th>Clientes</th>
            <th>Alterado em</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((e) => (
            <tr key={e.id} className="clickable" onClick={() => navigate(`/erps/${e.id}`)}>
              <td>
                <Link to={`/erps/${e.id}`}>{e.name}</Link>
              </td>
              <td>{AUTH_LABEL[e.authType]}</td>
              <td>{e.endpoints}</td>
              <td>{e.clients}</td>
              <td className="muted">{formatDate(e.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && !data.length && <p className="muted">Nenhum ERP cadastrado.</p>}
      {creating && <ErpModal erp={null} onClose={() => setCreating(false)} onSaved={(id) => navigate(`/erps/${id}`)} />}
    </div>
  );
}

type ErpBase = Omit<Erp, 'endpoints' | 'clients'>;

interface ErpFull extends Omit<Erp, 'endpoints' | 'clients'> {
  endpoints: ErpEndpoint[];
  clients: ErpClientItem[];
}

export function ErpPage() {
  const { id } = useParams();
  const me = useMe();
  const navigate = useNavigate();
  const { data: erp, error, reload } = useLoad(() => get<ErpFull>(`/erps/${id}`), [id]);
  const clients = useLoad(() => get<Client[]>('/clients'));
  const [editingErp, setEditingErp] = useState(false);
  const [endpoint, setEndpoint] = useState<ErpEndpoint | 'new' | null>(null);
  const [erpClient, setErpClient] = useState<ErpClientItem | 'new' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const canEdit = me.permissions.editConnections;

  if (!erp) return <ErrorBox message={error} />;

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
      <PageHeader title={erp.name}>
        <Link to="/erps">Todos os ERPs</Link>
        {canEdit && <button onClick={() => setEditingErp(true)}>Editar ERP</button>}
        {canEdit && (
          <button
            className="danger"
            onClick={() =>
              confirm(`Excluir o ERP ${erp.name} e todos os endpoints dele?`) &&
              void del(`/erps/${erp.id}`).then(() => navigate('/erps'), (err) => setActionError(errorMessage(err)))
            }
          >
            Excluir
          </button>
        )}
      </PageHeader>
      <ErrorBox message={actionError} />
      <div className="facts">
        <div>
          <span className="muted">URL base</span>
          <code>{erp.baseUrl}</code>
        </div>
        <div>
          <span className="muted">Autenticação</span>
          {AUTH_LABEL[erp.authType]}
          {erp.authType === 'header' && erp.authHeader ? ` (${erp.authHeader})` : ''}
        </div>
        <div>
          <span className="muted">Campos do cliente</span>
          {erp.clientFields.map((f) => f.label + (f.secret ? ' 🔒' : '')).join(', ')}
        </div>
      </div>
      {erp.notes && <p className="muted">{erp.notes}</p>}

      <div className="section-header">
        <h2>Endpoints</h2>
        {canEdit && <button onClick={() => setEndpoint('new')}>Novo endpoint</button>}
      </div>
      <table>
        <thead>
          <tr>
            <th>Nome</th>
            <th>Requisição</th>
            <th>Variáveis</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {erp.endpoints.map((ep) => (
            <tr key={ep.id}>
              <td>
                {ep.name}
                {ep.description && <div className="muted small">{ep.description}</div>}
              </td>
              <td>
                <code>
                  {ep.method} {ep.path}
                </code>
                {!ep.usesAuth && erp.authType !== 'none' && <span className="muted small"> · sem autenticação</span>}
              </td>
              <td className="muted">{ep.variables.map((v) => v.name).join(', ') || '—'}</td>
              <td className="row-actions">
                <button className="link" onClick={() => setEndpoint(ep)}>
                  {canEdit ? 'Editar' : 'Ver'}
                </button>
                {canEdit && (
                  <button className="link danger" onClick={() => confirm(`Excluir o endpoint ${ep.name}?`) && void act(() => del(`/erp-endpoints/${ep.id}`))}>
                    Excluir
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!erp.endpoints.length && <p className="muted">Nenhum endpoint. Comece pelo de login, se o ERP usa token.</p>}

      <div className="section-header">
        <h2>Clientes neste ERP</h2>
        {canEdit && <button onClick={() => setErpClient('new')}>Adicionar cliente</button>}
      </div>
      <table>
        <thead>
          <tr>
            <th>Cliente</th>
            {erp.clientFields
              .filter((f) => !f.secret)
              .map((f) => (
                <th key={f.name}>{f.label}</th>
              ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {erp.clients.map((c) => (
            <tr key={c.id}>
              <td>
                {c.clientName}
                {c.label && <span className="muted"> · {c.label}</span>}
              </td>
              {erp.clientFields
                .filter((f) => !f.secret)
                .map((f) => (
                  <td key={f.name}>{c.values[f.name]}</td>
                ))}
              <td className="row-actions">
                {canEdit && (
                  <>
                    <button className="link" onClick={() => setErpClient(c)}>
                      Editar
                    </button>
                    <button className="link danger" onClick={() => confirm(`Remover ${c.clientName} deste ERP?`) && void act(() => del(`/erp-clients/${c.id}`))}>
                      Remover
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!erp.clients.length && <p className="muted">Nenhum cliente cadastrado neste ERP.</p>}

      {editingErp && (
        <ErpModal
          erp={erp}
          onClose={() => setEditingErp(false)}
          onSaved={async () => {
            setEditingErp(false);
            await reload();
          }}
        />
      )}
      {endpoint && (
        <EndpointModal
          erp={erp}
          endpoint={endpoint === 'new' ? null : endpoint}
          readOnly={!canEdit}
          onClose={() => setEndpoint(null)}
          onSaved={async () => {
            setEndpoint(null);
            await reload();
          }}
        />
      )}
      {erpClient && clients.data && (
        <ErpClientModal
          erp={erp}
          item={erpClient === 'new' ? null : erpClient}
          clients={clients.data}
          onClose={() => setErpClient(null)}
          onSaved={async () => {
            setErpClient(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function ErpModal({ erp, onClose, onSaved }: { erp: ErpBase | null; onClose: () => void; onSaved: (id: string) => void | Promise<void> }) {
  const [name, setName] = useState(erp?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(erp?.baseUrl ?? 'http://{{host}}:{{porta}}');
  const [authType, setAuthType] = useState<Erp['authType']>(erp?.authType ?? 'bearer');
  const [authHeader, setAuthHeader] = useState(erp?.authHeader ?? '');
  const [fields, setFields] = useState<ClientField[]>(
    erp?.clientFields ?? [
      { name: 'host', label: 'Host', secret: false },
      { name: 'porta', label: 'Porta', secret: false },
      { name: 'usuario', label: 'Usuário', secret: false },
      { name: 'senha', label: 'Senha', secret: true },
    ],
  );
  const [notes, setNotes] = useState(erp?.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    try {
      const body = { name, baseUrl, authType, authHeader: authType === 'header' ? authHeader : null, clientFields: fields.filter((f) => f.name), notes };
      if (erp) {
        await put(`/erps/${erp.id}`, body);
        await onSaved(erp.id);
      } else {
        await onSaved((await post<Erp>('/erps', body)).id);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal title={erp ? 'Editar ERP' : 'Novo ERP'} onClose={onClose} wide>
      <Field label="Nome">
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Consinco" />
      </Field>
      <Field label="URL base" hint="Use {{campo}} para os campos do cliente. Ex.: http://{{host}}:{{porta}}/api">
        <input className="code" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </Field>
      <Field label="Autenticação dos endpoints" hint="O login não é automático: o endpoint de login roda num nó e o token vai como variável nos próximos.">
        <select value={authType} onChange={(e) => setAuthType(e.target.value as Erp['authType'])}>
          {Object.entries(AUTH_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Field>
      {authType === 'header' && (
        <Field label="Nome do header do token">
          <input value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} placeholder="X-Auth-Token" />
        </Field>
      )}
      <Field label="Campos que cada cliente preenche" hint="Os secretos ficam criptografados e nunca voltam para a tela. Para Basic, use os campos usuario e senha.">
        <div className="list-input">
          {fields.map((f, i) => (
            <div key={i} className="inline-row">
              <input className="code" value={f.name} placeholder="nome" onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input value={f.label} placeholder="Rótulo" onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <label className="check">
                <input type="checkbox" checked={f.secret} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, secret: e.target.checked } : x)))} /> Secreto
              </label>
              <button className="icon" onClick={() => setFields(fields.filter((_, j) => j !== i))} title="Remover">
                ×
              </button>
            </div>
          ))}
          <button className="link" onClick={() => setFields([...fields, { name: '', label: '', secret: false }])}>
            + Adicionar campo
          </button>
        </div>
      </Field>
      <Field label="Observações">
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
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

function PairsEditor({ value, onChange, disabled }: { value: { name: string; value: string }[]; onChange: (v: { name: string; value: string }[]) => void; disabled: boolean }) {
  return (
    <div className="list-input">
      {value.map((p, i) => (
        <div key={i} className="inline-row">
          <input disabled={disabled} value={p.name} placeholder="Nome" onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <input disabled={disabled} className="code" value={p.value} placeholder="Valor, pode usar {{variavel}}" onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          {!disabled && (
            <button className="icon" onClick={() => onChange(value.filter((_, j) => j !== i))} title="Remover">
              ×
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <button className="link" onClick={() => onChange([...value, { name: '', value: '' }])}>
          + Adicionar
        </button>
      )}
    </div>
  );
}

function EndpointModal({
  erp,
  endpoint,
  readOnly,
  onClose,
  onSaved,
}: {
  erp: ErpBase;
  endpoint: ErpEndpoint | null;
  readOnly: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<Omit<ErpEndpoint, 'id'>>(
    endpoint ?? { name: '', description: '', method: 'POST', path: '/', headers: [], query: [], bodyType: 'json', body: '{\n  \n}', variables: [], usesAuth: true },
  );
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm({ ...form, [key]: value });
  const setVar = (i: number, patch: Partial<ApiVariable>) => set('variables', form.variables.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const tokenVar = form.usesAuth && (erp.authType === 'bearer' || erp.authType === 'header');
  const available = [...erp.clientFields.map((f) => f.name), ...form.variables.map((v) => v.name).filter(Boolean), ...(tokenVar ? ['token'] : [])];

  const save = async () => {
    try {
      if (endpoint) await put(`/erp-endpoints/${endpoint.id}`, form);
      else await post(`/erps/${erp.id}/endpoints`, form);
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal title={endpoint ? `${erp.name} · ${endpoint.name}` : `Novo endpoint do ${erp.name}`} onClose={onClose} wide>
      <div className="grid-2">
        <Field label="Nome">
          <input disabled={readOnly} value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus placeholder="Alteração de preço" />
        </Field>
        <Field label="Descrição">
          <input disabled={readOnly} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
      </div>
      <div className="inline-row">
        <select disabled={readOnly} value={form.method} onChange={(e) => set('method', e.target.value)} style={{ width: 110 }}>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <input disabled={readOnly} className="code" value={form.path} onChange={(e) => set('path', e.target.value)} placeholder="/produtos/{{sku}}/preco" />
      </div>
      <p className="field-hint">
        Vai em {erp.baseUrl}
        {form.path}. Dá para usar: {available.map((n) => `{{${n}}}`).join(' ')}
      </p>
      {erp.authType !== 'none' && (
        <label className="check">
          <input type="checkbox" disabled={readOnly} checked={form.usesAuth} onChange={(e) => set('usesAuth', e.target.checked)} /> Usa a autenticação do ERP
          {tokenVar ? ' (o nó pede a variável token)' : ''}. Desmarque no endpoint de login.
        </label>
      )}
      <Field label="Variáveis que o nó vai pedir">
        <div className="list-input">
          {form.variables.map((v, i) => (
            <div key={i} className="inline-row">
              <input disabled={readOnly} className="code" value={v.name} placeholder="nome" onChange={(e) => setVar(i, { name: e.target.value })} />
              <input disabled={readOnly} value={v.label} placeholder="Rótulo (opcional)" onChange={(e) => setVar(i, { label: e.target.value })} />
              <select disabled={readOnly} value={v.type} onChange={(e) => setVar(i, { type: e.target.value as ApiVariable['type'] })}>
                <option value="text">Texto</option>
                <option value="number">Número</option>
                <option value="boolean">Verdadeiro/falso</option>
                <option value="json">JSON</option>
              </select>
              <input disabled={readOnly} value={v.default} placeholder="Padrão" onChange={(e) => setVar(i, { default: e.target.value })} />
              <label className="check">
                <input type="checkbox" disabled={readOnly} checked={v.required} onChange={(e) => setVar(i, { required: e.target.checked })} /> Obrigatória
              </label>
              {!readOnly && (
                <button className="icon" onClick={() => set('variables', form.variables.filter((_, j) => j !== i))} title="Remover">
                  ×
                </button>
              )}
            </div>
          ))}
          {!readOnly && (
            <button className="link" onClick={() => set('variables', [...form.variables, { name: '', label: '', type: 'text', required: true, default: '' }])}>
              + Adicionar variável
            </button>
          )}
        </div>
      </Field>
      <div className="grid-2">
        <Field label="Headers">
          <PairsEditor value={form.headers} onChange={(v) => set('headers', v)} disabled={readOnly} />
        </Field>
        <Field label="Parâmetros de query">
          <PairsEditor value={form.query} onChange={(v) => set('query', v)} disabled={readOnly} />
        </Field>
      </div>
      <Field label="Corpo">
        <select disabled={readOnly} value={form.bodyType} onChange={(e) => set('bodyType', e.target.value as ErpEndpoint['bodyType'])}>
          <option value="none">Sem corpo</option>
          <option value="json">JSON</option>
          <option value="form">Formulário (a=1&b=2)</option>
          <option value="text">Texto</option>
        </select>
      </Field>
      {form.bodyType !== 'none' && (
        <Field label="Modelo do corpo" hint={form.bodyType === 'json' ? 'Um valor que é só "{{variavel}}" recebe o tipo da variável (número, lista, objeto).' : undefined}>
          <textarea disabled={readOnly} className="code" rows={8} value={form.body} onChange={(e) => set('body', e.target.value)} />
        </Field>
      )}
      <ErrorBox message={error} />
      <div className="modal-actions">
        <button onClick={onClose}>{readOnly ? 'Fechar' : 'Cancelar'}</button>
        {!readOnly && (
          <button className="primary" onClick={save}>
            Salvar
          </button>
        )}
      </div>
    </Modal>
  );
}

function ErpClientModal({
  erp,
  item,
  clients,
  onClose,
  onSaved,
}: {
  erp: ErpBase;
  item: ErpClientItem | null;
  clients: Client[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [clientId, setClientId] = useState(item?.clientId ?? clients[0]?.id ?? '');
  const [label, setLabel] = useState(item?.label ?? '');
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(erp.clientFields.map((f) => [f.name, f.secret ? '' : (item?.values[f.name] ?? '')])));
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    try {
      const body = { clientId, label, values };
      if (item) await put(`/erp-clients/${item.id}`, body);
      else await post(`/erps/${erp.id}/clients`, body);
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal title={item ? `${item.clientName} no ${erp.name}` : `Adicionar cliente no ${erp.name}`} onClose={onClose}>
      <Field label="Cliente">
        <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Ambiente (opcional)" hint="Para ter o mesmo cliente duas vezes, ex.: Produção e Homologação.">
        <input value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      {erp.clientFields.map((f) => (
        <Field key={f.name} label={f.label} hint={f.secret && item ? 'Deixe em branco para manter o valor atual' : undefined}>
          <input
            type={f.secret ? 'password' : 'text'}
            autoComplete="new-password"
            value={values[f.name] ?? ''}
            placeholder={f.secret && item ? item.values[f.name] : undefined}
            onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
          />
        </Field>
      ))}
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
