# Legenda iA4tube em Minhas imagens

Opção voluntária por foto, disponível no envio original e no Modo iA4tube. Desativada por padrão, preserva a legenda manual anterior. Ativada, o campo aceita uma orientação e hashtags ou pode ficar vazio. A imagem e a orientação são enviadas à OpenAI para produzir a legenda final.

A etapa ocorre antes dos envios existentes. O site pede a legenda em `POST /empresa/edit/ready-images/caption`, usando o mesmo ticket nativo e o mesmo número do pedido. Depois envia o texto final pelo contrato anterior: `caption` no original; `imageCaption` no Modo iA4tube. Não há mudança no recebedor, produtor local, gravação de resultado, calendário ou Meta.

O endpoint exige `Authorization: EditTicket`, valida a conta antes de receber o arquivo e aceita somente `requestId`, `ticket`, `guidance` e uma imagem. Não aceita dados de outra conta ou programação pelo formulário. A origem é a mesma API já utilizada pelo app. A chave permanece no servidor. Não há chave nova nem atualização Android.

O modelo é `gpt-4.1-mini`, já utilizado pelo sistema para texto, pela Responses API com entrada de imagem, `store=false`, até 700 tokens de saída e prazo de 90 segundos. O pedido solicita português, uma legenda específica e natural, preservação das orientações e hashtags, sem inventar preços, ofertas, ingredientes ou contatos. Não acrescenta assinatura iA4tube às legendas de outros negócios.

As hashtags fornecidas são preservadas por uma verificação textual simples e acréscimo das que faltarem, sem uma segunda chamada à IA. O limite final continua sendo 2.200 caracteres. Não há avaliação visual ou repetição automática.

Antes da primeira chamada é conferida a existência de saldo de imagem. A assistência não reserva nem debita uma arte extra; o envio real continua consumindo sua única unidade pelo mecanismo existente. Assim como outros recursos de assistência, o cliente pode obter a legenda e não concluir o envio, sem consumir uma unidade de imagem.

A chamada é registrada antes do POST em `DATA_DIR/private/edit-calendar/image-captions/<requestId>.json`. A imagem reduzida, sem EXIF, fica no mesmo diretório. A identidade inclui imagem e orientação. Uma confirmação perdida reutiliza a mesma legenda, inclusive depois que a produção já foi admitida ou o saldo acabou. Texto, foto ou escolha de modo de legenda diferentes não substituem uma tentativa incerta. Uma falha sem resposta confirmada é preservada para atenção, sem criar outra legenda automaticamente.

As legendas manuais mantêm os mesmos campos, hashes e chamadas anteriores. Os modelos de geração de imagem e vídeo não foram trocados. A adaptação de formato do envio original e a composição do Modo iA4tube continuam com seus códigos anteriores.

Ponto anterior: `20261109-110524-antes-legenda-ia4tube-minhas-imagens`. Backend anterior: `56510f4e37e7c8f2981bdf8fe243cd8beb795156`; site anterior: `53c0a673a824ce2b07eb144e199eca63ea3d53a1`.

Para voltar, publicar primeiro o site anterior, preservando contas, dados e legendas já enviadas; só então retirar o endpoint do backend se não houver tentativa em andamento. Não restaurar clientes, saldos, calendários, chaves ou permissões.

Documentação de imagem + texto: https://developers.openai.com/api/docs/guides/images-vision?api-mode=responses
