"use strict";

const crypto = require("node:crypto");
const {
  MIGRATION_LOGIN,
  MIGRATOR_ROLE,
  OWNER_ROLE,
  PROVISIONER_LOGIN,
  RUNTIME_LOGIN,
  RUNTIME_ROLE,
  LOOPBACK
} = require("./social-3a0p-linux-postgres");

const IDENTITY_VERSION = "social-id-v1";
const VERIFIER_HOST = "local.ia4tube.invalid";

class LinuxPhysicalGateFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "LinuxPhysicalGateFailure";
    this.code = code;
  }
}

function fail(code) {
  throw new LinuxPhysicalGateFailure(code);
}

function exactRejection(results, fulfilled, code, rejectedCode) {
  const fulfilledCount = results.filter((item) => item.status === "fulfilled").length;
  const rejectedCount = results.filter((item) => item.status === "rejected").length;
  const rejectedCodesValid = rejectedCode === undefined || results
    .filter((item) => item.status === "rejected")
    .every((item) => item.reason?.code === rejectedCode);
  if (fulfilledCount !== fulfilled || rejectedCount !== results.length - fulfilled || !rejectedCodesValid) fail(code);
}

async function expectErrorCode(operation, expected, code) {
  try {
    await operation();
  } catch (error) {
    if (error?.code === expected) return true;
    fail(code);
  }
  fail(code);
}

function createTenant(label, dependencies = {}) {
  const randomUUID = dependencies.randomUUID || crypto.randomUUID;
  const identityKey = dependencies.identityKey || crypto.randomBytes(32);
  const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
  const { createConnectorContext } = require("../src/social/connectors/contract");
  const { SESSION_AUDIENCE, SESSION_ISSUER } = require("../src/social/reauth");
  const legacyId = `synthetic-linux-${label}`;
  const principal = createSocialAuthAdapter({
    namespaceUuid: "41cb8c58-0bf4-4bd9-83b2-3f2f96dfe29f",
    key: identityKey,
    derivationVersion: IDENTITY_VERSION
  }).fromVerifiedJwt({
    token_version: 2,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    jti: `synthetic-linux-jwt-${label}`,
    sub: legacyId,
    whatsapp: legacyId,
    company_id: legacyId
  });
  const fixture = Object.freeze({
    label,
    companyId: principal.companyId,
    userId: principal.userId,
    connectionId: randomUUID(),
    secondConnectionId: randomUUID(),
    activeConnectionId: randomUUID(),
    authorizationId: randomUUID(),
    expiredAuthorizationId: randomUUID(),
    operationId: randomUUID(),
    publicationId: randomUUID(),
    correlationId: randomUUID(),
    auditEventId: randomUUID()
  });
  const context = createConnectorContext({
    principal,
    provider: "instagram",
    environment: "test",
    correlationId: fixture.correlationId,
    auditEventId: fixture.auditEventId
  });
  return Object.freeze({ fixture, context, identityKey });
}

async function seedTenant(pool, fixture) {
  const { withTransaction } = require("../src/persistence/postgres/pool");
  await withTransaction(pool, async (client) => {
    await client.query(
      "INSERT INTO ia4tube_social.companies(id,name,identity_derivation_version) VALUES($1,$2,$3)",
      [fixture.companyId, `Synthetic Linux ${fixture.label}`, IDENTITY_VERSION]
    );
    await client.query(
      "INSERT INTO ia4tube_social.users(company_id,id,login_key_digest) VALUES($1,$2,$3)",
      [fixture.companyId, fixture.userId, crypto.createHash("sha256").update(`linux:${fixture.userId}`).digest("hex")]
    );
    await client.query(
      "INSERT INTO ia4tube_social.company_memberships(company_id,user_id,role) VALUES($1,$2,'owner')",
      [fixture.companyId, fixture.userId]
    );
  }, { role: OWNER_ROLE, companyId: fixture.companyId });
}

