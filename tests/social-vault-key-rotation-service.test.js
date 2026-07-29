"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CREDENTIAL_KEY_FOREIGN_KEY
} = require("../src/persistence/postgres/vault-key-registry-admin");
const {
  createSocialCredentialService
} = require("../src/social/credential-service");
const {
  MAX_ROTATION_ATTEMPTS,
  createVaultKeyRotationService
} = require("../src/social/vault-key-rotation-service");
const { createSocialVault } = require("../src/social/vault");
const {
  deriveVaultKeyVersion,
  vaultKeyringFingerprint
} = require("../src/social/vault-key-version");

const companyA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const companyB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const credentialA = "11111111-1111-4111-8111-111111111111";
const connectionA = "22222222-2222-4222-8222-222222222222";
const credentialB = "33333333-3333-4333-8333-333333333333";
const syntheticSecret = "synthetic-rotation-secret-never-log";

function key(byte) {
  return Buffer.alloc(32, byte);
}

const V1 = deriveVaultKeyVersion(1, key(1));
const V2 = deriveVaultKeyVersion(2, key(2));
const V3 = deriveVaultKeyVersion(3, key(3));

function context() {
  return {
    companyId: companyA,
    provider: "instagram",
    subjectType: "connection",
    subjectId: connectionA,
    credentialId: credentialA,
    credentialType: "access_token"
  };
}

function rowFromEnvelope(envelope, revision = 1) {
  return {
    company_id: companyA,
    id: credentialA,
    provider: "instagram",
    connection_id: connectionA,
    oauth_transaction_id: null,
    credential_type: "access_token",
    ciphertext: Buffer.from(envelope.ciphertext),
    nonce: Buffer.from(envelope.nonce),
    auth_tag: Buffer.from(envelope.authTag),
    key_version: envelope.keyVersion,
    aad_version: envelope.aadVersion,
    revision
  };
}

function fakeDependencies(overrides = {}) {
  const events = [];
  const logs = [];
  let registrationCount = 0;
  let activeKeyVersion = null;
  let generation = 0;
  const activatedVersions = new Set();
  const credentialService = {
    async rotateForKeyLifecycle(input) {
      events.push({ operation: "rotate", input });
      return {
        changed: false,
        keyVersion: V2,
        revision: 1
      };
    },
    ...overrides.credentialService
  };
  const keyRegistryAdmin = {
    async register({ keyVersion }) {
      registrationCount += 1;
      events.push({ operation: "register", keyVersion });
      return {
        keyVersion,
        registered: registrationCount === 1
      };
    },
    async retire({ keyVersion }) {
      events.push({ operation: "retire", keyVersion });
      return { keyVersion, retired: true };
    },
    async withActiveVersion(input, operation) {
      events.push({ operation: "barrier", input });
      if (activeKeyVersion !== input.keyVersion) {
        if (
          activeKeyVersion !== null &&
          input.expectedActiveKeyVersion !== activeKeyVersion
        ) {
          const error = new Error("synthetic active conflict");
          error.code = "vault_key_activation_conflict";
          throw error;
        }
        if (activatedVersions.has(input.keyVersion)) {
          const error = new Error("synthetic downgrade");
          error.code = "vault_key_activation_downgrade";
          throw error;
        }
        activeKeyVersion = input.keyVersion;
        generation += 1;
        activatedVersions.add(input.keyVersion);
      }
      const authority = {
        activeKeyVersion,
        generation,
        activated: true
      };
      const result = await operation(authority);
      return { authority, result };
    },
    ...overrides.keyRegistryAdmin
  };
  const vault = {
    versions() {
      events.push({ operation: "versions" });
      return { active: V2, readable: [V1, V2] };
    },
    ...overrides.vault
  };
  const logger = {
    info(entry) {
      logs.push({ level: "info", ...entry });
    },
    warn(entry) {
      logs.push({ level: "warn", ...entry });
    }
  };
  return {
    credentialService,
    events,
    keyRegistryAdmin,
    logger,
    logs,
    vault
  };
}

