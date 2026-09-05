"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const reviewer = require("../gate5a-reviewer-flow");
let ordinal = 100;

function element() {
  return { hidden: false, disabled: false, value: "", dataset: {}, style: {}, children: [],
    classList: { add() {}, toggle() {} }, removeAttribute() {},
    replaceChildren(...values) { this.children = values; },
    append(...values) { this.children.push(...values); },
    appendChild(value) { this.children.push(value); } };
}

function harness({ client, fetchImpl, returnReference = null, storage = new Map() }) {
  const nodes = new Map();
  const listeners = new Map();
  const navigations = [];
  const removedSessionKeys = [];
  const root = { ...element(),
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    }, querySelectorAll() { return []; },
    addEventListener(event, callback) { listeners.set(event, callback); }
  };
  const window = {
    IA4_REAL_REVIEWER_ACTIVE: true,
    IA4_GATE5A_RETURN_REFERENCE: returnReference,
    document: { body: element(), createElement: element },
    localStorage: { getItem() { return "offline-product-session"; },
      removeItem(key) { removedSessionKeys.push(key); } },
    sessionStorage: { getItem(key) { return storage.get(key); },
      setItem(key, value) { storage.set(key, value); }, removeItem(key) { storage.delete(key); } },
    location: { hostname: reviewer.STAGING_HOSTNAME,
      assign(url) { navigations.push(url); } },
    fetch: fetchImpl,
    crypto: { randomUUID() { return `58000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`; } }
  };
  const app = reviewer.mountRealReviewerApp(root, { window, client });
  function click(action) {
    listeners.get("click")({ target: { closest(selector) {
      return selector === "[data-real-action]" ? { dataset: { realAction: action } } : null;
    } } });
  }
  function select(value) {
    listeners.get("change")({ target: { value, matches(selector) {
      return selector === "[data-real-media-select]";
    } } });
  }
  return { app, click, select, storage, navigations, removedSessionKeys,
    node: (selector) => root.querySelector(selector) };
}

const MEDIA = `reviewer-jpeg:${"b".repeat(64)}`;
const CONNECTION = "58000000-0000-4000-8000-000000000010";
const tick = () => new Promise((resolve) => setImmediate(resolve));

const RETURN_REFERENCE = "R".repeat(32);
function returnPayload(status, code = null) {
  const completed = status === "authorization_completed";
  return { ok: completed, provider: "instagram", status,
    connectionId: completed ? CONNECTION : null, code, callbackSanitized: true };
}

function offlineResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status,
    async json() { return structuredClone(payload); } };
}

function oauthTransport({ result, returnStatus = 200, connectionStatus = 200 }) {
  const calls = [];
  const authorizationUrl = new URL("https://www.instagram.com/oauth/authorize");
  authorizationUrl.search = new URLSearchParams({ enable_fb_login: "0",
    client_id: "1234567890", response_type: "code", state: "S".repeat(64),
    redirect_uri: `${reviewer.STAGING_API_ORIGIN}/v1/social/oauth/callback`,
    scope: "instagram_business_basic,instagram_business_content_publish" }).toString();
  async function fetchImpl(url, init) {
    const route = new URL(url).pathname;
    calls.push({ route, method: init.method, body: init.body, headers: init.headers });
    if (route.startsWith("/v1/social/oauth/return/")) {
      return offlineResponse(result, returnStatus);
    }
    if (route === "/v1/social/connections/instagram") {
      const completed = result?.ok === true;
      return offlineResponse(connectionStatus === 200 ? { ok: true, connection: {
        connectionId: CONNECTION, provider: "instagram", state: completed ? "connected" : "failed",
        health: completed ? "healthy" : "failed", username: completed ? "reviewer_own" : null,
        accountType: completed ? "business" : null
      } } : { ok: false, code: "resource_unavailable" }, connectionStatus);
    }
    if (route === "/v1/social/reviewer/media") return offlineResponse({ ok: true, media: [] });
    if (route === "/v1/social/reviewer/publications") {
      return offlineResponse({ ok: true, independentReview: true, publications: [] });
    }
    if (route === "/v1/social/connections/instagram/authorization") {
      return offlineResponse({ ok: true, connectionId: CONNECTION,
        authorizationUrl: authorizationUrl.href }, 201);
    }
    throw new Error(`Unexpected offline route: ${route}`);
  }
  return { calls, fetchImpl, authorizationUrl: authorizationUrl.href };
}

