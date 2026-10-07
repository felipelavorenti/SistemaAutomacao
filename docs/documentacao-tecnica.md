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
- `nodes/`: um arquivo por grupo de nós, registrados em `registry.ts`. Os gatilhos de eventos ficam em `webhook.ts` e `triggers-listen.ts`, e os formulários em `forms.ts`. Exemplos: `http-request.ts`, `database.ts`, `flow.ts` (Loop, Stop and Error, Code, Chamado por outro fluxo, Execute Workflow), `data.ts` (Split Out, Aggregate, Merge), `edit-fields.ts`, `metabase.ts`, `clickup.ts`, `gmail.ts` (com o login do Google em `google.ts`), `triggers.ts`.
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
- `triggers/manager.ts`: liga os gatilhos dos fluxos ativos (webhooks, formulários, IMAP, RSS, pasta, SSE, n8n Trigger) e a escuta de teste.
- `routes/`: `webhooks` (rotas públicas `/webhook*` e `/form*`), `auth`, `workflows`, `executions`, `connections`, `oauth` (login com Google das conexões do Gmail), `files` (arquivos escolhidos na tela, como anexos), `catalog` (ERPs e clientes), `db-commands`, `admin` (usuários, pastas, clientes, auditoria).
- `executions/`: `queue.ts` (fila, agendamentos e retomadas no BullMQ), `worker.ts` (roda as execuções e o fluxo de erro), `store.ts` (grava resultado, dados comprimidos e o estado das pausas), `events.ts` (eventos de uma execução pelo Redis, para os webhooks responderem).
- `lib/`: `auth.ts` (senha, sessão, bloqueio), `permissions.ts` (perfis), `crypto.ts` (AES-256-GCM), `audit.ts`, `connection-types.ts`.
- `db/migrations.ts`: cria e atualiza as tabelas ao subir.

**apps/web/src**

- `App.tsx`: login, menu lateral e rotas.
- `pages/`: uma tela por item do menu (Fluxos, Execuções, Conexões, APIs dos ERPs, Comandos SQL, Clientes, Usuários, Pastas, Auditoria, Conta, Referência da API).
- `editor/`: `EditorPage.tsx` (canvas e paleta), `FlowNode.tsx` (desenho do nó), `NodePanel.tsx` (janela do nó), `ParameterField.tsx` (campos Fixo e Expressão).
- `components/`: `ui.tsx` (modal, tabelas, visualizador de JSON) e `icons.tsx` (ícones e marca Info8n).
- `api.ts`: chamadas à API e tipos. `styles.css`: cores do IPA e estilos.

## Motor de execução

Toda execução passa pela fila: a API grava a execução como "na fila", e um worker a pega, roda o motor e grava o resultado. Isso vale para execuções manuais, agendadas, por webhook, por gatilho, de fluxo de erro, reexecuções, subfluxos e retomadas de execuções em espera.

**Fila e worker**

- A fila é o BullMQ sobre o Redis. Cada fluxo ativo com gatilho Agendamento vira um agendador no Redis. `packages/engine/src/schedule.ts` (`scheduleRepeat`) converte os campos do nó: Todo dia, Toda semana e Todo mês viram cron de 6 campos (com segundos) no fuso do nó (padrão America/Sao\_Paulo); A cada intervalo vira `every` em milissegundos (segundos, minutos ou horas); Expressão cron aceita 5 ou 6 campos. Ao subir, o servidor refaz os agendadores a partir dos fluxos ativos do banco.
- A execução única (Uma vez, numa data e hora) não usa agendador: vira um job atrasado com id `once-{id do fluxo}`. O campo Data e hora aceita `aaaa-mm-dd hh:mm`, `aaaa-mm-dd hh:mm:ss` ou `aaaa-mm-dd hh:mm:ss.mmm` (1 a 3 dígitos de milissegundos, `.5` vale 500 ms); `parseLocalDateTime` converte no fuso do nó e o atraso do job é calculado em milissegundos. Ao disparar, o worker desativa o fluxo (auditoria `deactivate` sem usuário) e roda a execução. Uma data que já passou não é agendada, nem quando o servidor volta depois do horário; ativar ou salvar um fluxo ativo com data passada é recusado.
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

## Nós de dados, fluxo e formatos (vindos do n8n)

Os nós abaixo reproduzem os nós do n8n das categorias Data Transformation, Flow e Core que trabalham só com JSON. Cada grupo fica num arquivo de `packages/engine/src/nodes/`, com o conversor do importador em `packages/engine/src/n8n/convert-*.ts` (exporta `converters`, indexado pelo tipo curto do n8n, consultado por `convertNode` antes dos conversores antigos) e os testes em `packages/engine/test/`.

**Base comum**

- **Saídas dinâmicas:** `NodeTypeDescription.dynamicOutputs` diz de onde vem a quantidade de saídas (`countFrom`, um campo numérico, ou `listFrom`, uma saída por linha de uma lista, com nome em `nameField` e a saída extra `extraName` quando os parâmetros batem com `extraWhen`; `modeField`, `listModes` e `countModes` escolhem a regra pelo modo do nó). `resolveOutputs(description, parameters)` faz a conta, usando o padrão de cada campo não editado; a tela tem a mesma função em `apps/web/src/api.ts` e chama `useUpdateNodeInternals` quando o número de alças muda. O Switch usa isso.
- **Tempo limite:** o tempo limite de cada nó é limitado a 2^31-1 ms (cerca de 24,8 dias), o maior atraso que o timer do Node aceita; acima disso o `AbortSignal.timeout` disparava na hora.
- **Execution Data:** o nó grava os pares em `meta.executionData` da execução do nó. `saveResult` junta os de todos os nós (o último vence) na coluna `executions.custom_data` (jsonb, migração `006_dados_execucao`, com índice GIN). `GET /executions` aceita `dataKey` e `dataValue` e devolve `custom_data`; a tela Execuções filtra pelo campo Dado gravado (chave ou chave=valor) e mostra os pares.
- **Conexões novas:** `totp` (secret em base32, label) e `cryptoPrivateKey` (privateKey em PEM). Campos de conexão podem ter `multiline`, que vira uma caixa de texto de várias linhas no formulário.
- **Bibliotecas do motor:** luxon (Date & Time), cheerio (HTML), xml2js (XML), showdown e node-html-markdown (Markdown) e otpauth (TOTP), as mesmas que o n8n usa, para o resultado sair igual.
- **Editor:** a paleta tem busca por nome e descrição, e cada nó novo tem ícone e cor próprios.

### Filter, Switch, Compare Datasets, Wait, No Operation e Execution Data

**Arquivos**

- packages/engine/src/nodes/flow-extra.ts: os nós filter, switch, compareDatasets, wait, noOp e executionData. Exporta cada um (filter, switchNode, compareDatasets, wait, noOp, executionData) e a lista flowExtraNodes, além de utilitários testados à parte: evaluateConditionCase, datasetEquals, waitFor, WAIT_TIMEOUT_MS e EXECUTION_DATA_LIMITS.
- packages/engine/src/n8n/convert-flow-extra.ts: exporta converters, com as chaves filter, switch, compareDatasets, wait, noOp e executionData.
- packages/engine/test/flow-extra.test.ts: 35 testes dos nós e dos conversores.

Nenhuma biblioteca nova. A igualdade profunda do Compare Datasets usa isDeepStrictEqual de node:util.

**Decisões**

- Filter e Switch reaproveitam evaluateCondition do If e os mesmos operadores, lidos da descrição do ifNode (OPERATORS não é exportado em if.ts). A opção ignoreCase converte para minúsculas os textos (e listas de textos) dos dois lados antes de comparar; na regex usa a flag i em vez de mexer no padrão. looseTypeValidation do n8n não foi criada porque evaluateCondition já compara de forma tolerante (número e texto numérico são iguais).
- Filter tem uma saída, como o Filter v2 do n8n (a saída de descartados do n8n não é usada).
- Switch: as saídas vêm de description.dynamicOutputs (modo rules: uma por regra, nome em outputKey, mais "Outros" quando fallbackOutput = extra; modo expression: numberOutputs, até 64). O execute devolve exatamente resolveOutputs(...).count listas, calculado com ctx.node.parameters. Como um campo options não lista as regras dinamicamente, "mandar para a saída de uma regra" é fallbackOutput = 'output' mais o número em fallbackIndex; o execute também aceita fallbackOutput numérico. Índice inválido (fallback ou expressão) gera erro com a faixa válida. Cada regra tem uma condição só (campo list não tem lista dentro de lista).
- Compare Datasets segue a versão 2.3 do n8n: itens com JSON vazio são ignorados; item de A sem algum campo de casamento vai para "só em A"; um item de B pode casar com vários de A; preferInput2 com comparação tolerante manda a versão de B para "iguais"; includeBoth gera keys/same/different/skipped como o n8n (campos ausentes viram null; campos ignorados com ponto, como end.cep, vão para skipped dentro do objeto pai). Nomes com ponto sempre são lidos como caminho (não há a opção Disable Dot Notation). A comparação tolerante reproduz o fuzzyCompare do n8n (versão 2): nulo, 0 e "0"; vazio, nulo e lista vazia; número e texto; objeto e JSON em texto; booleano e "true"/"1"/"false"/"0".
- Wait (pausa e retomada estão em Gatilhos, webhooks e pausa de execuções): esperas curtas e esperas dentro de subfluxos usam setTimeout em partes de até 2^31-1 ms, escutando ctx.signal; ao abortar limpa o timer e rejeita com o motivo do sinal, e o executor transforma em execução cancelada (o teste confirma status 'canceled'). Data passada não espera. A data aceita aaaa-mm-ddThh:mm:ss(.mmm) no fuso do nó (parseLocalDateTime de schedule.ts) ou ISO com Z/±hh:mm. Grava meta.waitUntil no modo data e hora.
- Limite de tempo do Wait: o executor usa AbortSignal.timeout(timeoutMs), e o Node não aceita mais que 2^31-1 ms (uns 24,8 dias). Por isso defaultTimeoutMs = 2.147.483.647 ms, o executor limita o tempo limite de qualquer nó a esse valor e o Wait recusa esperas maiores que 24 dias com erro claro. Fora de subfluxos, esperas de 65 s ou mais pausam a execução e não têm esse limite.
- Execution Data segue o customData do n8n: chave só com A-Z, a-z, 0-9 e _ (senão erro), cortada em 50; valor convertido em texto e cortado em 512; no máximo 10 chaves distintas (a 11ª dá erro); chave vazia é ignorada; com vários itens, o último vence. O resultado vai em ctx.meta.executionData só quando há alguma chave.

**Como o importador converte**

