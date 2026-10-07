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

A tela Fluxos lista os fluxos que você enxerga, com a pasta, a próxima execução (nos fluxos com agendamento; inativo ou sem próximo disparo, aparece Sem próxima execução; na execução única com milissegundos, eles aparecem depois dos segundos), a última execução e a situação: **Ativo** (roda sozinho pelos gatilhos: agendamento, webhook, formulário, e-mail etc.), **Inativo** (tem um desses gatilhos, mas está desligado) ou **Manual** (só roda pelo botão ou chamado por outro fluxo). O campo de busca filtra pelo nome.

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

Ao salvar, o sistema confere o fluxo e mostra as pendências numa faixa amarela: falta de gatilho, nó solto, campo obrigatório vazio, nome repetido ou nó do n8n sem equivalente. O fluxo salva mesmo com pendências, mas não pode ser ativado até corrigi-las.

**Executar no editor**

O botão Executar roda o fluxo como está na tela, mesmo sem salvar. Cada nó ganha um ✓ verde ou um ! vermelho e a quantidade de itens que devolveu. A faixa acima do desenho mostra o resultado e o link Ver log completo. Nos gatilhos Manual e Chamado por outro fluxo há um campo JSON de entrada para testes: o que você escrever ali entra como itens do gatilho. Esse JSON não é salvo no fluxo.

Quando o fluxo para num Wait ou num Form (veja abaixo), a faixa mostra Esperando, em qual nó e até quando, e o editor continua acompanhando até a execução terminar; Parar de acompanhar solta o editor sem cancelar a execução.

**Escutar (testar gatilhos de eventos)**

Nos fluxos com Webhook, Form Trigger, Email Trigger, Local File Trigger ou SSE Trigger, o botão **Escutar** espera um evento de verdade por 2 minutos, como o "Listen for test event" do n8n. Ele usa o fluxo como está na tela, mesmo sem salvar. A faixa mostra os endereços de teste (`/webhook-test/...` e `/form-test/...`); chame o endereço, envie o formulário, mande o e-mail ou salve o arquivo, e a execução aparece no editor como se fosse pelo botão Executar (tipo Manual, com todos os dados guardados). Parar de escutar desliga antes do tempo. Se nada chegar em 2 minutos, o editor avisa.

**Um fluxo, vários gatilhos**

Um fluxo pode ter mais de um gatilho, como no n8n: por exemplo, um Agendamento e um Webhook que fazem a mesma coisa. Cada execução começa pelo gatilho que disparou. O botão Executar começa pelo gatilho Manual ou, sem ele, pelo primeiro gatilho do fluxo.

**Configurações do fluxo**

O botão Configurações, na barra do editor, tem o **Fluxo de erro**: o fluxo que roda quando uma execução automática deste falha (veja o Error Trigger). A mudança vale depois de salvar.

**Versões**

Cada vez que você salva, o Info8n guarda uma versão nova com a data e o autor. Em Versões você vê a lista e carrega uma versão antiga no editor; ela só vira a atual quando você salvar.

**Exportar e importar**

- **Exportar** (no editor) baixa o fluxo em JSON.
- **Importar JSON** (na lista) cria um fluxo a partir de um arquivo exportado do Info8n.
- **Importar do n8n** aceita um ou vários arquivos exportados do n8n. Subfluxos importados juntos, ou antes, ficam ligados ao fluxo que os chama. Ao final, uma lista mostra, fluxo por fluxo, o que precisa de ajuste. Credenciais não vêm do n8n: cadastre-as em Conexões e escolha a conexão em cada nó. Veja também a seção Diferenças para o n8n.

**Ativar o fluxo**

Fluxos com um gatilho que dispara sozinho (Agendamento, Webhook, Form Trigger, n8n Trigger, RSS Feed Trigger, Email Trigger, Local File Trigger ou SSE Trigger) precisam estar ativos para rodar. Salve as alterações e ligue a chave Ativo na barra do editor. O sistema recusa a ativação se o fluxo tiver pendências, se outro fluxo ativo já usar o mesmo endereço de webhook ou formulário, ou se o gatilho não conseguir iniciar (por exemplo, a caixa de e-mail recusou a senha); a mensagem diz o motivo. Salvar um fluxo ativo aplica as mudanças nos gatilhos na hora. Para parar de rodar, desligue a chave. Ativar e desativar ficam registrados na Auditoria.

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

**Arquivos nos itens.** Além do JSON, um item pode levar arquivos (PDF, planilha, imagem, zip...), como no n8n. Cada arquivo fica numa propriedade do item, com nome, tipo e tamanho; o padrão é `data`, e os anexos do Gmail ficam em `attachment_0`, `attachment_1`... Nós como HTTP Request, Gmail, Read Files from Disk e Convert to File criam arquivos, e nós como Extract from File, Compression, Edit Image e Gmail (anexos) usam os arquivos que chegam. Na janela do nó e na tela da execução, a lista Arquivos mostra o que cada item leva, com Abrir e Baixar nas execuções manuais. Nas expressões, `$binary` traz os arquivos do item atual (ex.: `{{ $binary.data.fileName }}`); no nó Code, `item.binary`.

### Gatilhos

Todo fluxo começa por pelo menos um gatilho.

| Nó | Quando dispara | Configuração |
| --- | --- | --- |
| Gatilho manual | Pelo botão Executar | JSON de entrada para testes, opcional |
| Agendamento | Sozinho, quando o fluxo está Ativo | Todo dia, toda semana, todo mês, a cada intervalo, uma vez numa data e hora, ou expressão cron (veja abaixo) |
| Chamado por outro fluxo | Quando outro fluxo o chama pelo Execute Workflow | Recebe os itens que o outro fluxo mandou |
| Webhook | Quando outro sistema chama o endereço do nó (fluxo Ativo) | Método, caminho, autenticação e como responder |
| Form Trigger | Quando alguém envia o formulário do nó (fluxo Ativo) | Título, campos e o que mostrar depois do envio |
| Error Trigger | Quando outro fluxo, que o escolheu como fluxo de erro, falha | Nenhuma |
| n8n Trigger | Quando o próprio fluxo é ativado ou salvo, ou quando o servidor inicia (fluxo Ativo) | Os eventos |
| RSS Feed Trigger | Quando aparece um item novo no feed (fluxo Ativo) | Endereço do feed e horários de consulta |
| Email Trigger (IMAP) | Quando chega um e-mail que bate com os critérios (fluxo Ativo) | Conexão IMAP, caixa, critérios e formato |
| Local File Trigger | Quando um arquivo ou pasta do servidor muda (fluxo Ativo) | Caminho, eventos e o que ignorar |
| SSE Trigger | A cada mensagem de um endereço de eventos em tempo real (fluxo Ativo) | Endereço |

**Tipos de agendamento.** Os horários seguem o Fuso horário do nó (padrão America/Sao\_Paulo).

- **Todo dia:** escolha o horário, com hora, minuto e segundo (ex.: 08:30:00).
- **Toda semana:** marque os dias da semana e escolha o horário. Ex.: Seg, Qua e Sex às 07:00:00.
- **Todo mês:** escolha o dia do mês (1 a 31) e o horário. Nos meses que não têm o dia escolhido (ex.: 31 em abril), não roda.
- **A cada intervalo:** um número e a unidade (segundos, minutos ou horas). Conta a partir da ativação. Cada execução fica em Execuções, então intervalos de poucos segundos enchem o histórico.
- **Uma vez, numa data e hora:** roda uma única vez no momento escolhido, com dia, hora, minuto, segundo e milissegundo (ex.: 05/10/2026 14:30:00,250), e depois o fluxo é desativado sozinho (a Auditoria registra a desativação). A data precisa estar no futuro para ativar. Para rodar de novo, escolha outra data e ative outra vez.
- **Expressão cron:** para casos que as opções acima não cobrem. São 5 campos (minuto, hora, dia do mês, mês, dia da semana), ou 6 com os segundos no começo. `*` é qualquer valor, `*/15` é a cada 15, `1-5` é um intervalo e `8,12,18` é uma lista; no dia da semana, 0 é domingo. Exemplos: `0 8 * * *` todo dia às 8h; `*/15 * * * *` a cada 15 minutos; `0 8-18 * * 1-5` de hora em hora das 8h às 18h, de segunda a sexta; `*/30 * * * * *` a cada 30 segundos.

#### Webhooks e formulários

Os endereços abaixo são os mesmos do n8n, trocando o servidor. Cada nó Webhook e Form Trigger mostra, na janela do nó, o endereço de **Teste** e o de **Produção**, com o botão Copiar.