for (const [status, code] of [
  ["authorization_cancelled", "social_oauth_state_cancelled"],
  ["authorization_expired", "social_oauth_state_expired"],
  ["authorization_failed", "social_oauth_exchange_failed"],
  ["authorization_completed", null]
]) {
  test(`real UI loads canonical connection after ${status} and retries only on a click`, async () => {
    const transport = oauthTransport({ result: returnPayload(status, code) });
    const h = harness({ fetchImpl: transport.fetchImpl, returnReference: RETURN_REFERENCE });
    await tick();
    const state = h.app.getState();
    assert.equal(state.connectionLoaded, true);
    assert.equal(state.returnStatus.status, status);
    assert.equal(state.error, "");
    assert.deepEqual(state.history, []);
    assert.deepEqual(h.navigations, []);
    assert.equal(transport.calls.length, 4);
    assert.ok(transport.calls.every((call) => call.method === "GET"));
    assert.ok(transport.calls.every((call) => call.headers.Authorization === "Bearer offline-product-session"));
    if (status === "authorization_completed") {
      assert.equal(state.connection.state, "connected");
      assert.equal(h.node("[data-real-authorize]").hidden, true);
      h.click("authorize");
      assert.equal(transport.calls.length, 4);
      return;
    }
    assert.equal(state.connection.state, "failed");
    assert.equal(reviewer.realReviewerConnectionView(state.connection).purpose, "connect");
    assert.equal(h.node("[data-real-authorize]").hidden, false);
    assert.equal(h.node("[data-real-authorize]").disabled, false);
    assert.equal(h.node('[data-real-action="disconnect"]').disabled, true);
    h.click("authorize");
    h.click("authorize");
    await tick();
    const writes = transport.calls.filter((call) => call.method !== "GET");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].route, "/v1/social/connections/instagram/authorization");
    assert.deepEqual(JSON.parse(writes[0].body), { purpose: "connect" });
    assert.deepEqual(h.navigations, [transport.authorizationUrl]);
  });
}

test("an unavailable opaque return still reloads the authorized company without automatic retry", async () => {
  const transport = oauthTransport({
    result: { ok: false, code: "social_oauth_return_unavailable" }, returnStatus: 404
  });
  const h = harness({ fetchImpl: transport.fetchImpl, returnReference: RETURN_REFERENCE });
  await tick();
  assert.equal(h.app.getState().connectionLoaded, true);
  assert.equal(h.app.getState().returnStatus, null);
  assert.notEqual(h.app.getState().error, "");
  assert.equal(transport.calls.length, 4);
  assert.ok(transport.calls.every((call) => call.method === "GET"));
  assert.deepEqual(h.navigations, []);
});

test("return authentication failure clears the session and stops bootstrap", async () => {
  const transport = oauthTransport({
    result: returnPayload("authorization_cancelled", "social_oauth_state_cancelled"), returnStatus: 401
  });
  const h = harness({ fetchImpl: transport.fetchImpl, returnReference: RETURN_REFERENCE });
  await tick();
  assert.equal(h.app.getState().connectionLoaded, false);
  assert.equal(h.app.getState().returnStatus, null);
  assert.deepEqual(h.removedSessionKeys, ["omascote_token"]);
  assert.equal(h.node("[data-real-layout]").hidden, true);
  assert.equal(transport.calls.length, 1);
  h.click("authorize");
  assert.equal(transport.calls.length, 1);
});

test("a terminal return cannot authorize a tenant rejected by the current-connection endpoint", async () => {
  const transport = oauthTransport({
    result: returnPayload("authorization_failed", "social_oauth_exchange_failed"), connectionStatus: 403
  });
  const h = harness({ fetchImpl: transport.fetchImpl, returnReference: RETURN_REFERENCE });
  await tick();
  assert.equal(h.app.getState().connectionLoaded, false);
  assert.equal(h.app.getState().connection, null);
  assert.notEqual(h.app.getState().error, "");
  assert.equal(h.node("[data-real-authorize]").disabled, true);
  h.click("authorize");
  assert.equal(transport.calls.length, 2);
  assert.deepEqual(h.navigations, []);
});