- filter (v1 e v2): reaproveita ifNode de import.ts (mesmos operadores e avisos). v1 lê combineConditions (AND/OR). ignoreCase vem de options.ignoreCase = true ou de conditions.options.caseSensitive = false. Só a saída 0 do n8n é ligada.
- switch v3 (typeVersion ≥ 3 ou rules.values): cada regra passa pelo ifNode; regra com várias condições fica só com a primeira e gera aviso dizendo quantas eram e se eram E ou OU (não há como representar várias condições por regra). outputKey vira o nome da saída. options.fallbackOutput: 'extra' vira extra (renameFallbackOutput gera aviso, porque aqui o nome é "Outros"), número vira 'output' + fallbackIndex. allMatchingOutputs e ignoreCase são copiados. Modo expression copia numberOutputs e output.
- switch v1/v2 (rules.rules com value1, dataType, operation, value2): cada regra vira left = value1. Operações mapeadas: equal, notEqual, contains, notContains, startsWith, endsWith, regex, larger, largerEqual, smaller, smallerEqual, after, before. notStartsWith e notEndsWith com valor fixo viram regex com lookahead negativo; com expressão, e notRegex, viram "é igual a" com aviso. dataType dateTime gera aviso de que as datas são comparadas como texto. v2: cada regra já é a saída de mesmo número; fallbackOutput ≥ 0 vira 'output'. v1: as 4 saídas fixas viram uma saída por regra, com outputMap ligando cada saída do n8n à primeira regra que ia para ela (aviso quando várias regras dividiam uma saída); fallback para uma saída usada por regra vira 'output', senão vira a saída extra e o mapa liga essa saída do n8n a "Outros". Modo expression: outputsAmount (v2) ou 4 (v1).
- compareDatasets: mergeByFields.values, resolve (padrão preferInput2 até a v2 e includeBoth depois), fuzzyCompare (nas opções na v1), preferWhenMix e exceptWhenMix, options.skipFields e options.multipleMatches. Avisa sobre Disable Dot Notation e sobre versões anteriores à 2.2 (que davam erro quando o campo de casamento faltava).
- wait: timeInterval com os padrões de cada versão (v1: 1 hora; v1.1: 5 segundos). specificTime: data com Z/offset é reescrita na hora local do fuso do fluxo; sem fuso, só troca o espaço por T; expressão é mantida com aviso sobre o formato. webhook e form são convertidos por convert-triggers-webhook.ts (veja Gatilhos, webhooks e pausa de execuções).
- noOp: vira noOp.
- executionData: dataToSave.values vira a lista key/value; mais de 10 pares geram aviso.

**Limites**

- Uma condição por regra no Switch.
- Wait dentro de subfluxo: no máximo 24 dias, ocupando o worker, sem webhook nem formulário.
- Compare Datasets sem a opção Disable Dot Notation.

### Limit, Sort, Remove Duplicates, Rename Keys e Summarize

**Arquivos**

- `packages/engine/src/nodes/transform.ts`: os nós `limit`, `sort`, `removeDuplicates`, `renameKeys` e `summarize` (todos no grupo `data`), mais a lista `transformNodes` para registrar de uma vez. Também exporta os utilitários `setPath`, `deepEqual`, `fieldsArray` e `normalizeFieldName`.
- `packages/engine/src/n8n/convert-transform.ts`: `converters` com as chaves `limit`, `sort`, `removeDuplicates`, `renameKeys`, `summarize` e `itemLists`.
- `packages/engine/test/transform.test.ts`: testes de execução de cada nó (com `executeWorkflow` e um `NodeRegistry` próprio) e de cada conversor.

Nenhuma biblioteca nova foi usada; os caminhos com ponto usam `getPath`/`splitPath` de `nodes/paths.ts`.

**Decisões**

- **Parâmetros planos.** As coleções "Options" do n8n viraram campos do próprio nó (ex.: `disableDotNotation`, `removeOtherFields`, `outputFormat`). Listas `fixedCollection` viraram campos `list`: Sort usa `sortFields` (`fieldName`, `order`); Rename Keys usa `keys` (`currentKey`, `newKey`) e `regexReplacements` (`searchRegex`, `replaceRegex`, `caseInsensitive`, `depth`), porque não há lista dentro de lista; Summarize usa `fieldsToSummarize` (`aggregation`, `field`, `includeEmpty`, `separateBy`, `customSeparator`).
- **Parâmetros do nó todo** (tipo de ordenação, campos de comparação, agrupamento, opções) são lidos com o índice 0, como no n8n. No Rename Keys, as listas são lidas por item, também como no n8n.
- **Sort por código.** O n8n roda o código do usuário uma única vez no sandbox, como `items.sort((a, b) => { código })`. Aqui é igual: o nó chama `ctx.runCode` uma vez, com um código que monta a lista a partir de `$input.all()` (cada elemento com `json` e a posição original), ordena com a função do usuário dentro do isolate e devolve só as posições; o nó reordena os itens originais com elas. Assim não há uma chamada ao isolate por comparação. O código é lido cru de `ctx.node.parameters.code` (sem resolver expressões), como o nó Code. Sem `return` no código, o nó dá erro, como no n8n. Os `console.log` vão para `meta.logs`.
- **Sort simples** reproduz o n8n: textos em minúsculas, igualdade profunda e "menor que" do lodash (textos com textos; o resto convertido para número). Erro se o campo não existe em nenhum item.
- **Remove Duplicates** reproduz a operação "Remove Items Repeated Within Current Input" da versão 2 (e a versão 1, que tem os mesmos parâmetros). Em vez de ordenar e comparar vizinhos, usa uma assinatura canônica dos valores comparados (chaves de objeto em ordem), com o mesmo resultado: fica a primeira ocorrência. Mantém as validações do n8n: em Todos os campos, as chaves são a união das chaves achatadas (`a.b`, `lista.0`) de todos os itens e cada uma precisa existir em todos (nulo é aceito, como na v2) e ter sempre o mesmo tipo. Diferença intencional: em "Todos os campos, menos alguns", ignorar `meta` também ignora `meta.x` (no n8n só a chave achatada exata era excluída, o que tornava inútil excluir um objeto). As operações que lembram itens de execuções anteriores (`removeItemsSeenInPreviousExecutions`, `clearDeduplicationHistory`) precisam de armazenamento entre execuções e não foram implementadas.
- **Rename Keys** copia o item, aplica a lista (lendo do item original, gravando com `setPath` e apagando o caminho antigo) e depois as expressões regulares, sem flag global (só a primeira ocorrência no nome é trocada, como no n8n). Regex inválida vira erro claro. A profundidade segue o n8n: -1 sem limite, 0 só o primeiro nível; listas consomem um nível e suas posições não são renomeadas.
- **Summarize** segue a versão 1.1: nomes de saída `appended_`, `average_`, `concatenated_`, `count_`, `unique_count_`, `max_`, `min_`, `sum_` + campo normalizado (sem `[]"`, ponto e espaço viram `_`); grupos mantêm o tipo do valor (1 e "1" são grupos diferentes); os campos de agrupamento entram no fim do item, do mais interno para o mais externo; no formato "um item só" as chaves viram texto. Mínimo e máximo usam `<`/`>` do JavaScript, como no n8n (por isso "3" < 5). Média sem números devolve null. A opção `continueIfFieldNotFound` (padrão ligado, que é o comportamento fixo da 1.1) existe para importar fluxos da versão 1; quando o nó continua, os avisos ficam em `meta.hints`.
- **Entrada vazia:** Remove Duplicates e Summarize devolvem nada (o executor nem chama nós sem itens).

**Importador**

- `limit`: `maxItems`, `keep`.
- `sort`: `type`, `sortFieldsUi.sortField[]` para `sortFields`, `options.disableDotNotation`; no tipo código, copia `code` e avisa para conferir.
- `removeDuplicates` (v1, v1.1 e v2): `compare`, `fieldsToExclude`, `fieldsToCompare`, `options.disableDotNotation`, `options.removeOtherFields`. Na v2, `operation` diferente de `removeDuplicateInputItems` gera aviso e devolve null (vira o nó não convertido).
- `renameKeys`: `keys.key[]` e `additionalOptions.regexReplacement.replacements[]` (com `options.caseInsensitive` e `options.depth`, padrão -1).
- `summarize`: `fieldsToSummarize.values[]`, `fieldsToSplitBy`, `options.*`. `continueIfFieldNotFound` fica ligado a partir da versão 1.1 e, na versão 1, vem da opção (padrão desligado).
- `itemLists` (todas as versões): `limit`, `sort`, `removeDuplicates` e `summarize` viram os nós acima (no Remove Duplicates, aceita também a forma antiga `{ fields: [{ fieldName }] }`; no Summarize, segue a regra da versão 1). `splitOutItems` vira Split Out e `aggregateItems`/`concatenateItems` vira Aggregate, usando os conversores `splitOut` e `aggregate` exportados por `import.ts` (os parâmetros do Item Lists têm os mesmos nomes desses nós).

**Limites**

- Sem a deduplicação entre execuções do n8n.
- O tipo `list` não permite listas aninhadas, por isso as trocas por regex ficam numa lista separada.

### Date & Time, Crypto, HTML, Markdown, XML e TOTP

**Arquivos**

- `packages/engine/src/nodes/formats.ts`: os seis nós (`dateTime`, `cryptoNode` com type `crypto`, `html`, `markdown`, `xml`, `totp`), a lista `formatNodes` com todos eles e utilitários exportados (`parseDate`, `setPath`, `formatPem`, `htmlToText`, `capitalizeHeader`, `DATE_OUTPUT_DEFAULTS`, `DEFAULT_DATE_TIMEZONE`, `HTML_PLACEHOLDER`).
- `packages/engine/src/n8n/convert-formats.ts`: `converters` com as chaves `dateTime`, `crypto`, `html`, `htmlExtract`, `markdown`, `xml` e `totp`, e `momentToLuxon` (tradução de formatos do moment para o luxon).
- `packages/engine/test/formats.test.ts`: 35 testes (cada operação de cada nó e cada conversor), com datas e relógio fixos.

**Bibliotecas**

As mesmas do n8n: luxon (Date & Time), node:crypto (Crypto), cheerio (HTML), showdown e node-html-markdown (Markdown), xml2js (XML) e otpauth (TOTP). Duas dependências do n8n não estão instaladas e foram substituídas: o moment (usado pelo parseDate do n8n para ler textos) e o html-to-text (usado na extração de texto do nó HTML 1.2).

**Decisões e diferenças**

