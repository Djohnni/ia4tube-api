# Social 3B-0 — procedência do primeiro cleanup O22 e contrato OAuth local

## Base local preservada

A implementação local pertence à branch
`social/checkpoint-3b0-instagram-oauth-local-contract-20260812`. O commit
funcional é `33e3ea7abcea7f5dc51780c3a1efd4743352fe40`, tem como pai imediato
`3dc3d8be62438216509f061f6c1a26ee39c9b5dc` e conserva a mensagem exata:

```text
[social-3b0] implement local Instagram OAuth authorize callback exchange
```

Esse commit contém exatamente os dezoito caminhos funcionais aprovados. Os
commits posteriores não reescrevem, alteram, fazem amend, rebase ou squash
desse commit. Os guards preservam uma comparação independente com `33e3`;
assim, alterações no produto, no contrato OAuth funcional, no repositório, no
cofre, em RLS, migrations, roles ou dependências são recusadas.

Os resultados locais já concluídos no snapshot funcional foram:

- focal final: 11/11;
- consolidado: 104 testes, 99 aprovados, zero falhas e cinco TODO físicos;
- suíte completa: 1.656 testes, 1.649 aprovados, zero falhas, dois ignorados e
  cinco TODO;
- secret scan canônico: zero achados;
- auditorias npm completa e runtime: zero vulnerabilidades;
- sintaxe: 18/18;
- parser/config: 4/4;
- `git diff --check`: aprovado;
- processos e listeners residuais: 0/0.

Esses números descrevem somente as validações locais já observadas. Eles não
antecipam nem representam o resultado do workflow remoto criado neste segundo
commit.

## Segundo commit de infraestrutura

O segundo commit tem como base exata o commit funcional `33e3` e usa a
mensagem:

```text
[run-social-3b0] validate Instagram OAuth contract remotely
```

Seu inventário é fechado em exatamente nove caminhos literais:

1. `.github/workflows/social-3b0-instagram-oauth-local-contract.yml`;
2. `docs/social-3b0-instagram-oauth-local-contract.md`;
3. `scripts/social-3a0p-local-scope.js`;
4. `scripts/social-3b0-linux-physical-gate.js`;
5. `tests/social-3a0p-current-diff-scope.test.js`;
6. `tests/social-3a0p-linux-workflow.test.js`;
7. `tests/social-3a0p-local-scope.test.js`;
8. `tests/social-3b0-linux-physical-gate.test.js`;
9. `tests/social-3b0-linux-workflow.test.js`.

Não há prefixo, glob ou diretório inteiro autorizado nesse inventário. Esse
commit foi executado uma única vez no run `31617802460`, attempt 1, que parou
na primeira falha física do Gate 3, substep S11, com o código fechado
`linux_gate_oauth_single_consumer_invalid`. Windows e o pré-gate Linux foram
aprovados; G01 e G02 foram aprovados; G04, G05 e O01–O21 não foram executados;
O22 concluiu o cleanup. O artifact histórico `9150034902` permanece
inalterado. Nele `externalRenderCalls` estava ausente e deve ser reportado como
indisponível, nunca inferido como zero.

## Terceiro commit — correção fechada

A terceira rota pertence à branch exata
`social/checkpoint-3b0-gate3-consumed-state-contract-20260812`. Seu commit é
`27cd350a253ab3ff07a915570eb41f291bbd1b42`, tem como pai imediato
`7bff67ac0c1acdd37473889a3f8b5c2017b30c9c` e usa a mensagem exata:

```text
[run-social-3b0] align Gate 3 replay and remote evidence contracts
```

Seu inventário é fechado em exatamente dez caminhos literais:

1. `.github/workflows/social-3b0-instagram-oauth-local-contract.yml`;
2. `docs/social-3b0-instagram-oauth-local-contract.md`;
3. `scripts/social-3a0p-linux-physical-gates.js`;
4. `scripts/social-3a0p-local-scope.js`;
5. `scripts/social-3b0-linux-physical-gate.js`;
6. `tests/social-3a0p-current-diff-scope.test.js`;
7. `tests/social-3a0p-linux-physical-gates.test.js`;
8. `tests/social-3a0p-local-scope.test.js`;
9. `tests/social-3b0-linux-physical-gate.test.js`;
10. `tests/social-3b0-linux-workflow.test.js`.

