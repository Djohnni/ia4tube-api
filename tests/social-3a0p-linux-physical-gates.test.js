"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createLocalVerifierPoolClass,
  createTenant,
  databaseContainsMarker,
  runRlsAndRoleGate,
  runRlsRuntimeWriteContractReproduction,
  runVaultSupplementalGate
} = require("../scripts/social-3a0p-linux-physical-gates");

const ROOT = path.resolve(__dirname, "..");

function postgresError(code) {
  return Object.assign(new Error("synthetic postgres refusal"), { code });
}

function legacyFailureCode(error) {
  const candidate = String(error?.code || error?.message || "");
  return /^[a-z][a-z0-9_]{2,119}$/.test(candidate)
    ? candidate
    : "linux_gate_unclassified_failure";
}

function createRlsDatabase(options = {}) {
  const companies = new Set();
  const users = new Set();
  const auditEvents = new Set();
  const calls = [];
  const releases = [];
  let inventoryCalls = 0;
  const key = (companyId, id) => `${companyId}:${id}`;

  class Client {
    constructor(kind) {
      this.kind = kind;
      this.companyId = null;
      this.invalidCompanyContext = false;
      this.manualScopeClient = false;
    }

    async query(text, values = []) {
      const sql = String(text);
      calls.push({
        kind: this.kind,
        sql,
        values: [...values],
        manualScopeClient: this.manualScopeClient
      });
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "COMMIT" || sql === "ROLLBACK") {
        this.companyId = null;
        this.invalidCompanyContext = false;
        return { rows: [] };
      }
      if (sql.startsWith("SET LOCAL ROLE")) {
        if (!sql.includes('"')) this.manualScopeClient = true;
        return { rows: [] };
      }
      if (sql.includes("set_config('ia4tube.company_id'")) {
        this.companyId = values[0];
        this.invalidCompanyContext = values[0] === "not-a-uuid";
        return { rows: [{ set_config: values[0] }] };
      }
      if (sql.includes("INSERT INTO ia4tube_social.companies")) {
        companies.add(values[0]);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO ia4tube_social.users")) {
        if (this.kind === "runtime") {
          if (options.persistUserOnRuntimeFailure) users.add(key(values[0], values[1]));
          throw postgresError(options.userInsertFailureCode || "42501");
        }
        users.add(key(values[0], values[1]));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO ia4tube_social.company_memberships")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO ia4tube_social.social_audit_events")) {
        if (this.kind !== "runtime" || values[0] !== this.companyId) {
          if (options.persistCrossBeforeFailure) auditEvents.add(key(values[0], values[1]));
          throw postgresError(options.crossWriteFailureCode || "42501");
        }
        auditEvents.add(key(values[0], values[1]));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("FROM ia4tube_social.users WHERE company_id=$1 AND id=$2")) {
        return { rows: [{ n: users.has(key(values[0], values[1])) ? 1 : 0 }] };
      }
      if (sql.includes("FROM ia4tube_social.social_audit_events") && sql.includes("WHERE company_id=$1")) {
        const visible = this.companyId === values[0] && auditEvents.has(key(values[0], values[1]));
        return { rows: [{ n: visible ? 1 : 0 }] };
      }
      if (sql.includes("SELECT 1::integer AS n")) {
        return { rows: [{ n: options.runtimePoolReusable === false ? 0 : 1 }] };
      }
      if (sql.includes("FROM ia4tube_social.companies")) {
        if (this.invalidCompanyContext) throw postgresError("22P02");
        if (!sql.includes("WHERE id=$1")) return { rows: [{ n: 0 }] };
        const visible = options.connectionScopeLeaks === true && this.manualScopeClient
          ? companies.has(values[0])
          : this.companyId === values[0] && companies.has(values[0]);
        return { rows: [{ n: visible ? 1 : 0 }] };
      }
      throw new Error(`unexpected synthetic query: ${sql}`);
    }

    release() {
      releases.push({ kind: this.kind, manualScopeClient: this.manualScopeClient });
      if (options.manualScopeReleaseFailure && this.manualScopeClient) {
        throw postgresError("release_cleanup_failed");
      }
    }
  }

  const migration = {
    async connect() { return new Client("migration"); },
    async query(text) {
      const sql = String(text);
      calls.push({ kind: "migration-pool", sql, values: [] });
      if (sql.includes("AS core_user_insert")) {
        inventoryCalls += 1;
        return { rows: [{
          runtime_login_can_set_role: options.runtimeLoginCanSetRole !== false,
          runtime_login_core_user_insert: options.runtimeLoginUserInsertPrivilege === true,
          core_user_insert: options.userInsertPrivilege === true ||
            (options.mutatePrivilegeAfterRefusal === true && inventoryCalls > 1),
          social_audit_insert: options.auditInsertPrivilege !== false,
          social_audit_rls_enabled: options.auditRlsEnabled !== false,
          social_audit_company_policy: options.auditCompanyPolicy !== false &&
            options.auditPolicyAppliesToRuntime !== false
        }] };
      }
      if (sql.includes("SELECT rolsuper")) {
        return { rows: [{
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          migrator_member: false,
          migration_table_privilege: false,
          migration_schema_create: false
        }] };
      }
      throw new Error(`unexpected synthetic pool query: ${sql}`);
    }
  };
  const runtime = {
    async connect() { return new Client("runtime"); }
  };
  return {
    state: { pools: { migration, runtime } },
    calls,
    releases,
    companies,
    users,
    auditEvents
  };
}