async function runRlsAndRoleGate(state, dependencies = {}) {
  const { withTransaction } = require("../src/persistence/postgres/pool");
  const a = createTenant("rls-a", dependencies);
  const b = createTenant("rls-b", dependencies);
  try {
    await seedTenant(state.pools.migration, a.fixture);
    await seedTenant(state.pools.migration, b.fixture);
    const ownA = await withTransaction(state.pools.runtime, (client) => client.query(
      "SELECT COUNT(*)::integer AS n FROM ia4tube_social.companies WHERE id=$1", [a.fixture.companyId]
    ), { role: RUNTIME_ROLE, companyId: a.fixture.companyId });
    const crossA = await withTransaction(state.pools.runtime, (client) => client.query(
      "SELECT COUNT(*)::integer AS n FROM ia4tube_social.companies WHERE id=$1", [b.fixture.companyId]
    ), { role: RUNTIME_ROLE, companyId: a.fixture.companyId });
    const ownB = await withTransaction(state.pools.runtime, (client) => client.query(
      "SELECT COUNT(*)::integer AS n FROM ia4tube_social.companies WHERE id=$1", [b.fixture.companyId]
    ), { role: RUNTIME_ROLE, companyId: b.fixture.companyId });
    const crossB = await withTransaction(state.pools.runtime, (client) => client.query(
      "SELECT COUNT(*)::integer AS n FROM ia4tube_social.companies WHERE id=$1", [a.fixture.companyId]
    ), { role: RUNTIME_ROLE, companyId: b.fixture.companyId });
    if ([ownA, crossA, ownB, crossB].map((result) => Number(result.rows[0].n)).join(",") !== "1,0,1,0") {
      fail("linux_gate_rls_bidirectional_read_failed");
    }
    const missingContext = await withTransaction(state.pools.runtime, (client) => client.query(
      "SELECT COUNT(*)::integer AS n FROM ia4tube_social.companies"
    ), { role: RUNTIME_ROLE });
    if (Number(missingContext.rows?.[0]?.n) !== 0) fail("linux_gate_rls_missing_context_visible");
    await expectErrorCode(
      () => withTransaction(state.pools.runtime, async (client) => {
        await client.query("SELECT set_config('ia4tube.company_id',$1,TRUE)", ["not-a-uuid"]);
        return client.query("SELECT COUNT(*)::integer AS n FROM ia4tube_social.companies");
      }, { role: RUNTIME_ROLE }),
      "22P02",
      "linux_gate_rls_tampered_context_invalid"
    );
    const extraA = crypto.randomUUID();
    const extraB = crypto.randomUUID();
    const ownWriteA = await withTransaction(state.pools.runtime, (client) => client.query(
      "INSERT INTO ia4tube_social.users(company_id,id,login_key_digest) VALUES($1,$2,$3)",
      [a.fixture.companyId, extraA, crypto.createHash("sha256").update(extraA).digest("hex")]
    ), { role: RUNTIME_ROLE, companyId: a.fixture.companyId });
    const ownWriteB = await withTransaction(state.pools.runtime, (client) => client.query(
      "INSERT INTO ia4tube_social.users(company_id,id,login_key_digest) VALUES($1,$2,$3)",
      [b.fixture.companyId, extraB, crypto.createHash("sha256").update(extraB).digest("hex")]
    ), { role: RUNTIME_ROLE, companyId: b.fixture.companyId });
    if (ownWriteA.rowCount !== 1 || ownWriteB.rowCount !== 1) fail("linux_gate_rls_own_write_failed");
    await expectErrorCode(
      () => withTransaction(state.pools.runtime, (client) => client.query(
        "INSERT INTO ia4tube_social.users(company_id,id,login_key_digest) VALUES($1,$2,$3)",
        [b.fixture.companyId, crypto.randomUUID(), "e".repeat(64)]
      ), { role: RUNTIME_ROLE, companyId: a.fixture.companyId }),
      "42501",
      "linux_gate_rls_cross_write_a_to_b_invalid"
    );
    await expectErrorCode(
      () => withTransaction(state.pools.runtime, (client) => client.query(
        "INSERT INTO ia4tube_social.users(company_id,id,login_key_digest) VALUES($1,$2,$3)",
        [a.fixture.companyId, crypto.randomUUID(), "f".repeat(64)]
      ), { role: RUNTIME_ROLE, companyId: b.fixture.companyId }),
      "42501",
      "linux_gate_rls_cross_write_b_to_a_invalid"
    );
    const reused = await state.pools.runtime.connect();
    let connectionScopeReset = false;
    try {
      await reused.query("BEGIN");
      await reused.query(`SET LOCAL ROLE ${RUNTIME_ROLE}`);
      await reused.query("SELECT set_config('ia4tube.company_id',$1,TRUE)", [a.fixture.companyId]);
      await reused.query("COMMIT");
      await reused.query("BEGIN");
      await reused.query(`SET LOCAL ROLE ${RUNTIME_ROLE}`);
      await reused.query("SELECT set_config('ia4tube.company_id',$1,TRUE)", [b.fixture.companyId]);
      const result = await reused.query("SELECT COUNT(*)::integer AS n FROM ia4tube_social.companies WHERE id=$1", [a.fixture.companyId]);
      await reused.query("COMMIT");
      connectionScopeReset = Number(result.rows[0].n) === 0;
    } finally {
      await reused.query("ROLLBACK").catch(() => {});
      reused.release();
    }
    if (!connectionScopeReset) fail("linux_gate_rls_connection_context_leaked");
    const attributes = await state.pools.migration.query([
      "SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,",
      " pg_has_role($1,'ia4tube_social_migrator','MEMBER') AS migrator_member,",
      " has_table_privilege($1,'ia4tube_migrations.schema_migrations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS migration_table_privilege,",
      " has_schema_privilege($1,'ia4tube_migrations','CREATE') AS migration_schema_create",
      "FROM pg_catalog.pg_roles WHERE rolname=$1"
    ].join("\n"), [RUNTIME_LOGIN]);
    const role = attributes.rows?.[0];
    if (!role || role.rolsuper || role.rolbypassrls || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.migrator_member || role.migration_table_privilege || role.migration_schema_create) {
      fail("linux_gate_runtime_role_privileged");
    }
    return Object.freeze({
      companyAOwnReadWrite: true,
      companyBOwnReadWrite: true,
      companyAToBRefused: true,
      companyBToARefused: true,
      crossWriteRefused: true,
      missingContextZeroRows: true,
      tamperedContextSqlStateRefused: true,
      connectionScopeReset: true,
      runtimeSuperuser: false,
      runtimeBypassRls: false,
      runtimeCreateDb: false,
      runtimeCreateRole: false,
      runtimeMigrationPrivileges: false
    });
  } finally {
    a.identityKey.fill(0);
    b.identityKey.fill(0);
  }
}

