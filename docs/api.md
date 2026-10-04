# Info8n: documentação da API

> Cópia da documentação da API publicada em https://claude.ai/code/artifact/80ceb5b2-a2ea-4297-abe8-73dad394d2b9. As duas versões são atualizadas juntas. A parte das rotas é gerada a partir de `apps/server/src/api-reference.ts` e `apps/server/src/api-examples.ts`: não edite à mão, rode `npm run docs:api -w @sa/server`.

## Visão geral

A API do Info8n é a mesma que as telas usam: tudo o que se faz pela tela, outro sistema pode fazer com um token. Os endereços começam com `/api` no servidor do Info8n (porta 3000, por exemplo `http://localhost:3000/api`), e os corpos de envio e de resposta são JSON. Datas vêm no formato ISO 8601, em UTC (ex.: 2026-09-30T13:00:00.000Z), e os IDs são UUIDs.

Cada rota traz:

- **Perfil:** o menor perfil que pode chamar a rota.
- **Parâmetros:** os do caminho (como `{id}`), os filtros na URL e os campos do corpo, com tipo e se são obrigatórios.
- **Exemplo de chamada:** um `curl` pronto para copiar.
- **Exemplo de resposta:** o JSON que o servidor devolve, tirado de chamadas reais (listas longas aparecem encurtadas).
- **Erros próprios:** os que só aquela rota devolve, além dos erros comuns da seção Erros.

Nos exemplos, `$INFO8N` é o endereço do servidor e `$TOKEN` é o seu token. Os comandos usam a sintaxe do bash; no Windows, rode no Git Bash.

```bash
export INFO8N=http://localhost:3000
export TOKEN=sa_seu_token_aqui
```

A mesma lista de rotas aparece dentro do Info8n, no menu Referência da API, e em JSON em `GET /api/docs`.

## Autenticação

Toda chamada, menos `GET /api/health` e `POST /api/auth/login`, leva um token no header `Authorization`:

```http
Authorization: Bearer sa_seu_token_aqui
```

- **Gerar o token:** em Minha conta, na parte Tokens de API, dê um nome e clique em Criar. O token começa com `sa_` e só aparece nessa hora; o Info8n guarda apenas o hash dele. Pela API, é `POST /api/auth/tokens`.
- **Quem o token é:** ele age como o usuário que o criou, com o mesmo perfil, as mesmas pastas e os mesmos clientes. Uma rota acima do perfil devolve 403; um fluxo ou uma conexão fora das pastas e dos clientes do usuário devolve 404, como se não existisse.
- **Validade:** o token não expira. Ele para de valer quando é revogado (em Minha conta ou em `DELETE /api/auth/tokens/{id}`) ou quando o usuário é desativado. Se um administrador redefinir a senha do usuário, o token passa a devolver 403 até o usuário entrar e trocar a senha.
- **Usuário da integração:** crie um usuário só para ela, com o menor perfil que resolve. Entre uma vez com ele para trocar a senha inicial e gere o token logado como ele: enquanto a senha inicial não é trocada, o Info8n não deixa criar tokens.

Cada rota diz o menor perfil que pode chamá-la; os perfis acima também podem.

| Perfil | Valor em `role` | O que pode pela API |
| --- | --- | --- |
| Leitor | `viewer` | Consultar fluxos, execuções, comandos SQL, conexões, ERPs, pastas e clientes |
| Operador | `operator` | O do Leitor, mais disparar fluxos e cancelar ou reexecutar execuções |
| Editor | `editor` | O do Operador, mais criar e alterar fluxos, conexões e o catálogo de ERPs |
| Administrador | `admin` | Tudo, inclusive usuários, pastas, clientes e auditoria, em todas as pastas e clientes |

A tela usa um cookie de sessão criado por `POST /api/auth/login`. Outro sistema deve usar o token, que não depende de senha nem vence em 12 horas.

## Erros

Todo erro devolve um JSON com `error`, a mensagem em português, e às vezes `details`, com o que ajuda a corrigir. Para decidir no código, use o status HTTP: as mensagens são para pessoas e podem mudar.

```json
{
  "error": "Dados inválidos",
  "details": [
    {
      "code": "invalid_type",
      "expected": "object",
      "received": "undefined",
      "path": ["input", 0, "json"],
      "message": "Required"
    }
  ]
}
```

| Status | Quando acontece | Exemplo de `error` |
| --- | --- | --- |
| 400 | Dados inválidos (`details` lista cada campo com problema, com o caminho em `path`) ou regra de negócio, como senha fraca | Dados inválidos |
| 401 | Sem token, token errado ou revogado, ou usuário desativado | Faça login para continuar |
| 403 | Perfil sem permissão, pasta ou cliente sem acesso, ou usuário que ainda não trocou a senha inicial | Você não tem permissão para esta ação |
| 404 | Registro que não existe ou está numa pasta ou cliente que o usuário não enxerga, ou rota que não existe | Fluxo não encontrado |
| 409 | Nome repetido, registro em uso ou fluxo salvo por outra pessoa depois da versão editada | Já existe uma pasta com esse nome |
| 413 | Corpo maior que o limite (veja Limites) | Request body is too large |
| 500 | Erro interno; o detalhe fica só no log do servidor | Erro interno no servidor |

- **Senha inicial:** o 403 de quem ainda não trocou a senha traz `"details": {"code": "must_change_password"}`.
- **ID mal formado:** os IDs são UUIDs. Um ID inválido no caminho devolve 400 `Dados inválidos`, com `"path": ["id"]` em `details`.
- **POST sem corpo:** nas rotas POST que não recebem corpo, como ativar, cancelar ou reexecutar, não mande `Content-Type: application/json`, ou mande `{}` como corpo. O header JSON com corpo vazio devolve 400 `Body cannot be empty when content-type is set to 'application/json'`.

## Guia rápido: disparar um fluxo e pegar o resultado

O uso mais comum da API tem três passos. O fluxo não precisa estar ativo, porque ativar só liga o agendamento, e o usuário do token precisa ser Operador ou acima.

1. **Pegue o ID do fluxo.** Ele aparece no endereço do editor (`/fluxos/<id>`) e em `GET /api/workflows`.
2. **Dispare o fluxo** com `POST /api/workflows/{id}/run`. Os itens de `input` entram no Gatilho manual do fluxo. A resposta volta na hora, antes de o fluxo terminar, com o ID da execução.
3. **Consulte a execução** em `GET /api/executions/{id}` a cada 1 ou 2 segundos, até `status` sair de `queued` ou `running`.

O `status` final diz o que aconteceu:

- `success`: o resultado é a saída do último nó que rodou, `runs[-1].output[0]`, uma lista de itens `{"json": {...}}`.
- `error`: `error_message` diz o que houve, `error_node` diz em qual nó, e `error.details` traz o resto, como a resposta da API que falhou.
- `canceled`: alguém cancelou a execução.

O script abaixo faz os três passos e usa o `jq` para ler o JSON. Ele foi rodado num Info8n de teste com o fluxo Consultar preço, que busca o produto no banco do cliente.

```bash
export FLUXO=28eed8f6-3e9c-48e0-a144-c4b5226d3b79

EXECUCAO=$(curl -s -X POST "$INFO8N/api/workflows/$FLUXO/run" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input": [{"json": {"sku": "7891000055120"}}]}' | jq -r .executionId)

while true; do
  RESPOSTA=$(curl -s "$INFO8N/api/executions/$EXECUCAO" -H "Authorization: Bearer $TOKEN")
  STATUS=$(echo "$RESPOSTA" | jq -r .status)
  if [ "$STATUS" != "queued" ] && [ "$STATUS" != "running" ]; then break; fi
  sleep 2
done

echo "$RESPOSTA" | jq '{status, error_message, resultado: [.runs[-1].output[0][].json]}'
```

Saída:

```json
{
  "status": "success",
  "error_message": null,
  "resultado": [
    {
      "codigo": "7891000055120",
      "descricao": "Açúcar cristal 1 kg",
      "preco": "5.49",
      "estoque": 80
    }
  ]
}
```

- **Execução pela API:** conta como manual e guarda os dados de todos os nós, então `runs` sempre vem preenchido.
- **Resultado grande:** quando a entrada e a saída de um nó passam de 256 KB juntas, o Info8n guarda no lugar dos itens só um aviso, `{"_truncado": true, "itens": 5000, "bytes": 812345}`. Para devolver muitos dados, faça o último nó devolver só o necessário, ou gravar o resultado num banco ou numa API.
- **Muitos disparos ao mesmo tempo:** as execuções esperam na fila (`queued`) quando o servidor já está rodando o máximo de fluxos ao mesmo tempo (5, por padrão).

## Limites

- **Tamanho do corpo:** até 10 MB por chamada, e até 50 MB na importação do n8n. Acima disso, a resposta é 413 `Request body is too large`.
- **Chamadas por minuto:** não há limite. O que limita é quantos fluxos rodam ao mesmo tempo (5 por padrão, em `WORKER_CONCURRENCY`); os disparos a mais esperam na fila.
- **Webhook:** não existe URL pública de webhook como no n8n. Toda chamada leva o token.

<!-- rotas:inicio -->

## Conta e tokens

### GET /api/health

Diz se o servidor está no ar.

**Perfil:** Sem login

**Parâmetros:** nenhum.

**Exemplo de chamada**

```bash
curl "$INFO8N/api/health"
```

**Exemplo de resposta**

```json
{"ok": true}
```

### GET /api/docs

Esta referência, em JSON.

**Perfil:** Qualquer perfil

**Parâmetros:** nenhum.

**Exemplo de chamada**

```bash
curl "$INFO8N/api/docs" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

A mesma lista de rotas desta referência, com os parâmetros, os exemplos e os erros de cada uma.

```json
[
  {
    "title": "Conta e tokens",
    "routes": [
      {
        "method": "GET",
        "path": "/health",
        "profile": "public",
        "summary": "Diz se o servidor está no ar.",
        "example": {"response": {"ok": true}, "curl": "curl \"$INFO8N/api/health\""}
      }
    ]
  }
]
```

_Lista encurtada para o primeiro grupo e a primeira rota._

### POST /api/auth/login

Entra na tela e devolve o cookie de sessão. Sistemas externos devem usar um token no lugar.

**Perfil:** Sem login · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `email` | corpo | texto | sim | E-mail |
| `password` | corpo | texto | sim | Senha |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@empresa.com", "password": "senha-inicial-123"}' \
  -c cookies.txt
```

**Exemplo de resposta**

O cookie sa_session vem no header Set-Cookie e vale SESSION_TTL_HOURS (12 horas por padrão). Mande-o nas chamadas seguintes no lugar do token.

```json
{"ok": true}
```

**Erros próprios**

- 401: e-mail ou senha errados, usuário inativo ou bloqueado. 5 senhas erradas seguidas bloqueiam por 15 minutos

### POST /api/auth/logout

Encerra a sessão do cookie.

**Perfil:** Qualquer perfil

**Parâmetros:** nenhum.

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/auth/logout" \
  -b cookies.txt
```

**Exemplo de resposta**

```json
{"ok": true}
```

### GET /api/auth/me

Usuário dono da sessão ou do token.

**Perfil:** Qualquer perfil

**Parâmetros:** nenhum.

**Exemplo de chamada**

```bash
curl "$INFO8N/api/auth/me" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

permissions resume o que o perfil permite: editar fluxos, disparar fluxos, editar conexões e administrar. mustChangePassword true quer dizer que a senha inicial ainda não foi trocada.

```json
{
  "id": "c60328ef-23f7-4ea6-a719-3025f828d1d5",
  "email": "admin@empresa.com",
  "name": "Administrador",
  "role": "admin",
  "mustChangePassword": false,
  "permissions": {
    "editWorkflows": true,
    "executeWorkflows": true,
    "editConnections": true,
    "admin": true
  }
}
```

### POST /api/auth/change-password

Troca a própria senha.

**Perfil:** Qualquer perfil · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `currentPassword` | corpo | texto | sim | Senha atual |
| `newPassword` | corpo | texto | sim | Senha nova |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/auth/change-password" \
  -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"currentPassword": "senha-inicial-123", "newPassword": "nova-senha-segura-1"}'
