"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const GATE5_DOCS = path.join(ROOT, "docs", "gate5");
const LEGAL_TEMPLATES = path.join(ROOT, "src", "legal", "templates");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function occurrences(text, value) {
  return text.split(value).length - 1;
}

function main() {
  const expectedDocs = [
    "DATA_DELETION_MIGRATION_REQUIRED.md",
    "LEGAL_OWNER_DECISIONS_REQUIRED.md",
    "META_BUSINESS_IDENTITY_DISCREPANCY.md",
    "META_DASHBOARD_CHANGES_PENDING.md"
  ];
  assert.deepEqual(fs.readdirSync(GATE5_DOCS).sort(), expectedDocs.sort());

  const ownerDecisions = read("docs/gate5/LEGAL_OWNER_DECISIONS_REQUIRED.md");
  for (let decision = 1; decision <= 38; decision += 1) {
    const id = `LEG-${String(decision).padStart(2, "0")}`;
    assert.equal(ownerDecisions.includes(id), true, `Decisão ausente: ${id}`);
  }
  assert.match(ownerDecisions, /LEGAL_CONTENT_FINAL_APPROVED=NAO/);
  assert.match(ownerDecisions, /MARCO_20_CONCLUIDO=NAO/);
  assert.match(ownerDecisions, /Nenhum prazo deve ser publicado/i);

  const migration = read("docs/gate5/DATA_DELETION_MIGRATION_REQUIRED.md");
  assert.match(migration, /MIGRATION_REQUIRED=SIM/);
  assert.match(migration, /MIGRATION_CREATED=SIM/);
  assert.match(migration, /MIGRATION_APPLIED=NAO/);
  assert.match(migration, /REAL_COMPLIANCE_REPOSITORY_IMPLEMENTED=SIM/);
  assert.match(migration, /REAL_SUBFRONT_STOPPED=SIM/);
  assert.match(
    migration,
    /SYNTHETIC_TOKEN_PHYSICAL_DELETION_TEST=PENDENTE_PROVA_LINUX_ONE_SHOT/
  );
  assert.doesNotMatch(
    migration,
    /SYNTHETIC_TOKEN_PHYSICAL_DELETION_TEST=PASS/
  );
  assert.match(migration, /social_meta_subject_mappings/);
  assert.match(migration, /social_compliance_requests/);
  assert.match(migration, /social_idempotency_operations_capability_allowed/);
  assert.match(migration, /social_encrypted_credentials/);
  assert.match(migration, /instagram_user_access_token/);
  assert.match(migration, /credential_type IN \('instagram_user_access_token','access_token'\)/);
  assert.match(migration, /mesmo quando já tenham `revoked_at`/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /BYPASSRLS/);
  assert.match(migration, /DELETE \.\.\. RETURNING/);
  assert.match(migration, /REAL_DATA_DELETION_BLOCKED_BY_MIGRATION=SIM/);

  const complianceRepository = read(
    "src/persistence/postgres/meta-compliance-repository.js"
  );
  assert.match(
    complianceRepository,
    /LEAST\(\$11::timestamptz,CURRENT_TIMESTAMP\)/
  );
  assert.match(
    complianceRepository,
    /revoked_at=COALESCE\(revoked_at,CURRENT_TIMESTAMP\)/
  );
  assert.match(
    complianceRepository,
    /completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP/
  );
  assert.doesNotMatch(complianceRepository, /revoked_at=\$4/);
  assert.doesNotMatch(complianceRepository, /completed_at=\$6/);

  const dashboard = read("docs/gate5/META_DASHBOARD_CHANGES_PENDING.md");
  const requiredScopes = [
    "instagram_business_basic",
    "instagram_business_content_publish"
  ];
  const extraScopes = [
    "instagram_business_manage_messages",
    "instagram_business_manage_comments",
    "instagram_business_manage_insights"
  ];

  for (const scope of requiredScopes) {
    assert.ok(occurrences(dashboard, scope) >= 2, `Escopo mínimo ausente: ${scope}`);
  }
  for (const scope of extraScopes) {
    assert.equal(occurrences(dashboard, scope), 1, `Escopo extra inexato: ${scope}`);
  }
  assert.match(dashboard, /REQUESTED_BY_ACTIVE_OAUTH_FLOW/);
  assert.match(dashboard, /NEEDED_BY_CURRENT_PRODUCT/);
  assert.match(dashboard, /META_DASHBOARD_CHANGED=NAO/);
  assert.match(dashboard, /Access Verification como Tech Provider/);
  assert.match(dashboard, /Business Verification/);
  assert.match(dashboard, /App Review e Advanced Access/);
  assert.match(dashboard, /nos 30 dias anteriores/i);
  assert.match(dashboard, /Data Use Checkup anual/i);
  assert.match(dashboard, /não renomear/i);
  assert.match(dashboard, /instagram_business_content_publishing/);
  assert.match(
    dashboard,
    /https:\/\/ia4tube-api-staging-checkpoint-a\.onrender\.com\/v1\/social\/compliance\/meta\/deauthorization/
  );
  assert.match(
    dashboard,
    /https:\/\/ia4tube-api-staging-checkpoint-a\.onrender\.com\/v1\/social\/compliance\/meta\/data-deletion/
  );
  assert.match(dashboard, /repository PostgreSQL durável/);
  assert.match(dashboard, /DATA_DELETION_MIGRATION_REQUIRED\.md/);
  assert.doesNotMatch(dashboard, /montagem pública.*pendente/i);

  const identity = read("docs/gate5/META_BUSINESS_IDENTITY_DISCREPANCY.md");
  assert.match(identity, /APP_DISPLAY_NAME=ia4tube/);
  assert.match(identity, /APP_OWNER_OR_CLAIMED_BUSINESS=Ia4tube empresas/);
  assert.match(identity, /VERIFICATION_SCREEN_NAME=Verificação para Zé da Capicavara/);
  assert.match(identity, /F — INDETERMINADO/);
  assert.match(identity, /META_IDENTITY_RECONCILED=NAO/);
  assert.match(identity, /razão social/);
  assert.match(identity, /Business ID/);
  assert.match(identity, /identidade legal esperada/);
  assert.doesNotMatch(identity, /CLASSIFICACAO=[A-E]\b/);

  const templates = fs.readdirSync(LEGAL_TEMPLATES).sort();
  assert.deepEqual(templates, ["data-deletion.html", "privacy.html", "terms.html"]);
  for (const template of templates) {
    const html = fs.readFileSync(path.join(LEGAL_TEMPLATES, template), "utf8");
    assert.match(html, /RASCUNHO TÉCNICO PÚBLICO/);
    assert.match(html, /NÃO APROVADO JURIDICAMENTE/);
    assert.match(html, /PUBLIC TECHNICAL DRAFT/);
    assert.match(html, /NOT LEGALLY APPROVED/);
    assert.match(html, /name="robots" content="index, follow"/i);
    assert.match(html, /href="\/politica-de-privacidade"/);
    assert.match(html, /href="\/termos-de-uso"/);
    assert.match(html, /href="\/exclusao-de-dados"/);
    assert.doesNotMatch(html, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    assert.doesNotMatch(html, /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/);
    assert.doesNotMatch(html, /facebook\.com/i);
    assert.doesNotMatch(html, /reserva o endereço/i);
  }

  process.stdout.write(
    "gate5 legal readiness tests: OK (3 drafts, 4 docs, 38 decisions, 2 required + 3 extra scopes)\n"
  );
}

main();
