"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const {
  createConnectorContext
} = require("../src/social/connectors/contract");
const {
  SESSION_AUDIENCE,
  SESSION_ISSUER
} = require("../src/social/reauth");
const {
  CONTROLLED_GATE4_STAGING_ORIGIN,
  controlledGate4MediaReference
} = require("../src/social/publication/controlled-gate4-jpeg");
const {
  INSTAGRAM_GATE4_CAPTION,
  canonicalPermalink,
  confirmedReference,
  createInstagramPublicationConnector,
  parseConfirmedReference
} = require("../src/social/publication/instagram-publication-connector");

const IDS = Object.freeze({
  connection: "41000000-0000-4000-8000-000000000001",
  credential: "41000000-0000-4000-8000-000000000002",
  publication: "41000000-0000-4000-8000-000000000003",
  operation: "41000000-0000-4000-8000-000000000004",
  reconcile: "41000000-0000-4000-8000-000000000005",
  correlation: "41000000-0000-4000-8000-000000000006",
  audit: "41000000-0000-4000-8000-000000000007"
});
const ACCOUNT_ID = "17841498765432109";
const CONTAINER_ID = "17911111111111111";
const MEDIA_ID = "17922222222222222";
const PERMALINK = "https://www.instagram.com/p/IA4TubeGate4/";
const PROVIDER_TIMESTAMP = "2027-01-15T08:00:00.000Z";
const TOKEN = "synthetic-gate4-token-never-log";
const CONTROLLED_ACCOUNT = Object.freeze({
  externalId: ACCOUNT_ID,
  username: "ia4tube_empresas",
  displayName: "IA4Tube Empresas",
  accountType: "business"
});
const CONTROLLED_MEDIA_REFERENCE = controlledGate4MediaReference(
  CONTROLLED_ACCOUNT
);
const identityConfig = Object.freeze({
  namespaceUuid: "41cb8c58-0bf4-4bd9-83b2-3f2f96dfe29f",
  key: Buffer.alloc(32, 71),
  derivationVersion: "social-id-v1"
});

function principalFor(legacyId) {
  return createSocialAuthAdapter(identityConfig).fromVerifiedJwt({
    token_version: 2,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    jti: `synthetic-gate4-jti-${legacyId}-00001`,
    sub: legacyId,
    whatsapp: legacyId,
    company_id: legacyId
  });
}

function contextFor(principal) {
  return createConnectorContext({
    principal,
    provider: "instagram",
    environment: "staging",
    correlationId: IDS.correlation,
    auditEventId: IDS.audit
  });
}

function jsonResponse(body, status = 200) {
  return Object.freeze({
    status,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: JSON.stringify(body)
  });
}

function harness(transport, overrides = {}) {
  const principal = principalFor(overrides.legacyId || "gate4-company-a");
  const context = contextFor(principal);
  let publication = overrides.publication || null;
  const issuedBuffers = [];
  let credentialCalls = 0;
  let mediaCalls = 0;
  const connection = Object.freeze({
    companyId: principal.companyId,
    id: IDS.connection,
    provider: "instagram",
    state: "connected",
    account: CONTROLLED_ACCOUNT,
    revision: 4,
    createdAt: new Date("2026-08-27T20:00:00.000Z"),
    connectedAt: new Date("2026-08-27T20:01:00.000Z"),
    updatedAt: new Date("2026-08-27T20:01:00.000Z"),
    disconnectedAt: null,
    expiresAt: new Date("2026-10-27T20:01:00.000Z"),
    health: "healthy",
    grantedScopes: Object.freeze([
      "instagram_business_basic",
      "instagram_business_content_publish"
    ]),
    activeCredentialId: IDS.credential
  });
  const store = Object.freeze({
    scope() {
      return Object.freeze({
        async getConnectionDetails(id) {
          return id === IDS.connection ? connection : null;
        },
        async getPublicationDetails(id) {
          return id === IDS.publication ? publication : null;
        }
      });
    }
  });
  const credentials = Object.freeze({
    async withDecryptedCredential(input, operation) {
      assert.deepEqual(input, {
        companyId: principal.companyId,
        credentialId: IDS.credential
      });
      credentialCalls += 1;
      const token = Buffer.from(TOKEN);
      issuedBuffers.push(token);
      try {
        return await operation(token);
      } finally {
        token.fill(0);
      }
    }
  });
  const media = Object.freeze({
    async resolveOwnedJpeg(observed, mediaId) {
      mediaCalls += 1;
      assert.equal(observed.companyId, principal.companyId);
      assert.equal(mediaId, CONTROLLED_MEDIA_REFERENCE);
      return Object.freeze({
        companyId: principal.companyId,
        mediaId,
        mimeType: "image/jpeg",
        publicUrl: `${CONTROLLED_GATE4_STAGING_ORIGIN}/social/gate4/approved.jpg`
      });
    }
  });
  const connector = createInstagramPublicationConnector({
    config: Object.freeze({
      provider: "instagram",
      graphApiVersion: "v25.0",
      publicOrigin: CONTROLLED_GATE4_STAGING_ORIGIN
    }),
    store,
    credentials,
    media,
    transport,
    expectedCompanyId: principal.companyId,
    expectedUserId: principal.userId,
    timeoutMs: overrides.timeoutMs ?? 100,
    pollAttempts: overrides.pollAttempts ?? 1,
    pollIntervalMs: 0,
    sleep: async () => {},
    clock: () => 1_800_000_000_000
  });
  return Object.freeze({
    connection,
    connector,
    context,
    counters() {
      return Object.freeze({ credentialCalls, mediaCalls });
    },
    issuedBuffers,
    setPublication(value) { publication = value; }
  });
}

