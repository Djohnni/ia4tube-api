"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createSocialHttpCanaryProbe
} = require("../src/persistence/postgres/http-canary-probe");
const {
  createSyntheticHttpCanaryData
} = require("../src/social/http-canary-data");
const {
  createSocialHttpCanaryService
} = require("../src/social/http-canary-service");
const { createSocialVault } = require("../src/social/vault");
const {
  deriveVaultKeyVersion,
  vaultKeyringFingerprint
} = require("../src/social/vault-key-version");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const RUNTIME_ROLE = "ia4tube_social_runtime";

function uuidSequence() {
  let counter = 1;
  return () => {
    const suffix = String(counter++).padStart(12, "0");
    return `00000000-0000-4000-8000-${suffix}`;
  };
}

function canaryData() {
  return createSyntheticHttpCanaryData({
    companyA: COMPANY_A,
    companyB: COMPANY_B,
    randomUUID: uuidSequence()
  });
}

function createVault() {
  const key = Buffer.alloc(32, 41);
  const version = deriveVaultKeyVersion(1, key);
  const vault = createSocialVault({
    keyring: {
      activeVersion: version,
      keys: new Map([[version, key]])
    },
    expectedKeyringFingerprint: vaultKeyringFingerprint(version, [version]),
    randomBytes(size) {
      return Buffer.alloc(size, 17);
    }
  });
  key.fill(0);
  return vault;
}