- **Estrutura dos parâmetros.** O modelo de propriedades daqui não tem coleções ("options" do n8n), então as opções viraram campos de primeiro nível com `showWhen`. O n8n repete nomes de parâmetro com padrões diferentes por operação; aqui cada nome existe uma vez. No Date & Time, `outputFieldName` vazio usa o nome padrão do n8n para a operação (tabela `DATE_OUTPUT_DEFAULTS`); o conversor sempre preenche o nome.
- **Fuso do Date & Time.** O contexto de execução não tem o fuso do fluxo, então o nó tem o campo `timezone` (padrão America/Sao_Paulo), que faz o papel do fuso do fluxo; o conversor preenche com o fuso do fluxo do n8n (ou com `options.timezone` do Get Current Date). Na operação Formatar, a opção do n8n "Use Workflow Timezone" virou `useWorkflowTimezone`; desligada, a data é formatada em UTC ou no deslocamento "+hh" do texto (inclusive o atalho do n8n que usa `Etc/GMT-hh` e ignora os minutos).
- **Leitura de datas.** `parseDate` segue as regras do n8n para números (menos de 12 dígitos são segundos, senão milissegundos; números com casas decimais são segundos). Textos são lidos com luxon (ISO, RFC 2822, HTTP, SQL e, por último, `Date.parse`) no lugar do moment. Textos sem fuso são lidos no fuso em uso (o do nó, ou UTC na formatação sem o fuso do nó); no n8n eles eram lidos no fuso do servidor, então o resultado é igual quando o servidor do n8n roda no fuso do fluxo.
- **Arredondar para cima** devolve o início do mês seguinte, como no n8n (a opção se chama "Fim do mês" lá também).
- **Formatos prontos.** Além dos formatos do n8n, há DD/MM/AAAA. O padrão continua MM/dd/yyyy, como no n8n.
- **Crypto.** Na versão atual do n8n, o segredo do HMAC e a chave privada ficam numa credencial; aqui o segredo é parâmetro (como no Crypto V1) e a chave privada vem da conexão `cryptoPrivateKey` (`data.privateKey`). A chave é refeita com quebras de linha quando chega colada numa linha só (equivalente ao `formatPemBlock` do n8n). Os algoritmos de assinatura são os de `getHashes()` sem os não suportados, como no n8n; o padrão é RSA-SHA256 (no n8n é vazio). A saída é gravada com caminho (como o `set` do lodash): nomes com pontos criam campos aninhados. Ficaram de fora: hash/HMAC de dado binário (fase de arquivos) e as ações Encrypt/Decrypt da versão 2 do n8n.
- **HTML, gerar modelo.** No n8n o campo sempre resolve `{{ }}`; aqui é preciso o modo Expressão (o conversor acrescenta o "=" quando o modelo tem `{{`).
- **HTML, extrair texto.** A versão 1.2 do n8n converte o HTML interno do primeiro elemento com html-to-text. A função `htmlToText` imita as regras padrão dessa biblioteca: espaços colapsados, blocos (p, títulos, listas, tabelas: duas quebras; div, li, tr e outros: uma), títulos em maiúsculas, `br` como quebra, links como "texto [href]" (sem `#âncoras`, sem o "mailto:"), imagens como "alt [src]", listas com " * " ou "1. ", `hr` como 40 hífens; ignora script, style, head, noscript, template e svg. Diferença conhecida: o html-to-text quebra linhas em 80 colunas e, com "Limpar o texto" ligado (padrão), o n8n acaba colando as palavras da quebra; aqui não há quebra em 80 colunas. As versões 1 e 1.1 do nó (e o HTML Extract antigo) usavam o `.text()` do cheerio; o conversor avisa que agora vale a regra da 1.2.
- **HTML, tabela.** Reproduz o HTML do n8n caractere a caractere, inclusive os espaços duplos, campos ausentes como "undefined" e objetos como "[object Object]". Com zero itens de entrada, não sai nada.
- **Markdown.** Só são passadas para o node-html-markdown as opções preenchidas, como no n8n. O n8n passa o estilo de bloco "fence", que a biblioteca não conhece e acaba gerando código recuado; aqui "fence" vira "fenced" (o conversor avisa). As substituições de texto passam o padrão como texto, como no n8n (troca só a primeira ocorrência, sem regex). Do showdown ficaram 21 opções (as mais usadas); as que faltam (ghMentions, ghMentionsLink, customizedHeaderId, rawHeaderId, rawPrefixHeaderId, tablesHeaderId, smartIndentationFix, disableForced4SpacesIndentedSublists) e os padrões de escape do node-html-markdown (Global/Line Start Escape) geram aviso no conversor.
- **XML.** Mesmos padrões do n8n (`mergeAttrs` ligado, `explicitArray` desligado) e a mesma proteção contra `__proto__`, `constructor` e `prototype` em `attrkey`/`charkey`. O `sanitizeXmlName` do n8n não estava no código consultado; aqui tags e atributos com esses nomes recebem um "_" na frente. No JSON para XML, com uma única chave no item e a raiz padrão, o xml2js usa a chave como raiz (igual no n8n). Os parâmetros valem para o nó todo (lidos no item 0), como no n8n. Erros de XML viram "XML inválido: ...".
- **TOTP.** Igual ao n8n: o código é gerado uma vez por execução e repetido em cada item; o rótulo, se houver, precisa ter ":"; Dígitos e Validade zerados voltam aos padrões 6 e 30. O grupo é `action`.
- **Erros** usam `NodeOperationError` com mensagens em português; "Continuar com erro" fica a cargo do executor.

**Conversão do importador**

- `dateTime` V2: cada operação com os mesmos nomes de parâmetro; `options.includeInputFields`, `options.fromFormat` (ignorando o valor de exemplo "e.g yyyyMMdd"), `options.timezone` (fuso no Get Current Date, "usar fuso do fluxo" no Format) e `options.isoString`. O fuso do nó recebe o fuso do fluxo.
- `dateTime` V1: Format vira Formatar (`dataPropertyName` vira o campo de saída, `includeInputFields` ligado porque o V1 mantinha o item; formatos prontos do moment viram os do luxon; formatos personalizados são traduzidos por `momentToLuxon`, com aviso; `toTimezone`/`fromTimezone` viram o fuso do nó com "usar o fuso do nó" ligado). Calculate vira Somar/Subtrair, com aviso de que a saída agora é ISO no fuso do nó (antes era UTC). Campo de saída com pontos gera aviso.
- `crypto`: hash, hmac, sign e generate. Padrão do tipo MD5 no V1 e SHA256 no V2. HMAC no V2 (segredo na credencial) e sign (chave na credencial ou no parâmetro do V1) geram aviso para preencher o segredo ou escolher a conexão. Dado binário e encrypt/decrypt devolvem `null` com aviso.
- `html`: as três operações; extração com fonte binária devolve `null` com aviso; versões 1 e 1.1 com extração de texto geram aviso.
- `htmlExtract` (nó antigo): vira HTML > Extrair conteúdo, com o mesmo aviso sobre a extração de texto; fonte binária devolve `null`.
- `markdown`: os dois modos, com as opções suportadas copiadas e aviso para as que não existem.
- `xml`: os dois modos, copiando só as opções que valem para o modo.
- `totp`: as opções, a conexão vazia e o aviso para cadastrar o segredo.

**Limites e pendências**

- Fonte binária (HTML, Crypto) fica para a fase de arquivos; o campo "Origem do HTML" já existe com a opção JSON.
- Encrypt/Decrypt do Crypto V2 não foram feitos.

## Arquivos nos itens e nós de arquivos (vindos do n8n)

Os itens levam arquivos como no n8n, e os nós de arquivos das categorias Core e Files do n8n foram reproduzidos. Os grupos de nós ficam em `packages/engine/src/nodes/files-convert.ts` e `files-disk.ts`, com os conversores em `packages/engine/src/n8n/convert-files-*.ts`.

**Base comum**

- **Formato:** `Item.binary?: Record<string, BinaryData>` (`packages/engine/src/types.ts`), com `data` (base64), `mimeType`, `fileName`, `fileExtension`, `fileSize` (texto legível, como "12.3 kB"), `bytes`, `fileType` e `directory`, como o `IBinaryData` do n8n. Na execução gravada, `data` vem vazio e o arquivo tem `ref` (conteúdo guardado) ou `omitted: true` (não guardado).
- **Helpers:** `packages/engine/src/binary.ts` (`toBinary`, `getBinary`, `getBinaryBuffer`, `withBinary`, `binaryPropertyList`, `formatFileSize`, `mimeTypeFromFileName`, `extensionFromMimeType`), exportados pelo pacote. `getBinary` dá erro claro listando os arquivos que o item tem.
- **Os nós que só repassam itens** (If, Filter, Switch, Merge, Loop, Wait, Limit, Sort etc.) mantêm os arquivos, porque repassam o mesmo item. Edit Fields tem `includeBinary` (padrão ligado; o importador segue o `includeBinary`/`stripBinary` de cada versão do Set). Code recebe `item.binary` e `$binary` (também nas expressões) e pode devolver `binary`, validado em `toItems` de `nodes/flow.ts` (`data` em texto obrigatório; `mimeType` vazio vira application/octet-stream).
- **Gravação:** `stripBinaries` em `apps/server/src/executions/store.ts` tira o conteúdo antes de gravar a execução. Em execuções manuais e reexecuções (e nos subfluxos chamados por elas), cada arquivo diferente (SHA-256 do conteúdo) vai para a tabela `execution_files` (migração `007_arquivos_execucao`, apagada junto com a execução), até 64 MB por execução, e o item guarda `ref`; nos outros modos, ou passado o limite, o item fica com `omitted: true`. O corte de 256 KB por nó é aplicado depois, então arquivos não estouram o limite do log.
- **Download:** `GET /executions/{id}/files/{ref}` devolve o arquivo com o tipo e o nome; PDF, imagens (exceto SVG), texto, CSV e JSON abrem no navegador, o resto (inclusive HTML e SVG) sempre baixa, com `X-Content-Type-Options: nosniff` e CSP `sandbox`. `?download=true` força o download. A tela mostra a lista Arquivos (`BinaryFiles` em `apps/web/src/components/ui.tsx`) na janela do nó e na página da execução.
- **Pastas do servidor:** `FILES_DIRS` (vírgula ou ponto e vírgula) chega aos nós em `ctx.filesDirs`. O docker-compose usa `/files`, ligado à pasta `./arquivos` (fora do git).
- **Bibliotecas novas no motor:** exceljs, csv-parse, csv-stringify, pdfjs-dist, ics, iconv-lite, fflate, sharp e fast-glob. O SheetJS (`xlsx`) do n8n não pôde ser instalado (o pacote atual só é distribuído pelo CDN deles, e a versão do npm tem falhas de segurança conhecidas), por isso não há XLS nem ODS. A imagem Docker instala `fonts-dejavu-core` para o Edit Image escrever texto.

### Convert to File, Extract from File e iCalendar

**Arquivos**