test("rotation registers first, re-queries after CAS conflict, and is idempotent", async () => {
  const events = [];
  const oldVault = createSocialVault({
    keyring: {
      activeVersion: V1,
      keys: new Map([[V1, key(1)]])
    },
    expectedKeyringFingerprint: vaultKeyringFingerprint(V1, [V1]),
    randomBytes(size) {
      return Buffer.alloc(size, 1);
    }
  });
  const rotatingVault = createSocialVault({
    keyring: {
      activeVersion: V2,
      keys: new Map([
        [V1, key(1)],
        [V2, key(2)]
      ])
    },
    expectedKeyringFingerprint: vaultKeyringFingerprint(V2, [V1, V2]),
    randomBytes(size) {
      return Buffer.alloc(size, 9);
    }
  });
  let persisted = rowFromEnvelope(
    oldVault.encrypt(syntheticSecret, context())
  );
  let findCount = 0;
  let updateCount = 0;
  const repository = {
    async storeEncryptedCredential() {
      throw new Error("not expected");
    },
    async findEncryptedCredential(input) {
      events.push({ operation: "find", input });
      findCount += 1;
      return {
        ...persisted,
        ciphertext: Buffer.from(persisted.ciphertext),
        nonce: Buffer.from(persisted.nonce),
        auth_tag: Buffer.from(persisted.auth_tag)
      };
    },
    async findEncryptedCredentialForKeyRotation(input) {
      return this.findEncryptedCredential(input);
    },
    async rotateEncryptedCredential(input) {
      events.push({ operation: "compare-and-swap", input });
      updateCount += 1;
      persisted = {
        ...persisted,
        ciphertext: Buffer.from(input.ciphertext),
        nonce: Buffer.from(input.nonce),
        auth_tag: Buffer.from(input.authTag),
        key_version: input.keyVersion,
        revision: Number(input.expectedRevision) + 1
      };
      const error = new Error("synthetic concurrent writer");
      error.code = "credential_rotation_conflict";
      throw error;
    },
    async rotateEncryptedCredentialForKeyRotation(input) {
      return this.rotateEncryptedCredential(input);
    },
    async listCredentialKeyVersions() {
      return [];
    }
  };
  const vault = {
    encrypt: rotatingVault.encrypt,
    decrypt: rotatingVault.decrypt,
    rotate: rotatingVault.rotate,
    versions() {
      events.push({ operation: "versions" });
      return rotatingVault.versions();
    }
  };
  const credentialService = createSocialCredentialService({
    repository,
    vault
  });
  let registrations = 0;
  const keyRegistryAdmin = {
    async register({ keyVersion }) {
      events.push({ operation: "register", keyVersion });
      registrations += 1;
      return { keyVersion, registered: registrations === 1 };
    },
    async retire() {
      throw new Error("not expected");
    },
    async withActiveVersion(input, operation) {
      events.push({ operation: "barrier", input });
      const authority = {
        activeKeyVersion: input.keyVersion,
        generation: 1,
        activated: true
      };
      const result = await operation(authority);
      return { authority, result };
    }
  };
  const backoffAttempts = [];
  const logs = [];
  const service = createVaultKeyRotationService({
    credentialService,
    keyRegistryAdmin,
    vault,
    async backoff(attempt) {
      events.push({ operation: "backoff", attempt });
      backoffAttempts.push(attempt);
    },
    logger: {
      info(entry) {
        logs.push(entry);
      },
      warn(entry) {
        logs.push(entry);
      }
    }
  });

  const first = await service.rotateTenant({
    companyId: companyA,
    keyVersion: V2,
    credentialIds: [credentialA]
  });
  assert.equal(first.changed, 0);
  assert.equal(first.alreadyCurrent, 1);
  assert.equal(first.results[0].attempts, 2);
  assert.equal(first.results[0].keyVersion, V2);
  assert.equal(findCount, 2);
  assert.equal(updateCount, 1);
  assert.deepEqual(backoffAttempts, [1]);
  assert.ok(
    events.findIndex((entry) => entry.operation === "register") <
      events.findIndex((entry) => entry.operation === "versions")
  );
  assert.ok(
    events.findIndex((entry) => entry.operation === "versions") <
      events.findIndex((entry) => entry.operation === "find")
  );
  assert.equal(
    events
      .filter((entry) => entry.operation === "find")
      .every(
        (entry) =>
          entry.input.companyId === companyA &&
          entry.input.credentialId === credentialA
      ),
    true
  );

  const plaintext = rotatingVault.decrypt(
    {
      ciphertext: persisted.ciphertext,
      nonce: persisted.nonce,
      authTag: persisted.auth_tag,
      keyVersion: persisted.key_version,
      aadVersion: persisted.aad_version
    },
    context()
  );
  assert.equal(plaintext.toString("utf8"), syntheticSecret);
  plaintext.fill(0);

  const second = await service.rotateTenant({
    companyId: companyA,
    keyVersion: V2,
    credentialIds: [credentialA]
  });
  assert.equal(second.changed, 0);
  assert.equal(second.alreadyCurrent, 1);
  assert.equal(second.results[0].attempts, 1);
  assert.equal(findCount, 3);
  assert.equal(updateCount, 1);
  assert.equal(registrations, 2);

  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes(syntheticSecret), false);
  assert.equal(serializedLogs.includes(V1), false);
  assert.equal(serializedLogs.includes(V2), false);
  assert.equal(serializedLogs.includes(companyA), false);
  assert.equal(serializedLogs.includes(credentialA), false);
});