function createFakePool(options = {}) {
  const state = {
    connectCalls: 0,
    releaseCalls: 0,
    rollbackCalls: 0,
    activeConnections: 0,
    maxActiveConnections: 0,
    advisoryLockHeld: false,
    discardedConnections: 0,
    queries: [],
    committedEvents: new Map(),
    failedOnCompanyB: false
  };

  function createClient() {
    let transactionEvents = new Map(state.committedEvents);
    let scope = "";
    let clientLockHeld = false;
    let released = false;
    const savepoints = new Map();
    return {
      async query(sql, values = []) {
        const text = String(sql).trim();
        const normalized = text.replace(/\s+/g, " ");
        state.queries.push({ text: normalized, values });

        if (normalized === "BEGIN" || normalized === "BEGIN READ ONLY") {
          transactionEvents = new Map(state.committedEvents);
          scope = "";
          if (options.beginResponseLost) {
            throw new Error("Synthetic BEGIN response loss.");
          }
          return { rowCount: null, rows: [] };
        }
        if (normalized.startsWith("SET LOCAL ROLE")) {
          assert.equal(normalized, `SET LOCAL ROLE "${RUNTIME_ROLE}"`);
          return { rowCount: null, rows: [] };
        }
        if (normalized === `SET ROLE "${RUNTIME_ROLE}"`) {
          if (options.setRoleResponseLost) {
            throw new Error("Synthetic SET ROLE response loss.");
          }
          return { rowCount: null, rows: [] };
        }
        if (normalized === "RESET ROLE") {
          if (options.resetRoleFailure) {
            throw new Error("Synthetic RESET ROLE failure.");
          }
          return { rowCount: null, rows: [] };
        }
        if (normalized.includes("pg_try_advisory_lock")) {
          if (options.lockUnavailable || state.advisoryLockHeld) {
            return { rowCount: 1, rows: [{ acquired: false }] };
          }
          state.advisoryLockHeld = true;
          clientLockHeld = true;
          if (options.lockResponseLost) {
            throw new Error("Synthetic advisory lock response loss.");
          }
          return { rowCount: 1, rows: [{ acquired: true }] };
        }
        if (normalized.includes("pg_advisory_unlock")) {
          if (options.unlockFailure) {
            throw new Error("Synthetic advisory unlock failure.");
          }
          if (options.unlockUnconfirmed) {
            return { rowCount: 1, rows: [{ released: false }] };
          }
          state.advisoryLockHeld = false;
          clientLockHeld = false;
          return { rowCount: 1, rows: [{ released: true }] };
        }
        if (normalized === "ROLLBACK") {
          state.rollbackCalls += 1;
          if (options.rollbackFailure) {
            throw new Error("Synthetic ROLLBACK failure.");
          }
          transactionEvents = new Map(state.committedEvents);
          scope = "";
          return { rowCount: null, rows: [] };
        }
        if (normalized === "COMMIT") {
          throw new Error("HTTP canary must never commit.");
        }
        if (normalized.startsWith("SAVEPOINT ")) {
          const name = normalized.slice("SAVEPOINT ".length);
          savepoints.set(name, {
            events: new Map(transactionEvents),
            scope
          });
          return { rowCount: null, rows: [] };
        }
        if (normalized.startsWith("ROLLBACK TO SAVEPOINT ")) {
          const name = normalized.slice("ROLLBACK TO SAVEPOINT ".length);
          const snapshot = savepoints.get(name);
          assert.ok(snapshot, `missing savepoint ${name}`);
          transactionEvents = new Map(snapshot.events);
          scope = snapshot.scope;
          return { rowCount: null, rows: [] };
        }
        if (normalized.startsWith("RELEASE SAVEPOINT ")) {
          const name = normalized.slice("RELEASE SAVEPOINT ".length);
          assert.equal(savepoints.delete(name), true);
          return { rowCount: null, rows: [] };
        }
        if (normalized.startsWith("SELECT set_config('ia4tube.company_id'")) {
          scope = String(values[0] || "");
          return { rowCount: 1, rows: [{ set_config: scope }] };
        }
        if (
          normalized.includes("FROM ia4tube_social.companies") &&
          normalized.includes("id = ANY")
        ) {
          const count = values[0].filter((id) => id === scope).length;
          return { rowCount: 1, rows: [{ record_count: count }] };
        }
        if (
          normalized.includes("FROM ia4tube_social.companies") &&
          normalized.startsWith("SELECT id")
        ) {
          const id = values[0];
          const visible = scope === id && [COMPANY_A, COMPANY_B].includes(id);
          return { rowCount: visible ? 1 : 0, rows: visible ? [{ id }] : [] };
        }
        if (normalized.startsWith(
          "INSERT INTO ia4tube_social.social_audit_events"
        )) {
          const [companyId, id, eventId] = values;
          if (scope !== companyId && !options.disableRls) {
            const error = new Error("RLS denied synthetic insert.");
            error.code = "42501";
            throw error;
          }
          if (
            options.failOnCompanyB &&
            !state.failedOnCompanyB &&
            companyId === COMPANY_B &&
            scope === COMPANY_B
          ) {
            state.failedOnCompanyB = true;
            const error = new Error("Synthetic intermediate failure.");
            error.code = "social_http_canary_synthetic_query_failure";
            throw error;
          }
          const key = `${companyId}:${eventId}`;
          if (normalized.includes("ON CONFLICT") && transactionEvents.has(key)) {
            return { rowCount: 0, rows: [] };
          }
          transactionEvents.set(key, { companyId, id, eventId });
          return { rowCount: 1, rows: [{ id }] };
        }
        if (
          normalized.includes("FROM ia4tube_social.social_audit_events") &&
          normalized.includes("id = ANY")
        ) {
          const [companyId, ids, eventIds] = values;
          let count = 0;
          if (scope === companyId) {
            for (const event of transactionEvents.values()) {
              if (
                event.companyId === companyId &&
                (ids.includes(event.id) || eventIds.includes(event.eventId))
              ) {
                count += 1;
              }
            }
          }
          return { rowCount: 1, rows: [{ record_count: count }] };
        }
        if (
          normalized.includes("FROM ia4tube_social.social_audit_events") &&
          normalized.includes("id = $2")
        ) {
          const [companyId, id, eventId] = values;
          const event = transactionEvents.get(`${companyId}:${eventId}`);
          const count =
            (scope === companyId ||
              (options.leakWithoutContextReads && scope === "")) &&
            event && event.id === id
              ? 1
              : 0;
          return { rowCount: 1, rows: [{ record_count: count }] };
        }
        throw new Error(`Unexpected synthetic SQL: ${normalized}`);
      },
      release(error) {
        if (released) return;
        released = true;
        if (error) {
          state.discardedConnections += 1;
          if (clientLockHeld) {
            state.advisoryLockHeld = false;
            clientLockHeld = false;
          }
        }
        state.releaseCalls += 1;
        state.activeConnections -= 1;
      }
    };
  }

  return {
    state,
    pool: {
      async connect() {
        state.connectCalls += 1;
        state.activeConnections += 1;
        state.maxActiveConnections = Math.max(
          state.maxActiveConnections,
          state.activeConnections
        );
        return createClient();
      }
    }
  };
}