async function insertConnectedConnection(pool, fixture) {
  const { withTransaction } = require("../src/persistence/postgres/pool");
  await withTransaction(pool, (client) => client.query([
    "INSERT INTO ia4tube_social.social_connections(",
    " company_id,id,provider,status,created_by_user_id,connected_at,revision",
    ") VALUES($1,$2,'instagram','connected',$3,CURRENT_TIMESTAMP,1)"
  ].join("\n"), [fixture.companyId, fixture.activeConnectionId, fixture.userId]), {
    role: OWNER_ROLE,
    companyId: fixture.companyId
  });
}

async function databaseContainsMarker(pool, marker, companyId) {
  const { withTransaction } = require("../src/persistence/postgres/pool");
  const result = await withTransaction(pool, (client) => client.query([
    "SELECT (",
    " EXISTS(SELECT 1 FROM ia4tube_social.social_oauth_transactions row WHERE to_jsonb(row)::text LIKE '%'||$1||'%') OR",
    " EXISTS(SELECT 1 FROM ia4tube_social.social_encrypted_credentials row WHERE to_jsonb(row)::text LIKE '%'||$1||'%')",
    ") AS present"
  ].join("\n"), [marker]), { role: OWNER_ROLE, companyId });
  return result.rows?.[0]?.present === true;
}

