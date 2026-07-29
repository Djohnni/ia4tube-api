# Rotação do cofre social — Checkpoint 2B-0

Este procedimento é administrativo. Ele não deve registrar material de
chave, versões completas, fingerprints ou credenciais em logs e relatórios.

## Identidade e convergência

- Cada versão operacional usa `v<geração>_<digest-base64url>`.
- O digest é derivado do material AES-256; portanto, duas chaves diferentes
  não podem compartilhar legitimamente a mesma versão.
- `SOCIAL_VAULT_EXPECTED_KEYRING_FINGERPRINT` identifica publicamente o
  conjunto ordenado de versões legíveis e a versão ativa. Web Service e job
  administrativo devem receber exatamente o mesmo fingerprint esperado.
- A aplicação falha antes de abrir o cofre quando material, versão, conjunto
  legível ou versão ativa divergem.

## Sequência obrigatória

0. Antes do próximo deploy, rotacionar o deploy hook que foi exposto, conforme
   o plano controlado abaixo. Esta é uma ação externa pendente e não faz parte
   da execução local deste checkpoint.
1. Gerar a nova chave fora de logs e derivar sua versão com o helper oficial.
2. Executar `node scripts/social-vault-key-rotate.js prepare`, com aprovação
   exata `PREPARE_SOCIAL_VAULT:<environmentId>`, para registrar
   administrativamente a nova versão como legível sem ativá-la. O registro
   deve estar confirmado antes de qualquer instância ou job poder selecionar
   a nova chave como ativa.
3. Preparar o keyring de pré-carregamento contendo a chave antiga e a nova,
   ainda com a antiga ativa, e calcular o fingerprint correspondente.
4. Fazer o rolling deploy do keyring de pré-carregamento. Durante essa janela,
   instâncias antigas podem conhecer somente a chave antiga, enquanto as novas
   já conhecem ambas; todas devem continuar cifrando exclusivamente com a
   antiga.
5. Drenar as instâncias antigas e confirmar que todas as instâncias e jobs
   ativos estão saudáveis, usam o keyring antigo+novo, mantêm a chave antiga
   ativa e aprovam o fingerprint esperado. A comprovação deve expor somente
   estados booleanos.
6. Suspender temporariamente as escritas de credenciais sociais ou realizar
   um corte blue/green equivalente. Enquanto coexistirem escritores com
   chaves ativas diferentes, o backfill não pode começar e a escrita não pode
   permanecer liberada.
7. Ativar administrativamente a nova versão e, na mesma janela controlada,
   trocar a versão ativa e o fingerprint esperado de todas as instâncias e
   jobs. Drenar qualquer escritor que ainda esteja ativo na versão anterior.
8. Liberar as escritas somente depois de comprovar que a autoridade global e
   todas as instâncias concordam com a nova geração ativa, que o material
   corresponde à versão e que ambas as chaves continuam legíveis.
9. Rotacionar as credenciais por empresa, permitindo retomada idempotente de
   lotes parciais.
10. Confirmar contagem zero de referências à versão anterior em todas as
    empresas, inclusive credenciais revogadas ou expiradas, e repetir essa
    verificação depois de uma janela sem escritores antigos.
11. Aposentar administrativamente a versão anterior. A FK deve impedir esta
    etapa enquanto existir qualquer referência.
12. Somente depois da aposentadoria comprovada, remover o material antigo do
    keyring de todas as instâncias e configurar o fingerprint final.

## Janela mista e gates

- A janela mista de pré-carregamento é segura somente porque todos os
  escritores mantêm a chave antiga ativa. Nenhum registro pode ser cifrado com
  a nova chave nessa fase.
- O fingerprint de cada processo deve corresponder à configuração imutável da
  própria versão implantada. A convergência só é aprovada quando não restar
  processo antigo e todos os processos ativos aprovarem o fingerprint do
  keyring antigo+novo.
- A janela mista de ativação não é uma janela normal de operação. Escritas de
  credenciais devem permanecer suspensas até autoridade, Web Service e jobs
  convergirem para a nova geração ativa.
