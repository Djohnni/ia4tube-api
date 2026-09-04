"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const gate5a = require("../gate5a-reviewer-flow");

const repoDir = path.resolve(__dirname, "..");
const appPath = path.join(repoDir, "app.html");
const helperPath = path.join(repoDir, "gate5a-reviewer-flow.js");
const appSource = fs.readFileSync(appPath, "utf8");
const helperSource = fs.readFileSync(helperPath, "utf8");
const fixedNow = "2026-08-30T12:34:56.000Z";
const opaqueReturnReference = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const syntheticConnectionId = "11111111-1111-4111-8111-111111111111";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

function connectedState(accountType = "BUSINESS") {
  let state = gate5a.createInitialState({ accountType });
  state = gate5a.transitionState(state, {
    type: "START_AUTHORIZATION",
    accountType
  }, fixedNow);
  return gate5a.transitionState(state, {
    type: "COMPLETE_AUTHORIZATION"
  }, fixedNow);
}

function readyToPublishState(accountType = "BUSINESS") {
  return gate5a.transitionState(connectedState(accountType), {
    type: "SELECT_MEDIA"
  }, fixedNow);
}

test("API base resolves the exact checkpoint hostname without changing production", () => {
  assert.equal(
    gate5a.resolveApiBase(gate5a.STAGING_HOSTNAME),
    "https://ia4tube-api-staging-checkpoint-a.onrender.com"
  );
  assert.equal(gate5a.resolveApiBase("localhost"), "http://localhost:3000");
  assert.equal(gate5a.resolveApiBase("127.0.0.1"), "http://localhost:3000");
  assert.equal(
    gate5a.resolveApiBase("ia4tube.com"),
    "https://ia4tube-api.onrender.com"
  );
});

test("reviewer route is staging/local only and never activates on production", () => {
  const search = "?review=instagram-publishing&stage=overview";
  assert.equal(gate5a.isReviewerMode(search, gate5a.STAGING_HOSTNAME), true);
  assert.equal(gate5a.isReviewerMode(search, "localhost"), true);
  assert.equal(gate5a.isReviewerMode(search, "ia4tube.com"), false);
  assert.equal(gate5a.isReviewerMode("?review=debug", gate5a.STAGING_HOSTNAME), false);
});

test("reviewer login handoff uses only fixed same-origin paths and returns automatically", () => {
  const storage = memoryStorage();
  const assigned = [];
  const now = Date.parse(fixedNow);
  const reviewerWindow = {
    location: {
      hostname: gate5a.STAGING_HOSTNAME,
      pathname: "/app.html",
      search: "?review=instagram-publishing&stage=overview",
      assign(value) { assigned.push(value); }
    },
    sessionStorage: storage
  };
  const started = gate5a.beginCanonicalLoginHandoff(reviewerWindow, now);
  assert.equal(started.loginPath, "/app.html?gate5a_review_login=1");
  assert.equal(started.returnPath, gate5a.REVIEWER_RETURN_PATH);
  assert.deepEqual(assigned, ["/app.html?gate5a_review_login=1"]);
  const receipt = JSON.parse(storage.getItem(gate5a.CANONICAL_LOGIN_HANDOFF_KEY));
  assert.deepEqual(Object.keys(receipt).sort(), ["issuedAt", "version"]);
  assert.equal(JSON.stringify(receipt).includes("return"), false);

  const replacements = [];
  const canonicalWindow = {
    location: {
      hostname: gate5a.STAGING_HOSTNAME,
      pathname: "/app.html",
      search: "?gate5a_review_login=1",
      assign(value) { assigned.push(value); }
    },
    history: {
      replaceState(_state, _title, value) { replacements.push(value); }
    },
    sessionStorage: storage
  };
  assert.equal(gate5a.sanitizeCanonicalLoginHandoffUrl(canonicalWindow), true);
  assert.deepEqual(replacements, ["/app.html"]);
  assert.deepEqual(gate5a.readCanonicalLoginHandoff(canonicalWindow, now), {
    active: true,
    returnPath: gate5a.REVIEWER_RETURN_PATH
  });
  assert.equal(gate5a.completeCanonicalLoginHandoff(canonicalWindow, now), true);
  assert.equal(assigned.at(-1), gate5a.REVIEWER_RETURN_PATH);
  assert.equal(storage.getItem(gate5a.CANONICAL_LOGIN_HANDOFF_KEY), null);
});

test("reviewer login handoff rejects tampering, expiry and production hosts", () => {
  const now = Date.parse(fixedNow);
  const storage = memoryStorage();
  const target = {
    location: {
      hostname: gate5a.STAGING_HOSTNAME,
      pathname: "/app.html",
      search: "",
      assign() { throw new Error("must not redirect"); }
    },
    sessionStorage: storage
  };
  storage.setItem(gate5a.CANONICAL_LOGIN_HANDOFF_KEY, JSON.stringify({
    version: 1,
    issuedAt: now,
    returnUrl: "https://example.invalid/open-redirect"
  }));
  assert.equal(gate5a.readCanonicalLoginHandoff(target, now).active, false);
  assert.equal(storage.getItem(gate5a.CANONICAL_LOGIN_HANDOFF_KEY), null);

  storage.setItem(gate5a.CANONICAL_LOGIN_HANDOFF_KEY, JSON.stringify({
    version: 1,
    issuedAt: now - gate5a.CANONICAL_LOGIN_HANDOFF_TTL_MS - 1
  }));
  assert.equal(gate5a.readCanonicalLoginHandoff(target, now).active, false);

  assert.throws(
    () => gate5a.beginCanonicalLoginHandoff({
      location: {
        hostname: "ia4tube.com",
        search: "?review=instagram-publishing",
        assign() {}
      },
      sessionStorage: memoryStorage()
    }, now),
    (error) => error.code === "reviewer_canonical_login_unavailable"
  );
});

