"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  deriveSocialIdentity,
  parseIdentityConfig,
  uuidV5
} = require("../src/social/identity");
const {
  SocialVaultError,
  createSocialVault,
  parseVaultKeyring
} = require("../src/social/vault");
const {
  deriveVaultKeyVersion,
  vaultKeyringFingerprint
} = require("../src/social/vault-key-version");
const {
  REAUTH_TTL_MS,
  SESSION_AUDIENCE,
  SESSION_ISSUER,
  SocialReauthError,
  createSocialReauthService,
  requireSession,
  requireTarget
} = require("../src/social/reauth");
const {
  createSocialCredentialService
} = require("../src/social/credential-service");
const {
  audienceMatches,
  createSocialAuthAdapter
} = require("../src/social/auth-adapter");

const companyA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const companyB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const userA = "11111111-1111-4111-8111-111111111111";
const connectionA = "22222222-2222-4222-8222-222222222222";
const connectionB = "33333333-3333-4333-8333-333333333333";
const credentialId = "44444444-4444-4444-8444-444444444444";
const grantId = "55555555-5555-4555-8555-555555555555";
const namespace = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const identityVersion = "identity-v1";
const syntheticPrincipal = "synthetic-principal";

function key(byte) {
  return Buffer.alloc(32, byte);
}

function testOnlyKeyVersion(label, keyMaterial) {
  const match = /^v([1-9][0-9]*)$/.exec(label);
  assert.ok(match, "rotulo sintetico de chave invalido");
  return deriveVaultKeyVersion(Number(match[1]), keyMaterial);
}

