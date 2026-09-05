# Preparação do PostgreSQL social de produção

## Escopo desta entrega

`scripts/production-social-db-preflight.js` é um operador separado do servidor HTTP. Existe somente a operação `inspect`: catálogo sanitizado, em uma conexão, transação `REPEATABLE READ READ ONLY`, seguida de `ROLLBACK` e encerramento da conexão. Não existe modo de aplicação, provisionamento, backup, restauração ou migração; nenhum resultado deste operador autoriza uma escrita.

O destino foi observado no recurso oficial em 2026-09-05, não inferido do staging:

| Campo | Identidade fixa |
| --- | --- |
| Recurso | `dpg-dae4tmf40ujc73dr2dog-a` |
| Hostname interno observado | `dpg-dae4tmf40ujc73dr2dog-a` |
| Host externo observado | `dpg-dae4tmf40ujc73dr2dog-a.oregon-postgres.render.com` |
| Porta | `5432` explícita |
| Database | `ia4tube_social_production` |
| PostgreSQL permitido | major 18 |
| Fingerprint do destino | `6d21299b8c02250cf3493128557f52ff95e83397cba4d92dccaa52996485c17c` |

O fingerprint usa `databaseTargetFingerprint()` existente e não inclui senha ou usuário. A ligação entre o hostname e o ID do recurso vem da observação oficial; SQL não verifica o inventário nem a configuração de cobrança do provedor. O hostname interno não é fallback de conexão externa.

## Fronteira operacional

Antes de carregar `pg` ou conectar, o operador exige comando exato, aprovação de inspeção, URL exata, TLS estrito e os sete checksums locais: os seis históricos preservados e a adição 0007 autorizada na missão de continuidade. URL exige usuário/senha, porta explícita e somente `sslmode=verify-full`; rejeita outro banco, host, parâmetro ou fragmento. Não há override de destino na CLI.

São reutilizados `loadSystemPostgresTls()` e os certificados de confiança padrão, validação de cadeia, SAN/hostname exato, `rejectUnauthorized: true` e TLS mínimo 1.2. Não há CA customizada nem bypass de verificação. Overrides ambientais libpq, Node/OpenSSL e custom trust são recusados; o processo chamador deve recusá-los **antes de iniciar Node**, pois um preload pode executar antes do script. Não alterar ambiente global nem ambiente do webservice para executar esta inspeção.

Limites: conexão 5 segundos; query e statement 10 segundos; lock 5 segundos; transação ociosa 10 segundos; `search_path=pg_catalog`; sessão inicia com `default_transaction_read_only=on`. Eventos de erro assíncronos do cliente PostgreSQL também invalidam a inspeção e não são impressos. O wrapper privado deve capturar stdout/stderr, emitir somente o JSON sanitizado e nunca repassar diagnóstico bruto de processo, URL, usuário, senha ou objeto de configuração.

### Entrada privada

A CLI aceita somente:

```text
node scripts/production-social-db-preflight.js inspect
```

Para um processo filho com ambiente efêmero, os nomes são `PRODUCTION_SOCIAL_PREFLIGHT_DATABASE_URL` e `PRODUCTION_SOCIAL_PREFLIGHT_APPROVED`. A aprovação exata é `INSPECT_IA4TUBE_SOCIAL_PRODUCTION_CATALOG`. Não colocar valores secretos na linha de comando, histórico, relatório, arquivo versionado, saída ou variável do serviço.

Preferencialmente, o helper privado recebe a credencial por pipe/stdin e invoca a API exportada em memória:

```javascript
const { inspectProductionDatabase, READ_APPROVAL, safeFailure } =
  require("./scripts/production-social-db-preflight");
// url: recebido somente do canal privado; nunca imprimir ou persistir aqui.
try {
  const report = await inspectProductionDatabase({ url, approval: READ_APPROVAL });
  // Emitir apenas report; o wrapper deve validar o envelope e o exit code.
} catch (error) {
  const code = safeFailure(error).code;
  // Emitir somente { ok: false, readOnly: true, applyAvailable: false, code }.
}
```

A API cria apenas um objeto efêmero; não modifica `process.env`. Helpers sintéticos exportados para teste não são rotas de comando nem permissões de mudança de destino.

## O que o relatório verifica

- Database e principal da sessão iguais aos parâmetros fixados; PostgreSQL 18, SSL e transação somente leitura confirmados no servidor antes de considerar metadados da aplicação.
- Contagens de schemas, relações, funções, tipos e extensões fora do conjunto social conhecido; nenhum nome arbitrário de objeto é emitido.
- Atributos do principal atual e presença/atributos dos três papéis canônicos `ia4tube_social_owner`, `ia4tube_social_migrator` e `ia4tube_social_runtime`; apenas contagem de membros, sem nomes de logins.
- `CONNECT` público no database e `CREATE` público no schema `public` como sinais para revisão, sem revogação automática.
- Presença, tipo ordinário e privilégio de leitura do ledger e do marcador. Só os metadados conhecidos e legíveis são lidos, limitados a oito linhas do ledger e duas do marcador. Nenhuma tabela de clientes, mídia, tokens ou publicações é consultada.
- Se houver ledger legível, prefixo exato e checksums 0001–0007; se houver marcador legível, ambiente `production` e formato UUID. O UUID não é emitido e **não** é comparado com uma identidade previamente aprovada nesta inspeção.