test("callback sanitizer removes every sensitive value and keeps a visual route", () => {
  const result = gate5a.sanitizeCallbackUrl(
    "https://ia4tube-api-staging-checkpoint-a.onrender.com/app.html" +
    "?review=instagram-publishing&stage=authorization&code=secret-code" +
    "&state=secret-state&access_token=secret-token&unknown=remove-me" +
    "#id_token=secret-id"
  );
  assert.equal(result.active, true);
  assert.equal(result.callbackObserved, true);
  assert.equal(result.stage, "oauth-return");
  assert.equal(
    result.path,
    "/app.html?review=instagram-publishing&stage=oauth-return"
  );
  for (const forbidden of [
    "secret-code",
    "secret-state",
    "secret-token",
    "secret-id",
    "unknown"
  ]) {
    assert.equal(result.path.includes(forbidden), false);
  }
});

test("callback sanitizer captures a valid opaque return reference before removing it", () => {
  const result = gate5a.sanitizeCallbackUrl(
    `${gate5a.STAGING_API_ORIGIN}/app.html?review=instagram-publishing` +
      `&stage=oauth-return&return_ref=${opaqueReturnReference}&code=must-disappear`
  );
  assert.equal(result.returnReference, opaqueReturnReference);
  assert.equal(result.callbackObserved, true);
  assert.equal(
    result.path,
    "/app.html?review=instagram-publishing&stage=oauth-return"
  );
  assert.equal(result.path.includes("return_ref"), false);
  assert.equal(result.path.includes("must-disappear"), false);

  const invalid = gate5a.sanitizeCallbackUrl(
    `${gate5a.STAGING_API_ORIGIN}/app.html?review=instagram-publishing` +
      "&return_ref=too-short"
  );
  assert.equal(invalid.returnReference, null);
  assert.equal(invalid.path.includes("too-short"), false);
});

test("early guard permits only the authenticated reviewer sandbox prefix", async () => {
  const calls = [];
  const replacements = [];
  const originalFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true };
  };
  const target = {
    location: {
      hostname: gate5a.STAGING_HOSTNAME,
      search: "?review=instagram-publishing&code=pasted-code&state=pasted-state",
      href: "https://ia4tube-api-staging-checkpoint-a.onrender.com/app.html" +
        "?review=instagram-publishing&code=pasted-code&state=pasted-state"
    },
    history: {
      replaceState(_state, _title, url) { replacements.push(url); }
    },
    navigator: { sendBeacon: () => true },
    fetch: originalFetch
  };

  const guard = gate5a.installEarlyGuard(target);
  assert.equal(guard.active, true);
  assert.equal(target.fetch.gate5aGuarded, true);
  assert.equal(Object.hasOwn(target, "IA4_GATE5A_ORIGINAL_FETCH"), false);
  assert.deepEqual(replacements, [
    "/app.html?review=instagram-publishing&stage=oauth-return"
  ]);

  await target.fetch(
    `${gate5a.STAGING_API_ORIGIN}${gate5a.SANDBOX_PREFIX}/state`,
    { method: "GET" }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith("/reviewer-sandbox/state"), true);

  await assert.rejects(
    target.fetch(`${gate5a.STAGING_API_ORIGIN}/me`),
    (error) => error.code === "gate5a_reviewer_network_blocked"
  );
  await assert.rejects(
    target.fetch("https://graph.instagram.com/v25.0/me"),
    (error) => error.code === "gate5a_reviewer_network_blocked"
  );
  await assert.rejects(
    target.fetch(`${gate5a.STAGING_API_ORIGIN}/auth/login`, { method: "POST" }),
    (error) => error.code === "gate5a_reviewer_network_blocked"
  );
  assert.equal(calls.length, 1);
  assert.equal(target.navigator.sendBeacon(), false);
});

test("early guard leaves production and the ordinary app transport untouched", () => {
  const originalFetch = () => Promise.resolve({ ok: true });
  const target = {
    location: {
      hostname: "ia4tube.com",
      search: "?review=instagram-publishing",
      href: "https://ia4tube.com/app.html?review=instagram-publishing"
    },
    history: { replaceState() { throw new Error("must not replace"); } },
    navigator: {},
    fetch: originalFetch
  };
  const guard = gate5a.installEarlyGuard(target);
  assert.equal(guard.active, false);
  assert.equal(target.fetch, originalFetch);
  assert.equal(target.IA4_GATE5A_REVIEWER_ACTIVE, false);
});

test("early guard allows one exact GET-only visual-return route and blocks variants", async () => {
  const calls = [];
  const replacements = [];
  const target = {
    location: {
      hostname: gate5a.STAGING_HOSTNAME,
      search: `?review=instagram-publishing&return_ref=${opaqueReturnReference}`,
      href: `${gate5a.STAGING_API_ORIGIN}/app.html?review=instagram-publishing` +
        `&return_ref=${opaqueReturnReference}`
    },
    history: {
      replaceState(_state, _title, url) { replacements.push(url); }
    },
    navigator: {},
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    }
  };
  const guard = gate5a.installEarlyGuard(target);
  assert.equal(guard.returnReference, opaqueReturnReference);
  assert.equal(target.IA4_GATE5A_RETURN_REFERENCE, opaqueReturnReference);
  assert.deepEqual(replacements, [
    "/app.html?review=instagram-publishing&stage=oauth-return"
  ]);

  const allowed = `${gate5a.STAGING_API_ORIGIN}${gate5a.OAUTH_RETURN_PREFIX}/` +
    opaqueReturnReference;
  await target.fetch(allowed, { method: "GET" });
  assert.equal(calls.length, 1);
  await assert.rejects(
    target.fetch(allowed, { method: "POST" }),
    (error) => error.code === "gate5a_reviewer_network_blocked"
  );
  await assert.rejects(
    target.fetch(`${allowed}?unexpected=1`, { method: "GET" }),
    (error) => error.code === "gate5a_reviewer_network_blocked"
  );
  await assert.rejects(
    target.fetch(`${gate5a.STAGING_API_ORIGIN}${gate5a.OAUTH_RETURN_PREFIX}/too-short`),
    (error) => error.code === "gate5a_reviewer_network_blocked"
  );
  assert.equal(calls.length, 1);
});

