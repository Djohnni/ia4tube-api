"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const express = require("express");

const reviewerUi = require("../gate5a-reviewer-flow");
const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const {
  createConnectorContext
} = require("../src/social/connectors/contract");
const {
  createInstagramOAuthVisualReturn
} = require("../src/social/oauth/instagram-oauth-visual-return");
const {
  confirmedReference,
  createInstagramPublicationConnector,
  parseConfirmedReference
} = require("../src/social/publication/instagram-publication-connector");
const {
  SESSION_AUDIENCE,
  SESSION_ISSUER
} = require("../src/social/reauth");
const {
  REAL_REVIEWER_CONTENT_SECURITY_POLICY,
  REAL_REVIEWER_STAGING_ORIGIN,
  createInstagramRealReviewerRouter,
  createInstagramRealReviewerService,
  deterministicUuid,
  isRealReviewerLoginHandoffUrl,
  reviewerCaptionMarker,
  reviewerMediaIdentity,
  reviewerPublishedCandidateAuthorized,
  realReviewerUiGateState
} = require("../src/social/reviewer-real/reviewer-real");
const {
  initializeSocialServerRuntime
} = require("../src/social/server-runtime");

const IDENTITY_CONFIG = Object.freeze({
  namespaceUuid: "51cb8c58-0bf4-4bd9-83b2-3f2f96dfe29f",
  key: Buffer.alloc(32, 82),
  derivationVersion: "social-id-v1"
});
const IDS = Object.freeze({
  connectionA: "51000000-0000-4000-8000-000000000001",
  credentialA: "51000000-0000-4000-8000-000000000002",
  connectionB: "52000000-0000-4000-8000-000000000001",
  credentialB: "52000000-0000-4000-8000-000000000002"
});
const MEDIA_A = `reviewer-jpeg:${"a".repeat(64)}`;
const MEDIA_B = `reviewer-jpeg:${"b".repeat(64)}`;
const CAPTION_A = "Publicação manual da empresa A.\n#IA4Tube";
const CAPTION_B = "Publicação manual da empresa B.\n#IA4Tube";

function claims(owner) {
  return Object.freeze({
    token_version: 2,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    jti: `gate5-real-reviewer-${owner}-session-0001`,
    sub: owner,
    whatsapp: owner,
    company_id: owner
  });
}

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function jsonResponse(body, status = 200) {
  return Object.freeze({
    status,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: JSON.stringify(body)
  });
}

function capabilityUrl(mediaId, marker) {
  return `${REAL_REVIEWER_STAGING_ORIGIN}/v1/social/reviewer/` +
    `media-capability/${encodeURIComponent(mediaId)}/4102444800/` +
    `${marker.repeat(24)}/${marker.repeat(40)}/${marker.repeat(43)}`;
}

