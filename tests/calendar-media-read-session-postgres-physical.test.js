"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createOperationalMediaPostgresFixture } = require("./helpers/operational-media-postgres-fixture");
const { initializeSocialSchema, seedSyntheticSocialAccount } = require("./helpers/operational-media-social-fixture");
const { createCalendarStore } = require("../src/social/calendar/store");
const { calendarConnectionFromDetails } = require("../src/social/calendar/connection");
const { freshState } = require("../src/social/calendar/model");
const role = "ia4tube_social_runtime", hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("physical media read sessions retain fresh RLS/retention/connection facts with a three-client pool", { timeout: 120000 }, async t => {
  const db = await createOperationalMediaPostgresFixture(t, { initializeSocialSchema });
  db.tenantPool.options.max = 3;
  const owner = { companyId: crypto.randomUUID(), userId: crypto.randomUUID() };
  const other = { companyId: crypto.randomUUID(), userId: crypto.randomUUID() };
  const connected = await seedSyntheticSocialAccount(db, owner);
  const otherConnection = await seedSyntheticSocialAccount(db, other, { externalId: "987654321012345", username: "synthetic_other" });
  const assetId = crypto.randomUUID(), id = "a".repeat(40), calls = [], releases = [], modes = [];
  let inspectMode = false;
  const pool = { options: db.tenantPool.options, async connect() {
    const client = await db.tenantPool.connect();
    return {
      on: client.on.bind(client), removeListener: client.removeListener.bind(client),
      async query(sql, values) {
        calls.push(sql);
        if (inspectMode && sql.startsWith("SELECT calendar.document")) {
          inspectMode = false;
          modes.push((await client.query("SELECT current_setting('transaction_isolation') AS isolation, " +
            "current_setting('transaction_read_only') AS readonly, current_user AS role, " +
            "current_setting('ia4tube.company_id') AS company")).rows[0]);
        }
        return client.query(sql, values);
      },
      release(error) { releases.push(Boolean(error)); return client.release(error); }
    };
  } };
  const store = createCalendarStore({ pool, role });
  function document(context = owner) {
    const value = freshState();
    value.jobs[id] = { id, sourceKind: "upload", phase: "ready", import: { assetId, userId: context.userId, previewDigest: "b".repeat(64) } };
    return value;
  }
  async function seedCalendar(context, state = document(context)) {
    await db.adminPool.query(`INSERT INTO ia4tube_calendar.owner_state(company_id,document) VALUES($1,$2::jsonb)
      ON CONFLICT(company_id) DO UPDATE SET document=EXCLUDED.document`, [context.companyId, JSON.stringify(state)]);
    await db.adminPool.query(`INSERT INTO ia4tube_calendar.import_upload_state(company_id,document) VALUES($1,'{"schema":1}'::jsonb)
      ON CONFLICT(company_id) DO UPDATE SET document=EXCLUDED.document`, [context.companyId]);
  }
  await seedCalendar(owner); await seedCalendar(other);
  const options = { userId: owner.userId, connectionId: connected.connectionId };
  const withOwner = callback => store.withMediaReadSession(owner.companyId, options, callback);

  await t.test("READ COMMITTED sees committed cancellation and permits writers while the reader is held", async () => {
    inspectMode = true;
    await withOwner(async ({ read }) => {
      const first = await read(); assert.equal(first.state.jobs[id].phase, "ready");
      assert.ok(calendarConnectionFromDetails(first.connection));
      await store.update(owner.companyId, state => { state.jobs[id].phase = "cancelled"; });
      assert.equal((await read()).state.jobs[id].phase, "cancelled");
    });
    assert.deepEqual(modes, [{ isolation: "read committed", readonly: "on", role, company: owner.companyId }]);
    await seedCalendar(owner);
  });
  await t.test("scope and credential expiry use statement time, not the transaction start", async () => {
    await withOwner(async ({ read }) => {
      assert.ok(calendarConnectionFromDetails((await read()).connection));
      await db.adminPool.query(`UPDATE ia4tube_social.social_connection_scopes SET expires_at=statement_timestamp()
        WHERE company_id=$1 AND connection_id=$2 AND scope='instagram_business_content_publish'`, [owner.companyId, connected.connectionId]);
      const expiredScope = (await read()).connection;
      assert.equal(expiredScope.grantedScopes.includes("instagram_business_content_publish"), false);
      assert.equal(calendarConnectionFromDetails(expiredScope), null);
      await db.adminPool.query("UPDATE ia4tube_social.social_connection_scopes SET expires_at=NULL WHERE company_id=$1 AND connection_id=$2", [owner.companyId, connected.connectionId]);
      await db.adminPool.query("UPDATE ia4tube_social.social_encrypted_credentials SET expires_at=statement_timestamp() WHERE company_id=$1 AND id=$2", [owner.companyId, connected.credentialId]);
      const expiredCredential = (await read()).connection;
      assert.equal(expiredCredential.health, "reconnect_required"); assert.equal(calendarConnectionFromDetails(expiredCredential), null);
      await db.adminPool.query("UPDATE ia4tube_social.social_encrypted_credentials SET expires_at=NULL WHERE company_id=$1 AND id=$2", [owner.companyId, connected.credentialId]);
      assert.ok(calendarConnectionFromDetails((await read()).connection));
    });
  });
  await t.test("credential revocation and connection revision changes are visible on the next read", async () => {
    await withOwner(async ({ read }) => {
      assert.equal((await read()).connection.revision, 1);
      await db.adminPool.query("UPDATE ia4tube_social.social_connections SET revision=revision+1 WHERE company_id=$1 AND id=$2", [owner.companyId, connected.connectionId]);
      assert.equal((await read()).connection.revision, 2);
      await db.adminPool.query("UPDATE ia4tube_social.social_encrypted_credentials SET revoked_at=statement_timestamp() WHERE company_id=$1 AND id=$2", [owner.companyId, connected.credentialId]);
      const revoked = (await read()).connection;
      assert.equal(revoked.activeCredentialId, null); assert.equal(calendarConnectionFromDetails(revoked), null);
      await db.adminPool.query("UPDATE ia4tube_social.social_encrypted_credentials SET revoked_at=NULL WHERE company_id=$1 AND id=$2", [owner.companyId, connected.credentialId]);
    });
  });
  await t.test("fresh global retention guard rejects an unrelated referenced asset before another block", async () => {
    const retainedAsset = crypto.randomUUID();
    await store.update(owner.companyId, state => { state.importedSources = { origins: { [retainedAsset]: {} } }; });
    await assert.rejects(withOwner(async ({ read }) => {
      await read();
      // Admin fixture injects the committed retirement fence; no production collector is invoked.
      await db.adminPool.query("UPDATE ia4tube_calendar.import_upload_state SET document=$2::jsonb WHERE company_id=$1",
        [owner.companyId, JSON.stringify({ schema: 1, retention: { records: { [retainedAsset]: { phase: "intent" } } } })]);
      await read(); assert.fail("retired reference must prevent the next block");
    }), { code: "media_retention_asset_retired" });
    await seedCalendar(owner);
  });
  await t.test("full 22,225,691-byte consumption uses 340 fresh SELECTs without document writes", async () => {
    const source = Buffer.alloc(22225691, 0x6d), result = crypto.createHash("sha256");
    const before = (await db.adminPool.query("SELECT revision,document FROM ia4tube_calendar.owner_state WHERE company_id=$1", [owner.companyId])).rows;
    const first = calls.length, started = performance.now(); let blocks = 0, size = 0;
    await withOwner(async ({ read }) => {
      for (let offset = 0; offset < source.length; offset += 65536) {
        const snapshot = await read(); assert.equal(snapshot.state.jobs[id].phase, "ready");
        assert.ok(calendarConnectionFromDetails(snapshot.connection));
        const bytes = source.subarray(offset, Math.min(offset + 65536, source.length)); result.update(bytes); size += bytes.length; blocks++;
      }
    });
    assert.equal(blocks, 340); assert.equal(size, source.length); assert.equal(result.digest("hex"), hash(source));
    const statements = calls.slice(first); assert.equal(statements.length, 344);
    assert.equal(statements.filter(sql => sql.startsWith("SELECT calendar.document")).length, 340);
    assert.equal(statements.some(sql => /FOR UPDATE|pg_advisory|INSERT|UPDATE ia4tube|DELETE/.test(sql)), false);
    assert.deepEqual((await db.adminPool.query("SELECT revision,document FROM ia4tube_calendar.owner_state WHERE company_id=$1", [owner.companyId])).rows, before);
    t.diagnostic(`MEDIA_SESSION_PHYSICAL_BYTES=${size}; BLOCKS=${blocks}; ELAPSED_MS=${Math.ceil(performance.now() - started)}; MAX_POOL=3`);
  });
  await t.test("RLS and exact connection binding prevent cross-company reads; scope never leaks back to the pool", async () => {
    await withOwner(async ({ read }) => {
      const value = await read(); assert.equal(value.connection.companyId, owner.companyId);
      assert.equal(value.state.jobs[id].import.userId, owner.userId);
    });
    await assert.rejects(store.withMediaReadSession(owner.companyId, { userId: owner.userId, connectionId: otherConnection.connectionId }, ({ read }) => read()), { code: "calendar_connection_changed" });
    const noScope = await db.tenantPool.query("SELECT company_id FROM ia4tube_calendar.owner_state"); assert.equal(noScope.rows.length, 0);
    await assert.rejects(store.withMediaReadSession(crypto.randomUUID(), { userId: owner.userId }, ({ read }) => read()), { code: "calendar_not_found" });
  });
  await t.test("three concurrent callbacks perform preflight before lazy acquisition and all complete", async () => {
    const gate = deferred(); let entered = 0;
    await Promise.all([0, 1, 2].map(() => withOwner(async ({ read }) => {
      // This separate read must remain possible before all three sessions acquire clients.
      await store.read(owner.companyId, state => state.jobs[id]);
      if (++entered === 3) gate.resolve(); await gate.promise;
      for (let block = 0; block < 4; block++) await read();
    })));
    assert.equal(db.tenantPool.waitingCount, 0); assert.ok(db.tenantPool.totalCount <= 3);
  });
  await t.test("two held streams leave a pool client for cancellation while a third reader waits", async () => {
    const started = deferred(), continueReads = deferred(); let held = 0, admittedThird = false;
    const readers = [0, 1].map(() => withOwner(async ({ read }) => {
      await read(); if (++held === 2) started.resolve(); await continueReads.promise;
      assert.equal((await read()).state.jobs[id].phase, "cancelled");
    }));
    await started.promise;
    const third = withOwner(async ({ read }) => { await read(); admittedThird = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(admittedThird, false); assert.equal(db.tenantPool.waitingCount, 0);
    // This write uses the same restricted pool and must commit before the held readers finish.
    await store.update(owner.companyId, state => { state.jobs[id].phase = "cancelled"; });
    assert.equal(await store.read(owner.companyId, state => state.jobs[id].phase), "cancelled");
    assert.equal(admittedThird, false);
    continueReads.resolve(); await Promise.all([...readers, third]); assert.equal(admittedThird, true);
    await seedCalendar(owner);
  });
  await t.test("abort releases a real checked-out client and later sessions remain usable", async () => {
    const controller = new AbortController(), started = deferred(), wait = deferred();
    const reading = store.withMediaReadSession(owner.companyId, { ...options, signal: controller.signal }, async ({ read }) => {
      await read(); started.resolve(); await wait.promise;
    });
    await started.promise; controller.abort();
    await assert.rejects(reading, { code: "calendar_media_read_aborted" }); wait.resolve();
    assert.equal(releases.at(-1), true);
    await withOwner(({ read }) => read()); assert.equal(db.tenantPool.waitingCount, 0);
  });
  t.diagnostic(`MEDIA_READ_SESSION_PG=${db.databaseVersion}; LOOPBACK_ONLY=YES; PRODUCTION_DATA=NONE; EXTERNAL_REQUESTS=0`);
});