function reproductionProof(overrides = {}) {
  return Object.freeze({
    runtimeWriteContractReproductionPassed: true,
    tenantSeedsCreatedByAdministrativeRole: true,
    runtimeCoreUserInsertPrivilege: false,
    runtimeCoreUserInsertRefused: true,
    runtimeCoreUserInsertPersisted: false,
    runtimePoolUsableAfterRefusal: true,
    runtimePrivilegesUnchanged: true,
    socialAuditEventInsertPrivilege: true,
    socialAuditEventsRlsProtected: true,
    oldGateLaterStagesReached: false,
    ...overrides
  });
}

test("old runtime write contract reproduces 42501 before every corrected write stage", async () => {
  const database = createRlsDatabase();
  const substeps = [];
  const result = await runRlsRuntimeWriteContractReproduction(database.state, {
    legacyFailureCode,
    async runSubstep(name, operation) {
      substeps.push(name);
      return operation();
    }
  });
  assert.deepEqual(result, reproductionProof());
  assert.deepEqual(substeps, [
    "rls_seed_tenants",
    "rls_privilege_inventory",
    "rls_core_user_insert_reproduction",
    "rls_core_user_insert_refusal",
    "rls_privilege_inventory"
  ]);
  const runtimeUserWrites = database.calls.filter((call) =>
    call.kind === "runtime" && call.sql.includes("INSERT INTO ia4tube_social.users")
  );
  assert.equal(runtimeUserWrites.length, 1);
  assert.equal(database.calls.some((call) =>
    call.sql.includes("INSERT INTO ia4tube_social.social_audit_events")
  ), false);
  assert.equal(database.users.size, 2);
  assert.equal(database.calls.filter((call) => call.sql === "ROLLBACK").length, 1);
  assert.equal(database.calls.some((call) => call.sql.includes("SELECT 1::integer AS n")), true);
});

test("reproduction stops before the old insert when runtime unexpectedly owns users INSERT", async () => {
  const database = createRlsDatabase({ userInsertPrivilege: true });
  const substeps = [];
  await assert.rejects(
    runRlsRuntimeWriteContractReproduction(database.state, {
      legacyFailureCode,
      async runSubstep(name, operation) {
        substeps.push(name);
        return operation();
      }
    }),
    { code: "linux_gate_rls_core_user_insert_privilege_unexpected" }
  );
  assert.deepEqual(substeps, ["rls_seed_tenants", "rls_privilege_inventory"]);
  assert.equal(database.calls.some((call) =>
    call.kind === "runtime" && call.sql.includes("INSERT INTO ia4tube_social.users")
  ), false);
});

test("privilege inventory seals SET ROLE and refuses direct login identity writes", async () => {
  for (const [options, code] of [
    [{ runtimeLoginCanSetRole: false }, "linux_gate_rls_runtime_role_set_missing"],
    [{ runtimeLoginUserInsertPrivilege: true }, "linux_gate_rls_core_user_insert_privilege_unexpected"]
  ]) {
    const database = createRlsDatabase(options);
    await assert.rejects(
      runRlsRuntimeWriteContractReproduction(database.state, {
        legacyFailureCode,
        runSubstep: (_name, operation) => operation()
      }),
      { code }
    );
    assert.equal(database.calls.some((call) =>
      call.kind === "runtime" && call.sql.includes("INSERT INTO ia4tube_social.users")
    ), false);
  }
});

