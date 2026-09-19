# iA4tube — adaptação focal SDK 36

19/09/2026. Candidato 44 / 0.2.31, mesmo `com.ia4tube.app`, assinatura existente e SDK mínimo 26. A versão 43 / 0.2.30 e suas evidências permanecem preservadas.

## Mudança delimitada

- `compileSdk` e `targetSdk`: 36.
- AGP 8.10.1, Gradle 8.11.1, SDK Build Tools 35.0.0, JDK 17.
- Kotlin e plugin Compose 2.2.21: matriz oficialmente compatível com AGP 8.10 / Gradle 8.11.1; a antiga linha 2.0.21 não documenta suporte integral a essa combinação.
- Wrapper alinhado ao Gradle realmente utilizado, com SHA-256 oficial da distribuição.
- Sem mudanças de telas, permissões, bibliotecas de produto, endpoints, assinatura, backend ou gates.

Referências: [requisito target 36 desde 31/08/2026](https://developer.android.com/google/play/requirements/target-sdk), [AGP 8.10](https://developer.android.com/build/releases/agp-8-10-0-release-notes), [matriz Kotlin](https://kotlinlang.org/docs/gradle-configure-project.html).

## Verificação e limites

Testes focais de calendário/importação/planejamento reexecutados pela mudança efetiva de compilador e SDK: 291 aprovados, sem falhas/erros/ignorados. Eles continuam provas locais de regressão, não execução física no Android 16. Os testes de navegação e o AAB final têm registro externo sanitizado em `outputs` do workspace.

O `NavHost` já recebe `innerPadding` do `Scaffold` e as telas utilizam `BackHandler` AndroidX. Não há defeito visual confirmado nesta adaptação. Conferir no A55: barras, teclado, retorno/cancelamento, seletor de arquivos, retomada, prévia com áudio e preservação do estado. Rotação/janela redimensionada e execução em ambiente de páginas 16 KB ainda não foram comprovadas. [Mudanças Android 16](https://developer.android.com/about/versions/16/behavior-changes-16).

## Bibliotecas nativas — não declarar compatibilidade completa

As oito bibliotecas existentes (graphics-path 1.0.1 e datastore 1.1.1, quatro ABIs) passam no alinhamento `PT_LOAD` de 16 KB, mas a verificação complementar `GNU_RELRO` não atende ao critério de término em múltiplo de 16 KB. Não é prova de falha observada no aparelho; impede afirmar compatibilidade completa de execução em 16 KB.

Leitura de dois artefatos oficiais, fora do build: DataStore 1.2.1 atende aos dois critérios; graphics-path 1.1.0 ainda não atende ao critério RELRO. Nenhuma dessas atualizações foi aplicada. A ampliação de dependências/recompilação AndroidX foi expressamente excluída desta etapa.

A [documentação oficial de páginas 16 KB](https://developer.android.com/guide/practices/page-sizes), consultada nesta data, informa bloqueio de atualizações incompatíveis a partir de 01/02/2027. Isso não dispensa verificar os avisos efetivos da Play nem substituir a conferência física. O aceite do upload, o SDK 36 ou a assinatura não equivalem a aprovação pública nem à aprovação Meta.