Não há décimo primeiro caminho, prefixo, glob ou exceção de diretório. Os
guards daquela rota distinguiam os dezoito caminhos funcionais de `33e3`, os
nove caminhos de infraestrutura de `7bff` e os dez caminhos dessa correção. O
diff daquela rota usou `7bff` como base; a proteção de produto permaneceu
ancorada separadamente em `33e3`.

O Gate 3 preserva S10 com dois consumidores concorrentes e
`Promise.allSettled`. S11 exige um vencedor e um perdedor cujo código exato é
`social_oauth_state_already_consumed`. O replay posterior no mesmo tenant em
S12 exige o mesmo código específico. A tentativa cross-tenant em S12 continua
exigindo `authorization_expired`, sem revelar a existência do state em outra
empresa. A autorização realmente expirada em S16 também continua exigindo
`authorization_expired`. O repositório OAuth funcional não é alterado.

As validações locais dessa correção encerraram com focal S10–S12 em 12/12,
Gate 3 completo em 144/144, gate físico sintético em 14/14, workflow em 11/11,
escopo em 8/8 e suíte completa com 1.694 testes lógicos, 1.687 aprovados, zero
falhas, dois ignorados e cinco TODO. O scan canônico teve zero achados; as
auditorias npm completa e runtime tiveram zero vulnerabilidades.

O único push dessa branch iniciou o run `31622235155`, attempt 1. Windows, o
pré-gate Linux, G01–G05 e O01–O04 foram aprovados. O05 falhou com a primeira
causa sanitizada `social_3b0_authorize_bearer_refusal_invalid`; O06–O21 ficaram
`skipped`, O22 foi aprovado, o secret scan remoto permaneceu `not_run` e
`backupRestoreFailureProvenance` permaneceu `null`. A primeira falha registrou
`job=linux_physical_gate`,
`phase=instagram_oauth_local_contract`, `substep=O05`,
`lastCompletedSubstep=O04`, `externalProcessStarted=null`, `exitCode=null`,
`signal=null` e `timedOut=false`. O supervisor registrou `exitCode=1`, `signal=null`,
`timedOut=false` e nenhum stdout ou stderr armazenado. Não houve segundo push,
retry ou re-run.

O artifact histórico `9151753459`, nome
`social-3b0-instagram-oauth-local-contract-evidence` e digest
`sha256:0b03e60bc73b259c5ee60bcf4c606b174bbf3d1a3c7b8dafe943c732e66e9fec`,
permanece inalterado. Seu evidence SHA-256 é
`5b59296159c672cfd9e5983d1cbbe9b914ed67fd897dcf7b01b68d49d7c606ea` e o
process-status SHA-256 é
`26564ca3007f7f91c7b77edadbe4122d82804ea0626a3958f21292d1b067f342`.
Ele registrou `authorizeRequests=2`, `callbackRequests=0`,
`syntheticExchangeCalls=0`, `credentialWrites=0`, `publicationCalls=0`,
`externalMetaCalls=0`, `externalInstagramCalls=0`, `externalGraphApiCalls=0`,
`externalRenderCalls=0`, `externalPublicationCalls=0` e `realTokenCount=0`, além
de cleanup concluído, material sintético limpo e os dez resíduos em zero. O
status HTTP que causou a divergência não foi publicado e não é inferido.

## Quarto commit — correção fechada do helper loopback

A quarta rota parte exatamente de `27cd350a253ab3ff07a915570eb41f291bbd1b42`
na branch
`social/checkpoint-3b0-o05-loopback-json-flush-20260812` e reserva a mensagem:

```text
[run-social-3b0] preserve loopback JSON payload until request flush
```

Seu inventário é fechado em exatamente oito caminhos literais:

