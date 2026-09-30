/**
 * Referência de todas as chamadas da API, mostrada na tela "Referência da API"
 * (GET /api/docs). O teste test/api-reference.test.ts falha quando uma rota
 * existe sem estar aqui, ou quando algo daqui não existe mais: ao criar ou
 * mudar uma rota, atualize esta lista junto.
 */

/** Menor perfil que pode usar a chamada; os perfis acima também podem. */
export type ApiProfile = 'public' | 'any' | 'operator' | 'editor' | 'admin';

export interface ApiField {
  name: string;
  type: string;
  required?: boolean;
  description: string;
}

export interface ApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Caminho depois de /api, com os parâmetros entre chaves, ex.: /workflows/{id}. */
  path: string;
  profile: ApiProfile;
  summary: string;
  params?: ApiField[];
  query?: ApiField[];
  body?: ApiField[];
  response: string;
  /** Erros próprios da chamada, além dos comuns (401, 403 de perfil, 400 de dados inválidos). */
  errors?: string[];
  /** Grava na auditoria quem fez, quando, o IP e, nas alterações, o antes e o depois. */
  audited?: boolean;
}

export interface ApiGroup {
  title: string;
  routes: ApiRoute[];
}

const id = (what: string): ApiField => ({ name: 'id', type: 'uuid', required: true, description: `ID ${what}` });
const limit: ApiField = { name: 'limit', type: 'número', description: 'Quantas linhas devolver, de 1 a 200 (padrão 50)' };
const from: ApiField = { name: 'from', type: 'data e hora', description: 'A partir de quando, com fuso (ex.: 2026-09-30T00:00:00-03:00)' };
const to: ApiField = { name: 'to', type: 'data e hora', description: 'Até quando, com fuso' };
const ok = '{"ok": true}';

const workflowBody = (definitionRequired: boolean): ApiField[] => [
  { name: 'name', type: 'texto', required: true, description: 'Nome do fluxo' },
  { name: 'folderId', type: 'uuid', required: true, description: 'Pasta do fluxo; o usuário precisa ter acesso a ela' },
  {
    name: 'definition',
    type: 'objeto',
    required: definitionRequired,
    description: 'Nós e ligações do fluxo: {"nodes": [...], "connections": [...]}, no formato de GET /workflows/{id}',
  },
];

const connectionBody: ApiField[] = [
  { name: 'name', type: 'texto', required: true, description: 'Nome da conexão' },
  { name: 'type', type: 'texto', required: true, description: 'Tipo, como devolvido por GET /connection-types (ex.: postgres, sqlserver)' },
  { name: 'clientId', type: 'uuid ou null', description: 'Cliente dono da conexão; null para uma conexão sem cliente' },
  { name: 'data', type: 'objeto', required: true, description: 'Campos do tipo. Segredo em branco ao alterar mantém o valor salvo' },
];

const erpBody: ApiField[] = [
  { name: 'name', type: 'texto', required: true, description: 'Nome do ERP (único)' },
  { name: 'baseUrl', type: 'texto', required: true, description: 'Endereço base; aceita {{variáveis}} do cadastro do cliente' },
  { name: 'authType', type: 'texto', required: true, description: 'none, bearer, basic ou header' },
  { name: 'authHeader', type: 'texto', description: 'Nome do header, quando authType é header' },
  { name: 'clientFields', type: 'lista', description: 'Campos pedidos no cadastro do cliente: [{"name","label","secret"}]. Padrão: host, porta, usuário e senha' },
  { name: 'notes', type: 'texto', description: 'Observações' },
];

