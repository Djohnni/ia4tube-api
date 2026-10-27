"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { createCalendarStore } = require("../src/social/calendar/store");
const { freshState, dateTime } = require("../src/social/calendar/model");
const companyId = crypto.randomUUID(), userId = crypto.randomUUID(), role = "ia4tube_social_runtime";
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const immediate = () => new Promise(resolve => setImmediate(resolve));
function fixture({ query, connect, max = 3 } = {}) {
  const calls = [], releases = [], row = { calendar_document: freshState(), import_retention: null, connection: null };
  const client = new EventEmitter();
  client.query = async (sql, values) => {
    calls.push({ sql, values });
    if (query) await query(sql, values);
    return { rows: sql.startsWith("SELECT calendar.document") ? [structuredClone(row)] : [] };
  };
  client.release = error => releases.push(error || null);
  let connects = 0;
  const pool = { options: { max }, async connect() { connects++; return connect ? connect(client) : client; } };
  const store = createCalendarStore({ role, pool });
  return { store, pool, client, calls, releases, row, get connects() { return connects; } };
}
test("media sessions are lazy, close retained handles, and validate fixed scope before acquiring", async () => {
  const f = fixture(); let retained;
  assert.equal(await f.store.withMediaReadSession(companyId, { userId }, session => { retained = session; return 7; }), 7);
  assert.equal(f.connects, 0);
  await assert.rejects(retained.read(), { code: "calendar_media_read_closed" });
  for (const options of [{ userId: "bad" }, { userId, connectionId: "bad" }, { userId, signal: {} }, { userId, extra: true }]) {
    await assert.rejects(f.store.withMediaReadSession(companyId, options, () => {}), { code: "calendar_owner_invalid" });
  }
  await assert.rejects(f.store.withMediaReadSession(companyId, { userId, timeoutMs: 300001 }, () => {}), { code: "calendar_media_read_invalid" });
  assert.equal(f.connects, 0);
});
test("340 fresh block reads use one SELECT each, one scoped read-only transaction, and detached snapshots", async () => {
  const f = fixture();
  await f.store.withMediaReadSession(companyId, { userId }, async ({ read }) => {
    assert.equal(f.connects, 0);
    for (let block = 0; block < 340; block++) {
      f.row.calendar_document.block = block;
      const snapshot = await read(); assert.equal(snapshot.state.block, block); assert.equal(snapshot.connection, null);
      snapshot.state.preferences.enabled = false;
      assert.equal(f.row.calendar_document.preferences.enabled, true);
    }
  });
  assert.equal(f.connects, 1); assert.deepEqual(f.releases, [null]);
  assert.equal(f.calls.filter(call => call.sql.startsWith("SELECT calendar.document")).length, 340);
  assert.equal(f.calls.length, 344);
  assert.equal(f.calls[0].sql, "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
  assert.match(f.calls[1].sql, /^SET LOCAL ROLE "ia4tube_social_runtime"$/);
  assert.equal(f.calls[2].values[0], companyId);
  assert.equal(f.calls.at(-1).sql, "COMMIT");
  assert.equal(f.calls.some(call => /FOR UPDATE|pg_advisory|INSERT INTO|UPDATE ia4tube|DELETE FROM/.test(call.sql)), false);
});
test("all four retention origins and invalid calendar still fail through the existing validators", async () => {
  const assetId = crypto.randomUUID(), request = { assetId, uploadId: crypto.randomUUID(), idempotencyKey: "synthetic-key" };
  const hash = crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const submission = { id: "a".repeat(40), companyId, userId, request, clientHash: "b".repeat(64), requestHash: hash,
    state: "accepted", mediaRevision: 0, envelope: "synthetic", date: "2026-10-28", time: "09:00", scheduledAt: dateTime("2026-10-28", "09:00") };
  // requestHash uses canonical object keys, as the production validator does.
  submission.requestHash = crypto.createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(request).sort()))).digest("hex");
  for (const setup of [state => { state.jobs.other = { import: { assetId } }; },
    state => { state.importSubmissions = { [submission.id]: submission }; },
    state => { state.importedSources = { origins: { [assetId]: {} } }; },
    state => { state.importedSources = { requests: { other: { receipt: { upload: { assetId } } } } }; }]) {
    const f = fixture(); setup(f.row.calendar_document);
    f.row.import_retention = { records: { [assetId]: { phase: "intent" } } };
    await assert.rejects(f.store.withMediaReadSession(companyId, { userId }, ({ read }) => read()), { code: "media_retention_asset_retired" });
    assert.equal(f.calls.at(-1).sql, "ROLLBACK"); assert.deepEqual(f.releases, [null]);
  }
  const f = fixture(); f.row.calendar_document.preferences.enabled = "invalid";
  await assert.rejects(f.store.withMediaReadSession(companyId, { userId }, ({ read }) => read()), { code: "calendar_state_invalid" });
});
test("abort before first read and late pool acquisition release without leaving a scoped client", async () => {
  const pre = fixture(), aborted = new AbortController(); aborted.abort();
  await assert.rejects(pre.store.withMediaReadSession(companyId, { userId, signal: aborted.signal }, () => assert.fail()), { code: "calendar_media_read_aborted" });
  assert.equal(pre.connects, 0);
  const queued = deferred(), f = fixture({ connect: () => queued.promise }), controller = new AbortController();
  const reading = f.store.withMediaReadSession(companyId, { userId, signal: controller.signal }, ({ read }) => read());
  await immediate(); controller.abort(); await assert.rejects(reading, { code: "calendar_media_read_aborted" });
  queued.resolve(f.client); await immediate();
  assert.equal(f.calls.length, 0); assert.equal(f.releases.length, 1); assert.equal(f.releases[0].code, "calendar_media_read_aborted");
});
test("abort interrupts a pending SELECT and discards the connection once", async () => {
  const pending = deferred(), entered = deferred(), controller = new AbortController();
  const f = fixture({ query(sql) { if (sql.startsWith("SELECT calendar.document")) { entered.resolve(); return pending.promise; } } });
  const reading = f.store.withMediaReadSession(companyId, { userId, signal: controller.signal }, ({ read }) => read());
  await entered.promise; controller.abort();
  await assert.rejects(reading, { code: "calendar_media_read_aborted" });
  assert.equal(f.releases.length, 1); assert.equal(f.releases[0].code, "calendar_media_read_aborted");
  pending.reject(new Error("private delayed SQL error")); await immediate();
  assert.equal(f.releases.length, 1); assert.equal(f.calls.some(call => call.sql === "COMMIT"), false);
});
test("SQL and connection-event failures are sanitized and never reused; callback failure rolls back", async () => {
  const f = fixture({ query(sql) { if (sql.startsWith("SELECT calendar.document")) throw new Error("postgres://private-password@private-host/secret"); } });
  await assert.rejects(f.store.withMediaReadSession(companyId, { userId }, ({ read }) => read()), error => {
    assert.equal(error.code, "calendar_media_read_unavailable"); assert.doesNotMatch(error.message, /password|host|secret/); return true;
  });
  assert.equal(f.releases.length, 1); assert.ok(f.releases[0]);
  const g = fixture(), marker = new Error("synthetic caller failure");
  await assert.rejects(g.store.withMediaReadSession(companyId, { userId }, async ({ read }) => { await read(); throw marker; }), error => error === marker);
  assert.equal(g.calls.at(-1).sql, "ROLLBACK"); assert.deepEqual(g.releases, [null]);
  const h = fixture();
  await assert.rejects(h.store.withMediaReadSession(companyId, { userId }, async ({ read }) => {
    await read(); h.client.emit("error", new Error("private socket failure")); await read();
  }), { code: "calendar_media_read_unavailable" });
  assert.equal(h.releases.length, 1);
});
test("session timeout discards a reader and retained handles cannot reopen it", async () => {
  const f = fixture(); let retained;
  await assert.rejects(f.store.withMediaReadSession(companyId, { userId, timeoutMs: 15 }, async session => {
    retained = session; await session.read(); await new Promise(resolve => setTimeout(resolve, 40));
  }), { code: "calendar_media_read_timeout" });
  assert.equal(f.releases.length, 1); assert.equal(f.releases[0].code, "calendar_media_read_timeout");
  await assert.rejects(retained.read(), { code: "calendar_media_read_timeout" });
});
test("a callback cannot finish with an unawaited read or use two concurrent SELECTs", async () => {
  const pending = deferred(), entered = deferred();
  const f = fixture({ query(sql) { if (sql.startsWith("SELECT calendar.document")) { entered.resolve(); return pending.promise; } } });
  await assert.rejects(f.store.withMediaReadSession(companyId, { userId }, async ({ read }) => {
    read().catch(() => {}); await entered.promise;
    await assert.rejects(read(), { code: "calendar_media_read_busy" });
  }), { code: "calendar_media_read_busy" });
  assert.equal(f.releases.length, 1); pending.resolve(); await immediate();
});
test("admission is shared across stores, cancellable while queued, and leaves the last pool slot free", async () => {
  const f = fixture(), secondStore = createCalendarStore({ pool: f.pool, role });
  const started = deferred(), finish = deferred(); let held = 0;
  const holders = [f.store, secondStore].map(store => store.withMediaReadSession(companyId, { userId }, async ({ read }) => {
    await read(); if (++held === 2) started.resolve(); await finish.promise;
  }));
  await started.promise; assert.equal(f.connects, 2);
  const controller = new AbortController();
  const queued = secondStore.withMediaReadSession(companyId, { userId, signal: controller.signal }, ({ read }) => read());
  await immediate(); assert.equal(f.connects, 2); controller.abort();
  await assert.rejects(queued, { code: "calendar_media_read_aborted" });
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(secondStore.withMediaReadSession(companyId, { userId, timeoutMs: 15 }, ({ read }) => read()), { code: "calendar_media_read_timeout" });
  } finally { clearTimeout(keepAlive); }
  assert.equal(f.connects, 2); assert.equal(f.releases.length, 0);
  let admitted = false;
  const third = secondStore.withMediaReadSession(companyId, { userId }, async ({ read }) => { await read(); admitted = true; });
  await immediate(); assert.equal(f.connects, 2); assert.equal(admitted, false);
  finish.resolve(); await Promise.all([...holders, third]);
  assert.equal(admitted, true); assert.equal(f.connects, 3); assert.deepEqual(f.releases, [null, null, null]);
});
test("one-client pools reject immediately and two-client pools admit only one media session", async () => {
  const single = fixture({ max: 1 });
  await assert.rejects(single.store.withMediaReadSession(companyId, { userId }, ({ read }) => read()), { code: "calendar_media_read_unavailable" });
  assert.equal(single.connects, 0);
  const f = fixture({ max: 2 }), started = deferred(), finish = deferred();
  const first = f.store.withMediaReadSession(companyId, { userId }, async ({ read }) => { await read(); started.resolve(); await finish.promise; });
  await started.promise;
  const second = f.store.withMediaReadSession(companyId, { userId }, ({ read }) => read());
  await immediate(); assert.equal(f.connects, 1);
  finish.resolve(); await Promise.all([first, second]); assert.equal(f.connects, 2);
});