test("privilege inventory pins the exact audit policy and both tenant expressions", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "scripts/social-3a0p-linux-physical-gates.js"),
    "utf8"
  );
  assert.match(source, /policy\.polname='social_audit_events_company_scope'/);
  assert.match(source, /policy\.polroles=ARRAY\[0::oid\]/);
  assert.match(source, /pg_get_expr\(policy\.polqual,policy\.polrelid\)/);
  assert.match(source, /pg_get_expr\(policy\.polwithcheck,policy\.polrelid\)/);
  assert.equal((source.match(/\/length\('company_id'\)>=2/g) || []).length, 2);
  assert.match(source, /position\('ia4tube\.company_id'/);
});

test("reproduction fails closed when users refusal or audit write surface diverges", async () => {
  for (const [options, code] of [
    [{ userInsertFailureCode: "23505" }, "linux_gate_rls_core_user_insert_reproduction_invalid"],
    [{ auditInsertPrivilege: false }, "linux_gate_rls_social_audit_insert_privilege_missing"],
    [{ auditRlsEnabled: false }, "linux_gate_rls_social_audit_policy_invalid"],
    [{ auditCompanyPolicy: false }, "linux_gate_rls_social_audit_policy_invalid"],
    [{ auditPolicyAppliesToRuntime: false }, "linux_gate_rls_social_audit_policy_invalid"]
  ]) {
    const database = createRlsDatabase(options);
    await assert.rejects(
      runRlsRuntimeWriteContractReproduction(database.state, {
        legacyFailureCode,
        runSubstep: (_name, operation) => operation()
      }),
      { code }
    );
    assert.equal(database.calls.some((call) =>
      call.sql.includes("INSERT INTO ia4tube_social.social_audit_events")
    ), false);
  }
});

