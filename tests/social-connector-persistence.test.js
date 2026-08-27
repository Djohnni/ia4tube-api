"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const dns = require("node:dns");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const tls = require("node:tls");

const {
  createSocialAuthAdapter
} = require("../src/social/auth-adapter");
const {
  createConnectorContext
} = require("../src/social/connectors/contract");
const {
  assertInternalConnectorAudit,
  createPostgresConnectorAudit
} = require("../src/persistence/postgres/social-connector-audit");
const {
  createPostgresConnectorStore
} = require("../src/persistence/postgres/social-connector-store");
const {
  createPostgresOAuthRepository
} = require("../src/persistence/postgres/social-oauth-repository");
const {
  createSocialCredentialService
} = require("../src/social/credential-service");
const {
  ERROR_DEFINITIONS
} = require("../src/social/connectors/errors");
const {
  SESSION_AUDIENCE,
  SESSION_ISSUER
} = require("../src/social/reauth");

const ROOT = path.resolve(__dirname, "..");
const RUNTIME_ROLE = "ia4tube_social_runtime";
const NAMESPACE = "41cb8c58-0bf4-4bd9-83b2-3f2f96dfe29f";
const IDENTITY_CONFIG = Object.freeze({
  namespaceUuid: NAMESPACE,
  key: Buffer.alloc(32, 53),
  derivationVersion: "social-id-v1"
});

const IDS = Object.freeze({
  connection: "30000000-0000-4000-8000-000000000005",
  publication: "30000000-0000-4000-8000-000000000006",
  operation: "30000000-0000-4000-8000-000000000007",
  operationRetry: "30000000-0000-4000-8000-000000000011",
  transaction: "30000000-0000-4000-8000-000000000008",
  credential: "30000000-0000-4000-8000-000000000012",
  correlation: "30000000-0000-4000-8000-000000000009",
  audit: "30000000-0000-4000-8000-000000000010"
});

const SYNTHETIC_STATE = "synthetic-oauth-state-that-must-never-be-stored";
const SYNTHETIC_SESSION_JTI =
  "synthetic-session-jti-that-must-never-be-stored";
const SYNTHETIC_REDIRECT =
  "https://synthetic.invalid/social/oauth/callback";
const SYNTHETIC_SECRET_MARKER =
  "synthetic-access-token-that-must-never-appear";
const SYNTHETIC_MEDIA_BYTES = Buffer.from(
  "synthetic-jpeg-bytes-that-must-never-enter-postgres",
  "utf8"
);

function principal(legacyId) {
  return createSocialAuthAdapter(IDENTITY_CONFIG).fromVerifiedJwt({
    token_version: 2,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    jti: `synthetic-jwt-${legacyId}-000001`,
    sub: legacyId,
    whatsapp: legacyId,
    company_id: legacyId
  });
}

function contextFor(legacyId) {
  return createConnectorContext({
    principal: principal(legacyId),
    provider: "instagram",
    environment: "test",
    correlationId: IDS.correlation,
    auditEventId: IDS.audit
  });
}

const CONTEXT_A = contextFor("synthetic-company-a");
const CONTEXT_B = contextFor("synthetic-company-b");

function normalizeQuery(query, values) {
  if (typeof query === "string") {
    return { text: query, values: values || [] };
  }
  return {
    text: query?.text || "",
    values: query?.values || values || []
  };
}

function isTransactionPlumbing(text) {
  return (
    /^(BEGIN|COMMIT|ROLLBACK)$/i.test(text.trim()) ||
    /^SET LOCAL ROLE /i.test(text.trim()) ||
    /set_config\('ia4tube\.company_id'/i.test(text) ||
    /pg_advisory_xact_lock/i.test(text)
  );
}

function createFakePool(route = async () => ({ rows: [] })) {
  const calls = [];
  let connectCount = 0;
  let releaseCount = 0;
  const client = {
    async query(query, values) {
      const normalized = normalizeQuery(query, values);
      const call = Object.freeze({
        text: normalized.text,
        values: structuredClone(normalized.values)
      });
      calls.push(call);
      if (isTransactionPlumbing(call.text)) {
        return { rows: [] };
      }
      return route(call, calls);
    },
    release() {
      releaseCount += 1;
    }
  };
  return Object.freeze({
    async connect() {
      connectCount += 1;
      return client;
    },
    calls,
    counts() {
      return Object.freeze({ connectCount, releaseCount });
    }
  });
}

function productCalls(pool) {
  return pool.calls.filter((call) => !isTransactionPlumbing(call.text));
}

function flattenedValues(pool) {
  return productCalls(pool)
    .flatMap((call) => call.values)
    .flatMap((value) => {
      if (Buffer.isBuffer(value)) return [value.toString("utf8")];
      if (value && typeof value === "object") {
        return [JSON.stringify(value)];
      }
      return [String(value)];
    });
}

function assertScopedTransaction(pool, companyId) {
  const texts = pool.calls.map((call) => call.text.trim());
  assert.equal(texts[0], "BEGIN");
  assert.ok(texts.some((text) =>
    text === `SET LOCAL ROLE "${RUNTIME_ROLE}"`
  ));
  const companyScope = pool.calls.find((call) =>
    /set_config\('ia4tube\.company_id'/i.test(call.text)
  );
  assert.deepEqual(companyScope?.values, [companyId]);
  assert.equal(texts.at(-1), "COMMIT");
  assert.deepEqual(pool.counts(), { connectCount: 1, releaseCount: 1 });
}

function assertParameterized(call, forbiddenLiterals = []) {
  assert.match(call.text, /\$\d+/);
  for (const literal of forbiddenLiterals) {
    assert.equal(call.text.includes(literal), false);
  }
}

function connectorRecord(overrides = {}) {
  return {
    companyId: CONTEXT_A.companyId,
    id: IDS.connection,
    provider: "instagram",
    state: "authorization_pending",
    account: null,
    revision: 1,
    ...overrides
  };
}

function publicationRecord(overrides = {}) {
  return {
    companyId: CONTEXT_A.companyId,
    id: IDS.publication,
    connectionId: IDS.connection,
    provider: "instagram",
    state: "ready",
    confirmedProviderReference: null,
    reconciliationReference: null,
    errorCode: null,
    revision: 1,
    ...overrides
  };
}

function professionalAccount(overrides = {}) {
  return {
    externalId: "synthetic-professional-account-001",
    username: "synthetic_company",
    displayName: "Synthetic Company",
    accountType: "business",
    ...overrides
  };
}

function credentialEnvelope(overrides = {}) {
  return {
    id: IDS.credential,
    credentialType: "access_token",
    ciphertext: Buffer.from("synthetic-ciphertext-envelope", "utf8"),
    nonce: Buffer.alloc(12, 31),
    authTag: Buffer.alloc(16, 47),
    keyVersion: "social-kek-v1",
    aadVersion: 1,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides
  };
}

function connectionRow(overrides = {}) {
  return {
    company_id: CONTEXT_A.companyId,
    id: IDS.connection,
    provider: "instagram",
    status: "authorization_pending",
    revision: 1,
    external_account_id: null,
    ...overrides
  };
}

function publicationRow(overrides = {}) {
  return {
    company_id: CONTEXT_A.companyId,
    id: IDS.publication,
    connection_id: IDS.connection,
    provider: "instagram",
    state: "ready",
    confirmed_provider_reference: null,
    reconciliation_reference: null,
    error_code: null,
    revision: 1,
    ...overrides
  };
}

function oauthInput(overrides = {}) {
  return {
    authorizationHandle: IDS.transaction,
    connectionId: IDS.connection,
    state: SYNTHETIC_STATE,
    redirectUri: SYNTHETIC_REDIRECT,
    sessionJti: SYNTHETIC_SESSION_JTI,
    purpose: "connect",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    ...overrides
  };
}

function oauthConsumeInput(overrides = {}) {
  return {
    authorizationHandle: IDS.transaction,
    state: SYNTHETIC_STATE,
    redirectUri: SYNTHETIC_REDIRECT,
    sessionJti: SYNTHETIC_SESSION_JTI,
    purpose: "connect",
    ...overrides
  };
}

function oauthExpireInput(overrides = {}) {
  return oauthConsumeInput({
    observedAt: new Date(),
    ...overrides
  });
}

function credentialServiceHarness() {
  const contexts = [];
  const sealed = [];
  const repository = {
    async storeEncryptedCredential() {},
    async findEncryptedCredential() {},
    async rotateEncryptedCredential() {},
    async listCredentialKeyVersions() { return []; }
  };
  const vault = {
    encrypt(plaintext, context) {
      contexts.push(context);
      const envelope = {
        ciphertext: Buffer.from("sealed-synthetic-token", "utf8"),
        nonce: Buffer.alloc(12, 71),
        authTag: Buffer.alloc(16, 73),
        keyVersion: "social-kek-v1",
        aadVersion: 1
      };
      sealed.push(envelope);
      assert.equal(plaintext.toString("utf8"), SYNTHETIC_SECRET_MARKER);
      return envelope;
    },
    decrypt() { return Buffer.from("unused", "utf8"); },
    rotate() { return { changed: false, envelope: {} }; }
  };
  return Object.freeze({
    contexts,
    sealed,
    service: createSocialCredentialService({ repository, vault })
  });
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function oauthAuthorizationRow(overrides = {}) {
  return {
    id: IDS.transaction,
    connection_id: IDS.connection,
    purpose: "connect",
    state_digest: sha256(SYNTHETIC_STATE),
    redirect_uri_digest: sha256(SYNTHETIC_REDIRECT),
    session_jti_digest: sha256(SYNTHETIC_SESSION_JTI),
    expires_at: new Date(Date.now() + 5 * 60 * 1000),
    consumed_at: null,
    cancelled_at: null,
    failed_at: null,
    failure_code: null,
    ...overrides
  };
}

function oauthTerminalRow(overrides = {}) {
  return {
    id: IDS.transaction,
    connection_id: IDS.connection,
    purpose: "connect",
    expires_at: new Date(Date.now() + 5 * 60 * 1000),
    ...overrides
  };
}

function publishReservation(operationId, overrides = {}) {
  const {
    digest = "d".repeat(64),
    image = {
      mediaId: "synthetic-media-001",
      mimeType: "image/jpeg"
    },
    ...payloadOverrides
  } = overrides;
  const payload = {
    operationId,
    publicationId: IDS.publication,
    connectionId: IDS.connection,
    image,
    caption: "Synthetic caption",
    ...payloadOverrides
  };
  return {
    capability: "publishImage",
    operationId,
    digest,
    payload
  };
}

function mediaMetadataDigest(image = {
  mediaId: "synthetic-media-001",
  mimeType: "image/jpeg"
}) {
  return crypto.createHash("sha256").update(JSON.stringify({
    mediaId: image.mediaId,
    mimeType: image.mimeType
  }), "utf8").digest("hex");
}

async function withNetworkDenied(operation) {
  const denied = [];
  const replacements = [
    [globalThis, "fetch"],
    [http, "request"],
    [http, "get"],
    [https, "request"],
    [https, "get"],
    [net, "connect"],
    [net, "createConnection"],
    [tls, "connect"],
    [dns, "lookup"],
    [dns, "resolve"],
    [childProcess, "exec"],
    [childProcess, "execFile"],
    [childProcess, "spawn"]
  ];
  const originals = replacements.map(([owner, key]) => [owner, key, owner[key]]);
  const reject = function rejectExternalSideEffect(...args) {
    denied.push(args.length);
    throw new Error("synthetic_external_side_effect_blocked");
  };
  try {
    for (const [owner, key] of replacements) owner[key] = reject;
    return await operation();
  } finally {
    for (const [owner, key, original] of originals) owner[key] = original;
    assert.equal(denied.length, 0);
  }
}

test("connector store scopes every query with role and authenticated company", async () => {
  const pool = createFakePool();
  const store = createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  });
  const result = await store.scope(CONTEXT_A).getConnection(IDS.connection);
  assert.equal(result, null);
  assertScopedTransaction(pool, CONTEXT_A.companyId);
  const [query] = productCalls(pool);
  assertParameterized(query, [CONTEXT_A.companyId, IDS.connection]);
  assert.deepEqual(query.values, [
    CONTEXT_A.companyId,
    IDS.connection,
    "instagram"
  ]);
});

test("browser-shaped authority cannot replace the authenticated company", async () => {
  const pool = createFakePool();
  const store = createPostgresConnectorStore({ pool, runtimeRole: RUNTIME_ROLE });
  await assert.rejects(
    async () => store.scope(CONTEXT_A).getConnection({
      id: IDS.connection,
      companyId: CONTEXT_B.companyId
    })
  );
  assert.equal(productCalls(pool).length, 0);
  assert.equal(
    pool.calls.some((call) => call.text.trim() === "ROLLBACK"),
    true
  );
});

test("runExclusive uses one transaction, one tenant scope and an advisory xact lock", async () => {
  const pool = createFakePool();
  const scope = createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A);
  const marker = await scope.runExclusive(async (txScope) => {
    assert.notEqual(txScope, scope);
    assert.equal(await txScope.getConnection(IDS.connection), null);
    assert.equal(await txScope.getPublication(IDS.publication), null);
    return "synthetic-exclusive-result";
  });
  assert.equal(marker, "synthetic-exclusive-result");
  assertScopedTransaction(pool, CONTEXT_A.companyId);
  assert.equal(
    pool.calls.filter((call) => /pg_advisory_xact_lock/i.test(call.text)).length,
    1
  );
  assert.equal(pool.calls.filter((call) => call.text.trim() === "BEGIN").length, 1);
  assert.equal(pool.calls.filter((call) => call.text.trim() === "COMMIT").length, 1);
  assert.equal(productCalls(pool).length, 2);
});

test("exclusive locks are derived from tenant and provider rather than a global lock", async () => {
  const lockInputs = [];
  async function exercise(context) {
    const pool = createFakePool();
    await createPostgresConnectorStore({
      pool,
      runtimeRole: RUNTIME_ROLE
    }).scope(context).runExclusive(async () => null);
    const lock = pool.calls.find((call) =>
      /pg_advisory_xact_lock/i.test(call.text)
    );
    assert.ok(lock);
    lockInputs.push(JSON.stringify(lock.values));
  }
  await exercise(CONTEXT_A);
  await exercise(CONTEXT_B);
  assert.notEqual(lockInputs[0], lockInputs[1]);
});

test("legacy pending and active connection rows map to definitive states", async () => {
  for (const [persisted, expected] of [
    ["pending", "authorization_pending"],
    ["active", "connected"]
  ]) {
    const pool = createFakePool(async (call) => ({
      rows: /FROM ia4tube_social\.social_connections connection/is.test(
        call.text
      )
        ? [connectionRow({ status: persisted })]
        : []
    }));
    const result = await createPostgresConnectorStore({
      pool,
      runtimeRole: RUNTIME_ROLE
    }).scope(CONTEXT_A).getConnection(IDS.connection);
    assert.equal(result.state, expected);
  }
});

