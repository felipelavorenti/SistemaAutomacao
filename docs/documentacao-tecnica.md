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
- `routes/`: `auth`, `workflows`, `executions`, `connections`, `oauth` (login com Google das conexões do Gmail), `files` (arquivos escolhidos na tela, como anexos), `catalog` (ERPs e clientes), `db-commands`, `admin` (usuários, pastas, clientes, auditoria).
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

- Filter e Switch reaproveitam evaluateCondition do If e os mesmos operadores, lidos da descrição do ifNode (OPERATORS não é exportado em if.ts e não editei esse arquivo). A opção ignoreCase converte para minúsculas os textos (e listas de textos) dos dois lados antes de comparar; na regex usa a flag i em vez de mexer no padrão. looseTypeValidation do n8n não foi criada porque evaluateCondition já compara de forma tolerante (número e texto numérico são iguais).
- Filter tem uma saída, como o Filter v2 do n8n (a saída de descartados do n8n não é usada).
- Switch: as saídas vêm de description.dynamicOutputs (modo rules: uma por regra, nome em outputKey, mais "Outros" quando fallbackOutput = extra; modo expression: numberOutputs, até 64). O execute devolve exatamente resolveOutputs(...).count listas, calculado com ctx.node.parameters. Como um campo options não lista as regras dinamicamente, "mandar para a saída de uma regra" é fallbackOutput = 'output' mais o número em fallbackIndex; o execute também aceita fallbackOutput numérico. Índice inválido (fallback ou expressão) gera erro com a faixa válida. Cada regra tem uma condição só (campo list não tem lista dentro de lista).
- Compare Datasets segue a versão 2.3 do n8n: itens com JSON vazio são ignorados; item de A sem algum campo de casamento vai para "só em A"; um item de B pode casar com vários de A; preferInput2 com comparação tolerante manda a versão de B para "iguais"; includeBoth gera keys/same/different/skipped como o n8n (campos ausentes viram null; campos ignorados com ponto, como end.cep, vão para skipped dentro do objeto pai). Nomes com ponto sempre são lidos como caminho (não há a opção Disable Dot Notation). A comparação tolerante reproduz o fuzzyCompare do n8n (versão 2): nulo, 0 e "0"; vazio, nulo e lista vazia; número e texto; objeto e JSON em texto; booleano e "true"/"1"/"false"/"0".
- Wait: espera com setTimeout em partes de até 2^31-1 ms, escutando ctx.signal; ao abortar limpa o timer e rejeita com o motivo do sinal, e o executor transforma em execução cancelada (o teste confirma status 'canceled'). Data passada não espera. A data aceita aaaa-mm-ddThh:mm:ss(.mmm) no fuso do nó (parseLocalDateTime de schedule.ts) ou ISO com Z/±hh:mm. Grava meta.waitUntil no modo data e hora.
- Limite de tempo do Wait: o briefing sugeria 31 dias, mas o executor usa AbortSignal.timeout(timeoutMs), e o Node não aceita mais que 2^31-1 ms (uns 24,8 dias): acima disso o timer dispara na hora e o nó falha com "passou do tempo limite" imediatamente. Por isso defaultTimeoutMs = 2.147.483.647 ms e o nó recusa esperas maiores que 24 dias com erro claro. Isso vale para qualquer nó: um timeoutMs configurado acima de 24,8 dias quebra o nó. Para esperas mais longas, o executor precisaria de um timeout próprio em partes (pendência sugerida).
- Execution Data segue o customData do n8n: chave só com A-Z, a-z, 0-9 e _ (senão erro), cortada em 50; valor convertido em texto e cortado em 512; no máximo 10 chaves distintas (a 11ª dá erro); chave vazia é ignorada; com vários itens, o último vence. O resultado vai em ctx.meta.executionData só quando há alguma chave.

**Como o importador converte**

