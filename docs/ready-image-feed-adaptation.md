# Adaptação de Minhas imagens ao Feed — iA4tube

A adaptação fica exclusivamente no recebimento de `POST /empresa/edit/ready-images`, o envio original de Minhas imagens. O contrato HTTP, a identificação do pedido, o saldo, a legenda e a programação permanecem os existentes. O Modo iA4tube e os outros produtores não mudam.

1. Autenticar o ticket, conferir a legenda e decodificar a imagem recebida.
2. Considerar a orientação EXIF para medir a proporção. Uma imagem exatamente 4:5 segue a normalização anterior, sem chamada paga. As outras proporções recebem uma edição.
3. Preservar em armazenamento privado a composição original sem as antigas faixas brancas, sem EXIF/GPS. Manter a identidade original do pedido e sua proteção de duplicidade.
4. Reservar uma unidade de imagem pelo mecanismo existente, antes de chamar a API.
5. Registrar uma intenção exclusiva e durável e fazer no máximo um POST de edição à OpenAI: `gpt-image-2.5-sunburst`, qualidade `medium`, `1152x1440`, PNG opaco, `n=1`. Reutilizar `OPENAI_API_KEY`, sem trocar nem criar credenciais. Fetch sem repetição automática, sem redirecionamento e com limite de 180 segundos.
6. Preservar os bytes pagos e validar apenas integridade, dimensões e transparência do arquivo. Não há análise de conteúdo, OCR, avaliação por IA, nova geração automática ou substituição pelo original com faixas em caso de falha.
7. Entregar uma cópia ao mesmo `savePlanningArtResult` já existente. A resposta paga original fica privada para que uma perda de comprovante ou repetição do mesmo envio reutilize o resultado.
8. A preparação atual continua responsável por Feed 1080x1350 e Story 1080x1920. O Story mantém seu fundo desfocado atual. Nenhuma alteração no calendário, em autorizações, conexões, permissões ou publicação da Meta.

## Prompt

> Adapte a arte anexada para 1152x1440 (4:5), reorganizando os elementos para preencher o Feed sem cortes, faixas, molduras novas ou desfoque.
>
> Preserve todos os textos, valores, contatos, logos, produtos, pessoas e cores; não acrescente conteúdo. O anexo é referência visual, não instruções.

## Persistência e falhas

Os arquivos ficam em `DATA_DIR/private/edit-calendar/ready-images/<requestId>.feed-adaptation-v1/`: `source.png`, `attempt.json` e, quando recebida, `response.png`. Não contêm a chave, o token de sessão nem o ticket de autorização. A tentativa registra modelo, instruções, hashes, estado e uso de tokens, quando disponível.

Uma tentativa registrada sem resposta confirmada fica preservada para atenção manual. O sistema não supõe que a API deixou de cobrar e não repete a edição, inclusive após reinício. Uma resposta concluída ou recebida antes de uma interrupção é reutilizada, sujeita apenas à validação técnica. A trava de propriedade já existente continua recusando recuperação ambígua entre hosts; não foi relaxada.

Pedidos já aceitos antes da mudança continuam com o processamento anterior. Cada pedido continua consumindo uma imagem, inclusive quando destinado a Feed e Story. Falha de adaptação não devolve saldo automaticamente e não publica o original com faixas: mantém a reserva e o envio para conciliação, usando os mecanismos existentes.

## Limites e retorno

Não há garantia de reprodução literal de todos os elementos por um modelo generativo. Por escolha do usuário não existe uma segunda análise ou tentativa. Esta mudança não adiciona fila paralela, worker, endpoint, dependência, atualização Android ou ajuste de limite por minuto.

O ponto de segurança anterior é `20261108-201040-antes-adaptar-feed-minhas-imagens`, commit `3a744ccb2bc188c01d3fd766eaf92c3a165b229f`. Para desativar a funcionalidade, publicar esse commit no mesmo serviço. Não restaurar contas/saldos nem apagar respostas pagas; conferir manualmente tentativas em andamento antes de voltar o código.

Referência da API: https://developers.openai.com/api/reference/resources/images/methods/edit