test("terminal ok:false is accepted only by the strict visual-return endpoint", async () => {
  const result = returnPayload("authorization_cancelled", "social_oauth_state_cancelled");
  const client = reviewer.createHttpRealReviewerClient({ apiBase: reviewer.STAGING_API_ORIGIN,
    tokenProvider: () => "offline-product-session", fetchImpl: async () => offlineResponse(result) });
  assert.deepEqual(await client.visualReturn(RETURN_REFERENCE), {
    ok: false, status: "authorization_cancelled", callbackSanitized: true
  });
  for (const operation of [() => client.connection(), () => client.media(),
    () => client.publications(), () => client.authorize("connect")]) {
    await assert.rejects(operation, { code: "social_oauth_state_cancelled" });
  }
  assert.throws(() => client.visualReturn("../invalid"),
    { code: "reviewer_oauth_return_reference_invalid" });
});

test("visual return rejects malformed bodies, HTTP failures and missing authentication", async () => {
  const terminal = returnPayload("authorization_failed", "social_oauth_exchange_failed");
  for (const payload of [null, { ok: false }, { ...terminal, status: "arbitrary_status" },
    { ...terminal, provider: "other" }, { ...terminal, callbackSanitized: false },
    { ...terminal, connectionId: CONNECTION }, { ...terminal, unexpectedField: true },
    { ...terminal, status: "authorization_completed" }, { ...terminal, ok: true }]) {
    const client = reviewer.createHttpRealReviewerClient({ apiBase: reviewer.STAGING_API_ORIGIN,
      tokenProvider: () => "offline-product-session", fetchImpl: async () => offlineResponse(payload) });
    await assert.rejects(() => client.visualReturn(RETURN_REFERENCE));
  }
  for (const status of [401, 403, 404, 503]) {
    const client = reviewer.createHttpRealReviewerClient({ apiBase: reviewer.STAGING_API_ORIGIN,
      tokenProvider: () => "offline-product-session",
      fetchImpl: async () => offlineResponse(terminal, status) });
    await assert.rejects(() => client.visualReturn(RETURN_REFERENCE), {
      code: status === 401 ? "reviewer_authentication_required" : "social_oauth_exchange_failed"
    });
  }
  let calls = 0;
  const client = reviewer.createHttpRealReviewerClient({ apiBase: reviewer.STAGING_API_ORIGIN,
    tokenProvider: () => "", fetchImpl: async () => { calls += 1; return offlineResponse(terminal); } });
  await assert.rejects(() => client.visualReturn(RETURN_REFERENCE),
    { code: "reviewer_authentication_required" });
  assert.equal(calls, 0);
});

test("mounted real UI refreshes provider-confirming state without resubmitting the intent", async () => {
  const publications = [];
  const calls = [];
  let respondUncertain = true;
  const client = {
    async connection() { return { connection: { connectionId: CONNECTION, state: "connected",
      health: "healthy", username: "@reviewer_own", accountType: "creator" } }; },
    async media() { return { media: [{ id: MEDIA, mimeType: "image/jpeg", fileName: "test.jpg",
      width: 1080, height: 1080, thumbnailUrl: "/offline.jpg", caption: "Offline test" }] }; },
    async publications() { return { independentReview: true,
      freshPublicationAvailable: !publications.some((p) => ["sending", "provider_confirming"].includes(p.state)),
      publications: structuredClone(publications) }; },
    async publish(mediaId, requestId) {
      calls.push({ mediaId, requestId });
      let publication = publications.find((p) => p.requestId === requestId);
      if (!publication) {
        publication = { publicationId: requestId, requestId, connectionId: CONNECTION,
          media: { id: mediaId, fileName: "test.jpg" }, state: "provider_confirming" };
        publications.unshift(publication);
      }
      if (respondUncertain) {
        respondUncertain = false;
        throw new Error("Response lost after provider checkpoint");
      }
      return { publication: structuredClone(publication) };
    },
    async reconcile(id) {
      const publication = publications.find((p) => p.publicationId === id);
      Object.assign(publication, { state: "published", providerMediaId: "17999999999999",
        permalink: "https://www.instagram.com/p/OfflineReview/", internalReference: id,
        publishedAt: "2026-09-04T20:00:00Z" });
      return { publication: structuredClone(publication) };
    }
  };
  const h = harness({ client });
  await tick();
  h.select(MEDIA);
  h.click("publish");
  h.click("publish");
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(h.app.getState().request.uncertain, true);
  h.click("new-publication");
  h.select("another-media");
  h.click("publish");
  assert.equal(calls.length, 1);
  assert.equal(h.app.getState().selectedMediaId, MEDIA);
  h.click("resume-publication");
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(publications.length, 1);
  assert.equal(h.app.getState().request.publicationId, publications[0].publicationId);
  const reloaded = harness({ client, storage: h.storage });
  await tick();
  assert.equal(reloaded.app.getState().publication.state, "provider_confirming");
  assert.equal(reloaded.node('[data-real-action="publish"]').disabled, true);
  assert.equal(reloaded.node('[data-real-action="new-publication"]').hidden, true);
  reloaded.click("publish");
  assert.equal(calls.length, 1);
  reloaded.click("reconcile");
  await tick();
  assert.equal(reloaded.app.getState().publication.state, "published");
  reloaded.click("publish");
  assert.equal(calls.length, 1);
  assert.equal(reloaded.node('[data-real-action="new-publication"]').hidden, false);
  reloaded.click("new-publication");
  reloaded.select(MEDIA);
  reloaded.click("publish");
  await tick();
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].requestId, calls[0].requestId);
  assert.equal(publications.length, 2);
});