```

**Exemplo de resposta**

```json
{"ok": true}
```

**Erros próprios**

- 400: senha atual incorreta ou senha nova fraca

### GET /api/auth/tokens

Tokens de API do próprio usuário.

**Perfil:** Qualquer perfil

**Parâmetros:** nenhum.

**Exemplo de chamada**

```bash
curl "$INFO8N/api/auth/tokens" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

last_used_at é a hora da última chamada feita com o token (null se ele ainda não foi usado). O token em si nunca volta.

```json
[
  {
    "id": "c98636d8-680c-4755-9a5e-432a48add76b",
    "name": "ERP interno",
    "created_at": "2026-09-30T12:42:14.884Z",
    "last_used_at": "2026-09-30T12:44:51.065Z"
  }
]
```

### POST /api/auth/tokens

Cria um token de API. Ele age como o usuário que o criou e não expira.

**Perfil:** Qualquer perfil · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `name` | corpo | texto | sim | Nome do token, até 100 caracteres (ex.: ERP interno) |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/auth/tokens" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "ERP interno"}'
```

**Exemplo de resposta**

O token só aparece nesta resposta; guarde-o. O Info8n guarda apenas o hash dele.

```json
{
  "id": "c98636d8-680c-4755-9a5e-432a48add76b",
  "name": "ERP interno",
  "token": "sa_Q2x9Lm4TzR7vN1bY8cK3pW6hJ0sD5fGa_e7uXoB2iVk"
}
```

### DELETE /api/auth/tokens/{id}

Revoga um token do próprio usuário. Ele para de funcionar na hora.

**Perfil:** Qualquer perfil · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do token |

**Exemplo de chamada**

```bash
curl -X DELETE "$INFO8N/api/auth/tokens/92e0ad54-f3e8-40d1-9c04-ed65cc13faca" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
{"ok": true}
```

**Erros próprios**

- 404: o token não existe ou é de outro usuário

## Fluxos

### GET /api/workflows

Fluxos das pastas que o usuário enxerga.

**Perfil:** Qualquer perfil

**Parâmetros:** nenhum.

**Exemplo de chamada**

```bash
curl "$INFO8N/api/workflows" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

scheduled diz se o fluxo tem gatilho de agendamento, e callable, se pode ser chamado como subfluxo (começa pelo gatilho Chamado por outro fluxo). last_execution é a execução mais recente, ou null se o fluxo nunca rodou. next_run é o próximo disparo do agendamento; null quando o fluxo está inativo, não é agendado ou não tem próximo disparo (ex.: a execução única já passou).

```json
[
  {
    "id": "dec48013-b108-482a-8fc8-0c531e797802",
    "name": "Avisar estoque baixo",
    "folder_id": "7310270d-68a9-4f71-bce6-14fcc7ba6b22",
    "folder_name": "Financeiro",
    "active": true,
    "version": 1,
    "updated_at": "2026-09-30T12:44:10.107Z",
    "updated_by_name": "Administrador",
    "last_execution": null,
    "scheduled": true,
    "callable": false,
    "next_run": "2026-10-01T11:00:00.000Z"
  },
  {
    "id": "001f6938-0a6c-411e-b8b8-d0f9c96efd04",
    "name": "Calcular frete",
    "folder_id": "7310270d-68a9-4f71-bce6-14fcc7ba6b22",
    "folder_name": "Financeiro",
    "active": false,
    "version": 1,
    "updated_at": "2026-09-30T12:44:10.117Z",
    "updated_by_name": "Administrador",
    "last_execution": {
      "id": "b449e37f-eb2d-4b32-b2a0-7a17fece43ac",
      "status": "success",
      "createdAt": "2026-09-30T12:44:10.690956+00:00"
    },
    "scheduled": false,
    "callable": true,
    "next_run": null
  },
  {
    "id": "28eed8f6-3e9c-48e0-a144-c4b5226d3b79",
    "name": "Consultar preço",
    "folder_id": "7310270d-68a9-4f71-bce6-14fcc7ba6b22",
    "folder_name": "Financeiro",
    "active": false,
    "version": 2,
    "updated_at": "2026-09-30T12:44:10.044Z",
    "updated_by_name": "Administrador",
    "last_execution": {
      "id": "4b31556c-2e1d-48da-9043-d1a708320b46",
      "status": "success",
      "createdAt": "2026-09-30T12:44:10.139475+00:00"
    },
    "scheduled": false,
    "callable": false,
    "next_run": null
  }
]
```

_Lista encurtada para três fluxos._

### GET /api/workflows/{id}

Fluxo completo.

**Perfil:** Qualquer perfil

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do fluxo |

**Exemplo de chamada**

```bash
curl "$INFO8N/api/workflows/28eed8f6-3e9c-48e0-a144-c4b5226d3b79" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

definition traz os nós e as ligações do fluxo. issues lista os problemas encontrados na validação; com algum problema, o fluxo não pode ser ativado.

```json
{
  "id": "28eed8f6-3e9c-48e0-a144-c4b5226d3b79",
  "name": "Consultar preço",
  "folder_id": "7310270d-68a9-4f71-bce6-14fcc7ba6b22",
  "active": false,
  "definition": {
    "nodes": [
      {
        "id": "gatilho",
        "name": "Gatilho manual",
        "type": "manualTrigger",
        "position": {"x": 100, "y": 200},
        "parameters": {}
      },
      {
        "id": "buscar",
        "name": "Buscar preço",
        "type": "database",
        "position": {"x": 350, "y": 200},
        "parameters": {
          "sql": "SELECT codigo, descricao, preco, estoque FROM produtos WHERE codigo = :codigo",
          "operation": "query",
          "connection": "06382b0a-066f-4230-b288-053f93bd9af9",
          "queryParams": [{"name": "codigo", "value": "={{ $json.sku }}"}]
        }
      }
    ],
    "connections": [{"to": "buscar", "from": "gatilho", "toInput": 0, "fromOutput": 0}]
  },
  "version": 2,
  "updated_at": "2026-09-30T12:44:10.044Z",
  "issues": []
}
```

**Erros próprios**

- 404: não existe ou está numa pasta sem acesso

### POST /api/workflows

Cria um fluxo. Sem definition, ele nasce só com o Gatilho manual.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `name` | corpo | texto | sim | Nome do fluxo |
| `folderId` | corpo | uuid | sim | Pasta do fluxo; o usuário precisa ter acesso a ela |
| `definition` | corpo | objeto | não | Nós e ligações do fluxo: {"nodes": [...], "connections": [...]}, no formato de GET /workflows/{id} |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/workflows" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "Avisar estoque baixo",
  "folderId": "7310270d-68a9-4f71-bce6-14fcc7ba6b22",
  "definition": {
    "nodes": [
      {
        "id": "agenda",
        "name": "Dias úteis às 8h",
        "type": "scheduleTrigger",
        "position": {"x": 100, "y": 200},
        "parameters": {
          "mode": "cron",
          "cron": "0 8 * * 1-5",
          "timezone": "America/Sao_Paulo"
        }
      },
      {
        "id": "baixo",
        "name": "Estoque baixo",
        "type": "database",
        "position": {"x": 350, "y": 200},
        "parameters": {
          "connection": "06382b0a-066f-4230-b288-053f93bd9af9",
          "operation": "query",
          "sql": "SELECT codigo, descricao, estoque FROM produtos WHERE estoque < :minimo",
          "queryParams": [{"name": "minimo", "value": "100"}]
        }
      }
    ],
    "connections": [{"from": "agenda", "fromOutput": 0, "to": "baixo", "toInput": 0}]
  }
}'
```

**Exemplo de resposta**

```json
{
  "id": "dec48013-b108-482a-8fc8-0c531e797802",
  "name": "Avisar estoque baixo",
  "folder_id": "7310270d-68a9-4f71-bce6-14fcc7ba6b22",
  "active": false,
  "definition": {
    "nodes": [
      {
        "id": "agenda",
        "name": "Dias úteis às 8h",
        "type": "scheduleTrigger",
        "position": {"x": 100, "y": 200},
        "parameters": {"cron": "0 8 * * 1-5", "mode": "cron", "timezone": "America/Sao_Paulo"}
      },
      {
        "id": "baixo",
        "name": "Estoque baixo",
        "type": "database",
        "position": {"x": 350, "y": 200},
        "parameters": {
          "sql": "SELECT codigo, descricao, estoque FROM produtos WHERE estoque < :minimo",
          "operation": "query",
          "connection": "06382b0a-066f-4230-b288-053f93bd9af9",
          "queryParams": [{"name": "minimo", "value": "100"}]
        }
      }
    ],
    "connections": [{"to": "baixo", "from": "agenda", "toInput": 0, "fromOutput": 0}]
  },
  "version": 1,
  "updated_at": "2026-09-30T12:44:10.052Z"
}
```

**Erros próprios**

- 400: usa conexão ou subfluxo que não existe
- 403: pasta, conexão ou subfluxo sem acesso

### PUT /api/workflows/{id}

Salva o fluxo. Cada gravação cria uma versão nova.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do fluxo |
| `name` | corpo | texto | sim | Nome do fluxo |
| `folderId` | corpo | uuid | sim | Pasta do fluxo; o usuário precisa ter acesso a ela |
| `definition` | corpo | objeto | sim | Nós e ligações do fluxo: {"nodes": [...], "connections": [...]}, no formato de GET /workflows/{id} |
| `baseVersion` | corpo | número | não | Versão que foi editada. Se outra pessoa salvou depois dela, a gravação é recusada |

**Exemplo de chamada**

```bash
curl -X PUT "$INFO8N/api/workflows/28eed8f6-3e9c-48e0-a144-c4b5226d3b79" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "Consultar preço",
  "folderId": "7310270d-68a9-4f71-bce6-14fcc7ba6b22",
  "definition": {
    "nodes": [
      {
        "id": "gatilho",
        "name": "Gatilho manual",
        "type": "manualTrigger",
        "position": {"x": 100, "y": 200},
        "parameters": {}
      },
      {
        "id": "buscar",
        "name": "Buscar preço",
        "type": "database",
        "position": {"x": 350, "y": 200},
        "parameters": {
          "connection": "06382b0a-066f-4230-b288-053f93bd9af9",
          "operation": "query",
          "sql": "SELECT codigo, descricao, preco, estoque FROM produtos WHERE codigo = :codigo",
          "queryParams": [{"name": "codigo", "value": "={{ $json.sku }}"}]
        }
      }
    ],
    "connections": [{"from": "gatilho", "fromOutput": 0, "to": "buscar", "toInput": 0}]
  },
  "baseVersion": 1
}'
```

**Exemplo de resposta**

O fluxo salvo, com a version nova e os issues da validação.

```json
{
  "id": "28eed8f6-3e9c-48e0-a144-c4b5226d3b79",
  "name": "Consultar preço",
  "folder_id": "7310270d-68a9-4f71-bce6-14fcc7ba6b22",
  "active": false,
  "definition": {
    "nodes": [
      {
        "id": "gatilho",
        "name": "Gatilho manual",
        "type": "manualTrigger",
        "position": {"x": 100, "y": 200},
        "parameters": {}
      },
      {
        "id": "buscar",
        "name": "Buscar preço",
        "type": "database",
        "position": {"x": 350, "y": 200},
        "parameters": {
          "sql": "SELECT codigo, descricao, preco, estoque FROM produtos WHERE codigo = :codigo",
          "operation": "query",
          "connection": "06382b0a-066f-4230-b288-053f93bd9af9",
          "queryParams": [{"name": "codigo", "value": "={{ $json.sku }}"}]
        }
      }
    ],
    "connections": [{"to": "buscar", "from": "gatilho", "toInput": 0, "fromOutput": 0}]
  },
  "version": 2,
  "updated_at": "2026-09-30T12:44:10.044Z",
  "issues": []
}
```

**Erros próprios**

