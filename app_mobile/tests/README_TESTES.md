# Testes Mobile

Esta pasta contem testes/simuladores locais para validar o contrato Mobile V1 antes de criar o projeto Android.

## Teste: criar pedido `arte_empresa`

Arquivo:

```text
mobile_create_arte_empresa_test.js
```

Objetivo:

- Simular o futuro app Android.
- Criar um pedido `arte_empresa` via `POST /pedidos`.
- Montar `multipart/form-data` sem usar `app.html`.
- Validar se a API atual aceita o contrato Mobile V1.

## Requisitos

- API rodando localmente ou em URL acessivel.
- Token JWT valido.
- Arquivo de logo em PNG, JPG, JPEG ou WEBP.
- Node.js com `fetch`, `FormData` e `Blob` globais.

## Variaveis de ambiente

Obrigatorias:

```text
TOKEN
LOGO_PATH
```

Opcional:

```text
API_BASE
```

Padrao de `API_BASE`:

```text
http://localhost:3000
```

## Como executar no PowerShell

Exemplo com API local:

```powershell
$env:API_BASE="http://localhost:3000"
$env:TOKEN="COLE_O_JWT_AQUI"
$env:LOGO_PATH="C:\caminho\para\logo.png"
node app_mobile\tests\mobile_create_arte_empresa_test.js
```

Exemplo com API de producao:

```powershell
$env:API_BASE="https://ia4tube-api.onrender.com"
$env:TOKEN="COLE_O_JWT_AQUI"
$env:LOGO_PATH="C:\caminho\para\logo.png"
node app_mobile\tests\mobile_create_arte_empresa_test.js
```

## O que o teste envia

Campos principais:

- `flyer_tipo=arte_empresa`
- `product_id=arte_empresa`
- `schema_version=2`
- `fields_json`
- `assets_json`
- `ramo`
- `nome_empresa`
- `objetivo`
- `estilo_visual_cliente`
- `rodada=Arte para Empresa`
- `data=Arte para Empresa`
- `logo`

## Sucesso esperado

HTTP `200` com JSON:

```json
{
  "ok": true,
  "pedido_id": "..."
}
```

Isso significa que a API atual aceitou um pedido `arte_empresa` criado fora do `app.html`.

## Erros comuns

### Sem token

O script mostra instrucoes de uso e encerra.

### Sem logo

O script mostra instrucoes de uso ou informa que `LOGO_PATH` nao existe.

### HTTP 401

Token ausente, invalido ou expirado.

### HTTP 400

Algum campo obrigatorio nao foi aceito pela API. Verifique se `rodada`, `data`, `ramo`, `nome_empresa`, `objetivo` e `logo` foram enviados.

### HTTP 500

Erro interno da API ou dependencia do backend.

## Observacoes de seguranca

- Este teste cria pedido real no ambiente apontado por `API_BASE`.
- Use preferencialmente API local para validacao.
- Nao versione tokens.
- Nao use dados sensiveis no payload de teste.
- O teste nao altera `server.js`, `app.html`, endpoints, runners ou prompts.

## Validacao realizada

Em 2026-05-25, o teste `mobile_create_arte_empresa_test.js` funcionou contra a API online:

```json
{
  "ok": true,
  "pedido_id": "20260525_180819"
}
```

Resultado HTTP:

```text
HTTP 200 OK
```

## Validacao ponta a ponta realizada

Em 2026-05-25, o ciclo mobile completo foi validado com sucesso usando o pedido `20260525_180819`.

Resultados:

- `GET /pedidos/:id/info`: `HTTP 200`, `status="pronto"`, `imagem_pronta=true`.
- `GET /pedidos/:id/preview`: `HTTP 200`, `image/jpeg`, salvando `preview_20260525_180819.jpg`.
- `POST /pedidos/:id/aprovar`: `HTTP 200`, `aprovado_cliente=true`, `pode_baixar=true`.
- `GET /pedidos/:id/download-resultado`: `HTTP 200`, `image/png`, salvando `download_20260525_180819.png`.

Conclusao:

- O fluxo principal Mobile V1 para `arte_empresa` esta validado fora do `app.html`.
- Criacao, consulta, preview, aprovacao e download podem ser implementados no Android usando os contratos documentados.

## Teste: consultar info de pedido

Arquivo:

```text
mobile_order_info_test.js
```

Objetivo:

- Simular o futuro app Android consultando um pedido existente.
- Chamar `GET /pedidos/:id/info`.
- Validar o contrato de detalhe/status do pedido.

Variaveis obrigatorias:

```text
TOKEN
PEDIDO_ID
```

Variavel opcional:

```text
API_BASE
```

Padrao de `API_BASE` para este teste:

```text
https://ia4tube-api.onrender.com
```

Como executar no PowerShell:

```powershell
$env:API_BASE="https://ia4tube-api.onrender.com"
$env:TOKEN="COLE_O_JWT_AQUI"
$env:PEDIDO_ID="20260525_180819"
node app_mobile\tests\mobile_order_info_test.js
```

Sucesso esperado:

```json
{
  "ok": true,
  "id": "20260525_180819",
  "status": "novo",
  "categoria": "arte_empresa",
  "imagem_pronta": false
}
```

O status e os campos podem variar conforme o pedido evoluir na producao.

Erros comuns:

- HTTP `401`: token invalido, expirado ou ausente.
- HTTP `404`: pedido nao pertence ao usuario do token ou nao existe.
- HTTP `500`: erro interno da API.

## Ciclo mobile completo do pedido

Os testes abaixo simulam o ciclo de vida do pedido pelo app Android V1.

Ordem recomendada:

1. `mobile_order_info_test.js`
2. `mobile_order_preview_test.js`
3. `mobile_order_approve_test.js`
4. `mobile_order_download_test.js`
5. `mobile_order_adjust_test.js`, somente se voce realmente quiser acionar ajuste real.

Avisos importantes:

- Preview consulta imagem e salva arquivo local em `app_mobile/tests/output/`.
- Aprovar altera o estado real do pedido.
- Download pode marcar o pedido como baixado.
- Ajuste consome/aciona o fluxo real de ajuste e deve ser usado com cuidado.
- Gerar Pix pode criar uma cobranca Pix real.
- Pagar com saldo pode consumir saldo real da conta.
- Suporte pode criar ou atualizar uma conversa real de suporte.
- Use um pedido de teste, nao um pedido de cliente real.

### Preview

Arquivo:

```text
mobile_order_preview_test.js
```

Comando:

```powershell
$env:API_BASE="https://ia4tube-api.onrender.com"
$env:TOKEN="COLE_O_JWT_AQUI"
$env:PEDIDO_ID="20260525_180819"
node app_mobile\tests\mobile_order_preview_test.js
```

Sucesso:

- HTTP `200`.
- `Content-Type` com `image/jpeg` ou `image/png`.
- Arquivo salvo em `app_mobile/tests/output/preview_<PEDIDO_ID>.jpg` ou `.png`.
- Tamanho em bytes maior que zero.

Erro:

- HTTP `404`: imagem ainda nao ficou pronta ou pedido nao encontrado.
- HTTP `401`: token invalido, embora o endpoint atual de preview nao dependa de token.
- Resposta JSON com `ok:false`.

### Aprovar pedido

Arquivo:

```text
mobile_order_approve_test.js
```

Comando:

```powershell
$env:API_BASE="https://ia4tube-api.onrender.com"
$env:TOKEN="COLE_O_JWT_AQUI"
$env:PEDIDO_ID="20260525_180819"
node app_mobile\tests\mobile_order_approve_test.js
```

Sucesso:

```json
{
  "ok": true,
  "aprovado_cliente": true,
  "pode_baixar": true
}
```

Cuidado:

- Este teste marca o pedido real como aprovado.

### Download do resultado

Arquivo:

```text
mobile_order_download_test.js
```

Comando:

```powershell
$env:API_BASE="https://ia4tube-api.onrender.com"
$env:TOKEN="COLE_O_JWT_AQUI"
$env:PEDIDO_ID="20260525_180819"
node app_mobile\tests\mobile_order_download_test.js
```

Sucesso:

- HTTP `200`.
- `Content-Type` com imagem.
- Arquivo salvo em `app_mobile/tests/output/download_<PEDIDO_ID>.png`.
- Tamanho em bytes maior que zero.

Erros comuns:

- HTTP `403`: pagamento pendente, previa nao aprovada ou conta automatica nao finalizada.
- HTTP `404`: resultado final nao existe.

