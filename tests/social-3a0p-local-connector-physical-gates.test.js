"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createConnectorPhysicalGates
} = require("../scripts/social-3a0p-local-connector-physical-gates");
const {
  createBackupRestoreProvenanceTracker
} = require("../scripts/social-3a0p-linux-gate");
const {
  assertRestoreRequestProfileBinding
} = require("../scripts/social-3a0p-local-windows-physical-plans");
const {
  SCHEMA_PROFILES
} = require("../src/persistence/postgres/backup-restore");

const RUN_MARKER = "ia4tube-social-3a0p-connector-test-0001";
const BASE_GATE3_BOUNDARIES = Object.freeze([
  Object.freeze(["B1", "internal_setup", "base_context_store_setup"]),
  Object.freeze(["B2", "postgres_transaction", "base_initial_connection_save"]),
  Object.freeze(["B3", "internal_setup", "base_oauth_repository_material_setup"]),
  Object.freeze(["B4", "postgres_transaction", "base_oauth_authorization_create"]),
  Object.freeze(["B5", "postgres_transaction", "base_oauth_authorization_consume"]),
  Object.freeze(["B6", "postgres_concurrent_transactions", "base_idempotency_race"]),
  Object.freeze(["B7", "internal_validation", "base_idempotency_race_validation"]),
  Object.freeze(["B8", "postgres_transaction", "base_idempotency_complete"]),
  Object.freeze(["B9", "postgres_transaction", "base_idempotency_replay"]),
  Object.freeze(["B10", "internal_validation", "base_digest_result_finalization"])
]);
const BASE_GATE4_BOUNDARIES = Object.freeze([
  Object.freeze(["V01", "memory_setup", "base_setup"]),
  Object.freeze(["V02", "memory_crypto", "base_vault_v1_create"]),
  Object.freeze(["V03", "memory_crypto", "base_encrypt"]),
  Object.freeze(["V04", "memory_validation", "base_round_trip"]),
  Object.freeze(["V05", "memory_validation", "base_aad_refusal"]),
  Object.freeze(["V06", "memory_crypto", "base_vault_v2_create"]),
  Object.freeze(["V07", "memory_crypto", "base_rotate"]),
  Object.freeze(["V08", "memory_validation", "base_rotated_round_trip"]),
  Object.freeze(["V09", "memory_cleanup", "base_cleanup"])
]);

function uuidFactory() {
  let value = 0;
  return () => {
    value += 1;
    return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
  };
}

function fakeDependencies() {
  const identity = new Map();
  let identitySequence = 100;
  let idempotencyCalls = 0;
  let idempotencyCompleted = false;
  function principalFor(legacyId) {
    if (!identity.has(legacyId)) {
      identitySequence += 1;
      identity.set(legacyId, {
        companyId: `10000000-0000-4000-8000-${String(identitySequence).padStart(12, "0")}`,
        userId: `20000000-0000-4000-8000-${String(identitySequence).padStart(12, "0")}`
      });
    }
    return identity.get(legacyId);
  }
  const dependencies = {
    SESSION_AUDIENCE: "ia4tube-client",
    SESSION_ISSUER: "ia4tube-api",
    RLS_TABLES: ["companies", "users"],
    createSocialAuthAdapter() {
      return {
        fromVerifiedJwt(claims) {
          return { ...principalFor(claims.company_id), jti: claims.jti };
        }
      };
    },
    createConnectorContext({ principal, provider, environment, correlationId, auditEventId }) {
      return { ...principal, provider, environment, correlationId, auditEventId };
    },
    createMigrationRunner() {
      return {
        async apply() { return [{ version: "0001" }, { version: "0002" }, { version: "0003" }, { version: "0004" }]; },
        async validate() { return { valid: true, pending: 0, applied: 4 }; }
      };
    },
    targetFingerprint() { return "1".repeat(64); },
    async runForwardOnlyRollbackGate(options) {
      assert.equal(options.runMarker, RUN_MARKER);
      assert.equal(options.adapter.runMarker, RUN_MARKER);
      return { transactionalRollbackVerified: true, reapplyVerified: true, operationalRestoreVerified: true };
    },
    async withTransaction(pool, operation, options = {}) {
      return operation({
        async query(sql, values) {
          const text = String(sql);
          if (text.includes("WHERE id=$1")) {
            return { rows: [{ visible: values[0] === options.companyId ? 1 : 0 }] };
          }
          if (text.includes("COUNT(*)::integer AS visible")) return { rows: [{ visible: 0 }] };
          if (text.includes("COUNT(*)::integer AS missing")) return { rows: [{ missing: 0 }] };
          return { rowCount: 1, rows: [] };
        }
      });
    },
    createPostgresConnectorStore() {
      return {
        scope() {
          return {
            async saveConnection() { return { saved: true }; },
            async beginIdempotency() {
              if (idempotencyCompleted) return { status: "completed" };
              idempotencyCalls += 1;
              return { status: idempotencyCalls === 1 ? "acquired" : "pending" };
            },
            async completeIdempotency() { idempotencyCompleted = true; }
          };
        }
      };
    },
    createPostgresOAuthRepository() {
      return {
        scope() {
          return {
            async createAuthorization(input) { return { authorizationHandle: input.authorizationHandle }; },
            async consumeAuthorization() { return { status: "consumed" }; }
          };
        }
      };
    },
    deriveVaultKeyVersion(version) { return `v${version}`; },
    vaultKeyringFingerprint(active, versions) { return `${active}:${versions.join(",")}`; },
    createSocialVault({ keyring }) {
      return {
        encrypt(plaintext, context) {
          return { keyVersion: keyring.activeVersion, plaintext: Buffer.from(plaintext), context: JSON.stringify(context) };
        },
        decrypt(envelope, context) {
          if (envelope.context !== JSON.stringify(context)) throw new Error("synthetic_aad_mismatch");
          return Buffer.from(envelope.plaintext);
        },
        rotate(envelope) {
          return { changed: true, envelope: { ...envelope, keyVersion: keyring.activeVersion } };
        },
        destroy() {}
      };
    },
    async runProfileBackup(plan) {
      return {
        profileId: plan.profileId,
        evidence: {
          bundleSize: plan.profileId.endsWith("0003") ? 100 : 200,
          bundleSha256: plan.profileId.endsWith("0003") ? "3".repeat(64) : "4".repeat(64),
          tableCount: plan.profileId.endsWith("0003") ? 6 : 8,
          rlsTableCount: plan.profileId.endsWith("0003") ? 8 : 10
        }
      };
    },
    async runProfileRestore() { return { disposableTargetRemoved: true }; }
  };
  return dependencies;
}