test("persistent CAS conflicts stop after three attempts with redacted logs", async () => {
  const dependencies = fakeDependencies({
    credentialService: {
      async rotateForKeyLifecycle() {
        const error = new Error(syntheticSecret);
        error.code = "credential_rotation_conflict";
        throw error;
      }
    }
  });
  const backoffAttempts = [];
  const service = createVaultKeyRotationService({
    ...dependencies,
    async backoff(attempt) {
      backoffAttempts.push(attempt);
    }
  });

  await assert.rejects(
    service.rotateTenant({
      companyId: companyA,
      keyVersion: V2,
      credentialIds: [credentialA]
    }),
    (error) =>
      error?.code === "credential_rotation_conflict_exhausted" &&
      !error.message.includes(syntheticSecret)
  );
  assert.deepEqual(backoffAttempts, [1, 2]);
  assert.equal(
    dependencies.logs.filter(
      (entry) => entry.event === "credential_revision_conflict"
    ).length,
    MAX_ROTATION_ATTEMPTS - 1
  );
  assert.equal(
    JSON.stringify(dependencies.logs).includes(syntheticSecret),
    false
  );
});

test("missing active version fails after registration and before rotation", async () => {
  const dependencies = fakeDependencies({
    vault: {
      versions() {
        dependencies.events.push({ operation: "versions" });
        return { active: V1, readable: [V1] };
      }
    }
  });
  const service = createVaultKeyRotationService(dependencies);

  await assert.rejects(
    service.rotateTenant({
      companyId: companyA,
      keyVersion: V2,
      credentialIds: [credentialA]
    }),
    { code: "vault_active_key_unavailable" }
  );
  assert.deepEqual(
    dependencies.events.map((entry) => entry.operation),
    ["register", "versions"]
  );
});

test("unregistered active-key foreign key failure is mapped closed", async () => {
  const dependencies = fakeDependencies({
    credentialService: {
      async rotateForKeyLifecycle() {
        const error = new Error(syntheticSecret);
        error.code = "23503";
        error.constraint = CREDENTIAL_KEY_FOREIGN_KEY;
        throw error;
      }
    }
  });
  const service = createVaultKeyRotationService(dependencies);

  await assert.rejects(
    service.rotateTenant({
      companyId: companyA,
      keyVersion: V2,
      credentialIds: [credentialA]
    }),
    (error) =>
      error?.code === "vault_active_key_not_registered" &&
      !error.message.includes(syntheticSecret) &&
      error.cause === undefined
  );
  assert.equal(
    JSON.stringify(dependencies.logs).includes(syntheticSecret),
    false
  );
});

