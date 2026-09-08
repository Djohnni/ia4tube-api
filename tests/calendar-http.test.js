"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const express = require("express");
const { createProductionSession } = require("../src/social/production-session");
const { createCalendarRouter } = require("../src/social/calendar/router");
const { assertProductionPreparationBoundary } = require("../src/social/production-integration");

async function surface(t, getService) {
  const session = createProductionSession({ secret: crypto.randomBytes(48).toString("hex"),
    readClients: () => ({ "synthetic-a": { ativo: true }, "synthetic-b": { ativo: true } }) });
  const app = express(); app.use(express.json({ limit: "16kb" }));
  app.use("/v1/social/calendar", createCalendarRouter({ authenticate: session.authenticate, getService }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}/v1/social/calendar`,
    headers: owner => ({ Authorization: `Bearer ${session.sign(owner)}`, "Content-Type": "application/json" }) };
}

test("calendar HTTP authenticates real production sessions; request body cannot replace the owner; failures stay sanitized", async t => {
  const owners = [];
  const service = {
    async list(claims) { owners.push(claims.sub); return { ok: true, items: [], owner: claims.sub }; },
    async edit(claims, id) {
      owners.push(claims.sub);
      if (id !== crypto.createHash("sha256").update(claims.sub).digest("hex").slice(0, 40)) {
        throw Object.assign(new Error("sentinel-private-database-content"), { code: "calendar_not_found", statusCode: 404 });
      }
      return { ok: true };
    },
    async image() { throw new Error("sentinel-private-file-path"); }
  };
  const f = await surface(t, () => service);
  assert.equal((await fetch(f.base)).status, 401);
  const a = await fetch(f.base, { headers: f.headers("synthetic-a") });
  assert.equal((await a.json()).owner, "synthetic-a");
  const b = await fetch(f.base, { headers: f.headers("synthetic-b") });
  assert.equal((await b.json()).owner, "synthetic-b");
  const foreignId = crypto.createHash("sha256").update("synthetic-b").digest("hex").slice(0, 40);
  const foreign = await fetch(`${f.base}/items/${foreignId}`, { method: "POST", headers: f.headers("synthetic-a"),
    body: JSON.stringify({ company_id: "synthetic-b", action: "cancel", revision: 1 }) });
  assert.equal(foreign.status, 404); assert.equal((await foreign.json()).code, "calendar_not_found");
  assert.deepEqual(owners, ["synthetic-a", "synthetic-b", "synthetic-a"]);
  const unavailable = await fetch(`${f.base}/items/${foreignId}/image`, { headers: f.headers("synthetic-a") });
  assert.equal(unavailable.status, 503); assert.doesNotMatch(await unavailable.text(), /sentinel|private-file/);
});

test("disabled calendar remains authenticated and read-only; activation requires existing Instagram runtime", async t => {
  const f = await surface(t, () => null);
  assert.equal((await fetch(f.base)).status, 401);
  const read = await fetch(f.base, { headers: f.headers("synthetic-a") });
  assert.deepEqual(await read.json(), { ok: true, enabled: false, items: [], next: null });
  const write = await fetch(`${f.base}/preferences`, { method: "POST", headers: f.headers("synthetic-a"),
    body: JSON.stringify({ enabled: true, revision: 1, confirmed: true }) });
  assert.equal(write.status, 503); assert.equal((await write.json()).code, "calendar_disabled");
  assert.throws(() => assertProductionPreparationBoundary({ ENVIRONMENT: "production",
    PUBLIC_API_BASE_URL: "https://ia4tube-api.onrender.com", SOCIAL_PERSISTENCE_ENABLED: "true",
    SOCIAL_CALENDAR_ENABLED: "true", SOCIAL_INSTAGRAM_ENABLED: "false" }), { code: "social_production_preparation_incomplete" });
});