test("Business and Creator fixtures connect as synthetic professional accounts", () => {
  for (const accountType of ["BUSINESS", "CREATOR"]) {
    const state = connectedState(accountType);
    assert.equal(state.connection.status, "connected");
    assert.equal(state.connection.account.accountType, accountType);
    assert.equal(state.connection.account.synthetic, true);
    assert.equal(state.connection.account.username.includes("ia4tube_empresas"), false);
    assert.equal(state.stage, "connection");
  }
});

test("Personal account is rejected without creating a connection", () => {
  const state = connectedState("PERSONAL");
  assert.equal(state.stage, "oauth-return");
  assert.equal(state.connection.status, "rejected");
  assert.equal(state.connection.account, null);
  assert.equal(state.connection.error.code, "professional_account_required");
  assert.equal(state.media.selected, false);
  assert.equal(state.publication.attempts, 0);
});

test("controlled media is a synthetic JPEG and requires a connected account", () => {
  const refused = gate5a.transitionState(gate5a.createInitialState(), {
    type: "SELECT_MEDIA"
  }, fixedNow);
  assert.equal(refused.media.selected, false);

  const accepted = readyToPublishState();
  assert.equal(accepted.media.selected, true);
  assert.equal(accepted.media.item.mimeType, "image/jpeg");
  assert.equal(accepted.media.item.synthetic, true);
  assert.equal(accepted.media.item.width, 1080);
  assert.equal(accepted.media.item.height, 1080);
  assert.equal(accepted.media.item.id.includes("gate4"), false);
});

test("manual publish reservation is idempotent and attempts exactly once", () => {
  const ready = readyToPublishState();
  const first = gate5a.transitionState(ready, { type: "START_PUBLISH" }, fixedNow);
  const repeated = gate5a.transitionState(first, { type: "START_PUBLISH" }, fixedNow);
  assert.equal(first.publication.state, "sending");
  assert.equal(first.publication.attempts, 1);
  assert.equal(repeated, first);
  assert.equal(repeated.history.length, 0);
});

test("publication advances sending -> provider_confirming -> published once", () => {
  let state = gate5a.transitionState(
    readyToPublishState(),
    { type: "START_PUBLISH" },
    fixedNow
  );
  assert.equal(state.publication.state, "sending");
  state = gate5a.transitionState(state, {
    type: "ADVANCE_PUBLISH",
    publicationId: state.publication.id
  }, fixedNow);
  assert.equal(state.publication.state, "provider_confirming");
  state = gate5a.transitionState(state, {
    type: "ADVANCE_PUBLISH",
    publicationId: state.publication.id
  }, fixedNow);
  assert.equal(state.publication.state, "published");
  assert.equal(state.publication.details.synthetic, true);
  assert.equal(state.history.length, 1);
  const repeated = gate5a.transitionState(
    state,
    { type: "ADVANCE_PUBLISH", publicationId: state.publication.id },
    "2026-08-30T13:00:00.000Z"
  );
  assert.equal(repeated, state);
  assert.equal(repeated.history.length, 1);
  assert.equal(repeated.publication.attempts, 1);
});

for (const pendingState of ["sending", "provider_confirming"]) {
  test(`disconnect invalidates ${pendingState} and an old publication id cannot advance`, () => {
    let state = gate5a.transitionState(
      readyToPublishState(),
      { type: "START_PUBLISH" },
      fixedNow
    );
    if (pendingState === "provider_confirming") {
      state = gate5a.transitionState(state, {
        type: "ADVANCE_PUBLISH",
        publicationId: state.publication.id
      }, fixedNow);
    }
    assert.equal(state.publication.state, pendingState);
    const oldPublicationId = state.publication.id;
    state = gate5a.transitionState(state, { type: "DISCONNECT" }, fixedNow);
    assert.equal(state.publication.state, "idle");
    assert.equal(state.publication.id, null);
    assert.equal(state.media.selected, false);

    const disconnected = state;
    state = gate5a.transitionState(state, {
      type: "ADVANCE_PUBLISH",
      publicationId: oldPublicationId
    }, fixedNow);
    assert.equal(state, disconnected);
    state = gate5a.transitionState(state, {
      type: "START_AUTHORIZATION",
      accountType: "CREATOR"
    }, fixedNow);
    state = gate5a.transitionState(state, {
      type: "COMPLETE_AUTHORIZATION"
    }, fixedNow);
    const reconnected = state;
    state = gate5a.transitionState(state, {
      type: "ADVANCE_PUBLISH",
      publicationId: oldPublicationId
    }, fixedNow);
    assert.equal(state, reconnected);
    state = gate5a.transitionState(state, { type: "SELECT_MEDIA" }, fixedNow);
    state = gate5a.transitionState(state, { type: "START_PUBLISH" }, fixedNow);
    assert.notEqual(state.publication.id, oldPublicationId);
    assert.equal(state.publication.attempts, 1);
    const newPublication = state;
    state = gate5a.transitionState(state, { type: "START_PUBLISH" }, fixedNow);
    assert.equal(state, newPublication);
    state = gate5a.transitionState(state, {
      type: "ADVANCE_PUBLISH",
      publicationId: oldPublicationId
    }, fixedNow);
    assert.equal(state, newPublication);
    state = gate5a.transitionState(state, {
      type: "ADVANCE_PUBLISH",
      publicationId: state.publication.id
    }, fixedNow);
    state = gate5a.transitionState(state, {
      type: "ADVANCE_PUBLISH",
      publicationId: state.publication.id
    }, fixedNow);
    assert.equal(state.publication.state, "published");
    assert.equal(state.history.length, 1);
  });
}

