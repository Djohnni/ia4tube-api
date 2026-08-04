"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
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
  CONNECTOR_CAPABILITIES,
  createConnectorContext
} = require("../src/social/connectors/contract");
const {
  SocialConnectorError,
  publicConnectorError
} = require("../src/social/connectors/errors");
const {
  createConnectorRegistry
} = require("../src/social/connectors/registry");
const {
  createSocialConnectorService,
  inputDigest
} = require("../src/social/connectors/service");
const {
  CONNECTION_TRANSITIONS,
  PUBLICATION_TRANSITIONS,
  assertPublicationConfirmation,
  isPublicationConfirmed,
  transitionConnectionState,
  transitionPublicationState
} = require("../src/social/connectors/states");
const {
  SESSION_AUDIENCE,
  SESSION_ISSUER
} = require("../src/social/reauth");
const {
  createFakeSocialConnector,
  createSyntheticAudit,
  createSyntheticMediaAuthority,
  createSyntheticSocialStore
} = require("./helpers/fake-social-connector");

const ROOT = path.resolve(__dirname, "..");
const NAMESPACE = "41cb8c58-0bf4-4bd9-83b2-3f2f96dfe29f";
const IDENTITY_CONFIG = Object.freeze({
  namespaceUuid: NAMESPACE,
  key: Buffer.alloc(32, 37),
  derivationVersion: "social-id-v1"
});
let nextUuid = 1;

function uuid() {
  const suffix = String(nextUuid).padStart(12, "0");
  nextUuid += 1;
  return `00000000-0000-4000-8000-${suffix}`;
}

function principal(legacyId) {
  return createSocialAuthAdapter(IDENTITY_CONFIG).fromVerifiedJwt({
    token_version: 2,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    jti: `synthetic-jwt-jti-${legacyId}-000001`,
    sub: legacyId,
    whatsapp: legacyId,
    company_id: legacyId
  });
}

function contextFor(legacyId, environment = "test") {
  return createConnectorContext({
    principal: principal(legacyId),
    provider: "instagram",
    environment,
    correlationId: uuid(),
    auditEventId: uuid()
  });
}

function harness(connectorOptions = {}, registryOptions = {}) {
  const environment = registryOptions.environment || "test";
  const registry = createConnectorRegistry({
    environment,
    gates: registryOptions.gates
  });
  const connector = createFakeSocialConnector(connectorOptions);
  registry.register(connector);
  registry.seal();
  const store = createSyntheticSocialStore();
  const audit = createSyntheticAudit();
  const media = createSyntheticMediaAuthority();
  const logs = [];
  const service = createSocialConnectorService({
    registry,
    store,
    audit,
    media,
    logger: { info(entry) { logs.push(structuredClone(entry)); } }
  });
  return { audit, connector, logs, media, registry, service, store };
}

async function connectAccount(h, context, ids = {}) {
  const connectionId = ids.connectionId || uuid();
  const begun = await h.service.beginAuthorization(context, {
    operationId: ids.beginOperationId || uuid(),
    connectionId
  });
  const connected = await h.service.discoverAccount(context, {
    operationId: ids.discoverOperationId || uuid(),
    connectionId,
    authorizationHandle: begun.authorizationHandle
  });
  h.media.authorize(context, "synthetic-media-001");
  return { connectionId, connected };
}

test("contract exposes exactly the five approved capabilities", () => {
  assert.deepEqual(CONNECTOR_CAPABILITIES, [
    "beginAuthorization",
    "discoverAccount",
    "publishImage",
    "getPublicationStatus",
    "disconnect"
  ]);
  assert.equal(Object.isFrozen(CONNECTOR_CAPABILITIES), true);
});

test("registry accepts an explicit valid connector and exposes only metadata", () => {
  const registry = createConnectorRegistry({ environment: "test" });
  const fake = createFakeSocialConnector();
  assert.equal(registry.register(fake), "instagram");
  registry.seal();
  assert.deepEqual(registry.describe("instagram"), {
    provider: "instagram",
    capabilities: CONNECTOR_CAPABILITIES,
    external: false,
    testOnly: true
  });
  assert.equal(Object.hasOwn(registry.describe("instagram"), "invoke"), false);
  assert.equal(Object.hasOwn(registry, "connector"), false);
});

