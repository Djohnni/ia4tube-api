# IA4Tube Android

Projeto Android nativo inicial da IA4Tube.

## Estado atual

Esta primeira versao contem:

- Kotlin.
- Jetpack Compose.
- Material 3.
- Navegacao Compose.
- Navegacao inferior nas telas principais: Inicio, Criar e Pedidos.
- Icone launcher adaptativo minimo para testes internos.
- Splash visual minimo com identidade IA4Tube.
- Icones Material na navegacao inferior.
- Splash simples.
- Login manual simples.
- Home simples.
- Perfil da Empresa local para preencher automaticamente dados da criacao.
- Atalhos de status na Home com resumo de pedidos em producao, artes prontas e pagamentos pendentes.
- Criacao minima de pedido `arte_empresa` com logo obrigatorio usando `POST /pedidos`.
- Otimizacao local do logo antes do upload: dimensao maxima 1600px, qualidade 85 inicial e alvo abaixo de 2 MB.
- Fotos do negocio opcionais no campo multipart `fotos`, com limite inicial de 5 imagens otimizadas localmente.
- Referencias visuais opcionais no campo multipart `referencias`, com limite inicial de 5 imagens otimizadas localmente.
- Revisao final antes de criar o pedido real de `arte_empresa`.
- Indicador de envio na revisao final para uploads com imagens.
- Meus Pedidos usando `GET /meus-pedidos`.
- Atualizacao manual e gesto de puxar para atualizar em Meus Pedidos.
- Filtros locais em Meus Pedidos: todos, em producao, artes prontas e pagamento pendente.
- Filtros visuais em chips selecionaveis na tela Meus Pedidos.
- Badges visuais nos cards de Meus Pedidos para producao, pronto, pagamento pendente e erro.
- Detalhe simples do pedido usando `GET /pedidos/:id/info`.
- Polling automatico no detalhe a cada 5 segundos enquanto `imagem_pronta=false`.
- Acao manual "Atualizar agora" no detalhe do pedido.
- Preview somente leitura usando `GET /pedidos/:id/preview`.
- Aprovar pedido usando `POST /pedidos/:id/aprovar`.
- Download do resultado usando `GET /pedidos/:id/download-resultado`.
- Solicitacao de ajuste usando `POST /pedidos/:id/solicitar-ajuste`.
- Pagamento pendente via backend usando `GET /pedidos/:id/pagamento-info`, `POST /pedidos/:id/gerar-pix` e `POST /pedidos/:id/pagar-com-saldo`.
- API base padrao `https://ia4tube-api.onrender.com`.
- Chamada inicial para `/auth/login`.
- Chamada inicial para `/me`.
- Suporte usando `GET /suporte/minhas-mensagens` e `POST /suporte/chat`.
- Token de sessao protegido com Android Keystore.
- `android:allowBackup="false"` para reduzir risco de backup de dados locais sensiveis.

Ainda nao contem:

- Campos dinamicos avancados de criacao.
- Camera.
- Push notification.

## Como abrir

Abra no Android Studio a pasta:

```text
app_mobile/android
```

Nao abra a raiz Node do projeto como projeto Android.

## Observacao de Play Store

O app ja possui base visual minima para testes internos, mas o icone e o splash ainda sao provisórios.

Antes de publicar:

- Substituir `ic_launcher_foreground.xml` e `splash_logo.xml` pela arte oficial da marca.
- Configurar assinatura release.
- Criar politica de privacidade.
- Preencher Data Safety no Play Console.
