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
- `nodes/`: um arquivo por grupo de nós, registrados em `registry.ts`. Exemplos: `http-request.ts`, `database.ts`, `flow.ts` (Loop, Stop and Error, Code, Chamado por outro fluxo, Execute Workflow), `data.ts` (Split Out, Aggregate, Merge), `edit-fields.ts`, `metabase.ts`, `clickup.ts`, `triggers.ts`.
- `expressions/`: `template.ts` separa texto e `{{ }}`; `sandbox.ts` avalia no isolate V8.
- `python/runner.ts`: pool de processos com Pyodide para o nó Code em Python.
- `database/`: drivers de SQL Server, Oracle e Postgres, e parâmetros nomeados.
- `n8n/import.ts`: converte fluxos exportados do n8n.
- `validate.ts`: acha pendências no fluxo (gatilho ausente, campo obrigatório, expressão quebrada).
- `catalog.ts`: monta chamadas a partir das APIs cadastradas por ERP.

**apps/server/src**

- `index.ts`: sobe a API e, por padrão, o worker no mesmo processo. `worker-main.ts` roda só o worker.
- `config.ts`: lê as variáveis de ambiente.
- `routes/`: `auth`, `workflows`, `executions`, `connections`, `catalog` (ERPs e clientes), `db-commands`, `admin` (usuários, pastas, clientes, auditoria).
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

- A fila é o BullMQ sobre o Redis. Cada fluxo ativo com gatilho Agendamento vira um agendador no Redis, por intervalo ou por cron com fuso (padrão America/Sao\_Paulo). Ao subir, o servidor refaz os agendadores a partir dos fluxos ativos do banco.
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

**Auditoria**

- A tabela `audit_log` registra quem criou, alterou, ativou, desativou, excluiu ou executou cada coisa, com IP, antes e depois, sem os segredos.
- Cada comando SQL executado nos bancos dos clientes fica em `db_commands`, com cliente, conexão, fluxo, nó, quem disparou, parâmetros, linhas, duração e erro.

## API para outros sistemas

Tudo o que a tela faz passa por uma API HTTP em JSON, e outro sistema pode usar a mesma API. Todos os endereços começam com `http://<servidor>:3000/api`. Os corpos de envio e de resposta são JSON. Datas vêm no formato ISO 8601 (ex.: `2026-09-30T13:00:00.000Z`), e os IDs são UUIDs.

A mesma referência aparece dentro do Info8n, no menu Referência da API (`/referencia-api`), e em JSON em `GET /api/docs`. Ela vem de `apps/server/src/api-reference.ts`. O teste `apps/server/test/api-reference.test.ts` falha quando uma rota existe sem estar nesse arquivo, quando algo documentado não existe mais ou quando um campo fica sem descrição. Ao criar ou mudar uma rota, atualize o arquivo e esta seção juntos.

**Autenticação**

- Gere um token em Minha conta (ou com `POST /api/auth/tokens`). Ele começa com `sa_` e só aparece uma vez. O banco guarda apenas o hash.
- Mande o token em toda chamada no header `Authorization: Bearer sa_...`.
- O token age como o usuário que o criou: mesmo perfil, mesmas pastas e mesmos clientes. Para uma integração, crie um usuário próprio com o menor perfil que resolve (Operador para disparar fluxos, Leitor só para consultar) e gere o token com ele.
- O token não expira. Deixa de valer quando é revogado em Minha conta, quando o usuário é desativado ou quando o usuário precisa trocar a senha (nesse caso a API responde 403 até a troca).
- Cada uso atualiza a data de "usado em" do token. Criar e revogar tokens fica na auditoria.
- A tela usa um cookie de sessão (`POST /api/auth/login`), que vale por `SESSION_TTL_HOURS` (12 horas por padrão). Sistemas externos devem usar o token.

**Perfis**

Cada chamada exige um perfil mínimo. Na tabela de endereços, a coluna Perfil mostra o menor que pode usar a chamada; os perfis acima também podem.