- 400: fluxo ativo com problemas, agendamento inválido (horário, dias, cron) ou execução única com data que já passou, conexão ou subfluxo que não existe, ou o fluxo chama ele mesmo
- 409: outra pessoa salvou depois da baseVersion

### DELETE /api/workflows/{id}

Exclui o fluxo e desliga o agendamento dele.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do fluxo |

**Exemplo de chamada**

```bash
curl -X DELETE "$INFO8N/api/workflows/b2bbbd6a-aa22-4ef0-a066-1ed17da5888b" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
{"ok": true}
```

**Erros próprios**

- 400: outros fluxos chamam este como subfluxo (a mensagem diz quais)

### POST /api/workflows/{id}/activate

Liga o agendamento do fluxo.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do fluxo |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/workflows/dec48013-b108-482a-8fc8-0c531e797802/activate" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
{"ok": true, "active": true}
```

**Erros próprios**

- 400: o fluxo não tem gatilho de agendamento, tem problemas, o agendamento é inválido ou a data da execução única já passou

### POST /api/workflows/{id}/deactivate

Desliga o agendamento do fluxo.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do fluxo |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/workflows/dec48013-b108-482a-8fc8-0c531e797802/deactivate" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
{"ok": true, "active": false}
```

### POST /api/workflows/{id}/duplicate

Cria uma cópia "(cópia)" na mesma pasta, desativada.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do fluxo |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/workflows/28eed8f6-3e9c-48e0-a144-c4b5226d3b79/duplicate" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
{
  "id": "b2bbbd6a-aa22-4ef0-a066-1ed17da5888b",
  "name": "Consultar preço (cópia)",
  "folder_id": "7310270d-68a9-4f71-bce6-14fcc7ba6b22",
  "active": false,
  "definition": {
    "nodes": [
      {
        "id": "gatilho",
        "name": "Gatilho manual",
        "type": "manualTrigger",
        "position": {"x": 100, "y": 200},
        "parameters": {}
      },
      {
        "id": "buscar",
        "name": "Buscar preço",
        "type": "database",
        "position": {"x": 350, "y": 200},
        "parameters": {
          "sql": "SELECT codigo, descricao, preco, estoque FROM produtos WHERE codigo = :codigo",
          "operation": "query",
          "connection": "06382b0a-066f-4230-b288-053f93bd9af9",
          "queryParams": [{"name": "codigo", "value": "={{ $json.sku }}"}]
        }
      }
    ],
    "connections": [{"to": "buscar", "from": "gatilho", "toInput": 0, "fromOutput": 0}]
  },
  "version": 1,
  "updated_at": "2026-09-30T12:44:13.835Z"
}
```

### POST /api/workflows/{id}/run

Põe o fluxo na fila e responde na hora, sem esperar ele terminar. Acompanhe o resultado em GET /executions/{id}. A execução conta como manual e guarda os dados de todos os nós.

**Perfil:** Operador ou acima

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do fluxo |
| `input` | corpo | lista | não | Itens que entram no primeiro gatilho do fluxo (o Gatilho manual): [{"json": {...}}]. Sem input, o gatilho solta um item vazio |
| `definition` | corpo | objeto | não | Usado pelo editor da tela para rodar um fluxo ainda não salvo. Exige o perfil Editor |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/workflows/28eed8f6-3e9c-48e0-a144-c4b5226d3b79/run" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input": [{"json": {"sku": "7891000100103"}}]}'
```

**Exemplo de resposta**

Use o executionId em GET /executions/{id} para acompanhar a execução e pegar o resultado.

```json
{"executionId": "4b31556c-2e1d-48da-9043-d1a708320b46"}
```

**Erros próprios**

- 404: o fluxo não existe ou está numa pasta sem acesso

### GET /api/workflows/{id}/callers

Fluxos que chamam este como subfluxo.

**Perfil:** Qualquer perfil

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do fluxo |

**Exemplo de chamada**

```bash
curl "$INFO8N/api/workflows/001f6938-0a6c-411e-b8b8-d0f9c96efd04/callers" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
[{"id": "e0d680d2-37e4-403d-a15e-4d31808d352b", "name": "Fechar pedido"}]
```

### GET /api/workflows/{id}/versions

Últimas 200 versões salvas do fluxo.

**Perfil:** Qualquer perfil

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do fluxo |

**Exemplo de chamada**

```bash
curl "$INFO8N/api/workflows/28eed8f6-3e9c-48e0-a144-c4b5226d3b79/versions" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

Da versão mais nova para a mais antiga.

```json
[
  {
    "version": 2,
    "name": "Consultar preço",
    "created_at": "2026-09-30T12:44:10.044Z",
    "created_by_name": "Administrador"
  },
  {
    "version": 1,
    "name": "Consultar preço",
    "created_at": "2026-09-30T12:44:10.024Z",
    "created_by_name": "Administrador"
  }
]
```

### GET /api/workflows/{id}/versions/{version}

Uma versão salva do fluxo.

**Perfil:** Qualquer perfil

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do fluxo |
| `version` | caminho | número | sim | Número da versão |

**Exemplo de chamada**

```bash
curl "$INFO8N/api/workflows/28eed8f6-3e9c-48e0-a144-c4b5226d3b79/versions/1" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
{
  "version": 1,
  "name": "Consultar preço",
  "definition": {
    "nodes": [
      {
        "id": "gatilho",
        "name": "Gatilho manual",
        "type": "manualTrigger",
        "position": {"x": 100, "y": 200},
        "parameters": {}
      }
    ],
    "connections": []
  },
  "created_at": "2026-09-30T12:44:10.024Z"
}
```

**Erros próprios**

- 404: versão não existe

### GET /api/workflows/{id}/export

Arquivo de exportação do fluxo, o mesmo que a tela baixa.

**Perfil:** Qualquer perfil

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do fluxo |

**Exemplo de chamada**

```bash
curl "$INFO8N/api/workflows/001f6938-0a6c-411e-b8b8-d0f9c96efd04/export" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

O mesmo JSON, com o folderId da pasta de destino, serve de corpo para POST /workflows/import.

```json
{
  "name": "Calcular frete",
  "definition": {
    "nodes": [
      {
        "id": "recebe",
        "name": "Recebe pedido",
        "type": "executeWorkflowTrigger",
        "position": {"x": 100, "y": 200},
        "parameters": {}
      },
      {
        "id": "calc",
        "name": "Calcular frete",
        "type": "code",
        "position": {"x": 350, "y": 200},
        "parameters": {
          "mode": "each",
          "jsCode": "return { ...$json, frete: $json.total >= 200 ? 0 : 15 };",
          "language": "javaScript"
        }
      }
    ],
    "connections": [{"to": "calc", "from": "recebe", "toInput": 0, "fromOutput": 0}]
  },
  "exportedAt": "2026-09-30T12:44:13.825Z"
}
```

### POST /api/workflows/import

Importa um fluxo exportado. Ele entra desativado.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `name` | corpo | texto | sim | Nome do fluxo |
| `folderId` | corpo | uuid | sim | Pasta do fluxo; o usuário precisa ter acesso a ela |
| `definition` | corpo | objeto | sim | Nós e ligações do fluxo: {"nodes": [...], "connections": [...]}, no formato de GET /workflows/{id} |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/workflows/import" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "Calcular frete (importado)",
  "folderId": "7310270d-68a9-4f71-bce6-14fcc7ba6b22",
  "definition": {
    "nodes": [
      {
        "id": "recebe",
        "name": "Recebe pedido",
        "type": "executeWorkflowTrigger",
        "position": {"x": 100, "y": 200},
        "parameters": {}
      },
      {
        "id": "calc",
        "name": "Calcular frete",
        "type": "code",
        "position": {"x": 350, "y": 200},
        "parameters": {
          "mode": "each",
          "jsCode": "return { ...$json, frete: $json.total >= 200 ? 0 : 15 };",
          "language": "javaScript"
        }
      }
    ],
    "connections": [{"to": "calc", "from": "recebe", "toInput": 0, "fromOutput": 0}]
  }
}'
```

**Exemplo de resposta**

```json
{
  "id": "a0653ebc-3082-4d58-9a93-d4e17735f9b7",
  "name": "Calcular frete (importado)",
  "folder_id": "7310270d-68a9-4f71-bce6-14fcc7ba6b22",
  "active": false,
  "definition": {
    "nodes": [
      {
        "id": "recebe",
        "name": "Recebe pedido",
        "type": "executeWorkflowTrigger",
        "position": {"x": 100, "y": 200},
        "parameters": {}
      },
      {
        "id": "calc",
        "name": "Calcular frete",
        "type": "code",
        "position": {"x": 350, "y": 200},
        "parameters": {
          "mode": "each",
          "jsCode": "return { ...$json, frete: $json.total >= 200 ? 0 : 15 };",
          "language": "javaScript"
        }
      }
    ],
    "connections": [{"to": "calc", "from": "recebe", "toInput": 0, "fromOutput": 0}]
  },
  "version": 1,
  "updated_at": "2026-09-30T12:44:13.829Z"
}
```

**Erros próprios**

- 400: usa conexão ou subfluxo que não existe
- 403: pasta, conexão ou subfluxo sem acesso

### POST /api/workflows/import-n8n

Importa fluxos exportados do n8n. Entram desativados, e os Execute Workflow passam a apontar para os subfluxos importados. Fluxo já importado antes é pulado.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `folderId` | corpo | uuid | sim | Pasta onde os fluxos entram |
| `data` | corpo | objeto ou lista | sim | O JSON exportado do n8n, com um fluxo ou uma lista (até 50 MB) |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/workflows/import-n8n" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "folderId": "7310270d-68a9-4f71-bce6-14fcc7ba6b22",
  "data": {
    "id": "r7Kp2QmX9aLs",
    "name": "Boas-vindas",
    "active": false,
    "nodes": [
      {
        "id": "a1",
        "name": "Início",
        "type": "n8n-nodes-base.manualTrigger",
        "typeVersion": 1,
        "position": [0, 0],
        "parameters": {}
      },
      {
        "id": "a2",
        "name": "Mensagem",
        "type": "n8n-nodes-base.set",
        "typeVersion": 3.4,
        "position": [220, 0],
        "parameters": {
          "assignments": {
            "assignments": [
              {
                "id": "m1",
                "name": "mensagem",
                "value": "=Olá, {{ $json.nome }}",
                "type": "string"
              }
            ]
          },
          "options": {}
        }
      }
    ],
    "connections": {
      "Início": {"main": [[{"node": "Mensagem", "type": "main", "index": 0}]]}
    }
  }
}'
```

**Exemplo de resposta**

Uma linha por fluxo do arquivo. status é imported, ou skipped quando o fluxo já tinha sido importado antes (id é o do fluxo que já existe). wasActive diz se ele estava ativo no n8n, e warnings lista, por nó, o que precisa de ajuste.

```json
[
  {
    "n8nId": "r7Kp2QmX9aLs",
    "name": "Boas-vindas",
    "status": "imported",
    "id": "462e856b-1378-44b6-911c-ede2133a0481",
    "wasActive": false,
    "warnings": []
  }
]
```

**Erros próprios**

- 400: o arquivo não é uma exportação do n8n

### GET /api/node-types

Tipos de nó disponíveis no editor, com os parâmetros de cada um.

**Perfil:** Qualquer perfil

**Parâmetros:** nenhum.

**Exemplo de chamada**

