import { API_EXAMPLES } from './api-examples.js';
import { formatJson } from './lib/format-json.js';

/**
 * Referência de todas as chamadas da API, mostrada na tela "Referência da API"
 * (GET /api/docs) e em docs/api.md. O teste test/api-reference.test.ts falha
 * quando uma rota existe sem estar aqui ou sem exemplo em api-examples.ts,
 * quando algo daqui não existe mais, ou quando docs/api.md ficou para trás
 * (atualize com npm run docs:api -w @sa/server).
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
  /** Explicação da resposta, quando o exemplo sozinho não basta. */
  response?: string;
  /** Erros próprios da chamada, além dos comuns (401, 403 de perfil, 400 de dados inválidos). */
  errors?: string[];
  /** Grava na auditoria quem fez, quando, o IP e, nas alterações, o antes e o depois. */
  audited?: boolean;
  /** Exemplo de chamada e de resposta, vindo de api-examples.ts. */
  example?: ApiExample;
}

/** Uma chamada de verdade e o que o servidor respondeu (status 200). */
export interface ApiExample {
  /** Caminho usado, depois de /api, com IDs e filtros. Sem ele, vale o path da rota. */
  path?: string;
  /** Corpo JSON enviado. */
  body?: unknown;
  response: unknown;
  /** Observação sobre o exemplo, como uma lista encurtada. */
  note?: string;
  /** Usa o cookie da tela em vez do token: save guarda o cookie do login, send manda o cookie guardado. */
  session?: 'save' | 'send';
  /** Comando curl do exemplo; API_REFERENCE monta a partir dos outros campos. */
  curl?: string;
}

export interface ApiGroup {
  title: string;
  routes: ApiRoute[];
}

const id = (what: string): ApiField => ({ name: 'id', type: 'uuid', required: true, description: `ID ${what}` });
const limit: ApiField = { name: 'limit', type: 'número', description: 'Quantas linhas devolver, de 1 a 200 (padrão 50)' };
const from: ApiField = { name: 'from', type: 'data e hora', description: 'A partir de quando, com fuso (ex.: 2026-09-30T00:00:00-03:00)' };
const to: ApiField = { name: 'to', type: 'data e hora', description: 'Até quando, com fuso' };

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
  { name: 'type', type: 'texto', required: true, description: 'Tipo, como devolvido por GET /connection-types (ex.: postgres, mssql)' },
  { name: 'clientId', type: 'uuid ou null', description: 'Cliente dono da conexão; null para uma conexão sem cliente' },
  {
    name: 'data',
    type: 'objeto',
    required: true,
    description: 'Campos do tipo, com os valores em texto (ex.: "port": "5432"). Segredo em branco ao alterar mantém o valor salvo',
  },
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
  {
    name: 'values',
    type: 'objeto',
    required: true,
    description: 'Valores dos campos do ERP, em texto (ex.: "porta": "8080"). Segredo em branco ao alterar mantém o valor salvo',
  },
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