function publishInput() {
  return Object.freeze({
    publicationId: IDS.publication,
    connectionId: IDS.connection,
    image: Object.freeze({
      mediaId: CONTROLLED_MEDIA_REFERENCE,
      mimeType: "image/jpeg"
    }),
    caption: INSTAGRAM_GATE4_CAPTION,
    idempotencyKey: IDS.operation
  });
}

test("confirmed Instagram references round-trip Media ID and canonical permalink", () => {
  const reference = confirmedReference(
    MEDIA_ID,
    PERMALINK,
    () => 1_800_000_000_000
  );
  assert.deepEqual(parseConfirmedReference(reference), {
    mediaId: MEDIA_ID,
    permalink: PERMALINK,
    publishedEpochSeconds: 1_800_000_000
  });
  assert.equal(canonicalPermalink(PERMALINK), PERMALINK);
  for (const invalid of [
    "http://www.instagram.com/p/IA4TubeGate4/",
    "https://instagram.com/p/IA4TubeGate4/",
    "https://www.instagram.com/reel/IA4TubeGate4/",
    `${PERMALINK}?access_token=forbidden`
  ]) {
    assert.throws(() => canonicalPermalink(invalid));
  }
});

test("controlled JPEG publication performs one container and one publish mutation", async () => {
  const calls = [];
  const h = harness(async (url, options) => {
    calls.push({ url, options });
    if (options.method === "POST" && url.endsWith(`/${ACCOUNT_ID}/media`)) {
      return jsonResponse({ id: CONTAINER_ID });
    }
    if (options.method === "GET" && url.includes(`/${CONTAINER_ID}?`)) {
      return jsonResponse({ id: CONTAINER_ID, status_code: "FINISHED" });
    }
    if (options.method === "POST" && url.endsWith(`/${ACCOUNT_ID}/media_publish`)) {
      return jsonResponse({ id: MEDIA_ID });
    }
    if (options.method === "GET" && url.includes(`/${MEDIA_ID}?`)) {
      return jsonResponse({
        id: MEDIA_ID,
        permalink: PERMALINK,
        timestamp: PROVIDER_TIMESTAMP
      });
    }
    throw new Error("unexpected synthetic request");
  });
  const result = await h.connector.publishImage(h.context, publishInput());
  assert.equal(result.outcome, "published");
  assert.equal(
    parseConfirmedReference(result.confirmedProviderReference).mediaId,
    MEDIA_ID
  );
  assert.equal(
    parseConfirmedReference(result.confirmedProviderReference)
      .publishedEpochSeconds,
    Math.floor(new Date(PROVIDER_TIMESTAMP).getTime() / 1000)
  );
  assert.equal(
    calls.filter((call) => call.options.method === "POST" &&
      call.url.endsWith(`/${ACCOUNT_ID}/media`)).length,
    1
  );
  assert.equal(
    calls.filter((call) => call.options.method === "POST" &&
      call.url.endsWith(`/${ACCOUNT_ID}/media_publish`)).length,
    1
  );
  for (const call of calls) {
    assert.equal(call.url.includes(TOKEN), false);
    assert.equal(String(call.options.body || "").includes(TOKEN), false);
    assert.equal(call.options.headers.authorization, `Bearer ${TOKEN}`);
  }
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(h.issuedBuffers.every((buffer) => buffer.every((byte) => byte === 0)), true);
  assert.deepEqual(h.counters(), { credentialCalls: 1, mediaCalls: 1 });
});

