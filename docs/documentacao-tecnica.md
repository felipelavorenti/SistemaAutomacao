# Info8n: documentação técnica

> Cópia da documentação técnica publicada em https://claude.ai/code/artifact/df07d67b-3f8d-442b-90ea-252c386ddced. As duas versões são atualizadas juntas.

## Visão geral

O Info8n é uma plataforma de automação por fluxos de nós, no estilo do n8n, feita para substituir o n8n self-hosted com controle de usuários e logs completos. Ela roda em 3 containers Docker (app, Postgres e Redis), dentro da rede da empresa, e herda o acesso já liberado às APIs e aos bancos dos clientes.

A API grava cada execução no Postgres e a põe na fila do Redis. O worker pega da fila, roda o fluxo chamando os sistemas dos clientes e grava o resultado de volta no Postgres. Por padrão, API e worker rodam no mesmo processo Node.

## Tecnologias usadas

Tudo é TypeScript sobre Node 22. O banco é o PostgreSQL 16, e a fila usa o Redis 7. As versões abaixo são as do `package.json`. Entre parênteses, as que rodam hoje no computador do Felipe.

| Camada | Tecnologia | Versão | Para quê |
| --- | --- | --- | --- |
| Linguagem | TypeScript | 5.6 | Todo o código (motor, servidor e telas) |
| Runtime | Node.js | 22 (22.23.3) | Servidor, worker e build |
| Banco da plataforma | PostgreSQL | 16 (16.15) | Usuários, fluxos, versões, execuções, auditoria |
| Fila | Redis + BullMQ | 7 (7.4.11) + BullMQ 5.30 | Fila de execuções, agendamentos e cancelamento |
| API | Fastify | 5.2 | API HTTP e entrega das telas |
| Validação | Zod | 3.24 | Validação das requisições |
| Senhas | bcryptjs | 3.0 | Hash de senha (custo 12) |
| Agendamento | cron-parser | 5.0 | Validação das expressões cron |
| Expressões e Code JS | isolated-vm | 7.0 | Isolate V8 separado, com limite de memória e tempo |
| Code Python | Pyodide | 314.0 | Python 3 em WebAssembly, em processos separados |
| Bancos dos clientes | mssql, oracledb, pg | 12.7, 7.0, 8.23 | SQL Server, Oracle (modo thin, sem Instant Client) e Postgres |
| Telas | React | 19 | Interface |
| Editor de fluxos | @xyflow/react (React Flow) | 12.3 | Canvas de nós e ligações |
| Rotas das telas | react-router-dom | 7.1 | Navegação |
| Build das telas | Vite | 6.0 | Empacotamento |
| Testes | Vitest | 3.2 | Testes do motor e da API |
| Implantação | Docker + Docker Compose | Compose v2 ou superior | Sobe app, Postgres e Redis |

## Estrutura do código

