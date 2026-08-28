"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const { connectorFail } = require("../src/social/connectors/errors");
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
  confirmedReference
} = require("../src/social/publication/instagram-publication-connector");
const {
  createInstagramPublicationService
} = require("../src/social/publication/instagram-publication-service");

const IDS = Object.freeze({
  connection: "42000000-0000-4000-8000-000000000001",
  credential: "42000000-0000-4000-8000-000000000002"
});
const PROVIDER_MEDIA_ID = "17933333333333333";
const PROVIDER_PERMALINK = "https://www.instagram.com/p/IA4TubeGate4Service/";
const PROVIDER_PUBLISHED_AT = "2027-01-15T08:00:00.000Z";
const DATABASE_PUBLISHED_AT = new Date("2027-01-15T08:00:09.000Z");
const SNAPSHOT_CREATED_AT = new Date("2027-01-15T07:59:58.000Z");
const SNAPSHOT_UPDATED_AT = new Date("2027-01-15T07:59:59.000Z");
const ACCOUNT = Object.freeze({
  externalId: "17841498765432109",
  username: "ia4tube_empresas",
  displayName: "IA4Tube Empresas",
  accountType: "business"
});
const MEDIA_REFERENCE = controlledGate4MediaReference(ACCOUNT);
const IDENTITY_CONFIG = Object.freeze({
  namespaceUuid: "41cb8c58-0bf4-4bd9-83b2-3f2f96dfe29f",
  key: Buffer.alloc(32, 72),
  derivationVersion: "social-id-v1"
});

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function sha256Json(value) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function claimsFor(legacyId) {
  return Object.freeze({
    token_version: 2,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    jti: `synthetic-gate4-service-${legacyId}-00001`,
    sub: legacyId,
    whatsapp: legacyId,
    company_id: legacyId
  });
}

