"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CONTROLLED_GATE4_JPEG_SHA256
} = require("../src/social/publication/controlled-gate4-jpeg");
const {
  createInstagramPublicationRouter,
  normalizeSummary
} = require("../src/social/publication/instagram-publication-router");

const PUBLICATION_ID = "42000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "42000000-0000-4000-8000-000000000002";
const MEDIA_ID = "17933333333333333";
const PERMALINK = "https://www.instagram.com/p/IA4TubeGate4/";

function summary(overrides = {}) {
  return {
    ok: true,
    targetUsername: "@ia4tube_empresas",
    controlledJpegSha256: CONTROLLED_GATE4_JPEG_SHA256.toUpperCase(),
    externalPublicationEnabled: false,
    publicationCount: 1,
    publication: {
      publicationId: PUBLICATION_ID,
      connectionId: CONNECTION_ID,
      internalReference: PUBLICATION_ID,
      state: "published",
      providerMediaId: MEDIA_ID,
      permalink: PERMALINK,
      publishedAt: "2026-08-28T12:00:00.000Z",
      createdAt: "2026-08-28T11:59:00.000Z",
      updatedAt: "2026-08-28T12:00:00.000Z",
      revision: 3,
      attempts: [{
        attemptNumber: 1,
        state: "published",
        errorCode: null,
        providerReference: `igm:${MEDIA_ID}:abc:1800000000`,
        startedAt: "2026-08-28T11:59:00.000Z",
        finishedAt: "2026-08-28T12:00:00.000Z",
        durationMs: 60000
      }]
    },
    ...overrides
  };
}

function fakeResponse() {
  return {
    headers: {},
    statusCode: null,
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return value; }
  };
}

function harness(serviceOverride) {
  const routes = {};
  const calls = [];
  const service = serviceOverride || {
    async getSummary(input) { calls.push(["getSummary", input]); return summary(); },
    async arm(input) {
      calls.push(["arm", input]);
      return summary({
        externalPublicationEnabled: true,
        publicationCount: 0,
        publication: null
      });
    },
    async publish(input) { calls.push(["publish", input]); return summary(); },
    async reconcile(input) { calls.push(["reconcile", input]); return summary(); }
  };
  const router = {
    get(path, ...handlers) { routes[`GET ${path}`] = handlers; },
    post(path, ...handlers) { routes[`POST ${path}`] = handlers; }
  };
  createInstagramPublicationRouter({
    router,
    authenticate(_req, _res, next) { return next(); },
    getService() { return service; }
  });
  return { calls, routes };
}

async function invoke(handlers, overrides = {}) {
  const request = {
    user: overrides.user || { verified: true },
    params: overrides.params || {},
    query: overrides.query || {},
    body: Object.hasOwn(overrides, "body") ? overrides.body : {}
  };
  const response = fakeResponse();
  let nextCalls = 0;
  handlers[0](request, response, () => { nextCalls += 1; });
  handlers[1](request, response, () => { nextCalls += 1; });
  assert.equal(nextCalls, 2);
  await handlers[2](request, response);
  return response;
}

test("Gate4 router exposes only bodyless authenticated arm, publish and reconciliation", async () => {
  const h = harness();
  assert.deepEqual(Object.keys(h.routes).sort(), [
    "GET /publications/instagram/gate4",
    "POST /publications/instagram/gate4",
    "POST /publications/instagram/gate4/arm",
    "POST /publications/instagram/gate4/reconcile"
  ]);
  const armed = await invoke(
    h.routes["POST /publications/instagram/gate4/arm"]
  );
  assert.equal(armed.statusCode, 200);
  assert.equal(armed.payload.externalPublicationEnabled, true);
  assert.equal(armed.payload.publication, null);
  const published = await invoke(
    h.routes["POST /publications/instagram/gate4"]
  );
  assert.equal(published.statusCode, 201);
  assert.equal(published.headers["Cache-Control"], "no-store");
  assert.equal(published.payload.publication.providerMediaId, MEDIA_ID);
  assert.deepEqual(h.calls, [
    ["arm", { verifiedClaims: { verified: true } }],
    ["publish", { verifiedClaims: { verified: true } }]
  ]);
});

test("browser authority and publication payload fields are rejected before service", async () => {
  const h = harness();
  for (const body of [
    { companyId: "forged" },
    { mediaId: "forged" },
    { imageUrl: "https://example.invalid/a.jpg" },
    { caption: "forged" },
    { operationId: PUBLICATION_ID },
    { providerReference: "forged" }
  ]) {
    for (const route of [
      "POST /publications/instagram/gate4/arm",
      "POST /publications/instagram/gate4"
    ]) {
      const response = await invoke(h.routes[route], { body });
      assert.equal(response.statusCode, 403);
      assert.equal(response.payload.code, "social_context_invalid");
    }
  }
  assert.equal(h.calls.length, 0);
});

test("router rejects a service response carrying any extra sensitive field", () => {
  const unsafe = summary({ accessToken: "must-not-escape" });
  assert.throws(() => normalizeSummary(unsafe));
  assert.equal(JSON.stringify(unsafe).includes("must-not-escape"), true);
});

test("unknown publication service is closed without project mutation", async () => {
  const h = harness(null);
  const routes = {};
  const router = {
    get(path, ...handlers) { routes[`GET ${path}`] = handlers; },
    post(path, ...handlers) { routes[`POST ${path}`] = handlers; }
  };
  createInstagramPublicationRouter({
    router,
    authenticate(_req, _res, next) { return next(); },
    getService() { return null; }
  });
  const response = await invoke(routes["GET /publications/instagram/gate4"]);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.payload, {
    ok: false,
    code: "external_capability_disabled"
  });
  assert.ok(h.routes);
});
