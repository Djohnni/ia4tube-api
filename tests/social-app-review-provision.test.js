"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  REVIEW_LOGIN, REVIEW_NAME, REVIEW_ORIGIN, TARGET_FINGERPRINT,
  deriveReviewIdentity, exactApproval, loadProvisionConfig, provisionAppReview, main
} = require("../scripts/social-app-review-provision");
const { readManifest } = require("../src/persistence/postgres/migrations");
const { SET_COMPANY_SCOPE_SQL } = require("../src/persistence/postgres/pool");
const { PAID_STAGING_PUBLIC_TARGET: TARGET } = require("../src/persistence/postgres/staging-provisioner");

const FAKE_SECRET = "Synthetic-Operator-Only-Never-Output-Secret-9!";
function environment(overrides = {}) {
  const env = {
    ENVIRONMENT: "staging",
    PUBLIC_API_BASE_URL: REVIEW_ORIGIN,
    REAL_REVIEWER_UI_ENABLED: "true",
    SOCIAL_EXTERNAL_CONNECTION_ENABLED: "false",
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false",
    META_APP_REVIEW_WINDOW_ENABLED: "false",
    META_APP_REVIEW_PROVISION_MODE: "provision",
    META_APP_REVIEW_LOGIN_VERIFIED: "true",
    SOCIAL_MIGRATIONS_DATABASE_URL: `postgresql://${TARGET.migrationLogin}:${FAKE_SECRET}@${TARGET.host}:5432/${TARGET.database}?sslmode=verify-full`,
    SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: TARGET_FINGERPRINT,
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: TARGET.runtimeLogin,
    SOCIAL_MIGRATIONS_EXPECTED_LOGIN: TARGET.migrationLogin,
    SOCIAL_MIGRATION_ENVIRONMENT: "staging",
    SOCIAL_MIGRATION_EXPECTED_ENVIRONMENT_ID: TARGET.environmentId,
    SOCIAL_IDENTITY_DERIVATION_KEY: Buffer.alloc(32, 43).toString("base64"),
    SOCIAL_TENANT_NAMESPACE_UUID: "e20195bc-e11e-4a9f-8560-7177f7156622",
    SOCIAL_IDENTITY_DERIVATION_VERSION: "social-id-v1"
  };
  env.META_APP_REVIEW_PROVISION_APPROVED = exactApproval(deriveReviewIdentity(env).companyId);
  return { ...env, ...overrides };
}