function createFixture() {
  const authAdapter = createSocialAuthAdapter(IDENTITY_CONFIG);
  const claimsA = claims("tenant-a");
  const claimsB = claims("tenant-b");
  const principalA = authAdapter.fromVerifiedJwt(claimsA);
  const principalB = authAdapter.fromVerifiedJwt(claimsB);
  const connections = new Map([
    [principalA.companyId, Object.freeze({
      companyId: principalA.companyId,
      id: IDS.connectionA,
      provider: "instagram",
      state: "connected",
      health: "healthy",
      account: Object.freeze({
        externalId: "17841400000000001",
        username: "empresa_controlada_a",
        displayName: "Empresa A",
        accountType: "business"
      }),
      activeCredentialId: IDS.credentialA,
      grantedScopes: Object.freeze([
        "instagram_business_basic",
        "instagram_business_content_publish"
      ]),
      revision: 1
    })],
    [principalB.companyId, Object.freeze({
      companyId: principalB.companyId,
      id: IDS.connectionB,
      provider: "instagram",
      state: "connected",
      health: "healthy",
      account: Object.freeze({
        externalId: "17841400000000002",
        username: "criador_controlado_b",
        displayName: "Empresa B",
        accountType: "creator"
      }),
      activeCredentialId: IDS.credentialB,
      grantedScopes: Object.freeze([
        "instagram_business_basic",
        "instagram_business_content_publish"
      ]),
      revision: 1
    })]
  ]);
  const publications = new Map();
  const mediaByOwner = new Map([
    ["tenant-a", Object.freeze({
      companyId: principalA.companyId,
      mediaId: MEDIA_A,
      mimeType: "image/jpeg",
      width: 1080,
      height: 1080,
      caption: CAPTION_A,
      publicUrl: capabilityUrl(MEDIA_A, "a"),
      thumbnailUrl: capabilityUrl(MEDIA_A, "a")
    })],
    ["tenant-b", Object.freeze({
      companyId: principalB.companyId,
      mediaId: MEDIA_B,
      mimeType: "image/jpeg",
      width: 1080,
      height: 1350,
      caption: CAPTION_B,
      publicUrl: capabilityUrl(MEDIA_B, "b"),
      thumbnailUrl: capabilityUrl(MEDIA_B, "b")
    })]
  ]);
  const calls = {
    publish: 0,
    reconcile: 0,
    externalMeta: 0,
    externalInstagram: 0,
    sandbox: 0
  };
  const connectorStore = Object.freeze({
    scope(context) {
      const connection = connections.get(context.companyId) || null;
      return Object.freeze({
        async getCurrentConnectionDetails() {
          return copy(connection);
        },
        async getConnectionDetails(id) {
          return connection?.id === id ? copy(connection) : null;
        },
        async getPublicationDetails(id) {
          const value = publications.get(`${context.companyId}:${id}`);
          return copy(value || null);
        }
      });
    }
  });
  const media = Object.freeze({
    async listOwnedJpegs({ context, owner }) {
      const value = mediaByOwner.get(owner);
      return value?.companyId === context.companyId ? [copy(value)] : [];
    },
    async resolveOwnedJpeg({ context, owner, mediaId }) {
      const value = mediaByOwner.get(owner);
      return value?.companyId === context.companyId && value.mediaId === mediaId
        ? copy(value)
        : null;
    }
  });
  let tick = 0;
  function nextDate() {
    tick += 1;
    return new Date(`2026-09-02T12:00:${String(tick).padStart(2, "0")}.000Z`);
  }
  const serviceOptions = Object.freeze({
    config: Object.freeze({
      provider: "instagram",
      publicOrigin: REAL_REVIEWER_STAGING_ORIGIN,
      externalConnectionEnabled: true,
      externalPublicationEnabled: true
    }),
    authAdapter,
    connectorStore,
    connectorAudit: Object.freeze({ async append() {} }),
    media,
    createPublicationConnector() {
      return Object.freeze({});
    },
    createConnectorService({ context, media: scopedMedia }) {
      return Object.freeze({
        async publishImage(receivedContext, input) {
          assert.equal(receivedContext, context);
          const owned = await scopedMedia.resolveOwnedJpeg(
            context,
            input.image.mediaId
          );
          assert.equal(owned.companyId, context.companyId);
          calls.publish += 1;
          const now = nextDate();
          publications.set(`${context.companyId}:${input.publicationId}`, {
            companyId: context.companyId,
            id: input.publicationId,
            connectionId: input.connectionId,
            provider: "instagram",
            state: "provider_confirming",
            confirmedProviderReference: null,
            reconciliationReference: "igc:created:17900000000000001",
            errorCode: null,
            mediaReference: input.image.mediaId,
            caption: input.caption,
            publishedAt: null,
            createdAt: now,
            updatedAt: now,
            revision: 3,
            attempts: [{
              attemptNumber: 1,
              state: "provider_confirming",
              errorCode: null,
              providerReference: "igc:created:17900000000000001",
              startedAt: now,
              finishedAt: now,
              durationMs: 15
            }]
          });
        },
        async getPublicationStatus(receivedContext, input) {
          assert.equal(receivedContext, context);
          calls.reconcile += 1;
          const key = `${context.companyId}:${input.publicationId}`;
          const current = publications.get(key);
          const publishedAt = nextDate();
          publications.set(key, {
            ...current,
            state: "published",
            confirmedProviderReference: confirmedReference(
              "17999999999999999",
              "https://www.instagram.com/p/IA4TubeReviewer/",
              () => publishedAt.getTime()
            ),
            reconciliationReference: null,
            publishedAt,
            updatedAt: publishedAt,
            revision: current.revision + 1,
            attempts: [{
              ...current.attempts[0],
              state: "published",
              providerReference: "17999999999999999",
              finishedAt: publishedAt
            }]
          });
        }
      });
    },
    randomUUID: (() => {
      let ordinal = 100;
      return () => `51000000-0000-4000-8000-${String(ordinal += 1).padStart(12, "0")}`;
    })()
  });
  return {
    calls,
    claimsA,
    claimsB,
    connections,
    mediaByOwner,
    principalA,
    principalB,
    publications,
    serviceOptions,
    createService: () => createInstagramRealReviewerService(serviceOptions)
  };
}

