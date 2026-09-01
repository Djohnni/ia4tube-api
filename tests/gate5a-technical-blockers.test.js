"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const {
  GATE5A_REVIEWER_LOGIN,
  GATE5A_STAGING_ORIGIN,
  createGate5aSyntheticReviewerResolver,
  deriveGate5aSyntheticIdentity
} = require("../scripts/social-gate5a-synthetic-bridge");

const CLIENT_REQUEST_ID = "gate5a-reviewer-manual-publish-v1";
const FIXED_DATE = new Date("2026-09-01T12:00:00.000Z");
const TRUSTED_CONTENT = Object.freeze({
  caption: "CONTEUDO DEMO — NAO PUBLICAR",
  mediaReference: `gate5a-content:${"c".repeat(64)}:${"d".repeat(32)}`
});
const DIFFERENT_TRUSTED_CONTENT = Object.freeze({
  caption: "OUTRO CONTEUDO DEMO — NAO PUBLICAR",
  mediaReference: `gate5a-content:${"e".repeat(64)}:${"f".repeat(32)}`
});

function bridgeEnvironment() {
  return {
    ENVIRONMENT: "staging",
    PUBLIC_API_BASE_URL: GATE5A_STAGING_ORIGIN,
    REVIEW_SANDBOX_ENABLED: "true",
    SYNTHETIC_PROVIDER_ENABLED: "true",
    SOCIAL_IDENTITY_DERIVATION_KEY: Buffer.alloc(32, 7).toString("base64"),
    SOCIAL_TENANT_NAMESPACE_UUID: "41cb8c58-0bf4-4bd9-83b2-3f2f96dfe29f",
    SOCIAL_IDENTITY_DERIVATION_VERSION: "social-id-v1",
    SOCIAL_INSTAGRAM_ENABLED: "true",
    SOCIAL_EXTERNAL_CONNECTION_ENABLED: "true",
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false",
    INSTAGRAM_APP_ID: "1234567890",
    INSTAGRAM_APP_SECRET: "synthetic-app-secret-for-tests-0001",
    INSTAGRAM_OAUTH_REDIRECT_URI:
      `${GATE5A_STAGING_ORIGIN}/v1/social/oauth/callback`,
    INSTAGRAM_GRAPH_API_VERSION: "v25.0"
  };
}

function copy(value) {
  return value === null || value === undefined
    ? value
    : structuredClone(value);
}

function persistentStore(identity) {
  let publication = null;
  let idempotencyStatus = null;
  let idempotencyDigest = null;

  function scoped(context) {
    const methods = {
      async runExclusive(operation) {
        return operation(methods);
      },
      async getConnectionDetails(connectionId) {
        assert.equal(connectionId, identity.connectionId);
        return {
          companyId: context.companyId,
          id: identity.connectionId,
          provider: "instagram",
          state: "connected"
        };
      },
      async getPublicationDetails(publicationId) {
        return publication?.id === publicationId ? copy(publication) : null;
      },
      async beginIdempotency(record) {
        if (publication) {
          if (record.digest !== idempotencyDigest) {
            throw Object.assign(new Error("idempotency conflict"), {
              code: "idempotency_conflict"
            });
          }
          return { status: idempotencyStatus || "pending" };
        }
        const image = record.payload.image;
        publication = {
          companyId: context.companyId,
          id: record.payload.publicationId,
          connectionId: record.payload.connectionId,
          provider: "instagram",
          state: "ready",
          confirmedProviderReference: null,
          reconciliationReference: null,
          errorCode: null,
          revision: 1,
          mediaReference: image.mediaId,
          mediaMetadataDigest: crypto
            .createHash("sha256")
            .update(JSON.stringify({
              mediaId: image.mediaId,
              mimeType: image.mimeType
            }), "utf8")
            .digest("hex"),
          caption: record.payload.caption,
          idempotencyKey: record.operationId,
          requestHash: record.digest,
          publishedAt: null,
          createdAt: new Date(FIXED_DATE),
          updatedAt: new Date(FIXED_DATE),
          attempts: []
        };
        idempotencyStatus = "pending";
        idempotencyDigest = record.digest;
        return { status: "acquired" };
      },
      async savePublication(record, expectedRevision) {
        assert.equal(publication.revision, expectedRevision);
        assert.equal(record.revision, expectedRevision + 1);
        publication = {
          ...publication,
          ...copy(record),
          publishedAt: record.state === "published"
            ? new Date(FIXED_DATE)
            : null,
          createdAt: new Date(FIXED_DATE),
          updatedAt: new Date(FIXED_DATE),
          attempts: publication.attempts
        };
        if (record.state === "publishing") {
          publication.attempts = [{
            attemptNumber: 1,
            state: "started",
            errorCode: null,
            providerReference: null,
            startedAt: new Date(FIXED_DATE),
            finishedAt: null,
            durationMs: null
          }];
        } else if (record.state === "provider_confirming") {
          publication.attempts[0] = {
            ...publication.attempts[0],
            state: "provider_confirming",
            finishedAt: new Date(FIXED_DATE),
            durationMs: 0
          };
        } else if (record.state === "published") {
          publication.attempts[0] = {
            ...publication.attempts[0],
            state: "published",
            providerReference: record.confirmedProviderReference,
            finishedAt: new Date(FIXED_DATE),
            durationMs: 0
          };
        }
        return copy(publication);
      },
      async completeIdempotency(record) {
        assert.equal(record.result.state, "published");
        idempotencyStatus = "completed";
        return { status: "completed" };
      }
    };
    return methods;
  }

  return {
    scope: scoped,
    snapshot() {
      return copy(publication);
    }
  };
}