function createConcurrencyHarness(dependencies = fakeDependencies()) {
  const state = {
    target: Object.freeze({ host: "127.0.0.1", port: 55432 }),
    pools: Object.freeze({ migration: {}, runtime: {} })
  };
  const gates = createConnectorPhysicalGates({
    replaceDefaultDependencies: true,
    dependencies,
    randomBytes: (size) => Buffer.alloc(size, 5),
    randomUUID: uuidFactory(),
    plans: { runMarker: RUN_MARKER }
  });
  return Object.freeze({ gates, state });
}

function createVaultHarness(dependencies = fakeDependencies(), options = {}) {
  const state = {
    target: Object.freeze({ host: "127.0.0.1", port: 55432 }),
    pools: Object.freeze({ migration: {}, runtime: {} }),
    materials: Object.freeze({ vault: Buffer.alloc(32, 7) })
  };
  const generated = [];
  const randomBytes = options.randomBytes || ((size) => {
    const value = Buffer.alloc(size, 5);
    generated.push(value);
    return value;
  });
  const gates = createConnectorPhysicalGates({
    replaceDefaultDependencies: true,
    dependencies,
    randomBytes,
    randomUUID: uuidFactory(),
    plans: { runMarker: RUN_MARKER }
  });
  return Object.freeze({ gates, generated, state });
}

test("Gate 3 base B1-B10 runner is optional pass-through with exact success result and order", async () => {
  const baselineHarness = createConcurrencyHarness();
  const baseline = await baselineHarness.gates.concurrency({ state: baselineHarness.state });
  await baselineHarness.gates.destroy();

  const observed = [];
  const operationCalls = new Map();
  const instrumentedDependencies = fakeDependencies();
  instrumentedDependencies.runGate3Substep = async (substep, operationClass, operation) => {
    observed.push([substep, operationClass]);
    assert.equal(typeof operation, "function");
    operationCalls.set(substep, (operationCalls.get(substep) || 0) + 1);
    return operation();
  };
  const instrumentedHarness = createConcurrencyHarness(instrumentedDependencies);
  const instrumented = await instrumentedHarness.gates.concurrency({
    state: instrumentedHarness.state
  });
  await instrumentedHarness.gates.destroy();

  assert.deepEqual(instrumented, baseline);
  assert.deepEqual(
    observed,
    BASE_GATE3_BOUNDARIES.map(([substep, operationClass]) => [substep, operationClass])
  );
  assert.deepEqual(
    [...operationCalls.entries()],
    BASE_GATE3_BOUNDARIES.map(([substep]) => [substep, 1])
  );
});

test("Gate 3 base B1-B10 preserves the exact runner error and stops at its boundary", async (t) => {
  for (const [targetIndex, [targetSubstep]] of BASE_GATE3_BOUNDARIES.entries()) {
    await t.test(targetSubstep, async () => {
      const sentinel = Object.assign(
        new Error("must remain the same object"),
        { code: "23505" }
      );
      const observed = [];
      const operationCalls = [];
      const dependencies = fakeDependencies();
      dependencies.runGate3Substep = async (substep, operationClass, operation) => {
        observed.push([substep, operationClass]);
        operationCalls.push(substep);
        const result = await operation();
        if (substep === targetSubstep) throw sentinel;
        return result;
      };
      const harness = createConcurrencyHarness(dependencies);
      try {
        await assert.rejects(
          harness.gates.concurrency({
            state: harness.state
          }),
          (error) => error === sentinel
        );
      } finally {
        await harness.gates.destroy();
      }
      assert.deepEqual(
        observed,
        BASE_GATE3_BOUNDARIES
          .slice(0, targetIndex + 1)
          .map(([substep, operationClass]) => [substep, operationClass])
      );
      assert.deepEqual(
        operationCalls,
        BASE_GATE3_BOUNDARIES.slice(0, targetIndex + 1).map(([substep]) => substep)
      );
    });
  }
});