function createReconciliationHarness({ publication, transport }) {
  const authAdapter = createSocialAuthAdapter(IDENTITY_CONFIG);
  const principal = authAdapter.fromVerifiedJwt(claims("tenant-a"));
  const context = createConnectorContext({
    principal,
    provider: "instagram",
    environment: "staging",
    correlationId: "53000000-0000-4000-8000-000000000091",
    auditEventId: "53000000-0000-4000-8000-000000000092"
  });
  const counters = { credentials: 0, transport: 0 };
  const connection = Object.freeze({
    companyId: principal.companyId,
    id: IDS.connectionA,
    provider: "instagram",
    state: "connected",
    health: "healthy",
    account: Object.freeze({
      externalId: "17841400000000001",
      username: "empresa_controlada_a",
      displayName: "Empresa A",
      accountType: "business"
    }),
    activeCredentialId: IDS.credentialA,
    grantedScopes: Object.freeze([
      "instagram_business_basic",
      "instagram_business_content_publish"
    ]),
    revision: 1
  });
  const connector = createInstagramPublicationConnector({
    config: Object.freeze({
      provider: "instagram",
      graphApiVersion: "v25.0",
      publicOrigin: REAL_REVIEWER_STAGING_ORIGIN
    }),
    store: Object.freeze({
      scope() {
        return Object.freeze({
          async getConnectionDetails(id) {
            return id === connection.id ? copy(connection) : null;
          },
          async getPublicationDetails(id) {
            return id === publication.id ? copy(publication) : null;
          }
        });
      }
    }),
    credentials: Object.freeze({
      async withDecryptedCredential(_input, operation) {
        counters.credentials += 1;
        const token = Buffer.from("reviewer-test-token-not-a-real-secret");
        try {
          return await operation(token);
        } finally {
          token.fill(0);
        }
      }
    }),
    media: Object.freeze({
      async resolveOwnedJpeg() {
        throw new Error("reconciliation must not resolve media bytes");
      }
    }),
    async transport(url, options) {
      counters.transport += 1;
      return transport(url, options);
    },
    authorizeContext: (candidate) => candidate === context,
    authorizeConnection: () => true,
    authorizePublicationRequest: () => true,
    authorizePublication: () => true,
    authorizePublishedCandidate: reviewerPublishedCandidateAuthorized,
    allowOperationReferenceReconciliation: false,
    reconciliationLookbackMs: 30 * 1000,
    timeoutMs: 100,
    pollAttempts: 1,
    pollIntervalMs: 0,
    sleep: async () => {},
    clock: () => new Date("2026-09-02T12:00:10.000Z").getTime()
  });
  return Object.freeze({ connector, context, counters });
}

function pendingPublication({ reference, caption, mediaReference = MEDIA_A }) {
  return Object.freeze({
    companyId: createSocialAuthAdapter(IDENTITY_CONFIG)
      .fromVerifiedJwt(claims("tenant-a")).companyId,
    id: "53000000-0000-4000-8000-000000000093",
    connectionId: IDS.connectionA,
    provider: "instagram",
    state: "provider_confirming",
    confirmedProviderReference: null,
    reconciliationReference: reference,
    errorCode: null,
    revision: 3,
    mediaReference,
    mediaMetadataDigest: "c".repeat(64),
    caption,
    publishedAt: null,
    createdAt: new Date("2026-09-02T12:00:00.000Z"),
    updatedAt: new Date("2026-09-02T12:00:01.000Z"),
    attempts: Object.freeze([])
  });
}

