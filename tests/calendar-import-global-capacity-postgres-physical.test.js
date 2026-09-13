"use strict";

// Separate opt-in physical proof for the NEW global ledger. Every connection and
// credential below is created here for one ephemeral, loopback-only cluster.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), net = require("node:net");
const crypto = require("node:crypto"), { spawn } = require("node:child_process"), { Pool } = require("pg");
const { createPostgresGlobalCapacityStore } = require("../src/social/calendar/imports/postgres-global-capacity-store");
const { createGlobalMediaCapacity } = require("../src/social/calendar/imports/global-capacity");

test("physical global capacity: isolated restricted coordinator, serialization, persistence and revocation", {
  skip: !process.env.CALENDAR_GLOBAL_CAPACITY_TEST_PG_BIN, timeout: 90000
}, async t => {
  const bin = path.resolve(process.env.CALENDAR_GLOBAL_CAPACITY_TEST_PG_BIN), extension = process.platform === "win32" ? ".exe" : "";
  for (const name of ["postgres", "pg_ctl", "initdb"]) assert.equal(fs.statSync(path.join(bin, name + extension)).isFile(), true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-global-capacity-pg-synthetic-"));
  const data = path.join(root, "database"), passFile = path.join(root, "synthetic-initdb-password");
  const password = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(passFile, password, { mode: 0o600, flag: "wx" });
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const selected = server.address().port; server.close(() => resolve(selected)); });
  });
  const environment = { LANG: "C", LC_ALL: "C", TMP: root, TEMP: root };
  if (process.platform === "win32") {
    assert.ok(process.env.SystemRoot);
    environment.SystemRoot = process.env.SystemRoot;
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
  let started = false, admin, capacityPool, tenantPool;
  t.after(async () => {
    await capacityPool?.end(); await tenantPool?.end(); await admin?.end();
    if (started || fs.existsSync(path.join(data, "postmaster.pid"))) await command("pg_ctl", ["stop", "-D", data, "-m", "fast", "-w"]);
    assert.equal(fs.existsSync(path.join(data, "postmaster.pid")), false);
    const listening = await new Promise(resolve => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(1000); socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false)); socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
    assert.equal(listening, false);
    // Validated literal target is exclusively this new, disposable cluster.
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("ia4tube-global-capacity-pg-synthetic-"));
    assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false);
    fs.rmSync(resolved, { recursive: true, force: true });
    assert.equal(fs.existsSync(resolved), false);
    t.diagnostic("NEW_SYNTHETIC_CLUSTER_STOPPED=YES; LOOPBACK_LISTENER_CLOSED=YES; NEW_SYNTHETIC_DIRECTORY_REMOVED=YES");
  });
  await command("initdb", ["-D", data, "-U", "synthetic_global_admin", "--pwfile", passFile,
    "--auth-host=scram-sha-256", "--auth-local=scram-sha-256", "--encoding=UTF8", "--locale=C"]);
  fs.unlinkSync(passFile);
  await command("pg_ctl", ["start", "-D", data, "-l", path.join(root, "synthetic.log"), "-o", `-h 127.0.0.1 -p ${port}`, "-w"]);
  started = true;
  const common = { host: "127.0.0.1", port, password, database: "postgres", max: 4, connectionTimeoutMillis: 3000,
    statement_timeout: 10000, query_timeout: 12000, application_name: "synthetic_global_capacity_test" };
  admin = new Pool({ ...common, user: "synthetic_global_admin" }); admin.on("error", () => {});
  await admin.query(`CREATE ROLE ia4tube_social_owner NOLOGIN;
    GRANT CREATE ON DATABASE postgres TO ia4tube_social_owner;
    CREATE ROLE ia4tube_social_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}';
    CREATE ROLE ia4tube_media_capacity_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}';
    CREATE SCHEMA ia4tube_social AUTHORIZATION ia4tube_social_owner;
    REVOKE ALL ON SCHEMA ia4tube_social FROM PUBLIC;
    SET ROLE ia4tube_social_owner;
    CREATE TABLE ia4tube_social.companies(id uuid PRIMARY KEY);
    CREATE TABLE ia4tube_social.synthetic_tenant_secret(company_id uuid PRIMARY KEY, marker text);
    RESET ROLE;`);
  // Existing calendar schema is fixture setup, not a rerun of its previous proof.
  for (const migration of ["0001_calendar_bridge.up.sql", "0003_global_media_capacity.up.sql"]) {
    await admin.query(fs.readFileSync(path.join(__dirname, "../db/calendar-migrations", migration), "utf8"));
  }
  capacityPool = new Pool({ ...common, user: "ia4tube_media_capacity_runtime" }); capacityPool.on("error", () => {});
  tenantPool = new Pool({ ...common, user: "ia4tube_social_runtime" }); tenantPool.on("error", () => {});
  const store = createPostgresGlobalCapacityStore({ pool: capacityPool });
  const companyA = crypto.randomUUID(), companyB = crypto.randomUUID(), userId = crypto.randomUUID();
  await admin.query("INSERT INTO ia4tube_social.companies(id) VALUES($1),($2)", [companyA, companyB]);
  await admin.query("INSERT INTO ia4tube_calendar.owner_state(company_id,document) VALUES($1,$2::jsonb)", [companyA, JSON.stringify({ schema: 1, marker: "synthetic-only" })]);

  await t.test("migration provisions one restricted row and neither role crosses its intended data boundary", async () => {
    assert.equal(await store.verify(), true);
    const server = await admin.query("SELECT host(inet_server_addr()) AS address,current_setting('server_version_num') AS version");
    assert.equal(server.rows[0].address, "127.0.0.1"); assert.match(server.rows[0].version, /^18\d{4}$/);
    assert.equal((await capacityPool.query("SELECT singleton FROM ia4tube_calendar.global_media_capacity")).rowCount, 1);
    for (const sql of ["DELETE FROM ia4tube_calendar.global_media_capacity", "UPDATE ia4tube_calendar.global_media_capacity SET singleton=1",
      "INSERT INTO ia4tube_calendar.global_media_capacity SELECT * FROM ia4tube_calendar.global_media_capacity",
      "SELECT * FROM ia4tube_calendar.owner_state", "SELECT * FROM ia4tube_social.synthetic_tenant_secret"]) {
      await assert.rejects(capacityPool.query(sql), error => error.code === "42501");
    }
    await assert.rejects(tenantPool.query("SELECT * FROM ia4tube_calendar.global_media_capacity"), error => error.code === "42501");
    await assert.rejects(tenantPool.query("SET ROLE ia4tube_media_capacity_runtime"), error => error.code === "42501");
    await assert.rejects(createPostgresGlobalCapacityStore({ pool: admin }).verify(), { code: "media_capacity_schema_not_ready" });
  });

  const context = { authenticated: true, role: "calendar_media_capacity_coordinator" };
  const options = { enabled: true, limits: { globalStorageBytes: 12, companyStorageBytes: 6 }, clock: () => Date.UTC(2026, 8, 12) };
  let admitted;
  await t.test("distinct physical store instances serialize aggregate quota and idempotent reservations", async () => {
    const first = createGlobalMediaCapacity({ ...options, store });
    const second = createGlobalMediaCapacity({ ...options, store: createPostgresGlobalCapacityStore({ pool: capacityPool }) });
    const requests = Array.from({ length: 16 }, (_, index) => ({ context, jobId: crypto.randomUUID(), companyId: index % 2 ? companyA : companyB,
      userId, requestDigest: crypto.randomBytes(32).toString("hex"), storageBytes: 3, sourceBytes: 1, runtimeBudgetMs: 1000 }));
    const results = await Promise.allSettled(requests.map((request, index) => (index % 2 ? second : first).reserve(request)));
    assert.equal(results.filter(value => value.status === "fulfilled").length, 4);
    assert.ok(results.filter(value => value.status === "rejected").every(value => value.reason.code === "media_capacity_storage_exceeded"));
    admitted = requests[results.findIndex(value => value.status === "fulfilled")];
    const retries = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).reserve(admitted)));
    assert.ok(retries.every(value => value.jobId === admitted.jobId));
    const snapshot = await store.update(state => state);
    assert.equal(Object.keys(snapshot.jobs).length, 4);
    assert.equal(Object.values(snapshot.jobs).reduce((sum, job) => sum + job.heldBytes, 0), 12);
    assert.equal(Object.values(snapshot.jobs).filter(job => job.companyId === companyA).length, 2);
    assert.equal(Object.values(snapshot.jobs).filter(job => job.companyId === companyB).length, 2);
  });

  await t.test("rollback, async mutation rejection, no-op revision and pool reopen preserve durable singleton", async () => {
    const before = await store.update(state => state);
    await assert.rejects(store.update(state => { state.paused = true; throw new Error("synthetic rollback"); }), { code: "media_capacity_storage_unavailable" });
    await assert.rejects(store.update(async state => { state.paused = true; }), { code: "media_capacity_async_transaction_forbidden" });
    assert.deepEqual(await store.update(state => state), before);
    const revision = async () => (await admin.query("SELECT revision FROM ia4tube_calendar.global_media_capacity WHERE singleton=1")).rows[0].revision;
    const oldRevision = await revision(); await store.update(state => state.paused); assert.equal(await revision(), oldRevision);
    await capacityPool.end(); capacityPool = new Pool({ ...common, user: "ia4tube_media_capacity_runtime" }); capacityPool.on("error", () => {});
    const reopened = createPostgresGlobalCapacityStore({ pool: capacityPool });
    assert.equal(await reopened.verify(), true); assert.deepEqual(await reopened.update(state => state), before);
    const coordinator = createGlobalMediaCapacity({ ...options, store: reopened });
    assert.equal((await coordinator.reserve(admitted)).jobId, admitted.jobId);
  });

  await t.test("unsafe privilege or policy drift is refused before mutation", async () => {
    const reopened = createPostgresGlobalCapacityStore({ pool: capacityPool });
    for (const [apply, undo] of [["ALTER ROLE ia4tube_media_capacity_runtime BYPASSRLS", "ALTER ROLE ia4tube_media_capacity_runtime NOBYPASSRLS"],
      ["ALTER POLICY media_capacity_coordinator_scope ON ia4tube_calendar.global_media_capacity USING(true)", "ALTER POLICY media_capacity_coordinator_scope ON ia4tube_calendar.global_media_capacity USING(singleton=1)"],
      ["GRANT SELECT ON ia4tube_calendar.global_media_capacity TO ia4tube_social_runtime", "REVOKE SELECT ON ia4tube_calendar.global_media_capacity FROM ia4tube_social_runtime"]]) {
      await admin.query(apply);
      try { await assert.rejects(reopened.verify(), { code: "media_capacity_schema_not_ready" }); }
      finally { await admin.query(undo); }
      assert.equal(await reopened.verify(), true);
    }
  });

  await t.test("coordinator inheriting tenant access is refused, not silently considered isolated", async () => {
    const reopened = createPostgresGlobalCapacityStore({ pool: capacityPool });
    await admin.query("GRANT ia4tube_social_runtime TO ia4tube_media_capacity_runtime");
    try { await assert.rejects(reopened.verify(), { code: "media_capacity_schema_not_ready" }); }
    finally { await admin.query("REVOKE ia4tube_social_runtime FROM ia4tube_media_capacity_runtime"); }
    assert.equal(await reopened.verify(), true);
  });

  await t.test("coordinator direct tenant-column access is refused without relying only on role membership", async () => {
    const reopened = createPostgresGlobalCapacityStore({ pool: capacityPool });
    await admin.query("GRANT SELECT(document) ON ia4tube_calendar.owner_state TO ia4tube_media_capacity_runtime");
    try { await assert.rejects(reopened.verify(), { code: "media_capacity_schema_not_ready" }); }
    finally { await admin.query("REVOKE SELECT(document) ON ia4tube_calendar.owner_state FROM ia4tube_media_capacity_runtime"); }
    assert.equal(await reopened.verify(), true);
  });
});