`ok: true` significa apenas que a inspeção terminou. `baselineCandidate: true` significa ausência dos objetos contados e papéis canônicos, não banco comprovadamente seguro, cobertura completa do cluster ou recuperação validada. Atributos de papéis não provam grafo completo de memberships, ownership, ACLs efetivas, FORCE RLS ou isolamento entre tenants. Papéis são globais à instância; estes três nomes não devem ser reutilizados cegamente em outro database da mesma instância.

O relatório sempre contém `applyAvailable: false` e os bloqueios de recuperação, ausência de apply neste operador read-only, revisão de 0005/0006, prova isolada de 0007 e prova comportamental de RLS. Objetos inesperados, privilégios ausentes ou atributos incompatíveis acrescentam bloqueios. Um erro de identidade, checksum, marcador, consulta ou encerramento não vira resultado parcial aprovado.

## Checksums e rota ainda não liberada

Os seis SQL históricos e seus hashes permanecem imutáveis; `checksums.json` acrescenta somente 0007, cujo SQL completo, finalidade e pin constam em `docs/social-publication-binding-migration-0007.md`. O operador verifica os **bytes reais**, sem normalizar fim de linha nem substituir checksum. Os SQL canônicos usam LF; uma cópia CRLF deve ser corrigida para os bytes canônicos, nunca aceita por relaxamento do verificador.

Não reutilizar o provisionador de staging: ele fixa identidade de staging, e suas proteções não constituem autorização para produção. O aplicador genérico em `src/persistence/postgres/migrations.js` continua recusando 0005 pendente em produção, 0006 e agora 0007 pendentes no fluxo genérico. A nova rota `planProductionStep`/`applyProductionStep` é separada, pinada ao destino acima e limitada a uma próxima migration por chamada; exige infraestrutura/marker canônicos previamente preparados, journal exato, catálogo antes/depois, SQL pinado e verificador privado de recuperação obrigatório. Sem essa prova, recusa antes de abrir o pool. O preflight não chama essa rota nem contorna qualquer bloqueio.

## Recuperação e sequência futura, ainda não executada aqui

1. Capturar o catálogo sanitizado do destino exato, confirmar sua identidade externa e revisar privilégios e objetos. Arquivar somente evidência sem credenciais; o relatório não é um backup.
2. Definir e comprovar destino de recuperação isolado, sem webservice ou conexões ao staging. O inventário local anterior não encontrou PostgreSQL 18 ou Docker operáveis; WSL informou não instalado. Ter scripts de harness não prova que o ambiente existe. Não instalar ou criar recurso pago implicitamente.
3. Preparar proteção de arquivos fora do Git, controle de acesso, cifragem e chave separada, espaço livre suficiente e operações de sincronização exigidas pelo operador de backup/restauração. Não considerar um caminho de pasta ou DPAPI de uma credencial como prova de backup do banco.
4. Para baseline realmente vazio, revisar uma captura/restauração explícita desse perfil: o operador de backup social existente usa perfis a partir de 0003, não perfil zero. Não fingir que um baseline vazio satisfaz o manifesto de um esquema 0003–0007. Para conteúdo existente, usar o perfil exato e comprovar compatibilidade de catálogo/ledger antes de exportar.
5. Restaurar somente em destino novo e isolado; verificar autenticação e checksums do pacote, schema, ledger, ownership, ACLs, memberships, FORCE RLS, comportamento cross-tenant e ausência de conexões com o serviço. Evidência histórica de staging não prova recuperação de produção. Um backup PostgreSQL também não cobre os arquivos de `DATA_DIR` do serviço antigo.
6. Só após a prova de recuperação e revisão independente, executar as primeiras aplicações ausentes 0001–0006 e a adição 0007 sob as condições da autorização de continuidade. Não pedir novamente autorização para esses mesmos passos. Mudança além dos dois campos documentados não está incluída. Não trocar configuração do webservice, fazer deploy, OAuth ou publicação como consequência desta inspeção.

## Verificação focal local

```text
node --check scripts/production-social-db-preflight.js
node --test tests/production-social-db-preflight.test.js
```

Os testes usam somente clientes sintéticos em memória, fixtures sem credenciais reais e leitura de hashes dos SQL locais. Cobrem destino/TLS, recusa de comandos de escrita, sanitização, transação/rollback, metadados limitados, deriva de checksums e erros assíncronos. Não conectam ao PostgreSQL, não executam SQL real nem provam recuperação ou prontidão de produção.