test("gate do reviewer real abre somente no staging exato", () => {
  const enabled = realReviewerUiGateState({
    ENVIRONMENT: "staging",
    PUBLIC_API_BASE_URL: REAL_REVIEWER_STAGING_ORIGIN,
    REAL_REVIEWER_UI_ENABLED: "true"
  });
  assert.equal(enabled.enabled, true);
  for (const override of [
    { ENVIRONMENT: "production" },
    { PUBLIC_API_BASE_URL: "https://ia4tube-api.onrender.com" },
    { REAL_REVIEWER_UI_ENABLED: "TRUE" },
    { REAL_REVIEWER_UI_ENABLED: "false" }
  ]) {
    assert.equal(realReviewerUiGateState({
      ENVIRONMENT: "staging",
      PUBLIC_API_BASE_URL: REAL_REVIEWER_STAGING_ORIGIN,
      REAL_REVIEWER_UI_ENABLED: "true",
      ...override
    }).enabled, false);
  }
});

test("retorno OAuth real usa /reviewer e somente referência opaca", () => {
  const visual = createInstagramOAuthVisualReturn({
    publicOrigin: REAL_REVIEWER_STAGING_ORIGIN,
    returnPath: "/reviewer",
    surfaceMode: "reviewer-real",
    clock: () => 1_780_000_000_000,
    randomBytes: () => Buffer.alloc(24, 7)
  });
  const reference = visual.recordSuccess({
    ok: true,
    status: "authorization_completed",
    connectionId: IDS.connectionA
  });
  const redirect = new URL(visual.redirectUrl(reference));
  assert.equal(redirect.pathname, "/reviewer");
  assert.deepEqual([...redirect.searchParams.keys()], ["return_ref"]);
  assert.equal(redirect.searchParams.get("return_ref"), reference);
  assert.equal(redirect.href.includes("review=instagram-publishing"), false);
});

test("frontend separa /reviewer da sandbox e fecha rede por allowlist", async () => {
  const requests = [];
  const target = {
    location: {
      hostname: reviewerUi.STAGING_HOSTNAME,
      pathname: "/reviewer",
      search: "?return_ref=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      hash: "",
      href: `${reviewerUi.STAGING_API_ORIGIN}/reviewer?return_ref=` +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    },
    history: {
      replaceState(_state, _title, path) {
        target.replacedPath = path;
      }
    },
    navigator: { sendBeacon: () => true },
    fetch: async (url) => {
      requests.push(String(url));
      return { ok: true };
    }
  };
  const guard = reviewerUi.installEarlyGuard(target);
  assert.equal(guard.active, true);
  assert.equal(guard.mode, "real");
  assert.equal(target.IA4_REAL_REVIEWER_ACTIVE, true);
  assert.equal(target.replacedPath, "/reviewer");
  await target.fetch(`${reviewerUi.STAGING_API_ORIGIN}/v1/social/reviewer/media`);
  await assert.rejects(
    target.fetch(`${reviewerUi.STAGING_API_ORIGIN}/me`),
    { code: "gate5a_reviewer_network_blocked" }
  );
  await assert.rejects(
    target.fetch(`${reviewerUi.STAGING_API_ORIGIN}/v1/social/reviewer-sandbox`),
    { code: "gate5a_reviewer_network_blocked" }
  );
  await assert.rejects(
    target.fetch("https://graph.instagram.com/v25.0/me"),
    { code: "gate5a_reviewer_network_blocked" }
  );
  assert.equal(requests.length, 1);
  assert.equal(
    reviewerUi.isReviewerMode(
      "?review=instagram-publishing",
      reviewerUi.STAGING_HOSTNAME,
      "/reviewer"
    ),
    false
  );
  assert.equal(
    reviewerUi.isRealReviewerMode(
      "/reviewer",
      "ia4tube-api.onrender.com"
    ),
    false
  );
});

