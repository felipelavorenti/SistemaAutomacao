# Info8n: conectar o Gmail (login com Google)

Passo a passo completo para criar o app no Google Cloud, conectar uma conta do Gmail no Info8n e usar a conexão nos fluxos. O resumo fica no [Manual de uso](manual-de-uso.md#conectar-o-gmail).

## Visão geral

O Info8n entra no Gmail pelo login do Google, sem senha: você cria um app no Google Cloud uma vez, e cada conta do Gmail autoriza o Info8n com um clique. O app do Google Cloud serve para todas as contas que você for conectar.

Antes de começar, tenha em mãos:

- Uma conta do Google para criar o app (pode ser a mesma que vai ser conectada).
- O Info8n aberto no navegador, com perfil Editor ou Administrador.
- O endereço de retorno do Info8n, que aparece no formulário da conexão do Gmail (ex.: `http://localhost:3000/api/oauth/google/callback`).

## Parte 1: criar o projeto e ativar a API do Gmail

Feito uma vez só, no Google Cloud.

1. Entre em [console.cloud.google.com](https://console.cloud.google.com) com a sua conta do Google. Se for o primeiro acesso, aceite os termos.
2. No seletor de projetos, no alto da tela, clique em **Novo projeto**, dê o nome **Info8n** e clique em **Criar**. Depois selecione esse projeto no mesmo seletor.
3. No menu, abra **APIs e serviços → Biblioteca**, procure **Gmail API** e clique em **Ativar**.

## Parte 2: configurar a tela de consentimento

É o que aparece para a conta do Google na hora de autorizar o Info8n.

1. No menu, abra **Google Auth Platform** (em algumas contas aparece como **Tela de consentimento OAuth**) e clique em **Começar**.
2. Em **Informações do app (Branding)**, preencha o nome do app (**Info8n**) e o e-mail de suporte (o seu).
3. Em **Público-alvo**, escolha o tipo:
   - **Interno**: só aparece para contas do Google Workspace da empresa. É a melhor opção quando dá, porque não vence nem pede verificação.
   - **Externo**: para contas @gmail.com comuns. O app fica em **Teste**.
4. Em **Informações de contato**, coloque o seu e-mail, aceite a política e clique em **Criar**.
5. Se escolheu **Externo**: em **Público-alvo → Usuários de teste**, clique em **Adicionar usuários** e coloque **cada conta do Gmail** que vai ser conectada no Info8n. Conta que não está nessa lista recebe o erro 403 access_denied.

Com o app Externo em Teste, a autorização de cada conta vence a cada 7 dias. Se o botão **Publicar app** estiver disponível em Público-alvo, publicar tira esse limite; o Google vai mostrar o aviso de app não verificado na hora de conectar, o que é normal para uso próprio.

## Parte 3: criar o cliente OAuth (Client ID e secret)

1. No Info8n, abra **Conexões → Nova conexão**, escolha o tipo **Gmail (login com Google)** e copie o **Endereço de retorno** que aparece no formulário. Pode deixar essa tela aberta.
2. No Google Cloud, em **Google Auth Platform → Clientes** (ou **APIs e serviços → Credenciais**), clique em **Criar cliente**.
3. Em **Tipo de aplicativo**, escolha **Aplicativo da Web** e dê o nome **Info8n**.
4. Em **URIs de redirecionamento autorizados**, clique em **Adicionar URI** e cole o Endereço de retorno copiado do Info8n. Se o Info8n é aberto por mais de um endereço, cadastre todos.
5. Clique em **Criar**. Copie na hora o **ID do cliente** e a **Chave secreta do cliente** e guarde num lugar seguro.

O Google só mostra o secret inteiro nesse momento. Se perder, não dá para ver de novo: crie outro (veja [Outra conta, novo secret e renovação](#outra-conta-novo-secret-e-renovação)).

## Parte 4: criar a conexão no Info8n

1. Em **Conexões → Nova conexão**, tipo **Gmail (login com Google)**, dê um nome que identifique a conta (ex.: Gmail financeiro).
2. Cole o **Client ID** e o **Client secret** da Parte 3.
3. Clique em **Conectar com Google**. O Info8n salva a conexão e abre o Google.
4. Escolha a conta do Gmail e autorize. Se aparecer "O Google não verificou este app", clique em **Avançado** e depois em **Acessar Info8n**.
5. O Google volta para Conexões com a mensagem "Conta do Google conectada", e a conexão mostra o e-mail da conta.

**Info8n aberto por IP.** O Google só aceita voltar para `localhost` ou para um domínio, nunca para um IP. Se você abre o Info8n por IP (ex.: `http://10.0.0.20:3000`), a aba que o Google abre no fim não carrega. Copie o endereço inteiro dessa aba, volte para a conexão, cole em **Endereço da página de retorno** e clique em **Concluir**. Para evitar isso, abra o Info8n por `http://localhost:3000` no próprio PC do servidor.

## Parte 5: usar no fluxo

Ponha um nó **Gmail** no fluxo, escolha a conexão e a operação. O e-mail sempre sai da conta conectada.

| Operação | Para que serve | O que preencher |
| --- | --- | --- |
| Enviar e-mail | Mandar um e-mail novo | Para, Cc, Cco, Assunto, Texto (simples ou HTML), Anexos |
| Responder e-mail | Responder na mesma conversa | ID do e-mail; Responder a todos se quiser |
| Criar rascunho | Deixar um e-mail pronto sem enviar | Os mesmos campos do envio |
| Buscar rascunhos | Achar rascunhos que já existem, inclusive os feitos à mão | Busca no padrão do Gmail, como `subject:"Relatório mensal"` |
| Enviar rascunho | Enviar um rascunho | ID do rascunho, em Expressão: `{{ $json.id }}` |
| Buscar e-mails | Ler e-mails que chegaram | Busca no padrão do Gmail, como `from:nf@fornecedor.com is:unread` |

**Anexar um arquivo do seu PC.** Em Anexos, clique em **Adicionar** e depois em **Escolher arquivo** (até 25 MB). O arquivo fica guardado no Info8n e vai em todo e-mail que o fluxo mandar.

**Enviar um rascunho feito no Gmail.** Fluxo com três nós:

1. Gatilho (manual ou Agendamento).
2. Gmail com **Buscar rascunhos** e uma busca que ache só esse rascunho, como `subject:"Relatório mensal"`.
3. Gmail com **Enviar rascunho** e o campo ID do rascunho em **Expressão** com `{{ $json.id }}`.

Depois de enviado, o rascunho deixa de existir. Para mandar o mesmo texto toda vez, use Enviar e-mail.

## Outra conta, novo secret e renovação

**Conectar outra conta do Gmail.** Não precisa criar outro app no Google Cloud.

1. Com o app Externo, adicione a nova conta em **Público-alvo → Usuários de teste**.
2. No Info8n, crie outra conexão Gmail com o mesmo Client ID e secret.
3. Clique em **Conectar com Google** e entre com a outra conta.

**Perdeu o secret.** Nem o Info8n nem o Google mostram o secret depois de salvo. Em **Google Auth Platform → Clientes**, abra o cliente do Info8n e clique em **Adicionar secret**. Copie o novo na hora. O antigo continua valendo, então as conexões que já existem não param.

**Renovar a cada 7 dias (app Externo em Teste).** Quando vencer, o nó Gmail falha com "O Google recusou o acesso salvo". Abra a conexão no Info8n e clique em **Conectar com Google** de novo. Não precisa mexer no Google Cloud.

## Problemas comuns

| O que aparece | Causa | Como resolver |
| --- | --- | --- |
| Erro 403 access_denied ao autorizar | A conta não está em Usuários de teste (app Externo em Teste) | Adicione a conta em Público-alvo → Usuários de teste e conecte de novo |
| Erro redirect_uri_mismatch no Google | O endereço de retorno do Info8n não está cadastrado no cliente OAuth | Copie o Endereço de retorno da conexão e cadastre em URIs de redirecionamento autorizados |
| "O Google recusou o acesso salvo" no nó | Passaram 7 dias (app em Teste), a senha da conta mudou ou o acesso foi revogado | Abra a conexão e clique em Conectar com Google |
| "A conexão do Gmail ainda não foi conectada" | A conexão foi salva sem clicar em Conectar com Google | Abra a conexão e clique em Conectar com Google |
| A aba do Google não carrega no fim | O Info8n foi aberto por IP | Cole o endereço dessa aba em Endereço da página de retorno e clique em Concluir |
| "Invalid draft id" ao enviar rascunho | O campo ID do rascunho está em Fixo, então o texto `{{ $json.id }}` vai literal | Troque o campo para Expressão |
