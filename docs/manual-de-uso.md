# Info8n: manual de uso

> Cópia do manual de uso publicado em https://claude.ai/code/artifact/278d0b6e-2f6e-48f1-ba10-9b7b3ffd0b46. As duas versões são atualizadas juntas.

## Primeiros passos

O Info8n abre no navegador, no endereço do servidor na porta 3000 (por exemplo `http://localhost:3000`). Entre com o e-mail e a senha que o administrador criou para você.

1. **Login:** digite e-mail e senha e clique em Entrar. Depois de 5 senhas erradas, o acesso fica bloqueado por 15 minutos.
2. **Senha nova:** no primeiro acesso, o sistema pede uma senha nova antes de mostrar qualquer tela.
3. **Sessão:** o login vale 12 horas. Depois disso, entre de novo.

**O menu lateral**

| Item | Para quê |
| --- | --- |
| Fluxos | Lista, cria, importa e abre os fluxos |
| Execuções | Histórico de todas as execuções, com filtros e o log de cada nó |
| Conexões | Credenciais de APIs, bancos, Metabase e ClickUp |
| APIs dos ERPs | Catálogo de endpoints por ERP e cadastro dos clientes em cada ERP |
| Comandos SQL | Todo comando executado nos bancos dos clientes |
| Clientes | Cadastro dos clientes |
| Referência da API | Todas as chamadas que outros sistemas podem fazer com um token, com exemplos |
| Usuários, Pastas, Auditoria | Só para administradores |

No rodapé do menu ficam seu nome (abre Minha conta, onde você troca a senha e cria tokens de API) e o botão Sair.

## Perfis e permissões

Cada usuário tem um **perfil**, que diz o que ele pode fazer, e duas listas que dizem o que ele enxerga: **pastas** e **clientes**. Quem define tudo isso é o administrador, na tela Usuários.

| Perfil | Fluxos | Execuções | Conexões e APIs dos ERPs | Administração |
| --- | --- | --- | --- | --- |
| Administrador | Vê, cria, edita, executa e ativa | Vê, executa de novo e cancela | Vê e cadastra | Usuários, pastas, clientes e auditoria |
| Editor | Vê, cria, edita, executa e ativa | Vê, executa de novo e cancela | Vê e cadastra | Não |
| Operador | Vê e executa | Vê, executa de novo e cancela | Só vê | Não |
| Leitor | Só vê | Só vê | Só vê | Não |

**Pastas.** Todo fluxo fica numa pasta. Quem não é administrador só enxerga os fluxos das pastas marcadas no seu cadastro, e só as execuções desses fluxos. O administrador enxerga todas as pastas.

**Clientes.** Uma conexão pode pertencer a um cliente. Quem não é administrador só vê e só escolhe nos nós as conexões dos clientes marcados no seu cadastro. Conexões sem cliente ficam visíveis para todos. A tela Comandos SQL segue a mesma regra: cada um vê os comandos dos clientes a que tem acesso.

Se você abrir um fluxo que usa uma conexão de um cliente que você não enxerga, o campo mostra "Conexão sem acesso ou excluída". O fluxo continua rodando normalmente no agendamento; você só não consegue trocar nem ver os dados daquela conexão.

**Tokens de API.** Em Minha conta, cada usuário pode criar tokens para chamar a API do Info8n a partir de outros sistemas. O token tem as mesmas permissões de quem o criou e pode ser revogado ali mesmo.

