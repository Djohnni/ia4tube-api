"use strict";

const assert = require("node:assert/strict"), test = require("node:test");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { spawn } = require("node:child_process");
const jwt = require("jsonwebtoken");
const { databaseTargetFingerprint } = require("../src/persistence/postgres/config");
const root = path.resolve(__dirname, "..");

test("actual five official session issuances use scoped provisioning without changing legacy authentication", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-tenant-login-http-"));
  const password = "synthetic-local-login-password", ownerA = "synthetic-http-owner-a", ownerB = "synthetic-http-owner-b";
  const secret = "synthetic-tenant-http-session-secret-at-least-32";
  const hash = require("bcryptjs").hashSync(password, 4);
  const client = active => ({ ativo: active, senha_hash: hash, nome_time: "Synthetic", plano: "free", saldo_mensal: 0, saldo_extra: 0 });
  fs.writeFileSync(path.join(directory, "clientes.json"), JSON.stringify({
    [ownerA]: client(true), [ownerB]: client(true), "synthetic-inactive-owner": client(false)
  }));
  // All application network/command entry points are blocked BEFORE server.js.
  // Google verification is an in-memory synthetic response, never an HTTP call.
  // SQL uses the strict scoped protocol double, not a real database.
  const bootstrap = String.raw`
    "use strict";
    const blocked = () => { process.stderr.write("TENANT_FORBIDDEN_EFFECT\n"); throw new Error("synthetic_external_forbidden"); };
    global.fetch = async url => {
      if (url === "https://oauth2.googleapis.com/tokeninfo?id_token=synthetic-google-id-token")
        return { ok: true, json: async () => ({ aud: "synthetic-google-client", sub: "synthetic_google_subject", name: "Synthetic" }) };
      return blocked();
    };
    const http = require("node:http"), https = require("node:https");
    http.request = http.get = https.request = https.get = blocked;
    const net = require("node:net"); net.connect = net.createConnection = net.Socket.prototype.connect = blocked;
    require("node:tls").connect = blocked;
    const subprocess = require("node:child_process");
    for (const name of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]) subprocess[name] = blocked;
    global.setInterval = () => ({ unref() {}, ref() {} });
    global.clearInterval = () => {};
    const { createTenantMemoryPool } = require("./tests/helpers/production-tenant-memory-pool");
    const { createProductionTenantRepository, ENSURE_OFFICIAL_OWNER_SQL } = require("./src/persistence/postgres/production-tenant-repository");
    const { createCompanyScopedRepository } = require("./src/persistence/postgres/company-scoped-repository");
    const { createSocialAuthAdapter } = require("./src/social/auth-adapter");
    const pool = createTenantMemoryPool();
    const bcrypt = require("bcryptjs"), originalCompare = bcrypt.compareSync, originalHash = bcrypt.hashSync;
    let legacyError = null;
    bcrypt.compareSync = (...args) => { if (legacyError === "compare") { legacyError = null; throw new Error("synthetic_legacy_failure"); } return originalCompare(...args); };
    bcrypt.hashSync = (...args) => { if (legacyError === "hash") { legacyError = null; throw new Error("synthetic_legacy_failure"); } return originalHash(...args); };
    const auth = createSocialAuthAdapter({ namespaceUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", derivationVersion: "v1", key: Buffer.alloc(32, 17) });
    const unavailable = async () => { throw Object.assign(new Error(), { code: "external_capability_disabled" }); };
    const oauth = { authorize: unavailable, callback: unavailable, disconnect: unavailable, getAuthorizationStatus: unavailable,
      getConnection: unavailable, getConnectionHealth: unavailable, getCurrentConnection: async () => ({ ok: true, connection: null }) };
    const reviewer = { getPublication: unavailable, listMedia: async () => ({ ok: true, media: [] }),
      listPublications: async () => ({ ok: true, publications: [] }), publish: unavailable, reconcile: unavailable };
    const runtime = { enabled: true, auth, companies: createCompanyScopedRepository({ pool, identityDerivationVersion: "v1" }),
      tenantProvisioning: createProductionTenantRepository({ pool, identityDerivationVersion: "v1" }),
      instagramOAuth: oauth, instagramReviewer: reviewer, instagramPublication: null, metaCompliance: null, close: async () => {} };
    const modulePath = require.resolve("./src/social/server-runtime");
    const original = require(modulePath);
    require.cache[modulePath].exports = { ...original, initializeSocialServerRuntime: options => original.initializeSocialServerRuntime({ ...options, createRuntime: async () => runtime }) };
    const express = require("express");
    const wrapped = (...args) => {
      const app = express(...args), listen = app.listen;
      // These controls exist only in the isolated test process, never production.
      app.get("/__synthetic_tenant_state", (_req, res) => res.json({
        tenants: [...pool.tenants.values()], writes: pool.statements.filter(entry => entry.sql === ENSURE_OFFICIAL_OWNER_SQL).length
      }));
      app.post("/__synthetic_tenant_failure", express.json(), (req, res) => {
        legacyError = ["compare", "hash"].includes(req.body.legacyError) ? req.body.legacyError : null;
        pool.setFailure(req.body.enabled ? Object.assign(new Error("SYNTHETIC_PRIVATE_DB_DETAIL"), { code: "08006" }) : null); res.json({ ok: true });
      });
      app.listen = (_port, callback) => listen.call(app, 0, "127.0.0.1", function() {
        if (callback) callback(); process.stdout.write("TENANT_READY " + JSON.stringify({ port: this.address().port }) + "\n");
      });
      return app;
    };
    Object.assign(wrapped, express); require.cache[require.resolve("express")].exports = wrapped;
    require("./server.js");
  `;
  const env = { NODE_ENV: "test", DATA_DIR: directory, PORT: "0", JWT_SECRET: secret, GOOGLE_CLIENT_ID: "synthetic-google-client",
    SOCIAL_IDENTITY_DERIVATION_KEY: Buffer.alloc(32, 17).toString("base64"), SOCIAL_TENANT_NAMESPACE_UUID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    SOCIAL_IDENTITY_DERIVATION_VERSION: "v1",
    ENVIRONMENT: "production", PUBLIC_API_BASE_URL: "https://ia4tube-api.onrender.com", SOCIAL_PERSISTENCE_ENABLED: "true",
    SOCIAL_INSTAGRAM_ENABLED: "true", REAL_REVIEWER_UI_ENABLED: "false", SOCIAL_EXTERNAL_CONNECTION_ENABLED: "false", SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false" };
  const syntheticDatabaseUrl = new URL("postgresql://ia4tube_social_runtime:synthetic-test-only@dpg-dae4tmf40ujc73dr2dog-a.oregon-postgres.render.com:5432/ia4tube_social_production");
  env.DATABASE_URL = syntheticDatabaseUrl.href;
  env.SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN = "ia4tube_social_runtime";
  env.SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT = databaseTargetFingerprint(syntheticDatabaseUrl);
  for (const name of ["FCM_TOKEN_REGISTRATION_ENABLED", "FCM_ART_READY_EVENT_ENABLED", "FCM_DELIVERY_ENABLED", "FCM_AUTOMATIC_NOTIFICATIONS_ENABLED",
    "FCM_STATUS_NOTIFICATIONS_ENABLED", "FCM_SCHEDULED_NOTIFICATIONS_ENABLED", "FCM_MANUAL_NOTIFICATIONS_ENABLED",
    "IA4TUBE_ADMIN_FREE_ARTS_ENABLED", "IA4TUBE_ADMIN_FREE_ARTS_NOTIFICATIONS_ENABLED"]) env[name] = "false";
  for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  const child = spawn(process.execPath, ["-e", bootstrap], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes.toString(); }); child.stderr.on("data", bytes => { output += bytes.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
      const timer = setTimeout(resolve, 3000); child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill();
    });
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("ia4tube-tenant-login-http-")); fs.rmSync(directory, { recursive: true, force: true });
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("synthetic tenant listener timed out")), 10000);
    child.stdout.on("data", () => { const match = output.match(/TENANT_READY (\{[^\n]+\})/); if (match) { clearTimeout(timer); resolve(JSON.parse(match[1])); } });
    child.once("error", () => { clearTimeout(timer); reject(new Error("synthetic process failed")); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("synthetic listener exited before readiness")); });
  });
  async function request(route, { method = "GET", token, body } = {}) {
    return new Promise((resolve, reject) => {
      const headers = {}; if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const req = http.request({ hostname: "127.0.0.1", port: ready.port, path: route, method, headers, timeout: 6000 }, res => {
        let raw = ""; res.setEncoding("utf8"); res.on("data", chunk => { raw += chunk; });
        res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch { reject(new Error("invalid synthetic HTTP response")); } });
      });
      req.on("error", reject); req.on("timeout", () => req.destroy(new Error("synthetic HTTP timeout")));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const state = async () => (await request("/__synthetic_tenant_state")).body;
  let tokenA;
  await t.test("wrong credential and inactive owner never invoke provisioning", async () => {
    assert.equal((await request("/auth/login", { method: "POST", body: { whatsapp: ownerA, senha: "wrong" } })).status, 401);
    assert.equal((await request("/auth/login", { method: "POST", body: { whatsapp: "synthetic-inactive-owner", senha: password } })).status, 403);
    assert.equal((await state()).writes, 0);
  });
  await t.test("unexpected legacy errors still reach the Express4 error handler, never become floating rejections", async () => {
    for (const [route, legacyError] of [["login", "compare"], ["register", "hash"]]) {
      await request("/__synthetic_tenant_failure", { method: "POST", body: { legacyError } });
      const result = await request(`/auth/${route}`, { method: "POST", body: {
        whatsapp: route === "login" ? ownerA : "synthetic-error-registration", senha: password } });
      assert.equal(result.status, 500); assert.equal((await state()).writes, 0);
    }
  });
  await t.test("login replays are idempotent and client-supplied company cannot replace the authenticated owner", async () => {
    for (let n = 0; n < 2; n++) {
      const result = await request("/auth/login", { method: "POST", body: { whatsapp: ownerA, senha: password, company_id: ownerB, companyId: ownerB, role: "owner" } });
      assert.equal(result.status, 200); tokenA = result.body.token;
      const claims = jwt.verify(tokenA, secret, { algorithms: ["HS256"], issuer: "ia4tube-api", audience: "ia4tube-client" });
      assert.equal(claims.company_id, ownerA); assert.equal(claims.sub, ownerA);
    }
    assert.equal((await state()).tenants.length, 1);
    const before = (await state()).writes;
    assert.equal((await request("/v1/social/connections/instagram", { token: tokenA })).status, 200);
    assert.equal((await request("/v1/social/reviewer/publications", { token: tokenA })).status, 200);
    assert.equal((await state()).writes, before, "GETs never bootstrap/repair tenants");
  });
  await t.test("second real owner gets an independent deterministic company", async () => {
    const result = await request("/auth/login", { method: "POST", body: { whatsapp: ownerB, senha: password } });
    assert.equal(result.status, 200); const rows = (await state()).tenants;
    assert.equal(rows.length, 2); assert.notEqual(rows[0].company_id, rows[1].company_id); assert.notEqual(rows[0].user_id, rows[1].user_id);
  });
  await t.test("registration provisions only after successful account creation", async () => {
    const body = { whatsapp: "synthetic-http-register", senha: password, nome_time: "Untrusted display name", companyId: ownerA };
    assert.equal((await request("/auth/register", { method: "POST", body })).status, 200);
    const before = (await state()).writes;
    assert.equal((await request("/auth/register", { method: "POST", body })).status, 400);
    assert.equal((await state()).writes, before); assert.equal((await state()).tenants.length, 3);
  });
  await t.test("automatic registration remains social-ineligible; authenticated finalization binds only final identity", async () => {
    const automatic = await request("/auth/auto-register", { method: "POST", body: { login: "synthetic-temporary" } });
    assert.equal(automatic.status, 200); assert.equal((await state()).tenants.length, 3);
    assert.equal((await request("/v1/social/connections/instagram", { token: automatic.body.token })).status, 401);
    const finalized = await request("/auth/finalizar-conta-auto", { method: "POST", token: automatic.body.token,
      body: { login: "synthetic-finalized", senha: password } });
    assert.equal(finalized.status, 200); assert.equal(jwt.decode(finalized.body.token).sub, "synthetic-finalized");
    assert.equal((await state()).tenants.length, 4);
    const before = (await state()).writes;
    assert.equal((await request("/auth/finalizar-conta-auto", { method: "POST", token: finalized.body.token,
      body: { login: "synthetic-renamed-again", senha: password } })).status, 400);
    assert.equal((await state()).writes, before);
  });
  await t.test("Google-verified issuance uses the verified subject, not submitted company", async () => {
    const result = await request("/auth/google", { method: "POST", body: { id_token: "synthetic-google-id-token", company_id: ownerA } });
    assert.equal(result.status, 200); assert.equal(jwt.decode(result.body.token).sub, "google_synthetic_google_subject");
    assert.equal((await state()).tenants.length, 5);
  });
  await t.test("database failure after startup preserves legitimate JWT and leaves social safely unavailable", async () => {
    await request("/__synthetic_tenant_failure", { method: "POST", body: { enabled: true } });
    const result = await request("/auth/login", { method: "POST", body: { whatsapp: ownerA, senha: password } });
    assert.equal(result.status, 200); assert.equal(jwt.verify(result.body.token, secret).sub, ownerA);
    assert.equal((await request("/me", { token: result.body.token })).status, 200);
    const social = await request("/v1/social/connections/instagram", { token: result.body.token });
    assert.equal(social.status, 503); assert.equal(social.body.code, "social_tenant_readiness_unavailable");
    assert.ok(!JSON.stringify(result).includes("SYNTHETIC_PRIVATE_DB_DETAIL"));
    await request("/__synthetic_tenant_failure", { method: "POST", body: { enabled: false } });
  });
  assert.ok(!output.includes("TENANT_FORBIDDEN_EFFECT")); assert.ok(!output.includes("SYNTHETIC_PRIVATE_DB_DETAIL"));
});
