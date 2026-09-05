# Android oficial — vínculo estável de publicação

Checkpoint local de 05/09/2026. Implementação e artefato preparados; não é
aprovação de ativação, distribuição, funcionamento live ou App Review.

## Origem e integração exata

- Aplicativo oficial `com.ia4tube.app`, mantido em `versionCode 31` /
  `versionName 0.2.19`. O AAB 31 anterior foi preservado, sem substituição.
- Fonte de partida: `e11f4a66ae41dbcbbe7d2b9a6d2fb667e70cb0be`, em worktree
  separado `work/android-production-binding`, branch
  `feat/android-production-binding-20260905`.
- A nova implementação altera somente 12 arquivos Instagram nessa fonte:
  oito arquivos de produção e quatro testes. Não altera novamente FCM,
  SessionStore, origem oficial da API, fluxo de arte, permissões ou versão.
- O Android do candidato unificado `a619eb422bdcb92c24b1498cc5cecc63df7a3169`
  era anterior a essa base oficial. Por isso a integração completa apresenta
  **47 caminhos A/M (13 modificados e 34 adicionados)**, não 47 novas mudanças
  Instagram. As alterações anteriores de FCM e demais funcionalidades são
  herdadas de e11 e preservadas integralmente, não reimplementadas nesta missão.
- Antes da cópia, o Android do candidato não tinha alterações locais nem
  arquivos não rastreados. Foram recusados destinos extras ou ignorados que
  pudessem ser sobrescritos. Cópia mecânica dos bytes, sem normalização, sem
  exclusão, sem stage/commit, sem tocar no backend ou em arquivos ignorados.
- Conferidos **176 arquivos**: inventário rastreado da fonte versus união de
  rastreados e novos arquivos Android no candidato. Conjuntos de caminhos e
  conteúdo SHA-256 idênticos; 47 arquivos precisaram de cópia. Configuração
  Firebase ignorada, chaves, propriedades privadas, caches e artefatos de build
  não foram transferidos para o candidato.

Digest do manifesto Android, igual na fonte assinada e no candidato integrado:

`20027C862643619CE27AEFD7DA568C4D6C438F591B39C0BD5FA7C7EACECA4AEF`

Este é um **digest de conteúdo da árvore**, não um commit Git. Algoritmo:
ordenar ordinalmente os caminhos relativos `app_mobile/android/...`; para cada
arquivo acrescentar UTF-8 de `caminho`, NUL, SHA-256 hexadecimal maiúsculo de
seus bytes, LF; obter SHA-256 do texto concatenado. Ignorados não participam.
O helper de assinatura fixa esse digest, a base e11, o caminho exato da fonte
e o hash da configuração Firebase copiada do checkout oficial para o build.

## Contrato implementado

- A conexão recebida deve fornecer `externalId` e `connectionRevision` no topo
  do objeto, além do `connectionId`. Revisão deve ser inteiro positivo seguro;
  conta conectada sem identidade estável não libera publicação.
- Nova intenção persistida em formato v3 guarda o snapshot original desses
  três campos antes do primeiro POST. UUID, mídia, vínculo e confirmação
  monotônica não podem ser substituídos por uma atualização do registro.
- Publish e reconcile enviam `expectedConnectionId`, `expectedExternalId` e
  `expectedConnectionRevision` originais. A consulta anterior ao reconcile é
  somente auxiliar à interface: a verificação atômica final cabe ao servidor.
- Resposta perdida é consultada por GET de
  `/v1/social/reviewer/publication-intents/:clientRequestId`. A publicação só
  pode ser identificada se vínculo, conexão e mídia corresponderem à intenção
  original. Não há associação por legenda ou coincidência no histórico.
- Resposta nula, erro de consulta ou resultado incerto preserva a intenção e
  bloqueia novo UUID/envio. Refresh e retomada do aplicativo nunca chamam POST.
- Continuação identificada exige confirmação explícita, mesmo vínculo e
  estado elegível. Um conflito do servidor não adota a conta atual nem repete
  a publicação. Mudança de conta/revisão bloqueia a continuação antiga.
- Registros v1/v2 continuam legíveis sem receber identidade/revisão da conta
  atual. Podem manter histórico conhecido, mas não autorizam continuação.
- Permanecem a sessão oficial IA4Tube, origem de produção fixa, ausência de
  fallback staging, ausência de credenciais de revisor no app, redirects
  recusados no cliente e abertura externa apenas de URLs aprovadas.