test("connection insert and update are parameterized and guarded by revision CAS", async () => {
  let connectionExists = false;
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_connections connection/is.test(call.text)) {
      return { rows: connectionExists ? [connectionRow()] : [] };
    }
    if (/INSERT INTO .*social_connections/is.test(call.text)) {
      connectionExists = true;
      return { rows: [{ id: IDS.connection }] };
    }
    if (/UPDATE .*social_connections/is.test(call.text)) return { rows: [] };
    return { rows: [] };
  });
  const scope = createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A);
  await scope.saveConnection(connectorRecord(), null);
  await assert.rejects(
    scope.saveConnection(connectorRecord({ state: "failed", revision: 2 }), 1)
  );
  const writes = productCalls(pool);
  const insert = writes.find((call) =>
    /INSERT INTO .*social_connections/is.test(call.text)
  );
  const update = writes.find((call) =>
    /UPDATE .*social_connections/is.test(call.text)
  );
  assert.ok(insert);
  assert.ok(update);
  for (const call of [insert, update]) {
    assertParameterized(call, [CONTEXT_A.companyId, IDS.connection]);
  }
  assert.match(update.text, /revision\s*=/i);
  assert.ok(update.values.includes(1));
});

test("saveConnection cannot bypass atomic credential activation", async () => {
  const pool = createFakePool();
  await assert.rejects(createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).saveConnection(connectorRecord({
    state: "connected",
    account: professionalAccount(),
    revision: 2
  }), 1), { code: "credential_unavailable" });
  assert.equal(pool.calls.length, 0);
});

test("credential activation rejects plaintext material before opening a transaction", async () => {
  const pool = createFakePool();
  await assert.rejects(createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).activateConnectionWithCredential(
    connectorRecord({
      state: "connected",
      account: professionalAccount(),
      revision: 2
    }),
    1,
    {
      ...credentialEnvelope(),
      accessToken: SYNTHETIC_SECRET_MARKER
    }
  ));
  assert.equal(pool.calls.length, 0);
});

test("credential service seals once with final connection AAD and clears plaintext and envelope buffers", async () => {
  const harness = credentialServiceHarness();
  const plaintext = Buffer.from(SYNTHETIC_SECRET_MARKER, "utf8");
  let callbackEnvelope;
  const result = await harness.service.withEncryptedConnectionCredential({
    companyId: CONTEXT_A.companyId,
    connectionId: IDS.connection,
    credentialId: IDS.credential,
    provider: "instagram",
    credentialType: "access_token",
    plaintext,
    expiresAt: credentialEnvelope().expiresAt
  }, async (envelope) => {
    callbackEnvelope = envelope;
    assert.notEqual(envelope.ciphertext.length, 0);
    assert.equal(Object.hasOwn(envelope, "plaintext"), false);
    return Object.freeze({ stored: true });
  });
  assert.deepEqual(result, { stored: true });
  assert.equal(harness.contexts.length, 1);
  assert.deepEqual(harness.contexts[0], {
    companyId: CONTEXT_A.companyId,
    provider: "instagram",
    credentialId: IDS.credential,
    credentialType: "access_token",
    subjectType: "connection",
    subjectId: IDS.connection
  });
  assert.ok(plaintext.every((byte) => byte === 0));
  for (const field of ["ciphertext", "nonce", "authTag"]) {
    assert.ok(callbackEnvelope[field].every((byte) => byte === 0));
    assert.ok(harness.sealed[0][field].every((byte) => byte === 0));
  }
  assert.equal(JSON.stringify(result).includes(SYNTHETIC_SECRET_MARKER), false);
});

test("credential service clears token and sealed buffers when the transactional callback fails", async () => {
  const harness = credentialServiceHarness();
  const plaintext = Buffer.from(SYNTHETIC_SECRET_MARKER, "utf8");
  let callbackEnvelope;
  await assert.rejects(
    harness.service.withEncryptedConnectionCredential({
      companyId: CONTEXT_A.companyId,
      connectionId: IDS.connection,
      credentialId: IDS.credential,
      provider: "instagram",
      credentialType: "access_token",
      plaintext
    }, async (envelope) => {
      callbackEnvelope = envelope;
      throw Object.assign(new Error("synthetic_transaction_failure"), {
        code: "synthetic_transaction_failure"
      });
    }),
    { code: "synthetic_transaction_failure" }
  );
  assert.ok(plaintext.every((byte) => byte === 0));
  for (const field of ["ciphertext", "nonce", "authTag"]) {
    assert.ok(callbackEnvelope[field].every((byte) => byte === 0));
  }
});

test("connection, professional account and encrypted credential activate atomically", async () => {
  let activated = false;
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_connections connection/is.test(call.text)) {
      return { rows: [connectionRow(activated
        ? {
          status: "connected",
          revision: 2,
          external_account_id: "synthetic-account-row-001",
          external_id: professionalAccount().externalId,
          username: professionalAccount().username,
          display_name: professionalAccount().displayName,
          account_type: professionalAccount().accountType
        }
        : { status: "authorization_pending", revision: 1 })] };
    }
    if (/UPDATE ia4tube_social\.social_connections/is.test(call.text)) {
      activated = true;
      return { rows: [{ id: IDS.connection }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_external_accounts/is.test(
      call.text
    )) {
      return { rows: [{ id: "synthetic-account-row-001" }], rowCount: 1 };
    }
    if (/UPDATE ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )) {
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )) {
      return { rows: [{
        id: IDS.credential,
        credential_type: "access_token",
        key_version: "social-kek-v1",
        aad_version: 1,
        revision: 1,
        expires_at: credentialEnvelope().expiresAt
      }], rowCount: 1 };
    }
    return { rows: [{}], rowCount: 1 };
  });
  const result = await createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).activateConnectionWithCredential(
    connectorRecord({
      state: "connected",
      account: professionalAccount(),
      revision: 2
    }),
    1,
    credentialEnvelope()
  );
  assert.equal(result.connection.state, "connected");
  assert.equal(result.connection.account.accountType, "business");
  assert.equal(result.credential.id, IDS.credential);
  assert.equal(Object.hasOwn(result.credential, "ciphertext"), false);
  assert.equal(Object.hasOwn(result.credential, "nonce"), false);
  assert.equal(Object.hasOwn(result.credential, "authTag"), false);
  assertScopedTransaction(pool, CONTEXT_A.companyId);

  const calls = productCalls(pool);
  const connectionUpdate = calls.findIndex((call) =>
    /UPDATE ia4tube_social\.social_connections/is.test(call.text)
  );
  const accountInsert = calls.findIndex((call) =>
    /INSERT INTO ia4tube_social\.social_external_accounts/is.test(call.text)
  );
  const credentialInsert = calls.findIndex((call) =>
    /INSERT INTO ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )
  );
  const connectionAudit = calls.findIndex((call) =>
    call.values.includes("social.connection.state_transition")
  );
  const credentialAudit = calls.findIndex((call) =>
    call.values.includes("social.credential.stored")
  );
  assert.ok(connectionUpdate >= 0);
  assert.ok(accountInsert > connectionUpdate);
  assert.ok(credentialInsert > accountInsert);
  assert.ok(connectionAudit > credentialInsert);
  assert.ok(credentialAudit > connectionAudit);
  assert.equal(
    pool.calls.filter((call) => /pg_advisory_xact_lock/i.test(call.text)).length,
    1
  );
  assert.equal(JSON.stringify(pool.calls).includes(SYNTHETIC_SECRET_MARKER), false);
  assertParameterized(calls[credentialInsert], [
    CONTEXT_A.companyId,
    IDS.connection,
    IDS.credential
  ]);
});

test("credential activation failure rolls back every preceding write", async () => {
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_connections connection/is.test(call.text)) {
      return { rows: [connectionRow({
        status: "authorization_pending",
        revision: 1
      })] };
    }
    if (/UPDATE ia4tube_social\.social_connections/is.test(call.text)) {
      return { rows: [{ id: IDS.connection }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_external_accounts/is.test(
      call.text
    )) {
      return { rows: [{ id: "synthetic-account-row-001" }], rowCount: 1 };
    }
    if (/UPDATE ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )) {
      return { rows: [{ id: "synthetic-old-credential" }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [] };
  });
  await assert.rejects(createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).activateConnectionWithCredential(
    connectorRecord({
      state: "connected",
      account: professionalAccount(),
      revision: 2
    }),
    1,
    credentialEnvelope()
  ));
  assert.equal(
    pool.calls.some((call) => call.text.trim() === "ROLLBACK"),
    true
  );
  assert.equal(
    pool.calls.some((call) => call.text.trim() === "COMMIT"),
    false
  );
  assert.equal(
    productCalls(pool).some((call) =>
      call.values.includes("social.connection.state_transition") ||
      call.values.includes("social.credential.stored")
    ),
    false
  );
  const calls = productCalls(pool);
  const revoke = calls.findIndex((call) =>
    /UPDATE ia4tube_social\.social_encrypted_credentials/is.test(call.text)
  );
  const replacement = calls.findIndex((call) =>
    /INSERT INTO ia4tube_social\.social_encrypted_credentials/is.test(call.text)
  );
  assert.ok(revoke >= 0);
  assert.ok(replacement > revoke);
});

test("consumed OAuth credential is bound to the connection without reading its envelope", async () => {
  let activated = false;
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_connections connection/is.test(call.text)) {
      return { rows: [connectionRow(activated
        ? {
          status: "connected",
          revision: 2,
          external_account_id: "synthetic-account-row-001",
          external_id: professionalAccount().externalId,
          username: professionalAccount().username,
          display_name: professionalAccount().displayName,
          account_type: professionalAccount().accountType
        }
        : { status: "authorization_pending", revision: 1 })] };
    }
    if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [{ id: IDS.transaction }] };
    }
    if (
      /SELECT id, revision[\s\S]*social_encrypted_credentials/is.test(
        call.text
      )
    ) {
      return { rows: [{ id: IDS.credential, revision: 1 }] };
    }
    if (/UPDATE ia4tube_social\.social_connections/is.test(call.text)) {
      activated = true;
      return { rows: [{ id: IDS.connection }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_external_accounts/is.test(
      call.text
    )) {
      return { rows: [{ id: "synthetic-account-row-001" }], rowCount: 1 };
    }
    if (
      /UPDATE ia4tube_social\.social_encrypted_credentials/is.test(call.text) &&
      /oauth_transaction_id=NULL/is.test(call.text)
    ) {
      return { rows: [{ id: IDS.credential }], rowCount: 1 };
    }
    if (/UPDATE ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )) {
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)) {
      return { rows: [{}], rowCount: 1 };
    }
    return { rows: [] };
  });
  const connection = await createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).activateConnectionFromAuthorization(
    connectorRecord({
      state: "connected",
      account: professionalAccount(),
      revision: 2
    }),
    1,
    IDS.transaction
  );
  assert.equal(connection.state, "connected");
  assert.equal(connection.account.accountType, "business");
  assertScopedTransaction(pool, CONTEXT_A.companyId);
  const calls = productCalls(pool);
  const oauthRead = calls.findIndex((call) =>
    /FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)
  );
  const credentialRead = calls.findIndex((call) =>
    /SELECT id, revision[\s\S]*social_encrypted_credentials/is.test(call.text)
  );
  const connectionUpdate = calls.findIndex((call) =>
    /UPDATE ia4tube_social\.social_connections/is.test(call.text)
  );
  const rebound = calls.findIndex((call) =>
    /UPDATE ia4tube_social\.social_encrypted_credentials/is.test(call.text) &&
    /oauth_transaction_id=NULL/is.test(call.text)
  );
  assert.ok(oauthRead >= 0);
  assert.ok(credentialRead > oauthRead);
  assert.ok(connectionUpdate > credentialRead);
  assert.ok(rebound > connectionUpdate);
  assert.match(calls[oauthRead].text, /consumed_at IS NOT NULL/i);
  assert.match(calls[oauthRead].text, /initiated_by_user_id=\$5/i);
  assert.deepEqual(calls[oauthRead].values, [
    CONTEXT_A.companyId,
    IDS.transaction,
    "instagram",
    IDS.connection,
    CONTEXT_A.userId
  ]);
  assert.doesNotMatch(calls[credentialRead].text, /ciphertext|nonce|auth_tag/i);
  assert.equal(
    JSON.stringify(pool.calls).includes(SYNTHETIC_SECRET_MARKER),
    false
  );
});

test("unconsumed OAuth cannot activate or bind a staged credential", async () => {
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_connections connection/is.test(call.text)) {
      return { rows: [connectionRow({
        status: "authorization_pending",
        revision: 1
      })] };
    }
    if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [] };
    }
    return { rows: [] };
  });
  await assert.rejects(createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).activateConnectionFromAuthorization(
    connectorRecord({
      state: "connected",
      account: professionalAccount(),
      revision: 2
    }),
    1,
    IDS.transaction
  ), { code: "authorization_expired" });
  assert.equal(
    productCalls(pool).some((call) =>
      /UPDATE ia4tube_social\.social_(?:connections|encrypted_credentials)/is.test(
        call.text
      )
    ),
    false
  );
  assert.equal(
    pool.calls.some((call) => call.text.trim() === "ROLLBACK"),
    true
  );
});

test("publication attempts cannot be recorded outside savePublication", () => {
  const pool = createFakePool();
  const scope = createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A);
  assert.equal(Object.hasOwn(scope, "recordPublicationAttempt"), false);
  assert.equal(scope.recordPublicationAttempt, undefined);
  assert.equal(pool.calls.length, 0);
});

test("repeated disconnected persistence idempotently sanitizes legacy account material", async () => {
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_connections connection/is.test(call.text)) {
      return { rows: [connectionRow({
        status: "disconnected",
        revision: 1
      })] };
    }
    if (/UPDATE ia4tube_social\.social_external_accounts/is.test(call.text)) {
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )) {
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE ia4tube_social\.social_connection_scopes/is.test(
      call.text
    )) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [{}], rowCount: 1 };
  });
  const result = await createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).ensureDisconnected(IDS.connection);
  assert.equal(result.state, "disconnected");
  const calls = productCalls(pool);
  for (const pattern of [
    /UPDATE ia4tube_social\.social_external_accounts/is,
    /UPDATE ia4tube_social\.social_encrypted_credentials/is,
    /UPDATE ia4tube_social\.social_connection_scopes/is
  ]) {
    const call = calls.find((candidate) => pattern.test(candidate.text));
    assert.ok(call);
    assertParameterized(call, [CONTEXT_A.companyId, IDS.connection]);
  }
  assert.equal(
    calls.some((call) => /SELECT .*ciphertext/is.test(call.text)),
    false
  );
});

