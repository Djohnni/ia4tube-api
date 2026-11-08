# Proteção de login da iA4tube

A proteção é aplicada somente em `POST /auth/login`, antes da leitura das contas e da comparação de senha. Não altera hashes, cadastros, sessões, produção, integração do Instagram ou calendário. Não há alteração na política de tamanho das senhas existentes.

Cinco falhas na mesma conta em uma janela de 15 minutos geram uma espera de um minuto. Reincidências geram cinco e depois 15 minutos; o limite nunca é permanente. Requisições durante a espera não prorrogam o prazo. Após 24 horas sem falhas, a progressão expira. Uma senha válida após a espera limpa as falhas da conta.

Há também uma proteção por origem: 30 falhas contra quaisquer contas em 15 minutos geram 15 minutos de espera naquela origem. Um acerto não apaga o histórico da origem. Não existe contador global que bloqueie todos os clientes.

O retorno durante a espera é HTTP 429, com `Retry-After`, `code=login_rate_limited` e mensagem em português já compatível com a apresentação de erros do app atual. Sessões existentes não passam por esse filtro.

## Armazenamento e execução

Os contadores ficam em `DATA_DIR/security/login-attempts-v1.json`, separados de `clientes.json`. Identificadores são HMACs; a senha, o login e o IP em texto não são gravados nesse arquivo. A chave HMAC é derivada em uso da chave de sessão já existente, sem trocar essa chave ou emitir credenciais novas.

O arquivo tem limites de tamanho e quantidade, prazo de expiração e gravação por substituição atômica com sincronização em disco. Corrupção ou falha de acesso recusa somente novas autenticações com erro temporário 503; não altera contas, não zera evidências e não afeta sessões existentes.

Esta implementação atende ao serviço Render atual: `node server.js`, um processo Node e disco persistente exclusivo em `/var/data`. As transações de contagem são síncronas e não contêm `await`, de modo que requisições concorrentes desse processo não perdem incrementos. Não se deve passar a executar cluster, vários processos ou várias instâncias com este armazenamento: esse cenário exige substituir o armazenamento por um serviço transacional compartilhado. Não existe fallback silencioso para contagem em memória.

## Origem confiável

A configuração global de proxies do servidor permanece inalterada. Apenas o login usa uma interpretação própria: em conexão direta ignora cabeçalhos de origem; no ambiente Render com par interno, percorre a cadeia da direita para a esquerda, removendo proxies internos e faixas oficiais da Cloudflare até a primeira origem não confiável. Prefixos inventados pelo visitante e `CF-Connecting-IP` enviado por ele não definem a chave. As faixas da Cloudflare foram verificadas em 08/11/2026.

## Validação e reversão

Os testes incluem concorrência HTTP com o manipulador real do login, preservação de senha antiga de três caracteres, liberação após o prazo, reinício, troca de IP, aliases do login, isolamento de contas, limitação por origem, arquivo inválido, capacidade e preservação da sessão existente.

Uma reversão de código usa o commit anterior no mesmo serviço. Não restaurar `clientes.json`, não trocar chaves e não limpar sessões. O arquivo de contadores é independente e pode permanecer preservado quando o código anterior for restaurado.

Esta mudança não aumenta o mínimo das senhas nem modifica cadastros ou os outros caminhos de autenticação. Essas melhorias continuam separadas da proteção de tentativas aqui implementada.