async function runConcurrencyOAuthIdempotencyGate(state, sensitiveMarkers, dependencies = {}) {
  const { createPostgresConnectorStore } = require("../src/persistence/postgres/social-connector-store");
  const { createPostgresOAuthRepository } = require("../src/persistence/postgres/social-oauth-repository");
  const { withTransaction } = require("../src/persistence/postgres/pool");
  const a = createTenant("concurrency-a", dependencies);
  const b = createTenant("concurrency-b", dependencies);
  try {
    await seedTenant(state.pools.migration, a.fixture);
    await seedTenant(state.pools.migration, b.fixture);
    const storeA = createPostgresConnectorStore({ pool: state.pools.runtime, runtimeRole: RUNTIME_ROLE }).scope(a.context);
    const storeB = createPostgresConnectorStore({ pool: state.pools.runtime, runtimeRole: RUNTIME_ROLE }).scope(b.context);
    const connectionRecord = (id) => ({
      companyId: a.fixture.companyId, id, provider: "instagram",
      state: "authorization_pending", account: null, revision: 1
    });
    const reservations = await Promise.allSettled([
      storeA.saveConnection(connectionRecord(a.fixture.connectionId), null),
      storeA.saveConnection(connectionRecord(a.fixture.secondConnectionId), null)
    ]);
    exactRejection(reservations, 1, "linux_gate_connection_reservation_race_invalid", "state_transition_invalid");
    const winning = reservations[0].status === "fulfilled" ? a.fixture.connectionId : a.fixture.secondConnectionId;
    const blocking = await withTransaction(state.pools.migration, (client) => client.query(
      "SELECT id::text AS id FROM ia4tube_social.social_connections WHERE company_id=$1 AND provider='instagram' AND status IN('pending','active','authorization_pending','connected','reconnect_required','disconnecting') ORDER BY id LIMIT 2",
      [a.fixture.companyId]
    ), { role: OWNER_ROLE, companyId: a.fixture.companyId });
    if (blocking.rows?.length !== 1 || blocking.rows[0].id !== winning) fail("linux_gate_connection_blocking_identity_invalid");

    const oauthA = createPostgresOAuthRepository({ pool: state.pools.runtime, runtimeRole: RUNTIME_ROLE }).scope(a.context);
    const oauthB = createPostgresOAuthRepository({ pool: state.pools.runtime, runtimeRole: RUNTIME_ROLE }).scope(b.context);
    const rawState = `synthetic-linux-state-${crypto.randomBytes(32).toString("hex")}`;
    const session = `synthetic-linux-session-${crypto.randomBytes(20).toString("hex")}`;
    sensitiveMarkers.push(rawState, session);
    const redirectUri = "https://synthetic.invalid/social/oauth/callback";
    const input = {
      authorizationHandle: a.fixture.authorizationId,
      connectionId: winning,
      purpose: "connect",
      state: rawState,
      redirectUri,
      sessionJti: session,
      expiresAt: new Date(Date.now() + 300_000)
    };
    await oauthA.createAuthorization(input);
    const consume = {
      authorizationHandle: input.authorizationHandle,
      state: rawState,
      redirectUri,
      sessionJti: session
    };
    const consumers = await Promise.allSettled([
      oauthA.consumeAuthorization(consume),
      oauthA.consumeAuthorization(consume)
    ]);
    exactRejection(consumers, 1, "linux_gate_oauth_single_consumer_invalid", "authorization_expired");
    await Promise.all([
      expectErrorCode(() => oauthA.consumeAuthorization(consume), "authorization_expired", "linux_gate_oauth_replay_invalid"),
      expectErrorCode(() => oauthB.consumeAuthorization(consume), "authorization_expired", "linux_gate_oauth_cross_company_invalid")
    ]);
    const expiredState = `synthetic-linux-expired-${crypto.randomBytes(32).toString("hex")}`;
    const expiredSession = `synthetic-linux-expired-session-${crypto.randomBytes(20).toString("hex")}`;
    sensitiveMarkers.push(expiredState, expiredSession);
    const expiredInput = {
      authorizationHandle: a.fixture.expiredAuthorizationId,
      connectionId: winning,
      purpose: "connect",
      state: expiredState,
      redirectUri,
      sessionJti: expiredSession,
      expiresAt: new Date(Date.now() + 300_000)
    };
    await oauthA.createAuthorization(expiredInput);
    await withTransaction(state.pools.migration, (client) => client.query(
      "UPDATE ia4tube_social.social_oauth_transactions SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE company_id=$1 AND id=$2",
      [a.fixture.companyId, a.fixture.expiredAuthorizationId]
    ), { role: OWNER_ROLE, companyId: a.fixture.companyId });
    await expectErrorCode(() => oauthA.consumeAuthorization({
      authorizationHandle: expiredInput.authorizationHandle,
      state: expiredState,
      redirectUri,
      sessionJti: expiredSession
    }), "authorization_expired", "linux_gate_oauth_expired_invalid");
    if (
      await databaseContainsMarker(state.pools.migration, rawState, a.fixture.companyId) ||
      await databaseContainsMarker(state.pools.migration, expiredState, a.fixture.companyId)
    ) {
      fail("linux_gate_oauth_plaintext_persisted");
    }

    await storeA.saveConnection({
      companyId: a.fixture.companyId, id: winning, provider: "instagram",
      state: "disconnected", account: null, revision: 2
    }, 1);
    await insertConnectedConnection(state.pools.migration, a.fixture);
    await insertConnectedConnection(state.pools.migration, b.fixture);
    const digest = crypto.createHash("sha256").update("synthetic-linux-publication").digest("hex");
    const request = (tenant, fixture) => ({
      capability: "publishImage",
      operationId: a.fixture.operationId,
      digest,
      payload: {
        operationId: a.fixture.operationId,
        publicationId: fixture.publicationId,
        connectionId: fixture.activeConnectionId,
        image: { mediaId: `synthetic-media-${tenant}`, mimeType: "image/jpeg" },
        caption: "Synthetic Linux caption"
      }
    });
    const publicationRace = await Promise.all([
      storeA.beginIdempotency(request("a", a.fixture)),
      storeA.beginIdempotency(request("a", a.fixture))
    ]);
    if (publicationRace.map((item) => item.status).sort().join(",") !== "acquired,pending") {
      fail("linux_gate_publication_idempotency_race_invalid");
    }
    await storeA.completeIdempotency({
      capability: "publishImage", operationId: a.fixture.operationId, digest,
      result: {
        publicationId: a.fixture.publicationId,
        connectionId: a.fixture.activeConnectionId,
        provider: "instagram",
        state: "published",
        confirmedProviderReference: "synthetic-linux-provider-reference",
        reconciliationReference: null,
        revision: 3
      },
      errorCode: null
    });
    const replay = await storeA.beginIdempotency(request("a", a.fixture));
    if (replay.status !== "completed") fail("linux_gate_idempotency_same_request_not_reused");
    await expectErrorCode(
      () => storeA.beginIdempotency({ ...request("a", a.fixture), digest: "f".repeat(64) }),
      "idempotency_conflict",
      "linux_gate_idempotency_changed_hash_invalid"
    );
    const crossTenant = await storeB.beginIdempotency(request("b", b.fixture));
    if (crossTenant.status !== "acquired") fail("linux_gate_idempotency_cross_tenant_refused");
    const rows = await withTransaction(state.pools.migration, (client) => client.query([
      "SELECT",
      " (SELECT COUNT(*)::integer FROM ia4tube_social.social_publications WHERE company_id=$1 AND id=$2) AS publications,",
      " (SELECT COUNT(*)::integer FROM ia4tube_social.social_publication_attempts WHERE company_id=$1 AND publication_id=$2) AS attempts"
    ].join("\n"), [a.fixture.companyId, a.fixture.publicationId]), { role: OWNER_ROLE, companyId: a.fixture.companyId });
    if (Number(rows.rows[0].publications) !== 1 || Number(rows.rows[0].attempts) !== 0) {
      fail("linux_gate_publication_duplicate_detected");
    }
    return Object.freeze({
      connectionReservationsConcurrent: 2,
      blockingConnections: 1,
      secondConnectionConflict: true,
      oauthSingleConsumer: true,
      oauthSecondConsumeRefused: true,
      oauthReplayRefused: true,
      oauthExpiredRefused: true,
      oauthCrossCompanyRefused: true,
      oauthPlaintextAbsent: true,
      sameRequestReused: true,
      changedHashConflict: true,
      crossTenantKeyAccepted: true,
      publicationRows: 1,
      duplicateAttempts: 0,
      externalCalls: 0
    });
  } finally {
    a.identityKey.fill(0);
    b.identityKey.fill(0);
  }
}