test("published history survives disconnect while a newly selected publication runs once", () => {
  let state = gate5a.transitionState(
    readyToPublishState(),
    { type: "START_PUBLISH" },
    fixedNow
  );
  state = gate5a.transitionState(state, {
    type: "ADVANCE_PUBLISH",
    publicationId: state.publication.id
  }, fixedNow);
  state = gate5a.transitionState(state, {
    type: "ADVANCE_PUBLISH",
    publicationId: state.publication.id
  }, fixedNow);
  const firstPublicationId = state.publication.id;
  assert.equal(state.history.length, 1);
  state = gate5a.transitionState(state, { type: "DISCONNECT" }, fixedNow);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].id, firstPublicationId);
  state = gate5a.transitionState(state, {
    type: "START_AUTHORIZATION",
    accountType: "BUSINESS"
  }, fixedNow);
  state = gate5a.transitionState(state, { type: "COMPLETE_AUTHORIZATION" }, fixedNow);
  state = gate5a.transitionState(state, { type: "SELECT_MEDIA" }, fixedNow);
  state = gate5a.transitionState(state, { type: "START_PUBLISH" }, fixedNow);
  const secondPublicationId = state.publication.id;
  assert.notEqual(secondPublicationId, firstPublicationId);
  const once = state;
  state = gate5a.transitionState(state, { type: "START_PUBLISH" }, fixedNow);
  assert.equal(state, once);
  state = gate5a.transitionState(state, {
    type: "ADVANCE_PUBLISH",
    publicationId: secondPublicationId
  }, fixedNow);
  state = gate5a.transitionState(state, {
    type: "ADVANCE_PUBLISH",
    publicationId: secondPublicationId
  }, fixedNow);
  assert.equal(state.history.length, 2);
  assert.equal(state.history.some((item) => item.id === firstPublicationId), true);
  assert.equal(state.history.some((item) => item.id === secondPublicationId), true);
});

test("permalink is exact, safe, synthetic and never accepts query or credentials", () => {
  assert.equal(gate5a.isSafeSyntheticPermalink(gate5a.SYNTHETIC_PERMALINK), true);
  assert.equal(
    gate5a.isSafeSyntheticPermalink(`${gate5a.SYNTHETIC_PERMALINK}&token=secret`),
    false
  );
  assert.equal(
    gate5a.isSafeSyntheticPermalink("https://user:pass@example.invalid/internal-review"),
    false
  );
  assert.equal(
    gate5a.isSafeSyntheticPermalink("https://example.invalid/external-review"),
    false
  );
});

test("visual-return client performs an anonymous GET and accepts only the exact safe shape", async () => {
  const requests = [];
  const client = gate5a.createOAuthReturnClient({
    apiBase: gate5a.STAGING_API_ORIGIN,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            provider: "instagram",
            status: "authorization_completed",
            connectionId: syntheticConnectionId,
            code: null,
            callbackSanitized: true
          };
        }
      };
    }
  });
  const result = await client.getStatus(opaqueReturnReference);
  assert.deepEqual(result, {
    ok: true,
    status: "authorization_completed",
    callbackSanitized: true
  });
  assert.equal(
    requests[0].url,
    `${gate5a.STAGING_API_ORIGIN}${gate5a.OAUTH_RETURN_PREFIX}/${opaqueReturnReference}`
  );
  assert.deepEqual(requests[0].init.headers, { Accept: "application/json" });
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.credentials, "omit");
  assert.equal(requests[0].init.referrerPolicy, "no-referrer");
  assert.equal(JSON.stringify(requests[0]).includes("Authorization"), false);
});

test("visual-return client maps all safe outcomes and rejects shape drift", async () => {
  for (const [status, code] of [
    ["authorization_cancelled", "social_oauth_state_cancelled"],
    ["authorization_expired", "social_oauth_state_expired"],
    ["authorization_failed", "invalid_account_type"]
  ]) {
    const client = gate5a.createOAuthReturnClient({
      apiBase: gate5a.STAGING_API_ORIGIN,
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            ok: false,
            provider: "instagram",
            status,
            connectionId: null,
            code,
            callbackSanitized: true
          };
        }
      })
    });
    assert.equal((await client.getStatus(opaqueReturnReference)).status, status);
  }

  const unsafe = gate5a.createOAuthReturnClient({
    apiBase: gate5a.STAGING_API_ORIGIN,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          ok: true,
          provider: "instagram",
          status: "authorization_completed",
          connectionId: syntheticConnectionId,
          code: null,
          callbackSanitized: true,
          access_token: "must-not-be-accepted"
        };
      }
    })
  });
  await assert.rejects(
    unsafe.getStatus(opaqueReturnReference),
    (error) => error.code === "reviewer_oauth_return_response_invalid"
  );
});