test("rollback-only probe writes/reads A and B and proves all RLS denials", async () => {
  const data = canaryData();
  const { pool, state } = createFakePool();
  const probe = createSocialHttpCanaryProbe({
    pool,
    runtimeRole: RUNTIME_ROLE,
    operationalPoolMax: 3
  });
  const result = await probe.runExclusive(async (lockedProbe) => {
    const mutation = await lockedProbe.runMutation(data);
    assert.equal(await lockedProbe.verifyResiduals(data), 0);
    return mutation;
  });
  assert.deepEqual(result, {
    ownReadA: true,
    ownReadB: true,
    crossTenantDeniedA: true,
    crossTenantDeniedB: true,
    missingContextDenied: true,
    tamperedContextDenied: true,
    idempotentWrites: true,
    mutationRolledBack: true
  });
  assert.equal(state.connectCalls, 1);
  assert.equal(state.releaseCalls, 1);
  assert.equal(state.rollbackCalls, 2);
  assert.equal(state.maxActiveConnections, 1);
  assert.equal(state.activeConnections, 0);
  assert.equal(state.advisoryLockHeld, false);
  assert.equal(state.committedEvents.size, 0);
  const sql = state.queries.map((entry) => entry.text).join("\n");
  assert.match(sql, /BEGIN READ ONLY/);
  assert.match(sql, /pg_try_advisory_lock/);
  assert.match(sql, /pg_advisory_unlock/);
  assert.doesNotMatch(sql, /pg_try_advisory_xact_lock/);
  assert.doesNotMatch(sql, /\bCOMMIT\b/);
  assert.doesNotMatch(
    sql,
    /clientes|legacy_entity_mappings|users|company_memberships|social_connections/i
  );
  assert.match(sql, /social_audit_events/);
});

test("database advisory lock rejects a concurrent cross-instance execution without writes", async () => {
  const { pool, state } = createFakePool({ lockUnavailable: true });
  const probe = createSocialHttpCanaryProbe({
    pool,
    runtimeRole: RUNTIME_ROLE,
    operationalPoolMax: 3
  });
  let operationCalled = false;
  await assert.rejects(
    probe.runExclusive(async () => {
      operationCalled = true;
    }),
    { code: "social_http_canary_in_progress" }
  );
  assert.equal(operationCalled, false);
  assert.equal(state.rollbackCalls, 0);
  assert.equal(state.releaseCalls, 1);
  assert.equal(state.discardedConnections, 0);
  assert.equal(state.committedEvents.size, 0);
});

test("uncertain session-lock acquisition or cleanup destroys the pooled connection", async () => {
  for (const scenario of [
    { setRoleResponseLost: true },
    { lockResponseLost: true },
    { unlockUnconfirmed: true },
    { unlockFailure: true },
    { resetRoleFailure: true }
  ]) {
    const { pool, state } = createFakePool(scenario);
    const probe = createSocialHttpCanaryProbe({
      pool,
      runtimeRole: RUNTIME_ROLE,
      operationalPoolMax: 3
    });
    await assert.rejects(
      probe.runExclusive(async () => true),
      scenario.unlockUnconfirmed ||
        scenario.unlockFailure ||
        scenario.resetRoleFailure
        ? { code: "social_http_canary_lock_cleanup_failed" }
        : /Synthetic (?:SET ROLE|advisory lock) response loss/
    );
    assert.equal(state.releaseCalls, 1);
    assert.equal(state.discardedConnections, 1);
    assert.equal(state.activeConnections, 0);
    assert.equal(state.advisoryLockHeld, false);
  }
});

test("operation failure still releases the session lock and resets the role before rethrowing", async () => {
  const { pool, state } = createFakePool();
  const probe = createSocialHttpCanaryProbe({
    pool,
    runtimeRole: RUNTIME_ROLE,
    operationalPoolMax: 3
  });
  await assert.rejects(
    probe.runExclusive(async () => {
      throw new Error("Synthetic operation failure.");
    }),
    /Synthetic operation failure/
  );
  assert.equal(state.releaseCalls, 1);
  assert.equal(state.discardedConnections, 0);
  assert.equal(state.advisoryLockHeld, false);
  const sql = state.queries.map((entry) => entry.text);
  assert.ok(sql.some((entry) => entry.includes("pg_advisory_unlock")));
  assert.ok(sql.includes("RESET ROLE"));
});