test("Gate 3 base instrumentation preserves exact arguments and Promise.all concurrency", async () => {
  const dependencies = fakeDependencies();
  const calls = [];
  const beginRequests = [];
  let beginSequence = 0;
  let activeBegins = 0;
  let maximumActiveBegins = 0;
  let releaseRace;
  const race = new Promise((resolve) => { releaseRace = resolve; });
  dependencies.createPostgresConnectorStore = (options) => ({
    scope(context) {
      calls.push(["store-scope", options, context]);
      return {
        async saveConnection(record, expectedRevision) {
          calls.push(["save", record, expectedRevision]);
          return Object.freeze({ saved: true });
        },
        async beginIdempotency(request) {
          beginRequests.push(request);
          beginSequence += 1;
          if (beginSequence <= 2) {
            const contender = beginSequence;
            activeBegins += 1;
            maximumActiveBegins = Math.max(maximumActiveBegins, activeBegins);
            if (beginSequence === 2) releaseRace();
            await race;
            activeBegins -= 1;
            return Object.freeze({ status: contender === 1 ? "acquired" : "pending" });
          }
          return Object.freeze({ status: "completed" });
        },
        async completeIdempotency(record) {
          calls.push(["complete", record]);
          return Object.freeze({ status: "completed" });
        }
      };
    }
  });
  dependencies.createPostgresOAuthRepository = (options) => ({
    scope(context) {
      calls.push(["oauth-scope", options, context]);
      return {
        async createAuthorization(input) {
          calls.push(["oauth-create", input]);
          return Object.freeze({ authorizationHandle: input.authorizationHandle });
        },
        async consumeAuthorization(input) {
          calls.push(["oauth-consume", input]);
          return Object.freeze({ status: "consumed" });
        }
      };
    }
  });
  dependencies.runGate3Substep = (_substep, _operationClass, operation) => operation();
  const harness = createConcurrencyHarness(dependencies);
  try {
    await harness.gates.concurrency({
      state: harness.state
    });
  } finally {
    await harness.gates.destroy();
  }

  assert.equal(maximumActiveBegins, 2);
  assert.equal(beginRequests.length, 3);
  assert.equal(beginRequests[0], beginRequests[1]);
  assert.equal(beginRequests[1], beginRequests[2]);
  const storeScope = calls.find(([name]) => name === "store-scope");
  const oauthScope = calls.find(([name]) => name === "oauth-scope");
  assert.equal(storeScope[1].pool, harness.state.pools.runtime);
  assert.equal(oauthScope[1].pool, harness.state.pools.runtime);
  assert.equal(storeScope[1].runtimeRole, "ia4tube_social_runtime");
  assert.equal(oauthScope[1].runtimeRole, "ia4tube_social_runtime");
  assert.equal(storeScope[2], oauthScope[2]);
  const save = calls.find(([name]) => name === "save");
  assert.equal(save[1].companyId, storeScope[2].companyId);
  assert.equal(save[1].provider, "instagram");
  assert.equal(save[2], null);
  const created = calls.find(([name]) => name === "oauth-create")[1];
  const consumed = calls.find(([name]) => name === "oauth-consume")[1];
  assert.equal(created.authorizationHandle, consumed.authorizationHandle);
  assert.equal(created.state, consumed.state);
  assert.equal(created.redirectUri, consumed.redirectUri);
  assert.equal(created.sessionJti, consumed.sessionJti);
});

test("Gate 4 base V01-V09 runner is optional pass-through with exact success result and order", async () => {
  const baselineHarness = createVaultHarness();
  let baseline;
  try {
    baseline = await baselineHarness.gates.vault({ state: baselineHarness.state });
  } finally {
    await baselineHarness.gates.destroy();
  }

  const observed = [];
  const operationCalls = new Map();
  const instrumentedDependencies = fakeDependencies();
  instrumentedDependencies.runGate4Substep = async (substep, operationClass, operation) => {
    observed.push([substep, operationClass]);
    assert.equal(typeof operation, "function");
    operationCalls.set(substep, (operationCalls.get(substep) || 0) + 1);
    return operation();
  };
  const instrumentedHarness = createVaultHarness(instrumentedDependencies);
  let instrumented;
  try {
    instrumented = await instrumentedHarness.gates.vault({
      state: instrumentedHarness.state
    });
  } finally {
    await instrumentedHarness.gates.destroy();
  }

  assert.deepEqual(instrumented, baseline);
  assert.deepEqual(
    observed,
    BASE_GATE4_BOUNDARIES.map(([substep, operationClass]) => [substep, operationClass])
  );
  assert.deepEqual(
    [...operationCalls.entries()],
    BASE_GATE4_BOUNDARIES.map(([substep]) => [substep, 1])
  );
});