1. `.github/workflows/social-3b0-instagram-oauth-local-contract.yml`;
2. `docs/social-3b0-instagram-oauth-local-contract.md`;
3. `scripts/social-3a0p-local-scope.js`;
4. `scripts/social-3b0-linux-physical-gate.js`;
5. `tests/social-3a0p-current-diff-scope.test.js`;
6. `tests/social-3a0p-local-scope.test.js`;
7. `tests/social-3b0-linux-physical-gate.test.js`;
8. `tests/social-3b0-linux-workflow.test.js`.

Não há nono caminho, prefixo, glob ou exceção de diretório. O diff corrente
usa `27cd` como base, enquanto a proteção dos dezoito blobs funcionais continua
ancorada separadamente em `33e3`.

A causa fechada é
`social_3b0_loopback_json_payload_zeroed_before_request_flush`, limitada ao
helper físico `httpJsonRequest`. O payload JSON deve permanecer íntegro até a
confirmação de consumo pelo request e ser zerado uma única vez depois de
`finish`, ou antes da rejeição em erro ou fechamento prematuro. A procedência de
O05 distingue, sem publicar status ou corpo, Bearer ausente, Bearer inválido,
persistência indevida, aceitação indevida e o contrato da requisição válida.
OAuth funcional, autenticação Bearer do produto, parser do produto, state AEAD,
repositório, RLS e cofre permanecem inalterados.

Essa quarta rota foi concluída no commit
`ad3c162aaee04bb66d79ea3c35c3d75297e8d0ab`, filho imediato de `27cd`, com a
mensagem reservada acima e exatamente os oito caminhos declarados. Seu único
push iniciou o run histórico `31635646419`, attempt 1. Windows, pré-gate Linux,
G01–G05 e O01–O11 foram aprovados; O12 falhou; O13–O21 ficaram `skipped`; O22
concluiu o cleanup. O secret scan OAuth remoto ficou `not_run`.

A primeira falha histórica permanece, sem reclassificação:
`job=linux_physical_gate`, `phase=instagram_oauth_local_contract`,
`substep=O12`, `lastCompletedSubstep=O11`, `causalCode=credential_not_found`,
`externalProcessStarted=null`, `exitCode=null`, `signal=null` e
`timedOut=false`. O supervisor registrou `exitCode=1`, `signal=null`,
`timedOut=false`, `stdoutStored=false` e `stderrStored=false`.

O artifact histórico `9156947951`, nome
`social-3b0-instagram-oauth-local-contract-evidence`, permanece inalterado. Seu
digest é
`sha256:ffa0cd90627fb7aa4f1e0059919ee5962660893bed62ac78db8d5d9a9b43daa6`,
o Evidence SHA-256 é
`7ec82a5bdfcd80941e751b192b780d5f9e8b6e23d50194c5ce3a144eb6150fba` e o
Process-status SHA-256 é
`26564ca3007f7f91c7b77edadbe4122d82804ea0626a3958f21292d1b067f342`.
Ele registrou `authorizeRequests=3`, `callbackRequests=3`,
`syntheticExchangeCalls=1`, `credentialWrites=0`, `accountDiscoveryCalls=0`,
`publicationCalls=0`, `externalMetaCalls=0`, `externalInstagramCalls=0`,
`externalGraphApiCalls=0`, `externalRenderCalls=0`,
`externalPublicationCalls=0` e `realTokenCount=0`. O cleanup foi concluído,
`intermediateEvidenceRemoved=true`, `syntheticMaterialsCleared=true` e os dez
resíduos ficaram em zero. Não houve segundo push, retry ou re-run.

## Quinto commit — prova física da credencial pendente

A quinta rota parte exatamente de
`ad3c162aaee04bb66d79ea3c35c3d75297e8d0ab`, na branch
`social/checkpoint-3b0-o12-pending-credential-visibility-20260812`, e reserva a
mensagem:

```text
[run-social-3b0] verify pending credential without operational activation
```

Seu inventário é fechado em exatamente seis caminhos literais:

1. `.github/workflows/social-3b0-instagram-oauth-local-contract.yml`;
2. `docs/social-3b0-instagram-oauth-local-contract.md`;
3. `scripts/social-3b0-linux-physical-gate.js`;
4. `tests/social-3a0p-current-diff-scope.test.js`;
5. `tests/social-3b0-linux-physical-gate.test.js`;
6. `tests/social-3b0-linux-workflow.test.js`.

Não há sétimo caminho, prefixo, glob ou exceção de diretório. O diff corrente
usa `ad3c` como base. Os dois paths de escopo permanecem byte-idênticos porque
a allowlist literal existente já contém os seis caminhos desta rota.

A causa fechada é
`social_3b0_o12_pending_credential_operational_visibility_contract_mismatch`.
O callback já persistiu uma única credencial cifrada, vinculada a uma conexão
`authorization_pending`. A recusa interna `credential_not_found` pelo caminho
operacional é esperada e preservada: esse caminho continua aceitando somente
conexões `active` ou `connected`.

O12 deve provar simultaneamente que a linha física existe e tem envelope
válido, que o mesmo cofre autentica e decripta o material sintético com seu AAD,
e que o acesso operacional permanece recusado antes de account discovery. O
plaintext físico existe somente dentro da prova, é comparado por digest e
zerado em `finally`; buffers físicos também são zerados. Não se cria API,
segundo cofre, segunda chave, conta externa ou transição para `active`. O13
continua exigindo `authorization_pending`, zero external accounts,
`accountDiscoveryCalls=0` e zero publicação.

Essa quinta rota foi concluída no commit
`1febe1211b0021d8c35cdfb840f581fd76ce39e7`, filho imediato de `ad3c`, com a
mensagem reservada acima e exatamente os seis caminhos declarados. As
validações locais preservadas incluem O12 em 42/42, O13 em 1/1, gate físico
sintético em 73/73, workflow em 11/11, escopo em 8/8, secret scan canônico
aprovado e auditorias npm completa e runtime com zero vulnerabilidades. O teste
isolado de body-parser foi aprovado, sem timeout e sem resíduos. A suíte
completa substituta terminou com 125/125 no estágio serial e, no estágio
concorrente, 1.628 testes, 1.621 aprovados, zero falhas, dois ignorados e cinco
TODO.

O único push dessa branch iniciou o run histórico `31653513120`, attempt 1.
Windows, pré-gate Linux, G01–G05 e O01–O21 foram aprovados. A primeira falha
física ocorreu em O22. O secret scan OAuth remoto foi aprovado e
`backupRestoreFailureProvenance` permaneceu `null`. A primeira falha permanece,
sem reclassificação: `job=linux_physical_gate`,
`phase=instagram_oauth_local_contract`, `substep=O22`,
`lastCompletedSubstep=O21`, `causalCode=social_3b0_cleanup_incomplete`,
`externalProcessStarted=null`, `exitCode=null`, `signal=null` e
`timedOut=false`. O process-status registrou `exitCode=1`, `signal=null`,
`timedOut=false`, `stdoutStored=false` e `stderrStored=false`.

O artifact histórico `9163501259`, nome
`social-3b0-instagram-oauth-local-contract-evidence`, permanece inalterado e
não recebe retroativamente o schema desta sexta rota. Seu digest é
`sha256:fd99df69dc4222afd0e9f01201f694939c1fd8f242cb453e89851a8a41d6c32a`,
o Evidence SHA-256 é
`fd1b0b14a77d1e5cae310a9ea615d86f5531e0d1a511ec2f11905b7db48ec892` e o
Process-status SHA-256 é
`26564ca3007f7f91c7b77edadbe4122d82804ea0626a3958f21292d1b067f342`.
Ele registrou `authorizeRequests=6`, `callbackRequests=8`,
`syntheticExchangeCalls=2`, `credentialWrites=2`, `concurrencyWinners=1`,
`replayRefusals=1`, `blockedBodyAborts=1`, `cancellationExchanges=0`,
`accountDiscoveryCalls=0`, `publicationCalls=0`, `externalMetaCalls=0`,
`externalInstagramCalls=0`, `externalGraphApiCalls=0`,
`externalRenderCalls=0`, `externalPublicationCalls=0` e `realTokenCount=0`.
O cleanup compensatório final registrou `cleanupCompleted=true`,
`intermediateEvidenceRemoved=true`, `syntheticMaterialsCleared=true` e zero em
containers, networks, volumes, temporary roots, conexões PostgreSQL, servidores
HTTP, listeners, timers, readers e processos Node. Não houve segundo push,
retry ou re-run.