function createStore(connection) {
  const publications = new Map();
  const idempotency = new Map();
  const transitions = [];

  function ensureTenant(context) {
    if (
      context.companyId !== connection.companyId ||
      context.provider !== "instagram"
    ) {
      connectorFail("resource_unavailable");
    }
  }

  function createScope(context) {
    ensureTenant(context);
    const methods = {
      async getConnection(id) {
        return id === connection.id ? copy(connection) : null;
      },
      async getConnectionDetails(id) {
        return id === connection.id ? copy(connection) : null;
      },
      async getCurrentConnectionDetails() {
        return copy(connection);
      },
      async findBlockingConnection() {
        return null;
      },
      async saveConnection() {
        throw new Error("unexpected synthetic connection mutation");
      },
      async activateConnectionFromAuthorization() {
        throw new Error("unexpected synthetic connection activation");
      },
      async ensureDisconnected() {
        throw new Error("unexpected synthetic disconnect");
      },
      async getPublication(id) {
        return copy(publications.get(id) || null);
      },
      async getPublicationDetails(id) {
        return copy(publications.get(id) || null);
      },
      async getPublicationSnapshot(id, connectionId) {
        assert.equal(connectionId, connection.id);
        return Object.freeze({
          publication: copy(publications.get(id) || null),
          publicationCount: [...publications.values()].filter(
            (publication) =>
              publication.connectionId === connectionId &&
              publication.state === "published"
          ).length
        });
      },
      async countPublishedPublications(connectionId) {
        return [...publications.values()].filter(
          (publication) =>
            publication.connectionId === connectionId &&
            publication.state === "published"
        ).length;
      },
      async savePublication(record, expectedRevision) {
        const current = publications.get(record.id) || null;
        if (
          !current ||
          current.revision !== expectedRevision ||
          record.revision !== expectedRevision + 1
        ) {
          connectorFail("state_transition_invalid");
        }
        const next = {
          ...current,
          ...copy(record),
          updatedAt: new Date(SNAPSHOT_UPDATED_AT.getTime() + record.revision)
        };
        if (record.state === "publishing") {
          next.attempts = [{
            attemptNumber: 1,
            state: "started",
            errorCode: null,
            providerReference: null,
            startedAt: SNAPSHOT_UPDATED_AT,
            finishedAt: null,
            durationMs: null
          }];
        } else if (record.state === "published") {
          next.publishedAt = DATABASE_PUBLISHED_AT;
          next.attempts = [{
            ...next.attempts[0],
            state: "published",
            providerReference: record.confirmedProviderReference,
            finishedAt: DATABASE_PUBLISHED_AT,
            durationMs: 10_000
          }];
        }
        publications.set(record.id, copy(next));
        transitions.push(record.state);
        return copy(next);
      },
      async beginIdempotency(record) {
        const key = `${record.capability}:${record.operationId}`;
        const existing = idempotency.get(key);
        if (existing) {
          if (existing.digest !== record.digest) {
            connectorFail("idempotency_conflict");
          }
          return existing.status === "completed"
            ? copy({
              status: "completed",
              result: existing.result,
              errorCode: existing.errorCode
            })
            : { status: "pending" };
        }
        idempotency.set(key, {
          digest: record.digest,
          status: "pending",
          result: null,
          errorCode: null
        });
        if (record.capability === "publishImage") {
          const payload = record.payload;
          publications.set(payload.publicationId, {
            companyId: context.companyId,
            id: payload.publicationId,
            connectionId: payload.connectionId,
            provider: context.provider,
            mediaReference: payload.image.mediaId,
            mediaMetadataDigest: sha256Json(payload.image),
            caption: payload.caption,
            state: "ready",
            confirmedProviderReference: null,
            reconciliationReference: null,
            errorCode: null,
            publishedAt: null,
            createdAt: SNAPSHOT_CREATED_AT,
            updatedAt: SNAPSHOT_CREATED_AT,
            revision: 1,
            idempotencyKey: record.operationId,
            requestHash: record.digest,
            attempts: []
          });
          transitions.push("ready");
        }
        return { status: "acquired" };
      },
      async completeIdempotency(record) {
        const key = `${record.capability}:${record.operationId}`;
        const existing = idempotency.get(key);
        if (!existing || existing.digest !== record.digest) {
          connectorFail("idempotency_conflict");
        }
        idempotency.set(key, {
          digest: record.digest,
          status: "completed",
          result: copy(record.result),
          errorCode: record.errorCode
        });
      },
      async runExclusive(operation) {
        return operation(methods);
      }
    };
    return Object.freeze(methods);
  }

  return Object.freeze({
    scope: createScope,
    snapshot() {
      return Object.freeze({
        idempotencyCount: idempotency.size,
        publications: copy([...publications.values()]),
        transitions: Object.freeze([...transitions])
      });
    }
  });
}

