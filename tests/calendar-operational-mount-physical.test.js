"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createOperationalCalendarPipelineFixture, PREFIX, hash } = require("./helpers/operational-calendar-pipeline-fixture");
const { isOperationalCalendarImportsRuntime } = require("../src/social/calendar/imports/operational-runtime");
test("physical operational composer mounts authenticated metadata and opaque TCP bytes without decoding in GET", async t => {
  const f = await createOperationalCalendarPipelineFixture(t), runtime = f.current().imports;
  assert.equal(isOperationalCalendarImportsRuntime(runtime), true);
  const caps = await (await f.request(`${PREFIX}/capabilities`)).json();
  assert.equal(caps.enabled, true); assert.equal(caps.localSimulation, true);
  assert.deepEqual(caps.identity, { companyId: f.context.companyId, userId: f.context.userId });
  assert.deepEqual(caps.musicTracks, []);
  const denied = await (await f.request(`${PREFIX}/capabilities`, { headers: { Authorization: `Bearer ${f.otherToken}` } })).json();
  assert.equal(denied.enabled, false); assert.equal(denied.identity, undefined);
  assert.throws(() => runtime.contextForPrincipal({ companyId: f.context.companyId, userId: f.context.userId }),
    { code: "calendar_import_runtime_invalid" });
  const bytes = f.originals;
  const startResponse = await f.post(`${PREFIX}/uploads`, { idempotencyKey: crypto.randomUUID(), kind: "image", mimeType: "image/png", sizeBytes: bytes.length, sha256: hash(bytes) });
  assert.equal(startResponse.status, 200);
  const upload = (await startResponse.json()).upload;
  const authorized = await f.post(`${PREFIX}/uploads/${upload.uploadId}/parts/1/authorize`,
    { sha256: hash(bytes), md5Base64: crypto.createHash("md5").update(bytes).digest("base64") });
  assert.equal(authorized.status, 200); const part = (await authorized.json()).part;
  const resolved = await f.post(`${PREFIX}/uploads/${upload.uploadId}/parts/1/resolve`, { authorizationId: part.authorizationId });
  assert.equal(resolved.status, 200); const grant = (await resolved.json()).grant;
  assert.equal(new URL(grant.url).origin, "https://ia4tube-api.onrender.com");
  const body = await fetch(f.base + new URL(grant.url).pathname, { method: "PUT", body: bytes,
    headers: { ...grant.headers, "content-type": "application/octet-stream" } });
  assert.equal(body.status, 200); assert.equal((await body.json()).ok, true);
  const durable = (await f.snapshot()).uploads[upload.uploadId];
  assert.equal(durable.disk.parts["1"].sha256, hash(bytes));
  const resumed = await f.post(`${PREFIX}/uploads/${upload.uploadId}/resume`, {});
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).upload.completedParts[0].sha256, hash(bytes));
  await f.request(`${PREFIX}/uploads/${upload.uploadId}`);
  await f.request("/v1/social/calendar");
  assert.equal(f.counters.inspectionSourceReads, 0); assert.equal(f.counters.preparationSourceReads, 0);
  assert.equal(f.providerCalls.length, 0);
  const cancel = await f.post(`${PREFIX}/uploads/${upload.uploadId}/cancel`, {});
  assert.equal(cancel.status, 200);
  const after = (await f.snapshot()).uploads[upload.uploadId]; assert.equal(after.state, "cancelled");
  t.diagnostic("COMPOSER=OPERATIONAL_BRANDED; PG=REAL; BYTE_ROUTE=TCP_LOOPBACK; GET_DECODES=0; PROVIDER_CALLS=0");
});