- Falha de registro, fingerprint, material, saúde, autoridade, isolamento ou
  drenagem interrompe o avanço. Não se deve iniciar o backfill, aposentar a
  chave antiga nem liberar escritas.
- Os gates e relatórios devem mostrar apenas aprovação/reprovação, geração,
  estados e contagens; nunca material, versão completa, fingerprint ou
  credenciais.

## Executor administrativo

O executor permanente é `scripts/social-vault-key-rotate.js`. Ele aceita
somente:

```text
node scripts/social-vault-key-rotate.js inventory
node scripts/social-vault-key-rotate.js prepare
node scripts/social-vault-key-rotate.js rotate
node scripts/social-vault-key-rotate.js rotate --retire-previous
```

URLs, senhas, chaves, versões e fingerprints nunca são argumentos. O processo
administrativo recebe somente no próprio ambiente:

- `SOCIAL_VAULT_ROTATION_ACTIVE_KEY_VERSION`
- `SOCIAL_VAULT_ROTATION_APPROVAL`
- `SOCIAL_VAULT_ROTATION_BATCH_SIZE`
- `SOCIAL_VAULT_ROTATION_DATABASE_CA_BASE64`
- `SOCIAL_VAULT_ROTATION_ENVIRONMENT`
- `SOCIAL_VAULT_ROTATION_EXPECTED_CURRENT_KEY_VERSION`
- `SOCIAL_VAULT_ROTATION_EXPECTED_ENVIRONMENT_ID`
- `SOCIAL_VAULT_ROTATION_EXPECTED_KEYRING_FINGERPRINT`
- `SOCIAL_VAULT_ROTATION_EXPECTED_MIGRATION_LOGIN`
- `SOCIAL_VAULT_ROTATION_EXPECTED_RUNTIME_LOGIN`
- `SOCIAL_VAULT_ROTATION_EXPECTED_TARGET_FINGERPRINT`
- `SOCIAL_VAULT_ROTATION_IDENTITY_DERIVATION_VERSION`
- `SOCIAL_VAULT_ROTATION_KEYS_JSON`
- `SOCIAL_VAULT_ROTATION_MIGRATIONS_DATABASE_URL`
- `SOCIAL_VAULT_ROTATION_PRODUCTION_APPROVAL`, somente em produção
- `SOCIAL_VAULT_ROTATION_RETIRE_KEY_VERSION`, somente na retirada
- `SOCIAL_VAULT_ROTATION_RUNTIME_DATABASE_URL`

O modo `prepare` exige a aprovação exata
`PREPARE_SOCIAL_VAULT:<environmentId>`. Seu keyring administrativo contém a
chave atual e a nova, e aponta a nova como alvo somente dentro desse processo
isolado. Ele registra a versão alvo de forma idempotente, mas não ativa essa
versão, não abre o inventário e não altera nenhuma credencial. O resultado
expõe apenas se o registro foi novo; uma segunda execução segura retorna
`registered=false`.

Os demais modos exigem, respectivamente,
`INVENTORY_SOCIAL_VAULT:<environmentId>`,
`ROTATE_SOCIAL_VAULT:<environmentId>` ou
`ROTATE_AND_RETIRE_SOCIAL_VAULT:<environmentId>`. Em produção, tanto
`prepare` quanto `rotate` também mantêm a segunda aprovação de produção
obrigatória.

Todas as variáveis com prefixo `SOCIAL_VAULT_ROTATION_` são recusadas pelo
Web Service, inclusive as que não contêm segredo. O executor usa LOGIN de
migration e LOGIN de runtime separados e confirma ambiente, alvo, logins,
migrations, roles, RLS, keyring e autoridade antes de alterar qualquer linha.

O inventário global é paginado por `(company_id, credential_id)` sob uma
policy `SELECT` owner-only criada e removida na mesma transação. O
processamento posterior volta ao repository de runtime e ocorre empresa por
empresa sob RLS. A retomada não depende de arquivo local: o `key_version`
persistido é o checkpoint idempotente. Depois de cada execução, o catálogo
deve comprovar ausência da policy transitória
`social_credentials_key_rotation_inventory`.

A saída permite apenas estados booleanos e contagens. Qualquer falha produz
um código genérico; IDs, URLs, versões de chave, fingerprints e detalhes de
exceção não são impressos. O lote padrão é 100 e o máximo aceito é 250.