Arquivos alterados frente a e11, dentro de `feature/instagram`:

- Produção: `AndroidInstagramPublicationIntentStore.kt`,
  `InstagramApiClient.kt`, `InstagramModels.kt`, `InstagramPolicies.kt`,
  `InstagramPublicationIntentStore.kt`, `InstagramScreen.kt`,
  `InstagramUiState.kt`, `InstagramViewModel.kt`.
- Testes: `InstagramApiClientTest.kt`, `InstagramIntentPolicyTest.kt`,
  `InstagramUiStateTest.kt`, `InstagramViewModelTest.kt`.

## Validação do snapshot final

Ambiente existente JDK 17 / Gradle 8.9 / Android SDK, sem nova instalação.
No worktree Android, executadas conjuntamente:
`:app:testDebugUnitTest :app:assembleDebug :app:lintDebug :app:compileReleaseKotlin`.

- Rodada final: **BUILD SUCCESSFUL, 4min08s, 70 tarefas** (15 executadas e
  55 atuais). A primeira rodada completa também passou; foi removida somente
  uma condição redundante indicada pelo compilador, antes da rodada final.
- XML final: **17 suítes, 149 testes**, zero falhas, erros ou ignorados;
  timestamps `2026-09-05T19:05:12` a `2026-09-05T19:05:14` UTC.
- Composição: 65 testes Instagram, 3 de backup e 81 anteriores. Este é um
  snapshot único: não se soma aos 136 da versão anterior nem aos testes Node.
- Lint: **106 warnings, 6 information, 0 errors**, mesmo total anterior.
  O aviso Kotlin antigo de `OrderDetailScreen` e o aviso de versão de XML do
  SDK permanecem; nenhum aviso novo Instagram permaneceu.
- Testes usam gateways sintéticos e servidor HTTP de loopback. Não houve
  chamada ao backend live, OAuth, geração ou publicação real.
- `git diff --check`: PASS. Nenhuma alteração fora Android no worktree da
  fonte assinada.

## AAB assinado e preservação

Artefato novo no diretório de entregas do workspace:

`outputs/IA4Tube_0.2.19_31_production_binding_20027c862643.aab`

- **12.976.777 bytes**.
- SHA-256:
  `5529388D0BA7DEB4D11760299E399FC53A365834F41A506FCCFF87857466D821`.
- `:app:bundleRelease`: sucesso em 1min, 49 tarefas (33 executadas/16 atuais).
  Novo helper local `SafeAndroidProductionBindingRelease.java` separado do
  original; exige snapshot/caminho/configuração/certificado fixados. Referências
  privadas lidas somente em memória, disponibilizadas apenas ao ambiente do
  subprocesso. Saída filtrada; nenhum segredo em código, argumentos ou relatório.
- Fonte novamente igual ao digest aprovado após o build; cópia da entrega
  idêntica ao resultado, criada sem sobrescrever destino existente.
- Bundletool oficial 1.17.1: estrutura PASS, pacote `com.ia4tube.app`,
  versão `0.2.19`, código `31`, `debuggable` ausente (padrão falso).
- Verificador JDK independente leu integralmente as 514 entradas de conteúdo:
  digest/assinatura JAR PASS, um assinante de upload esperado em cada entrada.
- Certificado público original de upload SHA-256:
  `AC1B12E013EC3B6C91A925189295C007459CB02B6D491960CEB0E6E1D1B4366D`.

Artefato anterior preservado:

`outputs/IA4Tube_0.2.19_31_release.aab`

SHA-256 reconfirmado sem alteração:
`47B36E24A415937D9E5FD80138524B739A20D7F3FC521C73C9DCE17B058EC010`.
O checkout `work/android-official-instagram` continua limpo na base e11.

## Limites do fechamento

Sem commit/push nesta integração, deploy, upload Play, instalação no A55,
limpeza de dados, login real, OAuth ou publicação. Não houve nova consulta à
Play para reavaliar versões: 31 foi mantida conforme a orientação de preservar
a versão preparada e ainda não enviada no checkpoint anterior.

Assinatura de upload não é assinatura do APK instalado via Play e não autoriza
substituí-lo diretamente. Compilação/testes locais não provam comportamento
no aparelho nem aceite pela Meta. A ativação do backend, operação real e
distribuição continuam dependendo das etapas e autorizações próprias.