| Perfil na tabela | Quem pode |
| --- | --- |
| Qualquer | Todos os perfis logados, inclusive Leitor |
| Operador | Operador, Editor e Administrador |
| Editor | Editor e Administrador |
| Administrador | Só Administrador |

Além do perfil, valem as pastas e os clientes do usuário. Fluxos e execuções de pastas que ele não enxerga respondem 404, como se não existissem. Conexões e cadastros de cliente no ERP seguem os clientes dele.

**Erros**

Todo erro responde com `{"error": "mensagem", "details": ...}`. `details` só aparece quando há algo a detalhar.

| Código | Quando |
| --- | --- |
| 400 | Dados inválidos (details lista cada campo com problema) ou regra de negócio, como fluxo com erros ao ativar |
| 401 | Sem token, token errado ou revogado ("Faça login para continuar") |
| 403 | Perfil sem permissão, pasta ou cliente sem acesso, ou senha que precisa ser trocada (details.code = must_change_password) |
| 404 | Registro não existe ou está fora das pastas e clientes do usuário |
| 409 | Conflito: nome repetido, registro em uso ou fluxo salvo por outra pessoa |
| 500 | Erro interno; o detalhe fica no log do servidor |

**Disparar um fluxo e pegar o resultado**

A chamada que dispara não espera o fluxo terminar. Ela põe a execução na fila e devolve o ID na hora; o resultado é lido depois.

1. `POST /api/workflows/{id}/run` com o corpo `{"input": [{"json": {...}}, ...]}`. O `input` é opcional. Os itens entram no primeiro gatilho do fluxo, que deve ser o Gatilho manual; sem `input`, o gatilho solta um item vazio. Resposta: `{"executionId": "..."}`.
2. `GET /api/executions/{executionId}` até `status` sair de `queued` ou `running`. Consultar a cada 1 ou 2 segundos é suficiente.
3. Com `status` igual a `success`, o resultado está em `runs`: um registro por nó executado, na ordem. Cada um tem `nodeName`, `status`, `input` e `output`. O `output` é uma lista por saída do nó, e cada saída é uma lista de itens `{"json": {...}}`. O resultado final do fluxo é o `output` do último nó.
4. Com `status` igual a `error`, veja `error_message` (a mensagem), `error_node` (o nó que falhou) e `error` (o erro completo).

Exemplo com curl:

```
curl -X POST http://localhost:3000/api/workflows/ID_DO_FLUXO/run \
  -H "Authorization: Bearer sa_SEU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":[{"json":{"sku":"123"}}]}'

{"executionId":"957d6f51-b8c7-481f-96a9-c4a64c339dec"}

curl http://localhost:3000/api/executions/957d6f51-b8c7-481f-96a9-c4a64c339dec \
  -H "Authorization: Bearer sa_SEU_TOKEN"
```

Execuções disparadas pela API contam como manuais (`mode` = `manual`), aparecem em Execuções com o nome do dono do token e guardam os dados de todos os nós, mesmo com sucesso. Uma entrada ou saída de nó muito grande é guardada cortada, só com a contagem de itens (`_truncado` ou `_naoGuardado`). O ID do fluxo está no endereço da tela do fluxo (`/fluxos/{id}`) ou em `GET /api/workflows`.

**Resposta de GET /api/executions/{id}**

| Campo | Conteúdo |
| --- | --- |
| id, workflow_id, workflow_name, folder_id | Execução, fluxo e pasta |
| workflow_version | Versão do fluxo usada (vazia quando o editor rodou uma definição não salva) |
| mode | manual, schedule, subworkflow ou retry |
| status | queued, running, success, error ou canceled |
| triggered_by, triggered_by_name | Quem disparou (vazio nos agendados) |
| retry_of, parent_execution_id | Execução original de uma reexecução; execução que chamou este subfluxo |
| created_at, started_at, finished_at | Quando entrou na fila, começou e terminou |
| input | Itens de entrada enviados (apagado quando a execução não guarda dados) |
| definition | Fluxo exatamente como rodou |
| summary | Resumo por nó: status, tempo, tentativas, itens de entrada e de saída, erro |
| runs | Entrada e saída de cada nó; vazio quando os dados não foram guardados |
| error_message, error_node, error | Erro, quando houve |
| data_size | Tamanho dos dados guardados, em bytes (compactados) |
| children | Subfluxos que esta execução chamou: id, workflow_id, workflow_name, status, created_at, error_message |