test("Gate 4 base V01-V09 preserves the exact runner error, always cleans up, and stops functional work at its boundary", async (t) => {
  for (const [targetIndex, [targetSubstep]] of BASE_GATE4_BOUNDARIES.entries()) {
    await t.test(targetSubstep, async () => {
      const sentinel = Object.assign(
        new Error("must remain the same object"),
        { code: "23514" }
      );
      const observed = [];
      const operationCalls = [];
      const destroyCalls = [];
      let plaintextReference = null;
      const dependencies = fakeDependencies();
      const createSocialVault = dependencies.createSocialVault;
      dependencies.createSocialVault = (options) => {
        const vault = createSocialVault(options);
        return {
          encrypt(plaintext, context) {
            plaintextReference = plaintext;
            return vault.encrypt(plaintext, context);
          },
          decrypt: (envelope, context) => vault.decrypt(envelope, context),
          rotate: (envelope, context) => vault.rotate(envelope, context),
          destroy() {
            destroyCalls.push(options.keyring.activeVersion);
            return vault.destroy();
          }
        };
      };
      dependencies.runGate4Substep = async (substep, operationClass, operation) => {
        observed.push([substep, operationClass]);
        operationCalls.push(substep);
        const result = await operation();
        if (substep === targetSubstep) throw sentinel;
        return result;
      };
      const harness = createVaultHarness(dependencies);
      try {
        await assert.rejects(
          harness.gates.vault({ state: harness.state }),
          (error) => error === sentinel
        );
      } finally {
        await harness.gates.destroy();
      }

      const expectedBoundaries = targetSubstep === "V09"
        ? BASE_GATE4_BOUNDARIES
        : [
            ...BASE_GATE4_BOUNDARIES.slice(0, targetIndex + 1),
            BASE_GATE4_BOUNDARIES.at(-1)
          ];
      assert.deepEqual(
        observed,
        expectedBoundaries.map(([substep, operationClass]) => [substep, operationClass])
      );
      assert.deepEqual(
        operationCalls,
        expectedBoundaries.map(([substep]) => substep)
      );
      assert.deepEqual(
        destroyCalls,
        targetIndex < 1 ? [] : targetIndex < 5 ? ["v1"] : ["v1", "v2"]
      );
      assert.equal(harness.generated.length, 2);
      assert.equal(harness.generated[1].every((value) => value === 0), true);
      if (targetIndex >= 2) {
        assert.ok(plaintextReference);
        assert.equal(plaintextReference.every((value) => value === 0), true);
      }
    });
  }
});

test("Gate 4 base V01-V09 preserves a primary failure over cleanup and propagates cleanup-only failure", async (t) => {
  await t.test("primary plus cleanup preserves the primary Error identity", async () => {
    const primary = Object.assign(new Error("not persisted"), { code: "23514" });
    const cleanup = Object.assign(new Error("not persisted"), { code: "ETIMEDOUT" });
    const observed = [];
    const dependencies = fakeDependencies();
    dependencies.runGate4Substep = async (substep, operationClass, operation) => {
      observed.push([substep, operationClass]);
      const result = await operation();
      if (substep === "V03") throw primary;
      if (substep === "V09") throw cleanup;
      return result;
    };
    const harness = createVaultHarness(dependencies);
    try {
      await assert.rejects(
        harness.gates.vault({ state: harness.state }),
        (error) => error === primary
      );
    } finally {
      await harness.gates.destroy();
    }
    assert.deepEqual(
      observed,
      [
        ["V01", "memory_setup"],
        ["V02", "memory_crypto"],
        ["V03", "memory_crypto"],
        ["V09", "memory_cleanup"]
      ]
    );
  });

  await t.test("cleanup as the first failure preserves its Error identity", async () => {
    const cleanup = Object.assign(new Error("not persisted"), { code: "ETIMEDOUT" });
    const dependencies = fakeDependencies();
    dependencies.runGate4Substep = async (substep, _operationClass, operation) => {
      const result = await operation();
      if (substep === "V09") throw cleanup;
      return result;
    };
    const harness = createVaultHarness(dependencies);
    try {
      await assert.rejects(
        harness.gates.vault({ state: harness.state }),
        (error) => error === cleanup
      );
    } finally {
      await harness.gates.destroy();
    }
  });
});

test("Gate 4 base V01-V09 instrumentation preserves exact vault arguments and cleanup order", async () => {
  async function observe(instrumented) {
    const calls = [];
    const dependencies = fakeDependencies();
    dependencies.deriveVaultKeyVersion = (generation, key) => {
      calls.push(["derive", generation, key.length, key[0]]);
      return `v${generation}`;
    };
    dependencies.vaultKeyringFingerprint = (activeVersion, versions) => {
      calls.push(["fingerprint", activeVersion, [...versions]]);
      return `${activeVersion}:${versions.join(",")}`;
    };
    dependencies.createSocialVault = ({ keyring, expectedKeyringFingerprint }) => {
      calls.push([
        "create",
        keyring.activeVersion,
        [...keyring.keys].map(([version, key]) => [version, key.length, key[0]]),
        expectedKeyringFingerprint
      ]);
      return {
        encrypt(plaintext, context) {
          calls.push(["encrypt", keyring.activeVersion, plaintext.toString("utf8"), { ...context }]);
          return {
            keyVersion: keyring.activeVersion,
            plaintext: Buffer.from(plaintext),
            context: JSON.stringify(context)
          };
        },
        decrypt(envelope, context) {
          calls.push(["decrypt", keyring.activeVersion, envelope.keyVersion, { ...context }]);
          if (envelope.context !== JSON.stringify(context)) throw new Error("synthetic_aad_mismatch");
          return Buffer.from(envelope.plaintext);
        },
        rotate(envelope, context) {
          calls.push(["rotate", keyring.activeVersion, envelope.keyVersion, { ...context }]);
          return {
            changed: true,
            envelope: { ...envelope, keyVersion: keyring.activeVersion }
          };
        },
        destroy() {
          calls.push(["destroy", keyring.activeVersion]);
        }
      };
    };
    if (instrumented) {
      dependencies.runGate4Substep = (_substep, _operationClass, operation) => operation();
    }
    const harness = createVaultHarness(dependencies);
    let result;
    try {
      result = await harness.gates.vault({ state: harness.state });
    } finally {
      await harness.gates.destroy();
    }
    return { calls, result };
  }

  const baseline = await observe(false);
  const instrumented = await observe(true);
  assert.deepEqual(instrumented, baseline);
  assert.deepEqual(
    instrumented.calls.map(([name]) => name),
    [
      "derive",
      "derive",
      "fingerprint",
      "create",
      "encrypt",
      "decrypt",
      "decrypt",
      "fingerprint",
      "create",
      "rotate",
      "decrypt",
      "destroy",
      "destroy"
    ]
  );
  assert.deepEqual(instrumented.calls[0], ["derive", 1, 32, 7]);
  assert.deepEqual(instrumented.calls[1], ["derive", 2, 32, 5]);
  assert.equal(instrumented.calls[4][2], "synthetic-vault-physical-gate");
  assert.equal(instrumented.calls[8][1], "v2");
  assert.deepEqual(instrumented.calls.slice(-2), [["destroy", "v1"], ["destroy", "v2"]]);
});

