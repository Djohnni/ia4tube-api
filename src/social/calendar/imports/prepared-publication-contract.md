# iA4tube — publicação de derivados no calendário existente

Contrato candidato local, 13/09/2026. Não ativa gates, transporte, conta, deploy ou migração remota. `readyForProduction` permanece falso; música sintética não equivale a catálogo comercial autorizado.

## Superfície operacional

`createOperationalCalendarImportService` (em `local-calendar-service.js`) usa a mesma mutação `schedulePreparedImport` e o mesmo `owner_state.jobs` do calendário. Exige `createCalendarStore` genuína, os grants compartilhados do calendário, política de acesso, fila e result store genuína. Origens de artes copiadas e intenções/recibos de cópia ficam no mesmo documento PostgreSQL, com até 1.000 intenções e orçamento existente de 8 MiB. Não cria outro calendário, pedido ou crédito de geração. Inicialização permanece explicitamente desabilitada por padrão.

`createPreparedCalendarMedia` recebe essa store, fila, result store, política, grants, resolvedor de conexão e segredo/origem privados. O publisher transforma apenas um `ConnectorContext` genuíno validado em contexto de importação autenticado. O corpo de uma requisição não fornece a empresa ou o usuário.

`createProductionCalendar` aceita opcionalmente a factory genuína `createOperationalCalendarImportsRuntimeFactory`. Ausência ou factory desabilitada preserva imports indisponíveis; uma função/objeto copiado ou factory de transporte local é recusada no compositor de produção. O runtime confere as stores genuínas PostgreSQL de calendário/upload, política, result store, transferência opaca e verificações reais de schema antes do callback adicional de prontidão. Esse callback deve conferir o disco e a fronteira de execução da configuração escolhida; um boolean de capacidade não substitui as verificações. Nenhuma migração é executada na inicialização.

O compositor compartilha exatamente store/grants/mídia com o calendário antigo e entrega a fachada de metadados, transferência, prévia e programação. O host monta bytes antes dos parsers e prévia antes do 404 de metadados; a montagem social também já precede o parser JSON global. Principais de sessão legítimos são associados por WeakMap ao contexto interno; consulta de conexão após início usa grant verificado, nunca JWT inventado. Fechar o calendário fecha as chaves de mídia do runtime. A factory não recebe credenciais Instagram, inicia FFmpeg ou cria timer de execução; a configuração do piloto precisa fornecer a fronteira de processamento separadamente supervisionada, não instalá-la por acidente na API de 512 MiB.

Antes de criar container, o adaptador confere o registro durável, grant, conta/revisão da conexão, identidade do usuário, revisão da mídia, resultRef, previewDigest, referências imutáveis e metadados do destino. Reconfere por leitura/hash os bytes de todas as variantes e da miniatura contra o certificado de decode completo do commit. Não converte ou decodifica vídeo em GET de calendário, tick ou leitura de prévia. Uma prévia privada válida pode continuar existindo sem ser publicável: disponibilidade e confirmação operacionais recusam vídeo fora de 3–60 segundos ou acima de 100.000.000 bytes; JPEG operacional é limitado conservadoramente a 8.000.000 bytes.

## Mesmo motor, intenção e resultados independentes

O registry acrescenta a capacidade tipada `publishPreparedMedia`; o serviço e o adaptador preservam o MIME real JPEG/MP4. A operação persistente e sua auditoria continuam com o nome histórico `publishImage`, deliberadamente, reutilizando o mesmo hash v2, registro, CAS e claims de estágio. Esse nome de operação não converte MP4 em JPEG e não exige acrescentar enum/schema de operação. Legenda vazia só é aceita no namespace preparado; Feed/Reel continuam exigindo legenda no agendamento.

Cada destino tem intenção e resultado próprios. O digest preparado liga empresa, usuário, item, revisão da mídia, resultado, destino, referências/hash/tamanho/metadados, áudio, legenda e `shareToFeed`. A revisão editável do calendário continua protegida por CAS; não entra novamente no hash após a própria gravação da intenção incrementá-la.

O fluxo real é `/media` → consulta do container → `/media_publish` → confirmação do ID retornado. Os claims são persistidos antes do I/O e o transporte nunca roda numa transação. Resultado desconhecido de criação não gera outro container; resultado desconhecido de publicação não repete o POST. Um ID conhecido permite leitura/reconciliação exata, não busca por legenda. Story confirmado pode não fornecer permalink; nenhum link é inventado. Reel exige `media_product_type=REELS`; Story exige `STORY`.