test("handoff do login normal preserva o retorno real sem aceitar retorno livre", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const target = {
    location: {
      hostname: reviewerUi.STAGING_HOSTNAME,
      pathname: "/reviewer",
      search: "",
      assign(path) { target.assigned = path; }
    },
    sessionStorage: storage
  };
  const started = reviewerUi.beginCanonicalLoginHandoff(target, 1000);
  assert.equal(started.returnPath, "/reviewer");
  assert.equal(target.assigned, reviewerUi.CANONICAL_LOGIN_PATH);
  target.location.pathname = "/app.html";
  target.location.search = "";
  assert.deepEqual(
    reviewerUi.readCanonicalLoginHandoff(target, 1001),
    { active: true, returnPath: "/reviewer" }
  );
  assert.equal(reviewerUi.completeCanonicalLoginHandoff(target, 1002), true);
  assert.equal(target.assigned, "/reviewer");
  assert.equal(
    isRealReviewerLoginHandoffUrl("/app.html?gate5a_review_login=1"),
    true
  );
  for (const unsafe of [
    "/app.html",
    "/app.html?gate5a_review_login=0",
    "/app.html?gate5a_review_login=1&next=https://example.com",
    "/app.html?gate5a_review_login=1#token"
  ]) {
    assert.equal(isRealReviewerLoginHandoffUrl(unsafe), false);
  }
  assert.match(
    REAL_REVIEWER_CONTENT_SECURITY_POLICY,
    /connect-src 'self'/
  );
  assert.match(
    REAL_REVIEWER_CONTENT_SECURITY_POLICY,
    /script-src 'self' 'unsafe-inline'/
  );
  assert.equal(
    REAL_REVIEWER_CONTENT_SECURITY_POLICY.includes("googletagmanager"),
    false
  );
});

test("URL oficial e texto real expõem só as duas permissões aprovadas", () => {
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("enable_fb_login", "0");
  url.searchParams.set("client_id", "1234567890");
  url.searchParams.set(
    "redirect_uri",
    `${reviewerUi.STAGING_API_ORIGIN}/v1/social/oauth/callback`
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    "instagram_business_basic,instagram_business_content_publish"
  );
  url.searchParams.set("state", "A".repeat(64));
  assert.equal(reviewerUi.isOfficialInstagramAuthorizationUrl(url), true);
  url.searchParams.append("redirect_uri", url.searchParams.get("redirect_uri"));
  assert.equal(reviewerUi.isOfficialInstagramAuthorizationUrl(url), false);
  url.searchParams.delete("redirect_uri");
  url.searchParams.set(
    "redirect_uri",
    `${REAL_REVIEWER_STAGING_ORIGIN}/v1/social/oauth/callback`
  );
  url.hostname = "example.com";
  assert.equal(reviewerUi.isOfficialInstagramAuthorizationUrl(url), false);
  const html = reviewerUi.realReviewerTemplate();
  assert.match(html, /senha.+somente no ambiente oficial/is);
  assert.match(html, /instagram_business_basic/);
  assert.match(html, /instagram_business_content_publish/);
  assert.match(html, /Enviando/);
  assert.match(html, /Confirmando/);
  assert.match(html, /Publicado/);
  assert.equal(html.includes("/v1/social/reviewer-sandbox"), false);
  assert.equal(html.includes("provedor simulado"), false);
});

test("identidade da mídia vincula JPEG e legenda a um marcador único", () => {
  const first = reviewerMediaIdentity({
    orderId: "pedido-controlado-1",
    jpegSha256: "a".repeat(64),
    caption: CAPTION_A
  });
  const changedCaption = reviewerMediaIdentity({
    orderId: "pedido-controlado-1",
    jpegSha256: "a".repeat(64),
    caption: `${CAPTION_A} alterada`
  });
  assert.match(first.mediaId, /^reviewer-jpeg:[0-9a-f]{64}$/);
  assert.notEqual(first.mediaId, changedCaption.mediaId);
  assert.equal(
    first.caption.endsWith(`\n\n${reviewerCaptionMarker(first.mediaId)}`),
    true
  );
  assert.equal(reviewerMediaIdentity({
    orderId: "pedido-controlado-1",
    jpegSha256: "a".repeat(64),
    caption: "x".repeat(2200)
  }), null);
  assert.equal(reviewerPublishedCandidateAuthorized({
    publication: {
      mediaReference: first.mediaId,
      caption: first.caption
    },
    candidate: { caption: first.caption }
  }), true);
  assert.equal(reviewerPublishedCandidateAuthorized({
    publication: {
      mediaReference: first.mediaId,
      caption: CAPTION_A
    },
    candidate: { caption: CAPTION_A }
  }), false);
});