test("concrete connector gates use the product contracts and physical plan runner", async () => {
  const runtimePool = {
    async connect() {
      return {
        async query(sql) {
          if (String(sql).includes("COUNT(*) FROM ia4tube_social.companies")) throw new Error("synthetic_invalid_context");
          return { rowCount: 1, rows: [] };
        },
        release() {}
      };
    }
  };
  const state = {
    repositoryRoot: __dirname,
    environmentId: "30000000-0000-4000-8000-000000000001",
    target: { host: "127.0.0.1", port: 55432 },
    pools: { migration: {}, runtime: runtimePool },
    materials: { vault: Buffer.alloc(32, 7) }
  };
  const gates = createConnectorPhysicalGates({
    replaceDefaultDependencies: true,
    dependencies: fakeDependencies(),
    randomBytes: (size) => Buffer.alloc(size, 5),
    randomUUID: uuidFactory(),
    plans: {
      runMarker: RUN_MARKER,
      rollbackAdapter: { runMarker: RUN_MARKER },
      backupRestore: {
        backup0003: { profileId: "social-schema-0003" },
        restore0003: {},
        backup0004: { profileId: "social-schema-0004" },
        restore0004: {},
        async assertManifestTamperRefused() { return true; },
        async assertCrossProfileRefused() { return true; }
      }
    }
  });

  const migration = await gates.migration({ state });
  const rls = await gates.rls({ state });
  const concurrency = await gates.concurrency({ state });
  const vault = await gates.vault({ state });
  const backup = await gates.backupRestore({ state });

  assert.equal(migration.profile0004, true);
  assert.equal(rls.tenantIsolation, true);
  assert.equal(concurrency.oauthSynthetic, true);
  assert.equal(vault.aes256Gcm, true);
  assert.equal(backup.profile0003, true);
  assert.equal(backup.profile0004, true);
  assert.equal(backup.bundle0003Size, 100);
  assert.match(backup.bundle0003Sha256, /^3{64}$/);
  assert.equal(backup.bundle0003Tables, 6);
  assert.equal(backup.bundle0003RlsPolicies, 8);
  assert.equal(backup.bundle0004Size, 200);
  assert.match(backup.bundle0004Sha256, /^4{64}$/);
  assert.equal(backup.bundle0004Tables, 8);
  assert.equal(backup.bundle0004RlsPolicies, 10);
  gates.destroy();
});