function fixture(options = {}) {
  const env = environment(options.env);
  const identity = deriveReviewIdentity(env);
  const state = {
    company: null, user: null, membership: null,
    scope: null, queries: [], closes: 0, connections: 0,
    presentTable: options.presentTable, commits: 0, rollbacks: 0
  };
  const row = (value) => ({ rowCount: value ? 1 : 0, rows: value ? [{ ...value }] : [] });
  let snapshot;
  const client = {
    release() {},
    async query(sql, values = []) {
      state.queries.push({ sql, values });
      if (sql === "BEGIN") {
        snapshot = structuredClone({ company: state.company, user: state.user, membership: state.membership });
        return row({});
      }
      if (sql === "COMMIT") { state.commits += 1; return row({}); }
      if (sql === "ROLLBACK") {
        Object.assign(state, snapshot);
        state.rollbacks += 1;
        return row({});
      }
      if (sql === 'SET LOCAL ROLE "ia4tube_social_owner"') return row({});
      if (sql === SET_COMPANY_SCOPE_SQL) {
        state.scope = values[0];
        assert.equal(state.scope, identity.companyId);
        return row({});
      }
      if (sql === "SELECT pg_advisory_xact_lock($1::bigint)") return row({});
      assert.equal(state.scope, identity.companyId);
      assert.equal(values[0], identity.companyId);
      if (sql.startsWith("SELECT EXISTS")) {
        return row({ present: Boolean(state.presentTable && sql.includes(`.${state.presentTable} `)) });
      }
      if (sql.startsWith("SELECT id,name,status")) return row(state.company);
      if (sql.startsWith("SELECT company_id,id,")) return row(state.user);
      if (sql.startsWith("SELECT company_id,user_id,")) return row(state.membership);
      if (sql.startsWith("INSERT INTO ia4tube_social.companies")) {
        if (state.company) return row(null);
        state.company = { id: values[0], name: values[1], status: "active", identity_derivation_version: values[2] };
        return row({ id: values[0] });
      }
      if (sql.startsWith("INSERT INTO ia4tube_social.users")) {
        if (state.user) return row(null);
        state.user = { company_id: values[0], id: values[1], login_key_digest: values[2], password_absent: true, status: "active", auth_version: 1 };
        return row({ id: values[1] });
      }
      if (sql.startsWith("INSERT INTO ia4tube_social.company_memberships")) {
        if (options.membershipFailure) throw new Error(FAKE_SECRET);
        if (state.membership) return row(null);
        state.membership = { company_id: values[0], user_id: values[1], role: "owner", status: "active" };
        return row({ user_id: values[1] });
      }
      throw new Error(`Unexpected fixture SQL: ${sql}`);
    }
  };
  const dependencies = {
    env,
    createPool() {
      return { connect: async () => { state.connections += 1; return client; } };
    },
    createRunner() {
      return { async validate() {
        const count = readManifest().length;
        return {
          valid: true, pending: options.pending || 0, applied: count,
          migrations: Array.from({ length: count }, () => ({ state: "applied" }))
        };
      } };
    },
    async closePool() { state.closes += 1; }
  };
  return { env, identity, state, dependencies };
}

test("isolated identity is derived deterministically from exact review login", () => {
  const env = environment();
  const identity = deriveReviewIdentity(env);
  assert.deepEqual(identity, deriveReviewIdentity(env));
  assert.equal(REVIEW_LOGIN, "ia4tube_meta_app_review_20260904");
  assert.equal(REVIEW_NAME, "IA4Tube — Meta App Review");
  assert.notEqual(identity.companyId, identity.userId);
  assert.equal(JSON.stringify(identity).includes(env.SOCIAL_IDENTITY_DERIVATION_KEY), false);
});

test("operator environment is staging-only, globally closed, and separately credentialed", () => {
  for (const override of [
    { ENVIRONMENT: "production" },
    { PUBLIC_API_BASE_URL: "https://production.invalid" },
    { SOCIAL_EXTERNAL_CONNECTION_ENABLED: "true" },
    { SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "true" },
    { META_APP_REVIEW_WINDOW_ENABLED: "true" },
    { REAL_REVIEWER_UI_ENABLED: "false" },
    { DATABASE_URL: "postgresql://runtime.invalid" },
    { META_APP_REVIEW_COMPANY_ID: "00000000-0000-4000-8000-000000000001" },
    { META_APP_REVIEW_LOGIN_VERIFIED: "false" },
    { META_APP_REVIEW_PROVISION_APPROVED: "yes" },
    { SOCIAL_MIGRATION_ENVIRONMENT: "production" },
    { SOCIAL_MIGRATION_EXPECTED_ENVIRONMENT_ID: "00000000-0000-4000-8000-000000000001" },
    { SOCIAL_MIGRATIONS_DATABASE_URL: `postgresql://${TARGET.runtimeLogin}:${FAKE_SECRET}@${TARGET.host}:5432/${TARGET.database}?sslmode=verify-full` },
    { SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT: "0".repeat(64) },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { PGPASSWORD: FAKE_SECRET },
    { META_APP_REVIEW_PROVISION_MODE: "delete" }
  ]) assert.throws(() => loadProvisionConfig(environment(override)));
  assert.equal(loadProvisionConfig(environment()).mode, "provision");
});

