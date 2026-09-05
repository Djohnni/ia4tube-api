# Migration 0007: vínculo original de conta e revisão

Status: preparação e testes locais autorizados pela missão de continuidade de 2026-09-05. Não aplicada em produção nem staging. A sequência conferida no checkpoint local `a619eb422bdcb92c24b1498cc5cecc63df7a3169` termina em 0006; a árvore main observada `f9ac0e93633475218bd740cfc1e1334c6bf73e45` não contém migrations sociais.

- Identificador: `0007_social_publication_connection_binding`.
- Arquivo canônico LF: `db/migrations/0007_social_publication_connection_binding.up.sql`.
- SHA-256: `4747e001e3057b12facabb74f2529272d8c9cd4e933f55322ee9e3bc82483464`.
- Perfil anterior: `social-schema-0006`; perfil esperado: `social-schema-0007`.
- Tabela única alterada: `ia4tube_social.social_publications`; nenhum novo motor, tabela, dado secreto ou estrutura paralela.

## Dois campos e tratamento do legado

| Campo | Tipo | Finalidade | NULL/default |
| --- | --- | --- | --- |
| `bound_external_account_id` | `UUID` | Identifica a linha original da conta externa, cujo `external_id` é imutável para runtime; não é username nem a conta atualmente ativa. | NULL permitido; sem default. |
| `expected_connection_revision` | `BIGINT` | Revisão exata da conexão aceita na reserva atômica da intenção. | NULL permitido; sem default; se presente, entre 1 e 9007199254740991. |

Os dois campos devem ser ambos NULL ou ambos presentes. FK composta conserva company e connection da publicação e aponta para a chave única já existente `(company_id, connection_id, id)` de `social_external_accounts`, com `ON DELETE RESTRICT`. Não existe FK à revisão mutável da conexão.

Registros anteriores permanecem com os dois valores NULL: nenhum backfill, nenhum palpite a partir de conta atual, username, legenda, datas ou referências. Continuam visíveis pela política tenant existente. Duas políticas adicionais **restritivas**, somente para runtime, impedem INSERT sem vínculo e UPDATE de registros sem vínculo. São uma proteção relacionada aos dois campos; não substituem a política tenant, não permitem cross-tenant e não alteram ENABLE/FORCE RLS. O proprietário continua capaz de restaurar exatamente dados antigos sob os controles de recuperação existentes; isso não autoriza inventar vínculos. Histórico/reconciliação deve exibir bloqueio explícito de legado sem tentar atualizar sua publicação; compliance e leitura não ganham privilégios adicionais.

Os grants de tabela `INSERT, SELECT` existentes já abrangem as novas colunas. Nenhum grant de UPDATE é adicionado: runtime não pode trocar nenhum dos dois campos. As colunas de identidade e hash existentes continuam igualmente imutáveis. O verificador de perfil exige os tipos, nulabilidade, ausência de default/generated/identity, as três constraints validadas, duas políticas exatas e ausência de UPDATE efetivo dos campos.

O `request_hash` existente é compromisso unidirecional, não snapshot recuperável. Ele não permite recuperar a identidade/revisão original após perda do testemunho do cliente ou reconexão. O `result_payload` deve permanecer NULL durante pendência; campos de legenda/referência não são depósitos alternativos do vínculo. As duas colunas permitem recuperar o compromisso usando a conta original, enquanto a camada transacional ainda precisa conferir a revisão e a conta sob o mesmo lock antes de adquirir trabalho externo.

## SQL completo

```sql
ALTER TABLE ia4tube_social.social_publications
  ADD COLUMN bound_external_account_id UUID,
  ADD COLUMN expected_connection_revision BIGINT,
  ADD CONSTRAINT social_publications_binding_pair
    CHECK (
      (bound_external_account_id IS NULL) =
      (expected_connection_revision IS NULL)
    ),
  ADD CONSTRAINT social_publications_binding_revision_valid
    CHECK (
      expected_connection_revision IS NULL OR
      (
        expected_connection_revision >= 1 AND
        expected_connection_revision <= 9007199254740991
      )
    ),
  ADD CONSTRAINT social_publications_bound_account_fk
    FOREIGN KEY (company_id, connection_id, bound_external_account_id)
    REFERENCES ia4tube_social.social_external_accounts(company_id, connection_id, id)
    ON DELETE RESTRICT;

CREATE POLICY social_publications_bound_insert
  ON ia4tube_social.social_publications
  AS RESTRICTIVE
  FOR INSERT
  TO ia4tube_social_runtime
  WITH CHECK (
    bound_external_account_id IS NOT NULL AND
    expected_connection_revision IS NOT NULL
  );

CREATE POLICY social_publications_bound_update
  ON ia4tube_social.social_publications
  AS RESTRICTIVE
  FOR UPDATE
  TO ia4tube_social_runtime
  USING (
    bound_external_account_id IS NOT NULL AND
    expected_connection_revision IS NOT NULL
  )
  WITH CHECK (
    bound_external_account_id IS NOT NULL AND
    expected_connection_revision IS NOT NULL
  );
```