test("transport without canonical record keeps ambiguity and resumes the same UUID", async () => {
  const calls = [];
  let first = true;
  const client = {
    async connection() { return { connection: { connectionId: CONNECTION, state: "connected",
      health: "healthy", username: "@reviewer_own", accountType: "creator" } }; },
    async media() { return { media: [{ id: MEDIA, mimeType: "image/jpeg", fileName: "test.jpg",
      width: 1080, height: 1080, thumbnailUrl: "/offline.jpg", caption: "Offline test" }] }; },
    async publications() { return { independentReview: true,
      freshPublicationAvailable: true, publications: [] }; },
    async publish(mediaId, requestId) {
      calls.push({ mediaId, requestId });
      if (first) {
        first = false;
        throw new Error("Transport unavailable");
      }
      return { publication: { publicationId: requestId, connectionId: CONNECTION,
        media: { id: mediaId, fileName: "test.jpg" }, state: "failed_temporary" } };
    }
  };
  const h = harness({ client });
  await tick();
  h.select(MEDIA);
  h.click("publish");
  await tick();
  assert.equal(h.app.getState().request.uncertain, true);
  assert.equal(h.app.getState().request.publicationId, null);
  h.click("resume-publication");
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].requestId, calls[0].requestId);
  assert.equal(h.app.getState().request.uncertain, false);
});

for (const terminalState of ["failed_temporary", "failed_permanent", "published"]) {
  test(`canonical ${terminalState} after response loss clears uncertainty`, async () => {
    const publications = [];
    const calls = [];
    const client = {
      async connection() { return { connection: { connectionId: CONNECTION, state: "connected",
        health: "healthy", username: "@current_account", accountType: "business" } }; },
      async media() { return { media: [{ id: MEDIA, mimeType: "image/jpeg", fileName: "test.jpg",
        width: 1080, height: 1080, thumbnailUrl: "/offline.jpg", caption: "Offline test" }] }; },
      async publications() { return { independentReview: true,
        freshPublicationAvailable: true, publications: structuredClone(publications) }; },
      async publish(mediaId, requestId) {
        calls.push({ mediaId, requestId });
        if (calls.length === 1) {
          publications.unshift({ publicationId: requestId, connectionId: CONNECTION,
            media: { id: mediaId, fileName: "test.jpg" }, state: terminalState,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            ...(terminalState === "published" ? {
              providerMediaId: "17999999999999", internalReference: requestId,
              permalink: "https://www.instagram.com/p/OfflineReview/",
              publishedAt: "2026-09-04T20:00:00Z"
            } : {}) });
          throw new Error("Response lost after canonical persistence");
        }
        return { publication: structuredClone(publications[0]) };
      }
    };
    const h = harness({ client });
    await tick();
    h.select(MEDIA);
    h.click("publish");
    await tick();
    assert.equal(h.app.getState().publication.state, terminalState);
    assert.equal(h.app.getState().request.uncertain, false);
    assert.equal(h.app.getState().request.publicationId, publications[0].publicationId);
    if (terminalState === "failed_temporary") {
      assert.equal(h.node('[data-real-action="new-publication"]').hidden, true);
      h.click("publish");
      await tick();
      assert.equal(calls.length, 2);
      assert.equal(calls[1].requestId, calls[0].requestId);
    } else {
      h.click("publish");
      assert.equal(calls.length, 1);
    }
  });
}

