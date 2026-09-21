"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const express = require("express");
const { createProductionSession } = require("../src/social/production-session");
const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const { createCalendarImportRouter } = require("../src/social/calendar/imports/router");
const uploadId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const grantId = "33333333-3333-4333-8333-333333333333";
const sha256 = "a".repeat(64), md5Base64 = Buffer.alloc(16, 1).toString("base64");
async function setup(t, patch = {}) {
  const clients = { "fixture-a": { ativo: true }, "fixture-b": { ativo: true } };
  const session = createProductionSession({ secret: crypto.randomBytes(40).toString("hex"), readClients: () => clients });
  const auth = createSocialAuthAdapter({ namespaceUuid: crypto.randomUUID(), key: crypto.randomBytes(32), derivationVersion: "fixture-v1" });
  const calls = [];
  const upload = Object.fromEntries(["start", "status", "resume", "complete", "cancel", "authorizePart", "resolvePart"].map(name => [name,
    async (context, input) => { calls.push({ name, context, input }); return { uploadId, assetId, state: "uploading", ...input }; }]));
  const service = { ready: true, allowed: () => true, capabilities: () => ({ enabled: true, scheduling: { enabled: false } }), upload,
    preparation: { request: async (context, input) => { calls.push({ name: "prepare", context, input }); return { assetId, status: "queued" }; },
      status: async () => ({ assetId, status: "ready" }) }, ...patch };
  const app = express();
  app.use("/v1/social/calendar/imports", createCalendarImportRouter({ authenticate: session.authenticate,
    resolvePrincipal: patch.resolvePrincipal || (claims => auth.fromVerifiedJwt(claims)), getService: () => patch.absent ? null : service,
    logger: patch.logger, monotonicClock: patch.monotonicClock, diagnosticSlowMs: patch.diagnosticSlowMs }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1/social/calendar/imports`;
  const headers = owner => ({ Authorization: `Bearer ${session.sign(owner)}`, "Content-Type": "application/json" });
  const request = (path, data, extra = {}) => fetch(base + path, { method: data === undefined ? "GET" : "POST",
    headers: headers("fixture-a"), ...(data === undefined ? {} : { body: JSON.stringify(data) }), ...extra });
  return { base, headers, request, calls, clients, service };
}
test("import routes require actual signed current-owner session even when disabled", async t => {
  const f = await setup(t, { absent: true });
  assert.equal((await fetch(f.base + "/capabilities")).status, 401);
  assert.deepEqual(await (await f.request("/capabilities")).json(), { ok: true, enabled: false });
  assert.equal((await f.request("/uploads", {})).status, 503);
  const headers = f.headers("fixture-a"); f.clients["fixture-a"].ativo = false;
  assert.equal((await fetch(f.base + "/capabilities", { headers })).status, 401);
  assert.equal(f.calls.length, 0);
});
test("unbranded fabricated identity and nonpilot owners cannot obtain grants", async t => {
  const f = await setup(t, { resolvePrincipal: () => ({ companyId: uploadId, userId: assetId }) });
  assert.equal((await f.request("/uploads/" + uploadId)).status, 401);
  const denied = await setup(t, { allowed: () => false });
  assert.deepEqual(await (await denied.request("/capabilities")).json(), { ok: true, enabled: false });
  assert.equal((await denied.request(`/uploads/${uploadId}/parts/1/resolve`, { authorizationId: grantId })).status, 503);
  assert.equal(denied.calls.length, 0);
});
test("HTTP owner is derived from JWT; user, company and arbitrary metadata bodies rejected", async t => {
  const f = await setup(t);
  const input = { idempotencyKey: "fixture-request", kind: "image", mimeType: "image/jpeg", sizeBytes: 20, sha256 };
  const one = await f.request("/uploads", input), two = await f.request("/uploads", input, { headers: f.headers("fixture-b") });
  assert.equal(one.status, 200); assert.equal(two.status, 200);
  assert.notEqual(f.calls[0].context.companyId, f.calls[1].context.companyId);
  assert.notEqual(f.calls[0].context.userId, f.calls[1].context.userId);
  assert.equal(f.calls[0].context.authenticated, true);
  for (const extra of [{ companyId: uploadId }, { userId: assetId }, { objectKey: "foreign" }, { authenticated: true }]) {
    assert.equal((await f.request("/uploads", { ...input, ...extra })).status, 400);
  }
  assert.equal(f.calls.length, 2);
});
test("part grant requires exact path, checksum contract, no-store and original owner", async t => {
  const f = await setup(t);
  const response = await f.request(`/uploads/${uploadId}/parts/1/authorize`, { sha256, md5Base64 });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await response.json()).part.partNumber, 1);
  assert.deepEqual(f.calls[0].input, { uploadId, partNumber: 1, sha256, md5Base64 });
  for (const n of ["0", "01", "-1", "1e1", "1.0", "1000"]) {
    assert.equal((await f.request(`/uploads/${uploadId}/parts/${n}/authorize`, { sha256, md5Base64 })).status, 400);
  }
  assert.equal((await f.request(`/uploads/${uploadId}/parts/1/authorize`, { sha256 })).status, 400);
  const resolve = await f.request(`/uploads/${uploadId}/parts/1/resolve`, { authorizationId: grantId });
  assert.equal(resolve.status, 200); assert.equal((await resolve.json()).grant.authorizationId, grantId);
  assert.equal((await f.request(`/uploads/${uploadId}/parts/1/resolve`)).status, 404);
});
test("metadata endpoints reject media bodies, malformed JSON, arrays and cross-origin requests", async t => {
  const f = await setup(t);
  assert.equal((await f.request("/uploads", {} , { headers: { ...f.headers("fixture-a"), "Content-Type": "video/mp4" }, body: Buffer.alloc(30) })).status, 415);
  assert.equal((await f.request("/uploads", { ignored: "a".repeat(17 * 1024) })).status, 413);
  assert.equal((await f.request("/uploads", [], {})).status, 400);
  assert.equal((await f.request("/uploads", {}, { body: "{" })).status, 400);
  assert.equal((await f.request("/uploads", {}, { headers: { ...f.headers("fixture-a"), Origin: "https://foreign.invalid" } })).status, 403);
  assert.equal((await f.request("/capabilities?authorization=secret")).status, 400);
  assert.equal(f.calls.length, 0);
});
test("completion and cancellation are never retried by HTTP after an uncertain result", async t => {
  const f = await setup(t); let calls = 0;
  f.service.upload.complete = async () => { calls++; throw new Error("sentinel-url-token-database-password"); };
  const result = await f.request(`/uploads/${uploadId}/complete`, {});
  assert.equal(result.status, 503); assert.equal(calls, 1);
  assert.doesNotMatch(await result.text(), /sentinel|password|token|database/);
  for (const action of ["resume", "cancel"]) {
    assert.equal((await f.request(`/uploads/${uploadId}/${action}`, {})).status, 200);
  }
  assert.deepEqual(f.calls.map(c => c.name), ["resume", "cancel"]);
});
test("preparation is explicit and metadata-only; no scheduling or external publication route", async t => {
  const f = await setup(t);
  const input = { uploadId, expectedMediaRevision: 0, idempotencyKey: "fixture-preparation", selection: { kind: "image", targets: ["feed"], audioMode: "none" } };
  const response = await f.request(`/assets/${assetId}/prepare`, input);
  assert.equal(response.status, 200); assert.equal((await response.json()).asset.status, "queued");
  assert.deepEqual(f.calls[0].input, { ...input, assetId });
  assert.equal((await f.request(`/assets/${assetId}`)).status, 200);
  for (const path of ["/schedule", "/publish", "/connect", "/dispatch"]) assert.equal((await f.request(path, {})).status, 404);
  assert.equal(f.calls.length, 1);
});
test("capability and prepare diagnostics expose only closed stages and elapsed time", async t => {
  const capabilityEvents = [], capabilityTimes = [0, 300, 300, 700];
  const first = await setup(t, { logger: { error: value => capabilityEvents.push(value) },
    monotonicClock: () => capabilityTimes.shift(), diagnosticSlowMs: 250 });
  assert.equal((await first.request("/capabilities")).status, 200);
  assert.deepEqual(capabilityEvents, [
    { component: "calendar_media_http", code: "calendar_media_http_slow", stage: "principal_resolution", elapsedMs: 300 },
    { component: "calendar_media_http", code: "calendar_media_http_slow", stage: "capability_read", elapsedMs: 400 }
  ]);

  const prepareEvents = [], prepareTimes = [0, 251, 251, 752];
  const second = await setup(t, { logger: { error: value => prepareEvents.push(value) },
    monotonicClock: () => prepareTimes.shift(), diagnosticSlowMs: 250 });
  const input = { uploadId, expectedMediaRevision: 0, idempotencyKey: "fixture-observed-preparation",
    selection: { kind: "image", targets: ["feed"], audioMode: "none" } };
  assert.equal((await second.request(`/assets/${assetId}/prepare`, input)).status, 200);
  assert.deepEqual(prepareEvents, [
    { component: "calendar_media_http", code: "calendar_media_http_slow", stage: "principal_resolution", elapsedMs: 251 },
    { component: "calendar_media_http", code: "calendar_media_http_slow", stage: "prepare_transaction", elapsedMs: 501 }
  ]);
  assert.doesNotMatch(JSON.stringify(prepareEvents), new RegExp(`${assetId}|${uploadId}|fixture-observed`));
});
test("failed observed operation never logs the error message and logger failures stay non-fatal", async t => {
  const events = [], times = [0, 0, 0, 7];
  const first = await setup(t, { capabilities: () => { throw new Error("sentinel-token-password-url"); },
    logger: { error: value => events.push(value) }, monotonicClock: () => times.shift() });
  assert.equal((await first.request("/capabilities")).status, 503);
  assert.deepEqual(events, [{ component: "calendar_media_http", code: "calendar_media_http_failed", stage: "capability_read", elapsedMs: 7 }]);
  assert.doesNotMatch(JSON.stringify(events), /sentinel|token|password|url/);

  const secondTimes = [0, 300, 300, 700];
  const second = await setup(t, { logger: { error() { throw new Error("logger-failed"); } },
    monotonicClock: () => secondTimes.shift(), diagnosticSlowMs: 250 });
  assert.equal((await second.request("/capabilities")).status, 200);
});