- `packages/engine/src/nodes/files-convert.ts`: os nós `convertToFile` e `extractFromFile` (grupo `data`) e `iCal` (grupo `action`), exportados como `convertToFile`, `extractFromFile` e `iCal`, e a lista `fileConvertNodes`. Também exporta utilitários testados à parte: `flattenObject` (igual ao do n8n), `matrixToItems` (linhas de planilha em itens, como o `sheet_to_json` do SheetJS), `csvToItems`, `parseIcsCalendar` e `extractPdf`.
- `packages/engine/src/n8n/convert-files-convert.ts`: exporta `converters`, com as chaves `convertToFile`, `extractFromFile`, `iCal`, `spreadsheetFile`, `readPDF` e `moveBinaryData`.
- `packages/engine/test/files-convert.test.ts`: 30 testes dos nós (ida e volta CSV, XLSX, HTML, RTF, base64 e ICS; PDF de duas páginas escrito à mão no teste) e dos conversores.

Os arquivos dos itens usam os helpers de `binary.ts` (`toBinary`, `getBinary`, `getBinaryBuffer`); `setPath` vem de `nodes/formats.ts` e `getPath` de `nodes/paths.ts`.

**Bibliotecas**

Nenhuma nova. exceljs (XLSX, leitura e escrita), csv-parse (leitura de CSV, as mesmas opções do n8n), cheerio (tabela HTML), iconv-lite (codificações, a mesma lista de 102 codificações do n8n), pdfjs-dist (PDF, pelo build `legacy`, carregado só quando o nó lê um PDF) e ics (criação do evento, a mesma biblioteca do n8n). A escrita de CSV, HTML e RTF e a leitura de RTF e ICS são código próprio.

**Decisões e diferenças do n8n**

- O n8n usa o SheetJS (`@e965/xlsx`) para todas as planilhas, e ele não está disponível aqui. Por isso XLS e ODS não existem: não aparecem nas operações e, se chegarem por parâmetro, o nó para com "O formato XLS não é suportado nesta plataforma. Use XLSX ou CSV". O importador avisa e deixa o nó como não convertido.
- A escrita de planilhas imita o `json_to_sheet` do SheetJS: os itens passam por `flattenObject` (objetos e listas viram colunas com ponto, `end.cidade`, `tags.0`), as colunas seguem a ordem em que aparecem nos itens, campo ausente ou null fica vazio, e booleanos saem TRUE/FALSE no CSV, HTML e RTF. Diferenças: números saem com `String(n)` (o SheetJS usa o formato General, que arredonda para uns 11 dígitos e usa notação científica em números grandes); o HTML é uma tabela simples (`<td>` sem os atributos `data-t`/`data-v` e `id` do SheetJS); o CSV não tem quebra de linha no fim, como no SheetJS. O tipo MIME do arquivo é fixo por formato (o n8n deduz pelo nome). O RTF segue o `sheet_to_rtf` do SheetJS (`\trowd\trautofit1`, `\cellxN`, `\pard\intbl ... \cell`, `\row`), mas escapa `\`, `{` e `}` e grava acentos como `\uN?`.
- A leitura de planilhas imita o `sheet_to_json`: com cabeçalho, nomes repetidos ganham `_1`, `_2`, colunas sem nome viram `__EMPTY`, `__EMPTY_1`, e linhas vazias somem; sem cabeçalho, cada linha é `{ row: [...] }` (buracos saem null). No XLSX, a área lida vai da primeira à última célula preenchida (o SheetJS usa a dimensão gravada no arquivo, que pode incluir células só com formatação); células mescladas só têm valor na primeira; fórmulas dão o resultado em cache; rich text vira texto; datas saem em ISO (como o n8n 1.2) ou, com Dados brutos, como número serial do Excel (como as versões antigas). No HTML, só a primeira `<table>` é lida (colspan e rowspan respeitados, `<br>` vira quebra de linha); números e TRUE/FALSE viram número e booleano fora do modo Dados brutos, numa regra mais simples que a do SheetJS (não lê "1.234,56", porcentagem nem moeda).
- RTF: implementado nos dois sentidos, do jeito mais simples: a leitura procura as linhas `\trowd ... \row`, divide as células em `\cell`, tira os comandos e decodifica `\'hh` (Windows-1252) e `\uN`. Serve para tabelas geradas pelo próprio nó, pelo SheetJS e por editores comuns; RTF sem tabela dá erro.
- CSV: o arquivo é decodificado com iconv-lite antes do csv-parse, o que permite codificações além das do Node (Windows-1252 e Latin1, comuns em arquivos de ERPs). Como no n8n, sem "Excluir BOM" a marca fica grudada no primeiro nome de coluna; sem "Incluir células vazias", uma linha sem cabeçalho vira objeto `{ "0": ..., "1": ... }` (é o que o filtro do n8n faz com a lista). Erros de leitura sempre param o nó (o comportamento do n8n a partir da versão 1.1). Linha inicial 0 e Máximo de linhas -1 (ou 0) valem como "sem limite" (o csv-parse recusa 0).
- Opções do n8n que eram coleções viraram campos de primeiro nível com `showWhen`. Os nomes seguem o n8n (`binaryPropertyName`, `destinationKey`, `sourceProperty`, `delimiter`, `headerRow`, `includeEmptyCells`, `maxRowCount`, `fromLine`, `enableBOM`, `relaxQuotes`, `range`, `sheetName`, `rawData`, `encoding`, `stripBOM`, `addBOM`, `keepSource`, `joinPages`, `maxPages`, `password`, `format`, `mode`, `mimeType`, `fileName`), com estas exceções: a codificação do CSV é `csvEncoding` (no n8n as duas se chamam `encoding`, com listas diferentes); `skipRecordsWithErrors` (fixedCollection no n8n) virou o booleano `skipRecordsWithErrors` mais `maxSkippedRecords`; no iCalendar, `attendeesUi` virou a lista `attendees`, `organizerUi` virou `organizerName`/`organizerEmail` e `geolocationUi` virou `geoLat`/`geoLon`. A operação "Move File to Base64 String" tem o valor `binaryToProperty` (no n8n é `binaryToPropery`, com o erro de digitação; o nó aceita os dois).
- Manter da entrada (`keepSource`): no n8n, sem a opção, a saída não leva o JSON do item; por isso aqui há a opção Nada (`none`), que é o padrão e reproduz isso. Nada e JSON levam os outros arquivos do item e tiram o lido; Arquivo e Ambos levam todos. No PDF, JSON e Ambos juntam o JSON do item com o resultado.
- Extrair de JSON com o Campo de saída vazio troca o item inteiro pelo JSON do arquivo (no n8n o lodash gravaria no campo ""). Isso existe para converter o Move Binary Data com "Set All Data".
- Extrair de XML só lê o texto, como no n8n (para JSON, usar o nó XML depois).
- ICS (leitura): o n8n usa a biblioteca ts-ics, que não está disponível. O leitor próprio desdobra as linhas, separa parâmetros (com aspas) e monta o mesmo formato de objeto: `{ version, prodId, method, calScale, name, events: [...] }`, eventos com `uid`, `summary`, `description`, `location`, `url`, `status`, `class`, `timeTransparent`, `sequence`, `priority`, `start`/`end`/`stamp`/`created`/`lastModified`/`recurrenceId` como `{ date, type: 'DATE' | 'DATE-TIME', local? }`, `duration`, `geo`, `organizer`, `attendees`, `categories`, `exceptionDates`, `recurrenceRule` (`frequency`, `until`, `count`, `interval`, `byDay: [{ day, occurrence }]` etc.), `attach` e `alarms` (com `trigger` relativo ou absoluto). Datas com TZID IANA são convertidas pelo luxon e ganham `local: { date, timezone, tzoffset }`; TZID que não é IANA (nomes do Windows, como "E. South America Standard Time") fica com a hora como está, em UTC. VTODO vira `todos`; VTIMEZONE, VJOURNAL e campos X- não são lidos. As datas saem como texto ISO (no n8n são objetos Date, que viram o mesmo texto ao serializar).
- PDF: mesmo algoritmo do `extractDataFromPDF` do n8n (texto da página com quebra de linha quando a altura muda, páginas unidas com linha em branco) e mesmo formato de saída (`numpages`, `numrender`, `info`, `metadata` só quando existe, `text`, `version`, que é a versão do pdfjs-dist daqui, 6.x). Máximo de páginas 0 lê todas (no n8n, 0 explícito não lia nenhuma página). Senha errada ou ausente e arquivo inválido viram mensagens claras.
- Base64 para arquivo aceita o prefixo `data:...;base64,`. Sem nome nem tipo, o tipo é detectado pelo começo do conteúdo (PNG, JPEG, GIF, WEBP, PDF, ZIP, GZIP) e, sem reconhecer, fica text/plain como no n8n; o nome vira `file.<extensão>`.
- iCalendar: a data sem fuso é lida no campo novo Fuso horário (padrão America/Sao_Paulo; o n8n lia no fuso do servidor, com moment, e a opção Use Workflow Timezone não mudava o resultado) e vai para o ics em UTC, com segundos; dia inteiro manda só ano, mês e dia e soma um dia ao fim, como o n8n. Datas aceitam ISO (com espaço ou T), timestamp em segundos ou milissegundos, RFC 2822 e o que o `Date.parse` entender. O evento usa `startInputType`/`endInputType: 'utc'` como o n8n; erros de validação da biblioteca ics viram "Não foi possível criar o evento: ...".
- Erros com mais de um item recebem o prefixo "Item N:". A extensão do arquivo diferente da operação muda o erro para "O arquivo em "data" não está no formato XLSX. Troque a operação ou escolha um arquivo XLSX.", como o n8n.

**Como o importador converte**