test("referência ambígua sem container nunca vira prova por legenda", async () => {
  const reference = `igo:${"d".repeat(32)}`;
  const identity = reviewerMediaIdentity({
    orderId: "pedido-controlado-1",
    jpegSha256: "a".repeat(64),
    caption: CAPTION_A
  });
  const publication = pendingPublication({
    reference,
    caption: identity.caption,
    mediaReference: identity.mediaId
  });
  const h = createReconciliationHarness({
    publication,
    transport: async () => {
      throw new Error("operation reference must not call the provider");
    }
  });
  const result = await h.connector.getPublicationStatus(h.context, {
    publicationId: publication.id,
    providerReference: reference,
    idempotencyKey: "53000000-0000-4000-8000-000000000094"
  });
  assert.deepEqual(result, {
    outcome: "provider_confirming",
    reconciliationReference: reference
  });
  assert.deepEqual(h.counters, { credentials: 0, transport: 0 });
});

test("candidate sem marcador não confirma um container submetido", async () => {
  const containerId = "17900000000000001";
  const reference = `igc:submitted:${containerId}`;
  const publication = pendingPublication({ reference, caption: CAPTION_A });
  const h = createReconciliationHarness({
    publication,
    transport: async (url, options) => {
      assert.equal(options.method, "GET");
      assert.match(url, /\/media\?/);
      return jsonResponse({ data: [{
        id: "17999999999999998",
        caption: CAPTION_A,
        permalink: "https://www.instagram.com/p/UnrelatedPost/",
        timestamp: "2026-09-02T12:00:05.000Z"
      }] });
    }
  });
  const result = await h.connector.getPublicationStatus(h.context, {
    publicationId: publication.id,
    providerReference: reference,
    idempotencyKey: "53000000-0000-4000-8000-000000000095"
  });
  assert.deepEqual(result, {
    outcome: "provider_confirming",
    reconciliationReference: reference
  });
  assert.deepEqual(h.counters, { credentials: 1, transport: 1 });
});

test("container submetido só confirma a legenda vinculada ao JPEG", async () => {
  const identity = reviewerMediaIdentity({
    orderId: "pedido-controlado-1",
    jpegSha256: "a".repeat(64),
    caption: CAPTION_A
  });
  const reference = "igc:submitted:17900000000000001";
  const publication = pendingPublication({
    reference,
    caption: identity.caption,
    mediaReference: identity.mediaId
  });
  const h = createReconciliationHarness({
    publication,
    transport: async () => jsonResponse({ data: [{
      id: "17999999999999999",
      caption: identity.caption,
      permalink: "https://www.instagram.com/p/IA4TubeReviewer/",
      timestamp: "2026-09-02T12:00:05.000Z"
    }] })
  });
  const result = await h.connector.getPublicationStatus(h.context, {
    publicationId: publication.id,
    providerReference: reference,
    idempotencyKey: "53000000-0000-4000-8000-000000000096"
  });
  assert.equal(result.outcome, "published");
  assert.equal(
    parseConfirmedReference(result.confirmedProviderReference).mediaId,
    "17999999999999999"
  );
});

