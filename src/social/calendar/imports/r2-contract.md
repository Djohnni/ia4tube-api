# iA4tube — contrato local do adapter privado R2

Implementação local em 12/09/2026. Nenhuma conta, bucket, token, mídia real ou endpoint de nuvem foi usado nos testes. Não foi comprovada disponibilidade operacional do R2 nesta conta.

## Arquivos e fronteiras

- `r2-sdk-transport.js`: usa AWS SDK v3 e presigner oficiais, injetados pela composição do servidor. Constrói seu próprio S3Client com região auto, endpoint R2 canônico, forcePathStyle, uma única tentativa do SDK e timeout de metadados de 10 segundos. Não lê credenciais do ambiente nem aceita endpoint do usuário.
- `r2-provider.js`: vincula todas as operações ao contexto verificado de empresa/usuário e ao registro já reservado. Metadados privados ficam em `upload.r2`, sob a mesma transação/RLS de importação. Não recebe os bytes da mídia.
- `r2-inspection-worker.js`: executável exclusivo do worker. Lê o objeto completo em fluxo limitado, calcula SHA-256 dos bytes, exige consumo integral, chama decoder injetado e confere identidade ETag antes/depois. Precisa ser executado fora da API por dispatcher isolado com cota de computação, CPU/RAM/disco e deadline de 180 segundos.

Os testes usam um transporte de nuvem simulado, storage local e um dispatcher/decoder simulado explicitamente; não demonstram isolamento de um processo remoto. O presigner oficial foi exercitado de verdade, mas somente offline com credenciais sintéticas sem validade. Os headers assinados incluem tamanho exato, Content-MD5 e SHA-256 da parte.

## Interface usada pela API

Além das operações de upload anteriores, `authorizePart` aceita `{uploadId, partNumber, sha256, md5Base64}`. Os digests da parte são obrigatórios no R2 e opcionais apenas no adapter de memória de testes. Uma parte já autorizada não pode trocar os digests sob o mesmo upload; renovar autoriza os mesmos bytes/tamanho. Uma referência por parte evita acúmulo ilimitado de grants.

`resolvePart(context, {uploadId, partNumber, authorizationId})` retorna uma concessão temporária somente depois da verificação da mesma empresa/usuário e do estado aberto. Retorno: `{url, method:'PUT', headers, expiresAt, sizeBytes}`. A URL assinada é um segredo temporário de transporte: entregar apenas na resposta autenticada, com cache/logs de corpo e URL desativados; jamais gravar em banco, chat ou logs. Não incluir Authorization da API na requisição direta ao R2. Headers permitidos: content-length, content-md5, x-amz-checksum-sha256.

Todas as chamadas internas do upload-service repassam `args.context` construído a partir da identidade autenticada, não do corpo. Não manter um provider singleton preso à identidade de um usuário anterior. `getCapabilities()` expõe provider/origem e disponibilidade de configuração, não prova uma verificação real de bucket ou cloud smoke test.

## Idempotência e resultados incertos

O documento persistido registra intenção ANTES da chamada externa. `CreateMultipartUpload` não oferece o token de idempotência necessário para prometer exactly-once do fornecedor. Portanto, o adapter só faz uma tentativa de Create por registro. Perda de resposta ou crash reconcilia a chave opaca exata com ListMultipartUploads. Zero ou vários candidatos mantém a operação pendente para reconciliação; não cria outra cópia às cegas. Se o crash ocorreu antes da chamada, isso pode exigir ação operacional para sair do estado pendente. É uma limitação segura e explícita, não sucesso fabricado.

O manifesto verificado fica persistido antes de CompleteMultipartUpload. Repetições conservam o mesmo UploadId e a mesma lista de partes. Se a resposta se perder, HeadObject confirma a presença antes de seguir; a etapa seguinte ainda precisa verificar o SHA-256 dos bytes completos. Após selar, a retomada lê o manifesto persistido: não depende de ListParts continuar existindo no fornecedor. Nenhum caminho de PutObject/overwrite é exposto. A imutabilidade aqui é a regra do adapter para sua chave aleatória, não versionamento/Object Lock oferecido pelo R2 nem defesa contra um administrador externo com credenciais amplas.

Cancelamento só libera a reserva após confirmar aborto e ausência de objeto/upload. Uma criação ainda ambígua não é apresentada como abortada. Não apagar objeto concluído ou outro agendamento por este fluxo.

## Inspeção: job idempotente e metadados somente

O provider não executa GetObject nem decodificação na API. Requer um dispatcher interno com `capabilities: {isolated:true,bounded:true,remoteObjectInspection:true}`, `startInspection(request)` e `getInspection({context,ticketId})`.

`ticketId` é o objectVersion opaco já persistido. A intenção fica em `upload.r2.inspectionTicket` antes da primeira submissão. Depois de resposta incerta, o provider consulta somente esse ticket; não reenvia start nem inicia outra tarefa paga. O dispatcher também precisa impor unicidade persistente do ticket e reservar o orçamento de computação antes de executá-lo. Retorno rápido esperado: `{ticketId,state:'pending'|'ready'|'failed',result?}`. Pending mantém verifying; failed rejeita a mídia; ready precisa conter inspeção real dos bytes. Um ticket inexistente após submissão incerta permanece pendente, não se resolve com resubmissão automática.

O worker executa `execute(job)` com objectKey/etag/tamanho/digest/kind/deadline definidos internamente. Ele não aceita URL arbitrária, comando shell ou credencial Instagram. O dispatcher, a fila durável/cota compartilhada de inspeção e preparo e o isolamento físico são integrações separadas; este helper não constitui um serviço implantado. Não interpretar limites por tarefa como teto garantido de uma fatura.

## Fontes oficiais consultadas

- [Cloudflare — compatibilidade S3](https://developers.cloudflare.com/r2/api/s3/api/): multipart/partes, checksums e diferenças de capacidade; SHA-256 é composto no R2, não digest integral do objeto. O adapter não usa ETag multipart como SHA-256.
- [Cloudflare — URLs temporárias](https://developers.cloudflare.com/r2/api/s3/presigned-urls/): operação/objeto/expiração delimitados; uma URL é reutilizável até expirar e deve ser tratada como bearer secret.
- [AWS — CreateMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateMultipartUpload.html) e [UploadPart](https://docs.aws.amazon.com/AmazonS3/latest/API/API_UploadPart.html): comandos e campos do protocolo utilizados pelo SDK.

## Prova local e pendências de integração

Foram exercitados localmente: assinatura oficial, isolamento, grants expirados, hashes remotos ausentes/divergentes, bloqueio de overwrite, retomada após Create/Complete incertos, cancelamento confirmado, inspeção sem consumir bytes, resposta perdida de dispatcher e ausência de redispatch pago. O conjunto upload + R2 passou 36 testes na primeira integração; alterações focais posteriores devem usar a última execução registrada pelo executor.

Antes de habilitar em nuvem: confirmar bucket privado e permissões mínimas, origem/CORS e checksums multipart suportados de fato, provisionar dispatcher/inspector/cota autorizados, conferir schema/RLS persistente e executar smoke test autorizado contra o fornecedor. Sem isso, não anunciar upload/preparo remoto funcionando. Não relaxar checksums nem tornar o bucket público para contornar incompatibilidade.