test("an older terminal record for the same JPEG never resolves a new ambiguous request", async () => {
  const oldId = "58000000-0000-4000-8000-000000000099";
  const oldPublication = { publicationId: oldId, connectionId: CONNECTION,
    media: { id: MEDIA, fileName: "test.jpg" }, state: "failed_temporary",
    createdAt: "2026-09-01T10:00:00Z", updatedAt: "2026-09-01T10:00:01Z" };
  const calls = [];
  const client = {
    async connection() { return { connection: { connectionId: CONNECTION, state: "connected",
      health: "healthy", username: "@reviewer_own", accountType: "creator" } }; },
    async media() { return { media: [{ id: MEDIA, mimeType: "image/jpeg", fileName: "test.jpg",
      width: 1080, height: 1080, thumbnailUrl: "/offline.jpg", caption: "Offline test" }] }; },
    async publications() { return { independentReview: true,
      freshPublicationAvailable: true, publications: [structuredClone(oldPublication)] }; },
    async publish(mediaId, requestId) {
      calls.push({ mediaId, requestId });
      throw new Error("Transport unavailable before persistence");
    }
  };
  const h = harness({ client });
  await tick();
  h.select(MEDIA);
  h.click("publish");
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(h.app.getState().request.uncertain, true);
  assert.equal(h.app.getState().request.publicationId, null);
  assert.equal(h.app.getState().request.priorPublicationIds.includes(oldId), true);
});

test("active or ambiguous publication disables and blocks disconnect in the real UI", async () => {
  let disconnectCalls = 0;
  const client = {
    async connection() { return { connection: { connectionId: CONNECTION, state: "connected",
      health: "healthy", username: "@reviewer_own", accountType: "creator" } }; },
    async media() { return { media: [{ id: MEDIA, mimeType: "image/jpeg", fileName: "test.jpg",
      width: 1080, height: 1080, thumbnailUrl: "/offline.jpg", caption: "Offline test" }] }; },
    async publications() { return { independentReview: true, freshPublicationAvailable: false,
      publications: [{ publicationId: CONNECTION, connectionId: CONNECTION,
        media: { id: MEDIA, fileName: "test.jpg" }, state: "provider_confirming" }] }; },
    async disconnect() { disconnectCalls += 1; }
  };
  const h = harness({ client });
  await tick();
  assert.equal(h.node('[data-real-action="disconnect"]').disabled, true);
  h.click("disconnect");
  assert.equal(disconnectCalls, 0);
});

test("history never relabels an old publication with a currently connected username", async () => {
  const client = {
    async connection() { return { connection: { connectionId: CONNECTION, state: "connected",
      health: "healthy", username: "@newly_reconnected", accountType: "business" } }; },
    async media() { return { media: [] }; },
    async publications() { return { independentReview: true, freshPublicationAvailable: true,
      publications: [{ publicationId: CONNECTION, connectionId: CONNECTION,
        media: { id: MEDIA, fileName: "test.jpg" }, state: "failed_permanent",
        account: { username: "@newly_reconnected", accountType: "business" },
        updatedAt: "2026-09-04T20:00:00Z" }] }; }
  };
  const h = harness({ client });
  await tick();
  const history = h.node("[data-real-history]");
  const rendered = JSON.stringify(history.children);
  assert.equal(rendered.includes("@newly_reconnected"), false);
  assert.equal(rendered.includes("vínculo registrado nesta publicação"), true);
});

test("ordinary company never receives fresh-publication action", async () => {
  const client = { async connection() { return { connection: { connectionId: CONNECTION,
    state: "connected", health: "healthy" } }; }, async media() { return { media: [] }; },
    async publications() { return { independentReview: false, freshPublicationAvailable: false,
      publications: [{ publicationId: CONNECTION, state: "published", media: { id: MEDIA } }] }; } };
  const h = harness({ client });
  await tick();
  assert.equal(h.node('[data-real-action="new-publication"]').hidden, true);
  h.click("new-publication");
  assert.equal(h.app.getState().publication.state, "published");
});
