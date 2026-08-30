"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const express = require("express");

const {
  createInstagramOAuthRouter
} = require("../src/social/oauth/instagram-oauth-router");
const {
  createInstagramOAuthVisualReturn
} = require("../src/social/oauth/instagram-oauth-visual-return");

const connectionId = "11111111-1111-4111-8111-111111111111";

function deterministicBytes(length) {
  return Buffer.alloc(length, 0x41);
}

function fakeService() {
  return {
    async callback(input) {
      if (input.code === "cancel") {
        const error = new Error("cancelled");
        error.code = "social_oauth_state_cancelled";
        throw error;
      }
      if (input.code === "expired") {
        const error = new Error("expired");
        error.code = "social_oauth_state_expired";
        throw error;
      }
      if (input.code === "personal") {
        const error = new Error("personal");
        error.code = "invalid_account_type";
        throw error;
      }
      return {
        ok: true,
        provider: "instagram",
        status: "authorization_completed",
        connectionId,
        connectionState: "connected",
        username: "@synthetic_business",
        accountType: "business",
        returnPathId: "social_connections"
      };
    },
    async authorize() {
      throw new Error("not used");
    }
  };
}

async function fixture(t) {
  let byte = 0x40;
  const visualReturn = createInstagramOAuthVisualReturn({
    publicOrigin: "https://ia4tube-api-staging-checkpoint-a.onrender.com",
    randomBytes(length) {
      byte += 1;
      return Buffer.alloc(length, byte);
    }
  });
  const app = express();
  app.use("/v1/social", createInstagramOAuthRouter({
    authenticate(_req, _res, next) {
      return next();
    },
    getService: fakeService,
    visualReturn
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    visualReturn.destroy();
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  });
  return server.address().port;
}

function request(port, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: route,
      method: "GET",
      headers
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("browser callback redirects to a sanitized internal URL and opaque status", async (t) => {
  const port = await fixture(t);
  const callback = await request(
    port,
    "/v1/social/oauth/callback?state=private-state&code=private-code",
    { Accept: "text/html,application/xhtml+xml" }
  );
  assert.equal(callback.status, 303);
  assert.equal(callback.headers["referrer-policy"], "no-referrer");
  const location = new URL(callback.headers.location);
  assert.equal(
    location.origin,
    "https://ia4tube-api-staging-checkpoint-a.onrender.com"
  );
  assert.equal(location.pathname, "/app.html");
  assert.equal(location.searchParams.has("code"), false);
  assert.equal(location.searchParams.has("state"), false);
  assert.equal(location.searchParams.has("access_token"), false);
  assert.match(location.searchParams.get("return_ref"), /^[A-Za-z0-9_-]{32}$/);

  const status = await request(
    port,
    `/v1/social/oauth/return/${encodeURIComponent(location.searchParams.get("return_ref"))}`,
    { Accept: "application/json" }
  );
  assert.equal(status.status, 200);
  const payload = JSON.parse(status.body);
  assert.deepEqual(payload, {
    ok: true,
    provider: "instagram",
    status: "authorization_completed",
    connectionId,
    code: null,
    callbackSanitized: true
  });
  assert.equal(status.body.includes("private-code"), false);
  assert.equal(status.body.includes("private-state"), false);
});

test("JSON API callback remains compatible for non-browser consumers", async (t) => {
  const port = await fixture(t);
  const callback = await request(
    port,
    "/v1/social/oauth/callback?state=api-state&code=api-code",
    { Accept: "application/json" }
  );
  assert.equal(callback.status, 200);
  const payload = JSON.parse(callback.body);
  assert.equal(payload.status, "authorization_completed");
  assert.equal(payload.connectionId, connectionId);
  assert.equal(callback.headers.location, undefined);
});

for (const [code, expectedStatus, expectedCode] of [
  ["cancel", "authorization_cancelled", "social_oauth_state_cancelled"],
  ["expired", "authorization_expired", "social_oauth_state_expired"],
  ["personal", "authorization_failed", "invalid_account_type"]
]) {
  test(`browser callback exposes sanitized ${expectedStatus} state`, async (t) => {
    const port = await fixture(t);
    const callback = await request(
      port,
      `/v1/social/oauth/callback?state=opaque-state&code=${code}`,
      { Accept: "text/html" }
    );
    assert.equal(callback.status, 303);
    const location = new URL(callback.headers.location);
    assert.equal(location.searchParams.has("code"), false);
    assert.equal(location.searchParams.has("state"), false);
    const status = await request(
      port,
      `/v1/social/oauth/return/${location.searchParams.get("return_ref")}`
    );
    assert.equal(status.status, 200);
    const payload = JSON.parse(status.body);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, expectedStatus);
    assert.equal(payload.code, expectedCode);
    assert.equal(payload.connectionId, null);
  });
}

test("opaque callback status expires and becomes unavailable", () => {
  let current = Date.parse("2026-08-30T12:00:00.000Z");
  const visualReturn = createInstagramOAuthVisualReturn({
    publicOrigin: "https://ia4tube-api-staging-checkpoint-a.onrender.com",
    clock: () => current,
    randomBytes: deterministicBytes,
    ttlMs: 60 * 1000
  });
  const reference = visualReturn.recordError("social_oauth_state_cancelled");
  assert.equal(visualReturn.get(reference).status, "authorization_cancelled");
  current += 60 * 1000;
  assert.equal(visualReturn.get(reference), null);
  visualReturn.destroy();
});