test("mídia, publicação, confirmação e histórico são tenant-scoped e canônicos", async () => {
  const fixture = createFixture();
  const service = fixture.createService();
  const listA = await service.listMedia({ verifiedClaims: fixture.claimsA });
  const listB = await service.listMedia({ verifiedClaims: fixture.claimsB });
  assert.deepEqual(listA.media.map((item) => item.id), [MEDIA_A]);
  assert.deepEqual(listB.media.map((item) => item.id), [MEDIA_B]);
  assert.equal(listA.contentOwnerDerivedFromSession, true);

  await assert.rejects(service.publish({
    verifiedClaims: fixture.claimsB,
    mediaId: MEDIA_A,
    clientRequestId: "53000000-0000-4000-8000-000000000001"
  }), { code: "resource_unavailable" });
  assert.equal(fixture.calls.publish, 0);

  const first = await service.publish({
    verifiedClaims: fixture.claimsA,
    mediaId: MEDIA_A,
    clientRequestId: "53000000-0000-4000-8000-000000000002"
  });
  assert.equal(first.publication.state, "provider_confirming");
  assert.equal(first.publication.providerMediaId, null);
  assert.equal(first.duplicateSubmissionPrevented, false);
  assert.equal(fixture.calls.publish, 1);

  const duplicate = await service.publish({
    verifiedClaims: fixture.claimsA,
    mediaId: MEDIA_A,
    clientRequestId: "53000000-0000-4000-8000-000000000003"
  });
  assert.equal(duplicate.duplicateSubmissionPrevented, true);
  assert.equal(duplicate.publication.state, "provider_confirming");
  assert.equal(fixture.calls.publish, 1);

  const confirmed = await service.reconcile({
    verifiedClaims: fixture.claimsA,
    publicationId: first.publication.publicationId
  });
  assert.equal(confirmed.publication.state, "published");
  assert.equal(confirmed.publication.providerMediaId, "17999999999999999");
  assert.equal(
    confirmed.publication.permalink,
    "https://www.instagram.com/p/IA4TubeReviewer/"
  );
  assert.match(confirmed.publication.publishedAt, /^2026-09-02T/);
  assert.equal(fixture.calls.reconcile, 1);

  const restarted = fixture.createService();
  const history = await restarted.listPublications({
    verifiedClaims: fixture.claimsA
  });
  assert.equal(history.canonicalPersistence, true);
  assert.equal(history.publications.length, 1);
  assert.equal(history.publications[0].state, "published");
  assert.equal(history.publications[0].caption, CAPTION_A);
  await assert.rejects(restarted.getPublication({
    verifiedClaims: fixture.claimsB,
    publicationId: first.publication.publicationId
  }), { code: "resource_unavailable" });
  assert.deepEqual(fixture.calls, {
    publish: 1,
    reconcile: 1,
    externalMeta: 0,
    externalInstagram: 0,
    sandbox: 0
  });
});

test("falha temporária pode repetir a mesma publicação sem duplicar ativo", async () => {
  const fixture = createFixture();
  const service = fixture.createService();
  const first = await service.publish({
    verifiedClaims: fixture.claimsA,
    mediaId: MEDIA_A,
    clientRequestId: "53000000-0000-4000-8000-000000000081"
  });
  const key = `${fixture.principalA.companyId}:${first.publication.publicationId}`;
  const pending = fixture.publications.get(key);
  fixture.publications.set(key, {
    ...pending,
    state: "failed_temporary",
    reconciliationReference: null,
    errorCode: "provider_temporary_failure",
    revision: pending.revision + 1
  });
  const retried = await service.publish({
    verifiedClaims: fixture.claimsA,
    mediaId: MEDIA_A,
    clientRequestId: "53000000-0000-4000-8000-000000000082"
  });
  assert.equal(retried.duplicateSubmissionPrevented, false);
  assert.equal(retried.publication.state, "provider_confirming");
  assert.equal(fixture.calls.publish, 2);
});

test("submissão duplicada não atribui a conta de uma conexão posterior", async () => {
  const fixture = createFixture();
  const service = fixture.createService();
  await service.publish({
    verifiedClaims: fixture.claimsA,
    mediaId: MEDIA_A,
    clientRequestId: "53000000-0000-4000-8000-000000000083"
  });
  const previous = fixture.connections.get(fixture.principalA.companyId);
  fixture.connections.set(fixture.principalA.companyId, Object.freeze({
    ...previous,
    id: "51000000-0000-4000-8000-000000000009",
    activeCredentialId: "51000000-0000-4000-8000-000000000010",
    account: Object.freeze({
      ...previous.account,
      username: "conta_posterior"
    })
  }));
  const duplicate = await service.publish({
    verifiedClaims: fixture.claimsA,
    mediaId: MEDIA_A,
    clientRequestId: "53000000-0000-4000-8000-000000000084"
  });
  assert.equal(duplicate.duplicateSubmissionPrevented, true);
  assert.equal(duplicate.publication.account, null);
});