| Endereço | Quando funciona |
| --- | --- |
| `/webhook/<caminho>` e `/form/<caminho>` | Enquanto o fluxo estiver salvo e Ativo |
| `/webhook-test/<caminho>` e `/form-test/<caminho>` | Por 2 minutos depois de clicar em Escutar no editor, com o fluxo como está na tela, mesmo sem salvar |
| `/webhook-waiting/<id da execução>` e `/form-waiting/<id da execução>` | Enquanto uma execução estiver parada num Wait por webhook ou por formulário (veja o Wait) |

Dois fluxos ativos não podem usar o mesmo método e caminho; o sistema recusa a ativação e diz qual fluxo já usa. Com o Caminho vazio, vale o ID do nó.

**Webhook.** Recebe uma chamada HTTP de outro sistema e inicia o fluxo com um item:

```json
{
  "headers": { "content-type": "application/json", "user-agent": "curl/8.0" },
  "params": { "id": "42" },
  "query": { "origem": "erp" },
  "body": { "pedido": 10, "valor": 99.9 },
  "webhookUrl": "http://info8n.empresa.local:3000/webhook/pedidos/:id",
  "executionMode": "production"
}
```

- **Método HTTP e Caminho:** o caminho aceita partes variáveis com dois pontos, como `pedidos/:id`; o valor chega em `params`.
- **Autenticação:** Nenhuma, Usuário e senha (Basic, com uma conexão Usuário e senha) ou Header com chave (com uma conexão Header com chave). Quem chama sem as credenciais recebe 401 (ou 403 no header) e o fluxo não roda.
- **Quando responder:** Logo que receber (responde `{"message":"Workflow was started"}` e o fluxo segue sozinho), Quando o último nó terminar (responde com o que o último nó devolveu: o JSON do primeiro item, todos os itens, o arquivo do primeiro item ou sem corpo) ou Pelo nó Respond to Webhook. Nos dois últimos, quem chamou espera o fluxo; se ele demorar mais de 10 minutos, recebe 504 e o fluxo continua.
- **Código, Content-Type e Headers da resposta**, **Responder sem corpo** e **Campo da resposta** (responde só um campo do JSON, ex.: `resultado.total`).
- **Arquivos recebidos:** um corpo binário (PDF, imagem) vira o arquivo `data` do item (o nome muda em Nome do arquivo recebido). Num envio multipart (form-data), os campos de texto vão para `body` e cada arquivo fica no item com o nome do campo. **Guardar também o corpo cru** guarda o corpo original como arquivo, além do JSON.
- **IPs permitidos** (IPs ou faixas como 192.168.1.0/24, separados por vírgula), **Ignorar robôs** (recusa prévias de links e buscadores) e **Origens permitidas (CORS)** para chamadas feitas de páginas web.
- O corpo pode ter até 16 MB.

Exemplo: o ERP chama `POST /webhook/pedido-aprovado` com o pedido no corpo; o fluxo grava no banco do cliente e um Respond to Webhook devolve `{"ok": true}`.

**Respond to Webhook.** Define a resposta de um Webhook (ou Form Trigger, ou Wait por webhook) configurado para responder Pelo nó Respond to Webhook. Responde uma vez só, com: o primeiro item que chegou, todos os itens, um JSON que você escreve (aceita expressões), um texto, o arquivo de um campo do item, um redirecionamento para outro endereço ou sem corpo. Tem Código da resposta, Headers e, para primeiro item e todos os itens, Colocar a resposta no campo (ex.: `dados`). Os itens seguem para os próximos nós sem mudança. Se o fluxo terminar sem passar por ele, quem chamou recebe `{"message":"Workflow executed successfully"}` (ou 500 com o erro). Executado pelo botão Executar, ele não tem para quem responder e só repassa os itens.

**Form Trigger.** Publica um formulário web no endereço `/form/<caminho>` e inicia o fluxo quando alguém envia. Você define Título, Descrição, o Texto do botão e os **Campos do formulário**, um por linha:

| Tipo | Como chega no item |
| --- | --- |
| Texto, E-mail, Senha, Texto longo, Data | Texto (a data como aaaa-mm-dd) |
| Número | Número |
| Lista (dropdown) | Texto; com Várias escolhas na lista, uma lista |
| Caixas de seleção | Lista com as opções marcadas |
| Escolha única (radio) | Texto |
| Arquivo | Os arquivos ficam no item, com o nome do rótulo (ex.: "Nota fiscal" vira `Nota_fiscal`), e o JSON leva o nome, o tipo e o tamanho |
| Campo oculto | O Valor, com a chave do Nome; não aparece na tela |
| Bloco de texto (HTML) | Não chega no item; mostra o HTML do Valor no meio do formulário |

As opções das listas vão uma por linha. O item usa o rótulo de cada campo como chave e leva também `submittedAt` (data e hora do envio, no fuso escolhido) e `formMode` (test ou production). Depois do envio, a pessoa vê a Mensagem (padrão "Sua resposta foi registrada") ou vai para um endereço. Com Quando o último nó terminar, a mensagem só aparece depois do fluxo; com Pelo nó Respond to Webhook, o Respond to Webhook decide a página. O formulário pode pedir usuário e senha (Basic) e aceita CSS próprio. Campos obrigatórios vazios voltam com a mensagem de erro, sem rodar o fluxo.

**Form.** Continua um formulário iniciado pelo Form Trigger. Na operação **Próxima página do formulário**, a pessoa que enviou a primeira página vê outra página com os campos deste nó, e o fluxo fica Esperando até ela enviar; os valores chegam como itens deste nó. Na operação **Tela final**, define o que a pessoa vê no fim: Título e mensagem, Ir para um endereço, uma Página HTML ou o Arquivo do item (download). Sem Tela final, ela vê a mensagem do Form Trigger. Exemplo: Form Trigger pede o CPF, um nó consulta o cliente no ERP, um Form mostra a segunda página com os dados para confirmar, e a Tela final agradece.

**Error Trigger.** Começo do **fluxo de erro**: um fluxo que roda quando outro falha. No fluxo que pode falhar, abra Configurações (na barra do editor) e escolha o Fluxo de erro. Quando uma execução agendada, por webhook ou por gatilho desse fluxo termina com erro, o fluxo de erro roda com um item como no n8n:

```json
{
  "execution": {
    "id": "5c1f...",
    "url": "http://info8n.empresa.local:3000/execucoes/5c1f...",
    "error": { "message": "A API respondeu com status 500" },
    "lastNodeExecuted": "Consultar pedido",
    "mode": "schedule"
  },
  "workflow": { "id": "a1b2...", "name": "Sincronizar pedidos" }
}
```

Execuções manuais não chamam o fluxo de erro. Pelo botão Executar, o Error Trigger devolve um item de exemplo como esse. Exemplo: um único fluxo de erro manda um e-mail para a equipe com `{{ $json.workflow.name }}`, a mensagem e o link da execução, e todos os fluxos agendados apontam para ele.

**n8n Trigger.** Roda o fluxo quando ele próprio é ativado (Fluxo ativado), quando é salvo estando ativo (Fluxo salvo) ou quando o servidor do Info8n inicia (Servidor iniciado). O item traz `event`, `timestamp` e `workflow_id`. Exemplo: avisar no ClickUp sempre que alguém altera um fluxo de produção.

#### Gatilhos que escutam e consultam

Quatro gatilhos iniciam o fluxo quando algo acontece fora do Info8n. Todos só funcionam com o fluxo Ativo. Para testar no editor, clique em Escutar e provoque o evento (mande um e-mail, salve um arquivo na pasta); no RSS Feed Trigger, Executar já traz o item mais recente do feed.

**RSS Feed Trigger.** Consulta um feed RSS ou Atom (blogs, notícias, portais de licitação, Diário Oficial) nos **Horários de consulta** e dispara com os itens novos. Cada linha de horário é um modo: A cada minuto (o padrão), A cada hora (no minuto escolhido), Todo dia, Toda semana, Todo mês, A cada X minutos ou horas, ou Personalizado (expressão cron); só valem os campos do modo escolhido. Na primeira consulta depois de ativar, ele só anota a data do item mais recente e não dispara; depois, dispara uma vez com todos os itens publicados depois dessa data. Itens sem data nunca disparam, e um item antigo republicado com data nova dispara de novo. **Ignorar erros de certificado** aceita sites com certificado vencido ou próprio. O item traz `title`, `link`, `pubDate`, `isoDate`, `content`, `contentSnippet`, `guid`, `creator` e `categories`, conforme o feed. A maioria dos feeds muda poucas vezes por dia: A cada X com 15 minutos economiza recursos e evita bloqueio. Feeds com login não funcionam.