A classificação desta parada histórica é
`social_3b0_o22_first_attempt_cleanup_failure_provenance_missing`, limitada à
superfície `physical_gate_cleanup_observability_only`. O artifact prova apenas
que a primeira tentativa de cleanup foi considerada incompleta, a causa
específica não foi preservada, o cleanup compensatório terminou sem resíduos e
o primeiro erro continuou preservado. Ele não prova qual recurso ou operação
causou a falha e não pode ser reclassificado como aprovado.

## Sexto commit — procedência fechada da primeira tentativa de O22

A sexta rota parte exatamente de
`1febe1211b0021d8c35cdfb840f581fd76ce39e7`, na branch
`social/checkpoint-3b0-o22-cleanup-provenance-20260812`, e reserva a mensagem:

```text
[run-social-3b0] capture first-attempt O22 cleanup provenance
```

Seu inventário é fechado em exatamente seis caminhos literais:

1. `.github/workflows/social-3b0-instagram-oauth-local-contract.yml`;
2. `docs/social-3b0-instagram-oauth-local-contract.md`;
3. `scripts/social-3b0-linux-physical-gate.js`;
4. `tests/social-3a0p-current-diff-scope.test.js`;
5. `tests/social-3b0-linux-physical-gate.test.js`;
6. `tests/social-3b0-linux-workflow.test.js`.

Não há sétimo caminho, prefixo, glob ou exceção de diretório. O diff corrente
usa `1febe` como base; a proteção dos dezoito blobs funcionais permanece
ancorada separadamente em `33e3`. Esta rota altera somente a observabilidade do
primeiro cleanup O22. Ela não muda a ordem, as operações ou o comportamento do
cleanup e não adiciona espera, retry, polling ou segunda tentativa ao worker.

O campo fechado `cleanupFailureProvenance` vale `null` quando a primeira
tentativa de cleanup do worker é integralmente aprovada. Quando essa primeira
tentativa falha, seu schema exato é:

```json
{
  "operation": "<enum fechado>",
  "causalCode": "<código fechado>",
  "cleanupErrorCount": 0,
  "postgresCleanupCompleted": null,
  "firstAttemptSyntheticMaterialsCleared": false,
  "firstAttemptResiduals": {
    "containers": 0,
    "httpServers": 0,
    "listeners": 0,
    "networks": 0,
    "nodeProcesses": 0,
    "postgresConnections": 0,
    "readers": 0,
    "temporaryRoots": 0,
    "timers": 0,
    "volumes": 0
  }
}
```

Todos os contadores devem ser inteiros seguros, não negativos e sem coerção.
`postgresCleanupCompleted` aceita somente `true`, `false` ou `null`, e
`firstAttemptSyntheticMaterialsCleared` é booleano. `operation` aceita somente
`network_guard_restore`, `http_server_close`, `state_envelope_destroy`,
`vault_destroy`, `postgres_cleanup_call`, `postgres_cleanup_result` ou
`residual_validation`.

A primeira operação que lança é preservada, todas as operações continuam sendo
tentadas e `cleanupErrorCount` contabiliza todas as operações que lançaram.
Mensagem, stack e identificadores físicos nunca entram na evidência. Um erro
lançado conserva somente seu código seguro fechado; caso contrário usa
`social_3b0_cleanup_operation_failed`. PostgreSQL retornando cleanup incompleto
usa `social_3b0_postgres_cleanup_incomplete`; residual não zero sem erro lançado
usa `social_3b0_cleanup_residuals_nonzero`.