Para preparados há uma consulta imediata de status e, se necessário, no máximo quatro observações automáticas posteriores, separadas por pelo menos 60 segundos, com reserva dessa observação no registro do destino. A reserva sobrevive a concorrência/reinício. Esgotar observações deixa a intenção incerta visível e requer conferência operacional; não a transforma em falha conhecida nem autoriza reenvio. JPEG legado mantém seu comportamento anterior. Um destino confirmado nunca é repetido para compensar o outro.

## Entrega ao provedor não é a prévia do revisor

URL canônica exclusiva de entrega:

`https://ia4tube-api.onrender.com/v1/social/calendar/media/prepared/<company>/<scheduleId>/<target>/<publicationId>/<metadataDigest>/<expires>/<signature>`

HMAC com chave derivada separadamente liga os campos completos, inclusive o digest imutável. Expiração máxima de 900 segundos; assinatura conferida antes de consultar a empresa no PostgreSQL. O adaptador não persiste a URL nem a envia aos seus logs; isso não comprova exclusão dos logs de proxy, plataforma, provedor ou transporte externo injetado. Não aceita URL arbitrária, query, token de sessão, caminho do disco ou URL privada de revisão como origem.

GET/HEAD suportam uma faixa de bytes, arquivo limitado e blocos de 64 KiB, backpressure, deadline de 60 segundos e limite de duas transferências nesta instância. A entrega reconfere registro/grant/conexão e elegibilidade; arquivos modificados não são substituídos pelo original. Nenhuma reconversão é executada. É uma URL bearer temporária necessária para a coleta pela Meta, não um endpoint público permanente nem promessa de revogação de bytes já recebidos pelo provedor. Deploy/piloto precisam excluir esse caminho de access logs que incluam URLs e confirmar comportamento Range/HEAD/timeout no Render.

## Documentação oficial consultada

Consulta somente leitura em 13/09/2026. O guia atual foi obtido diretamente do domínio oficial por HTTPS (HTTP 200) depois de o mecanismo de busca falhar. A worktree permanece em **Graph v25.0**; os exemplos atuais do guia já mostram v26.0, portanto não são prova de migração do projeto.

- [Instagram API with Instagram Login — Content Publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing): host `graph.instagram.com`, Instagram User access token, `instagram_business_basic` e `instagram_business_content_publish`; upload por `image_url`/`video_url` acessível ao provedor; criação e publicação de container; estados de processamento e recomendação de consulta aproximadamente a cada minuto, até cinco minutos. Não foram copiados Facebook Login ou permissões adicionais.
- [Referência oficial IG User /media, vinculada pelo guia de Instagram Login](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media): JPEG, `STORIES`, `REELS`, `video_url`; Story MP4/MOV de 3–60 s e até 100 MB; `share_to_feed` é parâmetro do próprio Reel. `true` permite distribuição em Feed e Reels, sem garantir posicionamento algorítmico e sem criar terceira publicação. A referência comum contém exemplos de outro login; somente parâmetros de mídia aplicáveis foram aproveitados. O projeto mantém perfil conservador de vídeo até 60 s/100.000.000 bytes também para Reel.
- [Graph API v25.0 changelog](https://developers.facebook.com/docs/graph-api/changelog/version25.0): versão lançada em 18/02/2026; a página consultada não anuncia mudança desse fluxo de publicação. Compatibilidade real da conta na versão configurada ainda requer o piloto autorizado.

O perfil preparado existente produz H.264 progressivo, 30 fps, SDR/BT.709, MP4 com metadados no início e AAC quando há áudio. As restrições específicas do arquivo são conferidas por processamento/inspeção; metadados declarados pelo cliente não substituem decode real. Limites e documentação consultados não substituem um envio real à Meta.

## Fronteira de prova

`publication-test-transport.js` fornece somente a marca explícita de composição de teste: exige uma função de transporte, aceita os endpoints Graph v25 previstos e nunca faz fallback para `fetch`. Respostas e tokens sintéticos são definidos exclusivamente nos testes. O adaptador produtivo continua implementando o protocolo real com o transporte habitual, gates e autorização existentes; não contém motor de simulação ou resultado de sucesso sintético.

Testes focais com SQL double são diagnóstico do protocolo, não prova de durabilidade. A prova principal deve usar o helper PostgreSQL efêmero, migrations reais e processamento separado reais e preservar seu resultado/teardown individualmente. Permanecem separados: implementado; testado localmente com processo/persistência reais; provedor controlado; pendente de Render; pendente de A55; pendente de publicação real. Arquivo Flow definitivo, condições de uso e incorporação autorizada permanecem pendentes; nenhum catálogo alternativo é contratado.
