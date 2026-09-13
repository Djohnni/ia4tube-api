"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { createOperationalMediaPostgresFixture } = require("./helpers/operational-media-postgres-fixture");
const { createImportUploadPostgresStore } = require("../src/social/calendar/imports/postgres-store");
const { createCalendarStore } = require("../src/social/calendar/store");
const { createPostgresGlobalCapacityStore } = require("../src/social/calendar/imports/postgres-global-capacity-store");
const { createGlobalMediaCapacity } = require("../src/social/calendar/imports/global-capacity");
const { createReferencedRetentionCollector } = require("../src/social/calendar/imports/retention-collector");
const { renderDiskCapacityIdentity } = require("../src/social/calendar/imports/render-disk-admission");
const ctx = { authenticated: true, role: "calendar_media_capacity_coordinator" }, time = 1900000000000;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
test("candidate retention uses actual PostgreSQL fences, filesystem deletion and capacity accounting", { timeout: 90000 }, async t => {
  const pg = await createOperationalMediaPostgresFixture(t), root = path.join(pg.root, "synthetic-private-uploads");
  await fs.mkdir(root, { mode: 0o700 });
  let imports, calendar, capacity;
  function bind() {
    imports = createImportUploadPostgresStore({ pool: pg.tenantPool }); calendar = createCalendarStore({ pool: pg.tenantPool, role: "ia4tube_social_runtime" });
    capacity = createGlobalMediaCapacity({ store: createPostgresGlobalCapacityStore({ pool: pg.capacityPool }), enabled: true, clock: () => time });
  }
  bind(); await imports.verify(); await calendar.verify();
  function collector(policy = { mode: "terminal_upload_tombstones", minimumAgeMs: 1, approvalReference: "synthetic_policy_only" }, pool = pg.tenantPool) {
    return createReferencedRetentionCollector({ pool, capacityPool: pg.capacityPool, rootDirectory: root, enabled: true, policy, clock: () => time });
  }
  async function seed() {
    const companyId = await pg.addCompany(), userId = crypto.randomUUID(), uploadId = crypto.randomUUID(), assetId = crypto.randomUUID();
    const row = { companyId, userId, uploadId, assetId, objectKey: hash(crypto.randomBytes(16)), sha256: hash("synthetic rejected input"),
      sizeBytes: 11, chunkBytes: 5 * 1024 ** 2, kind: "image", mimeType: "image/png", state: "cancelled", lease: null,
      createdAt: time - 1000, updatedAt: time - 999, disk: { schema: 1, uploadId: crypto.randomUUID(), objectVersion: crypto.randomUUID(),
        phase: "aborted", cleanupVerified: true, parts: {} } };
    await imports.update(companyId, state => { state.uploads[uploadId] = row; });
    const binding = { reservationKey: `disk:${assetId}`, companyId, userId, assetId, sourceSha256: row.sha256, sourceBytes: row.sizeBytes, peakBytes: row.sizeBytes * 2 + 65536 };
    const id = renderDiskCapacityIdentity(binding);
    await capacity.reserveStorage({ context: ctx, ...id, companyId, userId, storageBytes: binding.peakBytes, sourceBytes: row.sizeBytes });
    await capacity.cancel({ context: ctx, jobId: id.jobId });
    await capacity.settleStorage({ context: ctx, jobId: id.jobId, remainingBytes: 65536, proofId: hash("synthetic_abort_" + assetId) });
    const dir = path.join(root, row.objectKey), identity = path.join(dir, "identity.json");
    await fs.mkdir(dir, { mode: 0o700 });
    await fs.writeFile(identity, JSON.stringify({ ...binding, uploadId: row.disk.uploadId, objectVersion: row.disk.objectVersion }), { flag: "wx", mode: 0o600 });
    return { companyId, userId, uploadId, assetId, row, dir, identity, capacityId: id.jobId };
  }
  const input = f => ({ companyId: f.companyId, uploadId: f.uploadId });
  async function held(f) { return (await capacity.inspect({ context: ctx, jobId: f.capacityId })).storageHeld; }
  await t.test("default retain-all does not delete or release anything", async () => {
    const f = await seed(), c = collector({ mode: "retain_all" });
    assert.equal((await c.inspect(input(f))).policyAllowsCleanup, false);
    await assert.rejects(c.retire(input(f)), { code: "media_retention_policy_preserve_all" });
    assert.equal((await fs.stat(f.identity)).isFile(), true); assert.equal(await held(f), true);
  });
  await t.test("scheduled/cancelled history ref committed before collector wins and preserves bytes", async () => {
    const f = await seed(); let release, entered;
    const inside = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
    const scheduling = calendar.update(f.companyId, async state => { entered(); await wait;
      state.jobs.synthetic = { phase: "cancelled", sourceKind: "upload", import: { assetId: f.assetId } }; });
    await inside;
    const cleaning = collector().retire(input(f)); release(); await scheduling;
    await assert.rejects(cleaning, { code: "media_retention_still_referenced_or_active" });
    assert.equal(await held(f), true); assert.equal((await fs.stat(f.identity)).isFile(), true);
  });
  await t.test("outbox/preparation dependency is retained despite an old timestamp", async () => {
    const f = await seed();
    await imports.update(f.companyId, state => { state.prepareOutbox.synthetic = { companyId: f.companyId, userId: f.userId,
      assetId: f.assetId, uploadId: f.uploadId, state: "pending" }; });
    await assert.rejects(collector().retire(input(f)), { code: "media_retention_still_referenced_or_active" });
    assert.equal(await held(f), true); assert.equal((await fs.stat(f.identity)).isFile(), true);
  });
  await t.test("unknown file/active lock prevents any deletion and quota release", async () => {
    const f = await seed(); await fs.writeFile(path.join(f.dir, "operation.lock"), "");
    await assert.rejects(collector().retire(input(f)), { code: "media_retention_unaccounted_files" });
    assert.equal(await held(f), true); assert.equal((await fs.stat(f.identity)).isFile(), true);
  });
  await t.test("lost acknowledgement after durable intent preserves fence across PG restart; no new reference wins", async () => {
    const f = await seed(); let lose = true;
    const lostPool = { query: (...args) => pg.tenantPool.query(...args), async connect() {
      const client = await pg.tenantPool.connect(); let marking = false;
      return { release: () => client.release(), async query(sql, values) {
        const result = await client.query(sql, values);
        if (typeof sql === "string" && sql.includes("UPDATE ia4tube_calendar.import_upload_state") && String(values?.[1]).includes('"retention"')) marking = true;
        if (sql === "COMMIT" && marking && lose) { lose = false; throw Object.assign(new Error("synthetic_commit_response_lost"), { code: "synthetic_commit_response_lost" }); }
        return result;
      } };
    } };
    await assert.rejects(collector(undefined, lostPool).retire(input(f)));
    assert.equal((await fs.stat(f.identity)).isFile(), true); assert.equal(await held(f), true);
    await pg.restart(); bind();
    await assert.rejects(calendar.update(f.companyId, state => { state.jobs.synthetic = { sourceKind: "upload", import: { assetId: f.assetId } }; }),
      { code: "media_retention_asset_retired" });
    await assert.rejects(imports.update(f.companyId, state => { state.uploads[f.uploadId].state = "uploaded"; }),
      error => ["calendar_import_state_invalid", "media_retention_state_invalid", "media_retention_asset_retired"].includes(error.code));
    await assert.rejects(imports.update(f.companyId, state => { delete state.retention; }), { code: "media_retention_collector_only" });
    const result = await collector().retire(input(f));
    assert.deepEqual(result, { filesRemoved: true, reservationReleased: true, deletedMediaFiles: 0, removedIdentityTombstones: 1 });
    await assert.rejects(fs.stat(f.dir), { code: "ENOENT" }); assert.equal(await held(f), false);
    assert.deepEqual(await collector().retire(input(f)), result);
    await assert.rejects(calendar.update(f.companyId, state => { state.jobs.synthetic = { import: { assetId: f.assetId } }; }), { code: "media_retention_asset_retired" });
  });
  await t.test("other company's upload cannot be retired; its root and reservation remain", async () => {
    const a = await seed(), b = await seed();
    await assert.rejects(collector().retire({ companyId: a.companyId, uploadId: b.uploadId }), { code: "media_retention_not_found" });
    assert.equal(await held(b), true); assert.equal((await fs.stat(b.identity)).isFile(), true);
  });
  t.diagnostic(`RETENTION_PHYSICAL=POSTGRES_FILESYSTEM; PLATFORM=${process.platform}; PG=${pg.databaseVersion}; REAL_MEDIA_DELETED=0; EXTERNAL_CALLS=0`);
});