const GROUPS: ApiGroup[] = [
  {
    title: 'Conta e tokens',
    routes: [
      { method: 'GET', path: '/health', profile: 'public', summary: 'Diz se o servidor está no ar.' },
      {
        method: 'GET',
        path: '/docs',
        profile: 'any',
        summary: 'Esta referência, em JSON.',
        response: 'A mesma lista de rotas desta referência, com os parâmetros, os exemplos e os erros de cada uma.',
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
        response:
          'O cookie sa_session vem no header Set-Cookie e vale SESSION_TTL_HOURS (12 horas por padrão). Mande-o nas chamadas seguintes no lugar do token.',
        errors: ['401: e-mail ou senha errados, usuário inativo ou bloqueado. 5 senhas erradas seguidas bloqueiam por 15 minutos'],
        audited: true,
      },
      { method: 'POST', path: '/auth/logout', profile: 'any', summary: 'Encerra a sessão do cookie.' },
      {
        method: 'GET',
        path: '/auth/me',
        profile: 'any',
        summary: 'Usuário dono da sessão ou do token.',
        response:
          'permissions resume o que o perfil permite: editar fluxos, disparar fluxos, editar conexões e administrar. mustChangePassword true quer dizer que a senha inicial ainda não foi trocada.',
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
        errors: ['400: senha atual incorreta ou senha nova fraca'],
        audited: true,
      },
      {
        method: 'GET',
        path: '/auth/tokens',
        profile: 'any',
        summary: 'Tokens de API do próprio usuário.',
        response: 'last_used_at é a hora da última chamada feita com o token (null se ele ainda não foi usado). O token em si nunca volta.',
      },
      {
        method: 'POST',
        path: '/auth/tokens',
        profile: 'any',
        summary: 'Cria um token de API. Ele age como o usuário que o criou e não expira.',
        body: [{ name: 'name', type: 'texto', required: true, description: 'Nome do token, até 100 caracteres (ex.: ERP interno)' }],
        response: 'O token só aparece nesta resposta; guarde-o. O Info8n guarda apenas o hash dele.',
        audited: true,
      },
      {
        method: 'DELETE',
        path: '/auth/tokens/{id}',
        profile: 'any',
        summary: 'Revoga um token do próprio usuário. Ele para de funcionar na hora.',
        params: [id('do token')],
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
          'scheduled diz se o fluxo tem gatilho de agendamento, e callable, se pode ser chamado como subfluxo (começa pelo gatilho Chamado por outro fluxo). last_execution é a execução mais recente, ou null se o fluxo nunca rodou.',
      },
      {
        method: 'GET',
        path: '/workflows/{id}',
        profile: 'any',
        summary: 'Fluxo completo.',
        params: [id('do fluxo')],
        response:
          'definition traz os nós e as ligações do fluxo. issues lista os problemas encontrados na validação; com algum problema, o fluxo não pode ser ativado.',
        errors: ['404: não existe ou está numa pasta sem acesso'],
      },
      {
        method: 'POST',
        path: '/workflows',
        profile: 'editor',
        summary: 'Cria um fluxo. Sem definition, ele nasce só com o Gatilho manual.',
        body: workflowBody(false),
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
        response: 'O fluxo salvo, com a version nova e os issues da validação.',
        errors: [
          '400: fluxo ativo com problemas, agendamento inválido (horário, dias, cron) ou execução única com data que já passou, conexão ou subfluxo que não existe, ou o fluxo chama ele mesmo',
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
        errors: ['400: outros fluxos chamam este como subfluxo (a mensagem diz quais)'],
        audited: true,
      },
      {
        method: 'POST',
        path: '/workflows/{id}/activate',
        profile: 'editor',
        summary: 'Liga o agendamento do fluxo.',
        params: [id('do fluxo')],
        errors: ['400: o fluxo não tem gatilho de agendamento, tem problemas, o agendamento é inválido ou a data da execução única já passou'],
        audited: true,
      },
      {
        method: 'POST',
        path: '/workflows/{id}/deactivate',
        profile: 'editor',
        summary: 'Desliga o agendamento do fluxo.',
        params: [id('do fluxo')],
        audited: true,
      },
      {
        method: 'POST',
        path: '/workflows/{id}/duplicate',
        profile: 'editor',
        summary: 'Cria uma cópia "(cópia)" na mesma pasta, desativada.',
        params: [id('do fluxo')],
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
        response: 'Use o executionId em GET /executions/{id} para acompanhar a execução e pegar o resultado.',
        errors: ['404: o fluxo não existe ou está numa pasta sem acesso'],
      },
      {
        method: 'GET',
        path: '/workflows/{id}/callers',
        profile: 'any',
        summary: 'Fluxos que chamam este como subfluxo.',
        params: [id('do fluxo')],
      },
      {
        method: 'GET',
        path: '/workflows/{id}/versions',
        profile: 'any',
        summary: 'Últimas 200 versões salvas do fluxo.',
        params: [id('do fluxo')],
        response: 'Da versão mais nova para a mais antiga.',
      },
      {
        method: 'GET',
        path: '/workflows/{id}/versions/{version}',
        profile: 'any',
        summary: 'Uma versão salva do fluxo.',
        params: [id('do fluxo'), { name: 'version', type: 'número', required: true, description: 'Número da versão' }],
        errors: ['404: versão não existe'],
      },
      {
        method: 'GET',
        path: '/workflows/{id}/export',
        profile: 'any',
        summary: 'Arquivo de exportação do fluxo, o mesmo que a tela baixa.',
        params: [id('do fluxo')],
        response: 'O mesmo JSON, com o folderId da pasta de destino, serve de corpo para POST /workflows/import.',
      },
      {
        method: 'POST',
        path: '/workflows/import',
        profile: 'editor',
        summary: 'Importa um fluxo exportado. Ele entra desativado.',
        body: workflowBody(true),
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
        response:
          'Uma linha por fluxo do arquivo. status é imported, ou skipped quando o fluxo já tinha sido importado antes (id é o do fluxo que já existe). wasActive diz se ele estava ativo no n8n, e warnings lista, por nó, o que precisa de ajuste.',
        errors: ['400: o arquivo não é uma exportação do n8n'],
        audited: true,
      },
      {
        method: 'GET',
        path: '/node-types',
        profile: 'any',
        summary: 'Tipos de nó disponíveis no editor, com os parâmetros de cada um.',
        response:
          'Cada item de properties é um parâmetro do nó: name é a chave dele em parameters, na definição do fluxo, e showWhen diz de quais outros parâmetros ele depende para aparecer.',
      },
      {
        method: 'POST',
        path: '/expressions/preview',
        profile: 'editor',
        summary: 'Calcula uma expressão como a prévia do editor.',
        body: [
          {
            name: 'value',
            type: 'texto',
            required: true,
            description: 'Texto começando com =, como no modo Expressão (ex.: =Total: {{ $json.preco }}). Sem o =, volta o texto como está',
          },
          { name: 'input', type: 'lista', description: 'Itens de entrada: [{"json": {...}}]' },
          { name: 'nodeOutputs', type: 'objeto', description: 'Saída de cada nó pelo nome, para $node["Nome"]' },
          { name: 'itemIndex', type: 'número', description: 'Item usado como $json (padrão 0)' },
        ],
        response: 'Volta {"result"} com o valor calculado ou, se a expressão falhar, {"error"} com o motivo, também com status 200.',
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
          'duration_ms é quanto a execução levou, em milissegundos (null enquanto não termina). data_size é o tamanho dos dados guardados, compactados, em bytes (null quando não foram guardados).',
      },
      {
        method: 'GET',
        path: '/executions/waiting',
        profile: 'any',
        summary: 'Fluxos agendados que já deviam ter começado e esperam vaga no worker.',
        response: 'dueAt é quando o fluxo devia ter começado. A lista vem vazia quando nenhum fluxo está esperando.',
      },
      {
        method: 'GET',
        path: '/executions/{id}',
        profile: 'any',
        summary: 'Execução completa, com os dados de cada nó. Consulte até status sair de queued ou running.',
        params: [id('da execução')],
        response:
          'runs traz um item por nó executado, na ordem em que rodaram; input e output são listas por entrada e por saída do nó, cada uma com itens {"json": {...}}. O resultado do fluxo é a saída do último nó executado, runs[-1].output[0]. Quando a entrada e a saída de um nó passam de 256 KB juntas, os itens dele vêm trocados por {"_truncado": true, "itens", "bytes"}. runs vem null quando os dados não foram guardados: execução com sucesso agendada ou de subfluxo, com KEEP_SUCCESS_DATA desligado (o padrão). summary resume cada nó sem os dados, e children lista os subfluxos chamados.',
        errors: ['404: não existe ou é de um fluxo numa pasta sem acesso'],
      },
      {
        method: 'POST',
        path: '/executions/{id}/cancel',
        profile: 'operator',
        summary: 'Cancela uma execução na fila ou em andamento.',
        params: [id('da execução')],
        errors: ['400: a execução já terminou'],
        audited: true,
      },
      {
        method: 'POST',
        path: '/executions/{id}/retry',
        profile: 'operator',
        summary: 'Roda de novo com a mesma definição e a mesma entrada.',
        params: [id('da execução')],
        response: 'executionId é a nova execução, com mode retry e retry_of apontando para a original.',
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
          'id vem como texto; para a próxima página, mande o id da última linha em beforeId. params são os valores usados no SQL, rows é quantas linhas a consulta devolveu e rows_affected, quantas o comando alterou (null numa consulta).',
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
        response:
          'Campos com secret true são guardados criptografados e o valor deles nunca volta. options, quando existe, lista os valores aceitos. oauth: "google" marca os tipos conectados pelo login com Google (Gmail), que além dos campos precisam de POST /connections/{id}/oauth/google/start.',
      },
      {
        method: 'GET',
        path: '/connections',
        profile: 'any',
        summary: 'Conexões sem cliente e as dos clientes que o usuário enxerga. Segredos nunca voltam.',
        response:
          'Em data, os campos secretos vêm como •••••• quando estão preenchidos e vazios quando não estão. Nas conexões do Gmail, data.oauthAccount é o e-mail da conta do Google conectada, ou vazio enquanto ninguém clicou em Conectar com Google.',
      },
      {
        method: 'GET',
        path: '/connections/{id}',
        profile: 'any',
        summary: 'Uma conexão, sem os segredos.',
        params: [id('da conexão')],
        errors: ['404: não existe ou é de um cliente sem acesso'],
      },
      {
        method: 'GET',
        path: '/connections/{id}/usage',
        profile: 'any',
        summary: 'Fluxos que usam a conexão.',
        params: [id('da conexão')],
      },
      {
        method: 'POST',
        path: '/connections',
        profile: 'editor',
        summary: 'Cria uma conexão. Os segredos são guardados criptografados.',
        body: connectionBody,
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
        errors: ['400: troca de tipo ou campo obrigatório vazio', '403: cliente sem acesso'],
        audited: true,
      },
      {
        method: 'DELETE',
        path: '/connections/{id}',
        profile: 'editor',
        summary: 'Exclui uma conexão.',
        params: [id('da conexão')],
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
        response:
          'Uma falha no teste também volta com status 200, com ok false e o motivo em message (ex.: database "nao_existe" does not exist).',
        errors: ['400: o tipo é testado no próprio nó, ou falta campo obrigatório'],
      },
      {
        method: 'GET',
        path: '/oauth/google/redirect-uri',
        profile: 'any',
        summary: 'Endereço de retorno que precisa estar cadastrado no app OAuth do Google Cloud para o login com Google das conexões do Gmail.',
        response:
          'Vem de PUBLIC_URL quando a variável existe. Sem ela, usa o endereço pelo qual o Info8n foi aberto, trocando IP por localhost, porque o Google só aceita retorno para localhost ou para um domínio.',
      },
      {
        method: 'POST',
        path: '/connections/{id}/oauth/google/start',
        profile: 'editor',
        summary: 'Começa o login com Google de uma conexão do Gmail já salva: devolve o endereço do Google onde a pessoa autoriza o acesso.',
        params: [id('da conexão')],
        response:
          'Abra url no navegador. O pedido vale 15 minutos e só pode ser concluído pelo mesmo usuário. Depois de autorizar, o Google manda o navegador para redirectUri.',
        errors: [
          '400: a conexão não usa login com Google, ou falta salvar o client ID e o client secret',
          '404: não existe ou é de um cliente sem acesso',
        ],
      },
      {
        method: 'POST',
        path: '/connections/{id}/oauth/google/complete',
        profile: 'editor',
        summary:
          'Conclui o login com Google colando o endereço da página para onde o Google mandou. Serve quando o Info8n é aberto por IP e o retorno foi para localhost, onde ele não roda.',
        params: [id('da conexão')],
        body: [
          {
            name: 'url',
            type: 'texto',
            required: true,
            description: 'Endereço completo da página de retorno, com code e state (ex.: http://localhost:3000/api/oauth/google/callback?state=...&code=...)',
          },
        ],
        response: 'account é o e-mail da conta do Google conectada. O acesso fica guardado criptografado na conexão e nunca volta pela API.',
        errors: [
          '400: endereço sem code e state, pedido vencido ou de outra conexão, autorização cancelada, ou o Google não aceitou o código (a mensagem traz o motivo)',
          '403: o pedido foi começado por outro usuário',
        ],
        audited: true,
      },
      {
        method: 'GET',
        path: '/oauth/google/callback',
        profile: 'public',
        summary:
          'Retorno do Google depois da autorização. Quem chama é o navegador, sem sessão: a conexão e o usuário vêm do state assinado. Grava o acesso na conexão e volta para a tela de conexões.',
        query: [
          { name: 'code', type: 'texto', description: 'Código da autorização, enviado pelo Google' },
          { name: 'state', type: 'texto', description: 'Pedido assinado criado por POST /connections/{id}/oauth/google/start' },
          { name: 'error', type: 'texto', description: 'Enviado pelo Google quando a autorização falha ou é cancelada (ex.: access_denied)' },
        ],
        response:
          'Responde com redirecionamento (302) para /conexoes?google=ok&conexao={id}&conta={e-mail}, ou para /conexoes?google=erro&mensagem={motivo} quando algo falha.',
        audited: true,
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
        response: 'endpoints e clients são quantos endpoints e quantos clientes o ERP tem.',
      },
      {
        method: 'GET',
        path: '/erps/{id}',
        profile: 'any',
        summary: 'Um ERP com os endpoints e os clientes cadastrados nele (só os clientes que o usuário enxerga, sem os segredos).',
        params: [id('do ERP')],
        response: 'Nos clientes, os valores dos campos secretos vêm como ••••••.',
      },
      {
        method: 'POST',
        path: '/erps',
        profile: 'editor',
        summary: 'Cadastra um ERP.',
        body: erpBody,
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
        audited: true,
      },
      {
        method: 'DELETE',
        path: '/erps/{id}',
        profile: 'editor',
        summary: 'Exclui um ERP e os endpoints dele.',
        params: [id('do ERP')],
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
        audited: true,
      },
      {
        method: 'DELETE',
        path: '/erp-endpoints/{id}',
        profile: 'editor',
        summary: 'Exclui um endpoint.',
        params: [id('do endpoint')],
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
        errors: ['403: cliente sem acesso'],
        audited: true,
      },
      {
        method: 'DELETE',
        path: '/erp-clients/{id}',
        profile: 'editor',
        summary: 'Exclui o cadastro de um cliente no ERP.',
        params: [id('do cadastro')],
        errors: ['409: fluxos usam o cadastro (a mensagem diz quais)'],
        audited: true,
      },
      {
        method: 'GET',
        path: '/api-catalog',
        profile: 'any',
        summary: 'O que o nó HTTP Request oferece no modo API cadastrada.',
        response:
          'clients são os cadastros de clientes nos ERPs e endpoints, os endpoints de todos os ERPs, ligados pelo erpId. Endpoints que usam a autenticação do ERP (bearer ou header) ganham a variável token, que recebe o token do nó de login.',
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
        response:
          'locked_until é até quando o usuário fica bloqueado por errar a senha (null se não está bloqueado). Para administradores, folder_ids e client_ids vêm vazios, porque eles enxergam tudo.',
      },
      {
        method: 'POST',
        path: '/users',
        profile: 'admin',
        summary: 'Cria um usuário.',
        body: userBody(true),
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
        errors: ['400: senha fraca, ou o administrador tirando o próprio acesso'],
        audited: true,
      },
      {
        method: 'POST',
        path: '/users/{id}/unlock',
        profile: 'admin',
        summary: 'Desbloqueia um usuário que errou a senha demais.',
        params: [id('do usuário')],
        audited: true,
      },
      { method: 'GET', path: '/folders', profile: 'any', summary: 'Pastas que o usuário enxerga.' },
      {
        method: 'POST',
        path: '/folders',
        profile: 'admin',
        summary: 'Cria uma pasta.',
        body: [{ name: 'name', type: 'texto', required: true, description: 'Nome (único)' }],
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
        audited: true,
      },
      {
        method: 'DELETE',
        path: '/folders/{id}',
        profile: 'admin',
        summary: 'Exclui uma pasta vazia.',
        params: [id('da pasta')],
        errors: ['409: a pasta tem fluxos'],
        audited: true,
      },
      { method: 'GET', path: '/clients', profile: 'any', summary: 'Clientes que o usuário enxerga.' },
      {
        method: 'POST',
        path: '/clients',
        profile: 'admin',
        summary: 'Cria um cliente.',
        body: [
          { name: 'name', type: 'texto', required: true, description: 'Nome (único)' },
          { name: 'notes', type: 'texto', description: 'Observações' },
        ],
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
        audited: true,
      },
      {
        method: 'DELETE',
        path: '/clients/{id}',
        profile: 'admin',
        summary: 'Exclui um cliente sem conexões e sem cadastro em ERP.',
        params: [id('do cliente')],
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
        response:
          'before e after são o registro antes e depois da mudança, sem os segredos. id vem como texto; para a próxima página, mande o id da última linha em before.',
      },
    ],
  },
];

/** A referência completa: cada rota com o exemplo de api-examples.ts e o comando curl dele. */
export const API_REFERENCE: ApiGroup[] = GROUPS.map((group) => ({
  ...group,
  routes: group.routes.map((route) => {
    const example = API_EXAMPLES[`${route.method} ${route.path}`];
    return example ? { ...route, example: { ...example, curl: curlCommand(route, example) } } : route;
  }),
}));

/** Comando curl do exemplo, com $INFO8N no lugar do endereço do servidor e $TOKEN no lugar do token. */
export function curlCommand(route: ApiRoute, example: ApiExample): string {
  const url = `"$INFO8N/api${example.path ?? route.path}"`;
  const parts = [route.method === 'GET' ? `curl ${url}` : `curl -X ${route.method} ${url}`];
  if (example.session === 'send') parts.push('-b cookies.txt');
  else if (route.profile !== 'public') parts.push('-H "Authorization: Bearer $TOKEN"');
  if (example.body !== undefined) {
    parts.push('-H "Content-Type: application/json"', `-d '${formatJson(example.body, 90).replaceAll("'", "'\\''")}'`);
  }
  if (example.session === 'save') parts.push('-c cookies.txt');
  return parts.join(' \\\n  ');
}
