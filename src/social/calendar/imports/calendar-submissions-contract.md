# Entrada direta no calendário iA4tube

Selecionar foto, vídeo ou arte existente e escolher formato/áudio produz uma solicitação durável. Não há confirmação visual obrigatória. A revisão do arquivo permanece disponível no mesmo calendário e a exclusão cancela sua programação futura.

`scheduling.directSubmission:true` anuncia o contrato. `POST /assets/:assetId/calendar-submissions` recebe `uploadId,idempotencyKey,expectedMediaRevision,selection,caption?`; `selection` conserva o contrato de preparo. Não recebe `confirmed`, hash da prévia, objeto privado, identidade ou autorização do cliente. `GET /assets/:assetId/calendar-submissions/by-key/:key` recupera o resultado sem iniciar trabalho. O prefixo é `/v1/social/calendar/imports`, com a mesma autenticação e admissão das importações.

Resposta: `{ok:true,submission:{id,assetId,uploadId,idempotencyKey,state,calendarItemId,mediaRevision,date,time,caption,errorCode,notice?}}`. O ID é hex40 e será o mesmo ID final do calendário. Estados: `accepted`, `preparing`, `scheduled`, `attention`, `cancelled`. O aviso de conclusão tem ID estável e aponta ao calendário; não envia FCM. Campos não informados por padrão são `calendarItemId:null`, `mediaRevision:0`, `caption:""`, `errorCode:null`.

A aceitação é gravada antes de solicitar preparo, na mesma transação que reserva a data. O padrão é amanhã às 09:00 em America/Sao_Paulo; cada colisão avança um dia. Uma cópia de arte existente herda a legenda quando omitida e usa a data/horário original como preferência quando ainda futura, avançando se ocupada. O original não é substituído. A conclusão reavalia datas vencidas/ocupadas e nunca cria horário passado.

O loop de progresso existente avança o pedido, inclusive após reinício. Uma revisão pronta ou em preparo com a mesma seleção é reaproveitada; outras seleções criam nova revisão com chave persistente. Repetições, concorrência e perda de resposta mantêm a mesma solicitação e o mesmo registro. Editar, pausar ou cancelar posteriormente não é desfeito por recuperação/repetição. Uma pendência pode ser cancelada no calendário enquanto ainda não existe arquivo final.

A delegação HMAC possui propósito próprio, proprietário, hash canônico do pedido e limite temporal. Não é um JWT fabricado nem autorização de publicação. A transformação em autorização de publicação exige a preferência e conexão originalmente vinculadas ainda válidas, sem renovação automática do prazo. Gates fechados não impedem salvar o item nem o pausam permanentemente; continuam impedindo qualquer publicação. Uma preferência revogada não é reativada.

Revisão, seleção, SHA da origem, objetos imutáveis e digest dos derivados continuam verificados no servidor. A preparação inspeciona os bytes reais, e o publicador volta a verificá-los antes do envio. O campo técnico `previewDigest` permanece interno a esse vínculo de integridade; não significa que o usuário visualizou ou aprovou uma prévia.

O processamento continua sujeito à configuração e janela do executor já existente. Expirar a admissão do piloto conserva leitura e permite apenas o progresso já aceito dentro da janela de conclusão. Retirar a configuração de importações em um reinício conserva a projeção dos registros no calendário, mas os bytes privados exigem o runtime de leitura configurado. Esta implementação não abre gates, provisiona executor, implanta código ou publica conteúdo.
