import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api';
import { ErrorBox, PageHeader, useLoad } from '../components/ui';

type ApiProfile = 'public' | 'any' | 'operator' | 'editor' | 'admin';

interface ApiField {
  name: string;
  type: string;
  required?: boolean;
  description: string;
}

interface ApiRoute {
  method: string;
  path: string;
  profile: ApiProfile;
  summary: string;
  params?: ApiField[];
  query?: ApiField[];
  body?: ApiField[];
  /** Explicação da resposta, quando o exemplo sozinho não basta. */
  response?: string;
  errors?: string[];
  audited?: boolean;
  example?: ApiExample;
}

/** Chamada de verdade e o que o servidor respondeu. */
interface ApiExample {
  response: unknown;
  note?: string;
  /** Comando curl, com $INFO8N no lugar do endereço do servidor. */
  curl?: string;
}

interface ApiGroup {
  title: string;
  routes: ApiRoute[];
}

const PROFILE_LABEL: Record<ApiProfile, string> = {
  public: 'Sem login',
  any: 'Qualquer perfil',
  operator: 'Operador ou acima',
  editor: 'Editor ou acima',
  admin: 'Administrador',
};

/** Referência das chamadas da API, para quem integra outro sistema com um token. */
export function ApiDocsPage() {
  const { data, error } = useLoad(() => get<ApiGroup[]>('/docs'));
  const [search, setSearch] = useState('');
  const base = `${window.location.origin}/api`;

  const term = search.trim().toLowerCase();
  const matches = (r: ApiRoute) => !term || `${r.method} ${r.path} ${r.summary}`.toLowerCase().includes(term);
  const groups = (data ?? []).map((g) => ({ ...g, routes: g.routes.filter(matches) })).filter((g) => g.routes.length);
  const total = (data ?? []).reduce((n, g) => n + g.routes.length, 0);

  return (
    <div className="api-docs">
      <PageHeader title="Referência da API" />
      <p>
        Tudo o que a tela faz passa por esta API, e outro sistema pode usar as mesmas chamadas. Os endereços começam com <code>{base}</code>, e os
        corpos de envio e de resposta são JSON.
      </p>

      <h2>Autenticação</h2>
      <ul>
        <li>
          Gere um token em <Link to="/conta">Minha conta</Link>. Ele começa com <code>sa_</code> e só aparece uma vez.
        </li>
        <li>
          Mande o token em toda chamada no header <code>Authorization: Bearer sa_...</code>.
        </li>
        <li>
          O token age como quem o criou: mesmo perfil, mesmas pastas e mesmos clientes. Para uma integração, crie um usuário só para ela, com o
          menor perfil que resolve (Operador para disparar fluxos, Leitor para consultar), e gere o token com ele.
        </li>
        <li>O token não expira. Para de valer quando é revogado ou quando o usuário é desativado.</li>
      </ul>

      <h2>Disparar um fluxo e pegar o resultado</h2>
      <ol>
        <li>
          <code>POST /api/workflows/{'{id}'}/run</code> põe o fluxo na fila e devolve <code>{'{"executionId": "..."}'}</code> na hora, sem esperar
          ele terminar. Os itens de <code>input</code> entram no Gatilho manual do fluxo.
        </li>
        <li>
          Consulte <code>GET /api/executions/{'{executionId}'}</code> a cada 1 ou 2 segundos até <code>status</code> sair de <code>queued</code> ou{' '}
          <code>running</code>.
        </li>
        <li>
          Com <code>success</code>, o resultado é o <code>output</code> do último item de <code>runs</code>. Com <code>error</code>, veja{' '}
          <code>error_message</code> e <code>error_node</code>.
        </li>
      </ol>
      <pre className="json-view">{`curl -X POST ${base}/workflows/ID_DO_FLUXO/run \\
  -H "Authorization: Bearer sa_SEU_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"input":[{"json":{"sku":"123"}}]}'

curl ${base}/executions/ID_DA_EXECUCAO \\
  -H "Authorization: Bearer sa_SEU_TOKEN"`}</pre>

      <h2>Erros</h2>
      <p>
        Todo erro responde com <code>{'{"error": "mensagem", "details": ...}'}</code>.
      </p>
      <table>
        <tbody>
          <tr>
            <td>400</td>
            <td>Dados inválidos (details lista cada campo com problema) ou regra de negócio</td>
          </tr>
          <tr>
            <td>401</td>
            <td>Sem token, token errado ou revogado</td>
          </tr>
          <tr>
            <td>403</td>
            <td>Perfil sem permissão, pasta ou cliente sem acesso, ou senha que precisa ser trocada</td>
          </tr>
          <tr>
            <td>404</td>
            <td>Não existe, ou está numa pasta ou cliente que o usuário não enxerga</td>
          </tr>
          <tr>
            <td>409</td>
            <td>Conflito: nome repetido, registro em uso ou fluxo salvo por outra pessoa</td>
          </tr>
          <tr>
            <td>500</td>
            <td>Erro interno; o detalhe fica no log do servidor</td>
          </tr>
        </tbody>
      </table>

      <div className="section-header">
        <h2>Todas as chamadas{data ? ` (${total})` : ''}</h2>
      </div>
      <p className="muted">
        Cada chamada traz um exemplo tirado de uma chamada de verdade. Nos comandos, troque <code>$TOKEN</code> pelo seu token.
      </p>
      <div className="filters">
        <input placeholder="Procurar por caminho ou descrição" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <ErrorBox message={error} />
      {data && !groups.length && <p className="muted">Nenhuma chamada encontrada.</p>}
      {groups.map((g) => (
        <section key={g.title}>
          <h3>{g.title}</h3>
          {g.routes.map((r) => (
            <RouteItem key={`${r.method} ${r.path}`} route={r} />
          ))}
        </section>
      ))}
    </div>
  );
}

function RouteItem({ route }: { route: ApiRoute }) {
  return (
    <details className="api-route">
      <summary>
        <span className={`badge api-method api-${route.method.toLowerCase()}`}>{route.method}</span>
        <code>/api{route.path}</code>
        <span className="muted">{route.summary}</span>
      </summary>
      <div className="api-route-body">
        <p>
          <strong>Perfil:</strong> {PROFILE_LABEL[route.profile]}
          {route.audited && <span className="muted"> · registra na auditoria</span>}
        </p>
        <Fields title="Parâmetros do caminho" fields={route.params} />
        <Fields title="Filtros na URL" fields={route.query} />
        <Fields title="Corpo (JSON)" fields={route.body} />
        {route.example?.curl && (
          <>
            <strong>Exemplo de chamada</strong>
            <pre className="json-view">{route.example.curl.replaceAll('$INFO8N', window.location.origin)}</pre>
          </>
        )}
        {(route.example || route.response) && <strong>Exemplo de resposta</strong>}
        {route.response && <p>{route.response}</p>}
        {route.example && <pre className="json-view">{JSON.stringify(route.example.response, null, 2)}</pre>}
        {route.example?.note && <p className="muted">{route.example.note}</p>}
        {!!route.errors?.length && (
          <>
            <strong>Erros próprios</strong>
            <ul>
              {route.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </details>
  );
}

function Fields({ title, fields }: { title: string; fields?: ApiField[] }) {
  if (!fields?.length) return null;
  return (
    <>
      <strong>{title}</strong>
      <table>
        <tbody>
          {fields.map((f) => (
            <tr key={f.name}>
              <td>
                <code>{f.name}</code>
                {f.required && <span className="required"> *</span>}
              </td>
              <td className="muted">{f.type}</td>
              <td>{f.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