Para usar um token, o outro sistema manda o header `Authorization: Bearer sa_...` em cada chamada. Para disparar um fluxo, ele chama `POST /api/workflows/{id}/run` e depois consulta o resultado em `GET /api/executions/{id}`. O menu Referência da API mostra todas as chamadas dentro do Info8n. A mesma lista, com os parâmetros, um exemplo de chamada e um exemplo de resposta de cada uma, está na [documentação da API](https://claude.ai/code/artifact/80ceb5b2-a2ea-4297-abe8-73dad394d2b9). Para uma integração, crie um usuário só para ela, com o menor perfil que resolve, e gere o token com esse usuário.

## Fluxos

A tela Fluxos lista os fluxos que você enxerga, com a pasta, quem alterou por último, a última execução e a situação: **Ativo** (roda sozinho no agendamento), **Inativo** (tem agendamento, mas está desligado) ou **Manual** (só roda pelo botão ou chamado por outro fluxo). O campo de busca filtra pelo nome.

**Criar, duplicar e excluir**

- **Novo fluxo:** dê um nome, escolha a pasta e o editor abre vazio.
- **Duplicar:** cria uma cópia inativa na mesma pasta.
- **Excluir:** pede confirmação. Um fluxo chamado por outros não pode ser excluído; o sistema lista quem o chama.

**O editor**

1. **Paleta à esquerda:** os nós por grupo (Gatilhos, Ações, Lógica, Dados). Clique para adicionar. Com um nó selecionado, o novo já entra ligado a ele.
2. **Ligar nós:** arraste da bolinha de saída (direita) até a de entrada (esquerda) do próximo. Nós com duas saídas, como If e Loop, mostram o nome de cada uma.
3. **Configurar:** dê dois cliques no nó. A janela mostra à esquerda o que chega, no meio os parâmetros e as configurações, e à direita o que o nó devolveu na última execução.
4. **Excluir:** selecione o nó ou a ligação e aperte Delete.
5. **Salvar:** botão Salvar ou Ctrl+S. Se alguém salvou o mesmo fluxo enquanto você editava, o sistema avisa e pede para recarregar, para ninguém sobrescrever o trabalho do outro.

Ao salvar, o sistema confere o fluxo e mostra as pendências numa faixa amarela: falta de gatilho, mais de um gatilho, nó solto, campo obrigatório vazio, nome repetido ou nó do n8n sem equivalente. O fluxo salva mesmo com pendências, mas não pode ser ativado até corrigi-las.

**Executar no editor**

O botão Executar roda o fluxo como está na tela, mesmo sem salvar. Cada nó ganha um ✓ verde ou um ! vermelho e a quantidade de itens que devolveu. A faixa acima do desenho mostra o resultado e o link Ver log completo. Nos gatilhos Manual e Chamado por outro fluxo há um campo JSON de entrada para testes: o que você escrever ali entra como itens do gatilho. Esse JSON não é salvo no fluxo.

**Versões**

Cada vez que você salva, o Info8n guarda uma versão nova com a data e o autor. Em Versões você vê a lista e carrega uma versão antiga no editor; ela só vira a atual quando você salvar.

**Exportar e importar**

- **Exportar** (no editor) baixa o fluxo em JSON.
- **Importar JSON** (na lista) cria um fluxo a partir de um arquivo exportado do Info8n.
- **Importar do n8n** aceita um ou vários arquivos exportados do n8n. Subfluxos importados juntos, ou antes, ficam ligados ao fluxo que os chama. Ao final, uma lista mostra, fluxo por fluxo, o que precisa de ajuste. Credenciais não vêm do n8n: cadastre-as em Conexões e escolha a conexão em cada nó. Veja também a seção Diferenças para o n8n.

**Ativar o agendamento**

Só fluxos que começam pelo gatilho Agendamento precisam ser ativados. Salve as alterações e ligue a chave Ativo na barra do editor. O sistema recusa a ativação se o fluxo tiver pendências. Para parar de rodar, desligue a chave. Ativar e desativar ficam registrados na Auditoria.

## Campos Fixo e Expressão

Quase todo parâmetro tem, acima dele, a escolha **Fixo** ou **Expressão**.

- **Fixo:** o valor vai exatamente como foi digitado. Chaves duplas aqui são texto comum.
- **Expressão:** o texto pode ter trechos de JavaScript entre chaves duplas, calculados para cada item que chega no nó.

Se o campo tem só uma expressão, o resultado mantém o tipo (número, lista, objeto). Se mistura texto e expressões, o resultado é texto, e objetos viram JSON.

| Exemplo | Resultado |
| --- | --- |
| {{ $json.id }} | O campo id do item atual, com o tipo original |
| Bearer {{ $node\['Login'\].json.token }} | Texto com o token devolvido pelo nó Login |
| {{ $json.preco \* 1.1 }} | Conta com o campo preco |
| {{ $json.itens.length > 0 }} | Verdadeiro ou falso |
| {{ $json.toJsonString() }} | O item inteiro como texto JSON |

**O que existe dentro das chaves**

| Variável | O que traz |
| --- | --- |
| $json | Os campos do item atual |
| $input.all(), $input.first(), $input.last() | Todos os itens que chegaram no nó, o primeiro e o último |
| $input.item | O item atual inteiro (com .json) |
| $itemIndex | A posição do item atual, a partir de 0 |
| $node\['Nome'\].json | O item de outro nó que já rodou, na mesma posição do item atual (ou o primeiro, se não houver) |
| $('Nome').first(), .last(), .all() | O mesmo, no formato do n8n |
| $execution.id, $execution.mode | O número da execução e o tipo (manual, schedule, subworkflow, retry) |
| $vars | Existe por compatibilidade com o n8n, mas hoje vem vazio |

Funções comuns do JavaScript funcionam normalmente: new Date(), Math, JSON.stringify, métodos de texto e de lista. Qualquer valor aceita .toJsonString(), como no n8n.

**Arrastar campos**

Na janela do nó, a coluna Entrada mostra o primeiro item que chegou na última execução, e o bloco Saídas de outros nós mostra o que os anteriores devolveram. Deixe o parâmetro em Expressão e arraste um campo até ele: o caminho entra pronto onde você soltar, como {{ $json.cliente.id }} ou {{ $node\['Login'\].json.token }}. Em Fixo, o mesmo texto entra, mas fica literal. Para ter o que arrastar, execute o fluxo uma vez antes.

**Limites**

- Cada expressão tem 2 segundos para terminar. Passou disso, o nó falha com Erro na expressão.
- A expressão roda isolada do servidor: não acessa arquivos, rede nem variáveis do sistema.
- Se a expressão cita um nó que ainda não rodou, o erro diz qual nó faltou.

## Catálogo de nós

Os dados andam entre os nós como uma lista de **itens**; cada item é um objeto JSON. A maioria dos nós de ação roda uma vez para cada item que chega. Quando um nó não devolve nenhum item, os nós ligados depois dele não rodam, e o fluxo termina ali sem erro.

### Gatilhos

Todo fluxo começa por exatamente um gatilho.

| Nó | Quando dispara | Configuração |
| --- | --- | --- |
| Gatilho manual | Pelo botão Executar | JSON de entrada para testes, opcional |
| Agendamento | Sozinho, quando o fluxo está Ativo | Todo dia, toda semana, todo mês, a cada intervalo, uma vez numa data e hora, ou expressão cron (veja abaixo) |
| Chamado por outro fluxo | Quando outro fluxo o chama pelo Execute Workflow | Recebe os itens que o outro fluxo mandou |

**Tipos de agendamento.** Os horários seguem o Fuso horário do nó (padrão America/Sao\_Paulo).

- **Todo dia:** escolha o horário, com hora, minuto e segundo (ex.: 08:30:00).
- **Toda semana:** marque os dias da semana e escolha o horário. Ex.: Seg, Qua e Sex às 07:00:00.
- **Todo mês:** escolha o dia do mês (1 a 31) e o horário. Nos meses que não têm o dia escolhido (ex.: 31 em abril), não roda.
- **A cada intervalo:** um número e a unidade (segundos, minutos ou horas). Conta a partir da ativação. Cada execução fica em Execuções, então intervalos de poucos segundos enchem o histórico.
- **Uma vez, numa data e hora:** roda uma única vez no momento escolhido e depois o fluxo é desativado sozinho (a Auditoria registra a desativação). A data precisa estar no futuro para ativar. Para rodar de novo, escolha outra data e ative outra vez.
- **Expressão cron:** para casos que as opções acima não cobrem. São 5 campos (minuto, hora, dia do mês, mês, dia da semana), ou 6 com os segundos no começo. `*` é qualquer valor, `*/15` é a cada 15, `1-5` é um intervalo e `8,12,18` é uma lista; no dia da semana, 0 é domingo. Exemplos: `0 8 * * *` todo dia às 8h; `*/15 * * * *` a cada 15 minutos; `0 8-18 * * 1-5` de hora em hora das 8h às 18h, de segunda a sexta; `*/30 * * * * *` a cada 30 segundos.

### Ações

**HTTP Request.** Chama uma API REST, uma vez por item.

- **Requisição:** Montar aqui (URL livre) ou API cadastrada. Na API cadastrada, você escolhe o cliente no ERP e o endpoint, e o nó pede só as variáveis do endpoint; servidor, porta e credenciais vêm do cadastro do cliente.
- **Montar aqui:** método, URL, autenticação (uma conexão de API key, Bearer ou Basic), parâmetros de query, headers e corpo (JSON, formulário ou texto).
- **Resposta:** uma lista de objetos vira um item por elemento; um objeto vira um item; resposta vazia não gera item e o fluxo termina ali sem erro.
- **Incluir status e headers da resposta:** devolve um item com statusCode, headers e body.
- **Falhar quando o status for de erro:** ligado por padrão. Desligado, uma resposta 4xx ou 5xx segue como resultado normal.

**Banco de dados.** SQL Server, Oracle ou Postgres, pela conexão escolhida. Todo comando fica registrado em Comandos SQL.

- **Executar SQL:** escreva o comando com :nome nos lugares dos valores e preencha cada parâmetro abaixo. Um SELECT devolve um item por linha; UPDATE e DELETE devolvem linhasAfetadas. Prefira parâmetros a montar o SQL com expressões: eles protegem contra SQL injection.
- **Inserir linhas:** informe a tabela e use todos os campos do item com o mesmo nome das colunas, ou escolha coluna e valor.
- **Executar procedure:** informe o nome e os parâmetros na ordem da procedure, cada um com direção (entrada, saída, entrada e saída) e tipo. Os de saída e os cursores voltam no item pelo nome; linhas de um SELECT dentro da procedure vêm em linhas.
- **Executar uma vez só:** desligado, o comando roda uma vez para cada item que chega, com os valores daquele item.

**Metabase.** Executa uma question e devolve um item por linha. Informe o número ou o link da question e os filtros pelo nome que aparecem nela. Por padrão roda uma vez só; desmarcado, roda uma vez por item, com os filtros de cada item. Tem até 5 minutos para responder.

**ClickUp.** Cria uma tarefa para cada item e devolve a tarefa criada. Campos: lista (ID ou link), nome, descrição em Markdown, responsáveis (e-mails ou IDs, separados por vírgula), prazo (dd/mm/aaaa, dd/mm/aaaa hh:mm ou ISO) e campos personalizados (ID do campo e valor).

**Gmail.** Envia, responde e organiza e-mails de uma conta do Google, uma vez por item. Usa uma conexão Gmail (login com Google); veja [Conectar o Gmail](#conectar-o-gmail).

- **Enviar e-mail:** Para, Cc e Cco (endereços separados por vírgula, como `Ana <ana@empresa.com>, bruno@cliente.com`), assunto, texto em texto simples ou HTML, nome do remetente, Responder para e anexos. O e-mail sai sempre da conta conectada; o nome do remetente só muda o nome que aparece. Devolve id, threadId e labelIds do e-mail enviado.
- **Responder e-mail:** informe o ID do e-mail. A resposta vai para quem enviou (ou para o Responder para dele), na mesma conversa, com "Re:" e o assunto original quando o assunto fica em branco. Responder a todos inclui quem estava em Para e Cc, menos a própria conta. Para, Cc e Cco preenchidos somam aos destinatários.
- **Criar rascunho:** os mesmos campos do envio. Com Em resposta ao e-mail, o rascunho já fica na conversa com os destinatários e o assunto da resposta. Devolve o id do rascunho e a mensagem.
- **Enviar rascunho:** envia o rascunho pelo ID que Criar rascunho devolveu. **Excluir rascunho** apaga o rascunho.
- **Buscar e-mails:** usa a mesma busca da caixa do Gmail (`from:nf@fornecedor.com is:unread newer_than:2d has:attachment`), com filtro opcional por etiquetas, opção de incluir spam e lixeira e máximo de e-mails (1 a 500, padrão 20). Cada e-mail vira um item com id, threadId, labelIds, snippet, from, to, cc, replyTo, subject, date, text, html e attachments. Sem e-mails encontrados, o caminho termina ali sem erro.
- **Ler e-mail:** traz um e-mail pelo ID, no mesmo formato da busca.
- **Trazer o conteúdo dos anexos:** na busca e na leitura, põe o conteúdo de cada anexo em base64 em attachments[].content. Sem isso, cada anexo vem só com nome, tipo, tamanho e attachmentId.
- **Anexos:** cada anexo tem nome do arquivo, conteúdo em base64 e tipo (ex.: application/pdf). Para reenviar um anexo recebido, use a busca com anexos e, em Expressão, `{{ $json.attachments[0].content }}`.
- **Marcar como lido** e **Marcar como não lido:** pelo ID do e-mail.
- **Pôr etiquetas** e **Tirar etiquetas:** nomes ou IDs separados por vírgula. As do sistema são INBOX (tirar arquiva o e-mail), STARRED, IMPORTANT, UNREAD, SPAM e TRASH. A etiqueta precisa existir no Gmail.
- **Mover para a lixeira:** o e-mail fica 30 dias na lixeira do Gmail. O Info8n não apaga e-mails de vez.

**Execute Workflow.** Chama outro fluxo, que precisa começar pelo gatilho Chamado por outro fluxo, e devolve a saída do último nó que rodou nele. Escolha rodar uma vez com todos os itens ou uma vez para cada item. A execução do subfluxo aparece separada em Execuções, ligada à execução que a chamou.

### Lógica

**If.** Separa os itens em duas saídas, verdadeiro e falso. Cada condição compara um valor com outro: é igual, é diferente, contém, não contém, começa com, termina com, maior, maior ou igual, menor, menor ou igual, está vazio, não está vazio, é verdadeiro, é falso ou combina com a regex. As condições se combinam com E (todas) ou OU (pelo menos uma).

**Loop.** Processa os itens em lotes. Cada volta manda o número de itens definido em Itens por lote pela saída loop. Ligue o último nó do ramo de volta na entrada do Loop. Quando os itens acabam, a saída concluído entrega tudo o que voltou pelo ramo.

**Stop and Error.** Para o fluxo com erro quando algum item chega nele. A mensagem pode ser um texto ou um objeto JSON; o campo message do objeto vira a mensagem e o resto fica nos detalhes do erro.

### Dados

**Split Out.** Transforma a lista de dentro de um item em vários itens, um por elemento. Informe o caminho do campo (ou uma expressão que devolva a lista), se os outros campos do item vão junto e o nome do campo de destino.

**Aggregate.** O contrário do Split Out: junta todos os itens em um só, com uma lista para cada campo escolhido, ou com os itens inteiros num campo (padrão data).

**Merge.** Junta duas entradas e espera as duas chegarem antes de rodar. Modos:

- **Emendar:** os itens da entrada 1 e depois os da entrada 2.
- **Combinar por campo em comum:** junta os itens com o mesmo valor num campo de cada lado. Mantém só os que combinam, ou todos da entrada 1.
- **Combinar pela posição:** o primeiro com o primeiro, o segundo com o segundo, e assim por diante.
- **Escolher uma das entradas:** só uma segue adiante, depois que as duas chegam.

**Edit Fields (Set).** Cria ou altera campos, como no n8n. Em Manual Mapping, cada campo tem nome, tipo (String, Number, Boolean, Array, Object) e valor; em JSON, você escreve o objeto inteiro. Include Other Input Fields decide se o item de saída leva os outros campos que chegaram (todos, só alguns ou todos menos alguns). Com Support Dot Notation, o nome a.b cria { a: { b } }.

**Code.** Roda JavaScript ou Python sobre os itens, uma vez com todos ou uma vez por item.

- **JavaScript:** use $input.all(), $json, $('Nó').first(), $execution. Pode usar await. Devolva uma lista de objetos (ou um objeto, no modo por item).
- **Python:** use \_input.all(), \_json, \_('Nó').first(), \_execution e a biblioteca padrão do Python. item.json.campo e item.json\['campo'\] funcionam. Devolva uma lista de dicionários (ou um dicionário, no modo por item).
- O que o código escreve com console.log ou print aparece na saída do nó e no log da execução.

### Nó do n8n não convertido

Aparece quando um fluxo importado do n8n tem um nó sem equivalente aqui. Ele guarda o tipo e a configuração original para consulta. Substitua-o por outros nós: o fluxo não pode ser ativado enquanto ele existir.

## Configurações do nó

Na janela do nó, a aba Configurações muda o comportamento dele sem mexer nos parâmetros.

| Configuração | O que faz | Padrão |
| --- | --- | --- |
| Desativar nó | O nó não executa e repassa os itens que chegaram, como se não estivesse ali. Aparece apagado no desenho. | Desligado |
| Continuar em caso de erro | Em vez de parar o fluxo, o nó devolve um item com os campos error (a mensagem) e details, e o fluxo segue. | Desligado |
| Tentar de novo quando falhar | Repete o nó quando ele falha. Você define o total de tentativas (1 a 10, contando a primeira) e a espera entre elas. | Desligado; 3 tentativas; 1 s |
| Tempo limite do nó | Quanto tempo o nó pode levar. Passou disso, falha com erro de tempo limite (e tenta de novo, se configurado). | 120 s; Metabase 300 s; Execute Workflow 1 h |
| Anotações | Texto livre para explicar o nó a quem abrir o fluxo depois. | Vazio |

**Como a espera cresce.** A espera aumenta a cada tentativa: com 1 s, a segunda tentativa espera 1 s, a terceira 2 s, a quarta 3 s, e assim por diante.

**Cuidado com nós importados do n8n.** A configuração de tentar de novo vem junto na importação. Um nó com 5 tentativas que chama um subfluxo, por exemplo, executa o subfluxo até 5 vezes quando ele falha, o que parece um fluxo em repetição. Confira essa aba nos nós que chamam APIs, bancos e subfluxos.

**Tentar de novo só vale para o nó.** Uma execução que termina com erro não é repetida sozinha. Para rodar de novo, use Executar de novo na tela da execução.

**Continuar em caso de erro com If.** Um jeito comum de tratar erros é ligar Continuar em caso de erro e colocar um If logo depois, com a condição {{ $json.error }} não está vazio: a saída verdadeiro trata a falha e a falso segue o caminho normal.

## Conexões, APIs dos ERPs e Clientes

### Clientes

O cadastro de clientes é a base para separar o acesso: conexões e cadastros nos ERPs apontam para um cliente, e cada usuário só enxerga os clientes marcados no seu cadastro. Só o administrador cria, renomeia e exclui clientes. Um cliente com conexões ou cadastrado num ERP não pode ser excluído; remova esses vínculos antes.

### Conexões

Uma conexão guarda o endereço e a credencial de um sistema externo, para os nós usarem sem repetir senha em cada fluxo. Para criar: Conexões, Nova conexão, dê um nome que identifique o sistema e o cliente, escolha o tipo e, se for o caso, o cliente.

| Tipo | Campos | Usada em |
| --- | --- | --- |
| API key no header | Nome do header e valor | HTTP Request |
| Bearer token | Token | HTTP Request |
| Usuário e senha (Basic) | Usuário e senha | HTTP Request |
| Postgres | Servidor, porta, banco, usuário, senha, SSL, tempo limite por comando | Banco de dados |
| SQL Server | Servidor, porta ou instância, banco, usuário, senha, criptografia, certificado, tempo limite | Banco de dados |
| Oracle | Servidor, porta e service name, ou connect string; usuário, senha, tempo limite | Banco de dados |
| Metabase | URL e API key, ou usuário e senha | Metabase |
| ClickUp | Token pessoal da API (no ClickUp: Configurações, Apps, API Token) | ClickUp |
| Gmail (login com Google) | Client ID e client secret do app do Google Cloud, e o botão Conectar com Google | Gmail |

- **Testar conexão:** bancos, Metabase, ClickUp e Gmail têm o botão Testar conexão no formulário, que tenta conectar antes de salvar.
- **Senhas e tokens:** ficam criptografados e nunca voltam para a tela. Ao editar, deixe o campo em branco para manter o valor atual.
- **Excluir:** uma conexão usada por algum fluxo não pode ser excluída; o sistema lista quais fluxos a usam.
- **Rede:** o Info8n acessa os bancos e as APIs a partir do servidor onde está instalado. Se um banco de cliente só aceita conexões de certos IPs, libere o IP desse servidor.

#### Conectar o Gmail

O Gmail não usa senha: a conta do Google autoriza o Info8n uma vez, pelo botão Conectar com Google, e o Info8n guarda essa autorização criptografada. Para isso é preciso um app OAuth no Google Cloud, criado uma vez e usado por todas as conexões do Gmail.

**1. Criar o app no Google Cloud** (uma vez só)

1. Entre em [console.cloud.google.com](https://console.cloud.google.com) com a conta do Google da empresa e crie um projeto (ex.: Info8n).
2. Em APIs e serviços, Biblioteca, procure Gmail API e clique em Ativar.
3. Abra Google Auth Platform (ou Tela de consentimento OAuth) e preencha o nome do app (ex.: Info8n) e o e-mail de suporte. Em Público:
   - **Interno**, se as contas que vão ser conectadas são do Google Workspace da empresa. É a melhor opção: não pede verificação nem vence.
   - **Externo**, para contas @gmail.com. Adicione cada conta em Usuários de teste. Enquanto o app estiver em Teste, a autorização vence a cada 7 dias; para não vencer, clique em Publicar app. O Google vai mostrar o aviso de app não verificado na hora de conectar, o que é normal para uso próprio.
4. Em Clientes (ou Credenciais), crie um ID do cliente OAuth do tipo **Aplicativo da Web**. Em URIs de redirecionamento autorizados, cole o Endereço de retorno que aparece na conexão do Gmail no Info8n (ex.: `http://localhost:3000/api/oauth/google/callback`). Se o Info8n é aberto por mais de um endereço, cadastre todos.
5. Copie o ID do cliente e a chave secreta do cliente.

**2. Criar a conexão no Info8n**

1. Conexões, Nova conexão, tipo **Gmail (login com Google)**. Dê um nome que identifique a conta (ex.: Gmail financeiro).
2. Cole o Client ID e o Client secret.
3. Clique em **Conectar com Google**. A conexão é salva e o Google abre. Escolha a conta e autorize. Se aparecer "O Google não verificou este app", clique em Avançado e depois em Acessar Info8n.
4. O Google volta para Conexões com a mensagem "Conta do Google conectada". Na lista, a conexão mostra o e-mail conectado.

**Info8n aberto por IP**

O Google só aceita voltar para localhost ou para um domínio, nunca para um IP. Quando o Info8n é aberto por IP (ex.: `http://10.0.0.20:3000`), o endereço de retorno vira `http://localhost:3000/...`, o Google abre numa nova aba e essa aba não carrega. Copie o endereço inteiro daquela aba, volte para a conexão, cole em Endereço da página de retorno e clique em Concluir.

Para não precisar colar, abra o Info8n por `http://localhost:3000` no próprio servidor, ou configure um nome (ex.: `http://info8n.empresa.local:3000`) na variável `PUBLIC_URL` do servidor e cadastre esse endereço no Google Cloud.

**Depois de conectado**

- O acesso vale até alguém revogar em [myaccount.google.com/permissions](https://myaccount.google.com/permissions), trocar a senha da conta, ou, com o app Externo em Teste, por 7 dias. Nesses casos o nó falha com "O Google recusou o acesso salvo"; abra a conexão e clique em Conectar com Google de novo.
- Trocar o Client ID desfaz a conexão com a conta, porque a autorização é do app antigo. Trocar só o nome ou o cliente não desfaz.
- O Info8n pede ao Google permissão para ler, enviar, criar rascunhos, mudar etiquetas e mover para a lixeira. Não pede permissão para apagar e-mails de vez.

### APIs dos ERPs

O catálogo evita montar a mesma chamada à mão em cada fluxo. Você cadastra o ERP uma vez, com seus endpoints, e depois cadastra cada cliente que usa aquele ERP com os dados de acesso dele. No HTTP Request, basta escolher API cadastrada, o cliente e o endpoint.

**1. Cadastrar o ERP** (APIs dos ERPs, Novo ERP)

- **URL base:** o começo comum das chamadas, com os campos do cliente entre chaves duplas. Ex.: http://{{host}}:{{porta}}/api
- **Autenticação dos endpoints:** sem autenticação, Bearer token vindo do login, usuário e senha (Basic) ou token num header próprio (você informa o nome do header).
- **Campos que cada cliente preenche:** por exemplo host, porta, usuario, senha. Marque como secretos os que forem senhas; eles ficam criptografados. Para Basic, use os campos usuario e senha.

**2. Cadastrar os endpoints** (na página do ERP, Novo endpoint)

- Método e caminho, que pode usar os campos do cliente e as variáveis do endpoint. Ex.: /produtos/{{sku}}/preco
- **Variáveis que o nó vai pedir:** nome, rótulo, tipo (texto, número, verdadeiro/falso, JSON), valor padrão e se é obrigatória.
- Headers, parâmetros de query e o modelo do corpo. No corpo JSON, um valor que é só {{variavel}} recebe o tipo da variável (número, lista, objeto).
- **Usa a autenticação do ERP:** com Bearer ou header próprio, o nó passa a pedir a variável token. Desmarque no endpoint de login.

**3. Cadastrar os clientes no ERP** (na página do ERP, Adicionar cliente)

Escolha o cliente, um ambiente opcional (para ter o mesmo cliente duas vezes, como Produção e Homologação) e preencha os campos que o ERP pede.

**Login sem automatismo.** O Info8n não faz login sozinho nem guarda token entre execuções. O padrão é: um HTTP Request chama o endpoint de login no começo do fluxo, e os próximos preenchem a variável token com uma expressão, como {{ $node\['Login'\].json.token }}. Assim, cada execução pega um token novo.

Criar e alterar ERPs, endpoints e clientes nos ERPs exige perfil Editor ou Administrador; todos os perfis podem consultar o catálogo.

## Execuções, Comandos SQL e Auditoria

### Execuções

Toda execução, de qualquer origem, aparece em Execuções, da mais recente para a mais antiga. Os filtros são fluxo, status, tipo, período (de e até) e uma busca pelo nome do fluxo, do nó ou pela mensagem de erro.

Quando muitos fluxos agendados disparam no mesmo horário, rodam 5 por vez. Os que esperam vaga aparecem no topo da lista como Na fila, com o horário desde quando aguardam, e começam sozinhos conforme os anteriores terminam.

| Status | Significado |
| --- | --- |
| Na fila | Aguardando vaga para rodar |
| Executando | Em andamento |
| Sucesso | Terminou sem erro |
| Erro | Parou num nó; a coluna Erro diz qual e por quê |
| Cancelada | Alguém cancelou |

| Tipo | Origem |
| --- | --- |
| Manual | Botão Executar no editor |
| Agendada | Gatilho Agendamento de um fluxo ativo |
| Subfluxo | Chamada por outro fluxo pelo Execute Workflow |
| Reexecução | Botão Executar de novo |

**A tela da execução** mostra quem disparou, quando começou, quanto durou e a versão do fluxo que rodou. Se houve erro, o painel vermelho diz em qual nó, a mensagem e os detalhes (por exemplo, a resposta da API ou o código do erro do banco). Abaixo, a lista Nós executados traz cada nó na ordem em que rodou, com a quantidade de itens e o tempo. Clique num nó para ver a entrada e a saída dele, as tentativas, os logs do código e os links para os subfluxos que ele chamou. Um nó dentro de um Loop aparece uma vez por volta.

- **Executar de novo:** roda outra vez a mesma versão do fluxo, com a mesma entrada. A nova execução aponta para a original.
- **Cancelar:** interrompe uma execução na fila ou em andamento.
- **Abrir fluxo** e **ver quem chamou** (em subfluxos) levam ao fluxo e à execução de origem.

**O que fica guardado.** Para os logs ocuparem pouco espaço:

- Execuções agendadas que terminam com sucesso, e os subfluxos chamados por elas, guardam só o resumo: cada nó, o status, a quantidade de itens e o tempo, sem os dados. As que dão erro, as manuais e as reexecuções (com os subfluxos que elas chamam) guardam tudo. O administrador pode mudar isso para guardar tudo sempre.
- A entrada e a saída de um nó que passam de 256 KB são trocadas por um aviso com a quantidade de itens (campo \_truncado). Passados 16 MB na execução, os nós seguintes guardam só a contagem (campo \_naoGuardado).
- Se o administrador configurou um prazo de retenção, execuções mais antigas que ele são apagadas uma vez por dia.

### Comandos SQL

Todo comando que o nó Banco de dados executa num banco de cliente fica registrado aqui: quando, cliente e conexão, fluxo e nó, o SQL com os parâmetros, o resultado (linhas devolvidas ou afetadas, ou o erro) e a duração. Filtre por cliente, conexão, sucesso ou erro e busque no SQL, no nome do fluxo ou no erro. Da tela de uma execução, o link ver comandos SQL abre só os comandos dela. Cada usuário vê apenas os comandos dos clientes a que tem acesso.

### Auditoria

Só para administradores. Registra quem fez o quê, quando e de qual IP: login, criação, alteração, exclusão, ativação, duplicação, importação e reexecução de fluxos, além de mudanças em conexões, usuários, pastas, clientes, ERPs e tokens de API. Nas alterações, mostra o antes e o depois; senhas e tokens nunca aparecem. Filtre pelo tipo de registro.

## Administração: usuários e pastas

Estas telas aparecem só para administradores.

### Usuários

A lista mostra nome, e-mail, perfil e situação: **Ativo**, **Desativado** ou **Bloqueado** (depois de 5 senhas erradas seguidas).

**Criar um usuário**

1. Clique em Novo usuário e preencha nome, e-mail e perfil. A dica abaixo do perfil resume o que ele permite.
2. Defina a senha inicial, com pelo menos 10 caracteres. No primeiro acesso, o usuário é obrigado a trocá-la.
3. Marque as **pastas que ele pode ver** e os **clientes cujas conexões ele pode usar**. Para administradores essas listas não se aplicam: eles veem tudo.
4. Salve.

**Manutenção**

- **Esqueceu a senha:** edite o usuário e preencha Nova senha. Isso também desbloqueia o usuário e encerra as sessões abertas dele, e ele terá de trocar a senha no próximo acesso.
- **Bloqueado:** o bloqueio some sozinho em 15 minutos, ou na hora pelo link Desbloquear na lista.
- **Saiu da empresa:** desmarque Usuário ativo. Ele não entra mais, e os tokens de API dele param de funcionar. O histórico de execuções e da auditoria continua com o nome dele.
- **Mudou de função:** troque o perfil, as pastas e os clientes. Vale a partir da próxima ação dele.

### Pastas

Pastas organizam os fluxos e definem quem vê o quê. Crie uma pasta pelo nome, renomeie ou exclua. Uma pasta com fluxos não pode ser excluída; mova os fluxos antes (no editor, pelo seletor de pasta ao lado do nome, e salve).

Uma forma simples de organizar é uma pasta por área ou por cliente, e marcar em cada usuário só as pastas em que ele trabalha.

## Diferenças para o n8n e problemas comuns

### O que muda para quem vem do n8n

| No n8n | No Info8n |
| --- | --- |
| Webhook e dezenas de gatilhos | Três gatilhos: manual, agendamento e chamado por outro fluxo |
| Credenciais | Conexões. Elas não vêm na importação: cadastre em Conexões e escolha em cada nó |
| $now, $today, DateTime (Luxon) | Não existem. Use new Date() e os métodos comuns do JavaScript |
| Métodos extras como .isEmpty(), .toFormat(), .toISO() de datas do Luxon | Não existem. Reescreva em JavaScript comum. .toJsonString() funciona |
| Paginação automática no HTTP Request | Não existe. Use um Loop que chama a próxima página |
| Filter | Vira um If; os itens que passam saem por verdadeiro |
| Split In Batches | Vira Loop |
| Function e Function Item | Viram Code |
| No Operation | Vira um Code que repassa os itens |
| Always Output Data | Não existe. Um nó sem itens encerra aquele caminho |
| Saída de erro separada | Com Continuar em caso de erro, o item de erro segue pela saída normal |
| Code em Python com \_items ou .to\_py() | Use \_input.all() e \_json; os itens já são dicionários. Só a biblioteca padrão do Python |
| Code em JavaScript com require() | Não existe |
| Execute Workflow sem esperar | Sempre espera o subfluxo terminar |
| Gmail | Mesmas operações principais; excluir e-mail vira mover para a lixeira. Escolha a conexão do Gmail depois de importar, e refaça os anexos, que no n8n vinham de dados binários |

A importação mostra esses pontos fluxo por fluxo, e o que não tem equivalente vira um nó do n8n não convertido, que impede a ativação até ser substituído. O importador ainda aponta .toJsonString() como incompatível; esse aviso pode ser ignorado.

Na importação, a configuração de tentar de novo vem junto. Confira a aba Configurações dos nós que chamam APIs, bancos e subfluxos.

### Problemas comuns

| O que aparece | Causa provável | O que fazer |
| --- | --- | --- |
| O fluxo parece rodar em repetição, ou o subfluxo roda várias vezes | Tentar de novo ligado num nó que falha, geralmente vindo do n8n | Veja a quantidade de tentativas na execução, corrija o erro e ajuste a aba Configurações |
| O fluxo termina com sucesso, mas os últimos nós não rodaram | Um nó não devolveu itens, como uma API com resposta vazia | É o comportamento esperado. Veja na execução qual nó devolveu 0 itens |
| Nó "X" não foi executado antes deste nó | A expressão cita um nó que não rodou naquele caminho | Confira o nome do nó e se ele fica antes, no mesmo ramo |
| Erro na expressão com "is not a function" ou "is not defined" | Recurso do n8n que não existe aqui | Reescreva em JavaScript comum (veja a tabela acima) |
| A API respondeu com status 401 ou 403 | Token vencido, errado ou não enviado | Confira o nó de login e a variável token, ou a conexão de autenticação |
| O nó passou do tempo limite | A API, o banco ou o código demorou mais que o permitido | Aumente o Tempo limite do nó em Configurações |
| Não consigo ativar o fluxo | O fluxo tem pendências, não foi salvo ou não começa por Agendamento | Salve, corrija a faixa amarela e tente de novo |
| A data e hora da execução única já passou | O tipo Uma vez está com uma data no passado | Escolha uma data futura, salve e ative |
| O fluxo de execução única ficou desativado | É o esperado: depois de rodar, ele se desativa | Para rodar de novo, escolha outra data e ative |
| Conexão sem acesso ou excluída | A conexão é de um cliente fora do seu cadastro, ou foi apagada | Peça acesso ao cliente para o administrador, ou escolha outra conexão |
| Outra pessoa salvou este fluxo enquanto você editava | Duas pessoas no mesmo fluxo | Recarregue a página e refaça a alteração sobre a versão atual |
| A execução agendada não mostra entrada e saída | Sucesso agendado guarda só o resumo | Use Executar de novo, que guarda todos os dados. Lembre que ela roda tudo outra vez, inclusive gravações em bancos e APIs |
| Testar conexão falha no banco | O banco não aceita o IP do servidor, ou os dados estão errados | Confira servidor, porta e usuário, e libere o IP do servidor do Info8n no banco |
| No Google, erro 400 redirect_uri_mismatch | O endereço de retorno não está cadastrado no app do Google Cloud | Copie o Endereço de retorno da conexão e cadastre em URIs de redirecionamento autorizados |
| O Google recusou o acesso salvo na conexão do Gmail | Acesso revogado, senha trocada ou app Externo em Teste há mais de 7 dias | Abra a conexão e clique em Conectar com Google de novo. Para não vencer, publique o app no Google Cloud |
| A conexão do Gmail ainda não foi conectada | Salvou a conexão sem clicar em Conectar com Google | Abra a conexão e clique em Conectar com Google |
| A execução fica Na fila | O servidor já está rodando o máximo de execuções ao mesmo tempo (5, por padrão) | Aguarde, ou peça ao administrador para aumentar esse limite |
