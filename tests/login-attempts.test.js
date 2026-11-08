"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { canonicalIp, loginOrigin, createLoginAttemptStore, createLoginAttemptProtection } = require("../src/security/login-attempts");

const SECRET = "synthetic-login-security-secret-at-least-32";
const MINUTE = 60_000;
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-login-attempts-"));
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith("ia4tube-login-attempts-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let now = 1_800_000_000_000;
  const config = { dataDir: directory, secret: SECRET, clock: () => now, ...options };
  return { directory, config, store: createLoginAttemptStore(config), advance: ms => { now += ms; } };
}

test("fifth failure starts one minute; later groups escalate to five and fifteen, capped", t => {
  const f = fixture(t), ip = "203.0.113.10";
  for (const delay of [60, 300, 900, 900]) {
    for (let n = 1; n < 5; n++) assert.equal(f.store.failure("owner", ip).blocked, false);
    const blocked = f.store.failure("owner", ip);
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.retryAfterSeconds, delay);
    f.advance(delay * 1000);
    assert.equal(f.store.check("owner", ip).blocked, false);
  }
});

test("blocked requests do not extend the original deadline", t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) f.store.failure("a", "203.0.113.1");
  f.advance(20_000);
  for (let i = 0; i < 50; i++) assert.equal(f.store.failure("a", "203.0.113.1").retryAfterSeconds, 40);
  f.advance(40_000);
  assert.equal(f.store.check("a", "203.0.113.1").blocked, false);
});

test("account protection survives IP rotation without blocking an unrelated account", t => {
  const f = fixture(t);
  for (let i = 1; i <= 5; i++) f.store.failure("target", `203.0.113.${i}`);
  assert.equal(f.store.check("target", "198.51.100.50").blocked, true);
  assert.equal(f.store.check("other", "203.0.113.1").blocked, false);
  assert.equal(f.store.check("other", "198.51.100.50").blocked, false);
});

test("thirty failures across accounts block only the origin for fifteen minutes", t => {
  const f = fixture(t);
  for (let i = 0; i < 29; i++) assert.equal(f.store.failure(`owner-${i}`, "203.0.113.1").blocked, false);
  assert.equal(f.store.failure("owner-29", "203.0.113.1").retryAfterSeconds, 900);
  assert.equal(f.store.check("new-owner", "203.0.113.1").blocked, true);
  assert.equal(f.store.check("new-owner", "203.0.113.2").blocked, false);
});

test("successful login clears the account counter but preserves the origin aggregate", t => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) f.store.failure("owner", "203.0.113.1");
  f.store.success("owner", "203.0.113.1");
  for (let i = 0; i < 4; i++) assert.equal(f.store.failure("owner", "203.0.113.1").blocked, false);
  for (let i = 0; i < 22; i++) f.store.failure(`other-${i}`, "203.0.113.1");
  assert.equal(f.store.check("new-owner", "203.0.113.1").blocked, true);
});

test("failure windows and escalation expire; no permanent account lock", t => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) f.store.failure("owner", "203.0.113.1");
  f.advance(15 * MINUTE);
  assert.equal(f.store.failure("owner", "203.0.113.1").blocked, false);
  for (let i = 0; i < 4; i++) f.store.failure("owner", "203.0.113.1");
  assert.equal(f.store.check("owner", "203.0.113.1").retryAfterSeconds, 60);
  f.advance(24 * 60 * MINUTE);
  assert.equal(f.store.check("owner", "203.0.113.1").blocked, false);
  for (let i = 0; i < 5; i++) f.store.failure("owner", "203.0.113.1");
  assert.equal(f.store.check("owner", "203.0.113.1").retryAfterSeconds, 60);
});

test("new store instance reads persisted counters and deadlines after restart", t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) f.store.failure("owner", "203.0.113.1");
  f.advance(10_000);
  const restarted = createLoginAttemptStore(f.config);
  assert.equal(restarted.check("owner", "203.0.113.99").retryAfterSeconds, 50);
});

test("state contains only HMAC identifiers and numbers, never raw logins, IPs, passwords or tokens", t => {
  const f = fixture(t);
  f.store.failure("synthetic-private-login", "203.0.113.77");
  const raw = fs.readFileSync(path.join(f.directory, "security", "login-attempts-v1.json"), "utf8");
  assert.ok(!raw.includes("synthetic-private-login") && !raw.includes("203.0.113.77") && !raw.includes(SECRET));
  assert.equal(Object.keys(JSON.parse(raw).entries).length, 2);
  assert.equal(fs.readdirSync(path.join(f.directory, "security")).length, 1);
});