**Email Trigger (IMAP).** Fica conectado a uma caixa de e-mail (Gmail, Outlook, Locaweb, servidor próprio) e dispara quando chega um e-mail que bate com os critérios. Crie antes uma conexão do tipo **IMAP (caixa de e-mail)** com Servidor (ex.: imap.gmail.com, outlook.office365.com), Porta (993 com SSL/TLS, 143 sem), Usuário, Senha (no Gmail e no Outlook com verificação em duas etapas, uma senha de app; no Gmail o IMAP precisa estar ligado) e Aceitar certificado inválido (só para servidores internos). No nó:

- **Caixa de e-mail:** a pasta vigiada; INBOX é a caixa de entrada, subpastas costumam ser INBOX/Notas ou INBOX.Notas.
- **Depois de ler:** Marcar como lido (padrão) ou Não fazer nada.
- **Formato:** Simples (from, to, cc, subject, date, textPlain, textHtml, os outros cabeçalhos em metadata e attributes.uid), Completo (o e-mail interpretado: from.value[0].address, text, html, messageId, date ISO, headers, anexos sempre como arquivos) ou Bruto (`raw` com o e-mail inteiro em base64, para guardar o .eml).
- **Baixar anexos** (no Simples) e **Prefixo dos anexos:** os anexos ficam no item como attachment\_0, attachment\_1...
- **Critérios de busca:** quais e-mails disparam, no formato do n8n. Padrão `["UNSEEN"]` (não lidos). Exemplos: `["UNSEEN", ["FROM", "nfe@fornecedor.com"]]`, `["UNSEEN", ["SUBJECT", "Pedido"]]`, `["UNSEEN", ["SINCE", "May 20, 2024"]]`, `[["OR", ["FROM", "a@x.com"], ["FROM", "b@x.com"]]]`, `["UNSEEN", "!FLAGGED"]` (o ! nega). Também valem SEEN, ANSWERED, FLAGGED, TO, CC, BCC, BODY, TEXT, BEFORE, ON, LARGER, SMALLER, HEADER e X-GM-RAW (busca do Gmail).
- **Lembrar o último e-mail:** ligado (padrão), nunca repete um e-mail, mesmo que ele continue não lido.
- **Reconectar a cada (minutos):** para servidores que param de avisar e-mails novos depois de um tempo; 0 reconecta só quando a conexão cai.

Vários e-mails de uma vez viram uma execução com um item por e-mail. E-mails que chegaram com o fluxo desativado e ainda batem com os critérios disparam ao ativar. Contas Microsoft 365 que só aceitam OAuth não funcionam por senha. Exemplo: uma regra do e-mail move as notas fiscais para INBOX/Notas; o gatilho vigia essa pasta com Baixar anexos, e um Read/Write Files from Disk grava `attachment_0` em /files/notas.

**Local File Trigger.** Vigia um arquivo ou uma pasta do servidor e dispara quando algo muda. Só funciona nas pastas liberadas em FILES_DIRS (no Docker, /files). Em **Disparar quando**, escolha Um arquivo mudar ou Algo mudar numa pasta; na pasta, marque os **Eventos**: Arquivo adicionado, alterado ou apagado, Pasta adicionada ou apagada. Outras opções: **Esperar o arquivo terminar de ser gravado** (ligue para arquivos grandes, senão o fluxo pode ler pela metade), Incluir arquivos ligados (links), **Ignorar** (padrões como `**/*.tmp` ou `**/~$*`, os temporários do Office), Ignorar o que já existe (padrão ligado: ao ativar, não dispara para o que já está na pasta), Profundidade máxima de subpastas e **Verificar por consulta (polling)**. Ligue o polling com Docker Desktop no Windows ou Mac e em pastas de rede: nesses casos o aviso de mudança não chega ao container e o gatilho fica mudo. Cada mudança é uma execução com `{ "event": "add", "path": "/files/entrada/pedido-123.xlsx" }` (event é add, change, unlink, addDir ou unlinkDir). Para ler o arquivo, use depois um Read/Write Files from Disk com o caminho `{{ $json.path }}`. Mudanças feitas com o fluxo desativado não disparam.

**SSE Trigger.** Conecta a um endereço que envia eventos em tempo real (Server-Sent Events, `text/event-stream`) e dispara a cada mensagem. Mensagem com JSON vira o item; texto comum chega em `{ "data": "..." }`. Mensagens com nome de evento próprio (como `event: ping`) são ignoradas, como no n8n. Se a conexão cair, ele reconecta sozinho e pede só as mensagens que faltaram (quando o servidor suporta). Não há campos de cabeçalho nem de login: o endereço precisa abrir sem autenticação, ou com o token na própria URL.

### Ações

**HTTP Request.** Chama uma API REST, uma vez por item.

- **Requisição:** Montar aqui (URL livre) ou API cadastrada. Na API cadastrada, você escolhe o cliente no ERP e o endpoint, e o nó pede só as variáveis do endpoint; servidor, porta e credenciais vêm do cadastro do cliente.
- **Montar aqui:** método, URL, autenticação (uma conexão de API key, Bearer ou Basic), parâmetros de query, headers e corpo (JSON, formulário, texto, formulário multipart ou arquivo).
- **Formulário multipart (form-data):** cada linha é um campo. Em Tipo, escolha Texto (o valor vai como texto) ou Arquivo do item (o valor é o nome do arquivo no item, como `data`); o arquivo vai com o nome e o tipo dele. É o que as APIs de upload costumam pedir.
- **Arquivo (binário):** o conteúdo do arquivo do item vai inteiro como corpo. Em Arquivo do item, informe a propriedade (padrão `data`). O Content-Type sai do tipo do arquivo, a menos que você informe outro nos headers.
- **Resposta:** uma lista de objetos vira um item por elemento; um objeto vira um item; resposta vazia não gera item e o fluxo termina ali sem erro.
- **Formato da resposta:** Automático (padrão) trata JSON como acima, põe texto (HTML, CSV, XML, texto simples) no campo `data` e transforma PDF, imagens, zip, planilhas e outros conteúdos que não são texto em arquivo do item. JSON exige resposta JSON; Texto põe a resposta inteira como texto no campo informado; Arquivo sempre devolve a resposta como arquivo. Propriedade de saída (padrão `data`) diz onde fica o arquivo ou o texto. O nome do arquivo baixado vem do header Content-Disposition ou, sem ele, do fim da URL (`.../boletos/123.pdf` vira `123.pdf`); o tipo vem do Content-Type.
- **Exemplos com arquivo:** baixar o boleto em PDF (GET na URL) e mandar num Gmail com Anexos dos arquivos do item `data`; ou ler uma nota com Read Files from Disk e enviar com corpo Formulário multipart, numa linha do tipo Arquivo do item com nome `arquivo` e valor `data`.
- **Incluir status e headers da resposta:** devolve um item com statusCode, headers e body (com resposta em arquivo, o arquivo vai na propriedade de saída).
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
- **Buscar rascunhos:** acha os rascunhos que já existem no Gmail, inclusive os criados à mão. Usa a mesma busca da caixa do Gmail (`subject:"Relatório mensal"`, `to:cliente@empresa.com`) e o máximo de rascunhos (1 a 500, padrão 20); em branco, traz os mais recentes. Cada rascunho vira um item no formato da busca de e-mails, com `id` sendo o ID do rascunho e `emailId` o ID do e-mail guardado nele. Sem rascunhos encontrados, o caminho termina ali sem erro.
- **Enviar rascunho:** envia o rascunho pelo ID que Criar rascunho ou Buscar rascunhos devolveu. **Excluir rascunho** apaga o rascunho.
- **Enviar um rascunho feito no Gmail:** o Gmail não mostra o ID do rascunho na tela (o código no endereço da página não serve). Use um nó Gmail com Buscar rascunhos e uma busca que ache só ele, como `subject:"Relatório mensal"`, e depois um nó Gmail com Enviar rascunho e, em Expressão, ID do rascunho `{{ $json.id }}`. Depois de enviado, o rascunho deixa de existir; para mandar o mesmo texto toda vez, use Enviar e-mail.
- **Buscar e-mails:** usa a mesma busca da caixa do Gmail (`from:nf@fornecedor.com is:unread newer_than:2d has:attachment`), com filtro opcional por etiquetas, opção de incluir spam e lixeira e máximo de e-mails (1 a 500, padrão 20). Cada e-mail vira um item com id, threadId, labelIds, snippet, from, to, cc, replyTo, subject, date, text, html e attachments. Sem e-mails encontrados, o caminho termina ali sem erro.
- **Ler e-mail:** traz um e-mail pelo ID, no mesmo formato da busca.
- **Trazer o conteúdo dos anexos:** na busca de e-mails, na busca de rascunhos e na leitura, cada anexo vira um arquivo do item, em `attachment_0`, `attachment_1`... na ordem em que aparecem (Prefixo dos arquivos dos anexos troca o `attachment_`). No JSON, a lista attachments traz nome, tipo, tamanho, attachmentId e binaryProperty, o arquivo do item com aquele anexo. Sem essa opção, cada anexo vem só com os dados, sem o conteúdo.
- **Também pôr o conteúdo em base64 no JSON:** ligado por padrão, para os fluxos que já leem attachments[n].content continuarem funcionando. Se o fluxo usa só os arquivos do item, desligue: a execução fica bem menor. Fluxos importados do n8n vêm com ele desligado, como lá.
- **Anexos:** clique em **Adicionar** e, em **Arquivo**, em **Escolher arquivo** para pegar o arquivo no seu computador (até 25 MB). O arquivo fica guardado no Info8n e vai em todo e-mail que o fluxo mandar; o nome e o tipo vêm dele, a menos que você preencha Nome do arquivo e Tipo. Trocar arquivo põe outro no lugar, e Remover tira. Para anexar um conteúdo em base64 que vem de outro nó, deixe Arquivo vazio e passe o conteúdo, o nome e o tipo (ex.: application/pdf).
- **Anexos dos arquivos do item:** nomes dos arquivos do item que vão anexados, separados por vírgula (ex.: `data` ou `attachment_0, attachment_1`). Somam aos anexos acima. É o jeito mais simples de reenviar um anexo recebido (busca com anexos e depois `attachment_0`) ou de mandar um arquivo gerado no fluxo, como a planilha do Convert to File. Se o item não tiver o arquivo, o nó dá erro dizendo quais arquivos ele tem.
- **Marcar como lido** e **Marcar como não lido:** pelo ID do e-mail.
- **Pôr etiquetas** e **Tirar etiquetas:** nomes ou IDs separados por vírgula. As do sistema são INBOX (tirar arquiva o e-mail), STARRED, IMPORTANT, UNREAD, SPAM e TRASH. A etiqueta precisa existir no Gmail.
- **Mover para a lixeira:** o e-mail fica 30 dias na lixeira do Gmail. O Info8n não apaga e-mails de vez.

