# Checkpoint Social 3A-0P — gates físicos Linux isolados

## Limite e proveniência

Esta rota encerra formalmente a sequência física local Windows no commit
`36be098f926cc060ee89dff7874dab772a3ef22f`. Ela não diagnostica nem corrige
`postgres_initdb_failed`, não altera a branch Windows e não reutiliza o pacote
Windows preservado.

O workflow Linux existe somente na branch
`social/checkpoint-3a0p-linux-physical-gates-20260807`. O produto permanece
idêntico a `fcfc92419021dae5f77baad731c634b10c275c5b`: `src/`,
`db/migrations/`, `server.js`, `package.json` e `package-lock.json` não são
alterados.

## Segundo e último disparo autorizado

O único gatilho agora autorizado é o segundo `push` na branch exata, sem
recriação, exclusão ou force, cujo commit tenha a mensagem integral:

```text
[run-social-3a0p-linux-gate] use verified structured loopback inspection
```

O job exige `run_attempt == 1`, `created == false`, `deleted == false`,
`forced == false`, `before` e pai exatos
`d80d351c599444dfca372db6071bda757e16dd64`, além de diff estritamente
allowlisted. Não há `workflow_dispatch`, pull request, agenda, matriz ou retry
automático. A regra operacional permanece: nenhuma repetição manual, terceiro
push ou recriação da branch depois desta segunda execução.

## Supply chain fechada