- filter (v1 e v2): reaproveita ifNode de import.ts (mesmos operadores e avisos). v1 lê combineConditions (AND/OR). ignoreCase vem de options.ignoreCase = true ou de conditions.options.caseSensitive = false. Só a saída 0 do n8n é ligada.
- switch v3 (typeVersion ≥ 3 ou rules.values): cada regra passa pelo ifNode; regra com várias condições fica só com a primeira e gera aviso dizendo quantas eram e se eram E ou OU (não há como representar várias condições por regra). outputKey vira o nome da saída. options.fallbackOutput: 'extra' vira extra (renameFallbackOutput gera aviso, porque aqui o nome é "Outros"), número vira 'output' + fallbackIndex. allMatchingOutputs e ignoreCase são copiados. Modo expression copia numberOutputs e output.
- switch v1/v2 (rules.rules com value1, dataType, operation, value2): cada regra vira left = value1. Operações mapeadas: equal, notEqual, contains, notContains, startsWith, endsWith, regex, larger, largerEqual, smaller, smallerEqual, after, before. notStartsWith e notEndsWith com valor fixo viram regex com lookahead negativo; com expressão, e notRegex, viram "é igual a" com aviso. dataType dateTime gera aviso de que as datas são comparadas como texto. v2: cada regra já é a saída de mesmo número; fallbackOutput ≥ 0 vira 'output'. v1: as 4 saídas fixas viram uma saída por regra, com outputMap ligando cada saída do n8n à primeira regra que ia para ela (aviso quando várias regras dividiam uma saída); fallback para uma saída usada por regra vira 'output', senão vira a saída extra e o mapa liga essa saída do n8n a "Outros". Modo expression: outputsAmount (v2) ou 4 (v1).
- compareDatasets: mergeByFields.values, resolve (padrão preferInput2 até a v2 e includeBoth depois), fuzzyCompare (nas opções na v1), preferWhenMix e exceptWhenMix, options.skipFields e options.multipleMatches. Avisa sobre Disable Dot Notation e sobre versões anteriores à 2.2 (que davam erro quando o campo de casamento faltava).
- wait: timeInterval com os padrões de cada versão (v1: 1 hora; v1.1: 5 segundos). specificTime: data com Z/offset é reescrita na hora local do fuso do fluxo; sem fuso, só troca o espaço por T; expressão é mantida com aviso sobre o formato. webhook e form devolvem null (vira nó não convertido) com aviso de que retomar por webhook ou formulário ainda não existe; os limites de espera desses modos não são convertidos.
- noOp: vira noOp.
- executionData: dataToSave.values vira a lista key/value; mais de 10 pares geram aviso.

**Limites**

- Uma condição por regra no Switch.
- Wait de no máximo 24 dias e sem retomada por webhook ou formulário; a execução fica ocupando o worker durante a espera.
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
- `itemLists` (todas as versões): `limit`, `sort`, `removeDuplicates` e `summarize` viram os nós acima (no Remove Duplicates, aceita também a forma antiga `{ fields: [{ fieldName }] }`; no Summarize, segue a regra da versão 1). `splitOutItems` e `aggregateItems`/`concatenateItems` devolvem null com aviso, porque os conversores de Split Out e Aggregate do `import.ts` não são exportados; se forem exportados, basta chamá-los com o mesmo `ctx` (os parâmetros do Item Lists têm os mesmos nomes dos nós Split Out e Aggregate).

**Limites**

- Sem a deduplicação entre execuções do n8n.
- O tipo `list` não permite listas aninhadas, por isso as trocas por regex ficam numa lista separada.

### Date & Time, Crypto, HTML, Markdown, XML e TOTP

**Arquivos**

- `packages/engine/src/nodes/formats.ts`: os seis nós (`dateTime`, `cryptoNode` com type `crypto`, `html`, `markdown`, `xml`, `totp`), a lista `formatNodes` com todos eles e utilitários exportados (`parseDate`, `setPath`, `formatPem`, `htmlToText`, `capitalizeHeader`, `DATE_OUTPUT_DEFAULTS`, `DEFAULT_DATE_TIMEZONE`, `HTML_PLACEHOLDER`).
- `packages/engine/src/n8n/convert-formats.ts`: `converters` com as chaves `dateTime`, `crypto`, `html`, `htmlExtract`, `markdown`, `xml` e `totp`, e `momentToLuxon` (tradução de formatos do moment para o luxon).
- `packages/engine/test/formats.test.ts`: 35 testes (cada operação de cada nó e cada conversor), com datas e relógio fixos.