test("unknown provider is rejected closed", () => {
  const registry = createConnectorRegistry({ environment: "test" });
  registry.seal();
  assert.throws(
    () => registry.describe("facebook"),
    { code: "provider_not_supported" }
  );
  assert.throws(
    () => createConnectorContext({
      principal: principal("synthetic-a"),
      provider: "facebook",
      environment: "test",
      correlationId: uuid(),
      auditEventId: uuid()
    }),
    { code: "provider_not_supported" }
  );
});

test("duplicate registration and mutation after seal are rejected", () => {
  const registry = createConnectorRegistry({ environment: "test" });
  registry.register(createFakeSocialConnector());
  assert.throws(
    () => registry.register(createFakeSocialConnector()),
    { code: "connector_registration_duplicate" }
  );
  registry.seal();
  assert.throws(
    () => registry.register(createFakeSocialConnector()),
    { code: "connector_contract_invalid" }
  );
});

test("registry captures declared methods and external connectors fail closed by default", async () => {
  const mutable = { ...createFakeSocialConnector() };
  const registry = createConnectorRegistry({ environment: "test" });
  registry.register(mutable);
  registry.seal();
  mutable.beginAuthorization = async () => {
    throw new Error("mutated connector must not execute");
  };
  const context = contextFor("synthetic-a");
  const result = await registry.invoke(context, "beginAuthorization", {
    connectionId: uuid(),
    idempotencyKey: uuid()
  });
  assert.equal(result.state, "authorization_pending");

  const invalidClassification = createConnectorRegistry({ environment: "test" });
  assert.throws(
    () => invalidClassification.register({
      provider: "instagram",
      capabilities: [],
      synthetic: false,
      testOnly: false
    }),
    { code: "connector_contract_invalid" }
  );

  const external = createConnectorRegistry({ environment: "test" });
  external.register({
    provider: "instagram",
    capabilities: ["beginAuthorization"],
    external: true,
    synthetic: false,
    testOnly: false,
    async beginAuthorization() {
      return { state: "authorization_pending", authorizationHandle: "never" };
    }
  });
  external.seal();
  await assert.rejects(
    external.invoke(context, "beginAuthorization", {}),
    { code: "external_capability_disabled" }
  );
});

test("undeclared capability is rejected even when a method exists", async () => {
  const registry = createConnectorRegistry({ environment: "test" });
  registry.register(createFakeSocialConnector({
    capabilities: CONNECTOR_CAPABILITIES.filter(
      (capability) => capability !== "disconnect"
    )
  }));
  registry.seal();
  await assert.rejects(
    registry.invoke(contextFor("synthetic-a"), "disconnect", {}),
    { code: "capability_not_supported" }
  );
});

test("context without a principal branded by verified authentication is rejected", () => {
  const rawPrincipal = Object.freeze({
    companyId: uuid(),
    userId: uuid()
  });
  assert.throws(
    () => createConnectorContext({
      principal: rawPrincipal,
      provider: "instagram",
      environment: "test",
      correlationId: uuid(),
      auditEventId: uuid()
    }),
    { code: "social_context_invalid" }
  );
});

test("browser input cannot override company, user, provider or environment", async () => {
  const h = harness();
  const context = contextFor("synthetic-a");
  for (const field of ["companyId", "userId", "provider", "environment"]) {
    await assert.rejects(
      h.service.beginAuthorization(context, {
        operationId: uuid(),
        connectionId: uuid(),
        [field]: field === "provider" ? "instagram" : "forged"
      }),
      { code: "social_context_invalid" }
    );
  }
  assert.equal(h.store.snapshot(context).connections.length, 0);
});

test("authority scan is bounded and rejects deeply nested input safely", async () => {
  const h = harness();
  const context = contextFor("synthetic-a");
  let nested = { mediaId: "synthetic-media-001", mimeType: "image/jpeg" };
  for (let index = 0; index < 20; index += 1) nested = { image: nested };
  await assert.rejects(
    h.service.publishImage(context, {
      operationId: uuid(),
      publicationId: uuid(),
      connectionId: uuid(),
      image: nested
    }),
    { code: "connector_contract_invalid" }
  );
});