**Todos os endereços**

Em `{id}` vai o UUID do registro. Chamadas marcadas "registra na auditoria" gravam quem fez, quando, o IP e, nas alterações, o antes e o depois.

*Conta e tokens*

| Método e caminho | Perfil | O que faz |
| --- | --- | --- |
| GET /api/health | Sem login | Responde {"ok":true} quando o servidor está no ar |
| GET /api/docs | Qualquer | Esta referência em JSON, a mesma que a tela Referência da API mostra |
| POST /api/auth/login | Sem login | Entra com {"email","password"} e devolve o cookie de sessão. 5 senhas erradas seguidas bloqueiam o usuário por 15 minutos |
| POST /api/auth/logout | Qualquer | Encerra a sessão do cookie |
| GET /api/auth/me | Qualquer | Usuário atual: id, email, name, role, mustChangePassword e permissions (editWorkflows, executeWorkflows, editConnections, admin) |
| POST /api/auth/change-password | Qualquer | Troca a senha: {"currentPassword","newPassword"}. Registra na auditoria |
| GET /api/auth/tokens | Qualquer | Tokens do próprio usuário: id, name, created_at, last_used_at |
| POST /api/auth/tokens | Qualquer | Cria um token: {"name"} (até 100 caracteres). Devolve {"id","name","token"}; o token só aparece aqui. Registra na auditoria |
| DELETE /api/auth/tokens/{id} | Qualquer | Revoga um token do próprio usuário. Registra na auditoria |

*Fluxos*

| Método e caminho | Perfil | O que faz |
| --- | --- | --- |
| GET /api/workflows | Qualquer | Lista os fluxos das pastas do usuário: id, name, folder_id, folder_name, active, version, updated_at, updated_by_name, last_execution (id, status, createdAt), scheduled (tem agendamento) e callable (pode ser chamado como subfluxo) |
| GET /api/workflows/{id} | Qualquer | Fluxo completo: id, name, folder_id, active, version, updated_at, definition e issues (problemas encontrados na validação) |
| POST /api/workflows | Editor | Cria: {"name","folderId","definition"?}. Sem definition, nasce só com o Gatilho manual. Registra na auditoria |
| PUT /api/workflows/{id} | Editor | Salva: {"name","folderId","definition","baseVersion"?}. Cada gravação cria uma versão nova. Com baseVersion diferente da atual, responde 409 (outra pessoa salvou antes). Fluxo ativo com problemas não salva (400). Registra na auditoria |
| DELETE /api/workflows/{id} | Editor | Exclui, desde que nenhum outro fluxo o chame como subfluxo (senão 400 com os nomes). Registra na auditoria com a definição apagada |
| POST /api/workflows/{id}/activate | Editor | Liga o agendamento. Só para fluxos com gatilho Agendamento, sem problemas e com cron válido. Registra na auditoria |
| POST /api/workflows/{id}/deactivate | Editor | Desliga o agendamento. Registra na auditoria |
| POST /api/workflows/{id}/duplicate | Editor | Cria uma cópia "(cópia)" na mesma pasta, desativada. Registra na auditoria |
| POST /api/workflows/{id}/run | Operador | Põe o fluxo na fila e devolve {"executionId"}. Corpo opcional: {"input":[{"json":{...}}]}. O editor da tela também manda "definition" (fluxo não salvo), o que exige Editor |
| GET /api/workflows/{id}/callers | Qualquer | Fluxos que chamam este como subfluxo: id, name |
| GET /api/workflows/{id}/versions | Qualquer | Últimas 200 versões: version, name, created_at, created_by_name |
| GET /api/workflows/{id}/versions/{versão} | Qualquer | Uma versão: version, name, definition, created_at |
| GET /api/workflows/{id}/export | Qualquer | {"name","definition","exportedAt"}, o arquivo que a tela baixa |
| POST /api/workflows/import | Editor | Importa um arquivo exportado: {"name","folderId","definition"}. Entra desativado. Registra na auditoria |
| POST /api/workflows/import-n8n | Editor | Importa do n8n: {"folderId","data"}, com data sendo o JSON exportado do n8n (um fluxo ou uma lista; até 50 MB). Devolve, por fluxo: n8nId, name, status (imported ou skipped), id, wasActive e warnings. Registra na auditoria |
| GET /api/node-types | Qualquer | Tipos de nó disponíveis, com os parâmetros de cada um |
| POST /api/expressions/preview | Editor | Calcula uma expressão como no editor: {"value","input"?,"nodeOutputs"?,"itemIndex"?}. Devolve {"result"} ou {"error"} |