test("every post-insert reproduction failure retains its exact closed substep", async () => {
  for (const [options, code, lastSubstep] of [
    [{ persistUserOnRuntimeFailure: true }, "linux_gate_rls_core_user_insert_persisted", "rls_core_user_insert_refusal"],
    [{ runtimePoolReusable: false }, "linux_gate_rls_runtime_pool_unusable_after_refusal", "rls_core_user_insert_refusal"],
    [{ mutatePrivilegeAfterRefusal: true }, "linux_gate_rls_runtime_privilege_changed", "rls_privilege_inventory"]
  ]) {
    const database = createRlsDatabase(options);
    const substeps = [];
    await assert.rejects(
      runRlsRuntimeWriteContractReproduction(database.state, {
        legacyFailureCode,
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code }
    );
    assert.equal(substeps.at(-1), lastSubstep);
    assert.equal(substeps.includes("rls_own_social_write"), false);
  }
});

test("reproduction requires the old numeric SQLSTATE classification in the physical substep", async () => {
  for (const classifier of [undefined, () => "postgres_insufficient_privilege"]) {
    const database = createRlsDatabase();
    const substeps = [];
    await assert.rejects(
      runRlsRuntimeWriteContractReproduction(database.state, {
        legacyFailureCode: classifier,
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code: "linux_gate_rls_legacy_failure_classification_invalid" }
    );
    assert.equal(substeps.at(-1), "rls_core_user_insert_reproduction");
  }
});

test("corrected RLS gate has no fallback around base or reproduction prerequisites", async () => {
  const runSubstep = (_name, operation) => operation();
  const baseMissing = createRlsDatabase();
  await assert.rejects(
    runRlsAndRoleGate(baseMissing.state, { runSubstep, reproduction: reproductionProof() }),
    { code: "linux_gate_rls_base_gate_prerequisite_missing" }
  );
  assert.equal(baseMissing.calls.length, 0);
  for (const reproduction of [
    undefined,
    reproductionProof({ runtimeCoreUserInsertRefused: false })
  ]) {
    const database = createRlsDatabase();
    const substeps = [];
    await assert.rejects(
      runRlsAndRoleGate(database.state, {
        baseRlsGatePassed: true,
        reproduction,
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code: "linux_gate_rls_runtime_write_reproduction_required" }
    );
    assert.deepEqual(substeps, ["rls_seed_tenants", "rls_core_user_insert_refusal"]);
    assert.equal(database.calls.some((call) =>
      call.sql.includes("INSERT INTO ia4tube_social.social_audit_events")
    ), false);
  }
});

test("corrected RLS gate writes own audit events and rejects both cross-tenant directions", async () => {
  const database = createRlsDatabase();
  const substeps = [];
  const result = await runRlsAndRoleGate(database.state, {
    baseRlsGatePassed: true,
    reproduction: reproductionProof(),
    async runSubstep(name, operation) {
      substeps.push(name);
      return operation();
    }
  });
  assert.deepEqual(substeps, [
    "rls_seed_tenants",
    "rls_core_user_insert_refusal",
    "rls_bidirectional_read",
    "rls_missing_context",
    "rls_tampered_context",
    "rls_own_social_write",
    "rls_cross_tenant_write",
    "rls_connection_scope_reset",
    "rls_runtime_role_attributes"
  ]);
  assert.deepEqual(result, {
    baseRlsGatePassed: true,
    tenantSeedsCreatedByAdministrativeRole: true,
    runtimeCoreUserInsertPrivilege: false,
    runtimeCoreUserInsertRefused: true,
    runtimeCoreUserInsertPersisted: false,
    companyAOwnRead: true,
    companyBOwnRead: true,
    companyAToBReadRefused: true,
    companyBToAReadRefused: true,
    companyAOwnSocialWrite: true,
    companyBOwnSocialWrite: true,
    companyAToBWriteRefused: true,
    companyBToAWriteRefused: true,
    crossTenantRowsPersisted: false,
    missingContextZeroRows: true,
    tamperedContextRefused: true,
    connectionScopeReset: true,
    runtimeSuperuser: false,
    runtimeBypassRls: false,
    runtimeCreateDb: false,
    runtimeCreateRole: false,
    runtimeMigrationPrivileges: false
  });
  assert.equal(Object.keys(result).length, 22);
  assert.equal(database.auditEvents.size, 2);
  assert.equal(database.calls.filter((call) =>
    call.kind === "runtime" && call.sql.includes("INSERT INTO ia4tube_social.social_audit_events")
  ).length, 4);
  assert.equal(database.calls.some((call) =>
    call.kind === "runtime" && call.sql.includes("INSERT INTO ia4tube_social.users")
  ), false);
});

test("corrected RLS gate detects any cross-tenant event that remains persisted", async () => {
  const database = createRlsDatabase({ persistCrossBeforeFailure: true });
  await assert.rejects(
    runRlsAndRoleGate(database.state, {
      baseRlsGatePassed: true,
      reproduction: reproductionProof(),
      runSubstep: (_name, operation) => operation()
    }),
    { code: "linux_gate_rls_cross_write_persisted" }
  );
});

test("connection reset preserves a primary failure while still attempting release", async () => {
  const database = createRlsDatabase({
    connectionScopeLeaks: true,
    manualScopeReleaseFailure: true
  });
  const substeps = [];
  await assert.rejects(
    runRlsAndRoleGate(database.state, {
      baseRlsGatePassed: true,
      reproduction: reproductionProof(),
      async runSubstep(name, operation) {
        substeps.push(name);
        return operation();
      }
    }),
    { code: "linux_gate_rls_connection_context_leaked" }
  );
  assert.equal(substeps.at(-1), "rls_connection_scope_reset");
  assert.equal(database.releases.filter((entry) => entry.manualScopeClient).length, 1);
  assert.equal(database.calls.some((call) =>
    call.kind === "runtime" && call.sql === "ROLLBACK" && call.manualScopeClient
  ), true);
});

test("connection reset propagates a release-only failure from its closed substep", async () => {
  const database = createRlsDatabase({ manualScopeReleaseFailure: true });
  const substeps = [];
  await assert.rejects(
    runRlsAndRoleGate(database.state, {
      baseRlsGatePassed: true,
      reproduction: reproductionProof(),
      async runSubstep(name, operation) {
        substeps.push(name);
        return operation();
      }
    }),
    { code: "release_cleanup_failed" }
  );
  assert.equal(substeps.at(-1), "rls_connection_scope_reset");
  assert.equal(database.releases.filter((entry) => entry.manualScopeClient).length, 1);
});

test("synthetic tenant context is locally derived and contains no external account", () => {
  const identityKey = Buffer.alloc(32, 7);
  const ids = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000004",
    "00000000-0000-4000-8000-000000000005",
    "00000000-0000-4000-8000-000000000006",
    "00000000-0000-4000-8000-000000000007",
    "00000000-0000-4000-8000-000000000008",
    "00000000-0000-4000-8000-000000000009"
  ];
  const tenant = createTenant("test-tenant", {
    identityKey,
    randomUUID: () => ids.shift()
  });
  assert.equal(tenant.context.provider, "instagram");
  assert.equal(tenant.context.environment, "test");
  assert.equal(tenant.context.companyId, tenant.fixture.companyId);
  assert.equal(tenant.context.userId, tenant.fixture.userId);
  assert.equal(Object.hasOwn(tenant.fixture, "accessToken"), false);
  identityKey.fill(0);
});

test("local verifier maps a verified synthetic TLS identity only to loopback", () => {
  const seen = [];
  class FakePool {
    constructor(configuration) {
      seen.push(configuration);
      return configuration;
    }
  }
  const passwords = {
    ia4tube_social_local_migration: "m".repeat(48),
    ia4tube_social_local_runtime: "r".repeat(48)
  };
  const LocalPool = createLocalVerifierPoolClass({
    PoolClass: FakePool,
    port: 49152,
    database: "ia4tube_social_local",
    passwords
  });
  const url = new URL("postgresql://local.ia4tube.invalid:49152/ia4tube_social_local");
  url.username = "ia4tube_social_local_runtime";
  url.password = passwords.ia4tube_social_local_runtime;
  const mapped = new LocalPool({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, servername: "local.ia4tube.invalid" },
    max: 2
  });
  assert.equal(mapped.host, "127.0.0.1");
  assert.equal(mapped.port, 49152);
  assert.equal(mapped.ssl, false);
  const bad = new URL(url);
  bad.hostname = "external.invalid";
  assert.throws(() => new LocalPool({
    connectionString: bad.toString(),
    ssl: { rejectUnauthorized: true, servername: "external.invalid" },
    max: 2
  }));
  assert.equal(seen.length, 1);
});

test("database plaintext probe is parameterized and never interpolates the marker", async () => {
  const marker = `synthetic-${crypto.randomBytes(24).toString("hex")}`;
  let call;
  const client = {
    async query(text, values) {
      if (String(text).includes("SELECT (")) {
        call = { text, values };
        return { rows: [{ present: false }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const pool = {
    async connect() { return client; }
  };
  const companyId = crypto.randomUUID();
  assert.equal(await databaseContainsMarker(pool, marker, companyId), false);
  assert.equal(call.text.includes(marker), false);
  assert.deepEqual(call.values, [marker]);
  assert.match(call.text, /social_encrypted_credentials/);
  assert.doesNotMatch(call.text, /social_credentials\b/);
});

test("vault supplemental gate proves connection and AAD binding without persistence", async () => {
  const markers = [];
  const state = { materials: { vault: Buffer.alloc(32, 11) } };
  const result = await runVaultSupplementalGate(state, markers);
  assert.deepEqual(result, {
    algorithm: "AES-256-GCM",
    aadBound: true,
    companyChangeRefused: true,
    providerChangeRefused: true,
    connectionChangeRefused: true,
    ciphertextTamperRefused: true,
    aadTamperRefused: true
  });
  assert.equal(markers.length, 1);
  assert.match(markers[0], /^synthetic-linux-token-/);
  state.materials.vault.fill(0);
  markers[0] = "";
});

test("Linux physical adapter contains no provider endpoint, customer data or real OAuth path", () => {
  const source = fs.readFileSync(path.join(ROOT, "scripts/social-3a0p-linux-physical-gates.js"), "utf8");
  assert.doesNotMatch(source, /graph\.facebook\.com|api\.instagram\.com|instagram\.com\/oauth/i);
  assert.doesNotMatch(source, /\b(?:119|customer|cliente_real|production_token)\b/i);
  assert.doesNotMatch(source, /\b(?:fetch|axios|undici|https?\.request)\s*\(/);
  assert.doesNotMatch(source, /currentLegacyDependencies|legacyDependencies:\s*current/);
  assert.match(source, /legacy2ARoot/);
  const runtimeIsolation = source.indexOf("gate.verifiers.verifyRuntimeIsolation()");
  const persistedVault = source.indexOf("gate.verifiers.verifyVault()");
  assert.ok(runtimeIsolation >= 0 && persistedVault > runtimeIsolation);
});
