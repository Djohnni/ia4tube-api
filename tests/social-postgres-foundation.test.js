"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  SET_COMPANY_SCOPE_SQL,
  SocialPersistenceError,
  createCompanyScopedRepository
} = require("../src/persistence/postgres/company-scoped-repository");

const companyA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const companyB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const userA = "11111111-1111-4111-8111-111111111111";
const mappingA = "22222222-2222-4222-8222-222222222222";
const targetA = "33333333-3333-4333-8333-333333333333";
const syntheticDatabaseUrl =
  "postgresql://synthetic.invalid/ia4tube_social_test";

function createFakePool({
  rows = [],
  failWhen = () => false,
  resultFor,
  rollbackFails = false
} = {}) {
  const state = {
    connectCalls: 0,
    released: 0,
    discardedWithError: 0,
    queries: []
  };
  const client = {
    async query(text, values = []) {
      state.queries.push({ text, values: [...values] });
      if (text === "ROLLBACK" && rollbackFails) {
        throw new Error("synthetic rollback failure");
      }
      if (failWhen(text, values)) {
        throw new Error("synthetic query failure");
      }
      if (typeof resultFor === "function") {
        return resultFor(text, values, state);
      }
      return { rows };
    },
    release(error) {
      state.released += 1;
      if (error) state.discardedWithError += 1;
    }
  };
  return {
    pool: {
      async connect() {
        state.connectCalls += 1;
        return client;
      }
    },
    state
  };
}

function assertErrorCode(expectedCode) {
  return (error) =>
    error instanceof SocialPersistenceError &&
    error.code === expectedCode;
}

test("DATABASE_URL is mandatory and fails before the pool is used", () => {
  const { pool, state } = createFakePool();
  for (const databaseUrl of [
    undefined,
    "",
    " https://database.invalid/ia4tube",
    "https://database.invalid/ia4tube",
    "postgresql://synthetic.invalid"
  ]) {
    assert.throws(
      () => createCompanyScopedRepository({ pool, databaseUrl }),
      (error) =>
        error instanceof SocialPersistenceError &&
        ["database_url_missing", "database_url_invalid"].includes(error.code)
    );
  }
  assert.equal(state.connectCalls, 0);
});

test("an injected pool is mandatory and no connection is created implicitly", () => {
  assert.throws(
    () =>
      createCompanyScopedRepository({
        databaseUrl: syntheticDatabaseUrl
      }),
    assertErrorCode("postgres_pool_required")
  );
});

test("company_id is required before opening a transaction", async () => {
  const { pool, state } = createFakePool();
  const repository = createCompanyScopedRepository({
    pool,
    databaseUrl: syntheticDatabaseUrl
  });

  for (const companyId of [
    undefined,
    "",
    "not-a-uuid",
    "00000000-0000-0000-0000-000000000000"
  ]) {
    await assert.rejects(
      repository.withCompanyTransaction(companyId, async () => null),
      assertErrorCode("company_id_required")
    );
  }
  assert.equal(state.connectCalls, 0);
});

test("a company transaction sets local tenant scope and commits", async () => {
  const { pool, state } = createFakePool();
  const repository = createCompanyScopedRepository({
    pool,
    databaseUrl: syntheticDatabaseUrl
  });

  const value = await repository.withCompanyTransaction(
    companyA,
    async (transaction) => {
      assert.equal(transaction.companyId, companyA);
      await transaction.query("SELECT $1::uuid AS company_id", [companyA]);
      return "committed";
    }
  );

  assert.equal(value, "committed");
  assert.deepEqual(
    state.queries.map(({ text }) => text),
    [
      "BEGIN",
      SET_COMPANY_SCOPE_SQL,
      "SELECT $1::uuid AS company_id",
      "COMMIT"
    ]
  );
  assert.deepEqual(state.queries[1].values, [companyA]);
  assert.equal(state.queries.some(({ text }) => text === "ROLLBACK"), false);
  assert.equal(state.released, 1);
});