*Execuções e comandos de banco*

| Método e caminho | Perfil | O que faz |
| --- | --- | --- |
| GET /api/executions | Qualquer | Lista as execuções, mais novas primeiro. Filtros na URL: workflowId, status (queued, running, success, error, canceled), mode (manual, schedule, subworkflow, retry), parentId, from e to (data e hora com fuso), search (nome do fluxo, mensagem ou nó do erro), before (para paginar: created_at da última linha recebida) e limit (1 a 200, padrão 50). Cada linha: id, workflow_id, workflow_name, mode, status, created_at, started_at, finished_at, duration_ms, error_message, error_node, triggered_by_name, data_size, parent_execution_id |
| GET /api/executions/waiting | Qualquer | Agendados que já deviam ter começado e esperam vaga no worker: workflowId, workflowName, dueAt |
| GET /api/executions/{id} | Qualquer | Execução completa, com os dados de cada nó (tabela acima) |
| POST /api/executions/{id}/cancel | Operador | Cancela uma execução na fila ou em andamento. Já terminada responde 400. Registra na auditoria |
| POST /api/executions/{id}/retry | Operador | Roda de novo com a mesma definição e a mesma entrada; devolve {"executionId"}. Em andamento responde 400. Registra na auditoria |
| GET /api/db-commands | Qualquer | Comandos rodados nos bancos dos clientes, mais novos primeiro, só dos clientes do usuário. Filtros: clientId, connectionId, executionId, status (ok ou error), from, to, search (SQL, fluxo ou erro), beforeId (para paginar: id da última linha) e limit (1 a 200, padrão 50). Cada linha: id, at, execution_id, workflow_id, workflow_name, node_name, connection_id, connection_name, client_id, client_name, db_type, operation, sql, params, rows, rows_affected, duration_ms, error, triggered_by_name |

*Conexões*

| Método e caminho | Perfil | O que faz |
| --- | --- | --- |
| GET /api/connection-types | Qualquer | Tipos de conexão e os campos de cada um (quais são segredo, quais são obrigatórios) |
| GET /api/connections | Qualquer | Conexões dos clientes do usuário e as sem cliente: id, name, type, typeName, clientId, clientName, data (sem os segredos), updatedAt, updatedByName |
| GET /api/connections/{id} | Qualquer | Uma conexão, no mesmo formato |
| GET /api/connections/{id}/usage | Qualquer | Fluxos que usam a conexão: id, name, active |
| POST /api/connections | Editor | Cria: {"name","type","clientId"?,"data"}. Os segredos são criptografados. Registra na auditoria sem os segredos |
| PUT /api/connections/{id} | Editor | Altera: mesmo corpo. Segredo em branco mantém o atual. Não troca o tipo. Registra na auditoria quais segredos mudaram, sem os valores |
| DELETE /api/connections/{id} | Editor | Exclui, se nenhum fluxo usa (senão 409 com os nomes). Registra na auditoria |
| POST /api/connections/test | Editor | Testa sem salvar: {"type","data","id"?}. Com id, segredos em branco usam os salvos. Devolve {"ok":true,"durationMs"} ou {"ok":false,"message"}. Limite de 20 segundos |

*APIs dos ERPs*