```bash
curl "$INFO8N/api/node-types" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

Cada item de properties é um parâmetro do nó: name é a chave dele em parameters, na definição do fluxo, e showWhen diz de quais outros parâmetros ele depende para aparecer.

```json
[
  {
    "type": "scheduleTrigger",
    "displayName": "Agendamento",
    "description": "Inicia o fluxo em horários definidos, quando o fluxo está ativo.",
    "group": "trigger",
    "inputs": 0,
    "outputs": 1,
    "properties": [
      {
        "name": "mode",
        "displayName": "Tipo de agendamento",
        "type": "options",
        "default": "interval",
        "options": [
          {"name": "Todo dia", "value": "daily"},
          {"name": "Toda semana", "value": "weekly"},
          {"name": "Todo mês", "value": "monthly"},
          {"name": "A cada intervalo", "value": "interval"},
          {"name": "Uma vez, numa data e hora", "value": "once"},
          {"name": "Expressão cron", "value": "cron"}
        ]
      },
      {
        "name": "intervalMinutes",
        "displayName": "Intervalo",
        "type": "number",
        "default": 60,
        "description": "Quantidade de unidades entre uma execução e outra. Intervalos de poucos segundos enchem o histórico de Execuções.",
        "showWhen": {"mode": ["interval"]}
      },
      {
        "name": "intervalUnit",
        "displayName": "Unidade",
        "type": "options",
        "default": "minutes",
        "options": [
          {"name": "Segundos", "value": "seconds"},
          {"name": "Minutos", "value": "minutes"},
          {"name": "Horas", "value": "hours"}
        ],
        "showWhen": {"mode": ["interval"]}
      },
      {
        "name": "weekdays",
        "displayName": "Dias da semana",
        "type": "multiOptions",
        "default": ["1", "2", "3", "4", "5"],
        "options": [
          {"name": "Dom", "value": "0"},
          {"name": "Seg", "value": "1"},
          {"name": "Ter", "value": "2"},
          {"name": "Qua", "value": "3"},
          {"name": "Qui", "value": "4"},
          {"name": "Sex", "value": "5"},
          {"name": "Sáb", "value": "6"}
        ],
        "showWhen": {"mode": ["weekly"]}
      },
      {
        "name": "dayOfMonth",
        "displayName": "Dia do mês",
        "type": "number",
        "default": 1,
        "description": "De 1 a 31. Nos meses que não têm esse dia (ex.: 31 em abril), não roda.",
        "showWhen": {"mode": ["monthly"]}
      },
      {
        "name": "time",
        "displayName": "Horário",
        "type": "time",
        "default": "08:00:00",
        "description": "Hora, minuto e segundo.",
        "showWhen": {"mode": ["daily", "weekly", "monthly"]}
      },
      {
        "name": "dateTime",
        "displayName": "Data e hora",
        "type": "dateTime",
        "default": "",
        "required": true,
        "description": "Roda uma vez nesse momento e depois o fluxo é desativado sozinho.",
        "showWhen": {"mode": ["once"]}
      },
      {
        "name": "cron",
        "displayName": "Expressão cron",
        "type": "string",
        "default": "0 8 * * *",
        "placeholder": "minuto hora dia mês dia-da-semana",
        "description": "5 campos, ou 6 com os segundos no começo. Ex.: 0 8 * * 1-5 é de segunda a sexta às 8h.",
        "showWhen": {"mode": ["cron"]}
      },
      {
        "name": "timezone",
        "displayName": "Fuso horário",
        "type": "string",
        "default": "America/Sao_Paulo",
        "showWhen": {"mode": ["daily", "weekly", "monthly", "once", "cron"]}
      }
    ]
  }
]
```

_Lista encurtada para o tipo Agendamento._

### POST /api/expressions/preview

Calcula uma expressão como a prévia do editor.

**Perfil:** Editor ou acima

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `value` | corpo | texto | sim | Texto começando com =, como no modo Expressão (ex.: =Total: {{ $json.preco }}). Sem o =, volta o texto como está |
| `input` | corpo | lista | não | Itens de entrada: [{"json": {...}}] |
| `nodeOutputs` | corpo | objeto | não | Saída de cada nó pelo nome, para $node["Nome"] |
| `itemIndex` | corpo | número | não | Item usado como $json (padrão 0) |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/expressions/preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "value": "=Total: R$ {{ ($json.preco * $json.quantidade).toFixed(2) }}",
  "input": [{"json": {"preco": 19.9, "quantidade": 3}}]
}'
```

**Exemplo de resposta**

Volta {"result"} com o valor calculado ou, se a expressão falhar, {"error"} com o motivo, também com status 200.

```json
{"result": "Total: R$ 59.70"}
```

## Execuções e comandos de banco

### GET /api/executions

Execuções dos fluxos que o usuário enxerga, mais novas primeiro.

**Perfil:** Qualquer perfil

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `workflowId` | URL | uuid | não | Só de um fluxo |
| `status` | URL | texto | não | queued, running, success, error ou canceled |
| `mode` | URL | texto | não | manual, schedule, subworkflow ou retry |
| `parentId` | URL | uuid | não | Só os subfluxos chamados por esta execução |
| `from` | URL | data e hora | não | A partir de quando, com fuso (ex.: 2026-09-30T00:00:00-03:00) |
| `to` | URL | data e hora | não | Até quando, com fuso |
| `search` | URL | texto | não | Procura no nome do fluxo, na mensagem de erro e no nó do erro |
| `before` | URL | data e hora | não | Para paginar: created_at da última linha recebida |
| `limit` | URL | número | não | Quantas linhas devolver, de 1 a 200 (padrão 50) |

**Exemplo de chamada**

```bash
curl "$INFO8N/api/executions?status=error&limit=2" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

duration_ms é quanto a execução levou, em milissegundos (null enquanto não termina). data_size é o tamanho dos dados guardados, compactados, em bytes (null quando não foram guardados).

```json
[
  {
    "id": "7c5e5f8e-885c-44e1-a645-5c64c715dc31",
    "workflow_id": "4a13551c-be81-451a-b6ed-768d1c7fa63d",
    "workflow_name": "Validar pedido",
    "mode": "retry",
    "status": "error",
    "created_at": "2026-09-30T12:44:11.749Z",
    "started_at": "2026-09-30T12:44:11.754Z",
    "finished_at": "2026-09-30T12:44:11.760Z",
    "error_message": "Pedido 1043 sem cliente",
    "error_node": "Pedido sem cliente",
    "triggered_by_name": "Administrador",
    "data_size": 259,
    "parent_execution_id": null,
    "duration_ms": 6
  },
  {
    "id": "4ef36a08-065b-4b35-b899-389cd3e0ac1d",
    "workflow_id": "4a13551c-be81-451a-b6ed-768d1c7fa63d",
    "workflow_name": "Validar pedido",
    "mode": "manual",
    "status": "error",
    "created_at": "2026-09-30T12:44:11.219Z",
    "started_at": "2026-09-30T12:44:11.223Z",
    "finished_at": "2026-09-30T12:44:11.229Z",
    "error_message": "Pedido 1043 sem cliente",
    "error_node": "Pedido sem cliente",
    "triggered_by_name": "Administrador",
    "data_size": 258,
    "parent_execution_id": null,
    "duration_ms": 6
  }
]
```

### GET /api/executions/waiting

Fluxos agendados que já deviam ter começado e esperam vaga no worker.

**Perfil:** Qualquer perfil

**Parâmetros:** nenhum.

**Exemplo de chamada**

```bash
curl "$INFO8N/api/executions/waiting" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

dueAt é quando o fluxo devia ter começado. A lista vem vazia quando nenhum fluxo está esperando.

```json
[
  {
    "workflowId": "232f2344-82b0-45f6-927e-40a84fda58a6",
    "workflowName": "Sincronizar pedidos",
    "dueAt": "2026-09-30T12:47:40.126Z"
  }
]
```

### GET /api/executions/{id}

Execução completa, com os dados de cada nó. Consulte até status sair de queued ou running.

**Perfil:** Qualquer perfil

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID da execução |

**Exemplo de chamada**

```bash
curl "$INFO8N/api/executions/4b31556c-2e1d-48da-9043-d1a708320b46" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

runs traz um item por nó executado, na ordem em que rodaram; input e output são listas por entrada e por saída do nó, cada uma com itens {"json": {...}}. O resultado do fluxo é a saída do último nó executado, runs[-1].output[0]. Quando a entrada e a saída de um nó passam de 256 KB juntas, os itens dele vêm trocados por {"_truncado": true, "itens", "bytes"}. runs vem null quando os dados não foram guardados: execução com sucesso agendada ou de subfluxo, com KEEP_SUCCESS_DATA desligado (o padrão). summary resume cada nó sem os dados, e children lista os subfluxos chamados.

```json
{
  "id": "4b31556c-2e1d-48da-9043-d1a708320b46",
  "workflow_id": "28eed8f6-3e9c-48e0-a144-c4b5226d3b79",
  "workflow_version": 2,
  "mode": "manual",
  "status": "success",
  "triggered_by": "c60328ef-23f7-4ea6-a719-3025f828d1d5",
  "retry_of": null,
  "definition": {
    "nodes": [
      {
        "id": "gatilho",
        "name": "Gatilho manual",
        "type": "manualTrigger",
        "position": {"x": 100, "y": 200},
        "parameters": {}
      },
      {
        "id": "buscar",
        "name": "Buscar preço",
        "type": "database",
        "position": {"x": 350, "y": 200},
        "parameters": {
          "sql": "SELECT codigo, descricao, preco, estoque FROM produtos WHERE codigo = :codigo",
          "operation": "query",
          "connection": "06382b0a-066f-4230-b288-053f93bd9af9",
          "queryParams": [{"name": "codigo", "value": "={{ $json.sku }}"}]
        }
      }
    ],
    "connections": [{"to": "buscar", "from": "gatilho", "toInput": 0, "fromOutput": 0}]
  },
  "input": [{"json": {"sku": "7891000100103"}}],
  "created_at": "2026-09-30T12:44:10.139Z",
  "started_at": "2026-09-30T12:44:10.148Z",
  "finished_at": "2026-09-30T12:44:10.167Z",
  "error_message": null,
  "error_node": null,
  "error": null,
  "summary": [
    {
      "runs": 1,
      "tries": 1,
      "nodeId": "gatilho",
      "status": "success",
      "nodeName": "Gatilho manual",
      "nodeType": "manualTrigger",
      "startedAt": "2026-09-30T12:44:10.152Z",
      "durationMs": 1,
      "inputItems": 1,
      "outputItems": [1]
    },
    {
      "runs": 1,
      "tries": 1,
      "nodeId": "buscar",
      "status": "success",
      "nodeName": "Buscar preço",
      "nodeType": "database",
      "startedAt": "2026-09-30T12:44:10.153Z",
      "durationMs": 14,
      "inputItems": 1,
      "outputItems": [1]
    }
  ],
  "data_size": 296,
  "parent_execution_id": null,
  "workflow_name": "Consultar preço",
  "folder_id": "7310270d-68a9-4f71-bce6-14fcc7ba6b22",
  "triggered_by_name": "Administrador",
  "runs": [
    {
      "nodeId": "gatilho",
      "nodeName": "Gatilho manual",
      "nodeType": "manualTrigger",
      "startedAt": "2026-09-30T12:44:10.152Z",
      "input": [[{"json": {"sku": "7891000100103"}}]],
      "status": "success",
      "output": [[{"json": {"sku": "7891000100103"}}]],
      "tries": 1,
      "finishedAt": "2026-09-30T12:44:10.153Z",
      "durationMs": 1
    },
    {
      "nodeId": "buscar",
      "nodeName": "Buscar preço",
      "nodeType": "database",
      "startedAt": "2026-09-30T12:44:10.153Z",
      "input": [[{"json": {"sku": "7891000100103"}}]],
      "status": "success",
      "output": [
        [
          {
            "json": {
              "codigo": "7891000100103",
              "descricao": "Café torrado 500 g",
              "preco": "19.90",
              "estoque": 120
            }
          }
        ]
      ],
      "tries": 1,
      "finishedAt": "2026-09-30T12:44:10.167Z",
      "durationMs": 14
    }
  ],
  "children": []
}
```

**Erros próprios**

- 404: não existe ou é de um fluxo numa pasta sem acesso

### POST /api/executions/{id}/cancel

Cancela uma execução na fila ou em andamento.

**Perfil:** Operador ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID da execução |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/executions/6add9343-6e56-49d2-b8ef-81a3a3021946/cancel" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
{"ok": true}
```

**Erros próprios**

- 400: a execução já terminou

### POST /api/executions/{id}/retry

Roda de novo com a mesma definição e a mesma entrada.

**Perfil:** Operador ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID da execução |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/executions/4ef36a08-065b-4b35-b899-389cd3e0ac1d/retry" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

