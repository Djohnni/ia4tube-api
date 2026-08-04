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
    if (/DELETE FROM ia4tube_social\.social_connection_scopes/is.test(
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
    /DELETE FROM ia4tube_social\.social_connection_scopes/is
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

test("OAuth consume binds state, redirect, session and connection in one atomic update", async () => {
  const pool = createFakePool(async (call) => {
    if (/UPDATE .*oauth/is.test(call.text)) {
      return { rows: [{
        id: IDS.transaction,
        company_id: CONTEXT_A.companyId,
        connection_id: IDS.connection,
        purpose: "connect",
        status: "consumed",
        consumed_at: new Date()
      }] };
    }
    return { rows: [] };
  });
  const repository = createPostgresOAuthRepository({
    pool,
    runtimeRole: RUNTIME_ROLE
  }).scope(CONTEXT_A);
  await repository.consumeAuthorization(oauthConsumeInput());
  const [consume] = productCalls(pool);
  assert.match(consume.text, /^UPDATE /i);
  assert.match(consume.text, /consumed_at\s+IS\s+NULL/i);
  assert.match(consume.text, /expires_at\s*>/i);
  assert.match(consume.text, /RETURNING/i);
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
});

test("OAuth state owned by another company is refused under authenticated tenant scope", async () => {
  const pool = createFakePool(async (call) => {
    if (/UPDATE .*oauth/is.test(call.text)) {
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
  const [consume] = productCalls(pool);
  assert.ok(consume);
  assert.match(consume.text, /company_id\s*=\s*\$1/i);
  assert.equal(JSON.stringify(pool.calls).includes(SYNTHETIC_STATE), false);
});

test("OAuth replay, expiry or tampered binding is indistinguishable and refused", async () => {
  const pool = createFakePool(async () => ({ rows: [] }));
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
    })
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
  const serialized = JSON.stringify(pool.calls);
  assert.equal(serialized.includes(SYNTHETIC_STATE), false);
  assert.equal(serialized.includes(SYNTHETIC_SESSION_JTI), false);
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
