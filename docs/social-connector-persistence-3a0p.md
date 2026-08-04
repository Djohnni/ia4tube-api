# Social 3A-0P: persistencia definitiva do contrato minimo

## Limite deste checkpoint

Este checkpoint liga o contrato interno do Social 3A-0 a adapters PostgreSQL
multitenant. Ele nao cria rota HTTP, callback OAuth, adaptador da Meta, fila,
worker, agenda ou chamada externa. Todos os valores de teste sao sinteticos.

## Mapa contrato para schema

| Capacidade do contrato | Tabelas reutilizadas | Complemento minimo |
| --- | --- | --- |
| `beginAuthorization` | `social_connections`, `social_oauth_transactions` | novos estados de conexao, contexto auditavel e consumo terminal do OAuth |
| `discoverAccount` | `social_connections`, `social_external_accounts`, `social_encrypted_credentials` | restricao Business/Creator para Instagram e adapter transacional |
| `publishImage` | `social_connections` | `social_idempotency_operations`, `social_publications` e `social_publication_attempts` |
| `getPublicationStatus` | `social_publications`, `social_publication_attempts` | referencia de reconciliacao distinta da confirmacao final |
| `disconnect` | `social_connections`, `social_external_accounts`, `social_encrypted_credentials` | revogacao da conta e das credenciais na mesma transacao da desconexao |
| auditoria das cinco capacidades | `social_audit_events` | provedor, correlacao e publicacao opcionais e allowlist de eventos |

As tabelas de empresas, usuarios, memberships, identidade, keyring e
reautenticacao continuam sendo as mesmas da fundacao 2B. Nao existe schema
paralelo.

## Migration 0004

`0004_social_connector_persistence`:

- preserva os estados legados e acrescenta os estados definitivos do 3A-0;
- executa um preflight agregado e sanitizado que recusa duplicidades legadas
  incompatíveis antes de criar os índices, sem retornar identificadores nem
  modificar registros;
- garante por indice parcial apenas uma conexao Instagram bloqueante por
  empresa, inclusive sob concorrencia;
- exige Business ou Creator e username em novas contas Instagram;
- completa a transacao OAuth com conexao, falha e IDs de auditoria/correlacao;
- cria somente os tres ledgers ausentes: idempotencia, publicacao e tentativas;
- aplica `ENABLE RLS`, `FORCE RLS`, politica por `company_id` e grants minimos;
- inclui as novas tabelas na validacao de startup e no backup social.

A migration nao atualiza nem apaga linhas existentes. Ela apenas verifica, por
contagem agregada sem expor dados, se o estado anterior permite instalar as
barreiras de unicidade. Conflito aborta toda a transacao com codigo sanitizado;
nao ha saneamento silencioso. Constraints aplicadas a entidades antigas usam a
forma compativel prevista pelo PostgreSQL, e toda a migration permanece
protegida pela transacao e pelo ledger de checksum do framework existente.

## Constraints e concorrencia

- a chave primaria da idempotencia e `(company_id, operation_id)`;
- a publicacao referencia a mesma empresa, operacao, provedor e hash da reserva;
- a mesma operacao nao pode criar duas publicacoes;
- `published` exige referencia confirmada e `published_at`;
- estados nao publicados nao podem carregar confirmacao final;
- uma tentativa e unica por empresa, publicacao e numero;
- atualizacoes de conexao/publicacao usam `revision` como compare-and-swap;
- a reserva de conexao usa transacao e advisory lock derivado de
  empresa/provedor, enquanto o indice parcial e a barreira fisica final;
- o consumo OAuth faz um unico `UPDATE ... WHERE` terminal e concorrente;
- nenhuma transacao fica aberta durante uma futura chamada ao provedor.

## Limites transacionais

1. reservar conexao: contexto RLS, advisory lock, verificacao bloqueante e
   insert/update CAS;
2. consumir OAuth: hash do state, empresa, sessao e validade verificados no
   mesmo update atomico;
3. ativar conexao: CAS da conexao, conta profissional, credencial ja cifrada e
   auditoria sao persistidos no mesmo escopo transacional; no fluxo OAuth, a
   credencial ativa ligada a uma transacao consumida e reatribuida a conexao
   sem ler o envelope, e o caminho PostgreSQL comum nao pode produzir
   `connected` sem uma credencial valida;
4. publicar: reserva idempotente e intencao `ready` sao criadas atomicamente;
5. registrar resultado: transicao CAS, tentativa sanitizada e auditoria usam o
   mesmo contexto de empresa;
6. desconectar: conexao, conta e credenciais sao desativadas na mesma transacao.

## Lifecycles persistidos

Conexao: `disconnected` -> `authorization_pending` -> `connected`, com
`reconnect_required`, `disconnecting` e `failed` conforme o contrato.

OAuth sintetico: criado apenas com `state_digest`, expira, e termina exatamente
uma vez por consumo, cancelamento ou falha. O handle persistivel e sempre UUID
emitido pelo servidor; texto opaco semelhante a state/JWT e recusado. O state
cru nunca e persistido.

Publicacao: `ready` -> `publishing` -> `provider_confirming` ou resultado
terminal. `provider_confirming` nunca equivale a sucesso e uma resposta atrasada
nao regride `published`.

Tentativa: `started` e um dos resultados normalizados
`provider_confirming`, `published`, `failed_temporary` ou `failed_permanent`.

## Idempotencia

O hash canonico e vinculado a empresa, operacao, provedor e capacidade. Mesma
chave e mesmo hash retornam o recurso/resultado anterior; hash diferente e
conflito. Empresas diferentes nao colidem. Falha e retry preservam a intencao
original. Para publicacao, a autoridade local comprova empresa, media e JPEG
antes de reservar a operacao ou criar a intencao. O resultado persistido passa
por allowlist e limite de tamanho.

## Cofre e dados deliberadamente ausentes

Credenciais continuam usando `credential-service`, AES-256-GCM, AAD, keyring,
versao e rotacao existentes. A leitura aceita o estado definitivo `connected` e
recusa OAuth falho. Desconexao revoga o envelope sem descriptografar o token.

O backup logico reconhece dois perfis fechados pelo ledger: schema 0001-0003 e
schema 0001-0004. Novos bundles autenticam no manifesto o perfil, o digest do
ledger e as listas exatas de tabelas/RLS. Bundles legados no formato 2 continuam
aceitos somente quando correspondem exatamente ao schema 0001-0003; qualquer
perfil ambiguo ou trocado e recusado.

Nao sao armazenados bytes de imagem, state cru, codigo OAuth, token em texto
claro, senha, App Secret, cabecalho Authorization, resposta bruta do provedor,
URL com credencial, stack completa ou payload de rede. A midia permanece uma
referencia opaca pertencente a empresa, acompanhada apenas de digest minimo de
metadados. Referencias do provedor aceitam somente identificadores opacos por
allowlist; URLs, queries, JSON bruto e marcadores de segredo sao recusados.

## Gate fisico seguinte

Os testes locais validam contrato, SQL parametrizado, ordem transacional,
allowlists, falha fechada, ausencia de rede e regressao. A aprovacao fisica exige
PostgreSQL 18 local/descartavel, apenas em loopback e com dados sinteticos, para
aplicar 0001-0004 e provar constraints, RLS, concorrencia, rollback, cofre e
restauracao. Esse gate nao pode ser substituido por mocks e nao autoriza usar o
banco de staging.