function hmacIdentity(value, derivationKey, domain) {
  return crypto
    .createHmac("sha256", derivationKey)
    .update(`${domain}\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function context(overrides = {}) {
  return {
    companyId: companyA,
    provider: "instagram",
    subjectType: "connection",
    subjectId: connectionA,
    credentialId,
    credentialType: "access_token",
    ...overrides
  };
}

function vault(activeVersion, keys, nonceStart = 1) {
  let next = nonceStart;
  const entries = Object.entries(keys).map(([label, keyMaterial]) => [
    testOnlyKeyVersion(label, keyMaterial),
    keyMaterial
  ]);
  const activeKey = keys[activeVersion];
  const boundActiveVersion = testOnlyKeyVersion(
    activeVersion,
    activeKey
  );
  const readable = entries.map(([version]) => version);
  return createSocialVault({
    keyring: {
      activeVersion: boundActiveVersion,
      keys: new Map(entries)
    },
    expectedKeyringFingerprint: vaultKeyringFingerprint(
      boundActiveVersion,
      readable
    ),
    randomBytes(size) {
      return Buffer.alloc(size, next++);
    }
  });
}

function rowFromStored(stored) {
  return {
    company_id: stored.companyId,
    id: stored.id,
    provider: stored.provider,
    connection_id: stored.connectionId,
    oauth_transaction_id: stored.oauthTransactionId,
    credential_type: stored.credentialType,
    ciphertext: stored.ciphertext,
    nonce: stored.nonce,
    auth_tag: stored.authTag,
    key_version: stored.keyVersion,
    aad_version: stored.aadVersion,
    revision: stored.revision
  };
}

test("legacy identities use domain-separated keyed HMAC before UUID derivation", () => {
  const derivationKey = key(7);
  const input = {
    namespaceUuid: namespace,
    derivationKey,
    derivationVersion: identityVersion,
    legacyCompanyId: "synthetic-company",
    legacyUserId: "synthetic-user"
  };
  const first = deriveSocialIdentity(input);
  const repeated = deriveSocialIdentity(input);
  const companyDigest = hmacIdentity(
    input.legacyCompanyId,
    derivationKey,
    "company"
  );
  const userDigest = hmacIdentity(
    input.legacyUserId,
    derivationKey,
    "user"
  );

  assert.deepEqual(first, repeated);
  assert.deepEqual(first, {
    companyId: uuidV5(namespace, `company:${companyDigest}`),
    userId: uuidV5(
      namespace,
      `user:${companyDigest}:${userDigest}`
    ),
    derivationVersion: identityVersion
  });
  assert.notEqual(
    companyDigest,
    crypto.createHash("sha256").update(input.legacyCompanyId).digest("hex")
  );
  assert.notEqual(
    hmacIdentity("same-legacy-value", derivationKey, "company"),
    hmacIdentity("same-legacy-value", derivationKey, "user")
  );
  assert.notDeepEqual(
    first,
    deriveSocialIdentity({ ...input, derivationKey: key(8) })
  );
  assert.equal(JSON.stringify(first).includes("synthetic-company"), false);
  assert.equal(JSON.stringify(first).includes(companyDigest), false);
  assert.equal(Object.hasOwn(first, "companySourceDigest"), false);
});

test("identity configuration requires a canonical independent 256-bit key", () => {
  const encoded = key(7).toString("base64");
  const parsed = parseIdentityConfig({
    SOCIAL_IDENTITY_DERIVATION_KEY: encoded,
    SOCIAL_TENANT_NAMESPACE_UUID: namespace,
    SOCIAL_IDENTITY_DERIVATION_VERSION: identityVersion
  });
  assert.equal(parsed.namespaceUuid, namespace);
  assert.equal(parsed.derivationVersion, identityVersion);
  assert.deepEqual(parsed.key, key(7));

  for (const invalidKey of [
    Buffer.alloc(31, 7).toString("base64"),
    encoded.replace(/=$/, ""),
    "not-canonical-base64"
  ]) {
    assert.throws(
      () =>
        parseIdentityConfig({
          SOCIAL_IDENTITY_DERIVATION_KEY: invalidKey,
          SOCIAL_TENANT_NAMESPACE_UUID: namespace,
          SOCIAL_IDENTITY_DERIVATION_VERSION: identityVersion
        }),
      { code: "identity_derivation_key_invalid" }
    );
  }
});

test("vault keyring rejects invalid and duplicated 256-bit key material", () => {
  const material = key(7);
  const encoded = material.toString("base64");
  const version = deriveVaultKeyVersion(1, material);
  const fingerprint = vaultKeyringFingerprint(version, [version]);
  const keyring = parseVaultKeyring({
    SOCIAL_VAULT_ACTIVE_KEY_VERSION: version,
    SOCIAL_VAULT_KEYS_JSON: JSON.stringify({ [version]: encoded }),
    SOCIAL_VAULT_EXPECTED_KEYRING_FINGERPRINT: fingerprint
  });
  assert.equal(keyring.activeVersion, version);
  assert.equal(keyring.keys.get(version).length, 32);
  assert.equal(keyring.fingerprint, fingerprint);

  assert.throws(
    () =>
      parseVaultKeyring({
        SOCIAL_VAULT_ACTIVE_KEY_VERSION: version,
        SOCIAL_VAULT_KEYS_JSON: JSON.stringify({
          [version]: Buffer.alloc(31).toString("base64")
        }),
        SOCIAL_VAULT_EXPECTED_KEYRING_FINGERPRINT: fingerprint
      }),
    SocialVaultError
  );
  const duplicateV1 = deriveVaultKeyVersion(1, key(9));
  const duplicateV2 = deriveVaultKeyVersion(2, key(9));
  assert.throws(
    () =>
      createSocialVault({
        keyring: {
          activeVersion: duplicateV2,
          keys: new Map([
            [duplicateV1, key(9)],
            [duplicateV2, key(9)]
          ])
        },
        expectedKeyringFingerprint: vaultKeyringFingerprint(
          duplicateV2,
          [duplicateV1, duplicateV2]
        )
      }),
    { code: "vault_duplicate_key_material" }
  );
});

test("key IDs bind every instance to the same AES material", () => {
  const material = key(5);
  const version = deriveVaultKeyVersion(7, material);
  const fingerprint = vaultKeyringFingerprint(version, [version]);
  const first = createSocialVault({
    keyring: {
      activeVersion: version,
      keys: new Map([[version, material]])
    },
    expectedKeyringFingerprint: fingerprint
  });
  const second = createSocialVault({
    keyring: {
      activeVersion: version,
      keys: new Map([[version, Buffer.from(material)]])
    },
    expectedKeyringFingerprint: fingerprint
  });
  assert.deepEqual(first.versions(), second.versions());
  assert.throws(
    () =>
      createSocialVault({
        keyring: {
          activeVersion: version,
          keys: new Map([[version, key(6)]])
        },
        expectedKeyringFingerprint: fingerprint
      }),
    { code: "vault_key_version_material_mismatch" }
  );
  first.destroy();
  second.destroy();
});

test("keyring fingerprint refuses different active or readable sets", () => {
  const firstMaterial = key(5);
  const secondMaterial = key(6);
  const firstVersion = deriveVaultKeyVersion(5, firstMaterial);
  const secondVersion = deriveVaultKeyVersion(6, secondMaterial);
  const expected = vaultKeyringFingerprint(secondVersion, [
    firstVersion,
    secondVersion
  ]);
  const encoded = {
    [firstVersion]: firstMaterial.toString("base64"),
    [secondVersion]: secondMaterial.toString("base64")
  };

  assert.throws(
    () =>
      parseVaultKeyring({
        SOCIAL_VAULT_ACTIVE_KEY_VERSION: firstVersion,
        SOCIAL_VAULT_KEYS_JSON: JSON.stringify(encoded),
        SOCIAL_VAULT_EXPECTED_KEYRING_FINGERPRINT: expected
      }),
    { code: "vault_keyring_fingerprint_mismatch" }
  );
  assert.throws(
    () =>
      parseVaultKeyring({
        SOCIAL_VAULT_ACTIVE_KEY_VERSION: firstVersion,
        SOCIAL_VAULT_KEYS_JSON: JSON.stringify({
          [firstVersion]: encoded[firstVersion]
        }),
        SOCIAL_VAULT_EXPECTED_KEYRING_FINGERPRINT: expected
      }),
    { code: "vault_keyring_fingerprint_mismatch" }
  );
  assert.throws(
    () =>
      parseVaultKeyring({
        SOCIAL_VAULT_ACTIVE_KEY_VERSION: firstVersion,
        SOCIAL_VAULT_KEYS_JSON: JSON.stringify({
          [firstVersion]: encoded[firstVersion]
        })
      }),
    { code: "vault_keyring_fingerprint_invalid" }
  );
});

test("AES-256-GCM uses a fresh nonce and decrypts only with exact AAD", () => {
  const service = vault("v1", { v1: key(1) });
  const secret = "synthetic-access-token-value";
  const first = service.encrypt(secret, context());
  const second = service.encrypt(secret, context());
  assert.notDeepEqual(first.nonce, second.nonce);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  const plaintext = service.decrypt(first, context());
  assert.equal(plaintext.toString("utf8"), secret);
  plaintext.fill(0);
  assert.equal(JSON.stringify(first).includes(secret), false);

  for (const changedContext of [
    context({ companyId: companyB }),
    context({ provider: "facebook" }),
    context({ subjectId: connectionB }),
    context({
      credentialId: "66666666-6666-4666-8666-666666666666"
    }),
    context({ credentialType: "refresh_token" })
  ]) {
    assert.throws(
      () => service.decrypt(first, changedContext),
      { code: "vault_authentication_failed" }
    );
  }
});

test("vault rejects tampering without exposing cryptographic details", () => {
  const service = vault("v1", { v1: key(1) });
  const encrypted = service.encrypt("synthetic-token", context());
  const tampered = {
    ...encrypted,
    ciphertext: Buffer.from(encrypted.ciphertext)
  };
  tampered.ciphertext[0] ^= 0xff;
  let caught;
  try {
    service.decrypt(tampered, context());
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.code, "vault_authentication_failed");
  assert.equal(caught.message, "Operacao do cofre social recusada.");
  assert.equal(caught.message.includes("synthetic-token"), false);
});

test("key rotation reads the old key and rewrites with a new nonce/version", () => {
  const oldVault = vault("v1", { v1: key(1) });
  const oldEnvelope = oldVault.encrypt("synthetic-refresh-token", context());
  const rotatingVault = vault("v2", { v1: key(1), v2: key(2) }, 9);
  const rotated = rotatingVault.rotate(oldEnvelope, context());
  assert.equal(rotated.changed, true);
  assert.equal(
    rotated.envelope.keyVersion,
    testOnlyKeyVersion("v2", key(2))
  );
  assert.notDeepEqual(rotated.envelope.nonce, oldEnvelope.nonce);
  const decrypted = rotatingVault.decrypt(rotated.envelope, context());
  assert.equal(decrypted.toString("utf8"), "synthetic-refresh-token");
  decrypted.fill(0);
  assert.throws(
    () => oldVault.decrypt(rotated.envelope, context()),
    { code: "vault_key_version_unavailable" }
  );
});

test("destroyed vault refuses every operation and cannot expose key versions", () => {
  const service = vault("v1", { v1: key(1) });
  const encrypted = service.encrypt("synthetic-destroy-token", context());
  const version = testOnlyKeyVersion("v1", key(1));
  assert.deepEqual(service.versions(), {
    active: version,
    fingerprint: vaultKeyringFingerprint(version, [version]),
    readable: [version]
  });

  service.destroy();
  service.destroy();

  for (const operation of [
    () => service.encrypt("synthetic-destroy-token", context()),
    () => service.decrypt(encrypted, context()),
    () => service.rotate(encrypted, context()),
    () => service.versions()
  ]) {
    assert.throws(operation, { code: "vault_destroyed" });
  }
});

test("credential service confines plaintext to a callback and wipes it", async () => {
  const serviceVault = vault("v1", { v1: key(3) });
  let stored;
  let inventoryCompany;
  const repository = {
    async storeEncryptedCredential(row) {
      stored = { ...row, revision: 1 };
      return stored;
    },
    async findEncryptedCredential({ companyId, credentialId: id }) {
      if (!stored || stored.companyId !== companyId || stored.id !== id) {
        return null;
      }
      return rowFromStored(stored);
    },
    async rotateEncryptedCredential() {
      throw new Error("not expected");
    },
    async listCredentialKeyVersions({ companyId }) {
      inventoryCompany = companyId;
      return [
        {
          keyVersion: testOnlyKeyVersion("v1", key(3)),
          credentialCount: 1
        }
      ];
    }
  };
  const credentials = createSocialCredentialService({
    repository,
    vault: serviceVault
  });
  await credentials.store({
    companyId: companyA,
    credentialId,
    provider: "instagram",
    connectionId: connectionA,
    credentialType: "access_token",
    plaintext: "synthetic-service-token"
  });
  assert.equal(Object.hasOwn(stored, "plaintext"), false);
  assert.equal(JSON.stringify(stored).includes("synthetic-service-token"), false);
  assert.equal(credentials.read, undefined);

  let retainedPlaintext;
  const result = await credentials.withDecryptedCredential(
    { companyId: companyA, credentialId },
    async (plaintext) => {
      retainedPlaintext = plaintext;
      assert.equal(plaintext.toString("utf8"), "synthetic-service-token");
      return "operation-complete";
    }
  );
  assert.equal(result, "operation-complete");
  assert.equal(retainedPlaintext.every((byte) => byte === 0), true);

  let rejectedPlaintext;
  const operationError = new Error("synthetic operation failure");
  await assert.rejects(
    credentials.withDecryptedCredential(
      { companyId: companyA, credentialId },
      (plaintext) => {
        rejectedPlaintext = plaintext;
        throw operationError;
      }
    ),
    operationError
  );
  assert.equal(rejectedPlaintext.every((byte) => byte === 0), true);

  const inventory = await credentials.tenantKeyInventory({
    companyId: companyA
  });
  assert.deepEqual(inventory, [
    {
      keyVersion: testOnlyKeyVersion("v1", key(3)),
      credentialCount: 1
    }
  ]);
  assert.equal(inventoryCompany, companyA);

  await assert.rejects(
    credentials.withDecryptedCredential(
      { companyId: companyB, credentialId },
      () => "must-not-run"
    ),
    { code: "credential_not_found" }
  );
  stored.connectionId = connectionB;
  await assert.rejects(
    credentials.withDecryptedCredential(
      { companyId: companyA, credentialId },
      () => "must-not-run"
    ),
    { code: "vault_authentication_failed" }
  );
});

test("credential service refuses invalid expiry instead of removing it", async () => {
  const serviceVault = vault("v1", { v1: key(4) });
  const persisted = [];
  const repository = {
    async storeEncryptedCredential(row) {
      persisted.push(row);
      return { ...row, revision: 1, expires_at: row.expiresAt };
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
  const input = {
    companyId: companyA,
    credentialId,
    provider: "instagram",
    connectionId: connectionA,
    credentialType: "access_token",
    plaintext: "synthetic-expiry-token"
  };

  for (const expiresAt of [0, false, "", new Date("invalid")]) {
    await assert.rejects(
      credentials.store({ ...input, expiresAt }),
      { code: "credential_expiry_invalid" }
    );
  }
  assert.equal(persisted.length, 0);

  const withoutExpiry = await credentials.store({
    ...input,
    expiresAt: null
  });
  assert.equal(withoutExpiry.expiresAt, null);
  assert.equal(persisted[0].expiresAt, null);

  const futureExpiry = new Date(Date.now() + 60000);
  const withExpiry = await credentials.store({
    ...input,
    expiresAt: futureExpiry
  });
  assert.equal(withExpiry.expiresAt, futureExpiry);
  assert.equal(persisted[1].expiresAt, futureExpiry);
});

test("credential service rotates with optimistic revision and inventories keys", async () => {
  const oldVault = vault("v1", { v1: key(1) });
  const oldEnvelope = oldVault.encrypt(
    "synthetic-rotation-token",
    context()
  );
  const rotatingVault = vault("v2", { v1: key(1), v2: key(2) }, 8);
  let update;
  let inventoryCompany;
  const repository = {
    async storeEncryptedCredential() {
      throw new Error("not expected");
    },
    async findEncryptedCredential() {
      return {
        company_id: companyA,
        id: credentialId,
        provider: "instagram",
        connection_id: connectionA,
        oauth_transaction_id: null,
        credential_type: "access_token",
        ciphertext: oldEnvelope.ciphertext,
        nonce: oldEnvelope.nonce,
        auth_tag: oldEnvelope.authTag,
        key_version: oldEnvelope.keyVersion,
        aad_version: oldEnvelope.aadVersion,
        revision: 7
      };
    },
    async rotateEncryptedCredential(input) {
      update = input;
      return { key_version: input.keyVersion, revision: 8 };
    },
    async listCredentialKeyVersions({ companyId }) {
      inventoryCompany = companyId;
      return [
        {
          keyVersion: testOnlyKeyVersion("v1", key(1)),
          credentialCount: 0
        },
        {
          keyVersion: testOnlyKeyVersion("v2", key(2)),
          credentialCount: 1
        }
      ];
    }
  };
  const credentials = createSocialCredentialService({
    repository,
    vault: rotatingVault
  });
  const result = await credentials.rotate({
    companyId: companyA,
    credentialId
  });
  assert.deepEqual(result, {
    changed: true,
    keyVersion: testOnlyKeyVersion("v2", key(2)),
    revision: 8
  });
  assert.equal(update.expectedRevision, 7);
  assert.notDeepEqual(update.nonce, oldEnvelope.nonce);
  assert.equal(Object.hasOwn(update, "plaintext"), false);

  assert.deepEqual(
    await credentials.tenantKeyInventory({ companyId: companyA }),
    [
      {
        keyVersion: testOnlyKeyVersion("v1", key(1)),
        credentialCount: 0
      },
      {
        keyVersion: testOnlyKeyVersion("v2", key(2)),
        credentialCount: 1
      }
    ]
  );
  assert.equal(inventoryCompany, companyA);
});

function fakeReauthRepository(initialDate = "2026-07-29T12:00:00.000Z") {
  const records = [];
  let now = new Date(initialDate);
  const state = {
    passwordHash: "x".repeat(60),
    authVersion: 3,
    role: "owner",
    userStatus: "active",
    membershipStatus: "active",
    companyStatus: "active"
  };

  function currentIdentity() {
    if (
      state.userStatus !== "active" ||
      state.membershipStatus !== "active" ||
      state.companyStatus !== "active" ||
      !["owner", "admin"].includes(state.role)
    ) {
      return null;
    }
    return {
      password_hash: state.passwordHash,
      auth_version: state.authVersion,
      role: state.role
    };
  }

  return {
    records,
    state,
    clock() {
      return new Date(now);
    },
    advance(milliseconds) {
      now = new Date(now.getTime() + milliseconds);
    },
    async findReauthIdentity({ companyId, userId }) {
      if (companyId !== companyA || userId !== userA) return null;
      return currentIdentity();
    },
    async createReauthGrant(record) {
      records.push({ ...record, consumed_at: null });
      return record;
    },
    async consumeReauthGrant(input) {
      const identity = currentIdentity();
      if (!identity) return null;
      const record = records.find(
        (item) =>
          item.companyId === input.companyId &&
          item.userId === input.userId &&
          item.tokenDigest === input.tokenDigest &&
          item.sessionJtiDigest === input.sessionJtiDigest &&
          item.action === input.action &&
          item.provider === input.provider &&
          item.targetConnectionId === input.targetConnectionId &&
          item.authVersion === Number(identity.auth_version) &&
          !item.consumed_at &&
          item.expiresAt > now
      );
      if (!record) return null;
      record.consumed_at = new Date(now);
      return { consumed_at: new Date(now) };
    }
  };
}

function session(overrides = {}) {
  return {
    tokenVersion: 2,
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE,
    subject: syntheticPrincipal,
    companyId: companyA,
    userId: userA,
    jti: "synthetic-session-jti-0001",
    ...overrides
  };
}

function reauthService(repository, randomByte = 4) {
  return createSocialReauthService({
    repository,
    comparePassword: async (password, passwordHash) =>
      password === "synthetic-password" &&
      passwordHash === repository.state.passwordHash,
    randomBytes: () => Buffer.alloc(32, randomByte),
    randomUuid: () => grantId,
    clock: () => repository.clock()
  });
}

test("reauth uses the repository identity and stores only opaque digests", async () => {
  const repository = fakeReauthRepository();
  const service = reauthService(repository);
  const now = repository.clock();
  const grant = await service.issue({
    session: session(),
    action: "social.connect",
    provider: "instagram",
    password: "synthetic-password",
    passwordHash: "attacker-controlled-hash-must-be-ignored"
  });

  assert.equal(grant.expiresAt.getTime() - now.getTime(), REAUTH_TTL_MS);
  assert.match(grant.token, /^[A-Za-z0-9_-]{40,100}$/);
  assert.equal(repository.records.length, 1);
  assert.equal(repository.records[0].authVersion, 3);
  assert.equal(repository.records[0].provider, "instagram");
  assert.equal(repository.records[0].targetConnectionId, null);
  const serialized = JSON.stringify(repository.records);
  assert.equal(serialized.includes(grant.token), false);
  assert.equal(serialized.includes("synthetic-password"), false);
  assert.equal(serialized.includes(repository.state.passwordHash), false);
  assert.match(repository.records[0].tokenDigest, /^[0-9a-f]{64}$/);
  assert.match(repository.records[0].sessionJtiDigest, /^[0-9a-f]{64}$/);
});

test("reauth target contract binds action, provider and target connection", () => {
  assert.deepEqual(
    requireTarget({
      action: "social.connect",
      provider: "instagram"
    }),
    {
      action: "social.connect",
      provider: "instagram",
      targetConnectionId: null
    }
  );
  assert.deepEqual(
    requireTarget({
      action: "social.disconnect",
      provider: "instagram",
      targetConnectionId: connectionA
    }),
    {
      action: "social.disconnect",
      provider: "instagram",
      targetConnectionId: connectionA
    }
  );
  assert.throws(
    () =>
      requireTarget({
        action: "social.connect",
        provider: "instagram",
        targetConnectionId: connectionA
      }),
    { code: "reauth_target_invalid" }
  );
  assert.throws(
    () =>
      requireTarget({
        action: "social.disconnect",
        provider: "instagram"
      }),
    { code: "reauth_target_invalid" }
  );
});

test("reauth grant is one-time and bound to tenant/session/action/provider/target", async () => {
  const repository = fakeReauthRepository();
  const service = reauthService(repository, 5);
  const grant = await service.issue({
    session: session(),
    action: "social.disconnect",
    provider: "instagram",
    targetConnectionId: connectionA,
    password: "synthetic-password"
  });

  for (const invalid of [
    {
      session: session({ companyId: companyB }),
      action: "social.disconnect",
      provider: "instagram",
      targetConnectionId: connectionA
    },
    {
      session: session({ jti: "synthetic-session-jti-other" }),
      action: "social.disconnect",
      provider: "instagram",
      targetConnectionId: connectionA
    },
    {
      session: session(),
      action: "social.revoke",
      provider: "instagram",
      targetConnectionId: connectionA
    },
    {
      session: session(),
      action: "social.disconnect",
      provider: "facebook",
      targetConnectionId: connectionA
    },
    {
      session: session(),
      action: "social.disconnect",
      provider: "instagram",
      targetConnectionId: connectionB
    }
  ]) {
    await assert.rejects(
      service.consume({ ...invalid, token: grant.token }),
      { code: "reauth_grant_invalid" }
    );
  }

  const accepted = await service.consume({
    session: session(),
    action: "social.disconnect",
    provider: "instagram",
    targetConnectionId: connectionA,
    token: grant.token
  });
  assert.equal(accepted.authorized, true);
  await assert.rejects(
    service.consume({
      session: session(),
      action: "social.disconnect",
      provider: "instagram",
      targetConnectionId: connectionA,
      token: grant.token
    }),
    { code: "reauth_grant_invalid" }
  );
});

test("reauth consumption rechecks current auth version and account membership", async (t) => {
  const scenarios = [
    ["auth version changed", (state) => { state.authVersion += 1; }],
    ["user disabled", (state) => { state.userStatus = "disabled"; }],
    [
      "membership disabled",
      (state) => { state.membershipStatus = "disabled"; }
    ],
    ["company disabled", (state) => { state.companyStatus = "disabled"; }],
    ["membership role downgraded", (state) => { state.role = "member"; }]
  ];

  for (const [name, mutate] of scenarios) {
    await t.test(name, async () => {
      const repository = fakeReauthRepository();
      const service = reauthService(repository, 6);
      const grant = await service.issue({
        session: session(),
        action: "social.revoke",
        provider: "instagram",
        targetConnectionId: connectionA,
        password: "synthetic-password"
      });
      mutate(repository.state);
      await assert.rejects(
        service.consume({
          session: session(),
          action: "social.revoke",
          provider: "instagram",
          targetConnectionId: connectionA,
          token: grant.token
        }),
        { code: "reauth_grant_invalid" }
      );
    });
  }
});

test("reauth refuses expired grants and untrusted repository identities", async () => {
  const repository = fakeReauthRepository();
  const service = reauthService(repository, 7);
  const grant = await service.issue({
    session: session(),
    action: "social.revoke",
    provider: "instagram",
    targetConnectionId: connectionA,
    password: "synthetic-password"
  });
  repository.advance(REAUTH_TTL_MS + 1);
  await assert.rejects(
    service.consume({
      session: session(),
      action: "social.revoke",
      provider: "instagram",
      targetConnectionId: connectionA,
      token: grant.token
    }),
    { code: "reauth_grant_invalid" }
  );

  const refusedRepository = fakeReauthRepository();
  refusedRepository.state.membershipStatus = "disabled";
  const refusedService = reauthService(refusedRepository, 8);
  await assert.rejects(
    refusedService.issue({
      session: session(),
      action: "social.connect",
      provider: "instagram",
      password: "synthetic-password",
      passwordHash: "x".repeat(60)
    }),
    { code: "reauth_credentials_invalid" }
  );
  assert.equal(refusedRepository.records.length, 0);
});

test("reauth session accepts only the strict current token contract", () => {
  const safe = requireSession(session({ authVersion: 999 }));
  assert.deepEqual(safe, {
    companyId: companyA,
    userId: userA,
    jti: "synthetic-session-jti-0001",
    subject: syntheticPrincipal
  });
  assert.equal(Object.hasOwn(safe, "authVersion"), false);

  for (const overrides of [
    { tokenVersion: undefined },
    { tokenVersion: 1 },
    { tokenVersion: "2" },
    { tokenVersion: 2.5 },
    { tokenVersion: 3 },
    { issuer: "unexpected-issuer" },
    { audience: "unexpected-audience" },
    { subject: "" },
    { jti: "too-short" }
  ]) {
    assert.throws(
      () => requireSession(session(overrides)),
      { code: "reauth_session_invalid" }
    );
  }
});

test("JWT adapter derives a tenant principal only from the verified v2 contract", () => {
  const identityConfig = {
    namespaceUuid: namespace,
    key: key(12),
    derivationVersion: identityVersion
  };
  const adapter = createSocialAuthAdapter(identityConfig);
  const claims = {
    token_version: 2,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    jti: "synthetic-jwt-jti-000001",
    sub: syntheticPrincipal,
    whatsapp: syntheticPrincipal,
    company_id: syntheticPrincipal
  };
  const principal = adapter.fromVerifiedJwt(claims);
  const expected = deriveSocialIdentity({
    namespaceUuid: namespace,
    derivationKey: identityConfig.key,
    derivationVersion: identityVersion,
    legacyCompanyId: syntheticPrincipal,
    legacyUserId: syntheticPrincipal
  });
  assert.deepEqual(principal, {
    tokenVersion: 2,
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE,
    subject: syntheticPrincipal,
    jti: claims.jti,
    companyId: expected.companyId,
    userId: expected.userId,
    derivationVersion: identityVersion
  });
  assert.equal(Object.hasOwn(principal, "authVersion"), false);
  assert.equal(JSON.stringify(principal).includes(syntheticPrincipal), true);
  assert.equal(audienceMatches([SESSION_AUDIENCE]), true);
  assert.equal(audienceMatches([SESSION_AUDIENCE, "other"]), false);

  for (const overrides of [
    { token_version: undefined },
    { token_version: 1 },
    { token_version: "2" },
    { token_version: 2.5 },
    { token_version: 3 },
    { iss: "unexpected-issuer" },
    { aud: "unexpected-audience" },
    { aud: [SESSION_AUDIENCE, "other"] },
    { jti: "too-short" },
    { whatsapp: "other-principal" },
    { company_id: "other-principal" }
  ]) {
    assert.throws(
      () => adapter.fromVerifiedJwt({ ...claims, ...overrides }),
      { code: "social_authenticated_principal_invalid" }
    );
  }
});

test("synthetic secrets never appear in error text", () => {
  const synthetic = crypto.randomBytes(32).toString("base64url");
  let caught;
  try {
    vault("v1", { v1: key(1) }).decrypt(
      {
        ciphertext: Buffer.from(synthetic),
        nonce: Buffer.alloc(12),
        authTag: Buffer.alloc(16),
        keyVersion: deriveVaultKeyVersion(2, key(2)),
        aadVersion: 1
      },
      context()
    );
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof SocialVaultError, true);
  assert.equal(caught.message.includes(synthetic), false);
  assert.equal(new SocialReauthError("x").message.includes(synthetic), false);
});
