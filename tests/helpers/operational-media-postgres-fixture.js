"use strict";

// Test-only physical fixture: every credential, database and listener is born
// here. No environment DATABASE_URL, saved app settings or external DB is read.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), net = require("node:net");
const crypto = require("node:crypto"), { spawn } = require("node:child_process"), { Pool } = require("pg");
const assert = require("node:assert/strict");
const PREFIX = "ia4tube-operational-media-pg-synthetic-";
async function createOperationalMediaPostgresFixture(t, { binDirectory = process.env.CALENDAR_OPERATIONAL_MEDIA_TEST_PG_BIN,
  initializeSocialSchema } = {}) {
  assert.ok(initializeSocialSchema === undefined || typeof initializeSocialSchema === "function");
  assert.ok(path.isAbsolute(binDirectory || ""), "Explicit installed synthetic-test PG binaries are required");
  const bin = path.resolve(binDirectory), extension = process.platform === "win32" ? ".exe" : "";
  for (const name of ["postgres", "pg_ctl", "initdb"]) assert.equal(fs.statSync(path.join(bin, name + extension)).isFile(), true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  const data = path.join(root, "database"), passwordFile = path.join(root, "synthetic-password");
  const password = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(passwordFile, password, { mode: 0o600, flag: "wx" });
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
  const env = { LANG: "C", LC_ALL: "C", TMP: root, TEMP: root };
  if (process.platform === "win32") {
    assert.ok(process.env.SystemRoot); env.SystemRoot = process.env.SystemRoot;
    env.COMSPEC = path.join(process.env.SystemRoot, "System32", "cmd.exe");
    env.PATH = [bin, path.join(process.env.SystemRoot, "System32"), process.env.SystemRoot].join(path.delimiter);
  } else env.PATH = bin + path.delimiter + "/usr/bin:/bin";
  async function command(name, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(path.join(bin, name + extension), args, { windowsHide: true, shell: false, stdio: "ignore", env });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Synthetic ${name} timeout`)); }, 45000);
      child.once("error", () => { clearTimeout(timer); reject(new Error(`Synthetic ${name} unavailable`)); });
      child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Synthetic ${name} failed`)); });
    });
  }
  let started = false, closed = false, adminPool, tenantPool, capacityPool, transferPool;
  const common = { host: "127.0.0.1", port, password, database: "postgres", max: 8, connectionTimeoutMillis: 3000,
    statement_timeout: 10000, query_timeout: 12000, application_name: "synthetic_operational_media_test" };
  const pool = user => { const value = new Pool({ ...common, user }); value.on("error", () => {}); return value; };
  function openPools() {
    adminPool = pool("synthetic_media_admin"); tenantPool = pool("ia4tube_social_runtime");
    capacityPool = pool("ia4tube_media_capacity_runtime"); transferPool = pool("ia4tube_media_transfer_runtime");
  }
  async function closePools() {
    await Promise.all([adminPool, tenantPool, capacityPool, transferPool].map(value => value?.end()));
    adminPool = tenantPool = capacityPool = transferPool = null;
  }
  async function stop() {
    if (started || fs.existsSync(path.join(data, "postmaster.pid"))) await command("pg_ctl", ["stop", "-D", data, "-m", "fast", "-w"]);
    started = false;
    assert.equal(fs.existsSync(path.join(data, "postmaster.pid")), false);
    const listening = await new Promise(resolve => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(1000); socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false)); socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
    assert.equal(listening, false, "Synthetic listener must be closed before cleanup or restart");
  }
  async function start() {
    await command("pg_ctl", ["start", "-D", data, "-l", path.join(root, "synthetic.log"), "-o", `-h 127.0.0.1 -p ${port}`, "-w"]);
    started = true;
  }
  t.after(async () => {
    if (closed) return; closed = true;
    await closePools(); await stop();
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith(PREFIX)); assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    fs.rmSync(target, { recursive: true, force: true }); assert.equal(fs.existsSync(target), false);
    t.diagnostic("NEW_SYNTHETIC_PG_STOPPED=YES; LOOPBACK_CLOSED=YES; ONLY_NEW_SYNTHETIC_DIRECTORY_REMOVED=YES");
  });
  await command("initdb", ["-D", data, "-U", "synthetic_media_admin", "--pwfile", passwordFile,
    "--auth-host=scram-sha-256", "--auth-local=scram-sha-256", "--encoding=UTF8", "--locale=C"]);
  fs.unlinkSync(passwordFile); await start();
  adminPool = pool("synthetic_media_admin");
  await adminPool.query(`CREATE ROLE ia4tube_social_owner NOLOGIN;
    GRANT CREATE ON DATABASE postgres TO ia4tube_social_owner;
    CREATE ROLE ia4tube_social_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}';
    CREATE ROLE ia4tube_media_capacity_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}';
    CREATE ROLE ia4tube_media_transfer_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}';`);
  if (initializeSocialSchema) await initializeSocialSchema({ adminPool });
  else await adminPool.query(`CREATE SCHEMA ia4tube_social AUTHORIZATION ia4tube_social_owner;
    REVOKE ALL ON SCHEMA ia4tube_social FROM PUBLIC;
    SET ROLE ia4tube_social_owner;
    CREATE TABLE ia4tube_social.companies(id uuid PRIMARY KEY);
    CREATE TABLE ia4tube_social.synthetic_tenant_secret(company_id uuid PRIMARY KEY, marker text);
    RESET ROLE;`);
  for (const migration of ["0001_calendar_bridge.up.sql", "0002_import_upload_state.up.sql",
    "0003_global_media_capacity.up.sql", "0004_transfer_authorization_registry.up.sql"]) {
    await adminPool.query(fs.readFileSync(path.join(__dirname, "../../db/calendar-migrations", migration), "utf8"));
  }
  await adminPool.end(); openPools();
  const identity = await adminPool.query("SELECT host(inet_server_addr()) AS address,current_setting('server_version') AS version");
  assert.equal(identity.rows[0].address, "127.0.0.1");
  return Object.freeze({
    root, platform: process.platform, databaseVersion: identity.rows[0].version,
    get adminPool() { return adminPool; }, get tenantPool() { return tenantPool; },
    get capacityPool() { return capacityPool; }, get transferPool() { return transferPool; },
    async addCompany(id = crypto.randomUUID()) {
      assert.match(id, /^[a-f0-9-]{36}$/); await adminPool.query("INSERT INTO ia4tube_social.companies(id) VALUES($1)", [id]); return id;
    },
    async restart() { await closePools(); await stop(); await start(); openPools(); },
    async reopenPools() { await closePools(); openPools(); }
  });
}
module.exports = { createOperationalMediaPostgresFixture };