test("malformed storage fails closed without overwriting the existing evidence", t => {
  const f = fixture(t);
  f.store.failure("owner", "203.0.113.1");
  const file = path.join(f.directory, "security", "login-attempts-v1.json");
  fs.writeFileSync(file, "{broken");
  assert.throws(() => f.store.check("owner", "203.0.113.1"), /unavailable/);
  assert.throws(() => f.store.failure("owner", "203.0.113.1"), /unavailable/);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

test("bounded storage does not evict active restrictions or prevent clean successful checks", t => {
  const f = fixture(t, { maxEntries: 2 });
  f.store.failure("owner", "203.0.113.1");
  assert.throws(() => f.store.failure("other", "203.0.113.2"), /unavailable/);
  assert.equal(f.store.check("clean-owner", "203.0.113.3").blocked, false);
  f.store.success("clean-owner", "203.0.113.3");
  f.advance(24 * 60 * MINUTE);
  assert.equal(f.store.failure("other", "203.0.113.2").blocked, false);
});

test("IP normalization groups equivalent IPv6 and mapped IPv4 spellings", () => {
  assert.equal(canonicalIp("::ffff:203.0.113.1"), "203.0.113.1");
  assert.equal(canonicalIp("::ffff:cb00:7101"), "203.0.113.1");
  assert.equal(canonicalIp("2001:db8:0:0:0:0:0:1"), canonicalIp("2001:db8::1"));
  assert.equal(canonicalIp("not an ip"), null);
});

test("local/direct requests ignore spoofed forwarded and Cloudflare headers", () => {
  const req = { socket: { remoteAddress: "203.0.113.9" }, headers: { "x-forwarded-for": "1.2.3.4", "cf-connecting-ip": "8.8.8.8" } };
  assert.deepEqual(loginOrigin(req, {}), { ip: "203.0.113.9", source: "socket" });
  assert.deepEqual(loginOrigin(req, { RENDER: "true", RENDER_SERVICE_ID: "synthetic" }), { ip: "203.0.113.9", source: "socket" });
});

test("Render chain stops at the nearest untrusted IP, ignoring spoofed prefixes", () => {
  const env = { RENDER: "true", RENDER_SERVICE_ID: "synthetic" };
  const req = prefix => ({ socket: { remoteAddress: "10.1.1.1" }, headers: {
    "x-forwarded-for": `${prefix}, 203.0.113.80, 172.68.1.1, 10.2.2.2`, "cf-connecting-ip": "8.8.8.8"
  } });
  assert.deepEqual(loginOrigin(req("1.1.1.1"), env), { ip: "203.0.113.80", source: "render_forwarded" });
  assert.deepEqual(loginOrigin(req("2.2.2.2"), env), loginOrigin(req("1.1.1.1"), env));
  assert.equal(loginOrigin({ socket: { remoteAddress: "10.1.1.1" }, headers: { "x-forwarded-for": "malformed" } }, env).source, "proxy_fallback");
});

test("actual login handler and existing signed sessions remain compatible under HTTP concurrency", async t => {
  const f = fixture(t);
  const legacyPassword = "abc";
  const client = { ativo: true, senha_hash: bcrypt.hashSync(legacyPassword, 4), nome_time: "Synthetic", ciclo_mes: "2026-11", usados_no_ciclo: 0 };
  const before = JSON.stringify(client);
  let compareCalls = 0, provisioningCalls = 0;
  const events = [];
  const protection = createLoginAttemptProtection({ ...f.config, env: {}, logger: { warn: (...args) => events.push(args) } });
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const start = source.indexOf('app.post("/auth/login",');
  const end = source.indexOf('app.use("/company/profile"', start);
  assert.ok(start > 0 && end > start);
  const app = express();
  app.use(express.json());
  const normalize = value => String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9._-]+/g, "");
  new Function("app", "normalizarLoginId", "readClientes", "bcrypt", "repairAppReviewCompanyLabel", "nowYYYYMM", "writeClientes", "productionSocialIntegration", "productionSession", "billingService", "loginAttemptProtection", source.slice(start, end))(
    app, normalize, () => ({ owner: client }), { compareSync: (...args) => { compareCalls++; return bcrypt.compareSync(...args); } },
    (_o, name) => name, () => "2026-11", () => { throw Error("Customer writes forbidden"); },
    { afterAuthentication: async () => { provisioningCalls++; } }, { sign: owner => jwt.sign({ whatsapp: owner }, SECRET, { expiresIn: "7d", algorithm: "HS256" }) },
    { getStandaloneArtStatus: () => ({}) }, protection
  );
  app.get("/synthetic-existing-session", (req, res) => {
    try { res.json({ owner: jwt.verify(req.headers.authorization.slice(7), SECRET).whatsapp }); }
    catch { res.status(401).end(); }
  });
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function login(owner = "owner", senha = "wrong") {
    const response = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ whatsapp: owner, senha }) });
    return { status: response.status, retry: response.headers.get("retry-after"), body: await response.json() };
  }
  const valid = await login("owner", legacyPassword);
  assert.equal(valid.status, 200);
  assert.equal(provisioningCalls, 1);
  assert.equal((await login("owner", { malformed: true })).status, 400);
  assert.equal(compareCalls, 1);
  for (let i = 0; i < 4; i++) assert.equal((await login()).status, 401);
  // Normalization aliases share the counter. Parallel requests cannot slip
  // additional bcrypt checks past the fifth failed password in this process.
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => login(i % 2 ? " OWNER " : "ÓWNER")));
  assert.ok(burst.every(result => result.status === 429));
  assert.equal(compareCalls, 6); // initial valid login + exactly five failures
  assert.equal(burst[0].retry, "60");
  assert.match(burst[0].body.error, /Aguarde 1 minuto/);
  assert.equal(events.length, 1);
  assert.ok(!JSON.stringify(events).includes("owner") && !JSON.stringify(events).includes(legacyPassword));
  const oldSession = await fetch(`${base}/synthetic-existing-session`, { headers: { Authorization: `Bearer ${valid.body.token}` } });
  assert.equal(oldSession.status, 200);
  assert.equal((await login("owner", legacyPassword)).status, 429);
  f.advance(MINUTE);
  assert.equal((await login("owner", legacyPassword)).status, 200);
  assert.equal(JSON.stringify(client), before);
  assert.equal(provisioningCalls, 2);
});

test("storage failure returns a clear retryable error without calling credential verification", () => {
  let logs = 0;
  const protection = createLoginAttemptProtection({ env: {}, clock: () => 1000,
    store: { check() { throw Error("synthetic private details"); } }, logger: { warn() { logs++; } } });
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; } };
  assert.equal(protection.begin({ socket: { remoteAddress: "127.0.0.1" } }, res, "owner"), null);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["Retry-After"], "5");
  assert.ok(!JSON.stringify(res.body).includes("private details"));
  protection.begin({}, res, "owner");
  assert.equal(logs, 1);
});