test("retirement refuses the active key and delegates old-key blocking to registry", async () => {
  let retireCalls = 0;
  const dependencies = fakeDependencies({
    keyRegistryAdmin: {
      async retire({ keyVersion }) {
        retireCalls += 1;
        const error = new Error("registry reference remains");
        error.code = "vault_key_version_in_use";
        error.keyVersion = keyVersion;
        throw error;
      }
    }
  });
  const service = createVaultKeyRotationService(dependencies);

  await assert.rejects(service.retire({ keyVersion: V2 }), {
    code: "vault_active_key_retirement_refused"
  });
  assert.equal(retireCalls, 0);

  await assert.rejects(service.retire({ keyVersion: V1 }), {
    code: "vault_key_version_in_use"
  });
  assert.equal(retireCalls, 1);
  assert.equal(
    dependencies.events.some((entry) => entry.operation === "rotate"),
    false
  );
});

test("duplicate credentials fail before changing the global registry", async () => {
  const dependencies = fakeDependencies();
  const service = createVaultKeyRotationService(dependencies);

  await assert.rejects(
    service.rotateTenant({
      companyId: companyA,
      keyVersion: V2,
      credentialIds: [credentialA, credentialA]
    }),
    { code: "vault_rotation_credentials_duplicated" }
  );
  assert.equal(dependencies.events.length, 0);
});

test("tenant scope rejects a credential from another company before update", async () => {
  let updates = 0;
  const dependencies = fakeDependencies({
    credentialService: {
      async rotateForKeyLifecycle({ companyId, credentialId }) {
        if (
          companyId !== companyB ||
          credentialId !== credentialB
        ) {
          const error = new Error("synthetic credential unavailable");
          error.code = "credential_not_found";
          throw error;
        }
        updates += 1;
        return { changed: true, keyVersion: V2, revision: 2 };
      }
    }
  });
  const service = createVaultKeyRotationService(dependencies);

  await assert.rejects(
    service.rotateTenant({
      companyId: companyA,
      keyVersion: V2,
      credentialIds: [credentialB]
    }),
    { code: "credential_not_found" }
  );
  assert.equal(updates, 0);
});

