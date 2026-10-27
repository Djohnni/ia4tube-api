"use strict";

// All SQL targets a newly created loopback-only fixture. Space is observed with
// the production guard; no disk filling, injected statfs, or production state.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { createOperationalMediaPostgresFixture } = require("./helpers/operational-media-postgres-fixture");
const { createPostgresGlobalCapacityStore } = require("../src/social/calendar/imports/postgres-global-capacity-store");
const { createGlobalMediaCapacity } = require("../src/social/calendar/imports/global-capacity");
const { createDiskSpaceGuard, assertDiskSpaceEvidence } = require("../src/social/calendar/imports/disk-space-guard");
const context = Object.freeze({ authenticated: true, role: "calendar_media_capacity_coordinator" });
const WAIT_MS = 1200;

test("physical PostgreSQL samples disk space after connection and row-lock waits without weakening admission", {
  skip: !process.env.CALENDAR_OPERATIONAL_MEDIA_TEST_PG_BIN, timeout: 120000
}, async t => {
  const db = await createOperationalMediaPostgresFixture(t);
  const root = path.join(db.root, "synthetic-private-media");
  await fs.mkdir(root, { mode: 0o700 });
  const guard = createDiskSpaceGuard({ rootDirectory: root, enabled: true, marginBytes: 0 });
  const store = createPostgresGlobalCapacityStore({ pool: db.capacityPool });
  assert.equal(await store.verify(), true);
  assert.equal(store.capabilities.transactionalDiskSpaceEvidence, true);
  assert.ok(assertDiskSpaceEvidence(await guard.sample(), { guard }) > 1024 * 1024,
    "Synthetic test needs at least one MiB of available physical space");
  const companyId = await db.addCompany(), userId = crypto.randomUUID();
  const request = (patch = {}) => ({ context, jobId: crypto.randomUUID(), companyId, userId,
    requestDigest: crypto.randomBytes(32).toString("hex"), storageBytes: 100, sourceBytes: 40, ...patch });
  const capacity = (value = store, diskSpaceGuard = guard, limits = {}) => createGlobalMediaCapacity({
    store: value, enabled: true, requireDiskSpaceEvidence: true, diskSpaceGuard, limits });
  const snapshot = async () => (await db.adminPool.query(
    "SELECT document,revision,updated_at FROM ia4tube_calendar.global_media_capacity WHERE singleton=1"
  )).rows[0];
  const api = capacity(), existing = request();
  await api.reserveStorage({ ...existing, diskSpaceEvidence: await guard.sample() });

  function observedPool(connectDelay = 0) {
    const observed = { connects: 0, pid: null };
    return { observed, async connect() {
      observed.connects++;
      if (connectDelay) await delay(connectDelay);
      const client = await db.capacityPool.connect();
      observed.pid = client.processID;
      return client;
    } };
  }

  // This is deliberately unbranded despite copying the capability/method. It
  // must use the original synchronous update path and reject aged evidence.
  function legacyFacade(value) {
    return { ...value, updateWithDiskSpaceEvidence() {
      assert.fail("A copied capability must not activate the branded transaction API");
    } };
  }

  async function behindRealLock(pool, operation) {
    const blocker = await db.adminPool.connect();
    let pending, settled = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT document FROM ia4tube_calendar.global_media_capacity WHERE singleton=1 FOR UPDATE");
      pending = operation().then(value => ({ value }), error => ({ error }))
        .then(result => { settled = true; return result; });
      const deadline = performance.now() + 5000;
      let blocked = false;
      while (!blocked && performance.now() < deadline) {
        if (pool.observed.pid) {
          const state = await db.adminPool.query(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pool.observed.pid]);
          blocked = state.rows[0]?.wait_event_type === "Lock";
        }
        if (settled) break;
        if (!blocked) await delay(25);
      }
      assert.equal(blocked, true, "Reservation must actually wait on a PostgreSQL row lock");
      const waitStarted = performance.now();
      await delay(WAIT_MS);
      assert.equal(settled, false, "Lock must still prevent completion after the caller token expires");
      assert.ok(performance.now() - waitStarted >= 1000);
      await blocker.query("COMMIT");
      return await pending;
    } finally {
      try { await blocker.query("ROLLBACK"); } finally { blocker.release(); }
      if (pending) await pending;
    }
  }

  for (const action of ["reserveStorage", "assertHeld"]) {
    await t.test(`${action} refreshes a real token after more than one second before connect`, async () => {
      const pool = observedPool(WAIT_MS), delayed = capacity(createPostgresGlobalCapacityStore({ pool }));
      const input = action === "reserveStorage" ? request() : existing;
      const before = await snapshot(), diskSpaceEvidence = await guard.sample(), started = performance.now();
      const result = await delayed[action]({ ...input, diskSpaceEvidence });
      assert.ok(performance.now() - started >= 1000);
      assert.throws(() => assertDiskSpaceEvidence(diskSpaceEvidence, { guard }), { code: "disk_space_evidence_stale" });
      assert.equal(result.jobId, input.jobId); assert.equal(result.storageHeld, true);
      assert.equal(pool.observed.connects, 1);
      const after = await snapshot();
      if (action === "assertHeld") assert.deepEqual(after, before);
      else assert.equal(after.document.jobs[input.jobId].heldBytes, input.storageBytes);
    });

    await t.test(`${action} refreshes only after a real PostgreSQL row-lock wait exceeds one second`, async () => {
      const pool = observedPool(), delayed = capacity(createPostgresGlobalCapacityStore({ pool }));
      const input = action === "reserveStorage" ? request() : existing;
      const before = await snapshot();
      let original;
      const outcome = await behindRealLock(pool, async () => {
        original = await guard.sample();
        return delayed[action]({ ...input, diskSpaceEvidence: original });
      });
      if (outcome.error) throw outcome.error;
      assert.throws(() => assertDiskSpaceEvidence(original, { guard }), { code: "disk_space_evidence_stale" });
      assert.equal(outcome.value.jobId, input.jobId); assert.equal(outcome.value.storageHeld, true);
      const after = await snapshot();
      if (action === "assertHeld") assert.deepEqual(after, before);
      else assert.equal(after.document.jobs[input.jobId].heldBytes, input.storageBytes);
    });

    for (const waiting of ["connection", "row lock"]) {
      await t.test(`unbranded ${action} still rejects evidence aged by the ${waiting} wait`, async () => {
        const pool = observedPool(waiting === "connection" ? WAIT_MS : 0);
        const legacy = capacity(legacyFacade(createPostgresGlobalCapacityStore({ pool })));
        const input = action === "reserveStorage" ? request() : existing, before = await snapshot();
        const operation = async () => legacy[action]({ ...input, diskSpaceEvidence: await guard.sample() });
        if (waiting === "row lock") {
          const outcome = await behindRealLock(pool, operation);
          assert.equal(outcome.error?.code, "media_capacity_disk_space_evidence_invalid");
        } else await assert.rejects(operation(), { code: "media_capacity_disk_space_evidence_invalid" });
        assert.deepEqual(await snapshot(), before);
      });
    }
  }

  await t.test("forged, wrong-issuer and already-expired caller evidence are refused before connecting", async () => {
    const pool = observedPool(), strict = capacity(createPostgresGlobalCapacityStore({ pool }));
    const other = createDiskSpaceGuard({ rootDirectory: root, enabled: true, marginBytes: 0 });
    const expired = await guard.sample(); await delay(WAIT_MS);
    const foreign = await other.sample(), before = await snapshot();
    for (const diskSpaceEvidence of [{}, structuredClone(foreign), foreign, expired]) {
      await assert.rejects(strict.reserveStorage({ ...request(), diskSpaceEvidence }), { code: "media_capacity_disk_space_evidence_invalid" });
      await assert.rejects(strict.assertHeld({ ...existing, diskSpaceEvidence }), { code: "media_capacity_disk_space_evidence_invalid" });
    }
    assert.equal(pool.observed.connects, 0);
    assert.deepEqual(await snapshot(), before);
  });

  await t.test("each transaction receives its own real evidence and asynchronous callbacks cannot commit", async () => {
    const tokens = [], before = await snapshot();
    for (let index = 0; index < 2; index++) {
      await store.updateWithDiskSpaceEvidence((state, evidence) => {
        assert.ok(assertDiskSpaceEvidence(evidence, { guard }) > 0); tokens.push(evidence); return state.sequence;
      }, guard);
    }
    assert.notEqual(tokens[0], tokens[1]);
    let called = false;
    await assert.rejects(store.updateWithDiskSpaceEvidence(() => { called = true; }, { ...guard }),
      { code: "media_capacity_disk_space_guard_invalid" });
    assert.equal(called, false);
    await assert.rejects(store.updateWithDiskSpaceEvidence(async state => { state.paused = true; }, guard),
      { code: "media_capacity_async_transaction_forbidden" });
    await assert.rejects(store.updateWithDiskSpaceEvidence(state => { state.paused = true; return Promise.resolve(); }, guard),
      { code: "media_capacity_async_transaction_forbidden" });
    assert.deepEqual(await snapshot(), before);
  });

  await t.test("real low-space observations roll back reservation and write checks but preserve reads", async () => {
    const lowGuard = createDiskSpaceGuard({ rootDirectory: root, enabled: true, marginBytes: Number.MAX_SAFE_INTEGER });
    const low = capacity(store, lowGuard), before = await snapshot();
    assert.equal(assertDiskSpaceEvidence(await lowGuard.sample(), { guard: lowGuard }), 0);
    for (const input of [request(), existing]) {
      await assert.rejects(low.reserveStorage({ ...input, diskSpaceEvidence: await lowGuard.sample() }),
        { code: "media_capacity_disk_space_insufficient" });
    }
    await assert.rejects(low.assertHeld({ ...existing, diskSpaceEvidence: await lowGuard.sample() }),
      { code: "media_capacity_disk_space_insufficient" });
    assert.equal((await low.assertHeld({ ...existing, intent: "read" })).storageHeld, true);
    assert.deepEqual(await snapshot(), before);
  });

  await t.test("the locked ledger is validated before sampling or invoking its callback", async () => {
    const before = await snapshot(), malformed = { ...before.document, paused: "invalid" };
    const unavailableGuard = createDiskSpaceGuard({ rootDirectory: path.join(root, "absent"), enabled: true });
    let called = false;
    await db.adminPool.query("UPDATE ia4tube_calendar.global_media_capacity SET document=$1::jsonb WHERE singleton=1", [JSON.stringify(malformed)]);
    try {
      await assert.rejects(store.updateWithDiskSpaceEvidence(() => { called = true; }, unavailableGuard),
        { code: "media_capacity_state_invalid" });
      assert.equal(called, false);
      const rejected = await snapshot();
      assert.deepEqual(rejected.document, malformed); assert.equal(rejected.revision, before.revision);
    } finally {
      await db.adminPool.query("UPDATE ia4tube_calendar.global_media_capacity SET document=$1::jsonb WHERE singleton=1", [JSON.stringify(before.document)]);
    }
    assert.deepEqual(await snapshot(), before);
  });

  await t.test("distinct real stores retain idempotency, aggregate quota and exact binding", async () => {
    const before = await snapshot(), held = Object.values(before.document.jobs).reduce((total, job) => total + job.heldBytes, 0);
    const limits = { globalStorageBytes: held + 100, companyStorageBytes: held + 100 };
    const first = capacity(store, guard, limits);
    const second = capacity(createPostgresGlobalCapacityStore({ pool: db.capacityPool }), guard, limits);
    const input = request();
    const results = await Promise.all([first, second, first, second].map(async value =>
      value.reserveStorage({ ...input, diskSpaceEvidence: await guard.sample() })));
    assert.ok(results.every(result => result.jobId === input.jobId && result.heldBytes === 100));
    const after = await snapshot();
    assert.equal(Object.keys(after.document.jobs).length, Object.keys(before.document.jobs).length + 1);
    assert.equal(BigInt(after.revision), BigInt(before.revision) + 1n);
    await assert.rejects(first.reserveStorage({ ...request(), diskSpaceEvidence: await guard.sample() }),
      { code: "media_capacity_storage_exceeded" });
    await assert.rejects(second.reserveStorage({ ...input, requestDigest: crypto.randomBytes(32).toString("hex"), diskSpaceEvidence: await guard.sample() }),
      { code: "media_capacity_reservation_conflict" });
    assert.deepEqual(await snapshot(), after);
  });
});