test("Gate 5 sequences tracked normal operations before exact untracked refusal checks", async (t) => {
  const profile0003 = SCHEMA_PROFILES.find(
    (profile) => profile.id === "social-schema-0003"
  );
  const profile0004 = SCHEMA_PROFILES.find(
    (profile) => profile.id === "social-schema-0004"
  );
  const normalOperations = Object.freeze([
    Object.freeze(["backup", "gate5_backup_0003", "social-schema-0003"]),
    Object.freeze(["restore", "gate5_restore_0003", "social-schema-0003"]),
    Object.freeze(["backup", "gate5_backup_0004", "social-schema-0004"]),
    Object.freeze(["restore", "gate5_restore_0004", "social-schema-0004"])
  ]);
  const normalOrder = normalOperations.map(([, operation]) => operation);
  const canonicalTamperCode = "backup_bundle_authentication_failed";
  const canonicalCrossProfileCode =
    "local_backup_restore_cross_profile_refused";
  const crossRuntimeDiagnostic = Object.freeze({
    expectedProfile: profile0004.id,
    sourceProfile: profile0003.id,
    expectedRelationCount: 16,
    observedRelationCount: 13,
    missingRelationCount: 3,
    ownerMismatchCount: 0,
    kindMismatchCount: 0
  });
  const state = {
    target: { host: "127.0.0.1", port: 55432 },
    pools: { migration: {}, runtime: {} },
    forwardOnlyRollback: { operationalRestoreVerified: true }
  };

  function exactRefusal(error, expectedCode) {
    try {
      throw error;
    } catch (candidate) {
      if (candidate?.code === expectedCode) return true;
      throw candidate;
    }
  }

  function createFixture(options = {}) {
    const tracker = createBackupRestoreProvenanceTracker({
      requireSpawnProof: false
    });
    const requests = {};
    for (const [kind, operation, profileId] of normalOperations) {
      const request = Object.freeze({
        profileId,
        async runTool() { return { code: 0 }; }
      });
      requests[operation] = request;
      if (kind === "backup") tracker.bindBackup(operation, request);
      else tracker.bindRestore(operation, request);
    }

    const events = [];
    const crossEffects = {
      databaseCreate: 0,
      databaseGetPools: 0,
      databaseReconcile: 0,
      requireBackupTransport: 0,
      restoreStarted: false,
      runProfileRestore: 0,
      runtimeVerifier: 0
    };
    const dependencies = fakeDependencies();
    const productBackup = dependencies.runProfileBackup;
    const productRestore = dependencies.runProfileRestore;
    dependencies.runProfileBackup = async (request) => {
      const operation = normalOperations.find(
        ([kind, name]) => kind === "backup" && requests[name] === request
      )?.[1];
      assert.ok(operation);
      events.push(operation);
      return tracker.runBackup(async (trackedRequest) => {
        if (operation === options.failOperation) throw options.failure;
        for (let index = 0; index < 3; index += 1) {
          await trackedRequest.runTool();
        }
        return productBackup(trackedRequest);
      }, request);
    };
    dependencies.runProfileRestore = async (request) => {
      const operation = normalOperations.find(
        ([kind, name]) => kind === "restore" && requests[name] === request
      )?.[1];
      assert.ok(operation);
      events.push(operation);
      return tracker.runRestore(async (trackedRequest) => {
        if (operation === options.failOperation) throw options.failure;
        for (let index = 0; index < 4; index += 1) {
          await trackedRequest.runTool();
        }
        return productRestore(trackedRequest);
      }, request);
    };

    const tamperError = options.tamperError || Object.assign(
      new Error("synthetic exact tamper refusal"),
      { code: canonicalTamperCode }
    );
    const crossError = options.crossError || Object.assign(
      new Error("synthetic exact cross-profile refusal"),
      { code: canonicalCrossProfileCode }
    );
    const plan = {
      backup0003: requests.gate5_backup_0003,
      restore0003: requests.gate5_restore_0003,
      backup0004: requests.gate5_backup_0004,
      restore0004: requests.gate5_restore_0004,
      async assertManifestTamperRefused() {
        events.push("tamper");
        return exactRefusal(tamperError, canonicalTamperCode);
      },
      async assertCrossProfileRefused() {
        events.push("cross");
        let rejected = false;
        try {
          if (options.crossError) throw crossError;
          assertRestoreRequestProfileBinding(
            SCHEMA_PROFILES,
            { profile: profile0003 },
            profile0004
          );
          crossEffects.requireBackupTransport += 1;
          crossEffects.databaseGetPools += 1;
          crossEffects.databaseCreate += 1;
          crossEffects.restoreStarted = true;
          crossEffects.runProfileRestore += 1;
          crossEffects.runtimeVerifier += 1;
        } catch (error) {
          if (error?.code === canonicalCrossProfileCode) {
            rejected = true;
          } else {
            throw error;
          }
        }
        if (crossEffects.restoreStarted) {
          crossEffects.databaseReconcile += 1;
        }
        return rejected;
      },
      async cleanup() { events.push("cleanup"); }
    };
    const gates = createConnectorPhysicalGates({
      replaceDefaultDependencies: true,
      dependencies,
      randomBytes: (size) => Buffer.alloc(size, 5),
      randomUUID: uuidFactory(),
      plans: { runMarker: RUN_MARKER, backupRestore: plan }
    });
    return { crossEffects, crossRuntimeDiagnostic, events, gates, tracker };
  }

  await t.test("canonical tamper and cross-profile codes approve the final Gate 5 result", async () => {
    const fixture = createFixture();
    try {
      const result = await fixture.gates.backupRestore({ state });
      assert.deepEqual(fixture.events, [
        ...normalOrder,
        "tamper",
        "cross",
        "cleanup"
      ]);
      assert.equal(result.physicalExecution, true);
      assert.equal(result.profile0003, true);
      assert.equal(result.profile0004, true);
      assert.equal(result.manifestTamperRefused, true);
      assert.equal(result.crossProfileRefused, true);
      assert.equal(result.operationalRollback, true);
      assert.equal(result.disposableRemoved, true);
      assert.deepEqual(fixture.crossRuntimeDiagnostic, {
        expectedProfile: "social-schema-0004",
        sourceProfile: "social-schema-0003",
        expectedRelationCount: 16,
        observedRelationCount: 13,
        missingRelationCount: 3,
        ownerMismatchCount: 0,
        kindMismatchCount: 0
      });
      assert.deepEqual(fixture.crossEffects, {
        databaseCreate: 0,
        databaseGetPools: 0,
        databaseReconcile: 0,
        requireBackupTransport: 0,
        restoreStarted: false,
        runProfileRestore: 0,
        runtimeVerifier: 0
      });
      assert.equal(fixture.tracker.failure(), null);
    } finally {
      await fixture.gates.destroy();
    }
  });

  await t.test("legacy tamper refusal is propagated outside normal-operation provenance", async () => {
    const legacy = Object.assign(new Error("synthetic legacy refusal"), {
      code: "restore_encrypted_bundle_invalid"
    });
    const fixture = createFixture({ tamperError: legacy });
    try {
      await assert.rejects(
        fixture.gates.backupRestore({ state }),
        (error) => error === legacy
      );
      assert.deepEqual(fixture.events, [
        ...normalOrder,
        "tamper",
        "cleanup"
      ]);
      assert.equal(fixture.tracker.failure(), null);
    } finally {
      await fixture.gates.destroy();
    }
  });

  await t.test("relation-owner mismatch is not accepted as cross-profile refusal and stays outside normal-operation provenance", async () => {
    const nonExact = Object.assign(new Error("synthetic relation-owner mismatch"), {
      code: "postgres_relation_owner_mismatch"
    });
    const fixture = createFixture({ crossError: nonExact });
    try {
      await assert.rejects(
        fixture.gates.backupRestore({ state }),
        (error) => error === nonExact
      );
      assert.deepEqual(fixture.events, [
        ...normalOrder,
        "tamper",
        "cross",
        "cleanup"
      ]);
      assert.equal(fixture.tracker.failure(), null);
    } finally {
      await fixture.gates.destroy();
    }
  });

  for (const [kind, operation] of normalOperations) {
    await t.test(`${operation} failure is propagated with current provenance`, async () => {
      const failure = Object.assign(new Error("synthetic normal-operation failure"), {
        code: `synthetic_${operation}_failure`
      });
      const fixture = createFixture({ failOperation: operation, failure });
      try {
        await assert.rejects(
          fixture.gates.backupRestore({ state }),
          (error) => error === failure
        );
        assert.deepEqual(fixture.events, [
          ...normalOrder.slice(0, normalOrder.indexOf(operation) + 1),
          "cleanup"
        ]);
        assert.deepEqual(fixture.tracker.failure(), {
          operation,
          substep: kind === "backup"
            ? "backup_before_data_snapshot"
            : "restore_before_schema_inventory",
          boundary: "internal_interval",
          causalCode: "backup_restore_internal_failure_unclassified",
          externalTransportProcessStarted: false,
          substepExact: false
        });
      } finally {
        await fixture.gates.destroy();
      }
    });
  }
});