test("ambiguous media_publish persists a submitted reference and reconciliation never republishes", async () => {
  const calls = [];
  let timeoutPublish = true;
  const h = harness(async (url, options) => {
    calls.push({ url, method: options.method });
    if (options.method === "POST" && url.endsWith(`/${ACCOUNT_ID}/media`)) {
      return jsonResponse({ id: CONTAINER_ID });
    }
    if (options.method === "GET" && url.includes(`/${CONTAINER_ID}?`)) {
      return jsonResponse({ status_code: "FINISHED" });
    }
    if (options.method === "POST" && url.endsWith(`/${ACCOUNT_ID}/media_publish`)) {
      if (timeoutPublish) return new Promise(() => {});
      throw new Error("media_publish must never be called again");
    }
    if (options.method === "GET" && url.includes(`/${ACCOUNT_ID}/media?`)) {
      return jsonResponse({ data: [{
        id: MEDIA_ID,
        caption: INSTAGRAM_GATE4_CAPTION,
        permalink: PERMALINK,
        timestamp: PROVIDER_TIMESTAMP
      }] });
    }
    throw new Error("unexpected synthetic request");
  }, { timeoutMs: 10 });
  const pending = await h.connector.publishImage(h.context, publishInput());
  assert.equal(pending.outcome, "provider_confirming");
  assert.equal(pending.reconciliationReference, `igc:submitted:${CONTAINER_ID}`);
  timeoutPublish = false;
  h.setPublication(Object.freeze({
    companyId: h.context.companyId,
    id: IDS.publication,
    connectionId: IDS.connection,
    provider: "instagram",
    state: "provider_confirming",
    confirmedProviderReference: null,
    reconciliationReference: pending.reconciliationReference,
    errorCode: null,
    revision: 3,
    mediaReference: CONTROLLED_MEDIA_REFERENCE,
    mediaMetadataDigest: "a".repeat(64),
    caption: INSTAGRAM_GATE4_CAPTION,
    publishedAt: null,
    createdAt: new Date("2027-01-15T07:59:00.000Z"),
    updatedAt: new Date("2027-01-15T07:59:01.000Z"),
    attempts: Object.freeze([])
  }));
  const reconciled = await h.connector.getPublicationStatus(h.context, {
    publicationId: IDS.publication,
    providerReference: pending.reconciliationReference,
    idempotencyKey: IDS.reconcile
  });
  assert.equal(reconciled.outcome, "published");
  assert.equal(
    parseConfirmedReference(reconciled.confirmedProviderReference).mediaId,
    MEDIA_ID
  );
  assert.equal(
    calls.filter((call) => call.method === "POST" &&
      call.url.endsWith(`/${ACCOUNT_ID}/media_publish`)).length,
    1
  );
});

test("another tenant is refused before media, vault or provider access", async () => {
  const principalA = principalFor("gate4-company-a");
  const principalB = principalFor("gate4-company-b");
  let externalCalls = 0;
  const base = harness(async () => {
    externalCalls += 1;
    return jsonResponse({});
  });
  const connector = createInstagramPublicationConnector({
    config: Object.freeze({
      provider: "instagram",
      graphApiVersion: "v25.0",
      publicOrigin: CONTROLLED_GATE4_STAGING_ORIGIN
    }),
    store: { scope() { throw new Error("store must not be reached"); } },
    credentials: {
      async withDecryptedCredential() {
        throw new Error("vault must not be reached");
      }
    },
    media: {
      async resolveOwnedJpeg() {
        throw new Error("media must not be reached");
      }
    },
    transport: async () => {
      externalCalls += 1;
      return jsonResponse({});
    },
    expectedCompanyId: principalA.companyId,
    expectedUserId: principalA.userId
  });
  await assert.rejects(
    connector.publishImage(contextFor(principalB), publishInput()),
    { code: "external_capability_disabled" }
  );
  assert.equal(externalCalls, 0);
  assert.ok(base.context.companyId);
});