A fotografia é formada depois de todas as operações da primeira tentativa e
antes de `failCleanup`, do supervisor compensatório e de qualquer reescrita da
evidência. O supervisor pode atualizar cleanup e resíduos finais, além de
`intermediateEvidenceRemoved`, mas não pode substituir a operação, o código, a
contagem de erros, o resultado PostgreSQL, o estado do material sintético ou os
dez resíduos da primeira tentativa.

Se a primeira tentativa O22 falhar, O22 e o status geral permanecem `failed`,
`firstFailure` permanece em O22 e a provenance é não nula, mesmo que a
compensação posterior conclua o cleanup e leve os resíduos finais a zero. Se
uma falha funcional anterior ocorrer e o primeiro cleanup passar, O22 pode ser
`passed`, a primeira falha anterior permanece e a provenance é `null`. O run
integralmente aprovado exige O22 `passed`, `firstFailure=null` e provenance
`null`.

## Workflow remoto separado

O workflow histórico
`.github/workflows/social-3a0p-linux-physical-gates.yml` permanece fora deste
inventário e não recebe trigger adicional. A rota 3B-0 usa um workflow separado,
acionado somente pelo primeiro `push` da branch exata. Não há
`pull_request`, `workflow_dispatch`, `schedule`, matrix ou repetição automática.
As permissões são somente `contents: read`, as Actions são fixadas por SHA
completo, a concorrência é exclusiva da branch e `cancel-in-progress` é falso.

O guard remoto deve aceitar somente `event=push`, criação da nova branch com
`github.event.before` composto por quarenta zeros, `github.event.created=true`,
`forced=false`, `deleted=false`, `run_attempt=1` e a mensagem exata do sexto
commit. A cadeia aceita é exclusivamente:

```text
HEAD remoto
  -> 1febe1211b0021d8c35cdfb840f581fd76ce39e7
  -> ad3c162aaee04bb66d79ea3c35c3d75297e8d0ab
  -> 27cd350a253ab3ff07a915570eb41f291bbd1b42
  -> 7bff67ac0c1acdd37473889a3f8b5c2017b30c9c
  -> 33e3ea7abcea7f5dc51780c3a1efd4743352fe40
  -> 3dc3d8be62438216509f061f6c1a26ee39c9b5dc
```

Cada commit deve ter exatamente um pai. O guard verifica separadamente os
dezoito caminhos do commit funcional `33e3`, os nove caminhos da infraestrutura
`7bff`, os dez caminhos da correção Gate 3 em `27cd`, os oito caminhos da
correção O05 em `ad3c`, os seis caminhos da correção O12 em `1febe` e os seis
caminhos da correção O22 no HEAD corrente.

## Jobs e limites operacionais

O job Windows usa `windows-2025`, checkout com histórico completo e sem
credenciais persistidas, Node 24 e `npm ci`. Ele neutraliza somente `PGBIN`,
`PGDATA`, `PGROOT`, `PGPASSWORD`, `PGUSER`, recusa outra variável PostgreSQL
não vazia e executa a suíte completa uma única vez. O job Linux só pode iniciar
depois do sucesso do Windows.

O job Linux usa o runner hospedado já adotado pelo Social 3A-0P e PostgreSQL
18.4 pinado pelo digest
`sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568`.
Seu ambiente físico é descartável, sem porta pública e com credenciais somente
sintéticas. Antes do gate novo, ele executa o pré-gate compatível e reexecuta os
Gates 1–5 existentes sem mudar suas expectativas. Uma falha nesses gates impede
o início da fase 3B-0 e preserva a primeira causa fechada.

A fase nova chama-se `instagram_oauth_local_contract`. Ela usa apenas aplicação
HTTP local, loopback, PostgreSQL descartável, transporte Instagram injetado e
material sintético não autenticável. O runtime padrão permanece desligado para
as três flags externas; nenhuma variável é criada no Render.

## Subetapas físicas fechadas

O gate registra exclusivamente O01–O22:

- O01: configuração sintética fail-closed;
- O02: migrations 0001–0004 aplicadas;
- O03: empresas sintéticas A e B criadas;
- O04: usuários e sessões sintéticos criados;
- O05: authorize de A com Bearer válido;
- O06: state AEAD emitido e digest persistido;
- O07: bindings ausentes do ciphertext em texto claro;
- O08: callback sem Bearer abre state válido;
- O09: tenant A instalado somente após autenticação AEAD;
- O10: sessão consumida sob FORCE RLS;
- O11: exchange sintético chamado exatamente uma vez;
- O12: credencial pendente persistida e autenticada fisicamente pelo cofre,
  mas recusada pelo caminho operacional;
- O13: conexão não ativada antes de account discovery e zero external accounts;
- O14: replay recusado sem novo exchange;
- O15: callbacks concorrentes produzem um vencedor;
- O16: state de A não alcança B;
- O17: cancelamento consome state sem exchange;
- O18: body bloqueado abortado pelo orçamento temporal único;
- O19: feature flags desligadas bloqueiam operação externa;
- O20: zero publicação, container, publish ou permalink;
- O21: auditoria sanitizada sem state, code ou token;
- O22: primeira tentativa de cleanup integral, com procedência fechada em falha.

O gate não executa OAuth real, Meta, Instagram, Graph API, Render, staging,
produção ou publicação. Conexões de aplicação não loopback são recusadas. O
provider usa somente o transporte injetado e não faz retry.

## Evidência e cleanup

O único artifact autorizado chama-se
`social-3b0-instagram-oauth-local-contract-evidence`. Ele contém exatamente:

1. `social-3b0-instagram-oauth-local-contract-evidence.json`;
2. seu sidecar `.sha256`;
3. `social-3b0-instagram-oauth-local-contract-process-status.json`;
4. seu sidecar `.sha256`.

A evidência admite somente identidade do run, resultados fechados do Windows,
Gates 1–5 e O01–O22, contagens, primeira falha e estado de cleanup. State, code,
token, App Secret, identidades físicas, JTI, authorization handle, ciphertext,
nonce, tag, AAD, URL de autorização, body, headers, stdout e stderr são
proibidos.

Todo artifact novo inclui obrigatoriamente os contadores inteiros seguros e
não negativos `externalMetaCalls`, `externalInstagramCalls`,
`externalGraphApiCalls`, `externalRenderCalls`, `externalPublicationCalls`,
`publicationCalls` e `realTokenCount`. A aprovação exige exatamente zero em
todos eles. `externalRenderCalls` é somente um contador: URL, host, domínio ou
ID de serviço Render continuam proibidos. O campo também deve existir em
evidência de falha e fallback sanitizado; ausência, `null`, string, valor
negativo, valor não zero, nome aproximado ou campo sinônimo adicional são
recusados.

Todo artifact novo também inclui obrigatoriamente `cleanupFailureProvenance`.
O schema recusa campo ausente ou adicional, operação ou código desconhecido,
contador negativo, fracionário ou textual, residual ausente ou adicional,
provenance não nula em sucesso, provenance nula quando `firstFailure` está em
O22, O22 aprovado com primeira falha em O22, O22 falho sem provenance e
compensação que apague a fotografia da primeira tentativa.

Uma evidência de falha que cumpra integralmente esse schema fechado continua
aprovada para upload, com resultado de sucesso falso, para preservar a
procedência sanitizada. O enforcement somente aprova quando `status=passed`,
`firstFailure=null`, O22 está `passed`, `cleanupFailureProvenance=null` e cada
resíduo final é zero, além de todas as condições históricas já exigidas.

O cleanup é obrigatório também em falha e remove container, rede, volume,
diretório temporário, banco, material sintético, arquivos intermediários,
servidor, timers, readers, processos e listeners. O enforcement remoto retorna
sucesso somente se Windows, pré-gate, Gates 1–5, O01–O22, secret scan remoto,
evidência, sidecars e cleanup forem aprovados, com `firstFailure=null` e todos
os resíduos em zero.

Nenhum resultado remoto, SHA de evidência, digest de artifact ou conclusão do
run da sexta rota é registrado neste documento antes de ser efetivamente
observado.