test("publication CAS rejects a stale revision and never stores media bytes", async () => {
  const pool = createFakePool(async (call) => ({
    rows: /FROM ia4tube_social\.social_publications/is.test(call.text)
      ? [publicationRow()]
      : []
  }));
  const scope = createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A);
  await assert.rejects(scope.savePublication(publicationRecord({
    media: SYNTHETIC_MEDIA_BYTES
  }), 1));
  assert.equal(pool.calls.length, 0);

  await assert.rejects(scope.savePublication(publicationRecord({
    state: "publishing",
    revision: 2
  }), 1));
  const write = productCalls(pool).find((call) =>
    /UPDATE ia4tube_social\.social_publications/is.test(call.text)
  );
  assert.ok(write);
  assertParameterized(write, [CONTEXT_A.companyId, IDS.publication]);
  assert.match(write.text, /revision/i);
  assert.equal(
    flattenedValues(pool).some((value) =>
      value.includes(SYNTHETIC_MEDIA_BYTES.toString("utf8"))
    ),
    false
  );
});

test("provider-confirming remains unconfirmed and its attempt can omit a reference", async () => {
  let persistedState = "publishing";
  let revision = 1;
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_publications/is.test(call.text)) {
      return { rows: [publicationRow({
        state: persistedState,
        revision,
        reconciliation_reference: null
      })] };
    }
    if (/UPDATE ia4tube_social\.social_publications/is.test(call.text)) {
      persistedState = "provider_confirming";
      revision = 2;
      return { rows: [{ id: IDS.publication }], rowCount: 1 };
    }
    if (/UPDATE ia4tube_social\.social_publication_attempts/is.test(
      call.text
    )) {
      return { rows: [{ attempt_number: 1 }], rowCount: 1 };
    }
    return { rows: [{}], rowCount: 1 };
  });
  const pending = await createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).savePublication(publicationRecord({
    state: "provider_confirming",
    revision: 2,
    reconciliationReference: null
  }), 1);
  assert.equal(pending.state, "provider_confirming");
  assert.equal(pending.confirmedProviderReference, null);
  assert.equal(pending.reconciliationReference, null);
  const attemptUpdate = productCalls(pool).find((call) =>
    /UPDATE ia4tube_social\.social_publication_attempts/is.test(call.text)
  );
  assert.ok(attemptUpdate);
  assert.ok(attemptUpdate.values.includes("provider_confirming"));
  assert.equal(attemptUpdate.values.includes(null), true);
  assert.match(attemptUpdate.text, /finished_at\s*=\s*COALESCE/i);
  assert.match(attemptUpdate.text, /duration_ms\s*=\s*COALESCE/i);

  const untouchedPool = createFakePool();
  await assert.rejects(createPostgresConnectorStore({
    pool: untouchedPool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).savePublication(publicationRecord({
    state: "published",
    revision: 2,
    confirmedProviderReference: null
  }), 1));
  assert.equal(untouchedPool.calls.length, 0);
});

test("publication attempt rows and audit events are written automatically in order", async () => {
  let persistedState = "ready";
  let revision = 1;
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_publications/is.test(call.text)) {
      return { rows: [publicationRow({ state: persistedState, revision })] };
    }
    if (/UPDATE ia4tube_social\.social_publications/is.test(call.text)) {
      persistedState = "publishing";
      revision = 2;
      return { rows: [{ id: IDS.publication }], rowCount: 1 };
    }
    if (/SELECT COALESCE\(MAX\(attempt_number\)/is.test(call.text)) {
      return { rows: [{ next_attempt: 1 }] };
    }
    return { rows: [{}], rowCount: 1 };
  });
  const result = await createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).savePublication(publicationRecord({
    state: "publishing",
    revision: 2
  }), 1);
  assert.equal(result.state, "publishing");
  assertScopedTransaction(pool, CONTEXT_A.companyId);

  const calls = productCalls(pool);
  const attemptInsert = calls.findIndex((call) =>
    /INSERT INTO ia4tube_social\.social_publication_attempts/is.test(call.text)
  );
  const attemptAudit = calls.findIndex((call) =>
    call.values.includes("social.publication.attempt_recorded") &&
    call.values.includes("state_started")
  );
  const transitionAudit = calls.findIndex((call) =>
    call.values.includes("social.publication.state_transition") &&
    call.values.includes("to_publishing")
  );
  assert.ok(attemptInsert >= 0);
  assert.ok(attemptAudit > attemptInsert);
  assert.ok(transitionAudit > attemptAudit);
  for (const index of [attemptAudit, transitionAudit]) {
    assert.ok(calls[index].values.includes(IDS.connection));
    assert.ok(calls[index].values.includes(IDS.publication));
  }
});

test("provider references reject URLs and secret-shaped values before SQL", async () => {
  for (const record of [
    publicationRecord({
      state: "published",
      confirmedProviderReference:
        "https://synthetic.invalid/publication/provider-reference",
      revision: 2
    }),
    publicationRecord({
      state: "provider_confirming",
      reconciliationReference: "access_token_synthetic_reference",
      revision: 2
    })
  ]) {
    const pool = createFakePool();
    await assert.rejects(createPostgresConnectorStore({
      pool,
      runtimeRole: RUNTIME_ROLE
    }).scope(CONTEXT_A).savePublication(record, 1));
    assert.equal(pool.calls.length, 0);
  }
});

test("idempotency is tenant-scoped and parameterized by capability, operation and digest", async () => {
  const pools = [];
  for (const context of [CONTEXT_A, CONTEXT_B]) {
    const pool = createFakePool(async (call) => {
      if (/idempoten/i.test(call.text)) {
        return { rows: [{
          status: "acquired",
          request_digest: "a".repeat(64),
          result_payload: null,
          error_code: null
        }] };
      }
      return { rows: [] };
    });
    pools.push(pool);
    const reservation = await createPostgresConnectorStore({
      pool,
      runtimeRole: RUNTIME_ROLE
    }).scope(context).beginIdempotency({
      capability: "publishImage",
      operationId: IDS.operation,
      digest: "a".repeat(64),
      payload: {
        operationId: IDS.operation,
        publicationId: IDS.publication,
        connectionId: IDS.connection,
        image: { mediaId: "synthetic-media-001", mimeType: "image/jpeg" },
        caption: "Synthetic caption"
      }
    });
    assert.equal(reservation.status, "acquired");
    assertScopedTransaction(pool, context.companyId);
  }
  for (const pool of pools) {
    const calls = productCalls(pool);
    assert.ok(calls.length >= 1);
    for (const call of calls) {
      assert.equal(call.text.includes(CONTEXT_A.companyId), false);
      assert.equal(call.text.includes(CONTEXT_B.companyId), false);
      assert.equal(call.text.includes(IDS.operation), false);
    }
  }
});

test("a reused idempotency key with a different digest fails closed", async () => {
  const pool = createFakePool(async (call) => {
    if (/idempoten/i.test(call.text)) {
      if (/^\s*INSERT/i.test(call.text)) return { rows: [] };
      return { rows: [{
        provider: "instagram",
        capability: "publishImage",
        request_hash: "a".repeat(64),
        status: "completed",
        result_payload: { synthetic: true },
        error_code: null
      }] };
    }
    return { rows: [] };
  });
  const scope = createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A);
  await assert.rejects(scope.beginIdempotency({
    capability: "publishImage",
    operationId: IDS.operation,
    digest: "b".repeat(64),
    payload: {
      operationId: IDS.operation,
      publicationId: IDS.publication,
      connectionId: IDS.connection,
      image: { mediaId: "synthetic-media-001", mimeType: "image/jpeg" },
      caption: "Synthetic caption"
    }
  }));
});

test("the same tenant, operation and payload returns the stored completion", async () => {
  const requestHash = "c".repeat(64);
  const storedResult = {
    publicationId: IDS.publication,
    connectionId: IDS.connection,
    provider: "instagram",
    state: "published",
    confirmedProviderReference: "synthetic-provider-reference-001",
    reconciliationReference: null,
    revision: 3
  };
  const pool = createFakePool(async (call) => {
    if (/INSERT INTO .*social_idempotency_operations/is.test(call.text)) {
      return { rows: [] };
    }
    if (/FROM ia4tube_social\.social_idempotency_operations/is.test(call.text)) {
      return { rows: [{
        provider: "instagram",
        capability: "publishImage",
        request_hash: requestHash,
        status: "completed",
        result_payload: storedResult,
        error_code: null
      }] };
    }
    return { rows: [] };
  });
  const reservation = await createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).beginIdempotency({
    capability: "publishImage",
    operationId: IDS.operation,
    digest: requestHash,
    payload: {
      operationId: IDS.operation,
      publicationId: IDS.publication,
      connectionId: IDS.connection,
      image: { mediaId: "synthetic-media-001", mimeType: "image/jpeg" },
      caption: "Synthetic caption"
    }
  });
  assert.deepEqual(reservation, {
    status: "completed",
    result: storedResult,
    errorCode: null
  });
  assert.equal(
    productCalls(pool).some((call) =>
      /INSERT INTO .*social_publications/is.test(call.text)
    ),
    false
  );
});

test("publish retry reuses a failed publication without inserting a second row", async () => {
  const reservation = publishReservation(IDS.operationRetry);
  const prior = {
    connection_id: IDS.connection,
    provider: "instagram",
    media_reference: reservation.payload.image.mediaId,
    media_metadata_digest: mediaMetadataDigest(reservation.payload.image),
    caption: reservation.payload.caption,
    state: "failed_temporary",
    request_hash: reservation.digest
  };
  const pool = createFakePool(async (call) => {
    if (/INSERT INTO .*social_idempotency_operations/is.test(call.text)) {
      return { rows: [{ operation_id: IDS.operationRetry }] };
    }
    if (/FROM ia4tube_social\.social_publications/is.test(call.text)) {
      return { rows: [prior] };
    }
    return { rows: [] };
  });
  const result = await createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).beginIdempotency(reservation);
  assert.deepEqual(result, { status: "acquired" });
  assert.equal(
    productCalls(pool).some((call) =>
      /INSERT INTO .*social_publications/is.test(call.text)
    ),
    false
  );
  assert.equal(
    productCalls(pool).some((call) =>
      /UPDATE .*social_publications/is.test(call.text)
    ),
    false
  );
});

test("publish retry refuses changed payload and rolls back its reservation", async () => {
  const reservation = publishReservation(IDS.operationRetry, {
    caption: "Changed synthetic caption"
  });
  const pool = createFakePool(async (call) => {
    if (/INSERT INTO .*social_idempotency_operations/is.test(call.text)) {
      return { rows: [{ operation_id: IDS.operationRetry }] };
    }
    if (/FROM ia4tube_social\.social_publications/is.test(call.text)) {
      return { rows: [{
        connection_id: IDS.connection,
        provider: "instagram",
        media_reference: reservation.payload.image.mediaId,
        media_metadata_digest: mediaMetadataDigest(reservation.payload.image),
        caption: "Original synthetic caption",
        state: "failed_temporary",
        request_hash: reservation.digest
      }] };
    }
    return { rows: [] };
  });
  await assert.rejects(createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).beginIdempotency(reservation));
  assert.equal(
    pool.calls.some((call) => call.text.trim() === "ROLLBACK"),
    true
  );
  assert.equal(
    productCalls(pool).some((call) =>
      /INSERT INTO .*social_publications/is.test(call.text)
    ),
    false
  );
});

test("publish retry refuses publication states that are not retryable", async () => {
  const reservation = publishReservation(IDS.operationRetry);
  const pool = createFakePool(async (call) => {
    if (/INSERT INTO .*social_idempotency_operations/is.test(call.text)) {
      return { rows: [{ operation_id: IDS.operationRetry }] };
    }
    if (/FROM ia4tube_social\.social_publications/is.test(call.text)) {
      return { rows: [{
        connection_id: IDS.connection,
        provider: "instagram",
        media_reference: reservation.payload.image.mediaId,
        media_metadata_digest: mediaMetadataDigest(reservation.payload.image),
        caption: reservation.payload.caption,
        state: "published",
        request_hash: reservation.digest
      }] };
    }
    return { rows: [] };
  });
  await assert.rejects(createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).beginIdempotency(reservation));
  assert.equal(
    pool.calls.some((call) => call.text.trim() === "ROLLBACK"),
    true
  );
});