**Execution Data.** Guarda dados importantes da execução para consultar e filtrar depois, e repassa os itens sem alterá-los. Em Dados para guardar, cada linha tem Chave e Valor (o valor aceita expressão). A chave usa só letras sem acento, números e _ e é cortada em 50 caracteres; o valor é cortado em 512 caracteres; cabem no máximo 10 chaves por execução. Com vários itens, o valor de cada chave é o do último item. Exemplo: chave pedido com valor {{ $json.numero }} para achar depois a execução que tratou aquele pedido. Na tela Execuções, o campo Dado gravado filtra por chave (pedido) ou por chave e valor (pedido=1043); os dados aparecem embaixo do nome do fluxo e na página da execução.

**TOTP.** Gera o código de uso único baseado em tempo, o mesmo dos aplicativos autenticadores, como o nó TOTP do n8n. Escolha uma conexão do tipo TOTP, com o segredo em base32 e, opcionalmente, o rótulo no formato emissor:usuário. As opções são o Algoritmo (padrão SHA1), os Dígitos (padrão 6) e a Validade em segundos (padrão 30). Cada item de entrada vira um item { token, secondsRemaining }, com o código e quantos segundos ele ainda vale. Exemplo: use o token num HTTP Request que faz login num sistema com verificação em duas etapas.

**Execute Workflow.** Chama outro fluxo, que precisa começar pelo gatilho Chamado por outro fluxo, e devolve a saída do último nó que rodou nele. Escolha rodar uma vez com todos os itens ou uma vez para cada item. A execução do subfluxo aparece separada em Execuções, ligada à execução que a chamou.

### Lógica

**If.** Separa os itens em duas saídas, verdadeiro e falso. Cada condição compara um valor com outro: é igual, é diferente, contém, não contém, começa com, termina com, maior, maior ou igual, menor, menor ou igual, está vazio, não está vazio, é verdadeiro, é falso ou combina com a regex. As condições se combinam com E (todas) ou OU (pelo menos uma).

**Loop.** Processa os itens em lotes. Cada volta manda o número de itens definido em Itens por lote pela saída loop. Ligue o último nó do ramo de volta na entrada do Loop. Quando os itens acabam, a saída concluído entrega tudo o que voltou pelo ramo.

**Stop and Error.** Para o fluxo com erro quando algum item chega nele. A mensagem pode ser um texto ou um objeto JSON; o campo message do objeto vira a mensagem e o resto fica nos detalhes do erro.

**Filter.** Deixa passar só os itens que atendem às condições e descarta os outros; tem uma saída só, como no n8n. As condições são as mesmas do If (é igual, é diferente, contém, maior, está vazio, combina com a regex etc.) e se combinam com E (todas) ou OU (pelo menos uma). Ligue Ignorar maiúsculas e minúsculas para "SP" contar igual a "sp", inclusive na regex. A comparação já tolera tipos diferentes: o número 10 e o texto "10" são iguais. Exemplo: com a condição {{ $json.uf }} é igual a SP, só os pedidos de São Paulo seguem.

**Switch.** Manda cada item para uma das saídas. No modo Regras, cada linha da lista é uma regra com Valor, Operador, Comparar com e Nome da saída; cada regra vira uma saída, na ordem da lista (a primeira é a saída 0), com o nome que você der ou o número dela. Por padrão o item vai só para a primeira regra que bate; com Mandar para todas as regras que batem, ele vai para cada uma delas. Em Itens que não batem com nenhuma regra, escolha Descartar, Mandar para uma saída extra (aparece a saída "Outros", a última) ou Mandar para a saída de uma regra (informe o número da saída, começando em 0). Ignorar maiúsculas e minúsculas vale para todas as regras. No modo Expressão, defina o Número de saídas e, em Saída do item, uma expressão que devolva o número da saída de cada item (começando em 0); um número fora da faixa para o fluxo com um erro que diz a faixa válida. Exemplo: regras {{ $json.prioridade }} é igual a alta (saída "urgente") e {{ $json.valor }} é maior que 1000 (saída "grande"), com a saída extra para o resto.

**Compare Datasets.** Recebe duas entradas, A e B, e casa os itens pelos campos de Campos para casar os itens (campo em A e campo em B; aceita caminho com ponto, como cliente.id). Os itens saem por quatro saídas: só em A (sem par em B), iguais (o par tem todos os campos iguais), diferentes e só em B. Em Quando houver diferenças, escolha usar a versão de A, a de B, misturar as versões (prefira uma e diga em Exceto nos campos quais campos vêm da outra) ou incluir as duas versões, que gera um item com keys (os campos de casamento), same (os campos iguais), different (cada campo diferente com inputA e inputB) e, quando houver, skipped. Comparação tolerante faz o número 3 e o texto "3" contarem como iguais, assim como vazio, nulo e lista vazia. Campos que não entram na comparação são separados por vírgula (ex.: atualizado_em). Em Vários pares para o mesmo item, escolha usar só o primeiro par de B ou todos. Itens vazios são ignorados. Exemplo: A com os produtos do ERP, B com os da loja, casando id com sku; a saída diferentes lista o que precisa ser atualizado.

**Wait.** Para o fluxo e depois continua. Em Continuar, escolha:

