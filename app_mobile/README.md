# IA4Tube Mobile

Este diretorio prepara o inicio do app Android oficial da IA4Tube dentro do mesmo repositorio do site e da API atual.

O app mobile sera Android nativo, construido futuramente com Kotlin e Jetpack Compose. Ele nao sera WebView, nao sera PWA empacotado e nao deve substituir o site atual. A primeira meta e organizar a arquitetura, documentar os contratos existentes e preparar a IA4Tube para operar como plataforma com multiplos clientes: site web, app Android e possiveis apps futuros.

## Principios

- O site atual continua funcionando como esta.
- O backend atual em `server.js` continua sendo a fonte da API.
- O app Android deve consumir a API por HTTP, usando JSON e multipart/form-data conforme cada endpoint.
- Mudancas futuras na API devem ser aditivas e compativeis com o `app.html`.
- Dados, pedidos, imagens, scripts e automacoes existentes nao devem ser movidos para esta pasta.

## Estado atual

Esta pasta contem documentacao inicial e o primeiro projeto Android base em `android/`.

O projeto Android inicial contem Splash, Login e Home simples. Ele ainda nao contem criacao de pedido, upload, Pix, suporte ou download.

## Documentos

- `docs/VISAO_GERAL.md`: visao do produto mobile e limites desta etapa.
- `docs/API_ATUAL.md`: mapa inicial dos endpoints atuais do `server.js`.
- `docs/CONTRATOS_DA_API.md`: padroes iniciais de requests, responses, autenticacao e uploads.
- `docs/IA4TUBE_CORE_API.md`: contrato tecnico detalhado do comportamento atual da Core API.
- `docs/MOBILE_CONTRACT_V1.md`: contrato mobile V1 para o Android consumir a API sem depender do `app.html`.
- `docs/ANDROID_ARCHITECTURE_V1.md`: arquitetura Android V1 antes da criacao do projeto Android Studio.
- `docs/ROADMAP_ANDROID.md`: fases sugeridas para evoluir ate o app Android nativo.
- `docs/RISCOS_E_COMPATIBILIDADE.md`: cuidados para nao quebrar o site atual.

## Proxima etapa recomendada

Abrir `app_mobile/android/` no Android Studio e validar o primeiro fluxo: Splash -> Login -> Home com `/auth/login` e `/me`.