- convertToFile: csv, html, rtf e xlsx copiam `binaryPropertyName` e as opções (`delimiter`, `headerRow`, `sheetName`, `compression`, `fileName`; sem nome, grava `File.<formato>`, o padrão do n8n). toJson copia `mode`, `format`, `encoding`, `addBOM` e `fileName`; toText, `sourceProperty`, `encoding`, `addBOM` e `fileName`; toBinary, `sourceProperty`, `mimeType` e `fileName` (na versão 1 com Data Is Base64 desligado vira toText, com aviso se havia tipo MIME). iCal passa pela mesma conversão do iCalendar. xls e ods: aviso e null.
- iCal: title, start, end, allDay, binaryPropertyName e as additionalFields (description, location, url, uid, calName, recurrenceRule, status, busyStatus, fileName, sequence; attendeesUi, organizerUi e geolocationUi viram os campos soltos). O Fuso horário fica UTC, para as datas sem fuso serem lidas como num servidor do n8n em UTC, com aviso para conferir; useWorkflowTimezone é ignorado (não mudava nada no n8n).
- extractFromFile: csv, html, rtf e xlsx copiam as opções que existem no fluxo (`encoding` vira `csvEncoding`; `skipRecordsWithErrors.value.enabled` e `.maxSkippedRecords` viram os dois campos). Versão anterior à 1.2 com XLSX liga Dados brutos, com aviso, porque nelas as datas saíam como número serial; versão 1 com CSV avisa que o n8n ignorava erros de leitura. `readAsString` gera aviso. binaryToPropery, fromJson, text, fromIcs e xml copiam `destinationKey`, `encoding`, `stripBOM` e `keepSource` (ausente vira `none`); pdf copia `joinPages`, `maxPages`, `password` e `keepSource`. xls e ods: aviso e null.
- spreadsheetFile (V1 e V2): Write to File vira convertToFile com o formato (padrão xls, que não é suportado) e nome padrão `spreadsheet.<formato>`; Read from File vira extractFromFile com o formato da V2, e o Autodetect (e a V1, que sempre detectava) vira XLSX com aviso para trocar se o arquivo for CSV, HTML ou RTF. As datas do XLSX saíam como número serial, então Dados brutos fica ligado (com aviso); CSV avisa que erros eram ignorados.
- readPDF: vira extractFromFile pdf com `keepSource: 'binary'` (o Read PDF devolvia o resultado e mantinha os arquivos); a senha só é copiada se Encrypted estava ligado.
- moveBinaryData, Binary to JSON: com Set All Data, vira fromJson com Campo de saída vazio (o item inteiro vira o JSON do arquivo); sem ele, vira binaryToProperty (Keep As Base64), fromJson (JSON Parse) ou text, mantendo o JSON do item. Keep Source ligado mantém o arquivo (`both` ou `binary`). `sourceKey` vira `binaryPropertyName`. Aviso: item sem o arquivo era pulado no n8n e aqui dá erro. JSON to Binary: Convert All Data vira toJson com um arquivo por item; um campo com Data Is Base64 vira toBinary; um campo de texto vira toText (sem Use Raw Data, aviso de que o n8n gravava o texto com JSON.stringify, entre aspas). `destinationKey` vira `binaryPropertyName`; tipo MIME diferente de application/json só passa no toBinary (nos outros, aviso). Sempre avisa que o nó novo devolve só o arquivo, sem os outros arquivos do item (e sem o JSON, quando Keep Source estava ligado).

**Limites**

- Sem XLS, ODS (leitura e escrita) e sem a detecção automática de formato do Spreadsheet File.
- PDF só com texto: PDFs escaneados precisam de OCR, que não existe aqui. O PDF inteiro é carregado em memória.
- O leitor de ICS não usa VTIMEZONE: fusos fora do padrão IANA ficam como UTC.
- A leitura de números no HTML e no RTF é simples (sem separador de milhar, porcentagem nem moeda).
- Os arquivos ficam em base64 dentro do item, como em todo o motor; planilhas e PDFs muito grandes pesam na memória do worker.

### Compression, Edit Image e Read/Write Files from Disk

**Arquivos**

- `packages/engine/src/nodes/files-disk.ts`: os três nós (`compression`, `editImage`, `readWriteFile`), a lista `fileDiskNodes` e utilitários exportados: `boundedGunzip`, `boundedUnzip`, `boundedUntar`, `createTar`, `parseColor`, `decodeBmp`, `encodeBmp`, `wrapText`, `resizeTarget`, `IMAGE_OPERATION_DEFAULTS`, `allowedRoots`, `resolveAllowedPath`, `findFiles`, `normalizeFileSelector`, `escapeBracketsAndParens` e os limites `MAX_DECOMPRESSED_SIZE`, `MAX_ARCHIVE_ENTRIES` e `MAX_READ_FILE_SIZE`.
- `packages/engine/src/n8n/convert-files-disk.ts`: `converters` com as chaves `compression`, `editImage`, `readWriteFile`, `readBinaryFile`, `readBinaryFiles` e `writeBinaryFile`.
- `packages/engine/test/files-disk.test.ts`: 30 testes (zip, gzip, tar e tar.gz de ida e volta; cada operação de imagem conferida com `sharp().metadata()` e pixels; leitura, glob e gravação numa pasta temporária; recusa de caminhos fora da pasta, com "..", por link simbólico e sem FILES_DIRS; conversores).
- Os arquivos usam os helpers de `binary.ts` (`toBinary`, `getBinary`, `getBinaryBuffer`, `binaryPropertyList`); o arquivo de um item fica em `item.binary[propriedade]`, no formato do n8n.

**Bibliotecas**

- fflate (zip e gzip), como o n8n. A leitura de gzip usa `zlib.gunzip` do Node com `maxOutputLength`, que para assim que o limite estoura.
- tar: o n8n usa o pacote `tar`, que não está instalado; o tar (ustar, com cabeçalho PAX para nomes acima de 100 bytes) é gravado e lido por código próprio, pequeno, em `files-disk.ts`.
- sharp (libvips) no lugar do GraphicsMagick (o `gm` do n8n), que não está na imagem Docker. BMP não existe no sharp; `decodeBmp`/`encodeBmp` leem BMP de 8, 24 e 32 bits sem compressão (e 32 bits com BI_BITFIELDS) e gravam BMP de 24 bits.
- fast-glob para os padrões do Read Files, como o n8n.

**Decisões e diferenças**