- **Depois de um intervalo:** Esperar e Unidade (segundos, minutos, horas ou dias). Segue com os mesmos itens.
- **Numa data e hora:** Data e hora no formato aaaa-mm-dd hh:mm:ss e Fuso horário, como no Agendamento; uma expressão também pode devolver uma data ISO com fuso, como 2026-11-01T12:00:00Z. Se a data já passou, segue na hora. Segue com os mesmos itens.
- **Quando a URL de retomada for chamada (webhook):** o fluxo fica parado até alguém chamar `{{ $execution.resumeUrl }}` (o endereço `/webhook-waiting/<id da execução>`, mais o Sufixo do caminho, se houver). Mande esse endereço antes, num HTTP Request, num e-mail ou numa mensagem. A chamada vira o item de saída, com headers, query e body, como no Webhook, e tem as mesmas opções de método, autenticação, IPs, robôs e resposta. Chamar de novo depois de retomado dá 409.
- **Quando um formulário for enviado:** o fluxo fica parado até alguém enviar o formulário do endereço `{{ $execution.resumeFormUrl }}`; os campos e a saída são como no Form Trigger. Bom para aprovações: o fluxo manda um e-mail com o link, o gestor aprova ou recusa, e o fluxo segue com a resposta.

Nos dois últimos, **Limitar o tempo de espera** faz o fluxo seguir sozinho depois de um intervalo ou numa data, com os itens que chegaram no Wait.

Esperas de mais de 1 minuto **pausam a execução de verdade**: ela fica Esperando em Execuções, não ocupa vaga de execução simultânea, não tem limite de prazo e continua mesmo se o Info8n for reiniciado. Esperas mais curtas acontecem com a execução rodando. Cancelar uma execução Esperando a encerra na hora. Dentro de um subfluxo (chamado pelo Execute Workflow), o Wait não pausa: espera rodando, até 24 dias, e não aceita webhook nem formulário. Os endereços de retomada usam o PUBLIC_URL do .env; sem ele, apontam para localhost e só funcionam no próprio servidor (peça ao administrador para configurar). Exemplo: esperar 10 minutos entre enviar um pedido ao ERP e consultar o status dele.

**No Operation.** Não faz nada: repassa os itens como chegaram. Serve para organizar o desenho do fluxo ou marcar um ponto de junção.

### Dados

**Split Out.** Transforma a lista de dentro de um item em vários itens, um por elemento. Informe o caminho do campo (ou uma expressão que devolva a lista), se os outros campos do item vão junto e o nome do campo de destino.

**Aggregate.** O contrário do Split Out: junta todos os itens em um só, com uma lista para cada campo escolhido, ou com os itens inteiros num campo (padrão data).

**Merge.** Junta duas entradas e espera as duas chegarem antes de rodar. Modos:

- **Emendar:** os itens da entrada 1 e depois os da entrada 2.
- **Combinar por campo em comum:** junta os itens com o mesmo valor num campo de cada lado. Mantém só os que combinam, ou todos da entrada 1.
- **Combinar pela posição:** o primeiro com o primeiro, o segundo com o segundo, e assim por diante.
- **Escolher uma das entradas:** só uma segue adiante, depois que as duas chegam.

**Edit Fields (Set).** Cria ou altera campos, como no n8n. Em Manual Mapping, cada campo tem nome, tipo (String, Number, Boolean, Array, Object) e valor; em JSON, você escreve o objeto inteiro. Include Other Input Fields decide se o item de saída leva os outros campos que chegaram (todos, só alguns ou todos menos alguns). Com Support Dot Notation, o nome a.b cria { a: { b } }. Include Binary File (ligado) mantém os arquivos que chegaram no item; desligado, o item sai só com o JSON.

**Code.** Roda JavaScript ou Python sobre os itens, uma vez com todos ou uma vez por item.

- **JavaScript:** use $input.all(), $json, $('Nó').first(), $execution. Pode usar await. Devolva uma lista de objetos (ou um objeto, no modo por item).
- **Python:** use \_input.all(), \_json, \_('Nó').first(), \_execution e a biblioteca padrão do Python. item.json.campo e item.json\['campo'\] funcionam. Devolva uma lista de dicionários (ou um dicionário, no modo por item).
- O que o código escreve com console.log ou print aparece na saída do nó e no log da execução.
- **Arquivos:** os arquivos do item ficam em item.binary (no JavaScript, também em `$binary`), com o conteúdo em base64 em data. Para devolver um arquivo, devolva o item com binary, por exemplo `return [{ json: {}, binary: { data: { data: '<base64>', mimeType: 'text/plain', fileName: 'oi.txt' } } }]`; mimeType e data são obrigatórios.

**Limit.** Deixa passar no máximo um certo número de itens. Em Máximo de itens, informe o limite (a partir de 1); em Manter, escolha se ficam os primeiros ou os últimos itens da lista. Se chegarem menos itens do que o limite, todos passam. Exemplo: depois de um Sort decrescente por valor, um Limit com máximo 10 e Manter "Os primeiros itens" entrega os dez maiores pedidos.

**Sort.** Ordena os itens. No tipo Simples, a lista Campos para ordenar diz por quais campos e em que ordem (crescente ou decrescente); o segundo campo só desempata o primeiro. O campo aceita caminho com ponto (cliente.nome), textos são comparados sem diferenciar maiúsculas e números em ordem numérica. Se o campo não existir em nenhum item, o nó dá erro. Desligar notação de ponto faz "a.b" ser lido como o nome exato de um campo. O tipo Aleatória embaralha os itens. No tipo Código, você escreve o corpo de uma função JavaScript que recebe a e b (os campos ficam em a.json e b.json) e devolve um número negativo se a vem antes, positivo se b vem antes e zero se tanto faz; exemplo: return a.json.valor - b.json.valor.

**Remove Duplicates.** Remove os itens repetidos que chegaram juntos, mantendo a primeira ocorrência. Em Comparar, escolha Todos os campos, Todos os campos menos alguns (Campos a ignorar, separados por vírgula) ou Só os campos escolhidos (Campos a comparar, separados por vírgula; aceita caminho com ponto, como cliente.email). Como no n8n, os campos comparados precisam existir em todos os itens (valor nulo é aceito) e ter sempre o mesmo tipo; caso contrário o nó dá erro, então em itens com formatos diferentes prefira Só os campos escolhidos. Objetos iguais com as chaves em outra ordem contam como iguais. Remover os outros campos deixa em cada item só os campos comparados. Desligar notação de ponto faz "a.b" ser lido como o nome exato de um campo. Exemplo: Comparar "Só os campos escolhidos" com email deixa um item por e-mail. A remoção de itens já vistos em execuções anteriores, que o n8n também oferece, ainda não existe aqui.

**Rename Keys.** Troca o nome de campos. Na lista Campos para renomear, cada linha tem o Nome atual e o Nome novo; os dois aceitam caminho com ponto, então end.cep para endereco.cep move o campo para dentro de outro objeto. Campos que não existem no item são ignorados. Em Renomear por expressão regular, cada linha tem a Expressão regular, o texto para Trocar por (use $1, $2 para os grupos capturados), Ignorar maiúsculas e a Profundidade máxima (-1 sem limite, 0 só o primeiro nível, 1 até o segundo); essas trocas valem para os campos de todos os níveis, inclusive objetos dentro de listas, e rodam depois da lista de cima. Exemplo: a expressão ^cli_(.*) trocada por $1 transforma cli_nome em nome.

**Summarize.** Calcula resumos dos itens, como uma tabela dinâmica. Em Campos para resumir, cada linha tem o Cálculo, o Campo e, conforme o cálculo, Incluir vazios e o Separador. Cálculos: Juntar em lista (appended_campo), Média (average_campo), Concatenar em texto (concatenated_campo, com separador vírgula, vírgula e espaço, quebra de linha, espaço, nenhum ou um personalizado), Contar (count_campo), Contar valores distintos (unique_count_campo), Máximo (max_campo), Mínimo (min_campo) e Soma (sum_campo). Média e soma consideram só valores numéricos; contar, juntar e concatenar ignoram valores vazios, nulos ou ausentes, a menos que Incluir vazios esteja ligado. Pontos e espaços do nome do campo viram sublinhado na saída (pedido.valor vira sum_pedido_valor). Em Agrupar por, informe campos separados por vírgula para ter um resumo por grupo; o valor de cada campo de agrupamento vai junto no item. Formato da saída escolhe um item por grupo ou todos os grupos num item só, aninhados pelo valor de cada campo. Ignorar itens sem valor para agrupar descarta itens com o campo de agrupamento vazio (o número 0 conta como valor). Continuar se o campo não existir (ligado por padrão) faz o nó seguir com um aviso quando um campo a resumir não aparece em nenhum item; desligado, o nó dá erro. Desligar notação de ponto faz "a.b" ser lido como o nome exato de um campo. Exemplo: Soma de valor agrupada por uf gera itens como { sum_valor: 150, uf: "SP" }.