executionId é a nova execução, com mode retry e retry_of apontando para a original.

```json
{"executionId": "7c5e5f8e-885c-44e1-a645-5c64c715dc31"}
```

**Erros próprios**

- 400: a execução ainda está em andamento

### GET /api/db-commands

Comandos rodados nos bancos dos clientes que o usuário enxerga, mais novos primeiro.

**Perfil:** Qualquer perfil

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `clientId` | URL | uuid | não | Só de um cliente |
| `connectionId` | URL | uuid | não | Só de uma conexão |
| `executionId` | URL | uuid | não | Só de uma execução |
| `status` | URL | texto | não | ok ou error |
| `from` | URL | data e hora | não | A partir de quando, com fuso (ex.: 2026-09-30T00:00:00-03:00) |
| `to` | URL | data e hora | não | Até quando, com fuso |
| `search` | URL | texto | não | Procura no SQL, no nome do fluxo e no erro |
| `beforeId` | URL | número | não | Para paginar: id da última linha recebida |
| `limit` | URL | número | não | Quantas linhas devolver, de 1 a 200 (padrão 50) |

**Exemplo de chamada**

```bash
curl "$INFO8N/api/db-commands?clientId=bbac4429-0366-4778-957c-0c1d0e6d7c10&limit=1" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

id vem como texto; para a próxima página, mande o id da última linha em beforeId. params são os valores usados no SQL, rows é quantas linhas a consulta devolveu e rows_affected, quantas o comando alterou (null numa consulta).

```json
[
  {
    "id": "1",
    "at": "2026-09-30T12:44:10.165Z",
    "execution_id": "4b31556c-2e1d-48da-9043-d1a708320b46",
    "workflow_id": "28eed8f6-3e9c-48e0-a144-c4b5226d3b79",
    "workflow_name": "Consultar preço",
    "node_name": "Buscar preço",
    "connection_id": "06382b0a-066f-4230-b288-053f93bd9af9",
    "connection_name": "Mercado Bom Preço - Postgres",
    "client_id": "bbac4429-0366-4778-957c-0c1d0e6d7c10",
    "client_name": "Mercado Bom Preço",
    "db_type": "postgres",
    "operation": "query",
    "sql": "SELECT codigo, descricao, preco, estoque FROM produtos WHERE codigo = :codigo",
    "params": {"codigo": "7891000100103"},
    "rows": 1,
    "rows_affected": null,
    "duration_ms": 5,
    "error": null,
    "triggered_by_name": "Administrador"
  }
]
```

## Conexões

### GET /api/connection-types

Tipos de conexão e os campos de cada um.

**Perfil:** Qualquer perfil

**Parâmetros:** nenhum.

**Exemplo de chamada**

```bash
curl "$INFO8N/api/connection-types" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

Campos com secret true são guardados criptografados e o valor deles nunca volta. options, quando existe, lista os valores aceitos. oauth: "google" marca os tipos conectados pelo login com Google (Gmail), que além dos campos precisam de POST /connections/{id}/oauth/google/start.

```json
[
  {
    "type": "postgres",
    "displayName": "Postgres",
    "testable": true,
    "fields": [
      {
        "name": "host",
        "displayName": "Servidor",
        "secret": false,
        "required": true,
        "placeholder": "10.0.0.5"
      },
      {
        "name": "port",
        "displayName": "Porta",
        "secret": false,
        "required": false,
        "default": "5432"
      },
      {"name": "database", "displayName": "Banco", "secret": false, "required": true},
      {"name": "user", "displayName": "Usuário", "secret": false, "required": true},
      {"name": "password", "displayName": "Senha", "secret": true, "required": false},
      {
        "name": "ssl",
        "displayName": "SSL",
        "secret": false,
        "required": false,
        "default": "disable",
        "options": [
          {"name": "Sem SSL", "value": "disable"},
          {"name": "Exigir SSL", "value": "require"},
          {"name": "SSL sem validar o certificado", "value": "no-verify"}
        ]
      },
      {
        "name": "queryTimeoutSeconds",
        "displayName": "Tempo limite por comando (s)",
        "secret": false,
        "required": false,
        "default": "300"
      }
    ]
  }
]
```

_Lista encurtada para o tipo Postgres._

### GET /api/connections

Conexões sem cliente e as dos clientes que o usuário enxerga. Segredos nunca voltam.

**Perfil:** Qualquer perfil

**Parâmetros:** nenhum.

**Exemplo de chamada**

```bash
curl "$INFO8N/api/connections" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

Em data, os campos secretos vêm como •••••• quando estão preenchidos e vazios quando não estão. Nas conexões do Gmail, data.oauthAccount é o e-mail da conta do Google conectada, ou vazio enquanto ninguém clicou em Conectar com Google.

```json
[
  {
    "id": "06382b0a-066f-4230-b288-053f93bd9af9",
    "name": "Mercado Bom Preço - Postgres",
    "type": "postgres",
    "typeName": "Postgres",
    "clientId": "bbac4429-0366-4778-957c-0c1d0e6d7c10",
    "clientName": "Mercado Bom Preço",
    "data": {
      "host": "127.0.0.1",
      "port": "5432",
      "database": "cliente_exemplo",
      "user": "postgres",
      "password": "••••••",
      "ssl": "disable",
      "queryTimeoutSeconds": "120"
    },
    "updatedAt": "2026-09-30T12:47:11.982Z",
    "updatedByName": "Administrador"
  },
  {
    "id": "c3d8dac7-563d-44fb-880c-df5d5df117ad",
    "name": "Mercado Bom Preço - SQL Server",
    "type": "mssql",
    "typeName": "SQL Server",
    "clientId": "bbac4429-0366-4778-957c-0c1d0e6d7c10",
    "clientName": "Mercado Bom Preço",
    "data": {
      "host": "10.0.0.20",
      "port": "1433",
      "instance": "",
      "database": "ERP_LOJAS",
      "user": "integracao",
      "password": "••••••",
      "encrypt": "true",
      "trustServerCertificate": "true",
      "queryTimeoutSeconds": ""
    },
    "updatedAt": "2026-09-30T12:47:11.992Z",
    "updatedByName": "Administrador"
  }
]
```

### GET /api/connections/{id}

Uma conexão, sem os segredos.

**Perfil:** Qualquer perfil

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID da conexão |

**Exemplo de chamada**

```bash
curl "$INFO8N/api/connections/06382b0a-066f-4230-b288-053f93bd9af9" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
{
  "id": "06382b0a-066f-4230-b288-053f93bd9af9",
  "name": "Mercado Bom Preço - Postgres",
  "type": "postgres",
  "typeName": "Postgres",
  "clientId": "bbac4429-0366-4778-957c-0c1d0e6d7c10",
  "clientName": "Mercado Bom Preço",
  "data": {
    "host": "127.0.0.1",
    "port": "5432",
    "database": "cliente_exemplo",
    "user": "postgres",
    "password": "••••••",
    "ssl": "disable",
    "queryTimeoutSeconds": "120"
  },
  "updatedAt": "2026-09-30T12:47:11.982Z",
  "updatedByName": "Administrador"
}
```

**Erros próprios**

- 404: não existe ou é de um cliente sem acesso

### GET /api/connections/{id}/usage

Fluxos que usam a conexão.

**Perfil:** Qualquer perfil

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID da conexão |

**Exemplo de chamada**

```bash
curl "$INFO8N/api/connections/06382b0a-066f-4230-b288-053f93bd9af9/usage" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
[
  {"id": "dec48013-b108-482a-8fc8-0c531e797802", "name": "Avisar estoque baixo", "active": true},
  {"id": "28eed8f6-3e9c-48e0-a144-c4b5226d3b79", "name": "Consultar preço", "active": false},
  {"id": "007e92de-3d13-4d1a-bac0-551ff13033a8", "name": "Relatório demorado", "active": false}
]
```

### POST /api/connections

Cria uma conexão. Os segredos são guardados criptografados.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `name` | corpo | texto | sim | Nome da conexão |
| `type` | corpo | texto | sim | Tipo, como devolvido por GET /connection-types (ex.: postgres, mssql) |
| `clientId` | corpo | uuid ou null | não | Cliente dono da conexão; null para uma conexão sem cliente |
| `data` | corpo | objeto | sim | Campos do tipo, com os valores em texto (ex.: "port": "5432"). Segredo em branco ao alterar mantém o valor salvo |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/connections" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "Mercado Bom Preço - SQL Server",
  "type": "mssql",
  "clientId": "bbac4429-0366-4778-957c-0c1d0e6d7c10",
  "data": {
    "host": "10.0.0.20",
    "port": "1433",
    "database": "ERP_LOJAS",
    "user": "integracao",
    "password": "senha-do-sql",
    "encrypt": "true",
    "trustServerCertificate": "true"
  }
}'
```

**Exemplo de resposta**

```json
{
  "id": "c3d8dac7-563d-44fb-880c-df5d5df117ad",
  "name": "Mercado Bom Preço - SQL Server",
  "type": "mssql",
  "typeName": "SQL Server",
  "clientId": "bbac4429-0366-4778-957c-0c1d0e6d7c10",
  "clientName": "Mercado Bom Preço",
  "data": {
    "host": "10.0.0.20",
    "port": "1433",
    "instance": "",
    "database": "ERP_LOJAS",
    "user": "integracao",
    "password": "••••••",
    "encrypt": "true",
    "trustServerCertificate": "true",
    "queryTimeoutSeconds": ""
  },
  "updatedAt": "2026-09-30T12:47:11.992Z",
  "updatedByName": "Administrador"
}
```

**Erros próprios**

- 400: tipo desconhecido ou campo obrigatório vazio
- 403: cliente sem acesso

### PUT /api/connections/{id}

Altera uma conexão. Não troca o tipo. A auditoria diz quais segredos mudaram, sem os valores.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID da conexão |
| `name` | corpo | texto | sim | Nome da conexão |
| `type` | corpo | texto | sim | Tipo, como devolvido por GET /connection-types (ex.: postgres, mssql) |
| `clientId` | corpo | uuid ou null | não | Cliente dono da conexão; null para uma conexão sem cliente |
| `data` | corpo | objeto | sim | Campos do tipo, com os valores em texto (ex.: "port": "5432"). Segredo em branco ao alterar mantém o valor salvo |

**Exemplo de chamada**

```bash
curl -X PUT "$INFO8N/api/connections/06382b0a-066f-4230-b288-053f93bd9af9" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "Mercado Bom Preço - Postgres",
  "type": "postgres",
  "clientId": "bbac4429-0366-4778-957c-0c1d0e6d7c10",
  "data": {
    "host": "127.0.0.1",
    "port": "5432",
    "database": "cliente_exemplo",
    "user": "postgres",
    "password": "senha-do-banco",
    "ssl": "disable",
    "queryTimeoutSeconds": "120"
  }
}'
```

**Exemplo de resposta**

```json
{
  "id": "06382b0a-066f-4230-b288-053f93bd9af9",
  "name": "Mercado Bom Preço - Postgres",
  "type": "postgres",
  "typeName": "Postgres",
  "clientId": "bbac4429-0366-4778-957c-0c1d0e6d7c10",
  "clientName": "Mercado Bom Preço",
  "data": {
    "host": "127.0.0.1",
    "port": "5432",
    "database": "cliente_exemplo",
    "user": "postgres",
    "password": "••••••",
    "ssl": "disable",
    "queryTimeoutSeconds": "120"
  },
  "updatedAt": "2026-09-30T12:47:11.982Z",
  "updatedByName": "Administrador"
}
```

**Erros próprios**

- 400: troca de tipo ou campo obrigatório vazio
- 403: cliente sem acesso

### DELETE /api/connections/{id}

Exclui uma conexão.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID da conexão |

**Exemplo de chamada**

```bash
curl -X DELETE "$INFO8N/api/connections/42afd978-bae1-4bc5-8a11-49be5240af1e" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
{"ok": true}
```

**Erros próprios**

- 409: fluxos usam a conexão (a mensagem diz quais)

### POST /api/connections/test