test("a failing operation is rolled back and never committed", async () => {
  const { pool, state } = createFakePool();
  const repository = createCompanyScopedRepository({
    pool,
    databaseUrl: syntheticDatabaseUrl
  });
  const syntheticFailure = new Error("synthetic operation failure");

  await assert.rejects(
    repository.withCompanyTransaction(companyA, async (transaction) => {
      await transaction.query("SELECT $1::uuid", [companyA]);
      throw syntheticFailure;
    }),
    (error) => error === syntheticFailure
  );

  assert.deepEqual(
    state.queries.map(({ text }) => text),
    [
      "BEGIN",
      SET_COMPANY_SCOPE_SQL,
      "SELECT $1::uuid",
      "ROLLBACK"
    ]
  );
  assert.equal(state.queries.some(({ text }) => text === "COMMIT"), false);
  assert.equal(state.released, 1);
});

test("failure while establishing tenant scope also rolls back", async () => {
  const { pool, state } = createFakePool({
    failWhen: (text) => text === SET_COMPANY_SCOPE_SQL
  });
  const repository = createCompanyScopedRepository({
    pool,
    databaseUrl: syntheticDatabaseUrl
  });

  await assert.rejects(
    repository.withCompanyTransaction(companyA, async () => {
      throw new Error("operation must not run");
    }),
    /synthetic query failure/
  );
  assert.deepEqual(
    state.queries.map(({ text }) => text),
    ["BEGIN", SET_COMPANY_SCOPE_SQL, "ROLLBACK"]
  );
  assert.equal(state.released, 1);
});

test("rollback failure destroys the client instead of returning scoped state to pool", async () => {
  const { pool, state } = createFakePool({ rollbackFails: true });
  const repository = createCompanyScopedRepository({
    pool,
    databaseUrl: syntheticDatabaseUrl
  });

  await assert.rejects(
    repository.withCompanyTransaction(companyA, async () => {
      throw new Error("synthetic operation failure");
    }),
    assertErrorCode("postgres_rollback_failed")
  );
  assert.equal(state.released, 1);
  assert.equal(state.discardedWithError, 1);
  assert.equal(state.queries.at(-1).text, "ROLLBACK");
});

test("membership lookup binds the same company to scope and query", async () => {
  const { pool, state } = createFakePool({
    rows: [{
      company_id: companyA,
      user_id: userA,
      role: "owner",
      status: "active"
    }]
  });
  const repository = createCompanyScopedRepository({
    pool,
    databaseUrl: syntheticDatabaseUrl
  });

  const membership = await repository.findMembership({
    companyId: companyA,
    userId: userA
  });

  assert.equal(membership.company_id, companyA);
  assert.deepEqual(state.queries[1].values, [companyA]);
  assert.match(state.queries[2].text, /WHERE company_id = \$1/);
  assert.deepEqual(state.queries[2].values, [companyA, userA]);
  assert.equal(
    state.queries.some(({ values }) => values.includes(companyB)),
    false
  );
});

test("legacy mapping is tenant-scoped, parameterized and idempotent", async () => {
  const { pool, state } = createFakePool({
    rows: [{
      id: mappingA,
      company_id: companyA,
      source_sha256: "a".repeat(64),
      target_entity_type: "user",
      target_entity_id: targetA
    }]
  });
  const repository = createCompanyScopedRepository({
    pool,
    databaseUrl: syntheticDatabaseUrl
  });

  const mapping = await repository.recordLegacyMapping({
    id: mappingA,
    migrationVersion: "0001_social_multitenant_foundation",
    companyId: companyA,
    sourceSystem: "legacy-json",
    sourceEntityType: "client",
    sourceEntityId: "synthetic-legacy-id",
    sourceSha256: "a".repeat(64),
    targetEntityType: "user",
    targetEntityId: targetA
  });

  assert.equal(mapping.company_id, companyA);
  const insert = state.queries[2];
  assert.match(insert.text, /ON CONFLICT/);
  assert.match(insert.text, /DO NOTHING/);
  assert.doesNotMatch(insert.text, /DO UPDATE/);
  assert.equal(insert.text.includes("synthetic-legacy-id"), false);
  assert.deepEqual(insert.values, [
    mappingA,
    "0001_social_multitenant_foundation",
    companyA,
    "legacy-json",
    "client",
    "synthetic-legacy-id",
    "a".repeat(64),
    "user",
    targetA
  ]);
});