test("inspect performs zero DML and exposes only isolated public evidence", async () => {
  const f = fixture({ env: { META_APP_REVIEW_PROVISION_MODE: "inspect", META_APP_REVIEW_PROVISION_APPROVED: "" } });
  const result = await provisionAppReview(f.dependencies);
  assert.equal(result.identityReady, false);
  assert.equal(result.identityRowsInserted, 0);
  assert.equal(f.state.queries.some(({ sql }) => /^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT)/.test(sql)), false);
  assert.equal(f.state.closes, 1);
  assert.equal(JSON.stringify(result).includes(FAKE_SECRET), false);
  assert.equal(JSON.stringify(result).includes(f.env.SOCIAL_IDENTITY_DERIVATION_KEY), false);
});

test("provision inserts only three exact identity rows and repeats idempotently", async () => {
  const f = fixture();
  const first = await provisionAppReview(f.dependencies);
  assert.equal(first.identityRowsInserted, 3);
  assert.equal(first.identityRowsAlreadyExact, 0);
  assert.equal(first.identityReady, true);
  assert.equal(first.gate4Touched, false);
  assert.equal(first.externalOperationsExecuted, false);
  const second = await provisionAppReview(f.dependencies);
  assert.equal(second.identityRowsInserted, 0);
  assert.equal(second.identityRowsAlreadyExact, 3);
  assert.equal(f.state.commits, 2);
  assert.equal(f.state.closes, 2);
  assert.equal(f.state.queries.some(({ sql }) => /^(UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE)/.test(sql)), false);
  assert.equal(f.state.queries.some(({ values }) => values.includes("ia4tube_empresas_staging")), false);
});

test("existing connection, publication, credential, OAuth or idempotency state prevents writes", async () => {
  for (const presentTable of [
    "social_connections", "social_publications", "social_encrypted_credentials",
    "social_oauth_transactions", "social_idempotency_operations"
  ]) {
    const f = fixture({ presentTable });
    await assert.rejects(provisionAppReview(f.dependencies), { code: "app_review_provision_tenant_not_unused" });
    assert.equal(f.state.queries.some(({ sql }) => sql.startsWith("INSERT")), false);
    assert.equal(f.state.rollbacks, 1);
    assert.equal(f.state.closes, 1);
  }
});

test("existing identity drift is never renamed, re-associated or overwritten", async () => {
  for (const field of ["company", "user", "membership"]) {
    const f = fixture();
    await provisionAppReview(f.dependencies);
    if (field === "company") f.state.company.name = "Original Gate 4 Company";
    if (field === "user") f.state.user.id = "00000000-0000-4000-8000-000000000001";
    if (field === "membership") f.state.membership.role = "viewer";
    const before = f.state.queries.length;
    await assert.rejects(provisionAppReview(f.dependencies), { code: `app_review_provision_${field}_drift` });
    assert.equal(f.state.queries.slice(before).some(({ sql }) => sql.startsWith("INSERT")), false);
  }
});

test("failed inserts roll back all identity rows; pending schema is refused without applying", async () => {
  const f = fixture({ membershipFailure: true });
  await assert.rejects(provisionAppReview(f.dependencies));
  assert.equal(f.state.company, null);
  assert.equal(f.state.user, null);
  assert.equal(f.state.membership, null);
  assert.equal(f.state.rollbacks, 1);
  const pending = fixture({ pending: 1 });
  await assert.rejects(provisionAppReview(pending.dependencies), { code: "app_review_provision_schema_not_current" });
  assert.equal(pending.state.connections, 0);
  assert.equal(pending.state.closes, 1);
});

test("CLI refuses arguments and sanitizes even secret-bearing failures", async () => {
  const output = [];
  const sink = { write(value) { output.push(value); } };
  assert.equal(await main({ argv: [FAKE_SECRET], stdout: sink, stderr: sink }), 2);
  assert.equal(await main({ argv: [], stdout: sink, stderr: sink,
    provision: async () => { const error = new Error(FAKE_SECRET); error.code = FAKE_SECRET; throw error; }
  }), 1);
  assert.equal(output.join("").includes(FAKE_SECRET), false);
  assert.match(output.join(""), /app_review_provision_failed/);
});
