# Dimensionamento inicial do PostgreSQL social

Este documento cobre apenas o módulo social. Imagens, vídeos e arquivos de
pedidos continuam fora do PostgreSQL.

## Limites iniciais

- Pool do Web Service: mínimo `0`, padrão/máximo operacional `3` conexões por
  instância. O código recusa configuração acima de `5`.
- LOGIN permanente de runtime: `CONNECTION LIMIT 9`. Isso comporta até três
  instâncias com pool `3`, incluindo uma janela controlada de rolling deploy.
- Cada pool/worker de migration: máximo `1`. O LOGIN permanente aceita no
  máximo `2` sessões globais, mínimo necessário para concorrência/retry entre
  dois workers sob advisory lock.
- `statement_timeout`: runtime `10 s`; migration `60 s`.
- `query_timeout`: runtime `15 s`; migration `65 s`.
- `lock_timeout`: `5 s`.
- `idle_in_transaction_session_timeout`: `5 s`.
- Aquisição de conexão: `5 s`.
- Retry do harness: no máximo três tentativas, somente para falhas transitórias,
  com backoff limitado.

O limite `9` não autoriza escalar automaticamente para três instâncias. Ele é
um teto de segurança. Qualquer aumento de instâncias, pool ou limite do LOGIN
exige novo teste de carga e revisão do orçamento total de conexões.

## Gate TLS do sizing remoto

O sizing remoto usa a mesma política fail-closed do runtime: trust store
padrão, TLS `verify-full`, `rejectUnauthorized=true`, TLS 1.2 ou superior e
hostname exato. CA customizada, pinning, fingerprint de certificado, TOFU,
override ambiental ou hostname sem SAN compatível bloqueiam o teste antes da
abertura do pool.

## Gate físico de 29/07/2026

O harness foi executado no PostgreSQL gratuito isolado da prova, com limite de
memória de `256 MB`, menor que os `512 MB` considerados para o ambiente futuro.

- tarefas concorrentes: `30`;
- pool configurado e pico observado: `3`;
- sessões PostgreSQL distintas: `3`;
- falhas e retries: `0`;
- `shared_buffers`: `64 MB`;
- limite inferior do orçamento configurável, baseado nos settings de sessão
  observáveis no pico:
  `102.737.920 bytes`;
- RSS máximo do processo Node cliente: `60.239.872 bytes` (não pertence ao
  processo PostgreSQL).

O teste demonstra somente que essa carga sintética concluiu no serviço de
`256 MB` e que o orçamento configurável observado permaneceu dentro desse
ambiente. A estimativa é um limite inferior, não uma medição conservadora da
memória total do PostgreSQL: ela não inclui toda alocação interna dos backends,
cache do sistema, extensões, picos de maintenance, autovacuum ou outras
atividades concorrentes. O LOGIN sem privilégios também não pode consultar
`pg_backend_memory_contexts`.

Por isso, `512 MB` é apenas uma hipótese inicial condicionada. Antes de liberar
carga real, o mesmo perfil deve ser repetido com volume e concorrência
representativos, margem operacional e monitoramento ativo. A aprovação
permanece limitada a dados sociais leves, sem mídia, analytics ou consultas de
relatório pesadas.

## Alertas e critérios para aumentar

Monitorar:

- memória do banco acima de `75%` por 10 minutos;
- CPU acima de `70%` por 15 minutos;
- uso de conexões acima de `7` no LOGIN de runtime ou filas persistentes no
  pool;
- espera p95 de aquisição acima de `500 ms` na carga normal;
- timeouts de statement ou lock, deadlocks e rollbacks;
- armazenamento acima de `70%`, crescimento diário e previsão de 30 dias;
- latência p95 das transações sociais e taxa de erro PostgreSQL.

Aumentar o plano antes de liberar mais carga quando qualquer limite se repetir,
quando forem necessárias mais de duas instâncias estáveis, ou antes de
introduzir métricas, histórico volumoso, vídeos ou jobs analíticos.

## Planos atuais do Render

O Render não oferece uma faixa exata de `512 MB` para PostgreSQL. O plano
`Basic-256mb` fica abaixo desse valor; o próximo plano que o supera é
`Basic-1gb`. Preço e disponibilidade precisam ser reconfirmados no dashboard
imediatamente antes da contratação.
