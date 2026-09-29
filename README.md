# SistemaAutomacao

Plataforma de automação de processos baseada em fluxos de nós, focada em integrações com APIs REST e bancos de dados de clientes. Substitui o n8n self-hosted com controle de usuários, permissões por pasta e por cliente, e logs completos.

## O que já funciona (fases 1 e 2)

- **Editor visual** de fluxos com nós e ligações, painel de parâmetros, execução direto do editor e dados de entrada e saída de cada nó.
- **Campos Fixo ou Expressão** em todos os parâmetros. Expressões em JavaScript entre `{{ }}`, com `$json`, `$node['Nome'].json`, `$('Nome').first()`, `$input`, `$execution` e `$vars`, prévia do resultado e arrastar campos do JSON de entrada. As expressões rodam num isolate V8 separado (isolated-vm), com limite de tempo e memória.
- **Nós:** Gatilho manual, Agendamento (intervalo ou cron com fuso), Chamado por outro fluxo, HTTP Request, Execute Workflow, If, Loop, Stop and Error, Split Out, Aggregate, Merge e Code (JavaScript).
- **Loop em lotes:** o ramo "loop" recebe um lote por vez e liga de volta na entrada do Loop; a saída "concluído" entrega tudo o que voltou. Se o ramo não devolver nada, o Loop segue para o próximo lote. Loops dentro de loops funcionam, e um limite de execuções de nós impede ciclos sem fim.
- **Subfluxos:** o Execute Workflow chama outro fluxo pelo ID (uma vez com todos os itens ou uma vez por item), espera terminar e devolve a saída. Cada chamada vira uma execução filha, com link para a execução de quem chamou. Um erro no subfluxo para o fluxo principal trazendo o nó e o retorno da API que falhou. Não dá para excluir um fluxo que outro chama.
- **Code:** JavaScript no mesmo isolate das expressões, com `$input.all()`, `$json`, `$('Nome')`, `await` e `console.log`, cujas linhas aparecem nos dados do nó.
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

Os testes da API usam um banco próprio (`TEST_DATABASE_URL`, padrão `postgres://postgres@127.0.0.1:5432/automacao_test`) e apagam tudo nele a cada execução. Sem Postgres acessível, esses testes são pulados.

## Próximas fases

- **Fase 3:** nó Banco de dados (SQL Server, Oracle, Postgres) com auditoria dos comandos, catálogo de APIs por ERP e cadastro do cliente no ERP.
- **Fase 4:** Code em Python, nós de Metabase e ClickUp, importador de fluxos do n8n.