O repositório [felipelavorenti/SistemaAutomacao](https://github.com/felipelavorenti/SistemaAutomacao) é um monorepo com npm workspaces e três pacotes. O motor não depende de banco nem de fila: o servidor o usa como biblioteca.

| Caminho | Pacote | Responsabilidade |
| --- | --- | --- |
| `packages/engine` | `@sa/engine` | Motor de execução, expressões, nós, drivers de banco, Python e importador do n8n |
| `apps/server` | `@sa/server` | API, autenticação, permissões, Postgres, fila, worker e auditoria |
| `apps/web` | `@sa/web` | Telas em React, incluindo o editor de fluxos |

**packages/engine/src**

- `executor.ts`: executa um fluxo nó a nó, com itens, tentativas, tempo limite e limite de execuções de nós.
- `nodes/`: um arquivo por grupo de nós, registrados em `registry.ts`. Exemplos: `http-request.ts`, `database.ts`, `flow.ts` (Loop, Stop and Error, Code, Chamado por outro fluxo, Execute Workflow), `data.ts` (Split Out, Aggregate, Merge), `edit-fields.ts`, `metabase.ts`, `clickup.ts`, `gmail.ts` (com o login do Google em `google.ts`), `triggers.ts`.
- `expressions/`: `template.ts` separa texto e `{{ }}`; `sandbox.ts` avalia no isolate V8.
- `python/runner.ts`: pool de processos com Pyodide para o nó Code em Python.
- `database/`: drivers de SQL Server, Oracle e Postgres, e parâmetros nomeados.
- `n8n/import.ts`: converte fluxos exportados do n8n.
- `validate.ts`: acha pendências no fluxo (gatilho ausente, campo obrigatório, expressão quebrada).
- `catalog.ts`: monta chamadas a partir das APIs cadastradas por ERP.

**apps/server/src**

- `index.ts`: sobe a API e, por padrão, o worker no mesmo processo. `worker-main.ts` roda só o worker.
- `config.ts`: lê as variáveis de ambiente.
- `api-reference.ts` e `api-examples.ts`: a referência da API e um exemplo de chamada e de resposta de cada rota. `api-markdown.ts` monta com eles a parte das rotas de `docs/api.md` (`npm run docs:api -w @sa/server`).
- `routes/`: `auth`, `workflows`, `executions`, `connections`, `oauth` (login com Google das conexões do Gmail), `catalog` (ERPs e clientes), `db-commands`, `admin` (usuários, pastas, clientes, auditoria).
- `executions/`: `queue.ts` (fila e agendamentos no BullMQ), `worker.ts` (roda as execuções), `store.ts` (grava resultado e dados comprimidos).
- `lib/`: `auth.ts` (senha, sessão, bloqueio), `permissions.ts` (perfis), `crypto.ts` (AES-256-GCM), `audit.ts`, `connection-types.ts`.
- `db/migrations.ts`: cria e atualiza as tabelas ao subir.

**apps/web/src**

- `App.tsx`: login, menu lateral e rotas.
- `pages/`: uma tela por item do menu (Fluxos, Execuções, Conexões, APIs dos ERPs, Comandos SQL, Clientes, Usuários, Pastas, Auditoria, Conta, Referência da API).
- `editor/`: `EditorPage.tsx` (canvas e paleta), `FlowNode.tsx` (desenho do nó), `NodePanel.tsx` (janela do nó), `ParameterField.tsx` (campos Fixo e Expressão).
- `components/`: `ui.tsx` (modal, tabelas, visualizador de JSON) e `icons.tsx` (ícones e marca Info8n).
- `api.ts`: chamadas à API e tipos. `styles.css`: cores do IPA e estilos.

## Motor de execução

Toda execução passa pela fila: a API grava a execução como "na fila", e um worker a pega, roda o motor e grava o resultado. Isso vale para execuções manuais, agendadas, reexecuções e subfluxos.

**Fila e worker**

- A fila é o BullMQ sobre o Redis. Cada fluxo ativo com gatilho Agendamento vira um agendador no Redis. `packages/engine/src/schedule.ts` (`scheduleRepeat`) converte os campos do nó: Todo dia, Toda semana e Todo mês viram cron de 6 campos (com segundos) no fuso do nó (padrão America/Sao\_Paulo); A cada intervalo vira `every` em milissegundos (segundos, minutos ou horas); Expressão cron aceita 5 ou 6 campos. Ao subir, o servidor refaz os agendadores a partir dos fluxos ativos do banco.
- A execução única (Uma vez, numa data e hora) não usa agendador: vira um job atrasado com id `once-{id do fluxo}`. Ao disparar, o worker desativa o fluxo (auditoria `deactivate` sem usuário) e roda a execução. Uma data que já passou não é agendada, nem quando o servidor volta depois do horário; ativar ou salvar um fluxo ativo com data passada é recusado.
- O worker roda até 5 execuções ao mesmo tempo (`WORKER_CONCURRENCY`). Por padrão ele roda no mesmo processo da API. Com `RUN_WORKER_IN_PROCESS=false`, sobe separado com `npm run start:worker -w @sa/server`, e podem existir vários.
- A fila não repete execuções que falham. Se o worker cair no meio, a execução é marcada como erro ("Execução interrompida"), sem rodar de novo sozinha.
- O cancelamento é avisado por um canal do Redis. O worker aborta a execução no nó em andamento.

**Como um fluxo roda**

- Os dados andam como lista de itens: cada nó recebe N itens e devolve N itens em uma ou mais saídas.
- Uma resposta vazia (sem corpo, 204 ou `[]`) não gera item, e os nós seguintes não rodam. A execução termina com sucesso.
- Subfluxos (Execute Workflow) viram execuções filhas, com até 10 níveis de fluxo chamando fluxo.

**Tentativas e limites**

| Limite | Valor padrão | Onde muda |
| --- | --- | --- |
| Tentativas por nó | 1 (desligado); ligado, 3 tentativas | Configurações do nó: "Tentar de novo quando falhar" |
| Espera entre tentativas | 1 s, crescendo a cada tentativa | Configurações do nó |
| Tempo limite de um nó | 120 s | Configurações do nó |
| Tempo limite do Metabase | 300 s | Configurações do nó |
| Tempo limite do Execute Workflow | 1 h | Configurações do nó |
| Execuções de nós por execução | 50.000 | Fixo; impede ciclo sem fim em Loop |
| Subfluxos um dentro do outro | 10 níveis | Fixo |
| Linhas de cursor (Oracle e Postgres) | 100.000 | Fixo |

**Isolamento do código do usuário**

- Expressões `{{ }}` e o nó Code em JavaScript rodam num isolate V8 separado (isolated-vm), com 64 MB de memória e 2 s por expressão. O código não enxerga o servidor, arquivos nem variáveis de ambiente.
- O Code em Python roda no Pyodide dentro de até 2 processos Node separados, com 512 MB cada, sem acesso a arquivos (só leitura do próprio Pyodide) nem a outros programas. Ele consegue abrir conexões de rede.
- Para quem vem do n8n, as expressões aceitam `.toJsonString()`. Recursos como `$now`, Luxon e `.toISO()` não existem, e o importador avisa onde aparecem.

## Banco de dados

A plataforma usa um Postgres próprio, com 16 tabelas criadas e atualizadas automaticamente ao subir (`db/migrations.ts`). Não há passo manual de migração.

| Tabela | Guarda |
| --- | --- |
| `users` | Usuários, perfil, hash da senha, tentativas erradas e bloqueio |
| `sessions` | Sessões de login (só o hash do token) |
| `api_tokens` | Tokens de API pessoais (só o hash) |
| `folders`, `user_folders` | Pastas de fluxos e quem acessa cada uma |
| `clients`, `user_clients` | Clientes e quem acessa cada um |
| `connections` | Conexões, com os segredos criptografados |
| `workflows` | Fluxos: definição em JSON, pasta, ativo, versão e ID de origem no n8n |
| `workflow_versions` | Uma versão por salvamento |
| `executions` | Execuções: modo, status, erro, resumo, dados comprimidos e execução pai |
| `db_commands` | Cada comando SQL executado nos bancos dos clientes |
| `audit_log` | Quem fez o quê, com antes e depois |
| `erps`, `erp_endpoints`, `erp_clients` | Catálogo de APIs por ERP e cadastro do cliente em cada ERP |

**Tamanho e retenção dos logs**

- Execuções agendadas que terminam com sucesso guardam só um resumo. Para guardar também os dados, use `KEEP_SUCCESS_DATA=true`.
- Execuções com erro, manuais e reexecuções guardam entrada e saída de cada nó, comprimidas com gzip.
- Cada nó guarda até 256 KB de dados, e cada execução até 16 MB. Acima disso fica só a contagem de itens.
- Comandos SQL guardam até 32 KB do texto e 8 KB dos parâmetros.
- Por padrão nada é apagado. Com `EXECUTION_RETENTION_DAYS` maior que 0, uma limpeza diária às 03:30 UTC (00:30 em Brasília) apaga execuções e comandos SQL mais antigos que esse número de dias.
- Referência medida: 24 execuções ocuparam 199 KB de dados comprimidos, e o banco inteiro tinha 9,3 MB.

## Segurança

O acesso é por login e senha, e cada perfil libera um conjunto de ações. Pastas e clientes limitam o que cada usuário enxerga.

**Autenticação**

- Senhas guardadas com bcrypt (custo 12). No primeiro acesso, o sistema obriga a trocar a senha.
- Depois de 5 senhas erradas, o usuário fica bloqueado por 15 minutos. Um administrador pode desbloquear antes.
- A sessão é um cookie `sa_session` (httpOnly, SameSite=Lax) que vale 12 horas (`SESSION_TTL_HOURS`). O banco guarda só o hash SHA-256 do token.
- Atrás de HTTPS, use `SECURE_COOKIES=true` para o cookie só trafegar criptografado.
- Tokens de API pessoais servem para chamar a API sem tela. O banco também guarda só o hash deles.

**Perfis**

| Perfil | Ver fluxos e execuções | Executar | Editar fluxos e conexões | Administrar |
| --- | --- | --- | --- | --- |
| Administrador | Sim | Sim | Sim | Sim |
| Editor | Sim | Sim | Sim | Não |
| Operador | Sim | Sim | Não | Não |
| Leitor | Sim | Não | Não | Não |

- Administrar = usuários, pastas, clientes e auditoria.
- O administrador vê todas as pastas e todos os clientes. Os outros perfis veem só as pastas e os clientes liberados para eles. Conexões sem cliente ficam visíveis para todos.

**Segredos das conexões**

- Senhas, tokens e chaves das conexões e dos clientes nos ERPs são criptografados com AES-256-GCM usando a `ENCRYPTION_KEY`.
- A API nunca devolve esses segredos para as telas.
- Sem a mesma `ENCRYPTION_KEY`, as conexões salvas não podem ser lidas. Guarde-a junto com o backup do banco.

**Login com Google (Gmail)**

As conexões do tipo `gmailOAuth2` usam OAuth 2.0 com o app que a empresa cria no Google Cloud (passo a passo no manual de uso, em Conectar o Gmail).

1. A tela chama `POST /api/connections/{id}/oauth/google/start`, que devolve o endereço do Google com `access_type=offline`, `prompt=consent` e o escopo `https://www.googleapis.com/auth/gmail.modify` (ler, enviar, rascunhos, etiquetas e lixeira; não apaga de vez).
2. O `state` leva a conexão, o usuário, o endereço de retorno e a validade (15 minutos), assinados com HMAC-SHA256 pela `ENCRYPTION_KEY`. Por isso o retorno `GET /api/oauth/google/callback` é público: ele confere a assinatura, carrega o usuário do state e exige que ele ainda possa editar conexões e enxergar o cliente da conexão.
3. O servidor troca o código pelo refresh token em `oauth2.googleapis.com/token`, lê o e-mail da conta em `/gmail/v1/users/me/profile` e grava os dois na conexão (`oauthRefreshToken` e `oauthAccount`), criptografados como os outros campos. A auditoria registra a ação `connect`, com a conta antes e depois, sem o token.
4. O endereço de retorno é `PUBLIC_URL` + `/api/oauth/google/callback` quando `PUBLIC_URL` existe. Sem ela, é o endereço pelo qual a tela foi aberta, com IP trocado por `localhost`, porque o Google não aceita IP. Nesse caso a tela mostra um campo para colar o endereço da página de retorno, enviado para `POST /api/connections/{id}/oauth/google/complete`.
5. Na execução, o nó Gmail troca o refresh token por um access token (1 hora) e o guarda em memória no worker até 5 minutos antes de vencer. `invalid_grant` vira a mensagem pedindo para conectar de novo.
6. A API devolve só `oauthAccount`; o refresh token nunca sai do servidor. Salvar a conexão mantém a autorização enquanto o Client ID não muda.

**Auditoria**

- A tabela `audit_log` registra quem criou, alterou, ativou, desativou, excluiu ou executou cada coisa, com IP, antes e depois, sem os segredos.
- Cada comando SQL executado nos bancos dos clientes fica em `db_commands`, com cliente, conexão, fluxo, nó, quem disparou, parâmetros, linhas, duração e erro.

## API para outros sistemas

Tudo o que a tela faz passa por uma API HTTP em JSON, e outro sistema pode usar a mesma API com um token de API. A [documentação da API](https://claude.ai/code/artifact/80ceb5b2-a2ea-4297-abe8-73dad394d2b9) (no repositório, `docs/api.md`) traz a autenticação, os perfis, os erros, os limites, um guia para disparar um fluxo e pegar o resultado, e cada rota com os parâmetros, um exemplo de chamada e um exemplo de resposta.

**Como a referência é mantida**

- `apps/server/src/api-reference.ts` descreve cada rota: método, caminho, perfil, parâmetros, erros e o que a resposta traz. `apps/server/src/api-examples.ts` guarda um exemplo de chamada e de resposta por rota, tirado de chamadas reais.
- A referência aparece em três lugares, todos gerados desses arquivos: no menu Referência da API do Info8n (`/referencia-api`), em JSON em `GET /api/docs` e na parte das rotas de `docs/api.md`.
- O teste `apps/server/test/api-reference.test.ts` falha quando uma rota existe sem estar na referência, quando algo documentado não existe mais, quando um campo fica sem descrição, quando uma rota fica sem exemplo ou o exemplo usa um campo não descrito, e quando `docs/api.md` fica diferente da referência.
- Ao criar ou mudar uma rota: atualize os dois arquivos, rode `npm run docs:api -w @sa/server` e leve a mesma mudança para a documentação da API publicada.

## Recursos necessários e requisitos mínimos

Uma máquina com 2 vCPU, 4 GB de RAM e 10 GB livres em disco deve comportar os 74 fluxos agendados e 15 subfluxos previstos. No teste de carga com 70 fluxos ao mesmo tempo (limite de 70 simultâneos), o app chegou a cerca de 1,2 GB e 4 a 6 núcleos no caso pesado; com o limite padrão de 5, ficou em cerca de 250 MB. Parada, a plataforma usa cerca de 125 MB de RAM. O restante é margem para as execuções, que sobem com Code em Python, expressões e respostas grandes de API.

| Recurso | Mínimo | Recomendado | Observação |
| --- | --- | --- | --- |
| CPU | 2 vCPU | 4 vCPU | Até 5 execuções em paralelo por padrão |
| RAM | 2 GB | 4 GB | Parado: app 75 MB, Postgres 41 MB, Redis 6 MB. Cada processo Python pode chegar a 512 MB |
| Disco livre | 5 GB | 10 GB ou mais | Imagens Docker \~1,5 GB; o primeiro build usa \~4,5 GB com cache. O banco cresce com as execuções guardadas |
| Sistema | Linux com Docker, ou Windows 10/11 com Docker Desktop e WSL 2 | Linux (servidor) | Testado no Windows 11 Pro com Docker Desktop 4.93 e WSL 2 |
| Docker | Docker Engine com Compose v2 | Versão atual | Sobe 3 containers: app, postgres e redis |
| Rede | Acesso às APIs e aos bancos dos clientes | A mesma rede do n8n atual | A plataforma herda os acessos já liberados; não tem túnel nem VPN embutidos |
| Porta | 3000 liberada para os usuários | Atrás de um proxy com HTTPS | Com HTTPS, ligue `SECURE_COOKIES=true` |
| Navegador | Chrome ou Edge 111+, Firefox 121+ | Chrome ou Edge atuais | Telas usam CSS moderno |

**Medido na instalação de teste** (6 fluxos, 24 execuções, cerca de 2 horas de uso): imagem do app 680 MB, postgres:16 642 MB, redis:7 170 MB; banco com 9,3 MB; volumes com 50 MB.

**Bancos dos clientes**

- SQL Server, Oracle e Postgres são acessados direto pela rede. Não precisa instalar cliente nativo: o Oracle usa o modo thin do driver `oracledb`, sem Oracle Instant Client.
- O Python do nó Code vem dentro da imagem (Pyodide). O servidor não precisa de Python instalado.

## Instalação, configuração e atualização

A instalação é um `docker compose up`. O container do app compila tudo no build e, ao subir, cria as tabelas e o primeiro administrador.

**Instalar**

1. Instale o Docker. No Windows, instale o WSL 2 (`wsl --install`) antes do Docker Desktop.
2. Baixe o código: `git clone https://github.com/felipelavorenti/SistemaAutomacao.git` e entre na pasta.
3. Copie `.env.example` para `.env` e preencha as variáveis obrigatórias (tabela abaixo).
4. Rode `docker compose up -d --build`.
5. Acesse `http://<servidor>:3000` com `ADMIN_EMAIL` e `ADMIN_PASSWORD`. O sistema pede uma senha nova no primeiro acesso.
6. Confira a saúde em `http://<servidor>:3000/api/health`, que responde `{"ok":true}`.

**Variáveis do .env**

| Variável | Obrigatória | Padrão | Para quê |
| --- | --- | --- | --- |
| `POSTGRES_PASSWORD` | Sim |  | Senha do Postgres do compose |
| `ENCRYPTION_KEY` | Sim |  | 32 bytes (64 caracteres hex); gere com `openssl rand -hex 32`. Criptografa as conexões |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Sim, na primeira subida |  | Primeiro administrador, criado só com o banco vazio |
| `ADMIN_NAME` | Não | Administrador | Nome do primeiro administrador |
| `PORT` | Não | 3000 | Porta da aplicação |
| `SESSION_TTL_HOURS` | Não | 12 | Duração do login |
| `EXECUTION_RETENTION_DAYS` | Não | 0 (guarda sempre) | Dias que execuções e comandos SQL ficam guardados |
| `KEEP_SUCCESS_DATA` | Não | false | Guarda dados também das agendadas com sucesso |
| `WORKER_CONCURRENCY` | Não | 5 | Execuções em paralelo por worker |
| `RUN_WORKER_IN_PROCESS` | Não | true | false = worker em processo separado |
| `SECURE_COOKIES` | Não | false | true quando estiver atrás de HTTPS |
| `PUBLIC_URL` | Não | endereço aberto na tela | Endereço pelo qual o Info8n é acessado (ex.: `http://info8n.empresa.local:3000`). Define o endereço de retorno do login com Google; precisa ser localhost ou um domínio, não IP |

`DATABASE_URL` e `REDIS_URL` são montadas pelo `docker-compose.yml`. Só precisam ser definidas quando a plataforma roda fora do Docker.

**Atualizar**

1. `git pull` na pasta do projeto.
2. `docker compose up -d --build`. Só o container do app é refeito; banco e Redis continuam com os dados.
3. Recarregue a tela com Ctrl+F5.

**Backup**

- Os dados ficam nos volumes `postgres-data` e `redis-data`. O essencial é o Postgres: `docker compose exec postgres pg_dump -U automacao automacao > backup.sql`.
- Guarde a `ENCRYPTION_KEY` junto com o backup. Sem ela, as conexões restauradas não abrem.

**Windows: problemas vistos na instalação de teste**

- Se o Docker Desktop abrir antes do WSL 2, ele trava numa tela de erro "wsl is not installed". Reinicie o Docker Desktop depois que o WSL subir.
- Na instalação por usuário, o `docker.exe` não entra no PATH. Ele fica em `C:\Users\<usuário>\AppData\Local\Programs\DockerDesktop\resources\bin`.

## Desenvolvimento, testes e CI

Para desenvolver fora do Docker são precisos Node 22, Postgres 16 e Redis 7. Cada mudança entra por pull request, e o CI roda os testes e o build da imagem antes do merge.

**Rodar local**

1. `npm install`
2. `npm run build -w @sa/engine`
3. Com as variáveis do `.env.example`, e `DATABASE_URL` e `REDIS_URL` apontando para o seu ambiente: `npm run dev:server` (porta 3000).
4. Em outro terminal: `npm run dev:web` (porta 5173, com recarga automática e `/api` repassado para a 3000).

**Testes**

- `npm run build && npm test` roda os testes do motor e da API (Vitest).
- Os testes da API usam um banco próprio, `TEST_DATABASE_URL` (padrão `postgres://postgres@127.0.0.1:5432/automacao_test`), e apagam tudo nele a cada rodada. Sem Postgres, são pulados.
- Os testes com SQL Server, Oracle e Metabase de verdade só rodam com `TEST_MSSQL_HOST`, `TEST_ORACLE_CONNECT` e `TEST_METABASE_URL` definidos.
- `npm run typecheck` confere os tipos dos três pacotes.

**CI (GitHub Actions)**

O arquivo `.github/workflows/ci.yml` tem dois jobs em cada pull request:

- `test`: sobe Postgres 16, Redis 7, SQL Server 2022, Oracle Free 23 e Metabase como serviços e roda todos os testes.
- `docker`: faz o build da imagem do `Dockerfile`.

**Imagem Docker**

- Build em duas etapas sobre `node:22-bookworm-slim`. A primeira instala `python3`, `make` e `g++` para compilar o isolated-vm, e roda `npm run build`.
- A imagem final leva só o `node_modules` de produção e os `dist` dos três pacotes, e roda como o usuário `node` na porta 3000.
