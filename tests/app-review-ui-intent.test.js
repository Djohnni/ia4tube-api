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

function harness({ client, storage = new Map() }) {
  const nodes = new Map();
  const listeners = new Map();
  const root = { ...element(),
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    }, querySelectorAll() { return []; },
    addEventListener(event, callback) { listeners.set(event, callback); }
  };
  const window = {
    IA4_REAL_REVIEWER_ACTIVE: true,
    document: { body: element(), createElement: element },
    localStorage: { getItem() { return "offline-product-session"; } },
    sessionStorage: { getItem(key) { return storage.get(key); },
      setItem(key, value) { storage.set(key, value); }, removeItem(key) { storage.delete(key); } },
    location: { hostname: reviewer.STAGING_HOSTNAME },
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
  return { app, click, select, storage, node: (selector) => root.querySelector(selector) };
}

const MEDIA = `reviewer-jpeg:${"b".repeat(64)}`;
const CONNECTION = "58000000-0000-4000-8000-000000000010";
const tick = () => new Promise((resolve) => setImmediate(resolve));

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