async function runVaultSupplementalGate(state, sensitiveMarkers) {
  const { createSocialVault } = require("../src/social/vault");
  const { deriveVaultKeyVersion, vaultKeyringFingerprint } = require("../src/social/vault-key-version");
  const token = Buffer.from(`synthetic-linux-token-${crypto.randomBytes(32).toString("hex")}`, "utf8");
  sensitiveMarkers.push(token.toString("utf8"));
  const key = state.materials.vault;
  const version = deriveVaultKeyVersion(1, key);
  const vault = createSocialVault({
    keyring: { activeVersion: version, keys: new Map([[version, key]]) },
    expectedKeyringFingerprint: vaultKeyringFingerprint(version, [version])
  });
  const context = {
    companyId: crypto.randomUUID(),
    provider: "instagram",
    credentialId: crypto.randomUUID(),
    credentialType: "access_token",
    subjectType: "connection",
    subjectId: crypto.randomUUID()
  };
  try {
    const envelope = vault.encrypt(token, context);
    const correct = vault.decrypt(envelope, context);
    const correctRoundTrip = correct.equals(token);
    correct.fill(0);
    const rejected = async (operation) => {
      try { operation(); return false; } catch (error) { return error?.code === "vault_authentication_failed"; }
    };
    const companyChanged = await rejected(() => vault.decrypt(envelope, { ...context, companyId: crypto.randomUUID() }));
    const providerChanged = await rejected(() => vault.decrypt(envelope, { ...context, provider: "facebook" }));
    const connectionChanged = await rejected(() => vault.decrypt(envelope, { ...context, subjectId: crypto.randomUUID() }));
    const aadChanged = await rejected(() => vault.decrypt(envelope, { ...context, credentialType: "refresh_token" }));
    const tampered = { ...envelope, ciphertext: Buffer.from(envelope.ciphertext) };
    tampered.ciphertext[0] ^= 0xff;
    const ciphertextChanged = await rejected(() => vault.decrypt(tampered, context));
    tampered.ciphertext.fill(0);
    if (!correctRoundTrip || !companyChanged || !providerChanged || !connectionChanged || !aadChanged || !ciphertextChanged) {
      fail("linux_gate_vault_context_validation_failed");
    }
    return Object.freeze({
      algorithm: "AES-256-GCM",
      aadBound: true,
      companyChangeRefused: true,
      providerChangeRefused: true,
      connectionChangeRefused: true,
      ciphertextTamperRefused: true,
      aadTamperRefused: true
    });
  } finally {
    vault.destroy();
    token.fill(0);
  }
}