const endpointBody: ApiField[] = [
  { name: 'name', type: 'texto', required: true, description: 'Nome do endpoint (único no ERP)' },
  { name: 'description', type: 'texto', description: 'O que ele faz' },
  { name: 'method', type: 'texto', required: true, description: 'GET, POST, PUT, PATCH ou DELETE' },
  { name: 'path', type: 'texto', required: true, description: 'Caminho depois do endereço base; aceita {{variáveis}}' },
  { name: 'headers', type: 'lista', description: 'Headers: [{"name","value"}]' },
  { name: 'query', type: 'lista', description: 'Parâmetros da URL: [{"name","value"}]' },
  { name: 'bodyType', type: 'texto', description: 'none, json, form ou text (padrão none)' },
  { name: 'body', type: 'texto', description: 'Corpo enviado; aceita {{variáveis}}' },
  { name: 'variables', type: 'lista', description: 'Variáveis pedidas no nó: [{"name","label","type" (text, number, boolean, json),"required","default"}]' },
  { name: 'usesAuth', type: 'sim ou não', description: 'Se usa a autenticação do ERP (padrão sim). Desmarque no endpoint de login' },
];

const erpClientBody: ApiField[] = [
  { name: 'clientId', type: 'uuid', required: true, description: 'Cliente; o usuário precisa ter acesso a ele' },
  { name: 'label', type: 'texto', description: 'Nome do cadastro, para ter mais de um por cliente (ex.: Homologação)' },
  { name: 'values', type: 'objeto', required: true, description: 'Valores dos campos do ERP. Segredo em branco ao alterar mantém o valor salvo' },
];

const userBody = (creating: boolean): ApiField[] => [
  { name: 'email', type: 'texto', required: true, description: 'E-mail de login (único)' },
  { name: 'name', type: 'texto', required: true, description: 'Nome' },
  { name: 'role', type: 'texto', required: true, description: 'admin, editor, operator ou viewer' },
  { name: 'active', type: 'sim ou não', description: 'Usuário ativo (padrão sim). Desativado não entra e os tokens dele param' },
  {
    name: 'password',
    type: 'texto',
    required: creating,
    description: creating ? 'Senha inicial; o usuário troca no primeiro acesso' : 'Nova senha; se enviada, redefine a senha e derruba as sessões',
  },
  { name: 'folderIds', type: 'lista de uuid', description: 'Pastas que o usuário enxerga (administrador enxerga todas)' },
  { name: 'clientIds', type: 'lista de uuid', description: 'Clientes que o usuário enxerga (administrador enxerga todos)' },
];

