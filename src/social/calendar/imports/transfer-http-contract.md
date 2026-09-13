# iA4tube — composição local de transferência privada

## O que existe

`createRenderDiskTransferService` liga upload autenticado, registro de autorização
opaca, store da empresa, política de elegibilidade e o provider de disco. A factory
é desativada por padrão; adapters voláteis exigem opção explícita de teste.
`createCalendarImportByteRouter` recebe bytes em fluxo, sem JSON, decoder, Sharp,
FFmpeg, upload a outro serviço ou publicação. Nenhum módulo é montado automaticamente
na aplicação atual. `readyForProduction` continua `false`.

O cenário local integrado usa sessões assinadas sintéticas, transferências HTTP
loopback reais, arquivos temporários e adapters de armazenamento reais. A inspeção
remota não é simulada como sucesso: receber bytes deixa `uploading`, nunca
`ready`, `scheduled` ou `published`.

## Composição futura e ordem obrigatória

1. Preparar/verificar os stores de empresa e de autorizações com suas identidades
   restritas; validar o diretório privado e a reserva global. Exigir a mesma
   instância de `diskSpaceGuard` na capacidade e na admissão, com
   `requireDiskSpaceEvidence:true`: a observação local de espaço livre é conferida
   dentro da reserva atômica. A margem provisória de 1 GiB e a contagem conservadora
   precisam adequação ao ambiente real; esse controle não é uma quota do sistema
   operacional nem um teto financeiro. Ver `disk-space-guard-contract.md`.
2. Criar o provider, a política confiável do piloto e o transfer service. Só o
   processo servidor pode fornecer esses objetos; não usar configuração do HTTP.
3. Na fachada de metadados existente, substituir somente `upload` por
   `transfer.wrapUpload(upload)`. Isso intercepta `resolvePart`, confere o grant
   exato e registra sua vinculação antes de devolver a URL ao usuário autenticado.
4. Montar o byte router em `/v1/social/calendar/imports/bytes`, **antes** dos body
   parsers e do router de metadados. O byte router não usa cookies ou JWT de sessão:
   a autorização curta e opaca é a credencial restrita para uma parte exata.
5. Configurar logs da aplicação/proxy para não registrar o grant. O helper
   `redactImportTransferUrl` sanitiza URLs desse caminho, incluindo parâmetros.
   O módulo não emite logs; isso não comprova a configuração do proxy Render.
6. Validar limites de conexão/tempo e a topologia real antes de ativar. Nada nesta
   composição autoriza contratação, novos gates ou montagem em produção.

O limite atual de entrada é **por processo**: duas transferências/consultas de
grant simultâneas, uma por empresa, sem fila escondida; máximo configurável quatro.
Ele é compartilhado quando a mesma instância de limiter é usada, não é uma cota
global distribuída entre processos ou réplicas. Verificar execução única real ou
substituir pela admissão distribuída antes de expandir. Não confundir esse limiter
com as reservas globais duráveis de espaço/processamento já implementadas.

O endpoint é para Android nativo e consumo web na mesma origem. Não foi criada
uma interface web nova nem um fluxo de preflight para aplicações em outra origem.
O host não deve habilitar CORS amplo nem credenciais de navegador nesta rota.

## Protocolo e segurança

- `PUT /v1/social/calendar/imports/bytes/<UUIDv4>` exato, minúsculo, sem parâmetros,
  barras finais, caminhos extras ou redirecionamento.
- Origem do grant emitido: somente `https://ia4tube-api.onrender.com`, porta HTTPS
  padrão. Não aceitar qualquer hostname terminado em `onrender.com`.
- `Content-Type: application/octet-stream`; comprimento explícito entre 1 byte
  e 5 MiB, MD5 e SHA-256 em base64 canônica, todos iguais à autorização persistida.
  Recusar codificação/chunked, intervalos, trailer, corpo já analisado e campos
  repetidos de comprimento/checksum/tipo. O próprio servidor HTTP deve manter suas
  proteções contra framing ambíguo.
- Cookies, Authorization, Proxy-Authorization, origem não permitida e navegação
  cross-site são recusados. A URL já é uma credencial curta: não a expor em logs,
  analytics, capturas, histórico ou mensagem de erro.
- A resolução consulta diretamente o hash da autorização no registro dedicado;
  nunca recebe empresa ou usuário da requisição de bytes nem varre tabelas de
  clientes para descobrir o proprietário.
- Antes de receber e de confirmar bytes, o servidor reconfirma empresa, usuário,
  asset, provider upload, parte, hashes, tamanho, vencimento, estado atual do
  upload e autorização atual. Renovar a parte invalida o grant anterior mesmo
  enquanto seu registro ainda existe.
- Elegibilidade é reconferida por bloco e imediatamente antes de instalar arquivos;
  um callback assíncrono confiável reconfirma registro e vinculação em pontos de
  commit. Nenhum callback ou prova é aceito do corpo HTTP.

Registro revogado durante a transferência é detectado antes do próximo commit
verificado. Isso não é rollback de um arquivo já instalado antes da revogação ser
observada. Se parte imutável foi gravada mas a confirmação falhou, os bytes e a
reserva são mantidos; a retomada consulta o mesmo upload e seu hash. Não publicar,
excluir o original ou criar outra importação para resolver resultado incerto.

O prazo padrão total é 30 segundos, máximo configurável 60, desde a entrada da
requisição: inclui consulta ao registro e à empresa. O recebimento ganha apenas
o tempo restante. O timeout fecha a conexão e impede despacho tardio de escritor.
Uma consulta ou escritor ainda não encerrado **não** libera seu slot só porque
o cliente desconectou; seu término real libera o slot. Configurar também timeouts
finitos do pool/conexões reais, pois fechar um socket HTTP não cancela uma consulta
de banco travada. Não há repetição automática de POST/PUT nesta camada.

## Recuperação e limites ainda pendentes

O provider já recupera a janela inicial de diretório/identidade ausente mediante
estado inicial persistido, reserva comprovada, diretório vazio e lock exclusivo
novo. Arquivos desconhecidos, originais, recibos parciais e locks anteriores não
são removidos por tempo/PID. A recuperação geral após queda de processo, incluindo
um lock abandonado e recibos pendentes, ainda precisa procedimento seguro com
escritor encerrado. Não declarar recuperação completa de qualquer queda.

Antes do uso remoto faltam: configuração de processos/logs/proxy/pools; aplicação
autorizada das migrations candidatas; espaço físico de segurança e política de
retenção; limitação de tráfego; ligação ao executor isolado e suas filas; integração
das telas; prova Linux/runtime; validação na Play/A55 e autorização de publicação.
O teto financeiro real exigido não foi comprovado. Quotas da aplicação não são
um bloqueio contratual de cobrança.

## Provas locais deste módulo

`tests/calendar-import-transfer-http.test.js` comprova emissão por sessão assinada,
envio HTTP e replay idêntico após reconstrução do serviço; dois tamanhos de partes,
retomada pelo estado físico; recusa de corpo alterado, headers, caminhos, credenciais
e origem indevidos; autorizações vencidas, revogadas, substituídas ou inexistentes;
elegibilidade revogada; limites de concorrência sem fila; falha de registro sem
exposição prematura; interrupção do socket; revogação entre blocos; timeout em lookup
e recusa de início tardio; validação do estado de disco na fronteira do store.

As provas não acessam produção, A55, conta Meta ou arquivo de cliente. Não são um
teste de capacidade de 100 clientes nem prova de fatura máxima.