**Date & Time.** Trabalha com datas e horas, como o nó Date & Time do n8n. Operações: Pegar a data atual (com ou sem a hora; desligada, a hora fica meia-noite), Somar a uma data e Subtrair de uma data (data, unidade de tempo de anos a milissegundos e quantidade), Formatar uma data (formatos prontos como DD/MM/AAAA, MM/DD/AAAA, AAAA-MM-DD e timestamp Unix em segundos ou milissegundos, ou um formato personalizado com os tokens do luxon, por exemplo dd/MM/yyyy HH:mm; o Formato da data de entrada ajuda quando a data não é reconhecida sozinha, por exemplo yyyyMMdd), Arredondar uma data (para baixo até o início do ano, mês, semana, dia, hora, minuto ou segundo; para cima até o fim do mês, que dá o início do mês seguinte), Tempo entre datas (diferença nas unidades marcadas, como objeto { days: 1, hours: 6 } ou, com Saída como texto ISO, P1DT6H) e Extrair parte de uma data (ano, mês, semana do ano, dia, hora, minuto ou segundo). A data pode ser um texto ISO (2026-04-09T15:30:00-03:00), uma data sem fuso (2026-04-09 15:30, lida no fuso do nó), um timestamp em segundos ou milissegundos ou datas nos formatos RFC 2822, HTTP e SQL. O Fuso horário (padrão America/Sao_Paulo) vale para as contas e para o resultado, que sai em ISO com o deslocamento (2026-04-09T12:30:00.000-03:00). Na operação Formatar, como no n8n, a data é formatada em UTC (ou no deslocamento "+hh" da própria data) a menos que você ligue Usar o fuso horário do nó. O Nome do campo de saída vazio usa o nome do n8n para a operação (currentDate, newDate, formattedDate, roundedDate, timeDifference ou datePart), e Incluir os campos de entrada leva junto os campos do item que chegou. Exemplo: Formatar {{ $json.criadoEm }} com DD/MM/AAAA e o fuso do nó ligado grava formattedDate = 09/04/2026.

**Crypto.** Gera hash, HMAC, assinatura ou textos aleatórios, como o nó Crypto do n8n. Ações: Hash de um texto (MD5, SHA1, SHA256, SHA384, SHA512, SHA3-256, SHA3-384 ou SHA3-512, em HEX ou BASE64), HMAC de um texto (os mesmos tipos, com o Segredo informado no nó), Assinar com chave privada (escolha a conexão do tipo Chave privada, com a chave em formato PEM, e o algoritmo, por exemplo RSA-SHA256) e Gerar texto aleatório (UUID, ou HEX, BASE64 e ASCII com o tamanho pedido). O resultado vai para o Nome do campo de saída (padrão data), junto com os outros campos do item; um nome com pontos, como seguranca.hash, cria o campo dentro de outro. Exemplo: Hash SHA256 de {{ $json.cpf }} em HEX grava data = o hash de 64 caracteres. Em Hash e HMAC, Usar um arquivo do item calcula sobre o conteúdo do arquivo (Propriedade do arquivo, padrão data) em vez de um texto; serve para conferir se um arquivo baixado é igual ao que o parceiro informou. Os arquivos do item seguem na saída. As ações de criptografar e descriptografar ainda não existem aqui.

**HTML.** Trabalha com HTML, como o nó HTML do n8n. Gerar HTML a partir de modelo devolve um item { html } para cada item de entrada; escreva o modelo no modo Expressão para incluir valores com {{ }}, por exemplo <p>Olá {{ $json.nome }}</p>. Extrair conteúdo do HTML lê o HTML do campo informado (padrão data; pode ser um texto ou uma lista de textos, e cada um vira um item) e, para cada linha de Valores a extrair, grava no Nome do campo o que o Seletor CSS encontra: o Texto (blocos viram linhas, títulos ficam em maiúsculas e links e imagens mostram o endereço entre colchetes; Ignorar seletores tira partes do texto, como img ou .anuncio), o HTML interno, um Atributo (como href) ou o Valor de um campo de formulário. Com Devolver lista, cada elemento encontrado vira uma posição da lista; sem ela, vale o primeiro elemento encontrado. Tirar espaços das pontas e Limpar o texto (que tira as quebras de linha e junta espaços repetidos) vêm ligados, como no n8n. Converter em tabela HTML junta todos os itens numa tabela (um item { table }), com uma coluna para cada campo, caixas de seleção para valores verdadeiro/falso e estilo padrão que você pode desligar em Estilo próprio; as opções são Cabeçalhos com iniciais maiúsculas (codigo_pedido vira Codigo Pedido), Legenda e atributos da tabela, do cabeçalho, das linhas e das células (os das linhas e células podem usar expressões de cada item). Em Origem do HTML, escolha Campo JSON ou Arquivo do item; com arquivo, Campo com o HTML é o nome do arquivo no item (padrão data), lido como texto UTF-8. Exemplo: HTTP Request com Formato da resposta Arquivo baixa a página, e o HTML extrai os preços dela.