- Runner: `ubuntu-24.04`.
- Permissões: somente `contents: read`.
- Node: linha 24, compatível com `>=20 <25`.
- Instalação: `npm ci --ignore-scripts --no-audit --no-fund`.
- `actions/checkout`: `3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1).
- `actions/setup-node`: `820762786026740c76f36085b0efc47a31fe5020` (v7.0.0).
- `actions/upload-artifact`: `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` (v7.0.1).
- PostgreSQL oficial:
  `docker.io/library/postgres:18.4-bookworm@sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568`.

O digest é o manifesto de plataforma `linux/amd64`, não o índice
multi-arquitetura. O job revalida `Os`, `Architecture`, `RepoDigests` e a versão
SQL antes de executar migrations.

## Isolamento do contêiner

O PostgreSQL usa uma rede Docker `--internal`, volume de propriedade do run e
diretório físico sob `$RUNNER_TEMP`. A porta do host é escolhida pelo Docker e
publicada exclusivamente como `127.0.0.1:<porta-alta>:5432`.

O PostgreSQL escuta na interface privada do contêiner para receber o DNAT da
publicação Docker. Isso não é relatado como exposição externa. A prova
autoritativa não usa mais `docker port`. O ID completo retornado por
`docker run --detach` é capturado e vinculado ao nome e ao label esperados.
Uma única inspeção JSON desse ID usa `NetworkSettings.Ports["5432/tcp"]` como
fonte da porta efetivamente publicada. A entrada correspondente em
`HostConfig.PortBindings` serve somente como confirmação independente da
solicitação original; ela não escolhe a porta nem substitui o estado publicado.
As duas estruturas devem conter uma única associação, exclusivamente em
`127.0.0.1:<porta-alta>`, para a porta interna `5432/tcp`.

O probe `ss` é apenas uma prova negativa de exposição. Wildcard, IPv4 externo,
IPv6, duplicidade ou associação ambígua reprovam o gate. Zero linhas para a
porta é aceitável quando a inspeção estruturada acima foi aprovada e uma conexão
real iniciada no host para `127.0.0.1:<porta-alta>` também foi aprovada; portanto
o sucesso não depende de uma representação específica do proxy Docker em `ss`.

Na primeira execução Linux, o antigo comando `docker port` terminou com o código
sanitizado `linux_postgres_port_inspect_failed`. A causa física permanece
indeterminada: aquela evidência não preservou o status detalhado, `stderr`, ID do
contêiner ou bindings estruturados, e o cleanup com zero resíduos não permite
reconstruir retrospectivamente qual dessas condições ocorreu.

O cluster exige PostgreSQL 18.4, `C`, UTF8, SCRAM-SHA-256 e data checksums. A
senha administrativa é sintética, nasce durante o job e fica somente em memória
e em arquivo temporário `0600`, passado via `POSTGRES_PASSWORD_FILE`. Senhas de
roles nunca aparecem em argumentos, logs ou evidência.

## Prova Linux de durabilidade

Antes do banco, um helper Python pequeno usa descritores de diretório mantidos,
`dir_fd`, `O_EXCL`, `O_NOFOLLOW` e validação de dispositivo/inode. A prova faz:

1. criação exclusiva, escrita integral e `fsync` do arquivo;
2. fechamento, rename atômico e `fsync` do diretório-pai;
3. reabertura e SHA-256 idêntico;
4. arquivo regular aceito;
5. symlink final recusado;
6. troca por symlink antes da abertura recusada;
7. symlink intermediário recusado sem travessia;
8. cleanup completo e zero resíduos.

Falha de `fsync` de diretório, ausência de `O_NOFOLLOW` ou identidade alterada
reprova o gate. Nenhuma garantia é inferida apenas por teste simulado.

## Ordem física dos gates

Os gates são sequenciais e param na primeira falha:

1. **Migrations e rollback** — 0001–0003, snapshot, 0004, checksum,
   constraints/índices/RLS/FORCE RLS, falha transacional controlada, restauração
   0003 e reaplicação 0004, sem migration down.
2. **RLS e roles** — A/B em ambos os sentidos, leitura e escrita, contexto
   ausente/adulterado, reutilização de conexão e atributos da role runtime.
3. **Concorrência, OAuth e idempotência** — reserva concorrente de conexão,
   consumo único/replay/expiração/cross-company de state sintético e corrida de
   publicação com um único registro.
4. **Cofre** — AES-256-GCM, AAD de empresa/provedor/conexão/finalidade,
   adulterações, rotação e bloqueio da retirada de chave ainda usada.
5. **Backup e restauração** — perfis 0003 e 0004, bundles individuais,
   SHA-256, manifesto, `fsync` do arquivo e diretório, restauração isolada,
   schema/dados/RLS/cofre, perfil cruzado e manifesto adulterado recusados.

O `fsync` definitivo do diretório do bundle é exigido e contado nos dois
bundles do Gate 5. O bundle transitório usado internamente pelo rollback do
Gate 1 não é contado nessa evidência; a prova de durabilidade anterior aos
gates comprova separadamente a primitiva do filesystem.

Os planos físicos, migrations, stores, cofre e operadores de backup do produto
são reutilizados. O código Linux acrescenta somente adaptação Docker, provas
físicas faltantes, métricas e evidência; não existe uma segunda implementação do
produto. Leituras do ledger feitas pelos planos assumem explicitamente a role
canônica de migration. O operador de backup continua autenticado como
provisionador para identidade, locks e lifecycle, mas delega somente a leitura
do ledger a uma sessão curta da role migrator; nenhuma role recebe `INHERIT` ou
grant adicional.

Os planos compartilhados constroem a configuração de restore antes de o
backup existir. A adaptação Linux valida esse caminho mediante arquivo regular
exclusivo, vazio e imediatamente removido dentro da raiz própria; o backup real
continua sendo criado com exclusividade e sua integridade é validada pelo
operador original. Bancos descartáveis de restore têm somente o footprint de
bootstrap removido sob concessão temporária e auditada da role owner, revertida
antes da restauração. O perfil 0003 recebe uma fixture sintética e a mesma
identidade e contagens específicas são comprovadas depois do restore.

## Evidência e primeira falha

Um único artifact contém:

- `social-3a0p-linux-physical-gates-evidence.json`;
- `social-3a0p-linux-physical-gates-evidence.sha256`.

A serialização é canônica. Somente fases, booleans, contagens, durações, hashes,
versões e códigos normalizados são permitidos. URL de conexão, senha, state,
token, SQL com valores, dump bruto, ambiente e log bruto são recusados. O marker
`.sanitized-approved` só é criado depois da varredura e não é enviado no
artifact.

O artifact tem retenção de sete dias.

Na primeira falha, gates posteriores não são chamados. O erro primário é
preservado, o finalizador remove somente container, volume, rede e caminhos do
run e o workflow termina sem retry. O passo `always()` repete apenas o cleanup
idempotente, nunca o gate.

## Status antes do disparo

Enquanto o único workflow não tiver terminado e a evidência não tiver sido
verificada, o checkpoint permanece:

```text
SOCIAL 3A-0P — GATE LINUX BLOQUEADO
```

OAuth real, Meta, Instagram, Render, staging, produção, Android, Firebase e FCM
permanecem fora deste checkpoint.