## Condições antes de uma aplicação real

Os bytes/checksums 0001–0006 permanecem inalterados. A rota genérica não pode aplicar 0007. A rota revisada deve conferir papel/infraestrutura/marker, journal exato, catálogo anterior, SQL pinado, perfil posterior e recuperação pertinente antes de COMMIT. Resultado de COMMIT incerto exige nova inspeção somente leitura, nunca reexecução automática.

A autorização da missão cobre primeiras aplicações efetivamente ausentes, após os pré-requisitos; não exige nova microautorização para os mesmos passos. Aplicação de 0007 continua condicionada à revisão independente do escopo, ensaio físico isolado, restauração comprovada, catálogo/checksums compatíveis e preservação do isolamento. O bootstrap seguro das roles/marker de produção e o material de recuperação precisam existir e ser verificados pelo operador; strings de aprovação ou testes sintéticos não substituem essa prova.

Testes físicos exigidos: par/revisão inválidos rejeitados; FK rejeita outra empresa/conexão; INSERT/UPDATE de legado bloqueados no runtime, SELECT permitido somente no tenant; tentativa de UPDATE dos dois campos negada; vínculo válido sobrevive a backup/restauração; conta original nunca muda após reconexão; transações concorrentes/resultado incerto testados junto à persistência real. Nenhum teste local de parser ou catálogo sintético é apresentado como prova física.

Gates externos continuam fechados. Nenhum deploy, troca de ambiente do serviço, OAuth, publicação, Play/A55 ou aplicação no staging faz parte desta preparação.

## Interface do runner preparado

`createMigrationRunner()` expõe `planProductionStep(request, env)` e `applyProductionStep(request, env)`. Não há CLI de produção que aceite somente um booleano de recuperação. A rota aceita o destino externo exato documentado no preflight, PostgreSQL 18, TLS, principal declarado, marcador de produção previamente preparado, papéis canônicos e o fingerprint completo da sessão de migration existente. O pool deve vir da configuração de migration TLS estrita; não reutilizar pool de webservice ou staging.

O request contém `resourceId`, `expectedApplied` (prefixo exato de versões), `migration`, `migrationSha256`, `fromProfile`, `toProfile`, `beforeCatalogSha256`, `afterCatalogSha256`, `recoveryEvidenceDigest` e `executionPackageDigest`. Os digests de catálogo usam o coletor canônico existente `readStagingExactCatalogSnapshot()` e `stagingExactCatalogDigest()`; o nome histórico desse coletor não muda o ambiente. Ele lê estruturas dos schemas social/migrations, não dados. A proteção do registro de chaves no schema admin é validada adicionalmente. Os digests precisam vir do ensaio/pacote revisado correspondente ao passo, não ser calculados automaticamente sobre qualquer catálogo encontrado e aprovados por isso.

Para produção, `options.verifyPreparationRecovery` é obrigatório no apply e deve ser implementado no operador privado: autentica o material e a revisão independente fora do Git. Retorna `verified`, `isolatedRestoreVerified` e `independentReviewApproved` verdadeiros, junto dos mesmos `targetFingerprint`, `fromProfile`, `toProfile`, `recoveryEvidenceDigest`, `executionPackageDigest`, `beforeCatalogSha256` e `afterCatalogSha256`. O runner compara todos; callback ausente ou contrato divergente é recusa antes da conexão. Esse ponto de integração não implementa sozinho armazenamento ou autenticação de evidências; produção continua bloqueada enquanto o operador privado não fornecer prova real.

Cada apply verifica o journal/catálogo dentro de lock de migration e transação, executa um SQL canônico, registra o mesmo checksum no journal, valida o perfil resultante e só então tenta COMMIT. Faz uma segunda validação somente leitura após o commit. Falha ou perda de resposta durante COMMIT marca resultado incerto, descarta conexão e exige inspeção sem retry. Uma versão já aplicada não é silenciosamente reaplicada.

Para ensaio, `planPublicationBinding`/`applyPublicationBinding` usam o mesmo gate transacional de 0007, mas aceitam somente ambiente `local`/`test`, loopback e database `ia4tube_social_test_*`, nunca produção/staging. O request é o passo 0006→0007; os quatro digests de evidência de produção não são exigidos nesse ensaio. A infraestrutura e ledger 0006 já precisam estar presentes. Isso não cria servidor, banco, credenciais, tabelas paralelas ou autorização de publicação.