function createLocalVerifierPoolClass({ PoolClass, port, database, passwords }) {
  return class LinuxLocalVerifierPool {
    constructor(configuration) {
      let parsed;
      try { parsed = new URL(configuration.connectionString); } catch { fail("linux_gate_verifier_target_invalid"); }
      const login = decodeURIComponent(parsed.username);
      const password = decodeURIComponent(parsed.password);
      if (
        parsed.hostname !== VERIFIER_HOST || Number(parsed.port) !== port ||
        decodeURIComponent(parsed.pathname.slice(1)) !== database || password !== passwords[login] ||
        configuration.ssl?.rejectUnauthorized !== true || configuration.ssl?.servername !== VERIFIER_HOST
      ) fail("linux_gate_verifier_target_invalid");
      return new PoolClass({
        ...configuration,
        connectionString: undefined,
        host: LOOPBACK,
        port,
        database,
        user: login,
        password,
        ssl: false
      });
    }
  };
}

function createRestoreBehaviorFacade(legacy2ARoot) {
  const original = require("../src/persistence/postgres/restore-behavior-verifiers");
  return Object.freeze({
    createRestoreBehaviorVerifiers(options) {
      return original.createRestoreBehaviorVerifiers({
        ...options,
        legacy2ARoot
      });
    }
  });
}