- **Estrutura dos parâmetros.** As "options" do n8n viraram campos de primeiro nível com `showWhen` (`destinationKey`, `fileName`, `font`, `format`, `quality` no Edit Image; `dataPropertyName`, `fileName`, `fileExtension`, `mimeType`, `literalBrackets` e `append` no Read/Write). O `fixedCollection` do Multi Step virou o campo `operations` (type `list`), uma linha por etapa com todos os campos (a tela não esconde campos dentro da lista). No Edit Image, campos que o n8n repete com padrões diferentes por operação existem uma vez com padrão vazio: `width`/`height` (50 ao criar, 500 ao cortar e redimensionar), `positionX`/`positionY` (50 no texto, 0 ao cortar e sobrepor) e `backgroundColor` (#ffffff00 ao criar, #ffffffff ao girar). Vazio vale o padrão do n8n para a operação (tabela `IMAGE_OPERATION_DEFAULTS`), também nas linhas do Multi Step; o conversor sempre preenche os valores. No Read/Write, `fileName` e `dataPropertyName` aparecem duas vezes (leitura e gravação), com o mesmo padrão, como no n8n.
- **Compression.** Segue a versão 1.1: parâmetros lidos por item; zip com nível 0 para extensões já compactadas (jpg, png, pdf, docx…) e 6 para o resto; gzip gera `nome.ext.gz` nos campos `data`, `data1`…; zip e tar num campo só. Descompactar decide pelo `fileExtension` (ou pela extensão do nome): zip, tar, tgz, `.tar.gz`, gz e gzip; ignora pastas e `__MACOSX`; entradas de tar absolutas, com ".." ou chamadas `__proto__`/`constructor`/`prototype` ficam de fora; cada arquivo extraído ganha `fileName` e `directory` (o `prepareBinaryData` do n8n faz o mesmo). Limites fixos de 512 MB descompactados e 10.000 arquivos por item (no n8n vêm do `CompressionNodeConfig`). O zip confere o tamanho declarado de cada entrada antes de descompactar (o fflate nunca escreve além dele) e a soma real depois; no n8n o inflate roda no pool do libuv, aqui o `unzipSync` do fflate roda na thread principal. Diferenças: no zip e no tar, arquivo sem nome usa o nome da propriedade (o n8n gravava "undefined"); no gzip sem extensão conhecida, o arquivo extraído fica sem extensão (o n8n detectava pelo conteúdo); o tipo MIME vem da tabela de `binary.ts`, não do `mime-types`.
- **Edit Image, cores.** `parseColor` segue o GraphicsMagick: em `#rrggbbaa` os dois últimos dígitos são opacidade (00 opaco, ff transparente). Por isso os padrões do n8n continuam certos (#ff000000 desenha vermelho opaco; #ffffff00 cria fundo branco opaco; #ffffffff deixa transparentes os cantos da rotação). Aceita também #rgb, #rrggbb, rgb()/rgba(), `transparent` e 22 nomes de cor; outros nomes dão erro claro.
- **Edit Image, pipeline.** A imagem é aberta já girada pela orientação EXIF (o `autoOrient` do n8n) e cada operação roda sobre os pixels RGBA crus, sem perda entre etapas; o formato de saída é aplicado no fim (padrão: o de entrada; SVG, HEIF e outros que o sharp não grava viram PNG; Criar sai em PNG). GIF animado: só o primeiro quadro. Qualidade: JPEG, WebP e TIFF usam a qualidade; no PNG, como no GraphicsMagick, ela vira o nível de compressão (dezenas). O campo de saída recebe os dados do arquivo anterior daquele campo (nome, pasta) como no n8n; com formato escolhido, a extensão do nome troca para o formato. Um campo de saída novo não herda o nome do arquivo de entrada (igual ao n8n).
- **Edit Image, operações.** Blur: `sharp.blur(sigma)`; o raio do GraphicsMagick não tem equivalente (sem sigma, usa metade do raio). Border: `extend`. Composite: `composite` com os operadores Over, In, Out, Atop, Xor, Multiply, Difference, Add, Plus (Add e Plus viram o `add` do sharp; no GraphicsMagick Add dá a volta no 255) e Copy (`source`); Bumpmap, os Copy de canal (CopyRed, CopyOpacity…), Divide, Minus e Subtract dão erro. A imagem de cima é recortada à parte visível, então posições negativas e sobras fora da borda funcionam. Crop: limitado à imagem (como o GraphicsMagick); começar fora da imagem dá erro. Draw: SVG sobreposto (retângulo de canto a canto, incluindo o pixel final, com `rx`/`ry` do raio; círculo com centro no início e raio até o ponto final; linha de 1 px). Resize: `resizeTarget` reproduz a geometria do GraphicsMagick: `!` exato, `%` porcentagem, `^` cobre a caixa, `>` só reduz, `<` só aumenta quando a imagem cabe inteira na caixa, `@` área máxima de largura × altura pixels, que só reduz (o GraphicsMagick arredonda um pouco diferente). Rotate: `rotate(ângulo, background)`, que aumenta a tela como o GraphicsMagick. Shear: `affine([1, tan X, tan Y, 1 + tan X·tan Y])` (inclina em X e depois em Y) com fundo transparente. Text: SVG com `<tspan>` por linha, quebra de linha igual à do n8n (`wrapText`), alinhamento pelo "gravity" do GraphicsMagick (o deslocamento X/Y conta a partir do lado ou do centro escolhido) e altura de linha de 1,2 × o tamanho. Transparent: pixels com a mesma cor RGB exata ficam com alfa 0 (sem tolerância, como o `transparent` sem fuzz). Information: devolve `format`, `Format`, `Geometry`, `size {width, height}`, `depth`, `Colorspace`, `channels`, `hasAlpha`, `Filesize`, `bytes` e, quando há, `Resolution`, `Orientation`, `Interlace` e `pages`; não é a saída completa do `identify` do GraphicsMagick, e a imagem passa sem ser regravada.
- **Edit Image, fonte.** No n8n a fonte é o caminho de um arquivo de fonte do servidor (`getSystemFonts`); aqui é o nome da família, resolvido pelo fontconfig do librsvg (padrão "DejaVu Sans, Arial, Helvetica, sans-serif"). Família inexistente cai na fonte padrão do sistema, sem erro.
- **Read/Write, pastas liberadas.** O nó só usa `ctx.filesDirs` (FILES_DIRS no servidor; no docker-compose, `/files` ligada a `./arquivos`). Sem pasta liberada, erro pedindo para configurar FILES_DIRS no .env; pastas configuradas que não existem são ignoradas. `resolveAllowedPath` resolve o caminho (relativo à primeira pasta), confere o caminho resolvido (`path.resolve` já elimina "..") contra as pastas e depois o caminho real (`fs.realpath` do arquivo ou da pasta existente mais próxima, para arquivo novo) contra o caminho real das pastas; links simbólicos para fora são recusados. A gravação abre o arquivo pelo caminho real com `O_NOFOLLOW` e cria as pastas que faltam (o n8n não cria). Na leitura, a parte fixa do padrão (o `base` de `fg.generateTasks`) precisa estar numa pasta liberada, e cada arquivo encontrado passa pelo `realpath`; os que caem fora são descartados (se só houver esses, erro).
- **Read/Write, leitura.** Igual ao n8n 1.1: `normalizeFileSelector` (caminhos do Windows) e `escapeBracketsAndParens` quando "Tratar [ ] e ( ) como texto" está ligado; desligado, `extglob: false`. Um item por arquivo com `binary[dataPropertyName]` (nome, pasta, extensão, tipo pela extensão) e JSON `{ mimeType, fileType, fileName, fileExtension, fileSize }`; nenhum arquivo encontrado é erro, com a dica sobre colchetes. A lista é ordenada (o n8n devolve na ordem do fast-glob). Limite de 512 MB por arquivo. Erros de permissão viram mensagens em português.
- **Read/Write, gravação.** Substitui ou, com `append`, acrescenta; devolve o item com o JSON de entrada mais `fileName` (o caminho como foi informado) e os mesmos arquivos.
- **Erros** usam `NodeOperationError` em português; "Continuar com erro" fica a cargo do executor (o n8n trata por item).

**Conversão do importador**

- `compression`: as duas operações; padrões do n8n preenchidos (`zip`, `data`, `file_`). V1 sem formato de saída vira zip com aviso; V1 com gzip usa `outputPrefix` como campo de saída, com aviso de que os nomes mudaram (data, data1 e `nome.ext.gz` no lugar de data0 e `nome.gzip`).
- `editImage`: cada operação com os padrões do n8n preenchidos (a exportação omite valores padrão); Multi Step converte `operations.operations` (linhas sem operação válida ficam de fora, com aviso); `options` viram os campos do nó. Avisos: fonte (caminho de arquivo no n8n, nome da família aqui), operador de Composite que não existe, Shear com fundo transparente, qualidade sem formato, Get Information com resumo. Na versão 1, o texto fica alinhado em cima à esquerda (a 1.1 centraliza).
- `readWriteFile`: leitura e gravação com as opções; aviso de que o caminho precisa estar numa pasta liberada em FILES_DIRS; versão 1 avisa que nenhum arquivo encontrado agora é erro.
- `readBinaryFile` (antigo): vira leitura com o caminho exato (curingas `* ? { } !` escapados), com aviso de que a saída agora traz os dados do arquivo no JSON em vez do JSON de entrada. `readBinaryFiles` (antigo): vira leitura com colchetes como padrão, com aviso de que agora lê uma vez por item de entrada. `writeBinaryFile` (antigo): vira gravação, com `append`. Todos avisam da pasta liberada.

**Limites e pendências**

- A imagem Docker instala `fonts-dejavu-core` e `fontconfig` na etapa final, para o Escrever texto ter fonte. Fora do Docker, o servidor precisa ter alguma fonte instalada.
- Operadores de Composite de canal e de subtração/divisão, o raio do Blur e a lista de fontes do servidor (o `getFonts` do n8n) não foram feitos.
- Os limites de descompactação e de leitura são constantes; não há variável de ambiente para mudar.

### Arquivos no HTTP Request, Gmail, HTML e Crypto

Arquivos alterados: `packages/engine/src/nodes/http-request.ts`, `src/nodes/gmail.ts`, `src/nodes/formats.ts`, `src/n8n/convert-formats.ts`, `src/n8n/import.ts` (só as funções `httpRequest` e `gmail`) e os testes `test/executor.test.ts` (HTTP), `test/gmail.test.ts`, `test/formats.test.ts` e `test/n8n-import.test.ts`. Todos usam os helpers de `src/binary.ts` (`toBinary`, `getBinary`, `getBinaryBuffer`, `binaryPropertyList`, `mimeTypeFromFileName`, `extensionFromMimeType`), sem alterá-lo.

#### HTTP Request

**Parâmetros novos (todos com padrão que preserva o comportamento antigo)**

| Parâmetro | Padrão | n8n |
|---|---|---|
| `bodyType: 'multipart'` + `multipartBody: [{ parameterType, name, value }]` | não usado | `contentType: 'multipart-form-data'`, `bodyParameters.parameters[]` com `parameterType: 'formData' \| 'formBinaryData'` |
| `bodyType: 'binary'` + `inputDataFieldName` | `data` | `contentType: 'binaryData'`, `inputDataFieldName` |
| `responseFormat: 'autodetect' \| 'json' \| 'text' \| 'file'` | `autodetect` | `options.response.response.responseFormat` |
| `outputPropertyName` | `data` | `options.response.response.outputPropertyName` |

Decisões:

- **Multipart em lista de 3 colunas.** No multipart o n8n tem `value` (texto) e `inputDataFieldName` (arquivo) em campos separados. A lista do editor mostra todos os campos em cada linha (não há `showWhen` dentro de linhas), então usei `value` para os dois: no tipo Arquivo, é a propriedade do arquivo. O importador mapeia `inputDataFieldName` para `value`.
- **`multipart` é um tipo novo**, separado de `form` (x-www-form-urlencoded), para não mudar o que `form` envia nos fluxos salvos.
- **Multipart com fetch nativo** (`FormData` + `Blob`): o boundary é gerado pelo fetch. Se o usuário pôs `Content-Type: multipart/form-data` à mão nos headers, o header é removido para não perder o boundary.
- **Corpo binário:** `Content-Type` vem do mimeType do arquivo, a menos que exista nos headers.
- **Nome do arquivo da resposta:** `filename*` (RFC 5987, UTF-8) do Content-Disposition, depois `filename` (com ou sem aspas, sem caminho), depois o último segmento da URL final (`response.url`, ou seja, após redirecionamentos), decodificado. Sem nenhum, o arquivo fica sem `fileName` (a extensão sai do mimeType), como no n8n. Funções exportadas `fileNameFromDisposition` e `isBinaryContentType`.
- **mimeType sem parâmetros:** guardo `text/csv`, não `text/csv; charset=utf-8`. O n8n guarda o Content-Type como veio.
- **Detecção do automático (`isBinaryContentType`):** é arquivo todo Content-Type não vazio que não seja `text/*` nem contenha `json`, `xml`, `javascript`/`ecmascript`, `x-www-form-urlencoded`, `yaml`, `csv` ou `graphql`. O n8n usa uma lista fechada de tipos binários (image/, audio/, video/, application/octet-stream, zip, gzip, pdf, msword etc.) e trata o resto como texto; a regra daqui é mais abrangente (ex.: `application/vnd.ms-excel` e `.xlsx` viram arquivo). Corpo vazio no automático continua sem item.
- **Texto no automático/Texto:** vai para `outputPropertyName` (padrão `data`, igual ao antigo `{ data: texto }`). Valores primitivos de uma lista JSON também usam a propriedade.
- **JSON:** resposta que não é JSON dá erro ("A resposta não é um JSON válido...") com os 2000 primeiros caracteres no detalhe. Resposta vazia vira nenhum item.
- **Resposta completa + arquivo:** `json: { statusCode, headers }` e o arquivo em `binary[outputPropertyName]` (o n8n faz igual).
- **Erro HTTP com corpo binário:** o detalhe mostra `(arquivo de N bytes, tipo)` em vez de texto ilegível.
- A resposta agora é lida com `arrayBuffer()` (antes `text()`); texto é decodificado como UTF-8, como antes.
- Formato da resposta vale também no modo "API cadastrada" (catálogo). O corpo do catálogo não ganhou arquivo.

**Compatibilidade com fluxos salvos**

- Sem `responseFormat` salvo, vale `autodetect`. JSON e texto continuam iguais. **Muda:** respostas com Content-Type binário (PDF, imagem, octet-stream, zip, Excel...) antes viravam `{ data: "<bytes como texto UTF-8, corrompido>" }` e agora viram arquivo em `binary.data`, com `json: {}`. Quem dependia do texto corrompido (pouco provável) pode escolher Formato **Texto**.
- `bodyType` antigos (`none`, `json`, `form`, `text`) não mudaram.

#### Gmail

**Parâmetros novos**

| Parâmetro | Padrão | n8n |
|---|---|---|
| `attachmentProperties` (Enviar, Responder, Criar rascunho) | `''` | `options.attachmentsUi.attachmentsBinary[].property` (cada uma pode ter várias separadas por vírgula) |
| `attachmentsPrefix` (Buscar, Buscar rascunhos, Ler) | `attachment_` | `options.dataPropertyAttachmentsPrefixName` |
| `attachmentsBase64InJson` | `true` | não existe (compatibilidade); o importador grava `false`, como o n8n |

- Anexos do item somam aos da lista `attachments` (arquivos da tela e base64), nesta ordem: lista da tela primeiro, depois os do item. Propriedade inexistente dá o erro do `getBinary` (lista os arquivos do item). Arquivo sem `fileName` vira `anexo-<n>.<extensão do mimeType>`.
- Download: cada anexo vira `binary[<prefixo><índice>]` (índice na ordem dos anexos do e-mail, como o n8n); o JSON mantém `attachments[]` com `fileName`, `mimeType`, `size`, `attachmentId` e o novo `binaryProperty`. Item sem anexos não ganha `binary`.
- `readMessage` passou a devolver um `Item` (json + binary); em Buscar rascunhos o `binary` é preservado ao trocar o `id` pelo do rascunho.

**Compatibilidade**

Os nós salvos não guardam os padrões dos campos (o editor só grava o que foi editado), então não dá para distinguir um nó antigo de um novo. Para não quebrar fluxos salvos que leem `attachments[n].content`:

1. **Também pôr o conteúdo em base64 no JSON** vem ligado por padrão: o conteúdo continua em `attachments[n].content` além do arquivo. Fluxos importados do n8n recebem `attachmentsBase64InJson: false` e ficam só com os arquivos, como lá. Desligar a opção deixa a execução bem menor.
2. Para não haver falha silenciosa (antes, um anexo com conteúdo vazio era pulado sem aviso), o envio verifica o parâmetro **cru** de cada linha de `attachments` (`ctx.node.parameters`): se o conteúdo era uma expressão que lê `attachments...content` e resolveu vazio, o nó dá erro explicando as duas correções. Expressões vazias que não leem `attachments...content` continuam sendo puladas como antes.

#### HTML

- `sourceData` ganhou `binary` ("Arquivo do item"); `dataPropertyName` passa a ser a propriedade do arquivo nesse caso (o n8n usa o mesmo parâmetro). O conteúdo é lido como UTF-8, como no n8n. A saída continua só com JSON (o n8n também não repassa o arquivo).

#### Crypto

- `binaryData` (boolean) e `binaryPropertyName` (padrão `data`), só para Hash e HMAC, como no n8n. O hash é dos bytes do arquivo. `value` some da tela quando `binaryData` está ligado (`showWhen: { binaryData: [false] }`; nos fluxos salvos o padrão `false` mantém o campo visível).
- O Crypto agora repassa `item.binary` na saída (o n8n faz isso); antes descartava. Não muda nada para fluxos sem arquivo.

#### Importador do n8n

- `convert-formats.ts`: Crypto com `binaryData: true` (hash/hmac) vira `binaryData` + `binaryPropertyName` (sem `value`); HTML/HTML Extract com `sourceData: 'binary'` vira `sourceData: 'binary'`. Os `return null` com aviso foram removidos.
- `import.ts`, `httpRequest` v3+: `contentType: 'multipart-form-data'` → `multipart` (linhas `formBinaryData` com `inputDataFieldName` → `value`); `binaryData` → `binary` + `inputDataFieldName`; `responseFormat` json/text/file (+ `outputPropertyName` para text e file); `autodetect` não é gravado (é o padrão). Outros tipos de corpo seguem com aviso.
- `httpRequest` v1/v2: `sendBinaryData` + `binaryPropertyName` → no multipart, cada `campo:propriedade` (ou só `propriedade`, que vira também o nome do campo) vira uma linha `formBinaryData`, somada aos `bodyParametersUi` como linhas de texto; fora do multipart, corpo `binary`. `responseFormat: 'file' | 'string'` → `file`/`text` com `outputPropertyName = dataPropertyName`. Multipart sem arquivo também é importado (antes dava aviso); multipart com "JSON Parameters" avisa para passar os campos à lista.
- `gmail`: `attachmentsUi.attachmentsBinary[].property` → `attachmentProperties` juntando as linhas com vírgula; se alguma linha é expressão, o resultado vira uma expressão só (`=data, {{ $json.arquivo }}`). `dataPropertyAttachmentsPrefixName` → `attachmentsPrefix`. O aviso "os anexos do n8n vinham de dados binários" foi removido.

#### Limites

- Tudo em memória: a resposta inteira é lida num Buffer e guardada em base64 no item (≈ +33%). Não há streaming nem limite de tamanho próprio no nó; arquivos de centenas de MB pesam na memória do worker.
- Multipart: não dá para escolher o nome do arquivo ou o tipo por linha (vêm do arquivo do item; sem nome, usa o nome do campo).
- O formato da resposta não aceita "anexar o arquivo da entrada" nem repassa os arquivos de entrada para a saída (o n8n também não repassa).
- Detecção do automático por Content-Type apenas (não olha os bytes). Servidor que responde PDF como `text/plain` dá texto; use Formato **Arquivo**.
- Gmail: não há opção para escolher quais anexos baixar; todos os anexos (inclusive imagens inline com nome) viram arquivos.

## Gatilhos, webhooks e pausa de execuções (vindos do n8n)

Fase 3 do pedido de ter os nós de Core e Flow do n8n: Webhook, Respond to Webhook, Form Trigger, Form, Error Trigger, n8n Trigger, RSS Feed Trigger, Email Trigger (IMAP), Local File Trigger, SSE Trigger e o Wait que pausa de verdade e retoma por tempo, webhook ou formulário.

**Arquivos**

| Arquivo | Conteúdo |
| --- | --- |
| `packages/engine/src/nodes/webhook.ts` | Nós `webhook`, `respondToWebhook`, `formTrigger`, `form`, `errorTrigger`, `n8nTrigger` (lista `webhookNodes`), o item do webhook (`webhookItem`), as respostas (`immediateResponse`, `lastNodeResponse`) e `N8N_TRIGGER_EVENTS` |
| `packages/engine/src/forms.ts` | Campos de formulário (`formFieldsProperty`, `readFormFields`), página HTML (`renderFormPage`, `renderMessagePage`), item do envio (`formSubmissionItem`) e `sanitizeHtml` |
| `packages/engine/src/nodes/triggers-listen.ts` | `rssFeedReadTrigger`, `emailReadImap`, `localFileTrigger`, `sseTrigger` (lista `listenTriggerNodes`) e `pollTimesToCrons` |
| `packages/engine/src/nodes/flow-extra.ts` | Wait com os quatro modos de retomada |
| `packages/engine/src/executor.ts` | Pausa (`status: 'waiting'`, `resumeState`) e retomada (`resume`) |
| `packages/engine/src/n8n/convert-triggers-webhook.ts`, `convert-triggers-listen.ts` | Conversores do importador |
| `apps/server/src/triggers/manager.ts` | `TriggerManager`: registro dos webhooks e formulários, ouvintes, consultas periódicas, n8n Trigger e escuta de teste |
| `apps/server/src/routes/webhooks.ts` | Rotas públicas `/webhook*` e `/form*` |
| `apps/server/src/executions/events.ts` | `ExecutionEvents`: espera eventos de uma execução pelo Redis |
| `apps/server/test/triggers.test.ts`, `packages/engine/test/triggers-listen.test.ts`, `n8n-triggers-webhook.test.ts`, `flow-extra.test.ts` | Testes |

Bibliotecas novas no motor: `rss-parser` (RSS, a mesma do n8n), `imapflow` (IMAP com IDLE; o n8n usa `imap-simple`, sem manutenção), `mailparser` e `libmime` (e-mail), `chokidar` 5 e `picomatch` (pasta e padrões Ignorar). O SSE usa `fetch` com um leitor próprio.

**Pausa e retomada**

- O nó pede a pausa com `ctx.putToWait({ kind, until?, config? })`. Quando o executor roda com `canWait: false` (subfluxos), a função devolve `false` e o nó espera rodando (Wait por tempo, até 24 dias) ou dá erro (webhook e formulário).
- Depois do nó, o executor devolve `status: 'waiting'`, `wait` (`{ kind, nodeId, nodeName, until?, config? }`) e `resumeState`: os nós já rodados, as saídas, as filas de nós prontos e esperando entrada, o estado dos nós (Loop), o contador e o nó pausado com as entradas dele. O nó pausado não entra na lista de nós rodados.
- Na retomada (`resume: { state, data }`), o executor restaura o estado e roda de novo o nó pausado com `ctx.resumeData` (`{ kind, items? }`). Sem `items` (o tempo acabou), o Wait devolve os itens de entrada; com `items`, devolve os itens recebidos.
- Waits menores que 65 s ficam rodando no worker, como no n8n.
- No servidor, `saveResult` grava `status = 'waiting'`, `wait_till`, `wait_info` e `resume_state` (JSON com gzip). A espera por tempo vira um job atrasado `resume-<id>` no BullMQ. O webhook e o formulário de retomada fazem `UPDATE ... SET status = 'queued', resume_data = ... WHERE status = 'waiting'` (só uma chamada ganha; a outra recebe 409), cancelam o job de tempo e enfileiram com um jobId novo (`<id>-<timestamp>`), porque o BullMQ ignora um job com o mesmo ID de um que já rodou.
- `$execution.resumeUrl` e `$execution.resumeFormUrl` são `PUBLIC_URL` + `/webhook-waiting/<id>` e `/form-waiting/<id>`. Sem `PUBLIC_URL`, `http://localhost:<PORT>`.
- Cancelar uma execução em espera muda o status para `canceled` e apaga o job de tempo.

**Rotas públicas**

São registradas fora de `/api`, sem login, com os caminhos do n8n. Têm um leitor de corpo próprio (buffer de até 16 MB): JSON, `application/x-www-form-urlencoded`, `multipart/form-data` (lido com `Response.formData()`), texto e binário.

| Rota | Faz |
| --- | --- |
| `GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS /webhook/*` | Webhook de produção (fluxo ativo). OPTIONS responde o preflight de CORS |
| `.../webhook-test/*` | Webhook de teste, enquanto o editor escuta |
| `/webhook-waiting/:id` e `/webhook-waiting/:id/*` | Retoma um Wait por webhook |
| `GET/POST /form/*` e `/form-test/*` | GET mostra o formulário; POST valida e cria a execução |
| `GET/POST /form-waiting/:id` | Página de um Form ou Wait por formulário que está esperando |

- O webhook confere IP (`BlockList` do Node, com faixas CIDR), robôs (user-agent) e autenticação (Basic com `WWW-Authenticate`, ou header, pelas conexões `httpBasicAuth` e `httpHeaderAuth`) antes de criar a execução.
- A execução nasce com `mode = 'webhook'` (ou `manual` no teste), `start_node_id` = o nó do gatilho e o item como entrada.
- Respostas: Logo que receber responde na hora; Quando o último nó terminar e Pelo Respond to Webhook assinam o canal Redis `sa:exec:<id>` antes de enfileirar e esperam `response`, `waiting` ou `finished`, por até 10 minutos (depois, 504 com o ID da execução). O worker só publica quando há alguém assinando (`PUBSUB NUMSUB`).
- HTML escrito pelo usuário (Respond to Webhook em texto HTML, Tela final em HTML) vai com `Content-Security-Policy: sandbox`, para não rodar script no domínio do Info8n.
- Um formulário com Form depois do Form Trigger: o POST da primeira página espera o evento `waiting` e redireciona para `/form-waiting/<id>`. Cada página seguinte faz o mesmo até a Tela final.

**TriggerManager**

Roda no processo da API (`index.ts` chama `triggers.start()` depois do `listen` e `close()` ao desligar). Com vários processos de API, cada um teria os próprios ouvintes: rode uma API só.

- `start()` lê os fluxos ativos e chama `sync` para cada um. `sync(fluxo, { strict })` registra os webhooks e formulários em memória e liga os ouvintes. Ativar usa `strict: true`: se um ouvinte não inicia (senha IMAP errada, pasta fora de FILES_DIRS), a ativação volta atrás com 400 "O gatilho não iniciou: ...". Salvar um fluxo ativo chama `sync` de novo; desativar e excluir chamam `remove`.
- `conflicts()` recusa dois fluxos ativos com o mesmo método e caminho (ou o mesmo caminho de formulário). Caminho vazio vale o ID do nó.
- Nós com `listen(ctx)` (IMAP, pasta, SSE) recebem um `TriggerContext` com `emit(items)`, `emitError`, `signal`, os parâmetros resolvidos, `getConnection`, `filesDirs` e `staticData`, e devolvem a função que fecha. Nós com `poll(ctx)` (RSS) rodam nos crons de `pollTimesToCrons(parameters.pollTimes)` e devolvem `Item[]` ou `null`.
- `staticData` fica na tabela `workflow_static_data` (por fluxo e nó): último e-mail do IMAP, data do último item do RSS.
- Cada disparo cria uma execução `mode = 'trigger'` com `start_node_id` e os itens como entrada.
- n8n Trigger: `fireEvent(fluxo, 'activate' | 'update' | 'init')`, chamado ao ativar, ao salvar ativo e no `start()`.
- Escuta de teste (`POST /api/workflows/{id}/listen`): registra os webhooks e formulários de teste e liga os ouvintes com a definição enviada, por 120 s, com `ctx.testing = true`. O primeiro evento cria uma execução `manual` com todos os dados, guarda o ID (lido por `GET .../listen`) e fecha a escuta.

**Fluxo de erro**

`definition.settings.errorWorkflowId` aponta para um fluxo que começa pelo Error Trigger (conferido ao salvar). Quando uma execução `schedule`, `webhook` ou `trigger` termina com erro, o worker cria uma execução `mode = 'error'` desse fluxo, começando pelo Error Trigger, com o item `{ execution: { id, url, retryOf?, error: { message, details? }, lastNodeExecuted, mode }, workflow: { id, name } }`, como o n8n. O `url` é `PUBLIC_URL` + `/execucoes/<id>`.

**Vários gatilhos por fluxo**

A regra de um gatilho por fluxo saiu do `validate.ts`. `executions.start_node_id` diz de onde começar; sem ele (botão Executar), o executor começa pelo gatilho manual ou, sem ele, pelo primeiro gatilho. Agendamentos gravam o `scheduleTrigger` como início.

**Gatilhos que escutam e consultam**

- RSS: igual ao n8n. Guarda `lastItemDate`; na primeira consulta só guarda a data; depois devolve os itens com `isoDate` maior, na ordem do feed. Pelo botão Executar, devolve o item mais recente sem mexer no estado. Campo extra `ignoreSSL`. Os horários (`pollTimes`) viram crons de 6 campos com segundo 0: `everyMinute` `0 * * * * *`, `everyHour` `0 {minuto} * * * *`, `everyDay`, `everyWeek`, `everyMonth`, `everyX` (`*/N` minutos ou horas) e `custom`.
- IMAP: conexão `imap` (`host`, `port`, `user`, `password`, `secure`, `allowUnauthorizedCerts`). Conecta, abre a caixa, busca os e-mails dos critérios e fica em IDLE; cada `exists` busca de novo, em fila. Com `trackLastMessageId`, busca `uid > último` e guarda também o `uidValidity` (caixa recriada zera o último). Os critérios no formato do node-imap viram o `SearchObject` do imapflow (flags, `!`, FROM/TO/SUBJECT..., datas, LARGER/SMALLER, HEADER, OR). Marcar como lido é um `STORE +FLAGS \Seen` depois de baixar. Formatos simples, completo (`simpleParser`) e bruto (`raw` é o e-mail inteiro em base64; no n8n, só o corpo). Reconexão com espera de 2 s a 60 s; `forceReconnect` reconecta no intervalo.
- Pasta: `resolveAllowedPath` de `files-disk.ts` limita a FILES_DIRS. Chokidar com `awaitWriteFinish`, `followSymlinks`, `depth`, `ignoreInitial`, `usePolling`; Ignorar é um glob do picomatch testado contra o caminho completo. Saída `{ event, path }`, uma execução por evento.
- SSE: `fetch` com `Accept: text/event-stream` e um leitor que segue a especificação (linhas cortadas entre pedaços, `data` de várias linhas, `id`, `retry`, comentários). Só eventos `message` disparam; JSON objeto vira o item, o resto vai em `data`. Reconecta com `Last-Event-ID` e espera crescente até 60 s; HTTP 204 para de vez.

**Importador do n8n**

| n8n | Info8n |
| --- | --- |
| `webhook` (`httpMethod`, `path`, `authentication`, `responseMode`, `responseCode`, `responseData`, `options.*`) | `webhook` com as opções em primeiro nível. Caminho com `:param` vira `<webhookId>/<caminho>`, como o endereço do n8n; caminho vazio vira o `webhookId`. Vários métodos ficam com o primeiro e avisam. Basic e Header viram conexões a recriar; JWT avisa |
| `respondToWebhook` | Mesmos modos; texto vem de `responseBody`; JWT vira JSON com aviso |
| `formTrigger`, `form` | `formFields.values[]` vira a lista de campos; `fieldOptions.values[].option` vira uma opção por linha; HTML vai para Valor; formulário definido por JSON avisa |
| `wait` (webhook, form) | Mesmos campos; `options.webhookSuffix`, `incomingAuthentication` e os limites de espera são convertidos. Avisa para configurar `PUBLIC_URL` |
| `errorTrigger`, `n8nTrigger` | Iguais |
| `rssFeedReadTrigger`, `emailReadImap`, `localFileTrigger`, `sseTrigger` | Mesmos nomes em primeiro nível; IMAP pede a conexão; Local File avisa sobre FILES_DIRS e polling; `ignoreMode: contain` vira `**/*texto*{,/**}` |
| `settings.errorWorkflow` do fluxo | `settings.errorWorkflowId`, quando o fluxo de erro é importado junto ou já foi importado; senão, aviso |

**Tela**

- A chave Ativo aparece quando o fluxo tem um gatilho com `activatable: true` (vem de `GET /api/node-types`; `GET /api/workflows` traz `activatable` por fluxo).
- A janela do Webhook e do Form Trigger mostra os endereços de teste e de produção, montados com `window.location.origin`.
- Escutar chama `POST /api/workflows/{id}/listen` com a definição da tela e consulta `GET .../listen` a cada segundo até aparecer `executionId`; depois acompanha a execução como o botão Executar. Execuções em espera continuam sendo acompanhadas (a cada 2 s) até terminarem ou o usuário parar.
- Configurações do fluxo grava `definition.settings.errorWorkflowId`.
- No modo de desenvolvimento, o Vite repassa `/webhook*` e `/form*` para a porta 3000.

**Limites**

- Corpo de webhook e formulário: 16 MB. Resposta síncrona: 10 minutos. Escuta de teste: 2 minutos.
- Os ouvintes e o registro de webhooks vivem num processo de API; não rode mais de uma API.
- IMAP sem OAuth2; SSE sem cabeçalhos nem autenticação; RSS sem proxy e sem cancelamento além do tempo limite de 60 s.
- Wait dentro de subfluxo não pausa (espera rodando, até 24 dias) e não aceita webhook nem formulário.

## Banco de dados

A plataforma usa um Postgres próprio, com 17 tabelas criadas e atualizadas automaticamente ao subir (`db/migrations.ts`). Não há passo manual de migração.

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
| `executions` | Execuções: modo, status, erro, resumo, dados comprimidos, execução pai, nó de início e, nas que estão esperando, até quando, o que esperam e o estado para retomar |
| `workflow_static_data` | Estado dos gatilhos por fluxo e nó (último e-mail lido, data do último item do RSS) |
| `db_commands` | Cada comando SQL executado nos bancos dos clientes |
| `audit_log` | Quem fez o quê, com antes e depois |
| `erps`, `erp_endpoints`, `erp_clients` | Catálogo de APIs por ERP e cadastro do cliente em cada ERP |
| `files` | Arquivos escolhidos na tela (ex.: anexos do Gmail): nome, tipo, tamanho, conteúdo e quem enviou |
| `execution_files` | Arquivos gerados pelos nós nas execuções manuais e reexecuções, pelo hash do conteúdo, para baixar na tela |

**Tamanho e retenção dos logs**

- Execuções agendadas que terminam com sucesso guardam só um resumo. Para guardar também os dados, use `KEEP_SUCCESS_DATA=true`.
- Execuções com erro, manuais e reexecuções guardam entrada e saída de cada nó, comprimidas com gzip.
- Cada nó guarda até 256 KB de dados, e cada execução até 16 MB. Acima disso fica só a contagem de itens.
- Arquivos dos itens: o conteúdo só é guardado nas execuções manuais e reexecuções (tabela `execution_files`, até 64 MB por execução, arquivos iguais contam uma vez). Nas outras, o histórico fica só com nome, tipo e tamanho.
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

**Anexos escolhidos na tela.** O campo do tipo `file` (Arquivo, nos anexos do Gmail) envia o arquivo para `POST /api/files` como está no corpo (`application/octet-stream`, até 25 MB), sem base64. O servidor guarda o conteúdo em `files` (bytea) e o campo guarda só o ID, para não repetir o arquivo em cada versão do fluxo nem na auditoria. Na execução, o worker passa `getFile(id)` ao motor e o nó Gmail lê o arquivo dali; nome e tipo vêm do arquivo quando o nó não informa outros. Se o arquivo não existir mais, o nó falha pedindo para escolher de novo. Os arquivos não são apagados quando saem do fluxo, e um fluxo levado para outro Info8n precisa ter os arquivos escolhidos de novo.

Buscar rascunhos lista `GET /drafts` (com `q` e `maxResults`, seguindo `nextPageToken` até o máximo) e lê cada e-mail em `GET /messages/{id}?format=full`, como a busca de e-mails. No item, `id` é o ID do rascunho (o que `POST /drafts/send` e `DELETE /drafts/{id}` pedem) e `emailId` é o ID da mensagem.

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
| `FILES_DIRS` | Não | /files no docker-compose; vazio fora dele | Pastas do servidor que os nós Read/Write Files from Disk e Local File Trigger podem usar, separadas por vírgula. No Docker Desktop (Windows ou Mac), o Local File Trigger precisa de Verificar por consulta (polling) |
| `RUN_WORKER_IN_PROCESS` | Não | true | false = worker em processo separado |
| `SECURE_COOKIES` | Não | false | true quando estiver atrás de HTTPS |
| `PUBLIC_URL` | Não | endereço aberto na tela; nos endereços de retomada, `http://localhost:<PORT>` | Endereço pelo qual o Info8n é acessado (ex.: `http://info8n.empresa.local:3000`). Define o endereço de retorno do login com Google (precisa ser localhost ou um domínio, não IP), `$execution.resumeUrl`, `$execution.resumeFormUrl`, o `webhookUrl` dos webhooks e o link da execução no fluxo de erro. Configure sempre que usar Wait por webhook ou formulário |

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
