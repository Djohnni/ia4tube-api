"use strict";
// Opt-in NEW loopback cluster; every password/database/table below is synthetic.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), net = require("node:net");
const crypto = require("node:crypto"), { spawn } = require("node:child_process"), { Pool } = require("pg");
const { createPostgresTransferRegistryStore } = require("../src/social/calendar/imports/postgres-transfer-registry-store");
const { createTransferAuthorizationRegistry } = require("../src/social/calendar/imports/transfer-registry");

test("physical transfer registry: dedicated role, durable opaque lookup, bounded atomic admission and expiry", {
  skip: !process.env.CALENDAR_TRANSFER_REGISTRY_TEST_PG_BIN, timeout: 90000
}, async t => {
  const bin = path.resolve(process.env.CALENDAR_TRANSFER_REGISTRY_TEST_PG_BIN), extension = process.platform === "win32" ? ".exe" : "";
  for (const name of ["postgres", "pg_ctl", "initdb"]) assert.equal(fs.statSync(path.join(bin, name + extension)).isFile(), true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-transfer-registry-pg-synthetic-"));
  const data = path.join(root, "database"), passFile = path.join(root, "synthetic-initdb-password");
  const password = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(passFile, password, { mode: 0o600, flag: "wx" });
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const selected = server.address().port; server.close(() => resolve(selected)); });
  });
  const environment = { LANG: "C", LC_ALL: "C", TMP: root, TEMP: root };
  if (process.platform === "win32") {
    assert.ok(process.env.SystemRoot); environment.SystemRoot = process.env.SystemRoot;
    environment.COMSPEC = path.join(process.env.SystemRoot, "System32", "cmd.exe");
    environment.PATH = [bin, path.join(process.env.SystemRoot, "System32"), process.env.SystemRoot].join(path.delimiter);
  } else environment.PATH = bin + path.delimiter + "/usr/bin:/bin";
  async function command(name, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(path.join(bin, name + extension), args, { windowsHide: true, shell: false, stdio: "ignore", env: environment });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Synthetic ${name} timeout`)); }, 45000);
      child.once("error", () => { clearTimeout(timer); reject(new Error(`Synthetic ${name} unavailable`)); });
      child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Synthetic ${name} failed`)); });
    });
  }
  let started = false, admin, transferPool, tenantPool, capacityPool;
  t.after(async () => {
    await transferPool?.end(); await tenantPool?.end(); await capacityPool?.end(); await admin?.end();
    if (started || fs.existsSync(path.join(data, "postmaster.pid"))) await command("pg_ctl", ["stop", "-D", data, "-m", "fast", "-w"]);
    assert.equal(fs.existsSync(path.join(data, "postmaster.pid")), false);
    const listening = await new Promise(resolve => {
      const socket = net.createConnection({ host: "127.0.0.1", port }); socket.setTimeout(1000);
      socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false));
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
    assert.equal(listening, false);
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("ia4tube-transfer-registry-pg-synthetic-"));
    assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false);
    fs.rmSync(resolved, { recursive: true, force: true }); assert.equal(fs.existsSync(resolved), false);
    t.diagnostic("NEW_SYNTHETIC_CLUSTER_STOPPED=YES; LOOPBACK_LISTENER_CLOSED=YES; NEW_SYNTHETIC_DIRECTORY_REMOVED=YES");
  });
  await command("initdb", ["-D", data, "-U", "synthetic_transfer_admin", "--pwfile", passFile,
    "--auth-host=scram-sha-256", "--auth-local=scram-sha-256", "--encoding=UTF8", "--locale=C"]);
  fs.unlinkSync(passFile);
  await command("pg_ctl", ["start", "-D", data, "-l", path.join(root, "synthetic.log"), "-o", `-h 127.0.0.1 -p ${port}`, "-w"]);
  started = true;
  const common = { host: "127.0.0.1", port, password, database: "postgres", max: 4, connectionTimeoutMillis: 3000,
    statement_timeout: 10000, query_timeout: 12000, application_name: "synthetic_transfer_registry_test" };
  admin = new Pool({ ...common, user: "synthetic_transfer_admin" }); admin.on("error", () => {});
  await admin.query(`CREATE ROLE ia4tube_social_owner NOLOGIN;
    GRANT CREATE ON DATABASE postgres TO ia4tube_social_owner;
    CREATE ROLE ia4tube_social_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}';
    CREATE ROLE ia4tube_media_capacity_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}';
    CREATE ROLE ia4tube_media_transfer_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}';
    CREATE SCHEMA ia4tube_social AUTHORIZATION ia4tube_social_owner;
    CREATE SCHEMA ia4tube_calendar AUTHORIZATION ia4tube_social_owner;
    REVOKE ALL ON SCHEMA ia4tube_social,ia4tube_calendar FROM PUBLIC;
    SET ROLE ia4tube_social_owner;
    CREATE TABLE ia4tube_social.synthetic_tenant_secret(marker text);
    CREATE TABLE ia4tube_calendar.owner_state(company_id uuid PRIMARY KEY,document jsonb);
    CREATE TABLE ia4tube_calendar.global_media_capacity(singleton int PRIMARY KEY,document jsonb);
    GRANT USAGE ON SCHEMA ia4tube_calendar TO ia4tube_social_runtime,ia4tube_media_capacity_runtime;
    GRANT SELECT ON ia4tube_calendar.owner_state TO ia4tube_social_runtime;
    GRANT SELECT ON ia4tube_calendar.global_media_capacity TO ia4tube_media_capacity_runtime;
    RESET ROLE;`);
  await admin.query(fs.readFileSync(path.join(__dirname, "../db/calendar-migrations/0004_transfer_authorization_registry.up.sql"), "utf8"));
  transferPool = new Pool({ ...common, user: "ia4tube_media_transfer_runtime" }); transferPool.on("error", () => {});
  tenantPool = new Pool({ ...common, user: "ia4tube_social_runtime" }); tenantPool.on("error", () => {});
  capacityPool = new Pool({ ...common, user: "ia4tube_media_capacity_runtime" }); capacityPool.on("error", () => {});
  let store = createPostgresTransferRegistryStore({ pool: transferPool }), clock = Date.now();
  const create = () => createTransferAuthorizationRegistry({ store, enabled: true, maxActiveRecords: 2, clock: () => clock });
  let first = create();
  const binding = () => ({ authorizationId: crypto.randomUUID(), companyId: crypto.randomUUID(), userId: crypto.randomUUID(),
    assetId: crypto.randomUUID(), objectKey: "a".repeat(64), providerUploadId: crypto.randomUUID(), partNumber: 1, sizeBytes: 8,
    sha256: "b".repeat(64), md5Base64: Buffer.alloc(16).toString("base64"), expiresAt: clock + 1000 });
  let admitted;
  await t.test("runtime reads only bounded registry; tenant/capacity and registry are isolated in both directions", async () => {
    assert.equal(await first.verify(), true);
    assert.equal((await admin.query("SELECT host(inet_server_addr()) AS address")).rows[0].address, "127.0.0.1");
    for (const sql of ["SELECT * FROM ia4tube_social.synthetic_tenant_secret", "SELECT * FROM ia4tube_calendar.owner_state",
      "SELECT * FROM ia4tube_calendar.global_media_capacity", "DELETE FROM ia4tube_calendar.transfer_authorization_registry",
      "UPDATE ia4tube_calendar.transfer_authorization_registry SET singleton=1", "TRUNCATE ia4tube_calendar.transfer_authorization_registry"]) {
      await assert.rejects(transferPool.query(sql), { code: "42501" });
    }
    for (const pool of [tenantPool, capacityPool]) {
      await assert.rejects(pool.query("SELECT * FROM ia4tube_calendar.transfer_authorization_registry"), { code: "42501" });
      await assert.rejects(pool.query("SET ROLE ia4tube_media_transfer_runtime"), { code: "42501" });
    }
    await assert.rejects(createPostgresTransferRegistryStore({ pool: admin }).verify(), { code: "media_transfer_schema_not_ready" });
  });
  await t.test("parallel stores atomically admit two grants and reject changed immutable bindings", async () => {
    const second = create(), rows = Array.from({ length: 12 }, binding);
    const results = await Promise.allSettled(rows.map((row, i) => (i % 2 ? first : second).register(row)));
    assert.equal(results.filter(item => item.status === "fulfilled").length, 2);
    assert.ok(results.filter(item => item.status === "rejected").every(item => item.reason.code === "media_transfer_registry_full"));
    admitted = rows[results.findIndex(item => item.status === "fulfilled")];
    assert.deepEqual(await second.register(admitted), admitted);
    await assert.rejects(second.register({ ...admitted, companyId: crypto.randomUUID() }), { code: "media_transfer_authorization_conflict" });
    assert.deepEqual(await second.resolve(admitted.authorizationId), admitted);
    const document = (await store.update(state => state));
    assert.equal(JSON.stringify(document).includes(admitted.authorizationId), false);
  });
  await t.test("grants survive pool recreation, read has no revision write, and revoke cannot resurrect", async () => {
    await transferPool.end(); transferPool = new Pool({ ...common, user: "ia4tube_media_transfer_runtime" }); transferPool.on("error", () => {});
    store = createPostgresTransferRegistryStore({ pool: transferPool }); first = create();
    const revision = async () => (await admin.query("SELECT revision FROM ia4tube_calendar.transfer_authorization_registry")).rows[0].revision;
    const before = await revision(); assert.deepEqual(await first.resolve(admitted.authorizationId), admitted); assert.equal(await revision(), before);
    assert.equal(await first.revoke(admitted.authorizationId), true); assert.equal(await first.resolve(admitted.authorizationId), null);
    await assert.rejects(first.register(admitted), { code: "media_transfer_authorization_revoked" });
  });
  await t.test("expiry pruning keeps existing source/idempotency metadata and admits new registry grants", async () => {
    const marker = { synthetic: true, idempotency: { preserved: "yes" }, source: "retained" };
    await admin.query("INSERT INTO ia4tube_calendar.owner_state VALUES($1,$2::jsonb)", [admitted.companyId, JSON.stringify(marker)]);
    clock += 1000; const fresh = binding(); await first.register(fresh);
    assert.equal(Object.keys((await store.update(state => state)).grants).length, 1);
    assert.equal(await first.resolve(admitted.authorizationId), null);
    assert.deepEqual((await admin.query("SELECT document FROM ia4tube_calendar.owner_state")).rows[0].document, marker);
    await assert.rejects(admin.query("UPDATE ia4tube_calendar.transfer_authorization_registry SET document=$1::jsonb",
      [JSON.stringify({ schema: 1, grants: Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [String(i), {}])) })]), { code: "23514" });
  });
  await t.test("actual role membership, column grants, RLS and reverse access drift fail closed", async () => {
    for (const [apply, undo] of [
      ["GRANT ia4tube_social_runtime TO ia4tube_media_transfer_runtime", "REVOKE ia4tube_social_runtime FROM ia4tube_media_transfer_runtime"],
      ["GRANT SELECT(document) ON ia4tube_calendar.owner_state TO ia4tube_media_transfer_runtime", "REVOKE SELECT(document) ON ia4tube_calendar.owner_state FROM ia4tube_media_transfer_runtime"],
      ["GRANT SELECT(document) ON ia4tube_calendar.global_media_capacity TO ia4tube_media_transfer_runtime", "REVOKE SELECT(document) ON ia4tube_calendar.global_media_capacity FROM ia4tube_media_transfer_runtime"],
      ["GRANT SELECT(document) ON ia4tube_calendar.transfer_authorization_registry TO ia4tube_social_runtime", "REVOKE SELECT(document) ON ia4tube_calendar.transfer_authorization_registry FROM ia4tube_social_runtime"],
      ["GRANT SELECT(document) ON ia4tube_calendar.transfer_authorization_registry TO PUBLIC", "REVOKE SELECT(document) ON ia4tube_calendar.transfer_authorization_registry FROM PUBLIC"],
      ["ALTER POLICY media_transfer_registry_scope ON ia4tube_calendar.transfer_authorization_registry USING(true)", "ALTER POLICY media_transfer_registry_scope ON ia4tube_calendar.transfer_authorization_registry USING(singleton=1)"],
      ["ALTER TABLE ia4tube_calendar.transfer_authorization_registry NO FORCE ROW LEVEL SECURITY", "ALTER TABLE ia4tube_calendar.transfer_authorization_registry FORCE ROW LEVEL SECURITY"]]) {
      await admin.query(apply);
      try { await assert.rejects(store.verify(), { code: "media_transfer_schema_not_ready" }); }
      finally { await admin.query(undo); }
      assert.equal(await store.verify(), true);
    }
  });
});