test("administrative rotation includes revoked and expired credentials", async () => {
  const oldVault = createSocialVault({
    keyring: {
      activeVersion: V1,
      keys: new Map([[V1, key(1)]])
    },
    expectedKeyringFingerprint: vaultKeyringFingerprint(V1, [V1]),
    randomBytes(size) {
      return Buffer.alloc(size, 3);
    }
  });
  const rotatingVault = createSocialVault({
    keyring: {
      activeVersion: V2,
      keys: new Map([
        [V1, key(1)],
        [V2, key(2)]
      ])
    },
    expectedKeyringFingerprint: vaultKeyringFingerprint(V2, [V1, V2]),
    randomBytes(size) {
      return Buffer.alloc(size, 4);
    }
  });
  const expiredAt = new Date("2026-01-01T00:00:00.000Z");
  const revokedAt = new Date("2026-01-02T00:00:00.000Z");
  let persisted = {
    ...rowFromEnvelope(
      oldVault.encrypt(syntheticSecret, context())
    ),
    expires_at: expiredAt,
    revoked_at: revokedAt
  };
  let lifecycleReads = 0;
  let lifecycleUpdates = 0;
  const repository = {
    async storeEncryptedCredential() {
      throw new Error("not expected");
    },
    async findEncryptedCredential() {
      return null;
    },
    async rotateEncryptedCredential() {
      throw new Error("not expected");
    },
    async findEncryptedCredentialForKeyRotation(input) {
      lifecycleReads += 1;
      if (
        input.companyId !== companyA ||
        input.credentialId !== credentialA
      ) {
        return null;
      }
      return {
        ...persisted,
        ciphertext: Buffer.from(persisted.ciphertext),
        nonce: Buffer.from(persisted.nonce),
        auth_tag: Buffer.from(persisted.auth_tag)
      };
    },
    async rotateEncryptedCredentialForKeyRotation(input) {
      lifecycleUpdates += 1;
      persisted = {
        ...persisted,
        ciphertext: Buffer.from(input.ciphertext),
        nonce: Buffer.from(input.nonce),
        auth_tag: Buffer.from(input.authTag),
        key_version: input.keyVersion,
        revision: Number(input.expectedRevision) + 1
      };
      return persisted;
    },
    async listCredentialKeyVersions() {
      return [{ keyVersion: persisted.key_version, credentialCount: 1 }];
    }
  };
  const credentials = createSocialCredentialService({
    repository,
    vault: rotatingVault
  });
  const dependencies = fakeDependencies({
    credentialService: credentials,
    vault: {
      versions() {
        return rotatingVault.versions();
      }
    }
  });
  const service = createVaultKeyRotationService(dependencies);

  const result = await service.rotateTenant({
    companyId: companyA,
    keyVersion: V2,
    credentialIds: [credentialA]
  });
  assert.equal(result.changed, 1);
  assert.equal(persisted.key_version, V2);
  assert.equal(persisted.expires_at, expiredAt);
  assert.equal(persisted.revoked_at, revokedAt);
  assert.equal(lifecycleReads, 1);
  assert.equal(lifecycleUpdates, 1);
  await assert.rejects(
    credentials.withDecryptedCredential(
      { companyId: companyA, credentialId: credentialA },
      () => true
    ),
    { code: "credential_not_found" }
  );
});

test("a partially completed tenant rotation resumes without rewriting completed rows", async () => {
  const state = new Map([
    [credentialA, V1],
    [credentialB, V1]
  ]);
  let failSecondOnce = true;
  const calls = [];
  const dependencies = fakeDependencies({
    credentialService: {
      async rotateForKeyLifecycle({ companyId, credentialId }) {
        assert.equal(companyId, companyA);
        calls.push(credentialId);
        if (credentialId === credentialB && failSecondOnce) {
          failSecondOnce = false;
          const error = new Error("synthetic interrupted batch");
          error.code = "synthetic_batch_interrupted";
          throw error;
        }
        if (state.get(credentialId) === V2) {
          return { changed: false, keyVersion: V2, revision: 2 };
        }
        state.set(credentialId, V2);
        return { changed: true, keyVersion: V2, revision: 2 };
      }
    }
  });
  const service = createVaultKeyRotationService(dependencies);
  const input = {
    companyId: companyA,
    keyVersion: V2,
    expectedActiveKeyVersion: V1,
    credentialIds: [credentialA, credentialB]
  };

  await assert.rejects(service.rotateTenant(input), {
    code: "synthetic_batch_interrupted"
  });
  assert.equal(state.get(credentialA), V2);
  assert.equal(state.get(credentialB), V1);

  const resumed = await service.rotateTenant(input);
  assert.equal(resumed.changed, 1);
  assert.equal(resumed.alreadyCurrent, 1);
  assert.deepEqual([...state.values()], [V2, V2]);
  assert.equal(
    calls.filter((credentialId) => credentialId === credentialA).length,
    2
  );
});