test("company A cannot access a connection from company B", async () => {
  const h = harness();
  const contextA = contextFor("synthetic-a");
  const contextB = contextFor("synthetic-b");
  const connectionId = uuid();
  h.store.seedConnection(contextB, {
    companyId: contextB.companyId,
    id: connectionId,
    provider: "instagram",
    state: "connected",
    account: null,
    revision: 1
  });
  await assert.rejects(
    h.service.disconnect(contextA, {
      operationId: uuid(),
      connectionId
    }),
    { code: "resource_unavailable" }
  );
  assert.equal(h.store.snapshot(contextB).connections[0].state, "connected");
});

test("company B cannot access a connection from company A", async () => {
  const h = harness();
  const contextA = contextFor("synthetic-a");
  const contextB = contextFor("synthetic-b");
  const connectionId = uuid();
  h.store.seedConnection(contextA, {
    companyId: contextA.companyId,
    id: connectionId,
    provider: "instagram",
    state: "connected",
    account: null,
    revision: 1
  });
  await assert.rejects(
    h.service.disconnect(contextB, {
      operationId: uuid(),
      connectionId
    }),
    { code: "resource_unavailable" }
  );
  assert.equal(h.store.snapshot(contextA).connections[0].state, "connected");
});

test("connection and publication initial states are explicit", () => {
  assert.equal(Object.hasOwn(CONNECTION_TRANSITIONS, "disconnected"), true);
  assert.equal(Object.hasOwn(PUBLICATION_TRANSITIONS, "ready"), true);
  assert.equal(CONNECTION_TRANSITIONS.disconnected.includes("authorization_pending"), true);
  assert.equal(PUBLICATION_TRANSITIONS.ready.includes("publishing"), true);
});

test("every declared valid state transition is accepted", () => {
  for (const [current, nextStates] of Object.entries(CONNECTION_TRANSITIONS)) {
    for (const next of nextStates) {
      assert.equal(transitionConnectionState(current, next), next);
    }
  }
  for (const [current, nextStates] of Object.entries(PUBLICATION_TRANSITIONS)) {
    for (const next of nextStates) {
      assert.equal(transitionPublicationState(current, next), next);
    }
  }
});

test("undeclared, self and terminal state transitions are rejected", () => {
  assert.throws(
    () => transitionConnectionState("connected", "connected"),
    { code: "state_transition_invalid" }
  );
  assert.throws(
    () => transitionConnectionState("disconnected", "connected"),
    { code: "state_transition_invalid" }
  );
  assert.throws(
    () => transitionPublicationState("published", "provider_confirming"),
    { code: "state_transition_invalid" }
  );
  assert.throws(
    () => transitionPublicationState("unknown", "ready"),
    { code: "state_transition_invalid" }
  );
});

test("only published carries a confirmed provider reference", () => {
  const published = {
    state: "published",
    confirmedProviderReference: "synthetic-confirmed-001"
  };
  assert.equal(isPublicationConfirmed(published), true);
  assert.throws(
    () => assertPublicationConfirmation({ state: "published" }),
    { code: "connector_contract_invalid" }
  );
  assert.throws(
    () => assertPublicationConfirmation({
      state: "published",
      confirmedProviderReference: 0
    }),
    { code: "connector_contract_invalid" }
  );
  assert.throws(
    () => assertPublicationConfirmation({
      state: "provider_confirming",
      confirmedProviderReference: "synthetic-not-confirmed"
    }),
    { code: "connector_contract_invalid" }
  );
});

test("pending provider result is never treated as published", async () => {
  const h = harness({
    publishSequence: [{
      outcome: "provider_confirming",
      reconciliationReference: "synthetic-reconcile-001"
    }]
  });
  const context = contextFor("synthetic-a");
  const { connectionId } = await connectAccount(h, context);
  const result = await h.service.publishImage(context, {
    operationId: uuid(),
    publicationId: uuid(),
    connectionId,
    image: { mediaId: "synthetic-media-001", mimeType: "image/jpeg" },
    caption: "Synthetic caption\nwith two lines"
  });
  assert.equal(result.state, "provider_confirming");
  assert.equal(result.confirmedProviderReference, null);
  assert.equal(isPublicationConfirmed({
    state: result.state,
    confirmedProviderReference: result.confirmedProviderReference,
    reconciliationReference: result.reconciliationReference
  }), false);
});