function createHarness({ publicationEnabled = true } = {}) {
  const authAdapter = createSocialAuthAdapter(IDENTITY_CONFIG);
  const verifiedClaims = claimsFor("gate4-service-company");
  const principal = authAdapter.fromVerifiedJwt(verifiedClaims);
  const connection = Object.freeze({
    companyId: principal.companyId,
    id: IDS.connection,
    provider: "instagram",
    state: "connected",
    account: ACCOUNT,
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
  const store = createStore(connection);
  let providerPublishCalls = 0;
  let mediaResolveCalls = 0;
  let now = new Date("2027-01-15T07:59:00.000Z").getTime();
  let service;
  let windowStateObservedDuringProvider = null;
  const publicationConnector = Object.freeze({
    provider: "instagram",
    capabilities: Object.freeze(["publishImage", "getPublicationStatus"]),
    external: true,
    synthetic: false,
    testOnly: false,
    async publishImage(context, input) {
      providerPublishCalls += 1;
      assert.equal(context.companyId, principal.companyId);
      assert.equal(input.connectionId, IDS.connection);
      assert.equal(input.image.mediaId, MEDIA_REFERENCE);
      assert.equal(input.caption, INSTAGRAM_GATE4_CAPTION);
      windowStateObservedDuringProvider = (
        await service.getSummary({ verifiedClaims })
      ).externalPublicationEnabled;
      return Object.freeze({
        outcome: "published",
        confirmedProviderReference: confirmedReference(
          PROVIDER_MEDIA_ID,
          PROVIDER_PERMALINK,
          () => new Date(PROVIDER_PUBLISHED_AT).getTime()
        )
      });
    },
    async getPublicationStatus() {
      throw new Error("unexpected synthetic reconciliation");
    }
  });
  const auditEvents = [];
  service = createInstagramPublicationService({
    config: Object.freeze({
      provider: "instagram",
      publicOrigin: CONTROLLED_GATE4_STAGING_ORIGIN,
      expectedUsername: "ia4tube_empresas",
      externalConnectionEnabled: true,
      externalPublicationEnabled: publicationEnabled
    }),
    authAdapter,
    connectorStore: store,
    connectorAudit: Object.freeze({
      async append(_context, event) {
        auditEvents.push(copy(event));
      }
    }),
    credentials: Object.freeze({
      async withDecryptedCredential() {
        throw new Error("fake provider must not read a credential");
      }
    }),
    media: Object.freeze({
      async resolveOwnedJpeg(context, mediaId) {
        mediaResolveCalls += 1;
        assert.equal(context.companyId, principal.companyId);
        assert.equal(mediaId, MEDIA_REFERENCE);
        return Object.freeze({
          companyId: principal.companyId,
          mediaId,
          mimeType: "image/jpeg"
        });
      }
    }),
    publicationConnector,
    clock: () => now,
    expectedCompanyId: principal.companyId,
    expectedUserId: principal.userId
  });
  return Object.freeze({
    auditEvents,
    counters() {
      return Object.freeze({ mediaResolveCalls, providerPublishCalls });
    },
    advance(milliseconds) {
      now += milliseconds;
    },
    service,
    store,
    verifiedClaims,
    windowStateObservedDuringProvider() {
      return windowStateObservedDuringProvider;
    }
  });
}

test("Gate 4 service creates one immutable intent and returns it on repetition", async () => {
  const harness = createHarness();
  const before = await harness.service.getSummary({
    verifiedClaims: harness.verifiedClaims
  });
  assert.equal(before.publication, null);
  assert.equal(before.publicationCount, 0);
  assert.equal(before.externalPublicationEnabled, false);
  await assert.rejects(
    harness.service.publish({ verifiedClaims: harness.verifiedClaims }),
    { code: "external_capability_disabled" }
  );
  const armed = await harness.service.arm({
    verifiedClaims: harness.verifiedClaims
  });
  assert.equal(armed.externalPublicationEnabled, true);
  assert.equal(armed.publication, null);

  const first = await harness.service.publish({
    verifiedClaims: harness.verifiedClaims
  });
  const repeated = await harness.service.publish({
    verifiedClaims: harness.verifiedClaims
  });

  assert.deepEqual(repeated, first);
  assert.equal(first.publication.state, "published");
  assert.equal(first.publication.providerMediaId, PROVIDER_MEDIA_ID);
  assert.equal(first.publication.permalink, PROVIDER_PERMALINK);
  assert.equal(first.publication.publishedAt, PROVIDER_PUBLISHED_AT);
  assert.notEqual(
    first.publication.publishedAt,
    DATABASE_PUBLISHED_AT.toISOString(),
    "the public timestamp must come from the provider confirmation"
  );
  assert.equal(first.publicationCount, 1);
  assert.equal(first.externalPublicationEnabled, false);
  assert.equal(first.publication.attempts.length, 1);
  assert.equal(first.publication.attempts[0].state, "published");

  const persisted = harness.store.snapshot();
  assert.equal(persisted.publications.length, 1);
  assert.equal(persisted.idempotencyCount, 1);
  assert.deepEqual(persisted.transitions, ["ready", "publishing", "published"]);
  assert.equal(persisted.publications[0].mediaReference, MEDIA_REFERENCE);
  assert.equal(persisted.publications[0].caption, INSTAGRAM_GATE4_CAPTION);
  assert.match(persisted.publications[0].mediaMetadataDigest, /^[0-9a-f]{64}$/);
  assert.match(persisted.publications[0].requestHash, /^[0-9a-f]{64}$/);
  assert.equal(first.publication.publicationId, repeated.publication.publicationId);
  assert.deepEqual(harness.counters(), {
    mediaResolveCalls: 1,
    providerPublishCalls: 1
  });
  assert.equal(harness.windowStateObservedDuringProvider(), false);
  await assert.rejects(
    harness.service.arm({ verifiedClaims: harness.verifiedClaims }),
    { code: "state_transition_invalid" }
  );
});

test("Gate 4 concurrent requests consume one arm and call the provider once", async () => {
  const harness = createHarness();
  await harness.service.arm({ verifiedClaims: harness.verifiedClaims });
  const results = await Promise.allSettled([
    harness.service.publish({ verifiedClaims: harness.verifiedClaims }),
    harness.service.publish({ verifiedClaims: harness.verifiedClaims })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected?.reason?.code, "external_capability_disabled");
  assert.deepEqual(harness.counters(), {
    mediaResolveCalls: 1,
    providerPublishCalls: 1
  });
  assert.equal(harness.store.snapshot().publications.length, 1);
});

test("Gate 4 service starts read-only with publication flag false", async () => {
  const harness = createHarness({ publicationEnabled: false });
  const summary = await harness.service.getSummary({
    verifiedClaims: harness.verifiedClaims
  });
  assert.equal(summary.externalPublicationEnabled, false);
  assert.equal(summary.publication, null);
  assert.equal(summary.publicationCount, 0);
  await assert.rejects(
    harness.service.arm({ verifiedClaims: harness.verifiedClaims }),
    { code: "external_capability_disabled" }
  );
  await assert.rejects(
    harness.service.publish({ verifiedClaims: harness.verifiedClaims }),
    { code: "external_capability_disabled" }
  );
  assert.deepEqual(harness.counters(), {
    mediaResolveCalls: 0,
    providerPublishCalls: 0
  });
  assert.equal(harness.store.snapshot().publications.length, 0);
});

test("Gate 4 one-shot arm expires without provider access", async () => {
  const harness = createHarness();
  const armed = await harness.service.arm({
    verifiedClaims: harness.verifiedClaims
  });
  assert.equal(armed.externalPublicationEnabled, true);
  harness.advance(5 * 60 * 1000);
  await assert.rejects(
    harness.service.publish({ verifiedClaims: harness.verifiedClaims }),
    { code: "external_capability_disabled" }
  );
  const expired = await harness.service.getSummary({
    verifiedClaims: harness.verifiedClaims
  });
  assert.equal(expired.externalPublicationEnabled, false);
  assert.equal(expired.publication, null);
  assert.deepEqual(harness.counters(), {
    mediaResolveCalls: 0,
    providerPublishCalls: 0
  });
});

test("Gate 4 service rejects another authenticated tenant before provider access", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.service.arm({
      verifiedClaims: claimsFor("gate4-service-company-b")
    }),
    { code: "external_capability_disabled" }
  );
  await assert.rejects(
    harness.service.publish({
      verifiedClaims: claimsFor("gate4-service-company-b")
    }),
    { code: "external_capability_disabled" }
  );
  assert.deepEqual(harness.counters(), {
    mediaResolveCalls: 0,
    providerPublishCalls: 0
  });
  assert.equal(harness.store.snapshot().publications.length, 0);
});