Testa os dados de uma conexão sem salvar. Espera até 20 segundos.

**Perfil:** Editor ou acima

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `type` | corpo | texto | sim | Tipo da conexão |
| `data` | corpo | objeto | sim | Campos do tipo |
| `id` | corpo | uuid | não | Conexão já salva; os segredos em branco usam os valores dela |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/connections/test" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "type": "postgres",
  "data": {
    "host": "127.0.0.1",
    "port": "5432",
    "database": "cliente_exemplo",
    "user": "postgres",
    "password": "senha-do-banco"
  }
}'
```

**Exemplo de resposta**

Uma falha no teste também volta com status 200, com ok false e o motivo em message (ex.: database "nao_existe" does not exist).

```json
{"ok": true, "durationMs": 4}
```

**Erros próprios**

- 400: o tipo é testado no próprio nó, ou falta campo obrigatório

### GET /api/oauth/google/redirect-uri

Endereço de retorno que precisa estar cadastrado no app OAuth do Google Cloud para o login com Google das conexões do Gmail.

**Perfil:** Qualquer perfil

**Parâmetros:** nenhum.

**Exemplo de chamada**

```bash
curl "$INFO8N/api/oauth/google/redirect-uri" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

Vem de PUBLIC_URL quando a variável existe. Sem ela, usa o endereço pelo qual o Info8n foi aberto, trocando IP por localhost, porque o Google só aceita retorno para localhost ou para um domínio.

```json
{"redirectUri": "http://localhost:3000/api/oauth/google/callback"}
```

### POST /api/connections/{id}/oauth/google/start

Começa o login com Google de uma conexão do Gmail já salva: devolve o endereço do Google onde a pessoa autoriza o acesso.

**Perfil:** Editor ou acima

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID da conexão |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/connections/5f1c2a77-8d0e-4b8a-9a43-2f6f0f3e9b21/oauth/google/start" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

Abra url no navegador. O pedido vale 15 minutos e só pode ser concluído pelo mesmo usuário. Depois de autorizar, o Google manda o navegador para redirectUri.

```json
{
  "url": "https://accounts.google.com/o/oauth2/v2/auth?client_id=1234-abc.apps.googleusercontent.com&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Foauth%2Fgoogle%2Fcallback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.modify&access_type=offline&prompt=consent&include_granted_scopes=true&state=eyJjIjoiNWYxYzJhNzctOGQwZS00YjhhLTlhNDMtMmY2ZjBmM2U5YjIxIiwidSI6ImM2MDMyOGVmLTIzZjctNGVhNi1hNzE5LTMwMjVmODI4ZDFkNSIsInIiOiJodHRwOi8vbG9jYWxob3N0OjMwMDAvYXBpL29hdXRoL2dvb2dsZS9jYWxsYmFjayIsImUiOjE3OTE1NzQ2NDE5ODd9.q3Jx0Ue1y8b3tYwKkqv0p2r7oJmZ6c1nB4sVh9dXa0E",
  "redirectUri": "http://localhost:3000/api/oauth/google/callback"
}
```

**Erros próprios**

- 400: a conexão não usa login com Google, ou falta salvar o client ID e o client secret
- 404: não existe ou é de um cliente sem acesso

### POST /api/connections/{id}/oauth/google/complete

Conclui o login com Google colando o endereço da página para onde o Google mandou. Serve quando o Info8n é aberto por IP e o retorno foi para localhost, onde ele não roda.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID da conexão |
| `url` | corpo | texto | sim | Endereço completo da página de retorno, com code e state (ex.: http://localhost:3000/api/oauth/google/callback?state=...&code=...) |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/connections/5f1c2a77-8d0e-4b8a-9a43-2f6f0f3e9b21/oauth/google/complete" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "url": "http://localhost:3000/api/oauth/google/callback?state=eyJjIjoiNWYxYzJhNzct...q3Jx0Ue1y8b3tYwKkqv0p2r7oJmZ6c1nB4sVh9dXa0E&code=4%2F0AVG7fiQ-exemplo&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.modify"
}'
```

**Exemplo de resposta**

account é o e-mail da conta do Google conectada. O acesso fica guardado criptografado na conexão e nunca volta pela API.

```json
{
  "id": "5f1c2a77-8d0e-4b8a-9a43-2f6f0f3e9b21",
  "name": "Gmail financeiro",
  "account": "financeiro@empresa.com"
}
```

_O state foi encurtado; cole o endereço inteiro, como aparece na barra do navegador._

**Erros próprios**

- 400: endereço sem code e state, pedido vencido ou de outra conexão, autorização cancelada, ou o Google não aceitou o código (a mensagem traz o motivo)
- 403: o pedido foi começado por outro usuário

### GET /api/oauth/google/callback

Retorno do Google depois da autorização. Quem chama é o navegador, sem sessão: a conexão e o usuário vêm do state assinado. Grava o acesso na conexão e volta para a tela de conexões.

**Perfil:** Sem login · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `code` | URL | texto | não | Código da autorização, enviado pelo Google |
| `state` | URL | texto | não | Pedido assinado criado por POST /connections/{id}/oauth/google/start |
| `error` | URL | texto | não | Enviado pelo Google quando a autorização falha ou é cancelada (ex.: access_denied) |

**Exemplo de chamada**

```bash
curl "$INFO8N/api/oauth/google/callback?state=eyJjIjoiNWYxYzJhNzct...q3Jx0Ue1y8b3tYwKkqv0p2r7oJmZ6c1nB4sVh9dXa0E&code=4%2F0AVG7fiQ-exemplo"
```

**Exemplo de resposta**

Responde com redirecionamento (302) para /conexoes?google=ok&conexao={id}&conta={e-mail}, ou para /conexoes?google=erro&mensagem={motivo} quando algo falha.

```json
{
  "status": 302,
  "location": "/conexoes?google=ok&conexao=5f1c2a77-8d0e-4b8a-9a43-2f6f0f3e9b21&conta=financeiro%40empresa.com"
}
```

_A resposta é um redirecionamento; o exemplo mostra o status e o cabeçalho Location. Quem chama esta rota é o navegador, vindo do Google._

## Arquivos

### POST /api/files

Guarda um arquivo para os fluxos usarem, como o anexo escolhido no nó Gmail. O arquivo vai como está no corpo, sem base64, com Content-Type: application/octet-stream; o fluxo guarda só o ID devolvido.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `name` | URL | texto | sim | Nome do arquivo, com a extensão (ex.: boleto.pdf) |
| `type` | URL | texto | não | Tipo do arquivo (ex.: application/pdf); em branco, application/octet-stream |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/files?name=boleto-setembro.pdf&type=application%2Fpdf" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@boleto-setembro.pdf"
```

**Exemplo de resposta**

Responde com status 201. id é o que vai no campo Arquivo do anexo, no parâmetro file da lista attachments do nó Gmail.

```json
{
  "id": "9b2e4c61-3f0a-4d7e-8b15-6a0c2d9e7f43",
  "name": "boleto-setembro.pdf",
  "mimeType": "application/pdf",
  "size": 48213,
  "createdAt": "2026-10-03T22:41:07.512Z",
  "createdByName": "Ana Lima"
}
```

**Erros próprios**

- 400: falta o nome, o arquivo está vazio ou o corpo não veio como application/octet-stream
- 413: o arquivo passa de 25 MB

### GET /api/files/{id}

Nome, tipo, tamanho em bytes e quem enviou o arquivo.

**Perfil:** Qualquer perfil

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do arquivo |

**Exemplo de chamada**

```bash
curl "$INFO8N/api/files/9b2e4c61-3f0a-4d7e-8b15-6a0c2d9e7f43" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
{
  "id": "9b2e4c61-3f0a-4d7e-8b15-6a0c2d9e7f43",
  "name": "boleto-setembro.pdf",
  "mimeType": "application/pdf",
  "size": 48213,
  "createdAt": "2026-10-03T22:41:07.512Z",
  "createdByName": "Ana Lima"
}
```

**Erros próprios**

- 404: o arquivo não existe

### GET /api/files/{id}/content

Baixa o arquivo, com o tipo e o nome guardados.

**Perfil:** Qualquer perfil

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do arquivo |

**Exemplo de chamada**

```bash
curl "$INFO8N/api/files/9b2e4c61-3f0a-4d7e-8b15-6a0c2d9e7f43/content" \
  -H "Authorization: Bearer $TOKEN" \
  -o "boleto-setembro.pdf"
```

**Exemplo de resposta**

O corpo é o próprio arquivo, com Content-Type do tipo guardado e Content-Disposition: attachment com o nome.

```json
{
  "status": 200,
  "content-type": "application/pdf",
  "content-disposition": "attachment; filename*=UTF-8''boleto-setembro.pdf"
}
```

_O corpo é o arquivo; o exemplo mostra o status e os cabeçalhos. O curl grava o arquivo com -o._

**Erros próprios**

- 404: o arquivo não existe

## APIs dos ERPs

### GET /api/erps

ERPs cadastrados.

**Perfil:** Qualquer perfil

**Parâmetros:** nenhum.

**Exemplo de chamada**

```bash
curl "$INFO8N/api/erps" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

endpoints e clients são quantos endpoints e quantos clientes o ERP tem.

```json
[
  {
    "id": "6662ff1e-00be-44d4-b113-b44184345f8f",
    "name": "ERP Vendas",
    "baseUrl": "http://{{host}}:{{porta}}/api/v2",
    "authType": "bearer",
    "authHeader": null,
    "clientFields": [
      {"name": "host", "label": "Host", "secret": false},
      {"name": "porta", "label": "Porta", "secret": false},
      {"name": "usuario", "label": "Usuário", "secret": false},
      {"name": "senha", "label": "Senha", "secret": true}
    ],
    "notes": "Versão 5.3",
    "updatedAt": "2026-09-30T12:43:35.956Z",
    "endpoints": 2,
    "clients": 1
  }
]
```

### GET /api/erps/{id}

Um ERP com os endpoints e os clientes cadastrados nele (só os clientes que o usuário enxerga, sem os segredos).

**Perfil:** Qualquer perfil

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do ERP |

**Exemplo de chamada**

```bash
curl "$INFO8N/api/erps/6662ff1e-00be-44d4-b113-b44184345f8f" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

Nos clientes, os valores dos campos secretos vêm como ••••••.

```json
{
  "id": "6662ff1e-00be-44d4-b113-b44184345f8f",
  "name": "ERP Vendas",
  "baseUrl": "http://{{host}}:{{porta}}/api/v2",
  "authType": "bearer",
  "authHeader": null,
  "clientFields": [
    {"name": "host", "label": "Host", "secret": false},
    {"name": "porta", "label": "Porta", "secret": false},
    {"name": "usuario", "label": "Usuário", "secret": false},
    {"name": "senha", "label": "Senha", "secret": true}
  ],
  "notes": "Versão 5.3",
  "updatedAt": "2026-09-30T12:43:35.956Z",
  "endpoints": [
    {
      "id": "be63f1e8-a9a2-4171-b3ea-31fd5e5274bc",
      "name": "Consultar preço",
      "description": "Preço de venda de um produto na loja",
      "method": "GET",
      "path": "/produtos/{{sku}}/preco",
      "headers": [],
      "query": [{"name": "loja", "value": "{{loja}}"}],
      "bodyType": "none",
      "body": "",
      "variables": [
        {
          "name": "sku",
          "type": "text",
          "label": "Código do produto",
          "default": "",
          "required": true
        },
        {"name": "loja", "type": "number", "label": "Loja", "default": "1", "required": false}
      ],
      "usesAuth": true,
      "updatedAt": "2026-09-30T12:43:35.980Z"
    },
    {
      "id": "31558700-6acf-48eb-b109-2c1f4701e412",
      "name": "Login",
      "description": "Pega o token de acesso",
      "method": "POST",
      "path": "/login",
      "headers": [],
      "query": [],
      "bodyType": "json",
      "body": "{\"usuario\": \"{{usuario}}\", \"senha\": \"{{senha}}\"}",
      "variables": [],
      "usesAuth": false,
      "updatedAt": "2026-09-30T12:43:35.964Z"
    }
  ],
  "clients": [
    {
      "id": "00f9b5a4-4cda-4f65-b58f-21fd892f87c5",
      "clientId": "bbac4429-0366-4778-957c-0c1d0e6d7c10",
      "clientName": "Mercado Bom Preço",
      "label": "Produção",
      "values": {"host": "10.0.0.16", "porta": "8080", "usuario": "integracao", "senha": "••••••"},
      "updatedAt": "2026-09-30T12:43:36.007Z"
    }
  ]
}
```