test("temporary and permanent publication failures remain distinct", async () => {
  const h = harness({
    publishSequence: [
      { outcome: "failed_temporary" },
      { outcome: "failed_permanent" }
    ]
  });
  const context = contextFor("synthetic-a");
  const { connectionId } = await connectAccount(h, context);
  const publicationId = uuid();
  const temporary = await h.service.publishImage(context, {
    operationId: uuid(),
    publicationId,
    connectionId,
    image: { mediaId: "synthetic-media-001", mimeType: "image/jpeg" }
  });
  assert.equal(temporary.state, "failed_temporary");
  const permanent = await h.service.publishImage(context, {
    operationId: uuid(),
    publicationId,
    connectionId,
    image: { mediaId: "synthetic-media-001", mimeType: "image/jpeg" }
  });
  assert.equal(permanent.state, "failed_permanent");
});

test("cancelled authorization does not create an active connection", async () => {
  const h = harness({ authorizationOutcome: "cancelled" });
  const context = contextFor("synthetic-a");
  const connectionId = uuid();
  const begun = await h.service.beginAuthorization(context, {
    operationId: uuid(),
    connectionId
  });
  await assert.rejects(
    h.service.discoverAccount(context, {
      operationId: uuid(),
      connectionId,
      authorizationHandle: begun.authorizationHandle
    }),
    { code: "authorization_cancelled" }
  );
  assert.equal(h.store.snapshot(context).connections[0].state, "disconnected");
});

test("personal account is rejected and never becomes connected", async () => {
  const h = harness({ authorizationOutcome: "personal" });
  const context = contextFor("synthetic-a");
  const connectionId = uuid();
  const begun = await h.service.beginAuthorization(context, {
    operationId: uuid(),
    connectionId
  });
  await assert.rejects(
    h.service.discoverAccount(context, {
      operationId: uuid(),
      connectionId,
      authorizationHandle: begun.authorizationHandle
    }),
    { code: "invalid_account_type" }
  );
  assert.equal(h.store.snapshot(context).connections[0].state, "failed");
});

test("Creator is accepted while expired authorization remains disconnected", async () => {
  const creatorHarness = harness({ accountType: "creator" });
  const creatorContext = contextFor("synthetic-creator");
  const creator = await connectAccount(creatorHarness, creatorContext);
  assert.equal(creator.connected.state, "connected");
  assert.equal(creator.connected.account.accountType, "creator");

  const expiredHarness = harness({ authorizationOutcome: "expired" });
  const expiredContext = contextFor("synthetic-expired");
  const connectionId = uuid();
  const begun = await expiredHarness.service.beginAuthorization(expiredContext, {
    operationId: uuid(),
    connectionId
  });
  await assert.rejects(
    expiredHarness.service.discoverAccount(expiredContext, {
      operationId: uuid(),
      connectionId,
      authorizationHandle: begun.authorizationHandle
    }),
    { code: "authorization_expired" }
  );
  assert.equal(
    expiredHarness.store.snapshot(expiredContext).connections[0].state,
    "disconnected"
  );
});

test("a second active Instagram account for the same company is refused", async () => {
  const h = harness();
  const context = contextFor("synthetic-a");
  const first = await connectAccount(h, context);
  const firstSnapshot = h.store.snapshot(context).connections.find(
    (item) => item.id === first.connectionId
  );
  await assert.rejects(
    h.service.beginAuthorization(context, {
      operationId: uuid(),
      connectionId: uuid()
    }),
    { code: "active_connection_exists" }
  );
  assert.equal(firstSnapshot.state, "connected");
  assert.equal(h.store.snapshot(context).connections.length, 1);
});

