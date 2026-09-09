# Cópia privada das artes recebidas no Android

Implementação local iniciada em 2026-09-08, sobre `ec231a2ab0f6ff1b6b042ec9a81743509011be85`. Não é uma nova versão distribuída.

## Comportamento

- Na primeira leitura completa de uma imagem pelas telas de resultado do pedido, resultados mensais, calendário ou galeria, o aplicativo guarda automaticamente uma cópia privada. Não é necessário tocar em Salvar.
- Ao visualizar novamente a mesma representação, a cópia aparece enquanto o aplicativo confere sua validade. Quando o servidor responde `304` ao ETag/Last-Modified, o corpo da imagem não é transferido novamente. Se a imagem mudou ou não há um validador utilizável, uma nova resposta completa pode ser necessária.
- Abrir a tela novamente, retomar o aplicativo, usar Atualizar ou receber uma alteração pertinente do pedido/calendário permite reconferência. Tempo decorrido e recomposições da tela não introduzem downloads periódicos. A correção anterior de espera de até 60 segundos e remoção do ciclo de 15 segundos permanece.
- Legenda, horário, estado da programação e disponibilidade operacional continuam dependendo dos dados atuais do servidor; uma imagem salva não autoriza edição ou publicação.
- Se a internet falha e existe uma cópia válida, a tela informa `Cópia salva • sem atualização confirmada`. Negação de acesso ou remoção (`401/403/404`) descarta a cópia e retira seus pixels da tela. Falha real de decodificação também descarta a entrada, sem ciclo automático de tentativas.

## Identidade e preservação

O identificador do arquivo é o SHA-256 da sessão e da URL exata, incluindo a versão na consulta. Nenhuma URL ou credencial em texto aberto é usada como nome de arquivo. O modelo de produção atualmente associa o proprietário à sua empresa; trocar a sessão invalida a interface e limpa somente este armazenamento privado. Uma futura seleção de várias empresas dentro do mesmo token exigirá identidade de empresa adicional explícita.

As representações não são intercambiáveis:

- `/pedidos/{id}/preview` pode conter marca d'água conforme a situação do pedido;
- `/pedidos/{id}/thumbnail?v=...` pode representar a arte original;
- `/v1/social/calendar/items/{id}/image` entrega o JPEG preparado para o Instagram.

Cada uma é guardada separadamente. Não reutilizamos uma imagem sem marca d'água para contornar pagamento nem o JPEG preparado como se fosse o original. A primeira visualização de uma representação diferente ainda pode transferir aquela imagem uma vez.

O fluxo `/download-resultado` não é antecipado nem usado pelo cache: ele registra uma operação de download no servidor. Exportação, compartilhamento, criação, cobrança e publicação não foram alterados. Também não foi criado serviço de download em segundo plano; se o app estiver fechado, ele não recebe os bytes da arte até uma leitura já prevista pelo fluxo existente.

## Proteção e limites

- Diretório privado `cacheDir/private_art_v1`, resolvido a partir do diretório canônico do aplicativo, sem armazenamento público ou acesso pela galeria do telefone.
- AES-256-GCM com chave própria no Android Keystore e identidade da entrada autenticada. Sem alternativa de gravação em texto aberto se a proteção falhar.
- Limite de 96 MiB ou 256 entradas, o que ocorrer primeiro; até 20 MiB por imagem. Escrita temporária criptografada, substituição atômica quando disponível, remoção dos menos usados e rejeição de caminhos/links inesperados.
- Imagens completas, tipo permitido e dimensões limitadas são conferidos antes da persistência. Dados incompletos/corrompidos não são assumidos como válidos.
- Requisições para os caminhos oficiais permitidos usam a sessão legítima, sem redirecionamento ou relaxamento de TLS. Pré-visualizações HTTPS externas existentes não recebem credencial IA4Tube e não entram no cache privado.
- Logout, troca de sessão e invalidação de tela impedem reaproveitar pixels ou resultados atrasados do usuário anterior. A verificação local de expiração do token não substitui a autenticação do servidor.
- A cópia pode aparecer antes de a conferência remota terminar; revogação remota só é conhecida após a resposta. As rotas legadas de preview/thumbnail não fornecem a mesma garantia de autorização por objeto que a rota autenticada da galeria. A proteção local não altera essa limitação do backend.
- O Android pode liberar cache por falta de espaço. Ao atingir o limite, sair da conta ou limpar o cache, será necessário baixar novamente. Os originais no servidor não são apagados. Esta cópia é uma otimização, não um backup permanente.
- Memória/arquivos globais antigos de outros recursos não são reutilizados pelo novo componente; não apagamos caches de vídeos, marketing, exportações ou arquivos do usuário.

## Verificação

Os testes locais usam imagens sintéticas, servidor HTTP de loopback e criptografia de teste. Cobrem persistência, limites, corrupção, sessões, respostas condicionais, falhas, concorrência e pixels realmente decodificados por Compose/Coil. O histórico anterior de testes permanece no documento do calendário. O resultado final desta execução está no registro da entrega.

Conclusão em 2026-09-09: 182 casos selecionados em 13 suítes; 181 passaram, zero falhas/erros e um ignorado (`ownedSymlinkDoesNotReadOrDeleteItsTarget`, criação de link simbólico não disponível no Windows desta execução). Não alteramos proteções do Windows para executar esse caso. As quatro suítes novas somam 48 casos, dos quais 47 passaram e esse único caso foi ignorado. Os seis testes reais de renderização passaram; o harness foi ajustado para desenhar a tela antes de esperar a falha de decodificação, preservando a exigência de um único descarte e nenhuma repetição de download.

Compilação debug Kotlin e `git diff --check` concluídos. Aviso preexistente de condição sempre verdadeira em `OrderDetailScreen.kt` não foi tratado nesta mudança. Não houve recompilação release, commit, push ou distribuição.

Seleção final executada com as dependências já disponíveis, sem instalação:

```text
:app:testDebugUnitTest --offline --console=plain -Pkotlin.incremental=false
--tests '*PrivateArt*Test' --tests '*Calendar*Test' --tests '*MonthlyPlanning*'
--tests '*Order*Test' --tests '*PreviewUrlBuilderTest'
--tests '*InstagramNavigationRetentionTest' --tests '*InstagramUiStateTest'
--tests '*InstagramViewModelTest'
```

Uma prova local com cifrador de teste não comprova o funcionamento da chave no Keystore do A55. Ainda é necessária a futura distribuição interna autorizada e uma conferência no telefone: receber uma arte existente, fechar/reabrir, observar reutilização, alterar a sessão pelo fluxo normal e verificar ausência de imagem antiga. Não gerar outra arte paga nem executar Instagram para provar o cache.

Nenhum backend, gate, original, credencial, AAB existente, faixa Play ou formulário Meta foi alterado por esta implementação.