test("disconnect preserves synthetic history until explicit data deletion", () => {
  let state = gate5a.transitionState(
    readyToPublishState(),
    { type: "START_PUBLISH" },
    fixedNow
  );
  state = gate5a.transitionState(state, {
    type: "ADVANCE_PUBLISH",
    publicationId: state.publication.id
  }, fixedNow);
  state = gate5a.transitionState(state, {
    type: "ADVANCE_PUBLISH",
    publicationId: state.publication.id
  }, fixedNow);
  state = gate5a.transitionState(state, { type: "DISCONNECT" }, fixedNow);
  assert.equal(state.connection.status, "disconnected");
  assert.equal(state.connection.account, null);
  assert.equal(state.history.length, 1);
  state = gate5a.transitionState(state, { type: "DELETE_DATA" }, fixedNow);
  assert.equal(state.deletion.status, "completed");
  assert.equal(state.deletion.technicalConnectionDataDeleted, true);
  assert.equal(state.deletion.commercialHistoryPolicy, "owner_decision_pending");
  assert.equal(state.connection.account, null);
  assert.equal(state.media.item, null);
  assert.equal(state.history.length, 1);
});

test("in-memory sandbox reproduces the full safe flow with no external calls", async () => {
  const client = gate5a.createInMemorySandbox({ now: fixedNow });
  await client.authorize("CREATOR");
  let state = await client.completeAuthorization();
  assert.equal(state.connection.status, "connected");
  state = await client.selectMedia();
  assert.equal(state.media.selected, true);
  state = await client.publish();
  assert.equal(state.publication.state, "sending");
  state = await client.publish();
  assert.equal(state.publication.attempts, 1);
  state = await client.advancePublication(state.publication.id);
  assert.equal(state.publication.state, "provider_confirming");
  state = await client.advancePublication(state.publication.id);
  assert.equal(state.publication.state, "published");
  assert.equal(state.history.length, 1);
  assert.equal(state.externalCalls, 0);
  assert.equal(state.sandbox, true);
});

test("HTTP sandbox client emits only the agreed authenticated contract", async () => {
  const requests = [];
  let state = gate5a.createInitialState();
  const fakeFetch = async (url, init) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/authorization")) {
      state = gate5a.transitionState(state, {
        type: "START_AUTHORIZATION",
        accountType: JSON.parse(init.body).accountType
      }, fixedNow);
    }
    return {
      ok: true,
      async json() {
        return { ok: true, sandbox: true, externalCalls: 0, state };
      }
    };
  };
  const client = gate5a.createHttpSandboxClient({
    apiBase: gate5a.STAGING_API_ORIGIN,
    fetchImpl: fakeFetch,
    tokenProvider: () => "reviewer-session-secret"
  });
  await client.getState();
  await client.authorize("BUSINESS");
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].url,
    `${gate5a.STAGING_API_ORIGIN}${gate5a.SANDBOX_PREFIX}/state`
  );
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.headers.Authorization, "Bearer reviewer-session-secret");
  assert.equal(requests[0].url.includes("reviewer-session-secret"), false);
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    accountType: "BUSINESS",
    purpose: "app_review"
  });
});

test("HTTP sandbox client maps a bare 401 before requiring the sandbox envelope", async () => {
  let jsonReads = 0;
  const client = gate5a.createHttpSandboxClient({
    apiBase: gate5a.STAGING_API_ORIGIN,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async json() {
        jsonReads += 1;
        throw new Error("401 body must not be parsed");
      }
    }),
    tokenProvider: () => "stale-reviewer-token"
  });
  await assert.rejects(
    client.getState(),
    (error) => error.code === "reviewer_authentication_required"
  );
  assert.equal(jsonReads, 0);
});

test("stale-token recovery removes only the exact token proven invalid by a 401", () => {
  const storage = memoryStorage();
  storage.setItem("omascote_token", "stale-reviewer-token");
  storage.setItem("unrelated", "preserve-me");

  assert.deepEqual(gate5a.recoverReviewerAuthenticationFrom401({
    code: "reviewer_sandbox_response_invalid",
    hostname: gate5a.STAGING_HOSTNAME,
    expectedToken: "stale-reviewer-token",
    storage
  }), { handled: false, tokenRemoved: false });
  assert.equal(storage.getItem("omascote_token"), "stale-reviewer-token");

  storage.setItem("omascote_token", "new-token-from-another-tab");
  assert.deepEqual(gate5a.recoverReviewerAuthenticationFrom401({
    code: "reviewer_authentication_required",
    hostname: gate5a.STAGING_HOSTNAME,
    expectedToken: "stale-reviewer-token",
    storage
  }), { handled: false, tokenRemoved: false });
  assert.equal(storage.getItem("omascote_token"), "new-token-from-another-tab");

  storage.setItem("omascote_token", "stale-reviewer-token");
  assert.deepEqual(gate5a.recoverReviewerAuthenticationFrom401({
    code: "reviewer_authentication_required",
    hostname: gate5a.STAGING_HOSTNAME,
    expectedToken: "stale-reviewer-token",
    storage
  }), { handled: true, tokenRemoved: true });
  assert.equal(storage.getItem("omascote_token"), null);
  assert.equal(storage.getItem("unrelated"), "preserve-me");
});

test("a 401 during a sandbox action resets auth/company state and exposes the login gate", async () => {
  const storage = memoryStorage();
  storage.setItem("omascote_token", "stale-action-token");
  const client = gate5a.createHttpSandboxClient({
    apiBase: gate5a.STAGING_API_ORIGIN,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async json() { throw new Error("must not parse"); }
    }),
    tokenProvider: () => "stale-action-token"
  });
  let actionError;
  try {
    await client.authorize("BUSINESS");
  } catch (error) {
    actionError = error;
  }
  const reduced = gate5a.reduceReviewerAuthenticationAfterError({
    authenticated: true,
    companyVerified: true,
    canonicalToken: "stale-action-token"
  }, {
    code: actionError?.code,
    hostname: gate5a.STAGING_HOSTNAME,
    storage
  });
  assert.deepEqual(reduced, {
    handled: true,
    tokenRemoved: true,
    authenticated: false,
    companyVerified: false,
    canonicalToken: ""
  });
  assert.equal(storage.getItem("omascote_token"), null);
  assert.match(helperSource, /if \(authGate\) authGate\.hidden = authenticated;/);
});