Para integrar, o agente principal precisa registrar `formatNodes` no `registry.ts`, chamar `converters[shortType]` no `convertNode` do `import.ts` e criar os tipos de conexão `cryptoPrivateKey` (campo `privateKey`, texto PEM de várias linhas, secreto) e `totp` (campos `secret`, base32 secreto, e `label`, opcional no formato emissor:usuário).

**Bibliotecas**

As mesmas do n8n: luxon (Date & Time), node:crypto (Crypto), cheerio (HTML), showdown e node-html-markdown (Markdown), xml2js (XML) e otpauth (TOTP). Duas dependências do n8n não estão instaladas e foram substituídas: o moment (usado pelo parseDate do n8n para ler textos) e o html-to-text (usado na extração de texto do nó HTML 1.2).

**Decisões e diferenças**

- **Estrutura dos parâmetros.** O modelo de propriedades daqui não tem coleções ("options" do n8n), então as opções viraram campos de primeiro nível com `showWhen`. O n8n repete nomes de parâmetro com padrões diferentes por operação; aqui cada nome existe uma vez. No Date & Time, `outputFieldName` vazio usa o nome padrão do n8n para a operação (tabela `DATE_OUTPUT_DEFAULTS`); o conversor sempre preenche o nome.
- **Fuso do Date & Time.** O contexto de execução não tem o fuso do fluxo, então o nó tem o campo `timezone` (padrão America/Sao_Paulo), que faz o papel do fuso do fluxo; o conversor preenche com o fuso do fluxo do n8n (ou com `options.timezone` do Get Current Date). Na operação Formatar, a opção do n8n "Use Workflow Timezone" virou `useWorkflowTimezone`; desligada, a data é formatada em UTC ou no deslocamento "+hh" do texto (inclusive o atalho do n8n que usa `Etc/GMT-hh` e ignora os minutos).
- **Leitura de datas.** `parseDate` segue as regras do n8n para números (menos de 12 dígitos são segundos, senão milissegundos; números com casas decimais são segundos). Textos são lidos com luxon (ISO, RFC 2822, HTTP, SQL e, por último, `Date.parse`) no lugar do moment. Textos sem fuso são lidos no fuso em uso (o do nó, ou UTC na formatação sem o fuso do nó); no n8n eles eram lidos no fuso do servidor, então o resultado é igual quando o servidor do n8n roda no fuso do fluxo.
- **Arredondar para cima** devolve o início do mês seguinte, como no n8n (a opção se chama "Fim do mês" lá também).
- **Formatos prontos.** Além dos formatos do n8n, há DD/MM/AAAA. O padrão continua MM/dd/yyyy, como no n8n.
- **Crypto.** Na versão atual do n8n, o segredo do HMAC e a chave privada ficam numa credencial; aqui, como pedido, o segredo é parâmetro (como no Crypto V1) e a chave privada vem da conexão `cryptoPrivateKey` (`data.privateKey`). A chave é refeita com quebras de linha quando chega colada numa linha só (equivalente ao `formatPemBlock` do n8n). Os algoritmos de assinatura são os de `getHashes()` sem os não suportados, como no n8n; o padrão é RSA-SHA256 (no n8n é vazio). A saída é gravada com caminho (como o `set` do lodash): nomes com pontos criam campos aninhados. Ficaram de fora: hash/HMAC de dado binário (fase de arquivos) e as ações Encrypt/Decrypt da versão 2 do n8n.
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
- Os conversores ainda não estão ligados ao `import.ts`, nem os nós ao registro, nem os tipos de conexão ao servidor.

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
| `files` | Arquivos escolhidos na tela (ex.: anexos do Gmail): nome, tipo, tamanho, conteúdo e quem enviou |

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