| Método e caminho | Perfil | O que faz |
| --- | --- | --- |
| GET /api/erps | Qualquer | ERPs cadastrados: id, name, baseUrl, authType, authHeader, clientFields, notes, updatedAt e as contagens endpoints e clients |
| GET /api/erps/{id} | Qualquer | ERP com os endpoints e os clientes cadastrados nele (só os clientes do usuário, sem os segredos) |
| POST /api/erps | Editor | Cria: {"name","baseUrl","authType" (none, bearer, basic ou header),"authHeader"?,"clientFields"?,"notes"?}. Registra na auditoria |
| PUT /api/erps/{id} | Editor | Altera, mesmo corpo. Registra na auditoria |
| DELETE /api/erps/{id} | Editor | Exclui, se não tiver clientes cadastrados (senão 409). Registra na auditoria |
| POST /api/erps/{id}/endpoints | Editor | Cria um endpoint: {"name","description"?,"method","path","headers"?,"query"?,"bodyType"?,"body"?,"variables"?,"usesAuth"?}. Devolve {"id"}. Registra na auditoria |
| PUT /api/erp-endpoints/{id} | Editor | Altera um endpoint, mesmo corpo. Registra na auditoria |
| DELETE /api/erp-endpoints/{id} | Editor | Exclui, se nenhum fluxo usa (senão 409). Registra na auditoria |
| POST /api/erps/{id}/clients | Editor | Cadastra um cliente no ERP: {"clientId","label"?,"values"}. Devolve {"id"}. Registra na auditoria sem os segredos |
| PUT /api/erp-clients/{id} | Editor | Altera o cadastro, mesmo corpo. Segredo em branco mantém o atual. Registra na auditoria |
| DELETE /api/erp-clients/{id} | Editor | Exclui, se nenhum fluxo usa (senão 409). Registra na auditoria |
| GET /api/api-catalog | Qualquer | O que o nó HTTP Request oferece no modo API cadastrada: clientes no ERP e endpoints, com as variáveis que cada um pede |

*Administração*

| Método e caminho | Perfil | O que faz |
| --- | --- | --- |
| GET /api/users | Administrador | Usuários: id, email, name, role, active, locked_until, created_at, folder_ids, client_ids |
| POST /api/users | Administrador | Cria: {"email","name","role" (admin, editor, operator ou viewer),"active"?,"password","folderIds"?,"clientIds"?}. O usuário troca a senha no primeiro acesso. Registra na auditoria |
| PUT /api/users/{id} | Administrador | Altera, mesmo corpo; password é opcional e, se enviada, redefine a senha. Desativar ou redefinir a senha derruba as sessões. Registra na auditoria |
| POST /api/users/{id}/unlock | Administrador | Desbloqueia quem errou a senha demais. Registra na auditoria |
| GET /api/folders | Qualquer | Pastas que o usuário enxerga: id, name |
| POST /api/folders | Administrador | Cria: {"name"}. Registra na auditoria |
| PUT /api/folders/{id} | Administrador | Renomeia: {"name"}. Registra na auditoria |
| DELETE /api/folders/{id} | Administrador | Exclui, se não tiver fluxos (senão 409). Registra na auditoria |
| GET /api/clients | Qualquer | Clientes que o usuário enxerga: id, name, notes |
| POST /api/clients | Administrador | Cria: {"name","notes"?}. Registra na auditoria |
| PUT /api/clients/{id} | Administrador | Altera, mesmo corpo. Registra na auditoria |
| DELETE /api/clients/{id} | Administrador | Exclui, se não tiver conexões nem cadastro em ERP (senão 409). Registra na auditoria |
| GET /api/audit | Administrador | Registros da auditoria, mais novos primeiro. Filtros: entityType, entityId, userId, from, to, before (para paginar: id da última linha) e limit (1 a 200, padrão 50). Cada linha: id, at, action, entity_type, entity_id, entity_name, before, after, ip, user_name, user_email |

**Limites**

- Corpo de até 10 MB por chamada (50 MB na importação do n8n).
- Não há limite de chamadas por minuto. O limite real é o de execuções simultâneas do worker (`WORKER_CONCURRENCY`); o que passar dele espera na fila.
- Não existe URL pública de webhook como no n8n: toda chamada precisa do token.

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