test("global authority serializes targets and rejects a stale activation", async () => {
  let activeKeyVersion = V1;
  let generation = 1;
  let tail = Promise.resolve();
  const rotations = [];
  const keyRegistryAdmin = {
    async register({ keyVersion }) {
      return { keyVersion, registered: true };
    },
    async retire({ keyVersion }) {
      return { keyVersion, retired: true };
    },
    async withActiveVersion(input, operation) {
      const previous = tail;
      let release;
      tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        if (
          activeKeyVersion !== input.keyVersion &&
          input.expectedActiveKeyVersion !== activeKeyVersion
        ) {
          const error = new Error("synthetic stale target");
          error.code = "vault_key_activation_conflict";
          throw error;
        }
        if (activeKeyVersion !== input.keyVersion) {
          activeKeyVersion = input.keyVersion;
          generation += 1;
        }
        const authority = {
          activeKeyVersion,
          generation,
          activated: true
        };
        const result = await operation(authority);
        return { authority, result };
      } finally {
        release();
      }
    }
  };
  function candidate(targetVersion) {
    return createVaultKeyRotationService({
      credentialService: {
        async rotateForKeyLifecycle() {
          rotations.push(targetVersion);
          await new Promise((resolve) => setImmediate(resolve));
          return {
            changed: true,
            keyVersion: targetVersion,
            revision: 2
          };
        }
      },
      keyRegistryAdmin,
      vault: {
        versions() {
          return {
            active: targetVersion,
            readable: [V1, V2, V3]
          };
        }
      }
    });
  }

  const attempts = await Promise.allSettled([
    candidate(V2).rotateTenant({
      companyId: companyA,
      keyVersion: V2,
      expectedActiveKeyVersion: V1,
      credentialIds: [credentialA]
    }),
    candidate(V3).rotateTenant({
      companyId: companyA,
      keyVersion: V3,
      expectedActiveKeyVersion: V1,
      credentialIds: [credentialA]
    })
  ]);
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1
  );
  const rejected = attempts.find(
    (result) => result.status === "rejected"
  );
  assert.equal(rejected.reason?.code, "vault_key_activation_conflict");
  assert.deepEqual(rotations, [activeKeyVersion]);
  assert.ok([V2, V3].includes(activeKeyVersion));
});

test("logger failures never change successful rotation or retirement results", async () => {
  let retirementCalls = 0;
  const dependencies = fakeDependencies({
    keyRegistryAdmin: {
      async retire({ keyVersion }) {
        retirementCalls += 1;
        return {
          keyVersion,
          retired: retirementCalls === 1
        };
      }
    }
  });
  dependencies.logger.info = async () => {
    throw new Error(syntheticSecret);
  };
  dependencies.logger.warn = () => {
    throw new Error(syntheticSecret);
  };
  const service = createVaultKeyRotationService(dependencies);

  const rotation = await service.rotateTenant({
    companyId: companyA,
    keyVersion: V2,
    credentialIds: [credentialA]
  });
  assert.equal(rotation.alreadyCurrent, 1);
  assert.deepEqual(await service.retire({ keyVersion: V1 }), {
    keyVersion: V1,
    retired: true
  });
  assert.deepEqual(await service.retire({ keyVersion: V1 }), {
    keyVersion: V1,
    retired: false
  });
});

test("normal credential storage maps an unregistered key foreign key closed", async () => {
  const serviceVault = createSocialVault({
    keyring: {
      activeVersion: V2,
      keys: new Map([[V2, key(2)]])
    },
    expectedKeyringFingerprint: vaultKeyringFingerprint(V2, [V2]),
    randomBytes(size) {
      return Buffer.alloc(size, 6);
    }
  });
  const repository = {
    async storeEncryptedCredential() {
      const error = new Error(syntheticSecret);
      error.code = "23503";
      error.constraint = CREDENTIAL_KEY_FOREIGN_KEY;
      throw error;
    },
    async findEncryptedCredential() {
      return null;
    },
    async rotateEncryptedCredential() {
      throw new Error("not expected");
    },
    async listCredentialKeyVersions() {
      return [];
    }
  };
  const credentials = createSocialCredentialService({
    repository,
    vault: serviceVault
  });

  await assert.rejects(
    credentials.store({
      companyId: companyA,
      credentialId: credentialA,
      provider: "instagram",
      connectionId: connectionA,
      credentialType: "access_token",
      plaintext: syntheticSecret
    }),
    (error) =>
      error?.code === "vault_active_key_not_registered" &&
      error?.cause === undefined &&
      !error.message.includes(syntheticSecret)
  );
});