test("403 and malformed responses remain fail-closed without stale-token cleanup", async () => {
  const storage = memoryStorage();
  storage.setItem("omascote_token", "reviewer-token");
  const client = gate5a.createHttpSandboxClient({
    apiBase: gate5a.STAGING_API_ORIGIN,
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      async json() { return { ok: false, error: "forbidden" }; }
    }),
    tokenProvider: () => "reviewer-token"
  });
  let actionError;
  try {
    await client.authorize("BUSINESS");
  } catch (error) {
    actionError = error;
  }
  assert.equal(actionError?.code, "reviewer_sandbox_response_invalid");
  assert.deepEqual(gate5a.reduceReviewerAuthenticationAfterError({
    authenticated: true,
    companyVerified: true,
    canonicalToken: "reviewer-token"
  }, {
    code: actionError.code,
    hostname: gate5a.STAGING_HOSTNAME,
    storage
  }), {
    handled: false,
    tokenRemoved: false,
    authenticated: true,
    companyVerified: true,
    canonicalToken: "reviewer-token"
  });
  assert.equal(storage.getItem("omascote_token"), "reviewer-token");
});

test("HTTP sandbox client refuses production origin and unsafe envelopes", async () => {
  assert.throws(
    () => gate5a.createHttpSandboxClient({
      apiBase: gate5a.PRODUCTION_API_ORIGIN,
      fetchImpl: async () => ({ ok: true }),
      tokenProvider: () => "token"
    }),
    (error) => error.code === "reviewer_sandbox_origin_forbidden"
  );

  const client = gate5a.createHttpSandboxClient({
    apiBase: gate5a.STAGING_API_ORIGIN,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          ok: true,
          sandbox: true,
          externalCalls: 1,
          state: gate5a.createInitialState()
        };
      }
    }),
    tokenProvider: () => "token"
  });
  await assert.rejects(
    client.getState(),
    (error) => error.code === "reviewer_sandbox_response_invalid"
  );
});

test("normalizer rejects non-synthetic connected accounts and unsafe published proof", () => {
  const unsafeAccount = connectedState();
  unsafeAccount.connection.account.synthetic = false;
  assert.throws(
    () => gate5a.normalizeState(unsafeAccount),
    (error) => error.code === "reviewer_sandbox_account_invalid"
  );

  let unsafeProof = gate5a.transitionState(
    readyToPublishState(),
    { type: "START_PUBLISH" },
    fixedNow
  );
  unsafeProof = gate5a.transitionState(
    unsafeProof,
    { type: "ADVANCE_PUBLISH", publicationId: unsafeProof.publication.id },
    fixedNow
  );
  unsafeProof = gate5a.transitionState(
    unsafeProof,
    { type: "ADVANCE_PUBLISH", publicationId: unsafeProof.publication.id },
    fixedNow
  );
  unsafeProof.publication.details.permalink = "https://example.com/unsafe";
  assert.throws(
    () => gate5a.normalizeState(unsafeProof),
    (error) => error.code === "reviewer_sandbox_publication_invalid"
  );
});

test("normalizer accepts the exact backend sandbox shape and binds its internal proof", () => {
  const backendState = {
    sandbox: true,
    externalCalls: 0,
    company: {
      label: "Empresa autenticada pelo backend",
      controlled: true
    },
    stage: "publication_published",
    authorization: {
      status: "authorization_completed",
      callbackSanitized: true
    },
    connection: {
      status: "connected",
      account: {
        accountId: "synthetic-account-11111111-1111-4111-8111-111111111111",
        username: "@empresa_sintetica",
        accountType: "BUSINESS",
        professional: true,
        synthetic: true
      },
      error: null,
      tokenPhysicallyDeleted: false
    },
    media: {
      selected: true,
      item: {
        asset: gate5a.CONTROLLED_ASSET_ID,
        fileName: "ia4tube-review-controlado.jpg",
        mimeType: "image/jpeg",
        width: 1080,
        height: 1080,
        assetPath: "/social/controlled-review.jpg",
        caption: "Publicação sintética controlada.",
        synthetic: true
      }
    },
    publication: {
      state: "published",
      attempts: 1,
      details: {
        publicationId: gate5a.SYNTHETIC_PUBLICATION_ID,
        mediaId: "synthetic-media-11111111-1111-4111-8111-111111111111",
        publishedAt: fixedNow,
        reference: "synthetic-review:11111111-1111-4111-8111-111111111111",
        permalink: gate5a.SYNTHETIC_PERMALINK,
        synthetic: true
      }
    },
    history: [{
      publicationId: gate5a.SYNTHETIC_PUBLICATION_ID,
      state: "published",
      attempts: 1,
      mediaId: "synthetic-media-11111111-1111-4111-8111-111111111111",
      publishedAt: fixedNow,
      reference: "synthetic-review:11111111-1111-4111-8111-111111111111",
      permalink: gate5a.SYNTHETIC_PERMALINK,
      synthetic: true
    }],
    deletion: {
      status: "not_requested",
      technicalConnectionDataDeleted: false,
      commercialHistoryPolicy: "owner_decision_pending"
    }
  };
  const normalized = gate5a.normalizeState(backendState);
  assert.equal(normalized.stage, "publication");
  assert.deepEqual(normalized.company, {
    label: "Empresa autenticada pelo backend",
    controlled: true
  });
  assert.equal(normalized.connection.account.username, "empresa_sintetica");
  assert.equal(normalized.media.item.assetPath, "/social/controlled-review.jpg");
  assert.equal(normalized.publication.id, gate5a.SYNTHETIC_PUBLICATION_ID);
  assert.equal(normalized.publication.details.publicationId, normalized.publication.id);
  assert.equal(normalized.history[0].id, gate5a.SYNTHETIC_PUBLICATION_ID);

  backendState.media.item.assetPath = "https://example.invalid/customer-image.jpg";
  assert.equal(gate5a.normalizeState(backendState).media.item.assetPath, "");
});

