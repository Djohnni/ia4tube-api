"use strict";
// Explicit loopback-only synthetic database. No application credentials or remote database config.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const crypto = require("node:crypto"), net = require("node:net");
const { spawn } = require("node:child_process");
const { Pool } = require("pg");
const { createImportUploadPostgresStore, validateImportUploadState } = require("../src/social/calendar/imports/postgres-store");
const { withTransaction } = require("../src/persistence/postgres/pool");
const fresh = () => ({ schema: 1, reservedBytes: 0, uploads: {}, idempotency: {}, prepareOutbox: {} });

test("import state rejects foreign records, orphan outbox, oversized maps and unsafe role", () => {
  const companyId = crypto.randomUUID(), userId = crypto.randomUUID(), uploadId = crypto.randomUUID(), assetId = crypto.randomUUID();
  const state = fresh(); state.uploads[uploadId] = { companyId, userId, uploadId, assetId };
  state.idempotency["a".repeat(64)] = uploadId;
  assert.equal(validateImportUploadState(state, companyId), state);
  assert.throws(() => validateImportUploadState(state, crypto.randomUUID()));
  assert.throws(() => validateImportUploadState({ ...state, reservedBytes: -1 }, companyId));
  assert.throws(() => validateImportUploadState({ ...state, prepareOutbox: { x: { companyId, userId, uploadId, assetId: crypto.randomUUID() } } }, companyId));
  assert.throws(() => validateImportUploadState({ ...fresh(), idempotency: { ["a".repeat(64)]: uploadId } }, companyId));
  assert.throws(() => createImportUploadPostgresStore({ pool: { connect() {} }, role: "postgres" }));
  assert.throws(() => validateImportUploadState({ ...state, preparation: { schema: 1 } }, companyId));
  assert.throws(() => validateImportUploadState({ ...state, inspectionQuota: { schema: 1, months: { "2026-09": { starts: -1 } } } }, companyId));
});