test("backup/restore cleanup always runs without overwriting the first failure", async (t) => {
  const state = {
    target: { host: "127.0.0.1", port: 55432 },
    pools: { migration: {}, runtime: {} },
    forwardOnlyRollback: { operationalRestoreVerified: true }
  };
  function physicalPlan(cleanup, refusals = {}) {
    return {
      backup0003: { profileId: "social-schema-0003" },
      restore0003: {},
      backup0004: { profileId: "social-schema-0004" },
      restore0004: {},
      async assertManifestTamperRefused() {
        return refusals.tamper !== false;
      },
      async assertCrossProfileRefused() {
        return refusals.cross !== false;
      },
      cleanup
    };
  }
  function physicalGates(dependencies, plan) {
    return createConnectorPhysicalGates({
      replaceDefaultDependencies: true,
      dependencies,
      randomBytes: (size) => Buffer.alloc(size, 5),
      randomUUID: uuidFactory(),
      plans: {
        runMarker: RUN_MARKER,
        backupRestore: plan
      }
    });
  }

  await t.test("primary plus cleanup preserves the primary", async () => {
    const primary = Object.assign(new Error("not persisted"), {
      code: "synthetic_backup_primary_failure"
    });
    const cleanup = Object.assign(new Error("not persisted"), {
      code: "synthetic_backup_cleanup_failure"
    });
    let cleanupCalls = 0;
    const dependencies = fakeDependencies();
    dependencies.runProfileBackup = async () => { throw primary; };
    const gates = physicalGates(
      dependencies,
      physicalPlan(async () => {
        cleanupCalls += 1;
        throw cleanup;
      })
    );
    await assert.rejects(
      gates.backupRestore({ state }),
      (error) => error === primary
    );
    assert.equal(cleanupCalls, 1);
    await gates.destroy();
  });

  await t.test("invalid rollback state stops before the first backup runner", async () => {
    let runnerCalls = 0;
    let cleanupCalls = 0;
    const dependencies = fakeDependencies();
    dependencies.runProfileBackup = async () => {
      runnerCalls += 1;
      throw new Error("later runner must not start");
    };
    const gates = physicalGates(
      dependencies,
      physicalPlan(async () => { cleanupCalls += 1; })
    );
    await assert.rejects(
      gates.backupRestore({
        state: {
          ...state,
          forwardOnlyRollback: { operationalRestoreVerified: false }
        }
      }),
      { code: "connector_physical_backup_restore_invalid" }
    );
    assert.equal(runnerCalls, 0);
    assert.equal(cleanupCalls, 1);
    await gates.destroy();
  });

  await t.test("invalid first backup profile stops before restore", async () => {
    let backupCalls = 0;
    let restoreCalls = 0;
    let cleanupCalls = 0;
    const dependencies = fakeDependencies();
    const runValidBackup = dependencies.runProfileBackup;
    dependencies.runProfileBackup = async (plan) => {
      backupCalls += 1;
      return Object.freeze({
        ...(await runValidBackup(plan)),
        profileId: "social-schema-0004"
      });
    };
    dependencies.runProfileRestore = async () => {
      restoreCalls += 1;
      throw new Error("later runner must not start");
    };
    const gates = physicalGates(
      dependencies,
      physicalPlan(async () => { cleanupCalls += 1; })
    );
    await assert.rejects(
      gates.backupRestore({ state }),
      { code: "connector_physical_backup_restore_invalid" }
    );
    assert.equal(backupCalls, 1);
    assert.equal(restoreCalls, 0);
    assert.equal(cleanupCalls, 1);
    await gates.destroy();
  });

  await t.test("invalid first backup evidence stops before restore", async () => {
    let backupCalls = 0;
    let restoreCalls = 0;
    let cleanupCalls = 0;
    const dependencies = fakeDependencies();
    const runValidBackup = dependencies.runProfileBackup;
    dependencies.runProfileBackup = async (plan) => {
      backupCalls += 1;
      const result = await runValidBackup(plan);
      return Object.freeze({
        ...result,
        evidence: Object.freeze({
          ...result.evidence,
          bundleSize: 0
        })
      });
    };
    dependencies.runProfileRestore = async () => {
      restoreCalls += 1;
      throw new Error("later runner must not start");
    };
    const gates = physicalGates(
      dependencies,
      physicalPlan(async () => { cleanupCalls += 1; })
    );
    await assert.rejects(
      gates.backupRestore({ state }),
      { code: "connector_physical_backup_bundle_evidence_invalid" }
    );
    assert.equal(backupCalls, 1);
    assert.equal(restoreCalls, 0);
    assert.equal(cleanupCalls, 1);
    await gates.destroy();
  });

  await t.test("cleanup-only failure propagates", async () => {
    const cleanup = Object.assign(new Error("not persisted"), {
      code: "synthetic_backup_cleanup_failure"
    });
    let cleanupCalls = 0;
    const gates = physicalGates(
      fakeDependencies(),
      physicalPlan(async () => {
        cleanupCalls += 1;
        throw cleanup;
      })
    );
    await assert.rejects(
      gates.backupRestore({ state }),
      (error) => error === cleanup
    );
    assert.equal(cleanupCalls, 1);
    await gates.destroy();
  });

  await t.test("success and cleanup success preserve the result", async () => {
    let cleanupCalls = 0;
    const gates = physicalGates(
      fakeDependencies(),
      physicalPlan(async () => { cleanupCalls += 1; })
    );
    const result = await gates.backupRestore({ state });
    assert.equal(result.profile0003, true);
    assert.equal(result.profile0004, true);
    assert.equal(cleanupCalls, 1);
    await gates.destroy();
  });

  await t.test("accepted tamper wins over outer cleanup failure", async () => {
    const cleanup = Object.assign(new Error("not persisted"), {
      code: "synthetic_backup_cleanup_failure"
    });
    let cleanupCalls = 0;
    const gates = physicalGates(
      fakeDependencies(),
      physicalPlan(
        async () => {
          cleanupCalls += 1;
          throw cleanup;
        },
        { tamper: false }
      )
    );
    await assert.rejects(
      gates.backupRestore({ state }),
      { code: "connector_physical_manifest_tamper_accepted" }
    );
    assert.equal(cleanupCalls, 1);
    await gates.destroy();
  });

  await t.test("accepted cross-profile wins over outer cleanup failure", async () => {
    const cleanup = Object.assign(new Error("not persisted"), {
      code: "synthetic_backup_cleanup_failure"
    });
    let cleanupCalls = 0;
    const gates = physicalGates(
      fakeDependencies(),
      physicalPlan(
        async () => {
          cleanupCalls += 1;
          throw cleanup;
        },
        { cross: false }
      )
    );
    await assert.rejects(
      gates.backupRestore({ state }),
      { code: "connector_physical_cross_profile_accepted" }
    );
    assert.equal(cleanupCalls, 1);
    await gates.destroy();
  });
});

test("physical gate construction performs no PostgreSQL or external call", () => {
  let externalCalls = 0;
  const dependencies = fakeDependencies();
  dependencies.createMigrationRunner = () => {
    externalCalls += 1;
    throw new Error("must_not_construct_pool");
  };
  const gates = createConnectorPhysicalGates({
    replaceDefaultDependencies: true,
    dependencies,
    randomBytes: (size) => Buffer.alloc(size, 2),
    randomUUID: uuidFactory(),
    plans: { runMarker: RUN_MARKER }
  });
  assert.equal(externalCalls, 0);
  gates.destroy();
});

test("missing physical rollback/backup configuration fails during preflight contract validation", () => {
  const gates = createConnectorPhysicalGates({
    replaceDefaultDependencies: true,
    dependencies: fakeDependencies(),
    randomBytes: (size) => Buffer.alloc(size, 3),
    randomUUID: uuidFactory(),
    plans: { runMarker: RUN_MARKER }
  });
  assert.throws(() => gates.assertConfigured(), { code: "connector_physical_rollback_plan_missing" });
  gates.destroy();
});