test("completed beginAuthorization accepts only a server-issued UUID handle", async () => {
  const digest = "e".repeat(64);
  const validHandle = IDS.transaction;
  function poolForHandle(handle, extraResult = {}) {
    return createFakePool(async (call) => {
      if (/INSERT INTO .*social_idempotency_operations/is.test(call.text)) {
        return { rows: [] };
      }
      if (/FROM ia4tube_social\.social_idempotency_operations/is.test(call.text)) {
        return { rows: [{
          provider: "instagram",
          capability: "beginAuthorization",
          request_hash: digest,
          status: "completed",
          result_payload: {
            connectionId: IDS.connection,
            provider: "instagram",
            state: "authorization_pending",
            account: null,
            revision: 2,
            authorizationHandle: handle,
            ...extraResult
          },
          error_code: null
        }] };
      }
      return { rows: [] };
    });
  }
  const valid = await createPostgresConnectorStore({
    pool: poolForHandle(validHandle),
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).beginIdempotency({
    capability: "beginAuthorization",
    operationId: IDS.operation,
    digest
  });
  assert.equal(valid.result.authorizationHandle, validHandle);

  for (const invalidHandle of [
    "eyJzdGF0ZSI6InN5bnRoZXRpYy1vYXV0aC1zdGF0ZSJ9",
    "https://synthetic.invalid/oauth?code=secret",
    "synthetic-authorization?code=secret",
    "synthetic-authorization\nheader"
  ]) {
    await assert.rejects(createPostgresConnectorStore({
      pool: poolForHandle(invalidHandle),
      runtimeRole: RUNTIME_ROLE
    }).scope(CONTEXT_A).beginIdempotency({
      capability: "beginAuthorization",
      operationId: IDS.operation,
      digest
    }));
  }
  await assert.rejects(createPostgresConnectorStore({
    pool: poolForHandle(validHandle, {
      accessToken: SYNTHETIC_SECRET_MARKER
    }),
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).beginIdempotency({
    capability: "beginAuthorization",
    operationId: IDS.operation,
    digest
  }));
});

test("OAuth creation stores digests, never raw state or session binding", async () => {
  const pool = createFakePool(async (call) => {
    if (/INSERT INTO .*oauth/is.test(call.text)) {
      return { rows: [{
        id: IDS.transaction,
        company_id: CONTEXT_A.companyId,
        connection_id: IDS.connection,
        purpose: "connect",
        expires_at: oauthInput().expiresAt,
        consumed_at: null,
        status: "pending"
      }] };
    }
    return { rows: [] };
  });
  const repository = createPostgresOAuthRepository({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A);
  await repository.createAuthorization(oauthInput());
  assertScopedTransaction(pool, CONTEXT_A.companyId);
  const values = flattenedValues(pool);
  assert.equal(values.some((value) => value.includes(SYNTHETIC_STATE)), false);
  assert.equal(
    values.some((value) => value.includes(SYNTHETIC_SESSION_JTI)),
    false
  );
  assert.equal(values.some((value) => value.includes(SYNTHETIC_REDIRECT)), false);
  assert.ok(values.includes(crypto.createHash("sha256")
    .update(SYNTHETIC_STATE, "utf8")
    .digest("hex")));
  assert.ok(values.includes(crypto.createHash("sha256")
    .update(SYNTHETIC_REDIRECT, "utf8")
    .digest("hex")));
  for (const call of productCalls(pool)) {
    assertParameterized(call, [
      SYNTHETIC_STATE,
      SYNTHETIC_SESSION_JTI,
      SYNTHETIC_REDIRECT
    ]);
  }
});

test("pending connection and OAuth authorization are created atomically under one tenant lock", async () => {
  const expiresAt = oauthInput().expiresAt;
  const pool = createFakePool(async (call) => {
      if (/^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
        return { rows: [], rowCount: 0 };
      }
      if (/JOIN LATERAL/is.test(call.text)) {
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO ia4tube_social\.social_connections/is.test(call.text)) {
      return { rows: [{ id: IDS.connection, revision: 1 }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_oauth_transactions/is.test(
      call.text
    )) {
      return { rows: [{
        id: IDS.transaction,
        connection_id: IDS.connection,
        purpose: "connect",
        expires_at: expiresAt
      }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)) {
      return { rows: [{}], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const result = await createPostgresOAuthRepository({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).createAuthorizationWithPendingConnection(
    oauthInput({ expiresAt })
  );
  assert.deepEqual(result, {
    authorizationHandle: IDS.transaction,
    connectionId: IDS.connection,
    purpose: "connect",
    expiresAt,
    status: "pending",
    revision: 1
  });
  assertScopedTransaction(pool, CONTEXT_A.companyId);
  assert.equal(
    pool.calls.filter((call) => /pg_advisory_xact_lock/i.test(call.text)).length,
    1
  );
  const calls = productCalls(pool);
  const connectionInsert = calls.findIndex((call) =>
    /INSERT INTO ia4tube_social\.social_connections/is.test(call.text)
  );
  const authorizationInsert = calls.findIndex((call) =>
    /INSERT INTO ia4tube_social\.social_oauth_transactions/is.test(call.text)
  );
  assert.ok(connectionInsert >= 0);
  assert.ok(authorizationInsert > connectionInsert);
  assert.match(calls[connectionInsert].text, /'authorization_pending'/i);
  assert.match(calls[connectionInsert].text, /created_by_user_id/i);
  assert.match(calls[connectionInsert].text, /revision/i);
  assert.deepEqual(calls[connectionInsert].values, [
    CONTEXT_A.companyId,
    IDS.connection,
    "instagram",
    CONTEXT_A.userId
  ]);
  assert.equal(
    calls.some((call) => /social_external_accounts/i.test(call.text)),
    false
  );
  assert.ok(calls.some((call) =>
    call.values.includes("to_authorization_pending")
  ));
  assert.ok(calls.some((call) =>
    call.values.includes("purpose_connect")
  ));
  const serialized = JSON.stringify(pool.calls);
  assert.equal(serialized.includes(SYNTHETIC_STATE), false);
  assert.equal(serialized.includes(SYNTHETIC_SESSION_JTI), false);
  assert.equal(serialized.includes(SYNTHETIC_REDIRECT), false);
});

test("OAuth insert failure rolls back the pending connection and emits no audit", async () => {
  const pool = createFakePool(async (call) => {
    if (/^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO ia4tube_social\.social_connections/is.test(call.text)) {
      return { rows: [{ id: IDS.connection, revision: 1 }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_oauth_transactions/is.test(
      call.text
    )) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  await assert.rejects(
    createPostgresOAuthRepository({
      pool,
      runtimeRole: RUNTIME_ROLE
    }).scope(CONTEXT_A).createAuthorizationWithPendingConnection(oauthInput()),
    { code: "idempotency_conflict" }
  );
  assert.equal(
    pool.calls.some((call) => call.text.trim() === "ROLLBACK"),
    true
  );
  assert.equal(
    pool.calls.some((call) => call.text.trim() === "COMMIT"),
    false
  );
  assert.equal(
    productCalls(pool).some((call) =>
      /INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)
    ),
    false
  );
});

test("reconnect reuses the exact reconnect-required or disconnected connection", async () => {
  const requestedConnectionId = "30000000-0000-4000-8000-000000000013";
  const expiresAt = oauthInput().expiresAt;
  const pool = createFakePool(async (call) => {
    if (/^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [], rowCount: 0 };
    }
    if (/JOIN LATERAL/is.test(call.text)) return { rows: [], rowCount: 0 };
    if (/FROM ia4tube_social\.social_connections/is.test(call.text)) {
      return { rows: [{ id: IDS.connection, revision: 5 }], rowCount: 1 };
    }
    if (/UPDATE ia4tube_social\.social_connections/is.test(call.text)) {
      return { rows: [{ id: IDS.connection, revision: 6 }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_oauth_transactions/is.test(
      call.text
    )) {
      return { rows: [{
        id: IDS.transaction,
        connection_id: IDS.connection,
        purpose: "reconnect",
        expires_at: expiresAt
      }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)) {
      return { rows: [{}], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const result = await createPostgresOAuthRepository({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).createAuthorizationWithPendingConnection(oauthInput({
    connectionId: requestedConnectionId,
    purpose: "reconnect",
    expiresAt
  }));
  assert.deepEqual(result, {
    authorizationHandle: IDS.transaction,
    connectionId: IDS.connection,
    purpose: "reconnect",
    expiresAt,
    status: "pending",
    revision: 6
  });
  const calls = productCalls(pool);
  assert.equal(
    calls.some((call) =>
      /INSERT INTO ia4tube_social\.social_connections/is.test(call.text)
    ),
    false
  );
  const transitioned = calls.find((call) =>
    /UPDATE ia4tube_social\.social_connections/is.test(call.text)
  );
  assert.match(transitioned.text, /status='authorization_pending'/i);
  assert.match(transitioned.text, /status=ANY\(\$5::text\[\]\)/i);
  assert.deepEqual(transitioned.values, [
    CONTEXT_A.companyId,
    IDS.connection,
    "instagram",
    5,
    ["reconnect_required", "disconnected"]
  ]);
  const authorization = calls.find((call) =>
    /INSERT INTO ia4tube_social\.social_oauth_transactions/is.test(call.text)
  );
  assert.equal(authorization.values[2], IDS.connection);
  for (const audit of calls.filter((call) =>
    /INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)
  )) {
    assert.ok(audit.values.includes(IDS.connection));
    assert.equal(audit.values.includes(requestedConnectionId), false);
  }
});

test("a terminal pending connection is recoverable only without its exact authorization credential", async () => {
  const previousAuthorizationId =
    "30000000-0000-4000-8000-000000000014";
  const nextConnectionId = "30000000-0000-4000-8000-000000000015";
  const expiresAt = oauthInput().expiresAt;
  const pool = createFakePool(async (call) => {
    if (/^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [], rowCount: 0 };
    }
    if (/JOIN LATERAL/is.test(call.text)) {
      return { rows: [{
        id: IDS.connection,
        revision: 1,
        authorization_id: previousAuthorizationId,
        purpose: "connect",
        consumed_at: new Date(Date.now() - 11 * 60 * 1000),
        expires_at: new Date(Date.now() - 60 * 1000)
      }], rowCount: 1 };
    }
    if (/UPDATE ia4tube_social\.social_connections/is.test(call.text)) {
      if (call.values[1] === IDS.connection) {
        return { rows: [{ id: IDS.connection, revision: 2 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO ia4tube_social\.social_connections/is.test(call.text)) {
      return { rows: [{ id: nextConnectionId, revision: 1 }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_oauth_transactions/is.test(
      call.text
    )) {
      return { rows: [{
        id: IDS.transaction,
        connection_id: nextConnectionId,
        purpose: "connect",
        expires_at: expiresAt
      }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)) {
      return { rows: [{}], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const result = await createPostgresOAuthRepository({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).createAuthorizationWithPendingConnection(oauthInput({
    connectionId: nextConnectionId,
    expiresAt
  }));
  assert.equal(result.connectionId, nextConnectionId);
  const recovery = productCalls(pool).find((call) => /JOIN LATERAL/is.test(
    call.text
  ));
  assert.match(recovery.text, /credential\.id=terminal\.authorization_id/i);
  assert.match(recovery.text, /credential\.revoked_at IS NULL/i);
  assert.match(recovery.text, /open_oauth\.consumed_at IS NULL/i);
  assert.match(
    recovery.text,
    /terminal\.consumed_at IS NULL\s+OR terminal\.expires_at <= CURRENT_TIMESTAMP/i
  );
  assert.match(recovery.text, /FOR UPDATE OF c/i);
  assert.ok(productCalls(pool).some((call) =>
    call.values.includes("provider_result_unknown")
  ));
  assert.ok(productCalls(pool).some((call) =>
    call.values.includes("to_failed")
  ));
});

test("terminal pending recovery rolls back when the replacement authorization cannot be inserted", async () => {
  const previousAuthorizationId =
    "30000000-0000-4000-8000-000000000016";
  const nextConnectionId = "30000000-0000-4000-8000-000000000017";
  const pool = createFakePool(async (call) => {
    if (/^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return {
        rows: [{ connection_id: IDS.connection }],
        rowCount: 1
      };
    }
    if (/JOIN LATERAL/is.test(call.text)) {
      return { rows: [{
        id: IDS.connection,
        revision: 4,
        authorization_id: previousAuthorizationId,
        purpose: "connect",
        consumed_at: new Date(Date.now() - 11 * 60 * 1000),
        expires_at: new Date(Date.now() - 60 * 1000)
      }], rowCount: 1 };
    }
    if (/UPDATE ia4tube_social\.social_connections/is.test(call.text)) {
      return { rows: [{ id: IDS.connection, revision: 5 }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_connections/is.test(call.text)) {
      return { rows: [{ id: nextConnectionId, revision: 1 }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_oauth_transactions/is.test(
      call.text
    )) {
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)) {
      return { rows: [{}], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  await assert.rejects(
    createPostgresOAuthRepository({
      pool,
      runtimeRole: RUNTIME_ROLE
    }).scope(CONTEXT_A).createAuthorizationWithPendingConnection(oauthInput({
      connectionId: nextConnectionId
    })),
    { code: "idempotency_conflict" }
  );
  assert.equal(
    pool.calls.some((call) => call.text.trim() === "ROLLBACK"),
    true
  );
  assert.equal(
    pool.calls.some((call) => call.text.trim() === "COMMIT"),
    false
  );
  const calls = productCalls(pool);
  const expiration = calls.findIndex((call) =>
    /^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)
  );
  const recovery = calls.findIndex((call) => /JOIN LATERAL/is.test(call.text));
  const replacement = calls.findIndex((call) =>
    /INSERT INTO ia4tube_social\.social_oauth_transactions/is.test(call.text)
  );
  assert.ok(expiration >= 0);
  assert.ok(recovery > expiration);
  assert.ok(replacement > recovery);
  assert.match(calls[expiration].text, /expires_at <= CURRENT_TIMESTAMP/i);
  assert.ok(calls.some((call) =>
    call.values.includes("authorization_expired")
  ));
});

test("atomic authorization terminalizes an abandoned expired OAuth before replacing its pending connection", async () => {
  const previousAuthorizationId =
    "30000000-0000-4000-8000-000000000018";
  const nextConnectionId = "30000000-0000-4000-8000-000000000019";
  const expiresAt = oauthInput().expiresAt;
  const pool = createFakePool(async (call) => {
    if (/^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return {
        rows: [{ connection_id: IDS.connection }],
        rowCount: 1
      };
    }
    if (/JOIN LATERAL/is.test(call.text)) {
      return { rows: [{
        id: IDS.connection,
        revision: 2,
        authorization_id: previousAuthorizationId,
        purpose: "connect",
        consumed_at: null,
        expires_at: new Date(Date.now() - 1000)
      }], rowCount: 1 };
    }
    if (/UPDATE ia4tube_social\.social_connections/is.test(call.text)) {
      return { rows: [{ id: IDS.connection, revision: 3 }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_connections/is.test(call.text)) {
      return { rows: [{ id: nextConnectionId, revision: 1 }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_oauth_transactions/is.test(
      call.text
    )) {
      return { rows: [{
        id: IDS.transaction,
        connection_id: nextConnectionId,
        purpose: "connect",
        expires_at: expiresAt
      }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)) {
      return { rows: [{}], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const result = await createPostgresOAuthRepository({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).createAuthorizationWithPendingConnection(oauthInput({
    connectionId: nextConnectionId,
    expiresAt
  }));
  assert.equal(result.connectionId, nextConnectionId);
  const calls = productCalls(pool);
  const expiration = calls.findIndex((call) =>
    /^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)
  );
  const recovery = calls.findIndex((call) => /JOIN LATERAL/is.test(call.text));
  const newConnection = calls.findIndex((call) =>
    /INSERT INTO ia4tube_social\.social_connections/is.test(call.text)
  );
  assert.ok(expiration >= 0);
  assert.ok(recovery > expiration);
  assert.ok(newConnection > recovery);
  assert.match(calls[expiration].text, /failed_at=CURRENT_TIMESTAMP/i);
  assert.match(calls[expiration].text, /failure_code='authorization_expired'/i);
  assert.match(calls[expiration].text, /expires_at <= CURRENT_TIMESTAMP/i);
  assert.ok(calls.some((call) =>
    call.values.includes("authorization_expired")
  ));
  assert.ok(calls.some((call) => call.values.includes("to_failed")));
  assertScopedTransaction(pool, CONTEXT_A.companyId);
});

test("OAuth creation closes expired pending transactions before inserting a new one", async () => {
  const pool = createFakePool(async (call) => {
    if (/^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [{ connection_id: IDS.connection }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_oauth_transactions/is.test(
      call.text
    )) {
      return { rows: [{
        id: IDS.transaction,
        connection_id: IDS.connection,
        purpose: "connect",
        expires_at: oauthInput().expiresAt
      }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  await createPostgresOAuthRepository({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).createAuthorization(oauthInput());
  const calls = productCalls(pool);
  const expiredIndex = calls.findIndex((call) =>
    /^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)
  );
  const newTransactionIndex = calls.findIndex((call) =>
    /INSERT INTO ia4tube_social\.social_oauth_transactions/is.test(call.text)
  );
  assert.ok(expiredIndex >= 0);
  assert.ok(newTransactionIndex > expiredIndex);
  assert.match(calls[expiredIndex].text, /expires_at\s*<=\s*CURRENT_TIMESTAMP/i);
  const expirationAudit = calls.slice(expiredIndex + 1, newTransactionIndex)
    .find((call) => /social_audit_events/i.test(call.text));
  assert.ok(expirationAudit);
  assert.ok(expirationAudit.values.includes("social.authorization.failed"));
  assert.ok(expirationAudit.values.includes("authorization_expired"));
});

test("OAuth consume locks identity, timing-validates bindings and CAS-terminalizes once", async () => {
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [oauthAuthorizationRow()] };
    }
    if (/FROM ia4tube_social\.social_connections/is.test(call.text)) {
      return { rows: [{ id: IDS.connection, revision: 7 }], rowCount: 1 };
    }
    if (/^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [oauthTerminalRow()], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)) {
      return { rows: [{}], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const repository = createPostgresOAuthRepository({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A);
  const callbackObservedAt = new Date();
  const result = await repository.consumeAuthorization(oauthConsumeInput({
    observedAt: callbackObservedAt
  }));
  assert.equal(result.status, "consumed");
  assert.equal(result.connectionRevision, 7);
  const calls = productCalls(pool);
  const selected = calls.find((call) =>
    /FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)
  );
  const consume = calls.find((call) =>
    /^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)
  );
  const connection = calls.find((call) =>
    /FROM ia4tube_social\.social_connections/is.test(call.text)
  );
  assert.ok(selected);
  assert.ok(connection);
  assert.ok(consume);
  assert.match(connection.text, /status='authorization_pending'/i);
  assert.match(connection.text, /FOR UPDATE/i);
  assert.ok(calls.indexOf(consume) > calls.indexOf(selected));
  assert.ok(calls.indexOf(connection) > calls.indexOf(consume));
  assert.match(selected.text, /FOR UPDATE/i);
  assert.match(selected.text, /initiated_by_user_id\s*=\s*\$4/i);
  assert.match(selected.text, /purpose\s*=\s*\$5/i);
  assert.doesNotMatch(selected.text, /state_digest\s*=/i);
  assert.doesNotMatch(selected.text, /redirect_uri_digest\s*=/i);
  assert.doesNotMatch(selected.text, /session_jti_digest\s*=/i);
  assert.deepEqual(selected.values, [
    CONTEXT_A.companyId,
    IDS.transaction,
    "instagram",
    CONTEXT_A.userId,
    "connect"
  ]);
  assert.match(consume.text, /SET consumed_at\s*=\s*CURRENT_TIMESTAMP/i);
  assert.match(consume.text, /consumed_at\s+IS\s+NULL/i);
  assert.match(consume.text, /cancelled_at\s+IS\s+NULL/i);
  assert.match(consume.text, /failed_at\s+IS\s+NULL/i);
  assert.match(consume.text, /expires_at\s*>\s*\$6/i);
  assert.match(consume.text, /RETURNING/i);
  assert.deepEqual(consume.values, [
    CONTEXT_A.companyId,
    IDS.transaction,
    "instagram",
    CONTEXT_A.userId,
    "connect",
    callbackObservedAt,
    null
  ]);
  assertParameterized(selected, [
    SYNTHETIC_STATE,
    SYNTHETIC_SESSION_JTI,
    SYNTHETIC_REDIRECT
  ]);
  assertParameterized(consume, [
    SYNTHETIC_STATE,
    SYNTHETIC_SESSION_JTI,
    SYNTHETIC_REDIRECT
  ]);
  const values = flattenedValues(pool);
  assert.equal(values.some((value) => value.includes(SYNTHETIC_STATE)), false);
  assert.equal(
    values.some((value) => value.includes(SYNTHETIC_SESSION_JTI)),
    false
  );
  assert.equal(values.some((value) => value.includes(SYNTHETIC_REDIRECT)), false);
  const source = fs.readFileSync(path.join(
    ROOT,
    "src/persistence/postgres/social-oauth-repository.js"
  ), "utf8");
  assert.match(source, /crypto\.timingSafeEqual\(/);
  assert.match(source, /Buffer\.alloc\(DIGEST_BYTES\)/);
});

test("OAuth state owned by another company is refused under authenticated tenant scope", async () => {
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      assert.equal(call.values[0], CONTEXT_B.companyId);
      assert.notEqual(call.values[0], CONTEXT_A.companyId);
      return { rows: [] };
    }
    return { rows: [] };
  });
  const repository = createPostgresOAuthRepository({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_B);
  await assert.rejects(
    repository.consumeAuthorization(oauthConsumeInput()),
    { code: "authorization_expired" }
  );
  const texts = pool.calls.map((call) => call.text.trim());
  assert.equal(texts[0], "BEGIN");
  assert.equal(texts.at(-1), "ROLLBACK");
  assert.deepEqual(
    pool.calls.find((call) =>
      /set_config\('ia4tube\.company_id'/i.test(call.text)
    )?.values,
    [CONTEXT_B.companyId]
  );
  assert.deepEqual(pool.counts(), { connectCount: 1, releaseCount: 1 });
  const [selected] = productCalls(pool);
  assert.ok(selected);
  assert.match(selected.text, /company_id\s*=\s*\$1/i);
  assert.match(selected.text, /FOR UPDATE/i);
  assert.equal(
    productCalls(pool).some((call) =>
      /^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)
    ),
    false
  );
  assert.equal(JSON.stringify(pool.calls).includes(SYNTHETIC_STATE), false);
});

test("OAuth replay, purpose mismatch or tampered digest binding is uniformly refused", async () => {
  let updateAttempts = 0;
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return call.values[4] === "connect"
        ? { rows: [oauthAuthorizationRow()] }
        : { rows: [] };
    }
    if (/^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      updateAttempts += 1;
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  const repository = createPostgresOAuthRepository({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A);
  for (const input of [
    oauthConsumeInput(),
    oauthConsumeInput({ state: `${SYNTHETIC_STATE}-tampered` }),
    oauthConsumeInput({ redirectUri: `${SYNTHETIC_REDIRECT}/tampered` }),
    oauthConsumeInput({
      sessionJti: `${SYNTHETIC_SESSION_JTI}-tampered`
    }),
    oauthConsumeInput({ purpose: "reconnect" })
  ]) {
    await assert.rejects(
      repository.consumeAuthorization(input),
      (error) => {
        const serializedError = JSON.stringify({
          code: error?.code,
          message: error?.message,
          cause: error?.cause?.message
        });
        assert.equal(serializedError.includes(SYNTHETIC_STATE), false);
        assert.equal(serializedError.includes(SYNTHETIC_SESSION_JTI), false);
        assert.equal(serializedError.includes(SYNTHETIC_REDIRECT), false);
        return true;
      }
    );
  }
  assert.equal(updateAttempts, 1);
  const serialized = JSON.stringify(pool.calls);
  assert.equal(serialized.includes(SYNTHETIC_STATE), false);
  assert.equal(serialized.includes(SYNTHETIC_SESSION_JTI), false);
});

test("legacy OAuth terminals allow omitted purpose while expireAuthorization requires it", async () => {
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [oauthAuthorizationRow()] };
    }
    if (/^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [oauthTerminalRow()], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)) {
      return { rows: [{}], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const repository = createPostgresOAuthRepository({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A);
  const withoutPurpose = oauthConsumeInput();
  delete withoutPurpose.purpose;
  assert.equal(
    (await repository.consumeAuthorization(withoutPurpose)).status,
    "consumed"
  );
  assert.equal(
    (await repository.cancelAuthorization(withoutPurpose)).status,
    "cancelled"
  );
  assert.equal(
    (await repository.failAuthorization({
      ...withoutPurpose,
      failureCode: "authorization_cancelled"
    })).status,
    "failed"
  );
  const scopedSelects = productCalls(pool).filter((call) =>
    /FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)
  );
  assert.equal(scopedSelects.length, 3);
  for (const selected of scopedSelects) {
    assert.doesNotMatch(selected.text, /purpose\s*=/i);
    assert.deepEqual(selected.values, [
      CONTEXT_A.companyId,
      IDS.transaction,
      "instagram",
      CONTEXT_A.userId
    ]);
  }
  const callsBeforeInvalidPurpose = pool.calls.length;
  await assert.rejects(
    repository.consumeAuthorization({
      ...withoutPurpose,
      purpose: "publish"
    }),
    { code: "connector_contract_invalid" }
  );
  assert.equal(pool.calls.length, callsBeforeInvalidPurpose);
  const callsBeforeExpire = pool.calls.length;
  await assert.rejects(
    repository.expireAuthorization(withoutPurpose),
    { code: "connector_contract_invalid" }
  );
  assert.equal(pool.calls.length, callsBeforeExpire);
});

test("OAuth cancel and fail preserve purpose binding and emit only safe terminal audits", async () => {
  const cases = [
    {
      method: "cancelAuthorization",
      input: oauthConsumeInput(),
      timestampColumn: "cancelled_at",
      status: "cancelled",
      failureCode: null,
      action: "social.authorization.cancelled",
      outcome: "succeeded",
      detailsCode: null
    },
    {
      method: "failAuthorization",
      input: oauthConsumeInput({ failureCode: "authorization_cancelled" }),
      timestampColumn: "failed_at",
      status: "failed",
      failureCode: "authorization_cancelled",
      action: "social.authorization.failed",
      outcome: "failed",
      detailsCode: "authorization_cancelled"
    }
  ];
  for (const item of cases) {
    const pool = createFakePool(async (call) => {
      if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
        return { rows: [oauthAuthorizationRow()] };
      }
      if (/^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
        return { rows: [oauthTerminalRow()], rowCount: 1 };
      }
      if (/INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)) {
        return { rows: [{}], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const repository = createPostgresOAuthRepository({
      pool,
      runtimeRole: RUNTIME_ROLE
    }).scope(CONTEXT_A);
    const result = await repository[item.method](item.input);
    assert.equal(result.status, item.status);
    const calls = productCalls(pool);
    const selected = calls.find((call) =>
      /FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)
    );
    const updated = calls.find((call) =>
      /^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)
    );
    const audit = calls.find((call) =>
      /INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)
    );
    assert.ok(selected);
    assert.ok(updated);
    assert.ok(audit);
    assert.match(selected.text, /purpose\s*=\s*\$5/i);
    assert.match(selected.text, /FOR UPDATE/i);
    assert.match(
      updated.text,
      new RegExp(`SET ${item.timestampColumn}\\s*=\\s*CURRENT_TIMESTAMP`, "i")
    );
    assert.equal(updated.values[4], "connect");
    assert.equal(updated.values[5], item.failureCode);
    assert.ok(audit.values.includes(item.action));
    assert.ok(audit.values.includes(item.outcome));
    if (item.detailsCode) assert.ok(audit.values.includes(item.detailsCode));
    assert.equal(JSON.stringify(pool.calls).includes(SYNTHETIC_STATE), false);
    assert.equal(
      JSON.stringify(pool.calls).includes(SYNTHETIC_SESSION_JTI),
      false
    );
  }
});

test("OAuth exposes cancellation only after every digest binding authenticates", async () => {
  const cancelledRow = oauthAuthorizationRow({
    cancelled_at: new Date(Date.now() - 1000)
  });
  for (const [input, code] of [
    [oauthConsumeInput(), "authorization_cancelled"],
    [
      oauthConsumeInput({ state: `${SYNTHETIC_STATE}-tampered` }),
      "authorization_expired"
    ]
  ]) {
    let updateAttempts = 0;
    const pool = createFakePool(async (call) => {
      if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
        return { rows: [cancelledRow] };
      }
      if (/^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
        updateAttempts += 1;
      }
      return { rows: [], rowCount: 0 };
    });
    await assert.rejects(
      createPostgresOAuthRepository({
        pool,
        runtimeRole: RUNTIME_ROLE
      }).scope(CONTEXT_A).consumeAuthorization(input),
      { code }
    );
    assert.equal(updateAttempts, 0);
    assert.equal(
      productCalls(pool).some((call) =>
        /INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)
      ),
      false
    );
  }
});

test("expireAuthorization authenticates bindings and terminalizes only an expired pending row", async () => {
  const expiredAt = new Date(Date.now() - 1000);
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [oauthAuthorizationRow({ expires_at: expiredAt })] };
    }
    if (/FROM ia4tube_social\.social_connections/is.test(call.text)) {
      return { rows: [{ id: IDS.connection, revision: 9 }], rowCount: 1 };
    }
    if (/^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return {
        rows: [oauthTerminalRow({ expires_at: expiredAt })],
        rowCount: 1
      };
    }
    if (/INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)) {
      return { rows: [{}], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const result = await createPostgresOAuthRepository({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).expireAuthorization(oauthExpireInput());
  assert.equal(result.status, "expired");
  assert.equal(result.connectionRevision, 9);
  const calls = productCalls(pool);
  const selected = calls.find((call) =>
    /FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)
  );
  const expired = calls.find((call) =>
    /^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)
  );
  const audit = calls.find((call) =>
    /INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)
  );
  assert.ok(selected);
  assert.ok(expired);
  assert.ok(audit);
  assert.match(selected.text, /FOR UPDATE/i);
  assert.match(expired.text, /SET failed_at\s*=\s*CURRENT_TIMESTAMP/i);
  assert.match(expired.text, /expires_at\s*<=\s*\$6/i);
  assert.match(expired.text, /consumed_at\s+IS\s+NULL/i);
  assert.match(expired.text, /cancelled_at\s+IS\s+NULL/i);
  assert.match(expired.text, /failed_at\s+IS\s+NULL/i);
  assert.equal(expired.values[5] instanceof Date, true);
  assert.equal(expired.values[6], "authorization_expired");
  assert.ok(audit.values.includes("social.authorization.failed"));
  assert.ok(audit.values.includes("failed"));
  assert.ok(audit.values.includes("authorization_expired"));
});

test("expireAuthorization refuses unexpired, terminal or digest-mismatched rows without audit", async () => {
  const cases = [
    {
      row: oauthAuthorizationRow(),
      input: oauthExpireInput(),
      code: "authorization_expired"
    },
    {
      row: oauthAuthorizationRow({
        expires_at: new Date(Date.now() - 1000),
        consumed_at: new Date(Date.now() - 500)
      }),
      input: oauthExpireInput(),
      code: "social_oauth_state_already_consumed"
    },
    {
      row: oauthAuthorizationRow({ expires_at: new Date(Date.now() - 1000) }),
      input: oauthExpireInput({ state: `${SYNTHETIC_STATE}-tampered` }),
      code: "authorization_expired"
    }
  ];
  for (const item of cases) {
    let updateAttempts = 0;
    const pool = createFakePool(async (call) => {
      if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
        return { rows: [item.row] };
      }
      if (/^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
        updateAttempts += 1;
        const expired = item.row.expires_at.getTime() <= Date.now();
        const pending = !item.row.consumed_at &&
          !item.row.cancelled_at && !item.row.failed_at;
        return expired && pending
          ? { rows: [oauthTerminalRow({ expires_at: item.row.expires_at })] }
          : { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    });
    await assert.rejects(
      createPostgresOAuthRepository({
        pool,
        runtimeRole: RUNTIME_ROLE
      }).scope(CONTEXT_A).expireAuthorization(item.input),
      { code: item.code }
    );
    assert.equal(
      productCalls(pool).some((call) =>
        /INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)
      ),
      false
    );
    if (item.input.state !== SYNTHETIC_STATE) {
      assert.equal(updateAttempts, 0);
    }
  }
});

test("OAuth terminal CAS permits one concurrent consumer and audits only the winner", async () => {
  let won = false;
  let updateAttempts = 0;
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [oauthAuthorizationRow(won
        ? { consumed_at: new Date() }
        : {})] };
    }
    if (/^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      updateAttempts += 1;
      if (won) return { rows: [], rowCount: 0 };
      won = true;
      return { rows: [oauthTerminalRow()], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)) {
      return { rows: [{}], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const repository = createPostgresOAuthRepository({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A);
  const settled = await Promise.allSettled([
    repository.consumeAuthorization(oauthConsumeInput()),
    repository.consumeAuthorization(oauthConsumeInput())
  ]);
  const fulfilled = settled.filter((item) => item.status === "fulfilled");
  const rejected = settled.filter((item) => item.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(fulfilled[0].value.status, "consumed");
  assert.equal(rejected.length, 1);
  assert.equal(
    rejected[0].reason?.code,
    "authorization_expired"
  );
  assert.equal(updateAttempts, 2);
  assert.equal(
    productCalls(pool).filter((call) =>
      /INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)
    ).length,
    1
  );
  for (const update of productCalls(pool).filter((call) =>
    /^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)
  )) {
    assert.match(update.text, /consumed_at\s+IS\s+NULL/i);
    assert.match(update.text, /cancelled_at\s+IS\s+NULL/i);
    assert.match(update.text, /failed_at\s+IS\s+NULL/i);
  }
});

test("fixed-size digest comparison refuses malformed stored digests before CAS", async () => {
  let updateAttempts = 0;
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [oauthAuthorizationRow({ state_digest: "bad" })] };
    }
    if (/^UPDATE ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      updateAttempts += 1;
    }
    return { rows: [], rowCount: 0 };
  });
  await assert.rejects(
    createPostgresOAuthRepository({
      pool,
      runtimeRole: RUNTIME_ROLE
    }).scope(CONTEXT_A).consumeAuthorization(oauthConsumeInput()),
    { code: "authorization_expired" }
  );
  assert.equal(updateAttempts, 0);
});

test("consumed authorization stores one connection-bound encrypted credential without activation or account discovery", async () => {
  const expiresAt = credentialEnvelope().expiresAt;
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [{
        id: IDS.transaction,
        connection_id: IDS.connection,
        purpose: "connect"
      }] };
    }
    if (/FROM ia4tube_social\.social_connections/is.test(call.text)) {
      return { rows: [{ id: IDS.connection, revision: 1 }] };
    }
    if (/UPDATE ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )) {
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )) {
      return { rows: [{
        id: IDS.transaction,
        credential_type: "access_token",
        key_version: "social-kek-v1",
        aad_version: 1,
        expires_at: expiresAt,
        revision: 1
      }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)) {
      return { rows: [{}], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const oauth = createPostgresOAuthRepository({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A);
  const harness = credentialServiceHarness();
  const plaintext = Buffer.from(SYNTHETIC_SECRET_MARKER, "utf8");
  const result = await harness.service.withEncryptedConnectionCredential({
    companyId: CONTEXT_A.companyId,
    connectionId: IDS.connection,
    credentialId: IDS.transaction,
    provider: "instagram",
    credentialType: "access_token",
    plaintext,
    expiresAt
  }, (envelope) => oauth.storeConsumedAuthorizationCredential({
    authorizationHandle: IDS.transaction,
    connectionId: IDS.connection,
    purpose: "connect",
    expectedRevision: 1
  }, envelope));
  assert.deepEqual(result, {
    authorizationHandle: IDS.transaction,
    connectionId: IDS.connection,
    purpose: "connect",
    status: "credential_stored",
    revision: 1,
    credential: {
      id: IDS.transaction,
      credentialType: "access_token",
      keyVersion: "social-kek-v1",
      aadVersion: 1,
      expiresAt,
      revision: 1
    }
  });
  assert.ok(plaintext.every((byte) => byte === 0));
  assertScopedTransaction(pool, CONTEXT_A.companyId);
  assert.equal(
    pool.calls.filter((call) => /pg_advisory_xact_lock/i.test(call.text)).length,
    1
  );
  const calls = productCalls(pool);
  const authorizationRead = calls.findIndex((call) =>
    /FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)
  );
  const connectionRead = calls.findIndex((call) =>
    /FROM ia4tube_social\.social_connections/is.test(call.text)
  );
  const credentialInsert = calls.findIndex((call) =>
    /INSERT INTO ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )
  );
  assert.ok(authorizationRead >= 0);
  assert.ok(connectionRead > authorizationRead);
  assert.ok(credentialInsert > connectionRead);
  assert.match(calls[authorizationRead].text, /consumed_at IS NOT NULL/i);
  assert.match(calls[authorizationRead].text, /connection_id=\$4/i);
  assert.match(calls[authorizationRead].text, /initiated_by_user_id=\$5/i);
  assert.match(calls[authorizationRead].text, /purpose=\$6/i);
  assert.deepEqual(calls[authorizationRead].values, [
    CONTEXT_A.companyId,
    IDS.transaction,
    "instagram",
    IDS.connection,
    CONTEXT_A.userId,
    "connect"
  ]);
  assert.match(calls[connectionRead].text, /status='authorization_pending'/i);
  assert.match(calls[connectionRead].text, /revision=\$4/i);
  assert.match(calls[credentialInsert].text, /connection_id/i);
  assert.doesNotMatch(calls[credentialInsert].text, /oauth_transaction_id/i);
  assert.equal(
    calls.some((call) =>
      /UPDATE ia4tube_social\.social_connections/i.test(call.text) ||
      /social_external_accounts/i.test(call.text)
    ),
    false
  );
  assert.equal(Object.hasOwn(result.credential, "ciphertext"), false);
  assert.equal(Object.hasOwn(result.credential, "nonce"), false);
  assert.equal(Object.hasOwn(result.credential, "authTag"), false);
  assert.equal(JSON.stringify(pool.calls).includes(SYNTHETIC_SECRET_MARKER), false);
  assert.ok(calls.some((call) =>
    call.values.includes("credential_encrypted")
  ));
});

test("credential insert failure rolls back replacement and leaves no stored audit", async () => {
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [{
        id: IDS.transaction,
        connection_id: IDS.connection,
        purpose: "connect"
      }] };
    }
    if (/FROM ia4tube_social\.social_connections/is.test(call.text)) {
      return { rows: [{ id: IDS.connection, revision: 1 }] };
    }
    if (/UPDATE ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )) {
      return { rows: [{ id: "synthetic-prior-credential" }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  const harness = credentialServiceHarness();
  const plaintext = Buffer.from(SYNTHETIC_SECRET_MARKER, "utf8");
  await assert.rejects(
    harness.service.withEncryptedConnectionCredential({
      companyId: CONTEXT_A.companyId,
      connectionId: IDS.connection,
      credentialId: IDS.transaction,
      provider: "instagram",
      credentialType: "access_token",
      plaintext
    }, (envelope) => createPostgresOAuthRepository({
      pool,
      runtimeRole: RUNTIME_ROLE
    }).scope(CONTEXT_A).storeConsumedAuthorizationCredential({
      authorizationHandle: IDS.transaction,
      connectionId: IDS.connection,
      purpose: "connect",
      expectedRevision: 1
    }, envelope)),
    { code: "idempotency_conflict" }
  );
  assert.ok(plaintext.every((byte) => byte === 0));
  assert.equal(
    pool.calls.some((call) => call.text.trim() === "ROLLBACK"),
    true
  );
  assert.equal(
    pool.calls.some((call) => call.text.trim() === "COMMIT"),
    false
  );
  assert.equal(
    productCalls(pool).some((call) =>
      /INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)
    ),
    false
  );
});

test("credential bridge refuses authorization and pending-revision mismatches before writing material", async () => {
  for (const refuseAt of ["authorization", "connection"]) {
    const pool = createFakePool(async (call) => {
      if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
        return refuseAt === "authorization"
          ? { rows: [] }
          : { rows: [{
            id: IDS.transaction,
            connection_id: IDS.connection,
            purpose: "connect"
          }] };
      }
      if (/FROM ia4tube_social\.social_connections/is.test(call.text)) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    });
    await assert.rejects(
      createPostgresOAuthRepository({
        pool,
        runtimeRole: RUNTIME_ROLE
      }).scope(CONTEXT_A).storeConsumedAuthorizationCredential({
        authorizationHandle: IDS.transaction,
        connectionId: IDS.connection,
        purpose: "connect",
        expectedRevision: 1
      }, credentialEnvelope({ id: IDS.transaction })),
      { code: refuseAt === "authorization"
        ? "authorization_expired"
        : "state_transition_invalid" }
    );
    assert.equal(
      productCalls(pool).some((call) =>
        /(?:UPDATE|INSERT INTO) ia4tube_social\.social_encrypted_credentials/i
          .test(call.text)
      ),
      false
    );
  }
});

test("stale callback revision cannot store a credential or terminalize a newer connection generation", async () => {
  const staleRevision = 6;
  const storePool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [{
        id: IDS.transaction,
        connection_id: IDS.connection,
        purpose: "reconnect"
      }] };
    }
    if (/FROM ia4tube_social\.social_connections/is.test(call.text)) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  await assert.rejects(
    createPostgresOAuthRepository({
      pool: storePool,
      runtimeRole: RUNTIME_ROLE
    }).scope(CONTEXT_A).storeConsumedAuthorizationCredential({
      authorizationHandle: IDS.transaction,
      connectionId: IDS.connection,
      purpose: "reconnect",
      expectedRevision: staleRevision
    }, credentialEnvelope({ id: IDS.transaction })),
    { code: "state_transition_invalid" }
  );
  const staleRead = productCalls(storePool).find((call) =>
    /FROM ia4tube_social\.social_connections/is.test(call.text)
  );
  assert.match(staleRead.text, /revision=\$4/i);
  assert.equal(staleRead.values[3], staleRevision);
  assert.equal(
    productCalls(storePool).some((call) =>
      /(?:UPDATE|INSERT INTO) ia4tube_social\.social_encrypted_credentials/i
        .test(call.text)
    ),
    false
  );

  const failPool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [{
        id: IDS.transaction,
        connection_id: IDS.connection,
        purpose: "reconnect"
      }] };
    }
    if (/UPDATE ia4tube_social\.social_connections/is.test(call.text)) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  await assert.rejects(
    createPostgresOAuthRepository({
      pool: failPool,
      runtimeRole: RUNTIME_ROLE
    }).scope(CONTEXT_A).failAuthorizationConnection({
      authorizationHandle: IDS.transaction,
      connectionId: IDS.connection,
      purpose: "reconnect",
      expectedRevision: staleRevision,
      failureCode: "provider_result_unknown",
      terminalStatus: "consumed"
    }),
    { code: "state_transition_invalid" }
  );
  const staleUpdate = productCalls(failPool).find((call) =>
    /UPDATE ia4tube_social\.social_connections/is.test(call.text)
  );
  assert.match(staleUpdate.text, /revision=\$5/i);
  assert.equal(staleUpdate.values[4], staleRevision);
  assert.equal(
    productCalls(failPool).some((call) =>
      /INSERT INTO ia4tube_social\.social_audit_events/i.test(call.text)
    ),
    false
  );
});

test("new callback credential and cleanup bridges require an explicit connection revision", async () => {
  const repository = createPostgresOAuthRepository({
    pool: createFakePool(),
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A);
  await assert.rejects(
    repository.storeConsumedAuthorizationCredential({
      authorizationHandle: IDS.transaction,
      connectionId: IDS.connection,
      purpose: "connect"
    }, credentialEnvelope({ id: IDS.transaction })),
    { code: "connector_contract_invalid" }
  );
  await assert.rejects(
    repository.failAuthorizationConnection({
      authorizationHandle: IDS.transaction,
      connectionId: IDS.connection,
      purpose: "connect",
      failureCode: "provider_result_unknown",
      terminalStatus: "consumed"
    }),
    { code: "connector_contract_invalid" }
  );
});

test("failAuthorizationConnection validates the exact terminal and only moves pending connection to failed", async () => {
  const cases = [
    {
      terminalStatus: "consumed",
      failureCode: "provider_temporary_failure",
      purpose: "connect",
      status: "failed",
      sql: /consumed_at IS NOT NULL/i
    },
    {
      terminalStatus: "cancelled",
      failureCode: "authorization_cancelled",
      purpose: "connect",
      status: "failed",
      sql: /cancelled_at IS NOT NULL/i
    },
    {
      terminalStatus: "expired",
      failureCode: "authorization_expired",
      purpose: "connect",
      status: "failed",
      sql: /failure_code='authorization_expired'/i
    },
    {
      terminalStatus: "consumed",
      failureCode: "provider_result_unknown",
      purpose: "reconnect",
      status: "reconnect_required",
      sql: /consumed_at IS NOT NULL/i
    }
  ];
  for (const item of cases) {
    const pool = createFakePool(async (call) => {
      if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
        return { rows: [{
          id: IDS.transaction,
          connection_id: IDS.connection,
          purpose: "connect"
        }] };
      }
      if (/UPDATE ia4tube_social\.social_connections/is.test(call.text)) {
        return { rows: [{ id: IDS.connection, revision: 2 }], rowCount: 1 };
      }
      if (/INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)) {
        return { rows: [{}], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const result = await createPostgresOAuthRepository({
      pool,
      runtimeRole: RUNTIME_ROLE
    }).scope(CONTEXT_A).failAuthorizationConnection({
      authorizationHandle: IDS.transaction,
      connectionId: IDS.connection,
      purpose: item.purpose,
      expectedRevision: 1,
      failureCode: item.failureCode,
      terminalStatus: item.terminalStatus
    });
    assert.deepEqual(result, {
      authorizationHandle: IDS.transaction,
      connectionId: IDS.connection,
      purpose: item.purpose,
      terminalStatus: item.terminalStatus,
      failureCode: item.failureCode,
      status: item.status,
      revision: 2
    });
    const calls = productCalls(pool);
    const authorization = calls.find((call) =>
      /FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)
    );
    const connection = calls.find((call) =>
      /UPDATE ia4tube_social\.social_connections/is.test(call.text)
    );
    assert.match(authorization.text, item.sql);
    assert.match(authorization.text, /FOR UPDATE/i);
    assert.match(connection.text, /SET status=\$4/i);
    assert.match(connection.text, /status='authorization_pending'/i);
    assert.match(connection.text, /revision=\$5/i);
    assert.equal(connection.values[3], item.status);
    assert.ok(calls.some((call) => call.values.includes(
      item.status === "reconnect_required"
        ? "to_reconnect_required"
        : "to_failed"
    )));
    assert.ok(calls.some((call) => call.values.includes(item.failureCode)));
    assert.equal(
      calls.some((call) =>
        /social_encrypted_credentials|social_external_accounts/i.test(call.text)
      ),
      false
    );
  }
});

test("failAuthorizationConnection rejects terminal mismatch without touching the connection", async () => {
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_oauth_transactions/is.test(call.text)) {
      return { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  });
  const repository = createPostgresOAuthRepository({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A);
  await assert.rejects(
    repository.failAuthorizationConnection({
      authorizationHandle: IDS.transaction,
      connectionId: IDS.connection,
      purpose: "connect",
      expectedRevision: 1,
      failureCode: "authorization_expired",
      terminalStatus: "expired"
    }),
    { code: "authorization_expired" }
  );
  assert.equal(
    productCalls(pool).some((call) =>
      /UPDATE ia4tube_social\.social_connections/i.test(call.text)
    ),
    false
  );
  const callsBeforeInvalid = pool.calls.length;
  await assert.rejects(
    repository.failAuthorizationConnection({
      authorizationHandle: IDS.transaction,
      connectionId: IDS.connection,
      purpose: "connect",
      expectedRevision: 1,
      failureCode: "provider_temporary_failure",
      terminalStatus: "cancelled"
    }),
    { code: "connector_contract_invalid" }
  );
  assert.equal(pool.calls.length, callsBeforeInvalid);
});

test("audit appends only the approved structured allowlist with parameterized SQL", async () => {
  const pool = createFakePool(async (call) => {
    if (/INSERT INTO .*audit/is.test(call.text)) return { rows: [{}] };
    return { rows: [] };
  });
  const audit = createPostgresConnectorAudit({
    pool,
    runtimeRole: RUNTIME_ROLE
  });
  await audit.append(CONTEXT_A, {
    companyId: CONTEXT_A.companyId,
    actorUserId: CONTEXT_A.userId,
    provider: "instagram",
    auditEventId: IDS.audit,
    correlationId: IDS.correlation,
    action: "social.authorization.begin",
    outcome: "succeeded",
    detailsCode: null
  });
  assertScopedTransaction(pool, CONTEXT_A.companyId);
  const [insert] = productCalls(pool);
  assert.match(insert.text, /INSERT INTO .*audit/is);
  assertParameterized(insert, [CONTEXT_A.companyId, CONTEXT_A.userId]);
  assert.equal(JSON.stringify(pool.calls).includes(SYNTHETIC_SECRET_MARKER), false);

  const before = pool.calls.length;
  await assert.rejects(audit.append(CONTEXT_A, {
    companyId: CONTEXT_A.companyId,
    actorUserId: CONTEXT_A.userId,
    provider: "instagram",
    auditEventId: IDS.audit,
    correlationId: IDS.correlation,
    action: "social.authorization.begin",
    outcome: "failed",
    detailsCode: "provider_temporary_failure",
    token: SYNTHETIC_SECRET_MARKER
  }));
  assert.equal(pool.calls.length, before);
});

test("audit omits nonexistent or cross-tenant references without masking failure metadata", async () => {
  const foreignConnectionId = "30000000-0000-4000-8000-000000000013";
  const foreignPublicationId = "30000000-0000-4000-8000-000000000014";
  const pool = createFakePool(async (call) => {
    if (/AS publication_connection_id/is.test(call.text)) {
      return {
        rows: [{
          connection_id: null,
          publication_id: null,
          publication_connection_id: null
        }]
      };
    }
    if (/INSERT INTO .*social_audit_events/is.test(call.text)) {
      return { rows: [{ event_id: IDS.audit }], rowCount: 1 };
    }
    return { rows: [] };
  });
  await createPostgresConnectorAudit({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).append(CONTEXT_A, {
    connectionId: foreignConnectionId,
    publicationId: foreignPublicationId,
    action: "social.publication.publish",
    outcome: "failed",
    detailsCode: "provider_temporary_failure"
  });
  assertScopedTransaction(pool, CONTEXT_A.companyId);

  const calls = productCalls(pool);
  const referenceLookup = calls.find((call) =>
    /AS publication_connection_id/is.test(call.text)
  );
  assert.ok(referenceLookup);
  assert.match(referenceLookup.text, /connection\.company_id=\$1/i);
  assert.match(referenceLookup.text, /publication\.company_id=\$1/i);
  assert.deepEqual(referenceLookup.values, [
    CONTEXT_A.companyId,
    foreignConnectionId,
    foreignPublicationId,
    "instagram"
  ]);
  const insert = calls.find((call) =>
    /INSERT INTO .*social_audit_events/is.test(call.text)
  );
  assert.ok(insert);
  assert.equal(insert.values[4], null);
  assert.equal(insert.values[5], null);
  assert.ok(insert.values.includes("social.publication.publish"));
  assert.ok(insert.values.includes("failed"));
  assert.ok(insert.values.includes("provider_temporary_failure"));
});

test("the central internal-audit matrix accepts every declared writer event", () => {
  const matrix = Object.freeze({
    "social.connection.state_transition": [
      "to_authorization_pending",
      "to_connected",
      "to_reconnect_required",
      "to_disconnecting",
      "to_disconnected",
      "to_failed"
    ],
    "social.connection.disconnected": [
      "account_revoked",
      "no_active_account"
    ],
    "social.credential.removed": ["credential_revoked"],
    "social.publication.created": ["state_ready"],
    "social.publication.state_transition": [
      "to_publishing",
      "to_provider_confirming",
      "to_published",
      "to_failed_temporary",
      "to_failed_permanent"
    ],
    "social.authorization.started": [
      "purpose_connect",
      "purpose_reconnect"
    ],
    "social.authorization.consumed": [null],
    "social.authorization.cancelled": [null],
    "social.authorization.failed": Object.keys(ERROR_DEFINITIONS)
  });
  for (const [action, detailsCodes] of Object.entries(matrix)) {
    const outcome = action === "social.authorization.failed"
      ? "failed"
      : "succeeded";
    for (const detailsCode of detailsCodes) {
      assert.deepEqual(
        assertInternalConnectorAudit(action, outcome, detailsCode),
        { action, outcome, detailsCode }
      );
    }
  }
});

test("the central internal-audit matrix rejects swapped action, detail or outcome", () => {
  const valid = [
    ["social.connection.state_transition", "to_connected", "succeeded"],
    ["social.connection.disconnected", "account_revoked", "succeeded"],
    ["social.credential.removed", "credential_revoked", "succeeded"],
    ["social.publication.created", "state_ready", "succeeded"],
    ["social.publication.state_transition", "to_published", "succeeded"],
    ["social.authorization.started", "purpose_connect", "succeeded"],
    ["social.authorization.consumed", null, "succeeded"],
    ["social.authorization.cancelled", null, "succeeded"],
    ["social.authorization.failed", "authorization_expired", "failed"]
  ];
  for (const [action, detailsCode, outcome] of valid) {
    assert.throws(() => assertInternalConnectorAudit(
      action,
      outcome === "failed" ? "succeeded" : "failed",
      detailsCode
    ));
    const swappedDetails = action === "social.authorization.failed"
      ? "state_ready"
      : "provider_temporary_failure";
    assert.throws(() => assertInternalConnectorAudit(
      action,
      outcome,
      swappedDetails
    ));
  }
  assert.throws(() => assertInternalConnectorAudit(
    "social.authorization.begin",
    "succeeded",
    null
  ));
  assert.throws(() => assertInternalConnectorAudit(
    "social.publication.created",
    "pending",
    "state_ready"
  ));
});

test("store and OAuth writers validate internal audit metadata before SQL", () => {
  const storeSource = fs.readFileSync(path.join(
    ROOT,
    "src/persistence/postgres/social-connector-store.js"
  ), "utf8");
  const oauthSource = fs.readFileSync(path.join(
    ROOT,
    "src/persistence/postgres/social-oauth-repository.js"
  ), "utf8");
  assert.match(
    storeSource,
    /async function appendInternalAudit[\s\S]{0,1200}assertInternalConnectorAudit[\s\S]{0,1200}client\.query/
  );
  assert.match(
    oauthSource,
    /async function appendOAuthAudit[\s\S]{0,1200}assertInternalConnectorAudit[\s\S]{0,1200}client\.query/
  );
});

test("invalid store, OAuth and audit input fails before pool creation", async () => {
  const pool = createFakePool();
  const store = createPostgresConnectorStore({ pool, runtimeRole: RUNTIME_ROLE });
  const oauth = createPostgresOAuthRepository({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A);
  const audit = createPostgresConnectorAudit({ pool, runtimeRole: RUNTIME_ROLE });
  await assert.rejects(async () => store.scope(CONTEXT_A).saveConnection({
    ...connectorRecord(),
    accessToken: SYNTHETIC_SECRET_MARKER
  }, null));
  await assert.rejects(async () => oauth.createAuthorization(oauthInput({
    oauthCode: SYNTHETIC_SECRET_MARKER
  })));
  await assert.rejects(async () => audit.append(CONTEXT_A, {
    companyId: CONTEXT_A.companyId,
    token: SYNTHETIC_SECRET_MARKER
  }));
  assert.equal(pool.calls.length, 0);
});

test("local persistence adapters make zero external calls", async () => {
  await withNetworkDenied(async () => {
    const pool = createFakePool(async (call) => ({
      rows: /INSERT INTO .*audit/is.test(call.text) ? [{}] : [],
      rowCount: /INSERT INTO .*audit/is.test(call.text) ? 1 : 0
    }));
    const store = createPostgresConnectorStore({
      pool,
      runtimeRole: RUNTIME_ROLE
    });
    await store.scope(CONTEXT_A).getConnection(IDS.connection);

    const oauth = createPostgresOAuthRepository({
      pool,
      runtimeRole: RUNTIME_ROLE
    }).scope(CONTEXT_A);
    await assert.rejects(oauth.consumeAuthorization(oauthConsumeInput()));

    const audit = createPostgresConnectorAudit({
      pool,
      runtimeRole: RUNTIME_ROLE
    });
    await audit.append(CONTEXT_A, {
      companyId: CONTEXT_A.companyId,
      actorUserId: CONTEXT_A.userId,
      provider: "instagram",
      auditEventId: IDS.audit,
      correlationId: IDS.correlation,
      action: "social.authorization.begin",
      outcome: "succeeded",
      detailsCode: null
    });
  });
});

test("connection detail reads are tenant-scoped, date-safe and secret-free", async () => {
  const createdAt = new Date("2026-08-27T12:00:00.000Z");
  const connectedAt = new Date("2026-08-27T12:01:00.000Z");
  const updatedAt = new Date("2026-08-27T12:02:00.000Z");
  const expiresAt = new Date("2026-08-27T14:00:00.000Z");
  const observedAt = new Date("2026-08-27T12:03:00.000Z");
  const row = connectionRow({
    status: "connected",
    revision: 4,
    created_at: createdAt,
    connected_at: connectedAt,
    updated_at: updatedAt,
    disconnected_at: null,
    expires_at: expiresAt,
    external_account_id: "synthetic-account-row-001",
    external_id: professionalAccount().externalId,
    username: professionalAccount().username,
    display_name: professionalAccount().displayName,
    account_type: professionalAccount().accountType,
    external_account_status: "active",
    active_credential_id: IDS.credential,
    credential_expires_at: expiresAt,
    granted_scopes: [
      "instagram_business_manage_messages",
      "instagram_business_basic"
    ],
    observed_at: observedAt
  });
  const currentPool = createFakePool(async () => ({ rows: [row] }));
  const current = await createPostgresConnectorStore({
    pool: currentPool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).getCurrentConnectionDetails();

  assert.deepEqual(Object.keys(current).sort(), [
    "account",
    "companyId",
    "connectedAt",
    "createdAt",
    "disconnectedAt",
    "expiresAt",
    "grantedScopes",
    "health",
    "id",
    "provider",
    "revision",
    "state",
    "updatedAt"
  ]);
  assert.equal(current.companyId, CONTEXT_A.companyId);
  assert.equal(current.state, "connected");
  assert.equal(current.health, "healthy");
  assert.deepEqual(current.account, professionalAccount());
  assert.deepEqual(current.grantedScopes, [
    "instagram_business_basic",
    "instagram_business_manage_messages"
  ]);
  for (const [field, expected] of [
    ["createdAt", createdAt],
    ["connectedAt", connectedAt],
    ["updatedAt", updatedAt],
    ["expiresAt", expiresAt]
  ]) {
    assert.equal(current[field].getTime(), expected.getTime());
    assert.notEqual(current[field], expected);
  }
  assert.equal(current.disconnectedAt, null);
  assertScopedTransaction(currentPool, CONTEXT_A.companyId);
  const currentRead = productCalls(currentPool)[0];
  assert.deepEqual(currentRead.values.slice(0, 2), [
    CONTEXT_A.companyId,
    "instagram"
  ]);
  assert.match(currentRead.text, /status=ANY\(\$3::text\[\]\)/i);
  assert.doesNotMatch(
    currentRead.text,
    /ciphertext|nonce|auth_tag|key_version/i
  );

  const byIdPool = createFakePool(async () => ({ rows: [row] }));
  const byId = await createPostgresConnectorStore({
    pool: byIdPool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).getConnectionDetails(IDS.connection);
  assert.deepEqual(byId, current);
  assert.deepEqual(productCalls(byIdPool)[0].values, [
    CONTEXT_A.companyId,
    IDS.connection,
    "instagram"
  ]);
  assert.equal(flattenedValues(byIdPool).includes(CONTEXT_B.companyId), false);

  const emptyPool = createFakePool();
  assert.equal(await createPostgresConnectorStore({
    pool: emptyPool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).getCurrentConnectionDetails(), null);
});

test("authorization status is tenant-scoped and exposes only normalized lifecycle data", async () => {
  const expiresAt = new Date("2026-08-27T14:00:00.000Z");
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_oauth_transactions o/is.test(call.text)) {
      return { rows: [{
        connection_id: IDS.connection,
        purpose: "connect",
        expires_at: expiresAt,
        consumed_at: new Date("2026-08-27T12:01:00.000Z"),
        cancelled_at: null,
        failed_at: null,
        failure_code: null,
        authorization_expired: false,
        authorization_succeeded: true,
        connection_status: "connected"
      }] };
    }
    return { rows: [], rowCount: 0 };
  });
  const result = await createPostgresOAuthRepository({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).getAuthorizationStatus(IDS.connection);
  assert.deepEqual(result, {
    connectionId: IDS.connection,
    purpose: "connect",
    status: "authorization_completed",
    expiresAt
  });
  assertScopedTransaction(pool, CONTEXT_A.companyId);
  const read = productCalls(pool)[0];
  assert.deepEqual(read.values, [
    CONTEXT_A.companyId,
    IDS.connection,
    "instagram"
  ]);
  assert.doesNotMatch(
    read.text,
    /state_digest|session_jti_digest|redirect_uri_digest/i
  );
  assert.match(
    read.text,
    /o\.expires_at <= CURRENT_TIMESTAMP AS authorization_expired/i
  );
  assert.match(
    read.text,
    /credential\.id=o\.id[\s\S]*AS authorization_succeeded/i
  );

  const absent = createFakePool();
  await assert.rejects(
    createPostgresOAuthRepository({
      pool: absent,
      runtimeRole: RUNTIME_ROLE
    }).scope(CONTEXT_A).getAuthorizationStatus(IDS.connection),
    { code: "resource_unavailable" }
  );
});

test("authorization status derives expiry, failure and historical success durably", async () => {
  const expiresAt = new Date("2026-08-27T14:00:00.000Z");
  const terminalAt = new Date("2026-08-27T12:01:00.000Z");
  const baseRow = Object.freeze({
    connection_id: IDS.connection,
    purpose: "connect",
    expires_at: expiresAt,
    consumed_at: null,
    cancelled_at: null,
    failed_at: null,
    failure_code: null,
    authorization_expired: false,
    authorization_succeeded: false,
    connection_status: "authorization_pending"
  });
  const cases = [
    {
      name: "open transaction past database expiry",
      row: { ...baseRow, authorization_expired: true },
      expected: "authorization_expired"
    },
    {
      name: "non-expiry terminal failure",
      row: {
        ...baseRow,
        failed_at: terminalAt,
        failure_code: "provider_permanent_failure"
      },
      expected: "authorization_failed"
    },
    {
      name: "terminal expiry failure",
      row: {
        ...baseRow,
        failed_at: terminalAt,
        failure_code: "authorization_expired"
      },
      expected: "authorization_expired"
    },
    {
      name: "successful authorization after connection state changed",
      row: {
        ...baseRow,
        consumed_at: terminalAt,
        authorization_expired: true,
        authorization_succeeded: true,
        connection_status: "reconnect_required"
      },
      expected: "authorization_completed"
    }
  ];

  for (const item of cases) {
    const pool = createFakePool(async (call) => {
      if (/FROM ia4tube_social\.social_oauth_transactions o/is.test(call.text)) {
        return { rows: [item.row] };
      }
      return { rows: [], rowCount: 0 };
    });
    const result = await createPostgresOAuthRepository({
      pool,
      runtimeRole: RUNTIME_ROLE
    }).scope(CONTEXT_A).getAuthorizationStatus(IDS.connection);
    assert.equal(result.status, item.expected, item.name);
    assertScopedTransaction(pool, CONTEXT_A.companyId);
  }
});

test("local disconnect is idempotent and atomically revokes only connector material", async () => {
  let state = "connected";
  let revision = 7;
  let accountStatus = "active";
  let credentialActive = true;
  let scopes = 2;
  let disconnectedAt = null;
  const createdAt = new Date("2026-08-27T12:00:00.000Z");
  const connectedAt = new Date("2026-08-27T12:01:00.000Z");
  const updatedAt = new Date("2026-08-27T12:02:00.000Z");
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_connections connection/is.test(call.text)) {
      return { rows: [connectionRow({
        status: state,
        revision,
        created_at: createdAt,
        connected_at: connectedAt,
        updated_at: updatedAt,
        disconnected_at: disconnectedAt,
        expires_at: credentialActive
          ? new Date("2026-08-27T14:00:00.000Z")
          : null,
        external_account_id: "synthetic-account-row-001",
        external_id: professionalAccount().externalId,
        username: professionalAccount().username,
        display_name: professionalAccount().displayName,
        account_type: professionalAccount().accountType,
        external_account_status: accountStatus,
        active_credential_id: credentialActive ? IDS.credential : null,
        credential_expires_at: credentialActive
          ? new Date("2026-08-27T14:00:00.000Z")
          : null,
        granted_scopes: scopes > 0 ? ["instagram_business_basic"] : [],
        observed_at: new Date("2026-08-27T12:03:00.000Z")
      })] };
    }
    if (/UPDATE ia4tube_social\.social_connections/is.test(call.text)) {
      state = call.values[3];
      revision = call.values[4];
      if (state === "disconnected") {
        disconnectedAt = new Date("2026-08-27T12:04:00.000Z");
      }
      return { rows: [{ id: IDS.connection }], rowCount: 1 };
    }
    if (/UPDATE ia4tube_social\.social_external_accounts/is.test(call.text)) {
      const changed = accountStatus !== "revoked";
      accountStatus = "revoked";
      return { rows: [], rowCount: changed ? 1 : 0 };
    }
    if (/UPDATE ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )) {
      const changed = credentialActive;
      credentialActive = false;
      return { rows: [], rowCount: changed ? 1 : 0 };
    }
    if (/UPDATE ia4tube_social\.social_connection_scopes/is.test(
      call.text
    )) {
      const removed = scopes;
      scopes = 0;
      return { rows: [], rowCount: removed };
    }
    if (/INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)) {
      return { rows: [{}], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const scoped = createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A);
  const first = await scoped.disconnectConnectionLocally(IDS.connection);
  assert.equal(first.state, "disconnected");
  assert.equal(first.health, "disconnected");
  assert.equal(first.revision, 9);
  assert.equal(first.account, null);
  assert.deepEqual(first.grantedScopes, []);
  assert.equal(first.expiresAt, null);
  assertScopedTransaction(pool, CONTEXT_A.companyId);
  const firstCalls = productCalls(pool);
  assert.deepEqual(firstCalls.filter((call) =>
    /UPDATE ia4tube_social\.social_connections/is.test(call.text)
  ).map((call) => call.values[3]), ["disconnecting", "disconnected"]);
  assert.ok(firstCalls.some((call) =>
    /UPDATE ia4tube_social\.social_external_accounts/is.test(call.text) &&
    /status = 'revoked'/i.test(call.text)
  ));
  assert.ok(firstCalls.some((call) =>
    /UPDATE ia4tube_social\.social_encrypted_credentials/is.test(call.text) &&
    /revoked_at = CURRENT_TIMESTAMP/i.test(call.text)
  ));
  assert.equal(firstCalls.some((call) => /^DELETE /i.test(call.text)), false);
  assert.ok(firstCalls.some((call) =>
    /UPDATE ia4tube_social\.social_connection_scopes/i.test(call.text) &&
    /SET expires_at=GREATEST/i.test(call.text)
  ));

  const connectionUpdates = firstCalls.filter((call) =>
    /UPDATE ia4tube_social\.social_connections/is.test(call.text)
  ).length;
  const auditWrites = firstCalls.filter((call) =>
    /INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)
  ).length;
  const second = await scoped.disconnectConnectionLocally(IDS.connection);
  assert.equal(second.state, "disconnected");
  assert.equal(second.revision, first.revision);
  assert.equal(productCalls(pool).filter((call) =>
    /UPDATE ia4tube_social\.social_connections/is.test(call.text)
  ).length, connectionUpdates);
  assert.equal(productCalls(pool).filter((call) =>
    /INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)
  ).length, auditWrites);
});

test("credential activation restores the reusable account, token expiry and scopes atomically", async () => {
  let activated = false;
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_connections connection/is.test(call.text)) {
      return { rows: [connectionRow(activated
        ? {
          status: "connected",
          revision: 2,
          external_account_id: "synthetic-historical-account-row",
          external_id: professionalAccount().externalId,
          username: professionalAccount().username,
          display_name: professionalAccount().displayName,
          account_type: professionalAccount().accountType
        }
        : { status: "authorization_pending", revision: 1 })] };
    }
    if (/UPDATE ia4tube_social\.social_connections/is.test(call.text)) {
      activated = true;
      return { rows: [{ id: IDS.connection }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_external_accounts/is.test(
      call.text
    )) {
      return {
        rows: [{ id: "synthetic-historical-account-row" }],
        rowCount: 1
      };
    }
    if (/UPDATE ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )) {
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )) {
      return { rows: [{
        id: IDS.credential,
        credential_type: "instagram_user_access_token",
        key_version: "social-kek-v1",
        aad_version: 1,
        revision: 1,
        expires_at: expiresAt
      }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_audit_events/is.test(call.text)) {
      return { rows: [{}], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const result = await createPostgresConnectorStore({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A).activateConnectionWithCredential(
    connectorRecord({
      state: "connected",
      account: professionalAccount(),
      revision: 2
    }),
    1,
    credentialEnvelope({
      credentialType: "instagram_user_access_token",
      expiresAt
    }),
    {
      grantedScopes: [
        "instagram_business_manage_messages",
        "instagram_business_basic",
        "instagram_business_basic"
      ]
    }
  );
  assert.equal(result.connection.state, "connected");
  assert.equal(result.credential.expiresAt.getTime(), expiresAt.getTime());
  assert.deepEqual(result.grantedScopes, [
    "instagram_business_basic",
    "instagram_business_manage_messages"
  ]);
  assertScopedTransaction(pool, CONTEXT_A.companyId);
  const calls = productCalls(pool);
  const connectionUpdate = calls.find((call) =>
    /UPDATE ia4tube_social\.social_connections/is.test(call.text)
  );
  assert.match(connectionUpdate.text, /expires_at=\$6/i);
  assert.equal(connectionUpdate.values[5].getTime(), expiresAt.getTime());
  const accountUpsert = calls.find((call) =>
    /INSERT INTO ia4tube_social\.social_external_accounts/is.test(call.text)
  );
  assert.match(accountUpsert.text, /status = 'active'/i);
  assert.match(
    accountUpsert.text,
    /WHERE social_external_accounts\.connection_id = EXCLUDED\.connection_id/i
  );
  const scopeExpiration = calls.findIndex((call) =>
    /UPDATE ia4tube_social\.social_connection_scopes/is.test(call.text)
  );
  const scopeInsert = calls.findIndex((call) =>
    /INSERT INTO ia4tube_social\.social_connection_scopes/is.test(call.text)
  );
  const credentialInsert = calls.findIndex((call) =>
    /INSERT INTO ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )
  );
  assert.ok(scopeExpiration > credentialInsert);
  assert.ok(scopeInsert > scopeExpiration);
  assert.deepEqual(calls[scopeInsert].values.slice(0, 3), [
    CONTEXT_A.companyId,
    IDS.connection,
    [
      "instagram_business_basic",
      "instagram_business_manage_messages"
    ]
  ]);
  assert.equal(calls[scopeInsert].values[3].getTime(), expiresAt.getTime());
  assert.equal(JSON.stringify(pool.calls).includes(SYNTHETIC_SECRET_MARKER), false);
});

test("scope persistence failure rolls back connection, account and credential activation", async () => {
  const pool = createFakePool(async (call) => {
    if (/FROM ia4tube_social\.social_connections connection/is.test(call.text)) {
      return { rows: [connectionRow({
        status: "authorization_pending",
        revision: 1
      })] };
    }
    if (/UPDATE ia4tube_social\.social_connections/is.test(call.text)) {
      return { rows: [{ id: IDS.connection }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_external_accounts/is.test(
      call.text
    )) {
      return { rows: [{ id: "synthetic-account-row-001" }], rowCount: 1 };
    }
    if (/UPDATE ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )) {
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO ia4tube_social\.social_encrypted_credentials/is.test(
      call.text
    )) {
      return { rows: [{
        id: IDS.credential,
        credential_type: "access_token",
        key_version: "social-kek-v1",
        aad_version: 1,
        revision: 1,
        expires_at: credentialEnvelope().expiresAt
      }], rowCount: 1 };
    }
    if (/INSERT INTO ia4tube_social\.social_connection_scopes/is.test(
      call.text
    )) {
      throw Object.assign(new Error("synthetic_scope_failure"), {
        code: "synthetic_scope_failure"
      });
    }
    return { rows: [], rowCount: 0 };
  });
  await assert.rejects(
    createPostgresConnectorStore({
      pool,
      runtimeRole: RUNTIME_ROLE
    }).scope(CONTEXT_A).activateConnectionWithCredential(
      connectorRecord({
        state: "connected",
        account: professionalAccount(),
        revision: 2
      }),
      1,
      credentialEnvelope(),
      { grantedScopes: ["instagram_business_basic"] }
    ),
    { code: "synthetic_scope_failure" }
  );
  assert.equal(pool.calls.some((call) => call.text.trim() === "ROLLBACK"), true);
  assert.equal(pool.calls.some((call) => call.text.trim() === "COMMIT"), false);
  assert.equal(productCalls(pool).some((call) =>
    call.values.includes("social.connection.state_transition") ||
    call.values.includes("social.credential.stored")
  ), false);
});

test("persistence source has no network/provider adapter or media-byte storage", () => {
  const files = [
    "src/persistence/postgres/social-connector-store.js",
    "src/persistence/postgres/social-oauth-repository.js",
    "src/persistence/postgres/social-connector-audit.js"
  ];
  const source = files
    .map((file) => fs.readFileSync(path.join(ROOT, file), "utf8"))
    .join("\n");
  assert.doesNotMatch(
    source,
    /\b(fetch|axios|undici|https?\.request|net\.connect|tls\.connect)\s*\(/
  );
  assert.doesNotMatch(
    source,
    /\b(image_bytes|media_bytes|image_blob|media_blob|binary_media)\b/i
  );
  assert.doesNotMatch(source, /graph\.facebook\.com|instagram\.com/i);
});

test.todo(
  "PHYSICAL GATE PENDING: migration apply/rollback/checksum on disposable PostgreSQL 18"
);
test.todo(
  "PHYSICAL GATE PENDING: RLS A/B, FORCE RLS and missing/tampered tenant context"
);
test.todo(
  "PHYSICAL GATE PENDING: concurrent unique connection, OAuth consume and idempotency races"
);
test.todo(
  "PHYSICAL GATE PENDING: vault persistence/rotation and no plaintext in database"
);
test.todo(
  "PHYSICAL GATE PENDING: restore pre-migration state in an isolated disposable database"
);