Cuidado:

- Este teste pode marcar o pedido real como baixado.

### Solicitar ajuste

Arquivo:

```text
mobile_order_adjust_test.js
```

Comando:

```powershell
$env:API_BASE="https://ia4tube-api.onrender.com"
$env:TOKEN="COLE_O_JWT_AQUI"
$env:PEDIDO_ID="20260525_180819"
node app_mobile\tests\mobile_order_adjust_test.js
```

Payload enviado:

```json
{
  "motivo_ajuste": "Teste mobile: ajuste solicitado pelo simulador Android."
}
```

Sucesso com ajuste automatico:

```json
{
  "ok": true,
  "modo_humano": false,
  "status": "ajuste_pendente"
}
```

Sucesso encaminhado para suporte:

```json
{
  "ok": true,
  "modo_humano": true,
  "conversa_id": "..."
}
```

Cuidado:

- Este teste aciona o fluxo real de ajuste.
- Use somente em pedido descartavel.
- Se o pedido ainda nao usou ajuste automatico, ele pode voltar para `ajuste_pendente`.
- Se o ajuste ja foi usado, o teste pode abrir/atualizar conversa de suporte.

## Fluxos complementares Android V1

Estes testes validam fluxos complementares ao caminho principal ja validado.

### Gerar Pix do pedido

Arquivo:

```text
mobile_order_pix_test.js
```

Endpoint real usado:

```text
POST /pedidos/:id/gerar-pix
```

Comando:

```powershell
$env:API_BASE="https://ia4tube-api.onrender.com"
$env:TOKEN="COLE_O_JWT_AQUI"
$env:PEDIDO_ID="20260525_180819"
node app_mobile\tests\mobile_order_pix_test.js
```

Sucesso esperado quando o pedido tem pagamento pendente:

```json
{
  "ok": true,
  "pix_copia_cola": "...",
  "qr_code_base64": "...",
  "ticket_url": "...",
  "payment_id": "..."
}
```

Erros comuns:

- HTTP `400`: pedido ja liberado ou valor pendente invalido.
- HTTP `404`: pedido nao encontrado.
- HTTP `500`: Mercado Pago ou `MP_ACCESS_TOKEN`.

Cuidado:

- Pode gerar Pix real para pagamento.

### Pagar pedido com saldo

Arquivo:

```text
mobile_order_pay_with_balance_test.js
```

Endpoint real usado:

```text
POST /pedidos/:id/pagar-com-saldo
```

Comando:

```powershell
$env:API_BASE="https://ia4tube-api.onrender.com"
$env:TOKEN="COLE_O_JWT_AQUI"
$env:PEDIDO_ID="20260525_180819"
node app_mobile\tests\mobile_order_pay_with_balance_test.js
```

Sucesso esperado:

```json
{
  "ok": true,
  "pagamento_pendente": false
}
```

Ou, se ja estiver liberado:

```json
{
  "ok": true,
  "mensagem": "Pedido ja liberado.",
  "pagamento_pendente": false
}
```

Erros comuns:

- HTTP `403`: saldo insuficiente.
- HTTP `400`: valor pendente invalido.
- HTTP `404`: pedido ou cliente nao encontrado.

Cuidado:

- Pode consumir saldo real da conta.

### Suporte

Arquivo:

```text
mobile_support_test.js
```

Endpoints reais usados:

```text
GET /suporte/minhas-mensagens
POST /suporte/chat
GET /suporte/minhas-mensagens
```

Campos usados:

```json
{
  "mensagem": "Teste mobile: mensagem enviada pelo simulador Android."
}
```

Comando:

```powershell
$env:API_BASE="https://ia4tube-api.onrender.com"
$env:TOKEN="COLE_O_JWT_AQUI"
$env:SUPPORT_MESSAGE="Teste mobile: mensagem enviada pelo simulador Android."
node app_mobile\tests\mobile_support_test.js
```

Sucesso esperado:

- Primeira consulta retorna `ok=true`.
- Envio retorna `ok=true`, com `resposta`, `conversa_id` ou `modo_humano`.
- Segunda consulta retorna `ok=true` e mensagens/conversa atualizadas quando houver conversa aberta.

Cuidado:

- Pode criar ou atualizar conversa real de suporte.
- Use mensagem claramente identificada como teste.