export const API_REFERENCE: ApiGroup[] = [
  {
    title: 'Conta e tokens',
    routes: [
      { method: 'GET', path: '/health', profile: 'public', summary: 'Diz se o servidor está no ar.', response: ok },
      {
        method: 'GET',
        path: '/docs',
        profile: 'any',
        summary: 'Esta referência, em JSON.',
        response: 'Lista de grupos: [{"title","routes": [{"method","path","profile","summary","params","query","body","response","errors","audited"}]}]',
      },
      {
        method: 'POST',
        path: '/auth/login',
        profile: 'public',
        summary: 'Entra na tela e devolve o cookie de sessão. Sistemas externos devem usar um token no lugar.',
        body: [
          { name: 'email', type: 'texto', required: true, description: 'E-mail' },
          { name: 'password', type: 'texto', required: true, description: 'Senha' },
        ],
        response: `${ok}, com o cookie sa_session, que vale SESSION_TTL_HOURS (12 horas por padrão)`,
        errors: ['401: e-mail ou senha errados, usuário inativo ou bloqueado. 5 senhas erradas seguidas bloqueiam por 15 minutos'],
        audited: true,
      },
      { method: 'POST', path: '/auth/logout', profile: 'any', summary: 'Encerra a sessão do cookie.', response: ok },
      {
        method: 'GET',
        path: '/auth/me',
        profile: 'any',
        summary: 'Usuário dono da sessão ou do token.',
        response: '{"id","email","name","role","mustChangePassword","permissions": {"editWorkflows","executeWorkflows","editConnections","admin"}}',
      },
      {
        method: 'POST',
        path: '/auth/change-password',
        profile: 'any',
        summary: 'Troca a própria senha.',
        body: [
          { name: 'currentPassword', type: 'texto', required: true, description: 'Senha atual' },
          { name: 'newPassword', type: 'texto', required: true, description: 'Senha nova' },
        ],
        response: ok,
        errors: ['400: senha atual incorreta ou senha nova fraca'],
        audited: true,
      },
      {
        method: 'GET',
        path: '/auth/tokens',
        profile: 'any',
        summary: 'Tokens de API do próprio usuário.',
        response: '[{"id","name","created_at","last_used_at"}]',
      },
      {
        method: 'POST',
        path: '/auth/tokens',
        profile: 'any',
        summary: 'Cria um token de API. Ele age como o usuário que o criou e não expira.',
        body: [{ name: 'name', type: 'texto', required: true, description: 'Nome do token, até 100 caracteres (ex.: ERP interno)' }],
        response: '{"id","name","token"}. O token começa com sa_ e só aparece nesta resposta',
        audited: true,
      },
      {
        method: 'DELETE',
        path: '/auth/tokens/{id}',
        profile: 'any',
        summary: 'Revoga um token do próprio usuário. Ele para de funcionar na hora.',
        params: [id('do token')],
        response: ok,
        errors: ['404: o token não existe ou é de outro usuário'],
        audited: true,
      },
    ],
  },
  {
    title: 'Fluxos',
    routes: [
      {
        method: 'GET',
        path: '/workflows',
        profile: 'any',
        summary: 'Fluxos das pastas que o usuário enxerga.',
        response:
          '[{"id","name","folder_id","folder_name","active","version","updated_at","updated_by_name","last_execution": {"id","status","createdAt"},"scheduled","callable"}]. scheduled indica gatilho de agendamento; callable, que pode ser chamado como subfluxo',
      },
      {
        method: 'GET',
        path: '/workflows/{id}',
        profile: 'any',
        summary: 'Fluxo completo.',
        params: [id('do fluxo')],
        response: '{"id","name","folder_id","active","version","updated_at","definition","issues"}. issues lista os problemas encontrados na validação',
        errors: ['404: não existe ou está numa pasta sem acesso'],
      },
      {
        method: 'POST',
        path: '/workflows',
        profile: 'editor',
        summary: 'Cria um fluxo. Sem definition, ele nasce só com o Gatilho manual.',
        body: workflowBody(false),
        response: 'O fluxo criado, como em GET /workflows/{id}',
        errors: ['400: usa conexão ou subfluxo que não existe', '403: pasta, conexão ou subfluxo sem acesso'],
        audited: true,
      },
      {
        method: 'PUT',
        path: '/workflows/{id}',
        profile: 'editor',
        summary: 'Salva o fluxo. Cada gravação cria uma versão nova.',
        params: [id('do fluxo')],
        body: [
          ...workflowBody(true),
          { name: 'baseVersion', type: 'número', description: 'Versão que foi editada. Se outra pessoa salvou depois dela, a gravação é recusada' },
        ],
        response: 'O fluxo salvo, com issues',
        errors: [
          '400: fluxo ativo com problemas, cron inválido, conexão ou subfluxo que não existe, ou o fluxo chama ele mesmo',
          '409: outra pessoa salvou depois da baseVersion',
        ],
        audited: true,
      },
      {
        method: 'DELETE',
        path: '/workflows/{id}',
        profile: 'editor',
        summary: 'Exclui o fluxo e desliga o agendamento dele.',
        params: [id('do fluxo')],
        response: ok,
        errors: ['400: outros fluxos chamam este como subfluxo (a mensagem diz quais)'],
        audited: true,
      },
      {
        method: 'POST',
        path: '/workflows/{id}/activate',
        profile: 'editor',
        summary: 'Liga o agendamento do fluxo.',
        params: [id('do fluxo')],
        response: '{"ok": true, "active": true}',
        errors: ['400: o fluxo não tem gatilho de agendamento, tem problemas ou o cron é inválido'],
        audited: true,
      },
      {
        method: 'POST',
        path: '/workflows/{id}/deactivate',
        profile: 'editor',
        summary: 'Desliga o agendamento do fluxo.',
        params: [id('do fluxo')],
        response: '{"ok": true, "active": false}',
        audited: true,
      },
      {
        method: 'POST',
        path: '/workflows/{id}/duplicate',
        profile: 'editor',
        summary: 'Cria uma cópia "(cópia)" na mesma pasta, desativada.',
        params: [id('do fluxo')],
        response: 'A cópia, como em GET /workflows/{id}',
        audited: true,
      },
      {
        method: 'POST',
        path: '/workflows/{id}/run',
        profile: 'operator',
        summary:
          'Põe o fluxo na fila e responde na hora, sem esperar ele terminar. Acompanhe o resultado em GET /executions/{id}. A execução conta como manual e guarda os dados de todos os nós.',
        params: [id('do fluxo')],
        body: [
          {
            name: 'input',
            type: 'lista',
            description: 'Itens que entram no primeiro gatilho do fluxo (o Gatilho manual): [{"json": {...}}]. Sem input, o gatilho solta um item vazio',
          },
          { name: 'definition', type: 'objeto', description: 'Usado pelo editor da tela para rodar um fluxo ainda não salvo. Exige o perfil Editor' },
        ],
        response: '{"executionId"}',
        errors: ['404: o fluxo não existe ou está numa pasta sem acesso'],
      },
      {
        method: 'GET',
        path: '/workflows/{id}/callers',
        profile: 'any',
        summary: 'Fluxos que chamam este como subfluxo.',
        params: [id('do fluxo')],
        response: '[{"id","name"}]',
      },
      {
        method: 'GET',
        path: '/workflows/{id}/versions',
        profile: 'any',
        summary: 'Últimas 200 versões salvas do fluxo.',
        params: [id('do fluxo')],
        response: '[{"version","name","created_at","created_by_name"}]',
      },
      {
        method: 'GET',
        path: '/workflows/{id}/versions/{version}',
        profile: 'any',
        summary: 'Uma versão salva do fluxo.',
        params: [id('do fluxo'), { name: 'version', type: 'número', required: true, description: 'Número da versão' }],
        response: '{"version","name","definition","created_at"}',
        errors: ['404: versão não existe'],
      },
      {
        method: 'GET',
        path: '/workflows/{id}/export',
        profile: 'any',
        summary: 'Arquivo de exportação do fluxo, o mesmo que a tela baixa.',
        params: [id('do fluxo')],
        response: '{"name","definition","exportedAt"}',
      },
      {
        method: 'POST',
        path: '/workflows/import',
        profile: 'editor',
        summary: 'Importa um fluxo exportado. Ele entra desativado.',
        body: workflowBody(true),
        response: 'O fluxo criado, como em GET /workflows/{id}',
        errors: ['400: usa conexão ou subfluxo que não existe', '403: pasta, conexão ou subfluxo sem acesso'],
        audited: true,
      },
      {
        method: 'POST',
        path: '/workflows/import-n8n',
        profile: 'editor',
        summary:
          'Importa fluxos exportados do n8n. Entram desativados, e os Execute Workflow passam a apontar para os subfluxos importados. Fluxo já importado antes é pulado.',
        body: [
          { name: 'folderId', type: 'uuid', required: true, description: 'Pasta onde os fluxos entram' },
          { name: 'data', type: 'objeto ou lista', required: true, description: 'O JSON exportado do n8n, com um fluxo ou uma lista (até 50 MB)' },
        ],
        response: '[{"n8nId","name","status" (imported ou skipped),"id","wasActive","warnings": [{"node","message"}]}]',
        errors: ['400: o arquivo não é uma exportação do n8n'],
        audited: true,
      },
      {
        method: 'GET',
        path: '/node-types',
        profile: 'any',
        summary: 'Tipos de nó disponíveis no editor, com os parâmetros de cada um.',
        response: '[{"type","displayName","description","group","inputs","outputs","inputNames","outputNames","hidden","defaultTimeoutMs","properties"}]',
      },
      {
        method: 'POST',
        path: '/expressions/preview',
        profile: 'editor',
        summary: 'Calcula uma expressão como a prévia do editor.',
        body: [
          { name: 'value', type: 'texto', required: true, description: 'Texto com {{ expressões }}' },
          { name: 'input', type: 'lista', description: 'Itens de entrada: [{"json": {...}}]' },
          { name: 'nodeOutputs', type: 'objeto', description: 'Saída de cada nó pelo nome, para $node["Nome"]' },
          { name: 'itemIndex', type: 'número', description: 'Item usado como $json (padrão 0)' },
        ],
        response: '{"result"} ou {"error"}',
      },
    ],
  },
  {
    title: 'Execuções e comandos de banco',
    routes: [
      {
        method: 'GET',
        path: '/executions',
        profile: 'any',
        summary: 'Execuções dos fluxos que o usuário enxerga, mais novas primeiro.',
        query: [
          { name: 'workflowId', type: 'uuid', description: 'Só de um fluxo' },
          { name: 'status', type: 'texto', description: 'queued, running, success, error ou canceled' },
          { name: 'mode', type: 'texto', description: 'manual, schedule, subworkflow ou retry' },
          { name: 'parentId', type: 'uuid', description: 'Só os subfluxos chamados por esta execução' },
          from,
          to,
          { name: 'search', type: 'texto', description: 'Procura no nome do fluxo, na mensagem de erro e no nó do erro' },
          { name: 'before', type: 'data e hora', description: 'Para paginar: created_at da última linha recebida' },
          limit,
        ],
        response:
          '[{"id","workflow_id","workflow_name","mode","status","created_at","started_at","finished_at","duration_ms","error_message","error_node","triggered_by_name","data_size","parent_execution_id"}]',
      },
      {
        method: 'GET',
        path: '/executions/waiting',
        profile: 'any',
        summary: 'Fluxos agendados que já deviam ter começado e esperam vaga no worker.',
        response: '[{"workflowId","workflowName","dueAt"}]',
      },
      {
        method: 'GET',
        path: '/executions/{id}',
        profile: 'any',
        summary:
          'Execução completa. Consulte até status sair de queued ou running. O resultado do fluxo é o output do último item de runs.',
        params: [id('da execução')],
        response:
          '{"id","workflow_id","workflow_name","folder_id","workflow_version","mode","status","triggered_by","triggered_by_name","retry_of","parent_execution_id","created_at","started_at","finished_at","input","definition","summary","runs","error_message","error_node","error","data_size","children"}. runs traz, por nó executado, {"nodeName","status","input","output"}, com output sendo uma lista por saída do nó e cada saída uma lista de itens {"json"}. runs vem vazio quando os dados não foram guardados (agendado com sucesso, se KEEP_SUCCESS_DATA estiver desligado). children lista os subfluxos chamados',
        errors: ['404: não existe ou é de um fluxo numa pasta sem acesso'],
      },
      {
        method: 'POST',
        path: '/executions/{id}/cancel',
        profile: 'operator',
        summary: 'Cancela uma execução na fila ou em andamento.',
        params: [id('da execução')],
        response: ok,
        errors: ['400: a execução já terminou'],
        audited: true,
      },
      {
        method: 'POST',
        path: '/executions/{id}/retry',
        profile: 'operator',
        summary: 'Roda de novo com a mesma definição e a mesma entrada.',
        params: [id('da execução')],
        response: '{"executionId"} da nova execução',
        errors: ['400: a execução ainda está em andamento'],
        audited: true,
      },
      {
        method: 'GET',
        path: '/db-commands',
        profile: 'any',
        summary: 'Comandos rodados nos bancos dos clientes que o usuário enxerga, mais novos primeiro.',
        query: [
          { name: 'clientId', type: 'uuid', description: 'Só de um cliente' },
          { name: 'connectionId', type: 'uuid', description: 'Só de uma conexão' },
          { name: 'executionId', type: 'uuid', description: 'Só de uma execução' },
          { name: 'status', type: 'texto', description: 'ok ou error' },
          from,
          to,
          { name: 'search', type: 'texto', description: 'Procura no SQL, no nome do fluxo e no erro' },
          { name: 'beforeId', type: 'número', description: 'Para paginar: id da última linha recebida' },
          limit,
        ],
        response:
          '[{"id","at","execution_id","workflow_id","workflow_name","node_name","connection_id","connection_name","client_id","client_name","db_type","operation","sql","params","rows","rows_affected","duration_ms","error","triggered_by_name"}]',
      },
    ],
  },
  {
    title: 'Conexões',
    routes: [
      {
        method: 'GET',
        path: '/connection-types',
        profile: 'any',
        summary: 'Tipos de conexão e os campos de cada um.',
        response: '[{"type","displayName","testable","fields": [{"name","displayName","secret","required","default","options"}]}]',
      },
      {
        method: 'GET',
        path: '/connections',
        profile: 'any',
        summary: 'Conexões sem cliente e as dos clientes que o usuário enxerga. Segredos nunca voltam.',
        response: '[{"id","name","type","typeName","clientId","clientName","data","updatedAt","updatedByName"}]',
      },
      {
        method: 'GET',
        path: '/connections/{id}',
        profile: 'any',
        summary: 'Uma conexão, sem os segredos.',
        params: [id('da conexão')],
        response: 'Como um item de GET /connections',
        errors: ['404: não existe ou é de um cliente sem acesso'],
      },
      {
        method: 'GET',
        path: '/connections/{id}/usage',
        profile: 'any',
        summary: 'Fluxos que usam a conexão.',
        params: [id('da conexão')],
        response: '[{"id","name","active"}]',
      },
      {
        method: 'POST',
        path: '/connections',
        profile: 'editor',
        summary: 'Cria uma conexão. Os segredos são guardados criptografados.',
        body: connectionBody,
        response: 'A conexão criada, como em GET /connections/{id}',
        errors: ['400: tipo desconhecido ou campo obrigatório vazio', '403: cliente sem acesso'],
        audited: true,
      },
      {
        method: 'PUT',
        path: '/connections/{id}',
        profile: 'editor',
        summary: 'Altera uma conexão. Não troca o tipo. A auditoria diz quais segredos mudaram, sem os valores.',
        params: [id('da conexão')],
        body: connectionBody,
        response: 'A conexão salva',
        errors: ['400: troca de tipo ou campo obrigatório vazio', '403: cliente sem acesso'],
        audited: true,
      },
      {
        method: 'DELETE',
        path: '/connections/{id}',
        profile: 'editor',
        summary: 'Exclui uma conexão.',
        params: [id('da conexão')],
        response: ok,
        errors: ['409: fluxos usam a conexão (a mensagem diz quais)'],
        audited: true,
      },
      {
        method: 'POST',
        path: '/connections/test',
        profile: 'editor',
        summary: 'Testa os dados de uma conexão sem salvar. Espera até 20 segundos.',
        body: [
          { name: 'type', type: 'texto', required: true, description: 'Tipo da conexão' },
          { name: 'data', type: 'objeto', required: true, description: 'Campos do tipo' },
          { name: 'id', type: 'uuid', description: 'Conexão já salva; os segredos em branco usam os valores dela' },
        ],
        response: '{"ok": true, "durationMs"} ou {"ok": false, "message"}',
        errors: ['400: o tipo é testado no próprio nó, ou falta campo obrigatório'],
      },
    ],
  },
  {
    title: 'APIs dos ERPs',
    routes: [
      {
        method: 'GET',
        path: '/erps',
        profile: 'any',
        summary: 'ERPs cadastrados.',
        response: '[{"id","name","baseUrl","authType","authHeader","clientFields","notes","updatedAt","endpoints","clients"}]. endpoints e clients são contagens',
      },
      {
        method: 'GET',
        path: '/erps/{id}',
        profile: 'any',
        summary: 'Um ERP com os endpoints e os clientes cadastrados nele (só os clientes que o usuário enxerga, sem os segredos).',
        params: [id('do ERP')],
        response:
          '{"id","name","baseUrl","authType","authHeader","clientFields","notes","updatedAt","endpoints": [{"id","name","description","method","path","headers","query","bodyType","body","variables","usesAuth","updatedAt"}],"clients": [{"id","clientId","clientName","label","values","updatedAt"}]}',
      },
      {
        method: 'POST',
        path: '/erps',
        profile: 'editor',
        summary: 'Cadastra um ERP.',
        body: erpBody,
        response: 'O ERP criado, sem as listas',
        errors: ['409: já existe um ERP com esse nome'],
        audited: true,
      },
      {
        method: 'PUT',
        path: '/erps/{id}',
        profile: 'editor',
        summary: 'Altera um ERP.',
        params: [id('do ERP')],
        body: erpBody,
        response: 'O ERP salvo, sem as listas',
        audited: true,
      },
      {
        method: 'DELETE',
        path: '/erps/{id}',
        profile: 'editor',
        summary: 'Exclui um ERP e os endpoints dele.',
        params: [id('do ERP')],
        response: ok,
        errors: ['409: o ERP tem clientes cadastrados'],
        audited: true,
      },
      {
        method: 'POST',
        path: '/erps/{id}/endpoints',
        profile: 'editor',
        summary: 'Cadastra um endpoint no ERP.',
        params: [id('do ERP')],
        body: endpointBody,
        response: '{"id"}',
        errors: ['409: o ERP já tem um endpoint com esse nome'],
        audited: true,
      },
      {
        method: 'PUT',
        path: '/erp-endpoints/{id}',
        profile: 'editor',
        summary: 'Altera um endpoint.',
        params: [id('do endpoint')],
        body: endpointBody,
        response: ok,
        audited: true,
      },
      {
        method: 'DELETE',
        path: '/erp-endpoints/{id}',
        profile: 'editor',
        summary: 'Exclui um endpoint.',
        params: [id('do endpoint')],
        response: ok,
        errors: ['409: fluxos usam o endpoint (a mensagem diz quais)'],
        audited: true,
      },
      {
        method: 'POST',
        path: '/erps/{id}/clients',
        profile: 'editor',
        summary: 'Cadastra um cliente no ERP. Os segredos são guardados criptografados.',
        params: [id('do ERP')],
        body: erpClientBody,
        response: '{"id"}',
        errors: ['403: cliente sem acesso', '409: o cliente já está no ERP com esse label'],
        audited: true,
      },
      {
        method: 'PUT',
        path: '/erp-clients/{id}',
        profile: 'editor',
        summary: 'Altera o cadastro de um cliente no ERP.',
        params: [id('do cadastro')],
        body: erpClientBody,
        response: ok,
        errors: ['403: cliente sem acesso'],
        audited: true,
      },
      {
        method: 'DELETE',
        path: '/erp-clients/{id}',
        profile: 'editor',
        summary: 'Exclui o cadastro de um cliente no ERP.',
        params: [id('do cadastro')],
        response: ok,
        errors: ['409: fluxos usam o cadastro (a mensagem diz quais)'],
        audited: true,
      },
      {
        method: 'GET',
        path: '/api-catalog',
        profile: 'any',
        summary: 'O que o nó HTTP Request oferece no modo API cadastrada.',
        response: '{"clients": [{"id","erpId","erpName","clientName","label"}], "endpoints": [{"id","erpId","name","description","method","path","variables"}]}',
      },
    ],
  },
  {
    title: 'Administração',
    routes: [
      {
        method: 'GET',
        path: '/users',
        profile: 'admin',
        summary: 'Usuários.',
        response: '[{"id","email","name","role","active","locked_until","created_at","folder_ids","client_ids"}]',
      },
      {
        method: 'POST',
        path: '/users',
        profile: 'admin',
        summary: 'Cria um usuário.',
        body: userBody(true),
        response: 'O usuário criado, como em GET /users',
        errors: ['400: senha fraca ou ausente', '409: já existe um usuário com esse e-mail'],
        audited: true,
      },
      {
        method: 'PUT',
        path: '/users/{id}',
        profile: 'admin',
        summary: 'Altera um usuário. Desativar ou redefinir a senha derruba as sessões dele.',
        params: [id('do usuário')],
        body: userBody(false),
        response: 'O usuário salvo',
        errors: ['400: senha fraca, ou o administrador tirando o próprio acesso'],
        audited: true,
      },
      {
        method: 'POST',
        path: '/users/{id}/unlock',
        profile: 'admin',
        summary: 'Desbloqueia um usuário que errou a senha demais.',
        params: [id('do usuário')],
        response: ok,
        audited: true,
      },
      { method: 'GET', path: '/folders', profile: 'any', summary: 'Pastas que o usuário enxerga.', response: '[{"id","name"}]' },
      {
        method: 'POST',
        path: '/folders',
        profile: 'admin',
        summary: 'Cria uma pasta.',
        body: [{ name: 'name', type: 'texto', required: true, description: 'Nome (único)' }],
        response: '{"id","name"}',
        errors: ['409: já existe uma pasta com esse nome'],
        audited: true,
      },
      {
        method: 'PUT',
        path: '/folders/{id}',
        profile: 'admin',
        summary: 'Renomeia uma pasta.',
        params: [id('da pasta')],
        body: [{ name: 'name', type: 'texto', required: true, description: 'Nome novo' }],
        response: '{"id","name"}',
        audited: true,
      },
      {
        method: 'DELETE',
        path: '/folders/{id}',
        profile: 'admin',
        summary: 'Exclui uma pasta vazia.',
        params: [id('da pasta')],
        response: ok,
        errors: ['409: a pasta tem fluxos'],
        audited: true,
      },
      { method: 'GET', path: '/clients', profile: 'any', summary: 'Clientes que o usuário enxerga.', response: '[{"id","name","notes"}]' },
      {
        method: 'POST',
        path: '/clients',
        profile: 'admin',
        summary: 'Cria um cliente.',
        body: [
          { name: 'name', type: 'texto', required: true, description: 'Nome (único)' },
          { name: 'notes', type: 'texto', description: 'Observações' },
        ],
        response: '{"id","name","notes"}',
        errors: ['409: já existe um cliente com esse nome'],
        audited: true,
      },
      {
        method: 'PUT',
        path: '/clients/{id}',
        profile: 'admin',
        summary: 'Altera um cliente.',
        params: [id('do cliente')],
        body: [
          { name: 'name', type: 'texto', required: true, description: 'Nome' },
          { name: 'notes', type: 'texto', description: 'Observações' },
        ],
        response: '{"id","name","notes"}',
        audited: true,
      },
      {
        method: 'DELETE',
        path: '/clients/{id}',
        profile: 'admin',
        summary: 'Exclui um cliente sem conexões e sem cadastro em ERP.',
        params: [id('do cliente')],
        response: ok,
        errors: ['409: o cliente tem conexões ou está cadastrado em um ERP'],
        audited: true,
      },
      {
        method: 'GET',
        path: '/audit',
        profile: 'admin',
        summary: 'Registros da auditoria, mais novos primeiro.',
        query: [
          { name: 'entityType', type: 'texto', description: 'Tipo do registro (workflow, connection, user, api_token, execution…)' },
          { name: 'entityId', type: 'texto', description: 'ID do registro' },
          { name: 'userId', type: 'uuid', description: 'Quem fez' },
          from,
          to,
          { name: 'before', type: 'número', description: 'Para paginar: id da última linha recebida' },
          limit,
        ],
        response: '[{"id","at","action","entity_type","entity_id","entity_name","before","after","ip","user_name","user_email"}]',
      },
    ],
  },
];