### POST /api/erps

Cadastra um ERP.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `name` | corpo | texto | sim | Nome do ERP (único) |
| `baseUrl` | corpo | texto | sim | Endereço base; aceita {{variáveis}} do cadastro do cliente |
| `authType` | corpo | texto | sim | none, bearer, basic ou header |
| `authHeader` | corpo | texto | não | Nome do header, quando authType é header |
| `clientFields` | corpo | lista | não | Campos pedidos no cadastro do cliente: [{"name","label","secret"}]. Padrão: host, porta, usuário e senha |
| `notes` | corpo | texto | não | Observações |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/erps" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "ERP Vendas",
  "baseUrl": "http://{{host}}:{{porta}}/api",
  "authType": "bearer",
  "notes": "Versão 5.2"
}'
```

**Exemplo de resposta**

```json
{
  "id": "6662ff1e-00be-44d4-b113-b44184345f8f",
  "name": "ERP Vendas",
  "baseUrl": "http://{{host}}:{{porta}}/api",
  "authType": "bearer",
  "authHeader": null,
  "clientFields": [
    {"name": "host", "label": "Host", "secret": false},
    {"name": "porta", "label": "Porta", "secret": false},
    {"name": "usuario", "label": "Usuário", "secret": false},
    {"name": "senha", "label": "Senha", "secret": true}
  ],
  "notes": "Versão 5.2",
  "updatedAt": "2026-09-30T12:43:35.940Z"
}
```

**Erros próprios**

- 409: já existe um ERP com esse nome

### PUT /api/erps/{id}

Altera um ERP.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do ERP |
| `name` | corpo | texto | sim | Nome do ERP (único) |
| `baseUrl` | corpo | texto | sim | Endereço base; aceita {{variáveis}} do cadastro do cliente |
| `authType` | corpo | texto | sim | none, bearer, basic ou header |
| `authHeader` | corpo | texto | não | Nome do header, quando authType é header |
| `clientFields` | corpo | lista | não | Campos pedidos no cadastro do cliente: [{"name","label","secret"}]. Padrão: host, porta, usuário e senha |
| `notes` | corpo | texto | não | Observações |

**Exemplo de chamada**

```bash
curl -X PUT "$INFO8N/api/erps/6662ff1e-00be-44d4-b113-b44184345f8f" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "ERP Vendas",
  "baseUrl": "http://{{host}}:{{porta}}/api/v2",
  "authType": "bearer",
  "notes": "Versão 5.3"
}'
```

**Exemplo de resposta**

```json
{
  "id": "6662ff1e-00be-44d4-b113-b44184345f8f",
  "name": "ERP Vendas",
  "baseUrl": "http://{{host}}:{{porta}}/api/v2",
  "authType": "bearer",
  "authHeader": null,
  "clientFields": [
    {"name": "host", "label": "Host", "secret": false},
    {"name": "porta", "label": "Porta", "secret": false},
    {"name": "usuario", "label": "Usuário", "secret": false},
    {"name": "senha", "label": "Senha", "secret": true}
  ],
  "notes": "Versão 5.3",
  "updatedAt": "2026-09-30T12:43:35.956Z"
}
```

### DELETE /api/erps/{id}

Exclui um ERP e os endpoints dele.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do ERP |

**Exemplo de chamada**

```bash
curl -X DELETE "$INFO8N/api/erps/8771e566-2f59-448e-9c8a-da196a74b5f4" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
{"ok": true}
```

**Erros próprios**

- 409: o ERP tem clientes cadastrados

### POST /api/erps/{id}/endpoints

Cadastra um endpoint no ERP.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do ERP |
| `name` | corpo | texto | sim | Nome do endpoint (único no ERP) |
| `description` | corpo | texto | não | O que ele faz |
| `method` | corpo | texto | sim | GET, POST, PUT, PATCH ou DELETE |
| `path` | corpo | texto | sim | Caminho depois do endereço base; aceita {{variáveis}} |
| `headers` | corpo | lista | não | Headers: [{"name","value"}] |
| `query` | corpo | lista | não | Parâmetros da URL: [{"name","value"}] |
| `bodyType` | corpo | texto | não | none, json, form ou text (padrão none) |
| `body` | corpo | texto | não | Corpo enviado; aceita {{variáveis}} |
| `variables` | corpo | lista | não | Variáveis pedidas no nó: [{"name","label","type" (text, number, boolean, json),"required","default"}] |
| `usesAuth` | corpo | sim ou não | não | Se usa a autenticação do ERP (padrão sim). Desmarque no endpoint de login |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/erps/6662ff1e-00be-44d4-b113-b44184345f8f/endpoints" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "Consultar preço",
  "description": "Preço de venda de um produto",
  "method": "GET",
  "path": "/produtos/{{sku}}/preco",
  "query": [{"name": "loja", "value": "{{loja}}"}],
  "variables": [
    {"name": "sku", "label": "Código do produto", "type": "text", "required": true},
    {
      "name": "loja",
      "label": "Loja",
      "type": "number",
      "required": false,
      "default": "1"
    }
  ]
}'
```

**Exemplo de resposta**

```json
{"id": "be63f1e8-a9a2-4171-b3ea-31fd5e5274bc"}
```

**Erros próprios**

- 409: o ERP já tem um endpoint com esse nome

### PUT /api/erp-endpoints/{id}

Altera um endpoint.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do endpoint |
| `name` | corpo | texto | sim | Nome do endpoint (único no ERP) |
| `description` | corpo | texto | não | O que ele faz |
| `method` | corpo | texto | sim | GET, POST, PUT, PATCH ou DELETE |
| `path` | corpo | texto | sim | Caminho depois do endereço base; aceita {{variáveis}} |
| `headers` | corpo | lista | não | Headers: [{"name","value"}] |
| `query` | corpo | lista | não | Parâmetros da URL: [{"name","value"}] |
| `bodyType` | corpo | texto | não | none, json, form ou text (padrão none) |
| `body` | corpo | texto | não | Corpo enviado; aceita {{variáveis}} |
| `variables` | corpo | lista | não | Variáveis pedidas no nó: [{"name","label","type" (text, number, boolean, json),"required","default"}] |
| `usesAuth` | corpo | sim ou não | não | Se usa a autenticação do ERP (padrão sim). Desmarque no endpoint de login |

**Exemplo de chamada**

```bash
curl -X PUT "$INFO8N/api/erp-endpoints/be63f1e8-a9a2-4171-b3ea-31fd5e5274bc" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "Consultar preço",
  "description": "Preço de venda de um produto na loja",
  "method": "GET",
  "path": "/produtos/{{sku}}/preco",
  "query": [{"name": "loja", "value": "{{loja}}"}],
  "variables": [
    {"name": "sku", "label": "Código do produto", "type": "text", "required": true},
    {
      "name": "loja",
      "label": "Loja",
      "type": "number",
      "required": false,
      "default": "1"
    }
  ]
}'
```

**Exemplo de resposta**

```json
{"ok": true}
```

### DELETE /api/erp-endpoints/{id}

Exclui um endpoint.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do endpoint |

**Exemplo de chamada**

```bash
curl -X DELETE "$INFO8N/api/erp-endpoints/9ad6b703-e552-403d-8e70-9224d3117c43" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
{"ok": true}
```

**Erros próprios**

- 409: fluxos usam o endpoint (a mensagem diz quais)

### POST /api/erps/{id}/clients

Cadastra um cliente no ERP. Os segredos são guardados criptografados.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do ERP |
| `clientId` | corpo | uuid | sim | Cliente; o usuário precisa ter acesso a ele |
| `label` | corpo | texto | não | Nome do cadastro, para ter mais de um por cliente (ex.: Homologação) |
| `values` | corpo | objeto | sim | Valores dos campos do ERP, em texto (ex.: "porta": "8080"). Segredo em branco ao alterar mantém o valor salvo |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/erps/6662ff1e-00be-44d4-b113-b44184345f8f/clients" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "clientId": "bbac4429-0366-4778-957c-0c1d0e6d7c10",
  "label": "Produção",
  "values": {
    "host": "10.0.0.15",
    "porta": "8080",
    "usuario": "integracao",
    "senha": "segredo-do-erp"
  }
}'
```

**Exemplo de resposta**

```json
{"id": "00f9b5a4-4cda-4f65-b58f-21fd892f87c5"}
```

**Erros próprios**

- 403: cliente sem acesso
- 409: o cliente já está no ERP com esse label

### PUT /api/erp-clients/{id}

Altera o cadastro de um cliente no ERP.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do cadastro |
| `clientId` | corpo | uuid | sim | Cliente; o usuário precisa ter acesso a ele |
| `label` | corpo | texto | não | Nome do cadastro, para ter mais de um por cliente (ex.: Homologação) |
| `values` | corpo | objeto | sim | Valores dos campos do ERP, em texto (ex.: "porta": "8080"). Segredo em branco ao alterar mantém o valor salvo |

**Exemplo de chamada**

```bash
curl -X PUT "$INFO8N/api/erp-clients/00f9b5a4-4cda-4f65-b58f-21fd892f87c5" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "clientId": "bbac4429-0366-4778-957c-0c1d0e6d7c10",
  "label": "Produção",
  "values": {"host": "10.0.0.16", "porta": "8080", "usuario": "integracao", "senha": ""}
}'
```

**Exemplo de resposta**

```json
{"ok": true}
```

**Erros próprios**

- 403: cliente sem acesso

### DELETE /api/erp-clients/{id}

Exclui o cadastro de um cliente no ERP.

**Perfil:** Editor ou acima · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do cadastro |

**Exemplo de chamada**

```bash
curl -X DELETE "$INFO8N/api/erp-clients/676240ab-80ca-4f5d-b22d-ad47fd05fb3f" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
{"ok": true}
```

**Erros próprios**

- 409: fluxos usam o cadastro (a mensagem diz quais)

### GET /api/api-catalog

O que o nó HTTP Request oferece no modo API cadastrada.

**Perfil:** Qualquer perfil

**Parâmetros:** nenhum.

**Exemplo de chamada**

```bash
curl "$INFO8N/api/api-catalog" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

clients são os cadastros de clientes nos ERPs e endpoints, os endpoints de todos os ERPs, ligados pelo erpId. Endpoints que usam a autenticação do ERP (bearer ou header) ganham a variável token, que recebe o token do nó de login.

```json
{
  "clients": [
    {
      "id": "00f9b5a4-4cda-4f65-b58f-21fd892f87c5",
      "erpId": "6662ff1e-00be-44d4-b113-b44184345f8f",
      "erpName": "ERP Vendas",
      "clientName": "Mercado Bom Preço",
      "label": "Produção"
    }
  ],
  "endpoints": [
    {
      "id": "be63f1e8-a9a2-4171-b3ea-31fd5e5274bc",
      "erpId": "6662ff1e-00be-44d4-b113-b44184345f8f",
      "name": "Consultar preço",
      "description": "Preço de venda de um produto na loja",
      "method": "GET",
      "path": "/produtos/{{sku}}/preco",
      "variables": [
        {
          "name": "sku",
          "type": "text",
          "label": "Código do produto",
          "default": "",
          "required": true
        },
        {"name": "loja", "type": "number", "label": "Loja", "default": "1", "required": false},
        {"name": "token", "label": "Token (do nó de login)", "type": "text", "required": true}
      ]
    },
    {
      "id": "31558700-6acf-48eb-b109-2c1f4701e412",
      "erpId": "6662ff1e-00be-44d4-b113-b44184345f8f",
      "name": "Login",
      "description": "Pega o token de acesso",
      "method": "POST",
      "path": "/login",
      "variables": []
    }
  ]
}
```