test("normalizer requires an authenticated controlled company from the backend", () => {
  const state = gate5a.createInitialState();
  for (const company of [
    undefined,
    { label: "Empresa autenticada", controlled: false },
    { label: "", controlled: true },
    { label: "Empresa autenticada", controlled: true, companyId: "forbidden" }
  ]) {
    const candidate = { ...state, company };
    assert.throws(
      () => gate5a.normalizeState(candidate),
      (error) => error.code === "reviewer_sandbox_company_invalid"
    );
  }
});

test("deletion protocol accepts only the opaque code and canonical status route", () => {
  const confirmationCode = opaqueReturnReference;
  const statusUrl = `${gate5a.STAGING_API_ORIGIN}/v1/social/compliance/meta/` +
    `data-deletion/status/${confirmationCode}`;
  const candidate = {
    ...gate5a.createInitialState(),
    connection: {
      status: "deleted",
      account: null,
      error: null,
      tokenPhysicallyDeleted: true
    },
    deletion: {
      status: "completed",
      requestStatus: "completed",
      confirmationCode,
      statusUrl,
      technicalConnectionDataDeleted: true,
      commercialHistoryPolicy: "owner_decision_pending"
    }
  };
  const normalized = gate5a.normalizeState(candidate);
  assert.equal(normalized.deletion.confirmationCode, confirmationCode);
  assert.equal(normalized.deletion.requestStatus, "completed");
  assert.equal(normalized.deletion.statusUrl, statusUrl);

  assert.throws(
    () => gate5a.normalizeState({
      ...candidate,
      deletion: {
        ...candidate.deletion,
        statusUrl: `https://example.invalid/status/${confirmationCode}`
      }
    }),
    (error) => error.code === "reviewer_deletion_status_url_invalid"
  );
  assert.throws(
    () => gate5a.normalizeState({
      ...candidate,
      deletion: {
        ...candidate.deletion,
        statusUrl: `${statusUrl}?company_id=forbidden`
      }
    }),
    (error) => error.code === "reviewer_deletion_status_url_invalid"
  );
  assert.throws(
    () => gate5a.normalizeState({
      ...candidate,
      deletion: {
        ...candidate.deletion,
        statusUrl: `${gate5a.LOCAL_API_ORIGIN}/v1/social/compliance/meta/` +
          `data-deletion/status/${confirmationCode}`
      }
    }, gate5a.STAGING_API_ORIGIN),
    (error) => error.code === "reviewer_deletion_status_url_invalid"
  );
});

