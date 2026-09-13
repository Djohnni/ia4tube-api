# iA4tube — inspeção local de fonte selada em disco

Implementação local de inspeção real, sem publicação, credenciais ou chamada de
nuvem. O resultado confirma uma fonte decodificada; ele não aprova distribuição,
não cria preview público e não declara a plataforma pronta para produção.

## API e admissão

createDiskBoundedInspectionWorker recebe provider, workingDirectory, ffmpegPath,
assertExecutionHeld e clocks opcionais. Seu método inspect recebe o task do
dispatcher com providerType render_disk, proprietário, IDs de upload/asset/ticket,
chave/digest/token da execução, objectKey/objectVersion, hash/tamanho, tipo da
mídia e prazo de 180 segundos. Campos extras, caminhos, URLs e ETag são recusados.

assertExecutionHeld recebe task, snapshotBytes e maxRuntimeMs. Essa função,
configurada pelo coordenador confiável, deve confirmar a reserva real do
snapshot, o orçamento de computação e a execução autorizada, vinculados ao
proprietário e ao token. Seu retorno deve ser exatamente true. É chamada antes
de criar arquivos, antes de cada etapa de decode e antes de retornar. Não é
um booleano do corpo HTTP nem reserva automática fornecida pelo decoder.

A composição precisa reservar o snapshot além do storage já retido pelo upload.
Somente após o worker terminar e a limpeza ser verificada o coordenador pode
liquidar a computação e liberar a reserva temporária. O worker não modifica
contas, ledger de capacidade ou decisões de publicação.

## Bytes, formatos e limites

O provider fornece streamSealedObject com verificação da fonte selada. O worker
copia blocos de no máximo 64 KiB para seu próprio diretório .inspect-*, recalcula
SHA-256 e exige tamanho/hash exatos. O caminho original não é recebido nem
exposto. Imagens têm até 32 MiB/25 milhões de pixels; vídeos têm até 100 MiB,
60 segundos e 4096 pixels por dimensão, limitados também a 8.294.400 pixels.

PNG, JPEG e WebP são reconhecidos pela assinatura e inspecionados por Sharp.
Após metadata, o worker consome o raster inteiro decodificado, limitado a RGB
uchar (até 75 MB), com deadline do decoder. Imagens animadas são recusadas.
Metadata sozinha nunca produz decoded verdadeiro.

MP4/MOV passam por probe e decode completos reais de FFmpeg. O piloto permite
H.264 SDR, com áudio compatível ou sem áudio. Exige dimensões, duração e término
de decode coerentes; HEVC/HDR e streams inesperados são recusados. FFmpeg roda
sem shell, com ambiente mínimo, protocolos/formato permitidos explicitamente,
referências externas desabilitadas, duas threads, limite por alocação,
saída de logs limitada e prazo remanescente compartilhado.

Existe no máximo uma inspeção simultânea por instância. O orçamento monotônico
é compartilhado entre snapshot e etapas do decoder. Isso não constitui sandbox
do sistema operacional: Sharp roda neste worker local e os limites cooperativos
não substituem isolamento de CPU/RAM/processo em produção.

As capabilities declaram deadlineMode cooperative e hardTermination false.
Um await pendente de filesystem, transferência local ou admissão não é
forçosamente terminável pelo relógio JavaScript. Ultrapassar o prazo não prova
que a operação terminou e não autoriza devolver seu slot ou reserva. Ao voltar
a executar, o worker reconfere o prazo e recusa prosseguir. Somente seu término
efetivamente observado, seguido da limpeza verificada, permite liquidação.
Essa limitação aguarda um executor isolado pelo sistema operacional; não é
resolvida por Promise.race ou por cancelamento presumido.

## Resultado e recuperação

O resultado vincula provider, proprietário, ticket, objeto/versão e digest de
execução às dimensões, formato, hash e tamanho realmente observados. Vídeo
também registra duração, presença de áudio e SDR comprovado. Erros descartam
stderr, metadata arbitrária e caminhos, devolvendo somente códigos seguros.

O worker remove apenas seu diretório gerado, após verificar root, caminho,
ausência de links e conjunto exato de arquivos. Fonte selada, variantes
anteriores, arquivos desconhecidos e outras empresas não são alvos de limpeza.

createLocalDiskInspectionRunnerForTests registra intenção e resultado no ticket
da fixture volátil, preservando dispatchKey/executionDigest/fencing. Após
resposta perdida, lookup recupera o resultado sem chamar o decoder de novo.
Esse adapter é exclusivamente local: não alega persistência após perda da
fixture, isolamento do processo ou serviço remoto disponível.

## Prova local

Os testes executam upload de bytes, selo, dispatcher, admissão global,
snapshot e decode reais de uma PNG sintética e de um MP4 H.264/AAC de um segundo.
Também verificam resposta perdida sem nova computação, hash alterado, imagem
truncada, proprietário errado, marca de adapter copiada, admissão ausente,
quota e limpeza física do snapshot. Os 17 testes existentes do dispatcher R2
continuam passando. Não é um benchmark de capacidade, migração ou implantação.