test("an identical legacy mapping replay returns the existing target", async () => {
  const existing = {
    id: mappingA,
    company_id: companyA,
    source_sha256: "a".repeat(64),
    target_entity_type: "user",
    target_entity_id: targetA
  };
  const { pool, state } = createFakePool({
    resultFor(text) {
      if (text.startsWith("INSERT INTO legacy_entity_mappings")) {
        return { rows: [] };
      }
      if (text.startsWith("SELECT id, company_id, source_sha256")) {
        return { rows: [existing] };
      }
      return { rows: [] };
    }
  });
  const repository = createCompanyScopedRepository({
    pool,
    databaseUrl: syntheticDatabaseUrl
  });

  const replay = await repository.recordLegacyMapping({
    id: mappingA,
    migrationVersion: "0001_social_multitenant_foundation",
    companyId: companyA,
    sourceSystem: "legacy-json",
    sourceEntityType: "client",
    sourceEntityId: "synthetic-legacy-id",
    sourceSha256: "a".repeat(64),
    targetEntityType: "user",
    targetEntityId: targetA
  });

  assert.deepEqual(replay, existing);
  assert.equal(
    state.queries.filter(({ text }) =>
      text.startsWith("INSERT INTO legacy_entity_mappings")
    ).length,
    1
  );
  assert.equal(
    state.queries.filter(({ text }) =>
      text.startsWith("SELECT id, company_id, source_sha256")
    ).length,
    1
  );
  assert.equal(state.queries.at(-1).text, "COMMIT");
});

test("a divergent legacy mapping replay fails closed and rolls back", async () => {
  const { pool, state } = createFakePool({
    resultFor(text) {
      if (text.startsWith("INSERT INTO legacy_entity_mappings")) {
        return { rows: [] };
      }
      if (text.startsWith("SELECT id, company_id, source_sha256")) {
        return {
          rows: [{
            id: mappingA,
            company_id: companyA,
            source_sha256: "b".repeat(64),
            target_entity_type: "user",
            target_entity_id: targetA
          }]
        };
      }
      return { rows: [] };
    }
  });
  const repository = createCompanyScopedRepository({
    pool,
    databaseUrl: syntheticDatabaseUrl
  });

  await assert.rejects(
    repository.recordLegacyMapping({
      id: mappingA,
      migrationVersion: "0001_social_multitenant_foundation",
      companyId: companyA,
      sourceSystem: "legacy-json",
      sourceEntityType: "client",
      sourceEntityId: "synthetic-legacy-id",
      sourceSha256: "a".repeat(64),
      targetEntityType: "user",
      targetEntityId: targetA
    }),
    assertErrorCode("legacy_mapping_conflict")
  );

  assert.equal(state.queries.at(-1).text, "ROLLBACK");
  assert.equal(state.queries.some(({ text }) => text === "COMMIT"), false);
});

test("SQL migrations are minimal, tenant-scoped and reversible", () => {
  const migrationsDir = path.resolve(__dirname, "..", "db", "migrations");
  const up = fs.readFileSync(
    path.join(
      migrationsDir,
      "0001_social_multitenant_foundation.up.sql"
    ),
    "utf8"
  );
  const down = fs.readFileSync(
    path.join(
      migrationsDir,
      "0001_social_multitenant_foundation.down.sql"
    ),
    "utf8"
  );

  for (const table of [
    "schema_migrations",
    "companies",
    "users",
    "company_memberships",
    "legacy_entity_mappings"
  ]) {
    assert.match(up, new RegExp(`CREATE TABLE ${table}\\b`));
    assert.match(down, new RegExp(`DROP TABLE IF EXISTS ${table}\\b`));
  }

  assert.match(up, /company_id UUID NOT NULL/g);
  assert.equal((up.match(/ENABLE ROW LEVEL SECURITY/g) || []).length, 3);
  assert.equal((up.match(/FORCE ROW LEVEL SECURITY/g) || []).length, 3);
  assert.equal(
    (up.match(/current_setting\('ia4tube\.company_id', true\)/g) || [])
      .length,
    6
  );
  assert.match(up, /^BEGIN;/);
  assert.match(up, /COMMIT;\s*$/);
  assert.match(down, /^BEGIN;/);
  assert.match(down, /COMMIT;\s*$/);
  assert.doesNotMatch(up, /\bINSERT\s+INTO\s+(clientes|pedidos)\b/i);
  assert.doesNotMatch(up + down, /\bCASCADE\b/i);
  assert.doesNotMatch(
    up + down,
    /firebase|fcm|instagram|oauth|ia4tube-api\.onrender\.com/i
  );
});
