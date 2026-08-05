"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createConnectorPhysicalGates
} = require("../scripts/social-3a0p-local-connector-physical-gates");

const RUN_MARKER = "ia4tube-social-3a0p-connector-test-0001";

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
