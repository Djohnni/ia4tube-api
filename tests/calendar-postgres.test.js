"use strict";
// Explicit local synthetic PostgreSQL only. No production URL/environment is consumed.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const os = require("node:os"), crypto = require("node:crypto"), net = require("node:net"), { execFile } = require("node:child_process");
const { promisify } = require("node:util"), { Pool } = require("pg"), { createCalendarStore } = require("../src/social/calendar/store");
const { withTransaction } = require("../src/persistence/postgres/pool");
const execute = promisify(execFile);
test("physical local PostgreSQL: additive schema, forced tenant isolation, rollback, racing claim and unchanged reads", {
  skip: !process.env.CALENDAR_TEST_PG_BIN, timeout: 90000
}, async t => {
  const bin = path.resolve(process.env.CALENDAR_TEST_PG_BIN), extension = process.platform === "win32" ? ".exe" : "";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-calendar-pg-synthetic-"));
  const data = path.join(root, "database"), passFile = path.join(root, "synthetic-password");
  const password = crypto.randomBytes(24).toString("hex"); fs.writeFileSync(passFile, password, { mode: 0o600 });
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => {
    const port = server.address().port; server.close(() => resolve(port)); }); });
  let started = false, admin, runtime;
  const command = async (name, args) => {
    try { await execute(path.join(bin, name + extension), args, { windowsHide: true, timeout: 45000 }); }
    catch { throw new Error(`Synthetic PostgreSQL ${name} failed; no remote fallback allowed.`); }
  };
  t.after(async () => {
    await runtime?.end(); await admin?.end();
    if (started) await command("pg_ctl", ["stop", "-D", data, "-m", "fast", "-w"]);
    if (!started || !fs.existsSync(path.join(data, "postmaster.pid"))) fs.rmSync(root, { recursive: true, force: true });
  });
  await command("initdb", ["-D", data, "-U", "synthetic_admin", "--pwfile", passFile,
    "--auth-host=scram-sha-256", "--auth-local=scram-sha-256", "--encoding=UTF8", "--locale=C"]);
  await command("pg_ctl", ["start", "-D", data, "-l", path.join(root, "synthetic.log"), "-o", `-h 127.0.0.1 -p ${port}`, "-w"]); started = true;
  const common = { host: "127.0.0.1", port, password, database: "postgres", max: 3, connectionTimeoutMillis: 3000 };
  admin = new Pool({ ...common, user: "synthetic_admin" });
  await admin.query(`CREATE ROLE ia4tube_social_owner NOLOGIN;
    GRANT CREATE ON DATABASE postgres TO ia4tube_social_owner;
    CREATE ROLE ia4tube_social_runtime LOGIN PASSWORD '${password}';
    CREATE SCHEMA ia4tube_social AUTHORIZATION ia4tube_social_owner;
    SET ROLE ia4tube_social_owner;
    CREATE TABLE ia4tube_social.companies(id uuid PRIMARY KEY);
    RESET ROLE;`);
  await admin.query(fs.readFileSync(path.join(__dirname, "../db/calendar-migrations/0001_calendar_bridge.up.sql"), "utf8"));
  runtime = new Pool({ ...common, user: "ia4tube_social_runtime" });
  const store = createCalendarStore({ pool: runtime, role: "ia4tube_social_runtime" }); await store.verify();
  const a = crypto.randomUUID(), b = crypto.randomUUID(); await admin.query("INSERT INTO ia4tube_social.companies(id) VALUES($1),($2)", [a,b]);
  await store.update(a, state => { state.preferences.enabled = true; return null; });
  await store.update(b, state => { state.preferences.enabled = false; return null; });
  const unscoped = await runtime.query("SELECT company_id FROM ia4tube_calendar.owner_state"); assert.equal(unscoped.rowCount, 0);
  await withTransaction(runtime, async client => {
    assert.equal((await client.query("SELECT company_id FROM ia4tube_calendar.owner_state")).rowCount, 1);
    assert.equal((await client.query("SELECT company_id FROM ia4tube_calendar.owner_state WHERE company_id=$1", [b])).rowCount, 0);
    await assert.rejects(client.query("UPDATE ia4tube_calendar.owner_state SET company_id=$1 WHERE company_id=$2", [b,a]));
  }, { companyId: a });
  await assert.rejects(store.update(a, state => { state.preferences.enabled = false; throw new Error("synthetic rollback"); }));
  assert.equal(await store.update(a, state => state.preferences.enabled), true);
  const revisions = await admin.query("SELECT revision FROM ia4tube_calendar.owner_state WHERE company_id=$1", [a]);
  await store.update(a, state => state.preferences);
  assert.equal((await admin.query("SELECT revision FROM ia4tube_calendar.owner_state WHERE company_id=$1", [a])).rows[0].revision, revisions.rows[0].revision);
  const claims = await Promise.all(Array.from({ length: 8 }, () => store.update(a, state => {
    if (state.testClaim) return false; state.testClaim = true; return true;
  })));
  assert.equal(claims.filter(Boolean).length, 1);
  await admin.query("ALTER POLICY calendar_owner_scope ON ia4tube_calendar.owner_state USING (true)");
  await assert.rejects(store.verify(), { code: "calendar_schema_not_ready" });
});