**Markdown.** Converte texto entre Markdown e HTML, como o nó Markdown do n8n, e grava o resultado no Campo de destino (padrão data; aceita pontos, como email.corpo), mantendo os outros campos do item. Em HTML para Markdown, as opções são o marcador de lista (padrão *), a cerca dos blocos de código (```), os delimitadores de ênfase (_) e negrito (**), o estilo dos blocos de código (cerca ou recuo), elementos ignorados e elementos tratados como blocos (separados por vírgula), manter imagens com data:, o máximo de linhas em branco seguidas, URLs no fim do texto e substituições de texto (cada uma troca a primeira ocorrência do trecho). Em Markdown para HTML, as opções principais do showdown estão disponíveis: abrir links em nova janela, transformar URLs em links, tabelas, tachado, listas de tarefas, emoji, quebra de linha simples como <br>, documento HTML completo, títulos sem ID ou com ID no estilo do GitHub, nível inicial dos títulos, prefixo dos IDs e outras. Exemplo: o HTML <h1>Oi</h1><p><b>forte</b></p> vira "# Oi" e "**forte**".

**XML.** Converte entre XML e JSON, como o nó XML do n8n. Em XML para JSON, o XML vem do campo informado (padrão data) e o item de saída é o JSON lido; por padrão os atributos viram campos do elemento e as listas só aparecem quando há mais de um filho com o mesmo nome. As opções são Chave dos atributos ($) e do texto (_), Sempre usar listas, Manter o elemento raiz, Ignorar atributos, Juntar atributos com os filhos, Normalizar espaços do texto, Tags em minúsculas e Tirar espaços das pontas do texto. Em JSON para XML, o item inteiro vira XML e é gravado no campo informado, com as opções Nome do elemento raiz (root; com um campo só no item, o próprio campo vira a raiz), Sem cabeçalho XML, Usar CDATA e Permitir caracteres substitutos Unicode. Exemplo: <pedido id="7"><item>a</item><item>b</item></pedido> vira { pedido: { id: "7", item: ["a", "b"] } }.

### Arquivos

**Convert to File.** Transforma os itens em arquivo, como o nó Convert to File do n8n. O arquivo vai para o Campo do arquivo de saída (padrão data) e o item de saída fica só com ele (o JSON sai vazio). Operações: Converter para CSV, XLSX (Excel), HTML (tabela) ou RTF (tabela), que juntam todos os itens num arquivo só, com uma coluna por campo (campos dentro de outros viram colunas com ponto, como endereco.cidade; booleanos saem TRUE/FALSE), com as opções Linha de cabeçalho, Separador (no CSV, padrão vírgula), Nome da aba e Compactar mais (no XLSX); Converter para JSON, com Todos os itens num arquivo (uma lista) ou Um arquivo por item, e as opções Formatar o JSON, Codificação e Incluir BOM; Converter para arquivo de texto, que grava o texto do Campo de entrada (aceita caminho com ponto) na codificação escolhida; Base64 para arquivo, que transforma um texto em base64 (com ou sem o prefixo data:...;base64,) no arquivo original, com o tipo pelo Nome do arquivo, pelo Tipo MIME informado ou pelo próprio conteúdo; e Converter para ICS, que cria um evento de calendário por item, com os mesmos campos do nó iCalendar. O Nome do arquivo vazio usa File.csv, File.xlsx etc. nas planilhas, file.json, file.txt ou event.ics. XLS e ODS não existem aqui: salve como XLSX ou CSV. Exemplo: depois de um Banco de dados com os pedidos do dia, Converter para XLSX com Nome da aba Pedidos e Nome do arquivo pedidos.xlsx gera a planilha pronta para anexar num e-mail.

**Extract from File.** Lê o arquivo de um item e transforma em dados, como o nó Extract from File do n8n. Informe o Campo do arquivo de entrada (padrão data). Planilhas viram um item por linha: Extrair de CSV (Separador, Codificação, com UTF-8, Latin1 e Windows-1252 entre outras, Excluir BOM, Preservar aspas, Linha inicial, Máximo de linhas e Pular linhas com erro, com um Máximo de linhas puladas; os valores saem sempre como texto), Extrair de XLSX (Nome da aba, vazia é a primeira; Intervalo, como A1:D50 ou o número da linha inicial a partir de 0; números e booleanos mantêm o tipo e datas saem em ISO, ou como número serial do Excel com Dados brutos) e Extrair de HTML ou RTF (a primeira tabela do arquivo; números viram número, a menos que Dados brutos esteja ligado). Nessas quatro, Linha de cabeçalho (ligada) usa a primeira linha como nomes dos campos (nomes repetidos ganham _1 e vazios viram __EMPTY); desligada, cada linha sai como { row: [...] }. Incluir células vazias põe texto vazio nas células em branco, que normalmente ficam de fora. As outras operações gravam o conteúdo no Campo de saída (padrão data; aceita caminho com ponto): Extrair de JSON (o JSON lido; com o Campo de saída vazio, o item inteiro vira o JSON do arquivo), Extrair de arquivo de texto e Extrair de XML (o texto, na Codificação do arquivo escolhida; para transformar o XML em JSON, use depois o nó XML), Extrair de ICS (o calendário com a lista events, cada evento com uid, summary, start, end, location, attendees, recurrenceRule etc.) e Arquivo para base64 (o conteúdo em base64). Extrair de PDF devolve numpages, info (título, autor, datas), metadata, text e version; Máximo de páginas lê só as primeiras (0 é todas), Juntar páginas desligado devolve text como uma lista com uma posição por página, e Senha abre PDFs protegidos. PDFs escaneados (só imagem) não têm texto. Em JSON, texto, XML, ICS, base64 e PDF, Manter da entrada escolhe o que segue junto: Nada (padrão: só o resultado e os outros arquivos do item), JSON do item, Arquivo do item ou JSON e arquivo. XLS e ODS não existem aqui: salve como XLSX ou CSV. Exemplo: um e-mail com a planilha de preços em anexo vai para Extract from File com Extrair de XLSX e Campo do arquivo de entrada attachment_0; cada linha da planilha vira um item, pronto para o nó Banco de dados inserir.

**iCalendar.** Cria um arquivo de evento .ics para cada item, como o nó iCalendar do n8n, para mandar convites por e-mail ou publicar numa agenda. Informe o Título do evento, o Início e o Fim (vazio é igual ao início); com Dia inteiro ligado, a hora é ignorada e o evento ocupa os dias inteiros do início ao fim. Datas sem fuso, como 2026-05-10T14:00, são lidas no Fuso horário do nó (padrão America/Sao_Paulo) e o arquivo sai em UTC; datas com fuso (2026-05-10T14:00:00-03:00) e timestamps valem como estão. Opcionais: Descrição, Local, URL, Participantes (nome, e-mail e Pedir confirmação), Organizador (nome e e-mail), Latitude e Longitude, Status (Confirmado, Cancelado ou Provisório), Disponibilidade (Ocupado ou Provisório, usada pelo Outlook), Regra de repetição (RRULE, como FREQ=WEEKLY;BYDAY=MO;COUNT=10), Nome do calendário, UID (vazio gera um novo; para atualizar um evento já enviado, use o mesmo UID e aumente a Sequência) e Nome do arquivo (padrão event.ics). O arquivo vai para o Campo do arquivo de saída (padrão data). Exemplo: para cada agendamento vindo do ERP, Título Visita técnica - {{ $json.cliente }}, Início {{ $json.dataHora }}, Participantes com o e-mail do cliente, e um nó Gmail depois anexa o campo data no convite.

**Compression.** Compacta e descompacta arquivos, como o nó Compression do n8n. Em Compactar, informe o Campo(s) de arquivo de entrada (padrão data; vários separados por vírgula, como data, data2) e o Formato de saída: Zip (padrão) e Tar juntam todos os arquivos do item num só, com o Nome do arquivo (ex.: pedidos.zip) gravado em Colocar o arquivo no campo (padrão data); Tar (Gzip) faz um .tar.gz; Gzip compacta cada arquivo separado, com o nome original mais ".gz" (relatorio.csv vira relatorio.csv.gz) nos campos data, data1, data2… Em Descompactar, o nó reconhece zip, gzip, tar, tar.gz e tgz pela extensão do arquivo e põe cada arquivo extraído num campo com o Prefixo de saída (padrão file_: file_0, file_1…), com o nome e a pasta de dentro do pacote; pastas e a lixeira __MACOSX do Mac ficam de fora. O JSON do item passa igual. Por segurança, o conteúdo descompactado de um item pode ter até 512 MB e 10.000 arquivos. Exemplo: Read Files from Disk lê /files/entrada/notas.zip, Compression descompacta e cada nota fica em file_0, file_1…, prontas para o Extract from File.

**Edit Image.** Edita imagens, como o nó Edit Image do n8n. A imagem vem do Campo do arquivo (padrão data). Operações: Redimensionar (largura e altura com a Opção: Área máxima, o padrão, que só reduz até largura × altura pixels; Área mínima, que cobre a largura e a altura; Ignorar a proporção; Só se for maior; Só se for menor; Porcentagem), Cortar (largura, altura e posição X e Y do canto), Girar (graus no sentido horário e a cor de fundo dos cantos), Borrar (sigma, a intensidade), Borda (largura, altura e cor), Desenhar (retângulo com cantos arredondados, círculo pelo centro e um ponto da borda, ou linha, entre a posição inicial e a final), Escrever texto (texto, tamanho e cor da fonte, alinhamento horizontal e vertical, deslocamento X e Y a partir do alinhamento, máximo de caracteres por linha e a fonte, pelo nome da família instalada no servidor), Sobrepor imagem (outra imagem do item, por cima, na posição X e Y, com o operador Over, Multiply, Difference e outros), Inclinar (graus em X e em Y), Cor transparente (a cor escolhida some), Criar imagem (nova, com largura, altura e cor de fundo; não precisa de imagem de entrada), Informações (devolve no JSON o formato, o tamanho em size.width e size.height, a profundidade e as cores, sem mudar a imagem) e Várias etapas (uma lista de operações feitas em ordem; campo vazio numa etapa vale o padrão daquela operação). As cores aceitam #rrggbb, nomes como red e transparent; com 8 dígitos (#rrggbbaa), os dois últimos são a opacidade invertida, como no n8n: 00 é opaco e ff é transparente. No fim, escolha o Formato (bmp, gif, jpeg, png, tiff ou WebP; padrão: o mesmo da entrada, PNG ao criar), a Qualidade (0 a 100), o Nome do arquivo e o Campo de saída (padrão: o mesmo da entrada). Exemplo: Várias etapas com Redimensionar 400 × 400 em Só se for maior e Borda de 10 × 10 na cor #ffffff, no formato jpeg com qualidade 80, gera a miniatura do produto para o site.

**Read/Write Files from Disk.** Lê e grava arquivos no servidor do Info8n, como o nó Read/Write Files from Disk do n8n. Ele só enxerga as pastas liberadas pelo administrador na variável FILES_DIRS do .env; no Docker a pasta padrão é /files, ligada à pasta arquivos ao lado do docker-compose.yml no computador. Caminhos fora dessas pastas (inclusive com ".." ou por atalhos) são recusados, e um caminho relativo começa na primeira pasta liberada. Em Ler arquivo(s) do disco, informe o caminho ou um padrão com curingas, sempre com "/": * é qualquer nome, ** qualquer subpasta, ? um caractere e {csv,txt} uma das opções (ex.: /files/entrada/**/*.csv). Cada arquivo encontrado vira um item, com o arquivo em Colocar o arquivo no campo (padrão data) e, no JSON, mimeType, fileType, fileName, fileExtension e fileSize; se nada for encontrado, o nó para com erro. Dá para trocar o nome, a extensão e o tipo MIME informados na saída; [ ] e ( ) são tratados como texto, a menos que você desligue a opção para usá-los como classe ([0-9]) ou grupo. Arquivos de até 512 MB. Em Gravar arquivo no disco, informe o Caminho e nome do arquivo (ex.: /files/saida/relatorio.pdf; pastas que faltam são criadas) e o Campo do arquivo de entrada (padrão data); com Acrescentar ao final, o conteúdo vai para o fim de um arquivo que já existe (bom para CSV e log). O item segue com o JSON de entrada mais fileName. Exemplo: Convert to File gera o CSV de vendas e Gravar arquivo no disco salva em /files/relatorios/vendas.csv, que aparece na pasta arquivos/relatorios do computador.

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
| TOTP (código de dois fatores) | Chave secreta em base32 e identificação opcional | TOTP |
| Chave privada (assinatura) | Chave privada no formato PEM, colada com as quebras de linha | Crypto, operação Assinar |

- **Testar conexão:** bancos, Metabase, ClickUp e Gmail têm o botão Testar conexão no formulário, que tenta conectar antes de salvar.
- **Senhas e tokens:** ficam criptografados e nunca voltam para a tela. Ao editar, deixe o campo em branco para manter o valor atual.
- **Excluir:** uma conexão usada por algum fluxo não pode ser excluída; o sistema lista quais fluxos a usam.
- **Rede:** o Info8n acessa os bancos e as APIs a partir do servidor onde está instalado. Se um banco de cliente só aceita conexões de certos IPs, libere o IP desse servidor.

#### Conectar o Gmail

O Gmail não usa senha: a conta do Google autoriza o Info8n uma vez, pelo botão Conectar com Google, e o Info8n guarda essa autorização criptografada. Para isso é preciso um app OAuth no Google Cloud, criado uma vez e usado por todas as conexões do Gmail.

O passo a passo completo, com telas do Google Cloud, uso no fluxo e problemas comuns, está em [Conectar o Gmail (guia completo)](conectar-gmail.md).

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
| Esperando | Parada num Wait ou num Form; a tela da execução diz em qual nó, o que espera e até quando |
| Sucesso | Terminou sem erro |
| Erro | Parou num nó; a coluna Erro diz qual e por quê |
| Cancelada | Alguém cancelou |

| Tipo | Origem |
| --- | --- |
| Manual | Botão Executar no editor |
| Agendada | Gatilho Agendamento de um fluxo ativo |
| Subfluxo | Chamada por outro fluxo pelo Execute Workflow |
| Reexecução | Botão Executar de novo |
| Webhook | Chamada no endereço de produção de um Webhook ou Form Trigger |
| Gatilho | RSS Feed Trigger, Email Trigger, Local File Trigger, SSE Trigger ou n8n Trigger |
| Fluxo de erro | Disparada pelo Error Trigger porque outro fluxo falhou |

**A tela da execução** mostra quem disparou, quando começou, quanto durou e a versão do fluxo que rodou. Se houve erro, o painel vermelho diz em qual nó, a mensagem e os detalhes (por exemplo, a resposta da API ou o código do erro do banco). Abaixo, a lista Nós executados traz cada nó na ordem em que rodou, com a quantidade de itens e o tempo. Clique num nó para ver a entrada e a saída dele, as tentativas, os logs do código e os links para os subfluxos que ele chamou. Um nó dentro de um Loop aparece uma vez por volta.

- **Executar de novo:** roda outra vez a mesma versão do fluxo, com a mesma entrada. A nova execução aponta para a original.
- **Cancelar:** interrompe uma execução na fila, em andamento ou esperando.
- **Abrir fluxo** e **ver quem chamou** (em subfluxos) levam ao fluxo e à execução de origem.

**O que fica guardado.** Para os logs ocuparem pouco espaço:

- Execuções agendadas que terminam com sucesso, e os subfluxos chamados por elas, guardam só o resumo: cada nó, o status, a quantidade de itens e o tempo, sem os dados. As que dão erro, as manuais e as reexecuções (com os subfluxos que elas chamam) guardam tudo. O administrador pode mudar isso para guardar tudo sempre.
- Arquivos dos itens: nas execuções manuais e nas reexecuções, o conteúdo fica guardado (até 64 MB por execução; arquivos iguais contam uma vez) e a lista Arquivos de cada nó tem Abrir e Baixar. Nas outras, só o nome, o tipo e o tamanho ficam no histórico.
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
| Webhook, Form Trigger, Respond to Webhook, Form, Error Trigger, n8n Trigger, RSS, IMAP, Local File e SSE Trigger | Existem, com os mesmos endereços (/webhook, /webhook-test, /form...). Os outros gatilhos do n8n (de aplicativos como Slack ou Typeform) não existem |
| Fluxo de erro (Error Workflow nas configurações) | Configurações do fluxo, no editor. Vem na importação quando o fluxo de erro é importado junto ou antes |
| Credenciais | Conexões. Elas não vêm na importação: cadastre em Conexões e escolha em cada nó |
| $now, $today, DateTime (Luxon) | Não existem nas expressões. Use new Date() e os métodos comuns do JavaScript, ou o nó Date & Time |
| Métodos extras como .isEmpty(), .toFormat(), .toISO() de datas do Luxon | Não existem. Reescreva em JavaScript comum. .toJsonString() funciona |
| Paginação automática no HTTP Request | Não existe. Use um Loop que chama a próxima página |
| Split In Batches | Vira Loop |
| Function e Function Item | Viram Code |
| Item Lists | Cada operação vira o nó próprio: Split Out, Aggregate, Limit, Sort, Remove Duplicates ou Summarize |
| HTML Extract | Vira o HTML com a operação Extrair conteúdo |
| Switch | Cada regra do Info8n tem uma condição; regras do n8n com várias condições ficam com a primeira e a importação avisa |
| Wait por webhook ou formulário | Funciona, com $execution.resumeUrl e $execution.resumeFormUrl. Configure o PUBLIC_URL para os endereços saírem certos |
| Webhook com vários métodos | Um método por nó; duplique o nó para os outros. A importação avisa |
| Credencial do Webhook (Basic, Header) e do IMAP | Recrie como conexão Usuário e senha, Header com chave ou IMAP e escolha no nó |
| Remove Duplicates entre execuções | Ainda não existe; só remove repetidos dentro da mesma execução |
| Dados binários | Funcionam como no n8n: arquivos nos itens, com HTTP Request, Gmail, HTML, Crypto e os nós de arquivos. Read/Write Files from Disk só usa as pastas liberadas em FILES_DIRS |
| Spreadsheet File, Read PDF, Move Binary Data, Read/Write Binary File(s) | Viram Convert to File, Extract from File e Read/Write Files from Disk |
| Planilhas XLS e ODS | Não existem; use XLSX ou CSV. A importação avisa |
| Always Output Data | Não existe. Um nó sem itens encerra aquele caminho |
| Saída de erro separada | Com Continuar em caso de erro, o item de erro segue pela saída normal |
| Code em Python com \_items ou .to\_py() | Use \_input.all() e \_json; os itens já são dicionários. Só a biblioteca padrão do Python |
| Code em JavaScript com require() | Não existe |
| Execute Workflow sem esperar | Sempre espera o subfluxo terminar |
| Gmail | Mesmas operações principais; excluir e-mail vira mover para a lixeira. Escolha a conexão do Gmail depois de importar. Anexos de dados binários e o prefixo dos anexos baixados são convertidos |

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
| Não consigo ativar o fluxo | O fluxo tem pendências, não foi salvo ou não tem gatilho que dispara sozinho | Salve, corrija a faixa amarela e tente de novo |
| O webhook responde 404 "não existe ou o fluxo não está ativo" | Fluxo inativo, caminho ou método diferente | Ative o fluxo e confira o endereço de Produção na janela do nó |
| O webhook de teste responde 404 "não está escutando" | Faltou clicar em Escutar, ou passaram os 2 minutos | Clique em Escutar e chame o endereço de teste logo em seguida |
| O gatilho não iniciou ao ativar | O gatilho não conseguiu conectar (senha do e-mail, endereço SSE fora do ar, pasta fora de FILES_DIRS) | Corrija o que a mensagem diz e ative de novo |
| O link do Wait ou do formulário aponta para localhost | PUBLIC_URL não está configurado no .env | Peça ao administrador para preencher PUBLIC_URL com o endereço do Info8n |
| A execução fica Esperando para sempre | O Wait espera um webhook ou formulário que ninguém chamou | Chame o endereço de retomada, ligue Limitar o tempo de espera ou cancele a execução |
| O Local File Trigger não dispara no Docker Desktop | O aviso de mudança do Windows não chega ao container | Ligue Verificar por consulta (polling) no nó |
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
