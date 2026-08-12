# Social 3B-0 — Gate 3 replay e evidência remota do contrato OAuth local

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

A nova rota pertence à branch exata
`social/checkpoint-3b0-gate3-consumed-state-contract-20260812`, parte do commit
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
guards distinguem os dezoito caminhos funcionais de `33e3`, os nove caminhos
de infraestrutura de `7bff` e os dez caminhos desta correção. O diff corrente
usa `7bff` como base; a proteção de produto continua ancorada separadamente em
`33e3`.

O Gate 3 preserva S10 com dois consumidores concorrentes e
`Promise.allSettled`. S11 exige um vencedor e um perdedor cujo código exato é
`social_oauth_state_already_consumed`. O replay posterior no mesmo tenant em
S12 exige o mesmo código específico. A tentativa cross-tenant em S12 continua
exigindo `authorization_expired`, sem revelar a existência do state em outra
empresa. A autorização realmente expirada em S16 também continua exigindo
`authorization_expired`. O repositório OAuth funcional não é alterado.

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
`forced=false`, `deleted=false`, `run_attempt=1` e a mensagem exata do terceiro
commit. A cadeia aceita é exclusivamente:

```text
HEAD remoto
  -> 7bff67ac0c1acdd37473889a3f8b5c2017b30c9c
  -> 33e3ea7abcea7f5dc51780c3a1efd4743352fe40
  -> 3dc3d8be62438216509f061f6c1a26ee39c9b5dc
```

Cada commit deve ter exatamente um pai. O guard verifica os dezoito caminhos
do commit funcional, os nove caminhos do commit de infraestrutura anterior e
os dez caminhos do commit corrente como inventários distintos.

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
- O12: token sintético cifrado exatamente uma vez;
- O13: conexão não ativada antes de account discovery;
- O14: replay recusado sem novo exchange;
- O15: callbacks concorrentes produzem um vencedor;
- O16: state de A não alcança B;
- O17: cancelamento consome state sem exchange;
- O18: body bloqueado abortado pelo orçamento temporal único;
- O19: feature flags desligadas bloqueiam operação externa;
- O20: zero publicação, container, publish ou permalink;
- O21: auditoria sanitizada sem state, code ou token;
- O22: cleanup integral.

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

O cleanup é obrigatório também em falha e remove container, rede, volume,
diretório temporário, banco, material sintético, arquivos intermediários,
servidor, timers, readers, processos e listeners. O enforcement remoto retorna
sucesso somente se Windows, pré-gate, Gates 1–5, O01–O22, secret scan remoto,
evidência, sidecars e cleanup forem aprovados, com `firstFailure=null` e todos
os resíduos em zero.

Nenhum resultado remoto, SHA de evidência, digest de artifact ou conclusão do
run é registrado neste documento antes de ser efetivamente observado.
