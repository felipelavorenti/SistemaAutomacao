# SistemaAutomacao

Plataforma de automação de processos baseada em fluxos de nós, focada em integrações com APIs REST e bancos de dados de clientes. Substitui o n8n self-hosted com controle de usuários, permissões por pasta e por cliente, e logs completos.

## O que já funciona (fases 1 a 4)

- **Editor visual** de fluxos com nós e ligações, painel de parâmetros, execução direto do editor e dados de entrada e saída de cada nó.
- **Campos Fixo ou Expressão** em todos os parâmetros. Expressões em JavaScript entre `{{ }}`, com `$json`, `$node['Nome'].json`, `$('Nome').first()`, `$input`, `$execution` e `$vars`, prévia do resultado e arrastar campos do JSON de entrada. As expressões rodam num isolate V8 separado (isolated-vm), com limite de tempo e memória.
- **Nós:** Gatilho manual, Agendamento (intervalo ou cron com fuso), Chamado por outro fluxo, HTTP Request, Banco de dados, Metabase, ClickUp, Execute Workflow, If, Loop, Stop and Error, Split Out, Aggregate, Merge, Edit Fields (Set) e Code (JavaScript ou Python).
- **Loop em lotes:** o ramo "loop" recebe um lote por vez e liga de volta na entrada do Loop; a saída "concluído" entrega tudo o que voltou. Se o ramo não devolver nada, o Loop segue para o próximo lote. Loops dentro de loops funcionam, e um limite de execuções de nós impede ciclos sem fim.
- **Subfluxos:** o Execute Workflow chama outro fluxo pelo ID (uma vez com todos os itens ou uma vez por item), espera terminar e devolve a saída. Cada chamada vira uma execução filha, com link para a execução de quem chamou. Um erro no subfluxo para o fluxo principal trazendo o nó e o retorno da API que falhou. Não dá para excluir um fluxo que outro chama.
- **Code:** JavaScript no mesmo isolate das expressões, com `$input.all()`, `$json`, `$('Nome')`, `await` e `console.log`, cujas linhas aparecem nos dados do nó.
- **Code em Python:** Python 3 (Pyodide) em processos separados, sem acesso a arquivos, a outros programas nem às variáveis do servidor. Usa `_input.all()`, `_json`, `_("Nome")`, `_execution` e `_vars`, e o `print` aparece nos logs do nó. O código Python consegue abrir conexões de rede.
- **Metabase:** executa uma question pelo número ou pelo link, com filtros por nome, e devolve uma linha por item. A conexão usa API key ou usuário e senha. Um erro traz a mensagem do Metabase.
- **ClickUp:** cria tarefas numa lista (ID ou link), com nome, descrição, responsáveis (e-mail ou ID), prazo e campos personalizados. A conexão usa o token pessoal da API.
- **Importador do n8n:** em Fluxos, "Importar do n8n" recebe um ou vários arquivos exportados. HTTP Request, Code, Execute Workflow, Split Out, Aggregate, Merge, If, Loop, Stop and Error e os agendamentos convertem direto; Postgres, Microsoft SQL e Oracle viram o nó Banco de dados; Edit Fields (Set) vira o nó Edit Fields, No Op vira um Code; Filter vira If. Os subfluxos importados juntos, ou antes, ficam ligados pelo ID antigo. Os fluxos entram desativados, e a tela lista o que ajustar: credenciais a recadastrar como conexões, expressões com recursos do n8n que não existem aqui (`$now`, Luxon, métodos como `.toISO()`) e nós sem equivalente, que ficam marcados no fluxo e impedem a ativação até serem substituídos.
- **Banco de dados:** SQL Server, Oracle e Postgres dos clientes. Executa SQL com parâmetros nomeados (`:nome`, o valor nunca entra no texto do SQL), insere linhas (todos os campos do item ou coluna por coluna) e chama procedures com parâmetros de entrada e saída, inclusive cursor no Oracle e no Postgres. Cada conexão tem botão "Testar conexão". Todo comando executado fica registrado em **Comandos SQL**, com cliente, conexão, fluxo, nó, quem disparou, parâmetros, linhas, duração e erro.
- **Catálogo de APIs por ERP:** cada ERP tem a URL base (com `{{host}}` e `{{porta}}`), o tipo de autenticação e os endpoints (método, caminho, headers, query, corpo e variáveis). Cada cliente é cadastrado uma vez no ERP com host, porta e credenciais, que ficam criptografados. No nó HTTP Request, "API cadastrada" pede só o cliente, o endpoint e as variáveis, cada uma Fixo ou Expressão. O login continua sendo um nó do fluxo: o token vem da saída dele em cada execução. Um erro traz o ERP, o endpoint e o cliente junto com o retorno da API.
- **Dados como lista de itens**, como no n8n: cada nó recebe e devolve N itens. Arrays retornados por uma API viram um item por elemento.
- **Tratamento de erro:** quando uma API responde com erro, a execução para e guarda o status e o corpo da resposta. Por nó: tentar de novo com espera crescente, tempo limite e continuar em caso de erro.
- **Usuários e perfis** (Administrador, Editor, Operador, Leitor), acesso por pasta de fluxos e por cliente, bloqueio após 5 senhas erradas, troca de senha no primeiro acesso e tokens de API pessoais.
- **Conexões** cadastradas uma vez (API key no header, Bearer, Basic), criptografadas com AES-256-GCM, vinculadas a um cliente, com lista de fluxos que usam cada uma.
- **Execuções** em fila (BullMQ + Redis), com cancelamento, reexecução e histórico filtrável. Para ocupar pouco espaço, execuções agendadas com sucesso guardam só um resumo; as com erro e as manuais guardam entrada e saída de cada nó, comprimidas.
- **Auditoria** de quem criou, alterou, ativou, excluiu ou executou cada coisa, com o antes e o depois (sem segredos).
- **Versões** de cada fluxo a cada salvamento, com restauração, exportação e importação em JSON.

## Estrutura

```
packages/engine   Motor de execução, expressões e nós (sem dependência de banco)
apps/server       API (Fastify), Postgres, fila e worker
apps/web          Telas (React + React Flow)
```

## Rodar com Docker

```bash
cp .env.example .env        # preencha ENCRYPTION_KEY (openssl rand -hex 32) e as senhas
docker compose up -d --build
```

Acesse `http://servidor:3000` com o `ADMIN_EMAIL` e a `ADMIN_PASSWORD` do `.env`. A senha é trocada no primeiro acesso.

A plataforma precisa rodar na mesma rede do n8n atual, para herdar o acesso já liberado às APIs e aos bancos dos clientes.

## Desenvolvimento

Requer Node 22, Postgres 16 e Redis 7.

```bash
npm install
npm run build -w @sa/engine
# servidor (porta 3000) com as variáveis do .env.example, apontando DATABASE_URL e REDIS_URL para o seu ambiente
npm run dev:server
# telas com recarga automática (porta 5173, repassa /api para a 3000)
npm run dev:web
```

Testes:

```bash
npm run build && npm test
```

Os testes da API usam um banco próprio (`TEST_DATABASE_URL`, padrão `postgres://postgres@127.0.0.1:5432/automacao_test`) e apagam tudo nele a cada execução. Sem Postgres acessível, esses testes são pulados. Os testes do nó Banco de dados com SQL Server e Oracle rodam quando `TEST_MSSQL_HOST` e `TEST_ORACLE_CONNECT` estão definidos, e os do Metabase quando `TEST_METABASE_URL` está definido, como no CI (veja `.github/workflows/ci.yml`).
