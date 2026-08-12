# Social 3B-0 — validação remota do contrato OAuth local do Instagram

## Base local preservada

A implementação local pertence à branch
`social/checkpoint-3b0-instagram-oauth-local-contract-20260812`. O commit
funcional é `33e3ea7abcea7f5dc51780c3a1efd4743352fe40`, tem como pai imediato
`3dc3d8be62438216509f061f6c1a26ee39c9b5dc` e conserva a mensagem exata:

```text
[social-3b0] implement local Instagram OAuth authorize callback exchange
```

Esse commit contém exatamente os dezoito caminhos funcionais aprovados. O
segundo commit não reescreve, altera, faz amend, rebase ou squash desse commit.
Os guards deste segundo commit comparam o novo diff diretamente contra `33e3`;
assim, alterações no produto, no contrato OAuth, no repositório, no cofre, em
RLS, migrations, roles ou dependências são recusadas.

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

Não há prefixo, glob, diretório inteiro ou décimo caminho autorizado. Os três
arquivos de escopo são alterados apenas para trocar a allowlist funcional pela
allowlist literal deste commit de infraestrutura e para fixar `33e3` como a
base do diff corrente.

## Workflow remoto separado

O workflow histórico
`.github/workflows/social-3a0p-linux-physical-gates.yml` permanece fora deste
inventário e não recebe trigger adicional. A rota 3B-0 usa um workflow separado,
acionado somente pelo primeiro `push` da branch exata. Não há
`pull_request`, `workflow_dispatch`, `schedule`, matrix ou repetição automática.
As permissões são somente `contents: read`, as Actions são fixadas por SHA
completo, a concorrência é exclusiva da branch e `cancel-in-progress` é falso.

O guard remoto deve aceitar somente `event=push`, criação da branch com
`github.event.before` composto por quarenta zeros, `github.event.created=true`,
`forced=false`, `deleted=false`, `run_attempt=1` e a mensagem exata do segundo
commit. A cadeia aceita é exclusivamente:

```text
HEAD remoto
  -> commit de infraestrutura
  -> 33e3ea7abcea7f5dc51780c3a1efd4743352fe40
  -> 3dc3d8be62438216509f061f6c1a26ee39c9b5dc
```

Cada commit deve ter exatamente um pai. O guard verifica os dezoito caminhos
do commit funcional e os nove caminhos do commit de infraestrutura como
inventários distintos; os dezoito caminhos não precisam reaparecer no segundo
commit.

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

O cleanup é obrigatório também em falha e remove container, rede, volume,
diretório temporário, banco, material sintético, arquivos intermediários,
servidor, timers, readers, processos e listeners. O enforcement remoto retorna
sucesso somente se Windows, pré-gate, Gates 1–5, O01–O22, secret scan remoto,
evidência, sidecars e cleanup forem aprovados, com `firstFailure=null` e todos
os resíduos em zero.

Nenhum resultado remoto, SHA de evidência, digest de artifact ou conclusão do
run é registrado neste documento antes de ser efetivamente observado.
