# iA4tube — dois ambientes de testes locais

Este diretório contém somente o manifesto sintético dos testes de interface. Não pertence a
nenhum source set de runtime, APK instalável, AAB ou configuração de assinatura.

## Navegação sem recursos do aplicativo

Executar as provas de navegação com `-Pia4tubeLocalIsolatedTests=true` e selecionar as classes
`InstagramNavigationRetentionTest` e `PlannedArtsNavigationTest`. Seus guards originais permanecem
intactos: nenhum `com/android/tools/test_config.properties`, `android.app.Application`, pacote
`org.robolectric.default` e nenhum provider. Não usar o modo UI nessa execução.

## Interface com recursos, mas sem inicialização do produto

Executar `:app:testDebugUnitTest -Pia4tubeLocalUiResources=true --offline --console=plain`,
selecionando explicitamente as classes de interface/unidades desejadas e
`br.com.ia4tube.app.testinfra.LocalUiResourceIsolationTest`. As duas classes de navegação acima
devem ser executadas separadamente; nenhuma classe é excluída automaticamente pelo build.

Primeiro executar somente `LocalUiResourceIsolationTest` como preflight. As duas provas devem
passar antes da rodada de interface. O modo padrão do build não é alterado e não equivale a esta
prova isolada. Informar ambos os modos simultaneamente é um erro de configuração.

O Robolectric 4.14.1 usa o manifesto binário do APK de recursos da infraestrutura de testes;
`@Config(manifest = Config.NONE)` sozinho não o substitui quando o AGP fornece `test_config`.
Por isso, `prepareLocalUiResourceFixture` usa o `aapt2` já instalado para compilar este manifesto
e cria um novo contêiner **somente de recursos** em `app/build/local-ui-resource-fixture`.
Ele preserva `resources.arsc` e `res/` e substitui o manifesto binário por este manifesto vazio.
Não copia código, DEX, assets, bibliotecas nativas, assinatura ou componentes do produto.
O pacote é mantido apenas para compatibilidade com os IDs compilados de recursos.

Antes de iniciar a JVM de testes, a tarefa substitui exatamente o diretório de configuração
gerado pelo AGP por um diretório privado da fixture. A configuração e todos os arquivos da
fixture são inputs da tarefa. As provas exigem uma única configuração visível, recursos Compose
acessíveis, `android.app.Application` e ausência de providers, serviços, receivers, atividades,
permissões, metadados e app component factory. Nenhum guard de navegação é removido ou relaxado.

O APK de recursos de entrada, manifestos do produto e artefatos assinados existentes são apenas
preservados. Esta fixture não pode ser instalada ou enviada à Play. Não há dispositivo, login,
OAuth, publicação, rede externa, alteração de backend ou instalação de ferramentas nesta prova.