test("app contract mounts canonical reviewer UI before ordinary application boot", () => {
  assert.match(appSource, /<script src="gate5a-reviewer-flow\.js"><\/script>/);
  assert.match(appSource, /id="gate5aReviewerRoot"/);
  assert.match(appSource, /mountReviewerApp/);
  assert.match(appSource, /resolveApiBase\(location\.hostname\)/);
  assert.match(appSource, /window\.IA4_GATE5A_REVIEWER_ACTIVE\s*\?\s*null/);
  assert.match(appSource, /gate5a-reviewer-active/);
  assert.match(appSource, /sanitizeCanonicalLoginHandoffUrl\(window\)/);
  assert.match(appSource, /readCanonicalLoginHandoff\(window\)/);
  assert.match(appSource, /completeCanonicalLoginHandoff\(window\)/);
  assert.match(
    appSource,
    /readCanonicalLoginHandoff\(window\)[\s\S]{0,700}acaoDepoisDoCadastro\s*=\s*\(\)=>\{[\s\S]{0,300}completeCanonicalLoginHandoff\(window\)[\s\S]{0,300}abrirLoginVisitanteModal\(\)/
  );
  assert.ok(
    (appSource.match(/const acao = acaoDepoisDoCadastro;/g) || []).length >= 2,
    "login por senha e login Google devem consumir a ação de retorno canônica"
  );
  assert.match(
    helperSource,
    /if \(authenticated\) \{\s*run\(\s*\(\) => client\.getState\(\)/
  );
  assert.match(
    helperSource,
    /authenticationRecovery\.handled\)[\s\S]{0,220}authenticated = authenticationRecovery\.authenticated;[\s\S]{0,220}companyVerified = authenticationRecovery\.companyVerified;[\s\S]{0,220}canonicalToken = authenticationRecovery\.canonicalToken;/
  );
  assert.match(
    appSource,
    /if\(!window\.IA4_GATE5A_REVIEWER_ACTIVE\)\{\s*ia4IniciarEventos\(\);/
  );
  assert.ok(
    appSource.indexOf("installEarlyGuard(window)") <
      appSource.indexOf("googletagmanager.com")
  );
});

test("reviewer helper contains the complete non-admin journey and no real provider path", () => {
  for (const required of [
    "Visão geral",
    "Conectar Instagram",
    "Entre para iniciar a revisão",
    "Empresa autenticada e controlada",
    "Retorno seguro",
    "Estamos confirmando sua conta (sandbox)",
    "Conta conectada",
    "Revisar JPEG",
    "sending",
    "provider_confirming",
    "published",
    "Publicado no Instagram (simulado)",
    "Media ID",
    "Permalink seguro",
    "Histórico de publicações",
    "Desconectar Instagram",
    "Excluir dados da conexão",
    "A credencial de acesso e os dados técnicos elegíveis da conexão foram excluídos. A conexão permaneceu revogada. Suas artes, imagens, legendas e histórico continuam salvos.",
    "Acompanhar status do pedido",
    "data-g5a-field=\"deletionConfirmationCode\"",
    "rel=\"noopener noreferrer\""
  ]) {
    assert.ok(helperSource.includes(required), `Texto obrigatório ausente: ${required}`);
  }
  for (const forbidden of [
    "/auth/login",
    "media_publish",
    "graph.instagram.com",
    "www.instagram.com/p/",
    "produtos/resultado.jpg",
    "Conta, credencial e mídia foram removidas",
    "ia4tube_empresas",
    "Dcli_JWGv25",
    "17841476573931958",
    "gate4"
  ]) {
    assert.equal(
      helperSource.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `Referência real/proibida encontrada: ${forbidden}`
    );
  }
});

test("real reviewer allowlist accepts only GET and POST on the exact media route", () => {
  const exact = new URL(
    `${gate5a.STAGING_API_ORIGIN}/v1/social/reviewer/media`
  );
  assert.equal(gate5a.realReviewerRequestAllowed(exact, "GET"), true);
  assert.equal(gate5a.realReviewerRequestAllowed(exact, "POST"), true);
  assert.equal(gate5a.realReviewerRequestAllowed(exact, "PUT"), false);
  assert.equal(gate5a.realReviewerRequestAllowed(
    new URL(`${exact}?unexpected=1`),
    "POST"
  ), false);
  assert.equal(gate5a.realReviewerRequestAllowed(
    new URL(`${exact}/unexpected`),
    "POST"
  ), false);
});

test("real reviewer template exposes the app-like JPEG preparation surface", () => {
  const html = gate5a.realReviewerTemplate();
  for (const expected of [
    "IA4Tube · Revisão oficial do Instagram",
    "gate5aBrandMark",
    "data-real-upload-input",
    'accept=".jpg,.jpeg,image/jpeg"',
    "data-real-upload-preview",
    "data-real-upload-caption",
    'maxlength="2150"',
    "Somente JPEG 1080 × 1080 · máximo de 8 MB",
    'data-real-action="upload-media"',
    "Adicionar à revisão"
  ]) {
    assert.ok(html.includes(expected), `Contrato visual ausente: ${expected}`);
  }
  assert.match(appSource, /body\.gate5a-reviewer-real\s*\{/);
  assert.match(appSource, /background-color:#020202 !important/);
  assert.match(appSource, /\.gate5a-reviewer-real \.gate5aReviewerHeader/);
  assert.match(appSource, /#ffd76a/i);
});

test("real reviewer client uploads exactly jpeg and caption as multipart", async () => {
  class FakeFormData {
    constructor() {
      this.parts = [];
    }
    append(name, value, fileName) {
      this.parts.push({ name, value, fileName });
    }
  }
  const requests = [];
  const jpeg = Object.freeze({
    name: "ia4tube-review.jpg",
    type: "image/jpeg",
    size: 1024
  });
  const caption = "Publicação controlada da IA4Tube.";
  const uploaded = Object.freeze({
    id: `reviewer-jpeg:${"a".repeat(64)}`,
    fileName: "preview_ia4tube.jpg",
    mimeType: "image/jpeg",
    width: 1080,
    height: 1080,
    thumbnailUrl: `${gate5a.STAGING_API_ORIGIN}/v1/social/reviewer/media-capability/test`,
    caption: `${caption}\n\n#IA4Tube #IA4TubeReview_TEST`,
    owner: "Empresa autenticada"
  });
  const client = gate5a.createHttpRealReviewerClient({
    apiBase: gate5a.STAGING_API_ORIGIN,
    tokenProvider: () => "reviewer-session",
    FormDataImpl: FakeFormData,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 201,
        async json() {
          return {
            ok: true,
            contentOwnerDerivedFromSession: true,
            media: uploaded
          };
        }
      };
    }
  });

  const result = await client.uploadMedia(jpeg, caption);
  assert.equal(result.media, uploaded);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    `${gate5a.STAGING_API_ORIGIN}/v1/social/reviewer/media`
  );
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, "Bearer reviewer-session");
  assert.equal(requests[0].init.headers["Content-Type"], undefined);
  assert.ok(requests[0].init.body instanceof FakeFormData);
  assert.deepEqual(
    requests[0].init.body.parts.map(({ name, fileName }) => ({ name, fileName })),
    [
      { name: "jpeg", fileName: "ia4tube-review.jpg" },
      { name: "caption", fileName: undefined }
    ]
  );
  assert.equal(requests[0].init.body.parts[0].value, jpeg);
  assert.equal(requests[0].init.body.parts[1].value, caption);
});

test("successful upload selects its JPEG without invoking OAuth or publication", () => {
  const start = helperSource.indexOf('} else if (action === "upload-media")');
  const end = helperSource.indexOf('} else if (action === "publish")', start);
  assert.ok(start >= 0 && end > start, "ramo dedicado de upload deve existir");
  const uploadBranch = helperSource.slice(start, end);
  assert.match(uploadBranch, /client\.uploadMedia\(file, caption\)/);
  assert.match(uploadBranch, /selectedMediaId:\s*uploaded\.id/);
  assert.match(uploadBranch, /media:\s*nextMedia/);
  assert.equal(uploadBranch.includes("client.publish"), false);
  assert.equal(uploadBranch.includes("client.authorize"), false);
  assert.equal(uploadBranch.includes("location.assign"), false);
});