test("unexpectedly permissive RLS fails and the outer rollback still leaves zero residues", async () => {
  const data = canaryData();
  const { pool, state } = createFakePool({ disableRls: true });
  const probe = createSocialHttpCanaryProbe({
    pool,
    runtimeRole: RUNTIME_ROLE,
    operationalPoolMax: 3
  });
  await probe.runExclusive(async (lockedProbe) => {
    await assert.rejects(lockedProbe.runMutation(data), {
      code: "social_http_canary_rls_write_allowed"
    });
    assert.equal(await lockedProbe.verifyResiduals(data), 0);
  });
  assert.equal(state.rollbackCalls, 2);
  assert.equal(state.committedEvents.size, 0);
});

test("partial failure rolls back before a separate zero-residue verification", async () => {
  const data = canaryData();
  const { pool, state } = createFakePool({ failOnCompanyB: true });
  const probe = createSocialHttpCanaryProbe({
    pool,
    runtimeRole: RUNTIME_ROLE,
    operationalPoolMax: 3
  });
  await probe.runExclusive(async (lockedProbe) => {
    await assert.rejects(lockedProbe.runMutation(data), {
      code: "social_http_canary_synthetic_query_failure"
    });
    assert.equal(await lockedProbe.verifyResiduals(data), 0);
  });
  assert.equal(state.rollbackCalls, 2);
  assert.equal(state.committedEvents.size, 0);
});

test("a read leak with no company context fails the database gate and still leaves zero residues", async () => {
  const data = canaryData();
  const { pool, state } = createFakePool({ leakWithoutContextReads: true });
  const probe = createSocialHttpCanaryProbe({
    pool,
    runtimeRole: RUNTIME_ROLE,
    operationalPoolMax: 3
  });
  await probe.runExclusive(async (lockedProbe) => {
    await assert.rejects(lockedProbe.runMutation(data), {
      code: "social_http_canary_database_gate_failed"
    });
    assert.equal(await lockedProbe.verifyResiduals(data), 0);
  });
  assert.equal(state.committedEvents.size, 0);
  assert.equal(state.advisoryLockHeld, false);
});

test("an unconfirmed rollback destroys the same locked connection and leaves no committed residue", async () => {
  const { pool, state } = createFakePool({ rollbackFailure: true });
  const probe = createSocialHttpCanaryProbe({
    pool,
    runtimeRole: RUNTIME_ROLE,
    operationalPoolMax: 3
  });
  const vault = createVault();
  const service = createSocialHttpCanaryService({
    probe,
    vault,
    companyA: COMPANY_A,
    companyB: COMPANY_B,
    randomUUID: uuidSequence(),
    randomBytes(size) {
      return Buffer.alloc(size, 43);
    }
  });
  try {
    await assert.rejects(service.run(), {
      code: "social_http_canary_rollback_failed"
    });
  } finally {
    vault.destroy();
  }
  assert.equal(state.connectCalls, 1);
  assert.equal(state.releaseCalls, 1);
  assert.equal(state.discardedConnections, 1);
  assert.equal(state.advisoryLockHeld, false);
  assert.equal(state.committedEvents.size, 0);
});

test("probe refuses elevated/different role and operational pool above three before connecting", () => {
  const first = createFakePool();
  assert.throws(
    () => createSocialHttpCanaryProbe({
      pool: first.pool,
      runtimeRole: "ia4tube_social_owner",
      operationalPoolMax: 3
    }),
    { code: "social_http_canary_runtime_role_invalid" }
  );
  assert.equal(first.state.connectCalls, 0);

  const second = createFakePool();
  assert.throws(
    () => createSocialHttpCanaryProbe({
      pool: second.pool,
      runtimeRole: RUNTIME_ROLE,
      operationalPoolMax: 4
    }),
    { code: "social_http_canary_pool_must_be_three" }
  );
  assert.equal(second.state.connectCalls, 0);
});