test("canonical schema facade persists one synthetic history across resolver restart", async () => {
  const env = bridgeEnvironment();
  const identity = deriveGate5aSyntheticIdentity(env);
  const identityKey = Buffer.from(env.SOCIAL_IDENTITY_DERIVATION_KEY, "base64");
  const auth = createSocialAuthAdapter({
    namespaceUuid: env.SOCIAL_TENANT_NAMESPACE_UUID,
    derivationVersion: env.SOCIAL_IDENTITY_DERIVATION_VERSION,
    key: identityKey
  });
  const store = persistentStore(identity);
  const runtime = {
    enabled: true,
    auth,
    connectorPersistence: { store },
    instagramOAuth: {},
    metaCompliance: {}
  };
  const claims = Object.freeze({
    token_version: 2,
    iss: "ia4tube-api",
    aud: "ia4tube-client",
    jti: "gate5a-reviewer-session-0001",
    sub: GATE5A_REVIEWER_LOGIN,
    whatsapp: GATE5A_REVIEWER_LOGIN,
    company_id: GATE5A_REVIEWER_LOGIN
  });
  const context = Object.freeze({
    tenantId: GATE5A_REVIEWER_LOGIN,
    principalId: GATE5A_REVIEWER_LOGIN,
    role: "owner",
    companyName: "Sabor da Vila Hamburgueria — DEMO",
    verifiedClaims: claims
  });
  const resolver = createGate5aSyntheticReviewerResolver({
    env,
    getRuntime: () => runtime
  });

  await assert.rejects(
    resolver.publishPublication(
      context,
      { clientRequestId: CLIENT_REQUEST_ID },
      {
        caption: TRUSTED_CONTENT.caption,
        mediaReference: "client-controlled-reference"
      }
    ),
    (error) => error.code === "gate5a_synthetic_history_content_invalid"
  );
  const sending = await resolver.publishPublication(
    context,
    { clientRequestId: CLIENT_REQUEST_ID },
    TRUSTED_CONTENT
  );
  assert.equal(sending.idempotentReplay, false);
  assert.equal(sending.publication.state, "sending");
  assert.equal(sending.publication.attempts, 1);
  const publicationId = sending.publication.publicationId;

  await assert.rejects(
    resolver.publishPublication(
      context,
      { clientRequestId: CLIENT_REQUEST_ID },
      DIFFERENT_TRUSTED_CONTENT
    ),
    (error) => error.code === "idempotency_conflict"
  );
  assert.equal(store.snapshot().mediaReference, TRUSTED_CONTENT.mediaReference);
  assert.equal(store.snapshot().caption, TRUSTED_CONTENT.caption);

  const replay = await resolver.publishPublication(
    context,
    { clientRequestId: CLIENT_REQUEST_ID },
    TRUSTED_CONTENT
  );
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.publication.publicationId, publicationId);

  const confirming = await resolver.advancePublication(context, publicationId);
  assert.equal(confirming.publication.state, "provider_confirming");
  const published = await resolver.advancePublication(context, publicationId);
  assert.equal(published.publication.state, "published");
  assert.match(published.publication.mediaId, /^synthetic-media-/);
  assert.match(published.publication.reference, /^synthetic-review:/);
  assert.equal(published.publication.publishedAt, FIXED_DATE.toISOString());
  assert.equal(published.publications.length, 1);

  const restartedResolver = createGate5aSyntheticReviewerResolver({
    env,
    getRuntime: () => runtime
  });
  const afterRestart = await restartedResolver.readPublicationHistory(context);
  assert.deepEqual(afterRestart.publications, published.publications);
  assert.equal(store.snapshot().connectionId, identity.connectionId);
  assert.equal(store.snapshot().mediaReference, TRUSTED_CONTENT.mediaReference);
  assert.equal(store.snapshot().caption, TRUSTED_CONTENT.caption);
  assert.equal(store.snapshot().state, "published");
  assert.equal(store.snapshot().attempts.length, 1);
  assert.equal(store.snapshot().attempts[0].state, "published");
  identityKey.fill(0);
});