test("physical import store: forced tenant scope, durable state, atomic quota and rollback", {
  skip: !process.env.CALENDAR_IMPORT_TEST_PG_BIN, timeout: 90000
}, async t => {
  const bin = path.resolve(process.env.CALENDAR_IMPORT_TEST_PG_BIN);
  const extension = process.platform === "win32" ? ".exe" : "";
  for (const name of ["postgres", "pg_ctl", "initdb"]) assert.equal(fs.statSync(path.join(bin, name + extension)).isFile(), true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-import-pg-synthetic-"));
  const data = path.join(root, "database"), passFile = path.join(root, "synthetic-password");
  const password = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(passFile, password, { mode: 0o600, flag: "wx" });
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => {
    const value = server.address().port; server.close(() => resolve(value)); }); });
  let started = false, admin, runtime;
  async function command(name, args) {
    await new Promise((resolve, reject) => {
      const child = spawn(path.join(bin, name + extension), args, { windowsHide: true, shell: false, stdio: "ignore" });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Synthetic ${name} timed out`)); }, 45000);
      child.once("error", () => { clearTimeout(timer); reject(new Error(`Synthetic ${name} unavailable`)); });
      child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Synthetic ${name} failed`)); });
    });
  }
  t.after(async () => {
    await runtime?.end(); await admin?.end();
    if (started) await command("pg_ctl", ["stop", "-D", data, "-m", "fast", "-w"]);
    // Only the exact newly created synthetic directory is removed after the server stopped.
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("ia4tube-import-pg-synthetic-"));
    if (!started || !fs.existsSync(path.join(data, "postmaster.pid"))) fs.rmSync(resolved, { recursive: true, force: true });
  });
  await command("initdb", ["-D", data, "-U", "synthetic_admin", "--pwfile", passFile,
    "--auth-host=scram-sha-256", "--auth-local=scram-sha-256", "--encoding=UTF8", "--locale=C"]);
  await command("pg_ctl", ["start", "-D", data, "-l", path.join(root, "synthetic.log"), "-o", `-h 127.0.0.1 -p ${port}`, "-w"]);
  started = true;
  const common = { host: "127.0.0.1", port, password, database: "postgres", max: 4, connectionTimeoutMillis: 3000 };
  admin = new Pool({ ...common, user: "synthetic_admin" });
  await admin.query(`CREATE ROLE ia4tube_social_owner NOLOGIN;
    GRANT CREATE ON DATABASE postgres TO ia4tube_social_owner;
    CREATE ROLE ia4tube_social_runtime LOGIN PASSWORD '${password}';
    CREATE SCHEMA ia4tube_social AUTHORIZATION ia4tube_social_owner;
    SET ROLE ia4tube_social_owner;
    CREATE TABLE ia4tube_social.companies(id uuid PRIMARY KEY);
    RESET ROLE;`);
  for (const migration of ["0001_calendar_bridge.up.sql", "0002_import_upload_state.up.sql"]) {
    await admin.query(fs.readFileSync(path.join(__dirname, "../db/calendar-migrations", migration), "utf8"));
  }
  runtime = new Pool({ ...common, user: "ia4tube_social_runtime" });
  runtime.on("error", () => {});
  const store = createImportUploadPostgresStore({ pool: runtime }); await store.verify();
  const a = crypto.randomUUID(), b = crypto.randomUUID();
  await admin.query("INSERT INTO ia4tube_social.companies(id) VALUES($1),($2)", [a, b]);
  const initially = await store.update(a, state => state);
  assert.deepEqual(initially, fresh());
  await store.update(b, state => { state.reservedBytes = 123; return null; });
  assert.equal((await runtime.query("SELECT company_id FROM ia4tube_calendar.import_upload_state")).rowCount, 0);
  await withTransaction(runtime, async client => {
    assert.equal((await client.query("SELECT company_id FROM ia4tube_calendar.import_upload_state")).rowCount, 1);
    assert.equal((await client.query("SELECT company_id FROM ia4tube_calendar.import_upload_state WHERE company_id=$1", [b])).rowCount, 0);
  }, { companyId: a });
  await assert.rejects(withTransaction(runtime, client => client.query(
    "UPDATE ia4tube_calendar.import_upload_state SET company_id=$1 WHERE company_id=$2", [b, a]), { companyId: a }));
  await assert.rejects(withTransaction(runtime, client => client.query(
    "DELETE FROM ia4tube_calendar.import_upload_state WHERE company_id=$1", [a]), { companyId: a }));
  // Distinct processes/stores share the same PostgreSQL lock; memory locks alone would fail this test.
  const second = createImportUploadPostgresStore({ pool: runtime });
  const attempts = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? second : store).update(a, state => {
    if (state.reservedBytes >= 4) return false;
    state.reservedBytes += 1; return true;
  })));
  assert.equal(attempts.filter(Boolean).length, 4);
  assert.equal(await second.update(a, state => state.reservedBytes), 4);
  await assert.rejects(store.update(a, state => { state.reservedBytes = 0; throw new Error("synthetic rollback"); }));
  assert.equal(await store.update(a, state => state.reservedBytes), 4);
  await assert.rejects(store.update(a, async state => { state.reservedBytes = 0; return null; }), { code: "calendar_import_async_transaction_forbidden" });
  assert.equal(await store.update(a, state => state.reservedBytes), 4);
  const before = (await admin.query("SELECT revision FROM ia4tube_calendar.import_upload_state WHERE company_id=$1", [a])).rows[0].revision;
  await store.update(a, state => state.reservedBytes);
  assert.equal((await admin.query("SELECT revision FROM ia4tube_calendar.import_upload_state WHERE company_id=$1", [a])).rows[0].revision, before);
  // State survives pool closure/reopening; never confuse in-memory test adapters with durable storage.
  await runtime.end(); runtime = new Pool({ ...common, user: "ia4tube_social_runtime" }); runtime.on("error", () => {});
  const reopened = createImportUploadPostgresStore({ pool: runtime });
  await reopened.verify(); assert.equal(await reopened.update(a, state => state.reservedBytes), 4);
  assert.equal(await reopened.update(b, state => state.reservedBytes), 123);
  const { createCalendarImportUploadService } = require("../src/social/calendar/imports/upload-service");
  const { createMemoryMultipartProvider } = require("../src/social/calendar/imports/memory-adapters");
  const sharp = require("sharp");
  const image = await sharp({ create: { width: 4, height: 5, channels: 3, background: "#4477aa" } }).png().toBuffer();
  const provider = createMemoryMultipartProvider({ inspectBytes: async bytes => {
    const decoder = sharp(bytes, { limitInputPixels: 25_000_000, failOn: "error" });
    const meta = await decoder.metadata(); await decoder.raw().toBuffer();
    return { signatureVerified: true, decoded: true, detectedMime: "image/" + meta.format,
      width: meta.width, height: meta.height, frames: meta.pages || 1 };
  } });
  const api = createCalendarImportUploadService({ store: reopened, provider, enabled: true, allowVolatileForTests: true });
  const context = { authenticated: true, companyId: a, userId: crypto.randomUUID() };
  const request = { idempotencyKey: "synthetic-physical-import", kind: "image", mimeType: "image/png",
    sizeBytes: image.length, sha256: crypto.createHash("sha256").update(image).digest("hex") };
  const upload = await api.start(context, request);
  const permit = await api.authorizePart(context, { uploadId: upload.uploadId, partNumber: 1 });
  await provider.receivePartForTest(permit.authorizationId, image);
  await Promise.all([api.complete(context, { uploadId: upload.uploadId }), api.complete(context, { uploadId: upload.uploadId })]);
  const complete = await api.status(context, { uploadId: upload.uploadId });
  assert.equal(complete.state, "uploaded"); assert.equal(complete.ready, false);
  assert.equal(complete.verification.sha256, request.sha256);
  assert.equal((await api.start(context, request)).assetId, upload.assetId);
  const stored = await reopened.update(a, state => state);
  assert.equal(Object.keys(stored.prepareOutbox).length, 1);
  assert.equal(Object.keys(stored.uploads).length, 1);
  assert.equal(stored.reservedBytes, 4 + image.length);
  await assert.rejects(api.status({ ...context, companyId: b }, { uploadId: upload.uploadId }), { code: "import_not_found" });
  assert.equal(provider.statsForTest().finalize, 1);
  await admin.query("ALTER ROLE ia4tube_social_runtime BYPASSRLS");
  await assert.rejects(reopened.verify(), { code: "calendar_import_schema_not_ready" });
  await admin.query("ALTER ROLE ia4tube_social_runtime NOBYPASSRLS");
  assert.equal(await reopened.verify(), true);
  await admin.query("ALTER POLICY calendar_import_owner_scope ON ia4tube_calendar.import_upload_state USING (true)");
  await assert.rejects(reopened.verify(), { code: "calendar_import_schema_not_ready" });
});