test("gate externo fechado recusa antes de persistência ou provedor", async () => {
  const fixture = createFixture();
  let scopedStoreCalls = 0;
  const connectorStore = Object.freeze({
    scope() {
      scopedStoreCalls += 1;
      throw new Error("o store não deveria ser consultado");
    }
  });
  const service = createInstagramRealReviewerService({
    ...fixture.serviceOptions,
    config: Object.freeze({
      ...fixture.serviceOptions.config,
      externalPublicationEnabled: false
    }),
    connectorStore
  });
  await assert.rejects(service.publish({
    verifiedClaims: fixture.claimsA,
    mediaId: MEDIA_A,
    clientRequestId: "53000000-0000-4000-8000-000000000009"
  }), { code: "external_capability_disabled" });
  await assert.rejects(service.reconcile({
    verifiedClaims: fixture.claimsA,
    publicationId: deterministicUuid(
      fixture.principalA.companyId,
      "instagram-real-reviewer-publication:v1"
    )
  }), { code: "external_capability_disabled" });
  assert.equal(scopedStoreCalls, 0);
  assert.equal(fixture.calls.publish, 0);
  assert.equal(fixture.calls.reconcile, 0);
  assert.equal(fixture.publications.size, 0);
});

test("router exige login e rejeita autoridade ou legenda enviada pelo cliente", async (t) => {
  const fixture = createFixture();
  const service = fixture.createService();
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  app.use("/v1/social/reviewer", createInstagramRealReviewerRouter({
    authenticate(req, res, next) {
      if (req.headers.authorization !== "Bearer reviewer-test") {
        return res.status(401).json({ ok: false, code: "login_required" });
      }
      req.user = fixture.claimsA;
      return next();
    },
    getService: () => service
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/v1/social/reviewer`;
  assert.equal((await fetch(`${base}/media`)).status, 401);
  const media = await fetch(`${base}/media`, {
    headers: { authorization: "Bearer reviewer-test" }
  });
  assert.equal(media.status, 200);
  assert.deepEqual((await media.json()).media.map((item) => item.id), [MEDIA_A]);
  const rejected = await fetch(`${base}/publications`, {
    method: "POST",
    headers: {
      authorization: "Bearer reviewer-test",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      mediaId: MEDIA_A,
      clientRequestId: "53000000-0000-4000-8000-000000000004",
      company_id: fixture.principalA.companyId,
      caption: CAPTION_A
    })
  });
  assert.equal(rejected.status, 503);
  assert.deepEqual(await rejected.json(), {
    ok: false,
    code: "connector_contract_invalid"
  });
  assert.equal(fixture.calls.publish, 0);
});

test("server runtime encaminha o port real estreito sem expor runtime bruto", async () => {
  const markerMedia = Object.freeze({ marker: true });
  let captured = null;
  const reviewer = Object.freeze({
    getPublication() {},
    listMedia() {},
    listPublications() {},
    publish() {},
    reconcile() {}
  });
  const result = await initializeSocialServerRuntime({
    env: {
      SOCIAL_PERSISTENCE_ENABLED: "true",
      SOCIAL_DATABASE_POOL_MAX: "3"
    },
    realReviewerEnabled: true,
    realReviewerMedia: markerMedia,
    async createRuntime(options) {
      captured = options;
      return Object.freeze({
        enabled: true,
        instagramOAuth: null,
        instagramPublication: null,
        instagramReviewer: reviewer,
        metaCompliance: null,
        async close() {}
      });
    }
  });
  assert.equal(captured.realReviewerEnabled, true);
  assert.equal(captured.realReviewerMedia, markerMedia);
  assert.equal(result.instagramReviewer, reviewer);
  assert.equal(Object.hasOwn(result, "credentials"), false);
  await result.close();
});

test("identificador único do histórico não depende de memória process-local", () => {
  const companyId = "54000000-0000-4000-8000-000000000001";
  assert.equal(
    deterministicUuid(companyId, "instagram-real-reviewer-publication:v1"),
    deterministicUuid(companyId, "instagram-real-reviewer-publication:v1")
  );
});