## Emergência: suspeita ou confirmação de chave comprometida

Este procedimento é diferente da rotação preventiva. A prioridade é conter
novas exposições sem destruir a capacidade de investigar ou recuperar dados.
Ele exige uma janela controlada e não pode ser tratado como uma troca
automática de variável.

1. Bloquear imediatamente novas escritas de credenciais sociais e impedir
   novos processos, filas ou jobs de iniciarem com o keyring suspeito.
2. Preservar a leitura da chave antiga somente no menor conjunto de processos
   isolados necessário para investigação e recriptografia. Não reativar
   publicação, refresh ou uso externo de tokens durante essa janela.
3. Registrar o incidente, delimitar período, ambientes, empresas e registros
   potencialmente afetados e preservar evidências e logs já redigidos. Nunca
   copiar material de chave, plaintext, tokens ou versões completas para o
   relatório.
4. Gerar material novo em custódia independente, registrar primeiro sua
   versão como legível e validar material, fingerprint, autoridade e backup
   antes de ativá-la.
5. Fazer corte coordenado, com pausa de escrita ou blue/green, ativar a nova
   geração e comprovar que nenhum escritor antigo permanece. A autoridade
   global do registro não é consultada em cada escrita pelo runtime atual;
   portanto, este procedimento não promete zero downtime.
6. Recriptografar de forma idempotente todos os registros afetados, com
   contagens por estado e isolamento por empresa. Manter a chave antiga
   disponível apenas para leitura até a contagem global de referências chegar
   a zero e ser confirmada novamente.
7. Quando o conteúdo protegido incluir tokens ou credenciais que possam ter
   sido expostos, revogar e renovar também os tokens no provedor upstream,
   conforme a API permitir. Recriptografar um token comprometido não o torna
   seguro novamente.
8. Produzir um backup lógico criptografado do estado de recuperação, validar
   o roundtrip e restaurá-lo em banco novo e isolado. Reexecutar RLS A/B,
   autenticação, integridade do cofre, idempotência, compatibilidade e ausência
   de plaintext antes de qualquer retomada.
9. Aposentar a versão comprometida somente após referência global zero,
   revogação upstream aplicável, investigação encerrada e gates de backup e
   restauração aprovados. Uma falha em qualquer gate mantém escrita e
   publicação bloqueadas.
10. Liberar gradualmente a operação, monitorar erros de descriptografia,
    reautenticação e uso indevido, e documentar ações corretivas sem expor
    segredos.

A rotação normal também exige ao menos uma pausa curta de escrita ou um corte
blue/green durante a mudança da autoridade ativa. Enquanto o runtime não
validar essa autoridade global em cada operação de escrita, não há garantia
técnica de rotação sem indisponibilidade.

## Deploy hook exposto

A rotação do deploy hook é obrigatória antes do próximo deploy, mas não está
autorizada nem foi executada neste checkpoint. A ação controlada deve:

1. inventariar, sem revelar o hook, cada automação que ainda o utiliza;
2. criar ou regenerar o substituto somente no serviço correto;
3. atualizar os consumidores autorizados por canal seguro;
4. validar o novo hook no staging sem alterar produção;
5. revogar o hook exposto e confirmar que ele deixou de funcionar; e
6. registrar apenas estados e horários, sem URL, token ou fragmentos.

Se a plataforma não oferecer coexistência temporária entre os hooks, a troca
deve ocorrer em uma janela coordenada com rollback definido. Até essa rotação
ser concluída, qualquer deploy adicional permanece bloqueado.

## Falha e rollback

- Antes da aposentadoria, restaurar o conjunto antigo+novo e seu fingerprint
  permite retomar a rotação sem reescrever credenciais já concluídas.
- Depois da aposentadoria, a versão antiga não pode ser reativada. Um rollback
  que dependa dela exige restauração integral e comprovada do banco e da
  configuração para o mesmo checkpoint.
- Divergência de fingerprint, material, autoridade, FK, saúde ou isolamento
  interrompe a sequência; não se deve forçar a ativação nem remover a chave
  antiga.