## Administração

### GET /api/users

Usuários.

**Perfil:** Administrador

**Parâmetros:** nenhum.

**Exemplo de chamada**

```bash
curl "$INFO8N/api/users" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

locked_until é até quando o usuário fica bloqueado por errar a senha (null se não está bloqueado). Para administradores, folder_ids e client_ids vêm vazios, porque eles enxergam tudo.

```json
[
  {
    "id": "c60328ef-23f7-4ea6-a719-3025f828d1d5",
    "email": "admin@empresa.com",
    "name": "Administrador",
    "role": "admin",
    "active": true,
    "locked_until": null,
    "created_at": "2026-09-30T12:39:57.669Z",
    "folder_ids": [],
    "client_ids": []
  },
  {
    "id": "285956ee-c429-4eb0-abec-16015696d860",
    "email": "integracao.erp@empresa.com",
    "name": "Integração ERP",
    "role": "operator",
    "active": true,
    "locked_until": "2026-09-30T12:59:47.392Z",
    "created_at": "2026-09-30T12:44:45.166Z",
    "folder_ids": ["7310270d-68a9-4f71-bce6-14fcc7ba6b22"],
    "client_ids": ["bbac4429-0366-4778-957c-0c1d0e6d7c10"]
  }
]
```

### POST /api/users

Cria um usuário.

**Perfil:** Administrador · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `email` | corpo | texto | sim | E-mail de login (único) |
| `name` | corpo | texto | sim | Nome |
| `role` | corpo | texto | sim | admin, editor, operator ou viewer |
| `active` | corpo | sim ou não | não | Usuário ativo (padrão sim). Desativado não entra e os tokens dele param |
| `password` | corpo | texto | sim | Senha inicial; o usuário troca no primeiro acesso |
| `folderIds` | corpo | lista de uuid | não | Pastas que o usuário enxerga (administrador enxerga todas) |
| `clientIds` | corpo | lista de uuid | não | Clientes que o usuário enxerga (administrador enxerga todos) |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/users" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "email": "integracao.erp@empresa.com",
  "name": "Integração ERP",
  "role": "operator",
  "password": "senha-inicial-123",
  "folderIds": ["7310270d-68a9-4f71-bce6-14fcc7ba6b22"],
  "clientIds": ["bbac4429-0366-4778-957c-0c1d0e6d7c10"]
}'
```

**Exemplo de resposta**

```json
{
  "id": "285956ee-c429-4eb0-abec-16015696d860",
  "email": "integracao.erp@empresa.com",
  "name": "Integração ERP",
  "role": "operator",
  "active": true,
  "locked_until": null,
  "created_at": "2026-09-30T12:44:45.166Z",
  "folder_ids": ["7310270d-68a9-4f71-bce6-14fcc7ba6b22"],
  "client_ids": ["bbac4429-0366-4778-957c-0c1d0e6d7c10"]
}
```

**Erros próprios**

- 400: senha fraca ou ausente
- 409: já existe um usuário com esse e-mail

### PUT /api/users/{id}

Altera um usuário. Desativar ou redefinir a senha derruba as sessões dele.

**Perfil:** Administrador · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do usuário |
| `email` | corpo | texto | sim | E-mail de login (único) |
| `name` | corpo | texto | sim | Nome |
| `role` | corpo | texto | sim | admin, editor, operator ou viewer |
| `active` | corpo | sim ou não | não | Usuário ativo (padrão sim). Desativado não entra e os tokens dele param |
| `password` | corpo | texto | não | Nova senha; se enviada, redefine a senha e derruba as sessões |
| `folderIds` | corpo | lista de uuid | não | Pastas que o usuário enxerga (administrador enxerga todas) |
| `clientIds` | corpo | lista de uuid | não | Clientes que o usuário enxerga (administrador enxerga todos) |

**Exemplo de chamada**

```bash
curl -X PUT "$INFO8N/api/users/285956ee-c429-4eb0-abec-16015696d860" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "email": "integracao.erp@empresa.com",
  "name": "Integração ERP",
  "role": "operator",
  "active": true,
  "folderIds": ["7310270d-68a9-4f71-bce6-14fcc7ba6b22"],
  "clientIds": ["bbac4429-0366-4778-957c-0c1d0e6d7c10"]
}'
```

**Exemplo de resposta**

```json
{
  "id": "285956ee-c429-4eb0-abec-16015696d860",
  "email": "integracao.erp@empresa.com",
  "name": "Integração ERP",
  "role": "operator",
  "active": true,
  "locked_until": null,
  "created_at": "2026-09-30T12:44:45.166Z",
  "folder_ids": ["7310270d-68a9-4f71-bce6-14fcc7ba6b22"],
  "client_ids": ["bbac4429-0366-4778-957c-0c1d0e6d7c10"]
}
```

**Erros próprios**

- 400: senha fraca, ou o administrador tirando o próprio acesso

### POST /api/users/{id}/unlock

Desbloqueia um usuário que errou a senha demais.

**Perfil:** Administrador · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do usuário |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/users/285956ee-c429-4eb0-abec-16015696d860/unlock" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
{"ok": true}
```

### GET /api/folders

Pastas que o usuário enxerga.

**Perfil:** Qualquer perfil

**Parâmetros:** nenhum.

**Exemplo de chamada**

```bash
curl "$INFO8N/api/folders" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
[
  {"id": "7310270d-68a9-4f71-bce6-14fcc7ba6b22", "name": "Financeiro"},
  {"id": "415cea55-d153-474c-aad7-dd89ae88307f", "name": "Geral"}
]
```

### POST /api/folders

Cria uma pasta.

**Perfil:** Administrador · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `name` | corpo | texto | sim | Nome (único) |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/folders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Financeiro"}'
```

**Exemplo de resposta**

```json
{"id": "7310270d-68a9-4f71-bce6-14fcc7ba6b22", "name": "Financeiro"}
```

**Erros próprios**

- 409: já existe uma pasta com esse nome

### PUT /api/folders/{id}

Renomeia uma pasta.

**Perfil:** Administrador · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID da pasta |
| `name` | corpo | texto | sim | Nome novo |

**Exemplo de chamada**

```bash
curl -X PUT "$INFO8N/api/folders/3ea0a430-ce06-49d2-91cf-6d916c7614f6" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Testes antigos"}'
```

**Exemplo de resposta**

```json
{"id": "3ea0a430-ce06-49d2-91cf-6d916c7614f6", "name": "Testes antigos"}
```

### DELETE /api/folders/{id}

Exclui uma pasta vazia.

**Perfil:** Administrador · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID da pasta |

**Exemplo de chamada**

```bash
curl -X DELETE "$INFO8N/api/folders/3ea0a430-ce06-49d2-91cf-6d916c7614f6" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
{"ok": true}
```

**Erros próprios**

- 409: a pasta tem fluxos

### GET /api/clients

Clientes que o usuário enxerga.

**Perfil:** Qualquer perfil

**Parâmetros:** nenhum.

**Exemplo de chamada**

```bash
curl "$INFO8N/api/clients" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
[
  {
    "id": "bbac4429-0366-4778-957c-0c1d0e6d7c10",
    "name": "Mercado Bom Preço",
    "notes": "Rede com 12 lojas"
  }
]
```

### POST /api/clients

Cria um cliente.

**Perfil:** Administrador · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `name` | corpo | texto | sim | Nome (único) |
| `notes` | corpo | texto | não | Observações |

**Exemplo de chamada**

```bash
curl -X POST "$INFO8N/api/clients" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Mercado Bom Preço", "notes": "Rede com 12 lojas"}'
```

**Exemplo de resposta**

```json
{
  "id": "bbac4429-0366-4778-957c-0c1d0e6d7c10",
  "name": "Mercado Bom Preço",
  "notes": "Rede com 12 lojas"
}
```

**Erros próprios**

- 409: já existe um cliente com esse nome

### PUT /api/clients/{id}

Altera um cliente.

**Perfil:** Administrador · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do cliente |
| `name` | corpo | texto | sim | Nome |
| `notes` | corpo | texto | não | Observações |

**Exemplo de chamada**

```bash
curl -X PUT "$INFO8N/api/clients/76fdbd95-1f26-4094-b9f1-d046f6646f4f" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Cliente de teste (inativo)", "notes": "Contrato encerrado"}'
```

**Exemplo de resposta**

```json
{
  "id": "76fdbd95-1f26-4094-b9f1-d046f6646f4f",
  "name": "Cliente de teste (inativo)",
  "notes": "Contrato encerrado"
}
```

### DELETE /api/clients/{id}

Exclui um cliente sem conexões e sem cadastro em ERP.

**Perfil:** Administrador · registra na auditoria

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `id` | caminho | uuid | sim | ID do cliente |

**Exemplo de chamada**

```bash
curl -X DELETE "$INFO8N/api/clients/76fdbd95-1f26-4094-b9f1-d046f6646f4f" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

```json
{"ok": true}
```

**Erros próprios**

- 409: o cliente tem conexões ou está cadastrado em um ERP

### GET /api/audit

Registros da auditoria, mais novos primeiro.

**Perfil:** Administrador

**Parâmetros**

| Campo | Onde | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- | --- |
| `entityType` | URL | texto | não | Tipo do registro (workflow, connection, user, api_token, execution…) |
| `entityId` | URL | texto | não | ID do registro |
| `userId` | URL | uuid | não | Quem fez |
| `from` | URL | data e hora | não | A partir de quando, com fuso (ex.: 2026-09-30T00:00:00-03:00) |
| `to` | URL | data e hora | não | Até quando, com fuso |
| `before` | URL | número | não | Para paginar: id da última linha recebida |
| `limit` | URL | número | não | Quantas linhas devolver, de 1 a 200 (padrão 50) |

**Exemplo de chamada**

```bash
curl "$INFO8N/api/audit?entityType=workflow&limit=2" \
  -H "Authorization: Bearer $TOKEN"
```

**Exemplo de resposta**

before e after são o registro antes e depois da mudança, sem os segredos. id vem como texto; para a próxima página, mande o id da última linha em before.

```json
[
  {
    "id": "45",
    "at": "2026-09-30T12:44:13.867Z",
    "action": "import",
    "entity_type": "workflow",
    "entity_id": "462e856b-1378-44b6-911c-ede2133a0481",
    "entity_name": "Boas-vindas",
    "before": null,
    "after": {"n8nId": "r7Kp2QmX9aLs", "avisos": 0, "origem": "n8n"},
    "ip": "127.0.0.1",
    "user_name": "Administrador",
    "user_email": "admin@empresa.com"
  },
  {
    "id": "44",
    "at": "2026-09-30T12:44:13.843Z",
    "action": "delete",
    "entity_type": "workflow",
    "entity_id": "b2bbbd6a-aa22-4ef0-a066-1ed17da5888b",
    "entity_name": "Consultar preço (cópia)",
    "before": {
      "name": "Consultar preço (cópia)",
      "folderId": "7310270d-68a9-4f71-bce6-14fcc7ba6b22",
      "definition": {
        "nodes": [
          {
            "id": "gatilho",
            "name": "Gatilho manual",
            "type": "manualTrigger",
            "position": {"x": 100, "y": 200},
            "parameters": {}
          },
          {
            "id": "buscar",
            "name": "Buscar preço",
            "type": "database",
            "position": {"x": 350, "y": 200},
            "parameters": {
              "sql": "SELECT codigo, descricao, preco, estoque FROM produtos WHERE codigo = :codigo",
              "operation": "query",
              "connection": "06382b0a-066f-4230-b288-053f93bd9af9",
              "queryParams": [{"name": "codigo", "value": "={{ $json.sku }}"}]
            }
          }
        ],
        "connections": [{"to": "buscar", "from": "gatilho", "toInput": 0, "fromOutput": 0}]
      }
    },
    "after": null,
    "ip": "127.0.0.1",
    "user_name": "Administrador",
    "user_email": "admin@empresa.com"
  }
]
```

<!-- rotas:fim -->