test("parallel attempts reserve only one Instagram connection slot", async () => {
  const h = harness();
  const context = contextFor("synthetic-a");
  const attempts = await Promise.allSettled([
    h.service.beginAuthorization(context, {
      operationId: uuid(),
      connectionId: uuid()
    }),
    h.service.beginAuthorization(context, {
      operationId: uuid(),
      connectionId: uuid()
    })
  ]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = attempts.find((item) => item.status === "rejected");
  assert.equal(rejected.reason.code, "active_connection_exists");
  assert.equal(h.store.snapshot(context).connections.length, 1);
});

test("disconnect is idempotent and invokes the connector only once", async () => {
  const h = harness();
  const context = contextFor("synthetic-a");
  const { connectionId } = await connectAccount(h, context);
  const first = await h.service.disconnect(context, {
    operationId: uuid(),
    connectionId,
    revoke: true
  });
  const second = await h.service.disconnect(context, {
    operationId: uuid(),
    connectionId,
    revoke: true
  });
  assert.equal(first.state, "disconnected");
  assert.deepEqual(second, first);
  assert.equal(h.connector.callCount("disconnect"), 1);
});

test("revocation converges to disconnected and disconnect failure is normalized", async () => {
  const revokedHarness = harness({ disconnectOutcome: "revoked" });
  const revokedContext = contextFor("synthetic-revoked");
  const revokedConnection = await connectAccount(revokedHarness, revokedContext);
  const revoked = await revokedHarness.service.disconnect(revokedContext, {
    operationId: uuid(),
    connectionId: revokedConnection.connectionId,
    revoke: true
  });
  assert.equal(revoked.state, "disconnected");

  const failedHarness = harness({
    disconnectThrows: new Error("synthetic raw disconnect body")
  });
  const failedContext = contextFor("synthetic-failed-disconnect");
  const failedConnection = await connectAccount(failedHarness, failedContext);
  await assert.rejects(
    failedHarness.service.disconnect(failedContext, {
      operationId: uuid(),
      connectionId: failedConnection.connectionId
    }),
    { code: "disconnect_failed" }
  );
  assert.equal(
    failedHarness.store.snapshot(failedContext).connections[0].state,
    "failed"
  );
});

test("same idempotency key returns the same result without duplication", async () => {
  const h = harness();
  const context = contextFor("synthetic-a");
  const operationId = uuid();
  const connectionId = uuid();
  const first = await h.service.beginAuthorization(context, {
    operationId,
    connectionId
  });
  const second = await h.service.beginAuthorization(context, {
    operationId,
    connectionId
  });
  assert.deepEqual(second, first);
  assert.equal(h.connector.callCount("beginAuthorization"), 1);
  assert.equal(h.store.snapshot(context).connections.length, 1);
  await assert.rejects(
    h.service.beginAuthorization(context, {
      operationId,
      connectionId: uuid()
    }),
    { code: "idempotency_conflict" }
  );
});

test("cached idempotency result is revalidated before it can reach a caller", async () => {
  const h = harness();
  const context = contextFor("synthetic-a");
  const operationId = uuid();
  const connectionId = uuid();
  h.store.seedIdempotency(context, {
    capability: "beginAuthorization",
    operationId,
    digest: inputDigest({ connectionId }),
    errorCode: null,
    result: {
      connectionId,
      provider: "instagram",
      state: "authorization_pending",
      account: null,
      revision: 2,
      authorizationHandle: "synthetic-authorization-safe",
      token: "synthetic-cached-secret-must-not-escape"
    }
  });
  await assert.rejects(
    h.service.beginAuthorization(context, { operationId, connectionId }),
    { code: "connector_contract_invalid" }
  );
  assert.equal(h.connector.callCount("beginAuthorization"), 0);
  assert.equal(
    JSON.stringify({ logs: h.logs, audit: h.audit.events() })
      .includes("synthetic-cached-secret-must-not-escape"),
    false
  );
});

test("stored account rows are allowlisted before being returned", async () => {
  const h = harness();
  const context = contextFor("synthetic-a");
  const connectionId = uuid();
  h.store.seedConnection(context, {
    companyId: context.companyId,
    id: connectionId,
    provider: "instagram",
    state: "reconnect_required",
    account: {
      externalId: "synthetic-external-001",
      username: "synthetic_company",
      displayName: "Synthetic Company",
      accountType: "business",
      ciphertext: "synthetic-row-secret-must-not-escape"
    },
    revision: 1
  });
  let error;
  try {
    await h.service.beginAuthorization(context, {
      operationId: uuid(),
      connectionId
    });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error.code, "connector_contract_invalid");
  assert.equal(
    JSON.stringify({
      error: { code: error.code, message: error.message },
      logs: h.logs,
      audit: h.audit.events()
    }).includes("synthetic-row-secret-must-not-escape"),
    false
  );
});

test("an in-flight duplicate is blocked before a second provider invocation", async () => {
  const h = harness();
  const context = contextFor("synthetic-a");
  const operationId = uuid();
  const connectionId = uuid();
  const attempts = await Promise.allSettled([
    h.service.beginAuthorization(context, { operationId, connectionId }),
    h.service.beginAuthorization(context, { operationId, connectionId })
  ]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = attempts.find((item) => item.status === "rejected");
  assert.equal(rejected.reason.code, "provider_result_unknown");
  assert.equal(h.connector.callCount("beginAuthorization"), 1);
  const replay = await h.service.beginAuthorization(context, {
    operationId,
    connectionId
  });
  assert.equal(replay.state, "authorization_pending");
});

test("publication media must be resolved as company-owned before connector invocation", async () => {
  const h = harness();
  const contextA = contextFor("synthetic-a");
  const contextB = contextFor("synthetic-b");
  const { connectionId } = await connectAccount(h, contextA);
  const mediaId = "synthetic-media-owned-by-b";
  h.media.authorize(contextB, mediaId);
  await assert.rejects(
    h.service.publishImage(contextA, {
      operationId: uuid(),
      publicationId: uuid(),
      connectionId,
      image: { mediaId, mimeType: "image/jpeg" }
    }),
    { code: "resource_unavailable" }
  );
  assert.equal(h.connector.callCount("publishImage"), 0);
});

test("late out-of-order pending response cannot regress a published result", async () => {
  const reconciliationReference = "synthetic-reconcile-001";
  const confirmedProviderReference = "synthetic-published-001";
  const h = harness({
    publishSequence: [{
      outcome: "provider_confirming",
      reconciliationReference
    }],
    statusSequence: [
      { outcome: "published", confirmedProviderReference },
      { outcome: "provider_confirming", reconciliationReference }
    ]
  });
  const context = contextFor("synthetic-a");
  const { connectionId } = await connectAccount(h, context);
  const publicationId = uuid();
  await h.service.publishImage(context, {
    operationId: uuid(),
    publicationId,
    connectionId,
    image: { mediaId: "synthetic-media-001", mimeType: "image/jpeg" }
  });
  const published = await h.service.getPublicationStatus(context, {
    operationId: uuid(),
    publicationId,
    providerReference: reconciliationReference
  });
  const late = await h.service.getPublicationStatus(context, {
    operationId: uuid(),
    publicationId,
    providerReference: reconciliationReference
  });
  assert.equal(published.state, "published");
  assert.equal(late.state, "published");
  assert.equal(late.confirmedProviderReference, confirmedProviderReference);
});

test("unknown publication result cannot be reconciled with a browser-supplied reference", async () => {
  const h = harness({
    publishThrows: new Error("synthetic ambiguous provider response")
  });
  const context = contextFor("synthetic-a");
  const { connectionId } = await connectAccount(h, context);
  const publicationId = uuid();
  await assert.rejects(
    h.service.publishImage(context, {
      operationId: uuid(),
      publicationId,
      connectionId,
      image: { mediaId: "synthetic-media-001", mimeType: "image/jpeg" }
    }),
    { code: "provider_result_unknown" }
  );
  await assert.rejects(
    h.service.getPublicationStatus(context, {
      operationId: uuid(),
      publicationId,
      providerReference: "browser-invented-reference"
    }),
    { code: "resource_unavailable" }
  );
  assert.equal(h.connector.callCount("getPublicationStatus"), 0);
});

test("status request failures keep an unknown publication pending", async () => {
  for (const code of [
    "provider_temporary_failure",
    "provider_permanent_failure"
  ]) {
    const h = harness({
      publishSequence: [{
        outcome: "provider_confirming",
        reconciliationReference: `synthetic-${code}`
      }],
      statusThrows: new SocialConnectorError(code)
    });
    const context = contextFor(`synthetic-${code}`);
    const { connectionId } = await connectAccount(h, context);
    const publicationId = uuid();
    const pending = await h.service.publishImage(context, {
      operationId: uuid(),
      publicationId,
      connectionId,
      image: { mediaId: "synthetic-media-001", mimeType: "image/jpeg" }
    });
    await assert.rejects(
      h.service.getPublicationStatus(context, {
        operationId: uuid(),
        publicationId,
        providerReference: pending.reconciliationReference
      }),
      { code }
    );
    assert.equal(
      h.store.snapshot(context).publications[0].state,
      "provider_confirming"
    );
  }
});

test("only an explicit status result transitions to provider failure", async () => {
  for (const expectedState of ["failed_temporary", "failed_permanent"]) {
    const h = harness({
      publishSequence: [{
        outcome: "provider_confirming",
        reconciliationReference: `synthetic-${expectedState}`
      }],
      statusSequence: [{ outcome: expectedState }]
    });
    const context = contextFor(`synthetic-explicit-${expectedState}`);
    const { connectionId } = await connectAccount(h, context);
    const publicationId = uuid();
    const pending = await h.service.publishImage(context, {
      operationId: uuid(),
      publicationId,
      connectionId,
      image: { mediaId: "synthetic-media-001", mimeType: "image/jpeg" }
    });
    const result = await h.service.getPublicationStatus(context, {
      operationId: uuid(),
      publicationId,
      providerReference: pending.reconciliationReference
    });
    assert.equal(result.state, expectedState);
  }
});

test("malformed post-call publication result becomes unknown and cannot be republished", async () => {
  const marker = "synthetic-raw-provider-body-must-not-escape";
  const h = harness({
    publishSequence: [{
      outcome: "published",
      confirmedProviderReference: "synthetic-confirmed-001",
      rawProviderBody: marker
    }]
  });
  const context = contextFor("synthetic-malformed-result");
  const { connectionId } = await connectAccount(h, context);
  const publicationId = uuid();
  const publication = {
    publicationId,
    connectionId,
    image: { mediaId: "synthetic-media-001", mimeType: "image/jpeg" }
  };
  await assert.rejects(
    h.service.publishImage(context, {
      ...publication,
      operationId: uuid()
    }),
    { code: "provider_result_unknown" }
  );
  assert.equal(
    h.store.snapshot(context).publications[0].state,
    "provider_confirming"
  );
  await assert.rejects(
    h.service.publishImage(context, {
      ...publication,
      operationId: uuid()
    }),
    { code: "state_transition_invalid" }
  );
  assert.equal(h.connector.callCount("publishImage"), 1);
  assert.equal(
    JSON.stringify({ logs: h.logs, audit: h.audit.events() }).includes(marker),
    false
  );
});

test("missing permission marks the connection for reconnection", async () => {
  const h = harness({
    publishThrows: new SocialConnectorError("permission_missing")
  });
  const context = contextFor("synthetic-permission");
  const { connectionId } = await connectAccount(h, context);
  await assert.rejects(
    h.service.publishImage(context, {
      operationId: uuid(),
      publicationId: uuid(),
      connectionId,
      image: { mediaId: "synthetic-media-001", mimeType: "image/jpeg" }
    }),
    { code: "permission_missing" }
  );
  const snapshot = h.store.snapshot(context);
  assert.equal(snapshot.connections[0].state, "reconnect_required");
  assert.equal(snapshot.publications[0].state, "failed_permanent");
});

test("unexpected provider data is normalized and secrets never reach output or logs", async () => {
  const marker = "synthetic-secret-marker-Bearer-token-ciphertext";
  const h = harness({ beginThrows: new Error(marker) });
  const context = contextFor("synthetic-a");
  let error;
  try {
    await h.service.beginAuthorization(context, {
      operationId: uuid(),
      connectionId: uuid()
    });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error instanceof SocialConnectorError, true);
  assert.equal(error.code, "provider_result_unknown");
  const publicError = publicConnectorError(error, context.correlationId);
  const combined = JSON.stringify({
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable
    },
    publicError,
    logs: h.logs,
    audit: h.audit.events()
  });
  assert.equal(combined.includes(marker), false);
  assert.equal(combined.includes("Authorization"), false);
  assert.equal(combined.includes("ciphertext"), false);
  assert.deepEqual(Object.keys(publicError).sort(), [
    "code",
    "correlationId",
    "retryable"
  ]);
  assert.equal(
    publicConnectorError(error, "https://secret.invalid/?token=marker")
      .correlationId,
    null
  );
});

test("audit metadata is tenant-bound and contains only normalized fields", async () => {
  const h = harness();
  const context = contextFor("synthetic-a");
  await h.service.beginAuthorization(context, {
    operationId: uuid(),
    connectionId: uuid()
  });
  const event = h.audit.events()[0];
  assert.equal(event.companyId, context.companyId);
  assert.equal(event.actorUserId, context.userId);
  assert.equal(event.provider, "instagram");
  assert.equal(event.correlationId, context.correlationId);
  assert.equal(event.auditEventId, context.auditEventId);
  assert.deepEqual(Object.keys(event).sort(), [
    "action",
    "actorUserId",
    "auditEventId",
    "companyId",
    "correlationId",
    "detailsCode",
    "outcome",
    "provider"
  ]);
});

test("synthetic connector cannot be registered in staging or production", () => {
  for (const environment of ["staging", "production"]) {
    const registry = createConnectorRegistry({ environment });
    assert.throws(
      () => registry.register(createFakeSocialConnector()),
      { code: "synthetic_connector_forbidden" }
    );
  }
});

test("fake rejects token-shaped fields and is absent from product runtime", async () => {
  const fake = createFakeSocialConnector();
  await assert.rejects(
    fake.beginAuthorization(contextFor("synthetic-a"), {
      connectionId: uuid(),
      token: "synthetic-token-must-be-rejected"
    }),
    { code: "connector_contract_invalid" }
  );
  await assert.rejects(
    fake.beginAuthorization(contextFor("synthetic-a"), {
      connectionId: uuid(),
      access_token: "synthetic-token-must-be-rejected"
    }),
    { code: "connector_contract_invalid" }
  );
  for (const file of [
    "server.js",
    "src/social/runtime.js",
    "src/social/server-runtime.js"
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.equal(source.includes("fake-social-connector"), false);
    assert.equal(source.includes("createFakeSocialConnector"), false);
  }
});

test("synthetic end-to-end connector path performs zero external calls", async () => {
  const originals = [];
  let calls = 0;
  function block(object, key) {
    if (!object || typeof object[key] !== "function") return;
    originals.push([object, key, object[key]]);
    object[key] = function blockedExternalCall() {
      calls += 1;
      throw new Error("external call blocked");
    };
  }
  const originalFetch = global.fetch;
  global.fetch = async function blockedFetch() {
    calls += 1;
    throw new Error("external call blocked");
  };
  for (const [object, keys] of [
    [http, ["request", "get"]],
    [https, ["request", "get"]],
    [net, ["connect", "createConnection"]],
    [tls, ["connect"]],
    [dns, ["lookup", "resolve", "resolve4"]],
    [childProcess, ["spawn", "exec", "execFile", "fork"]]
  ]) {
    for (const key of keys) block(object, key);
  }
  try {
    const h = harness({
      publishSequence: [{
        outcome: "provider_confirming",
        reconciliationReference: "synthetic-reconcile-001"
      }],
      statusSequence: [{
        outcome: "published",
        confirmedProviderReference: "synthetic-published-001"
      }]
    });
    const context = contextFor("synthetic-a");
    const { connectionId } = await connectAccount(h, context);
    const publicationId = uuid();
    const pending = await h.service.publishImage(context, {
      operationId: uuid(),
      publicationId,
      connectionId,
      image: { mediaId: "synthetic-media-001", mimeType: "image/jpeg" }
    });
    await h.service.getPublicationStatus(context, {
      operationId: uuid(),
      publicationId,
      providerReference: pending.reconciliationReference
    });
    await h.service.disconnect(context, {
      operationId: uuid(),
      connectionId
    });
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
    for (const [object, key, original] of originals.reverse()) {
      object[key] = original;
    }
  }
});

test("new product modules contain no network client or dynamic provider loader", () => {
  const files = [
    "src/social/connectors/contract.js",
    "src/social/connectors/errors.js",
    "src/social/connectors/registry.js",
    "src/social/connectors/service.js",
    "src/social/connectors/states.js",
    "tests/helpers/fake-social-connector.js"
  ];
  const forbidden = [
    /require\(["']node:https?["']\)/,
    /require\(["']node:net["']\)/,
    /require\(["']node:tls["']\)/,
    /require\(["']node:dns["']\)/,
    /\bfetch\s*\(/,
    /\baxios\b/,
    /require\s*\(\s*(?:provider|input|name)/
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${file} contains ${pattern}`);
    }
  }
});