async function runPersistedVaultGate(state, sensitiveMarkers, legacy2ARoot) {
  const original = require("../src/persistence/postgres/restore-behavior-verifiers");
  const passwords = {
    [MIGRATION_LOGIN]: state.passwords[MIGRATION_LOGIN],
    [RUNTIME_LOGIN]: state.passwords[RUNTIME_LOGIN]
  };
  const databaseUrl = (login) => {
    const value = new URL(`postgresql://${VERIFIER_HOST}:${state.target.port}/${state.database}`);
    value.username = login;
    value.password = passwords[login];
    value.searchParams.set("sslmode", "verify-full");
    return value.toString();
  };
  const persistedA = Buffer.from(`persisted-a-${crypto.randomBytes(18).toString("hex")}`.slice(0, 48), "utf8");
  const persistedB = Buffer.from(`persisted-b-${crypto.randomBytes(18).toString("hex")}`.slice(0, 48), "utf8");
  if (persistedA.length !== 48 || persistedB.length !== 48) fail("linux_gate_persisted_marker_invalid");
  sensitiveMarkers.push(persistedA.toString("utf8"), persistedB.toString("utf8"));
  let plaintextIndex = 0;
  const gate = original.createRestoreBehaviorVerifiers({
    env: {},
    migrationDatabaseUrl: databaseUrl(MIGRATION_LOGIN),
    runtimeDatabaseUrl: databaseUrl(RUNTIME_LOGIN),
    expectedMigrationLogin: MIGRATION_LOGIN,
    expectedRuntimeLogin: RUNTIME_LOGIN,
    legacy2ARoot,
    randomBytes(size) {
      if (size === 48) {
        const source = plaintextIndex++ === 0 ? persistedA : persistedB;
        return Buffer.from(source);
      }
      return crypto.randomBytes(size);
    },
    dependencies: {
      PoolClass: createLocalVerifierPoolClass({
        PoolClass: state.PoolClass,
        port: state.target.port,
        database: state.database,
        passwords
      })
    }
  });
  try {
    if ((await gate.verifiers.verifyRuntimeIsolation()) !== true) fail("linux_gate_persisted_runtime_isolation_failed");
    if ((await gate.verifiers.verifyVault()) !== true) fail("linux_gate_persisted_vault_failed");
    return Object.freeze({
      runtimeIsolationPrerequisite: true,
      persistedRoundTrip: true,
      keyRotation: true,
      retirementWhileInUseRefused: true,
      plaintextDatabaseAbsent: true
    });
  } finally {
    await gate.close();
    persistedA.fill(0);
    persistedB.fill(0);
  }
}

module.exports = {
  LinuxPhysicalGateFailure,
  createLocalVerifierPoolClass,
  createRestoreBehaviorFacade,
  createTenant,
  databaseContainsMarker,
  runConcurrencyOAuthIdempotencyGate,
  runPersistedVaultGate,
  runRlsAndRoleGate,
  runVaultSupplementalGate,
  seedTenant
};
