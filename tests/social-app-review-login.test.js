"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const { APP_REVIEW_LOGIN_PREFIX } = require("../src/social/app-review-policy");
const { REVIEW_LOGIN, REVIEW_NAME, REVIEW_ORIGIN } = require("../scripts/social-app-review-provision");

const ROOT = path.resolve(__dirname, "..");
const SECRET = "app-review-local-login-secret-at-least-32-characters";

async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function request(port, pathname, body, token) {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port, path: pathname,
      method: data ? "POST" : "GET",
      headers: {
        Host: new URL(REVIEW_ORIGIN).host,
        "X-Forwarded-Proto": "https",
        ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const value = response.headers["content-type"]?.includes("application/json")
          ? JSON.parse(text) : text;
        resolve({ status: response.statusCode, value });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

test("dedicated product registration/login works offline and derives isolated company from verified session", { timeout: 30000 }, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-app-review-login-"));
  const dataDir = path.join(temporary, "data");
  const port = await unusedPort();
  const password = `Local-Only-9-${crypto.randomBytes(24).toString("hex")}`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "clientes.json"), JSON.stringify({
    [REVIEW_LOGIN]: {
      nome_time: REVIEW_NAME,
      login_id: REVIEW_LOGIN,
      senha_hash: bcrypt.hashSync(password, 4),
      plano: 0,
      saldo_mensal: 0,
      saldo_extra: 0,
      artes_avulsas_restantes: 0,
      artes_avulsas_usadas: 0,
      artes_avulsas_total_compradas: 0,
      artes_avulsas_compras: [],
      artes_avulsas_consumos: [],
      usados_no_ciclo: 0,
      ciclo_mes: "2026-09",
      ativo: true
    }
  }, null, 2), "utf8");
  const system = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|USERPROFILE)$/i.test(name)
  ));
  const env = {
    ...system,
    PORT: String(port), DATA_DIR: dataDir, NODE_ENV: "test", ENVIRONMENT: "staging",
    PUBLIC_API_BASE_URL: REVIEW_ORIGIN,
    HTTPS_ENFORCE: "true", HTTPS_ALLOW_LOCAL_HTTP: "false",
    JWT_SECRET: SECRET,
    ORDER_MEDIA_SIGNING_SECRET: "app-review-local-media-secret-at-least-32-characters",
    BOT_ADMIN_WHATSAPP: "app-review-local-admin",
    FCM_MOCK: "1", FCM_DELIVERY_ENABLED: "false", FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "false",
    IA4TUBE_FREE_ART_ENABLED: "false", SOCIAL_PERSISTENCE_ENABLED: "false",
    SOCIAL_INSTAGRAM_ENABLED: "false", SOCIAL_EXTERNAL_CONNECTION_ENABLED: "false",
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false", META_APP_REVIEW_WINDOW_ENABLED: "false",
    REAL_REVIEWER_UI_ENABLED: "true", REVIEW_SANDBOX_ENABLED: "false", SYNTHETIC_PROVIDER_ENABLED: "false",
    AUTH_LOGIN_RATE_LIMIT_MAX: "20", AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX: "20"
  };
  // Real HTTP handlers with a throw-on-use external transport boundary.
  const childSource = [
    "function deny(){ process.stderr.write('OFFLINE_EXTERNAL_DENIED'); throw new Error('offline_external_forbidden'); }",
    "globalThis.fetch = deny;",
    "require('node:http').request = deny; require('node:http').get = deny;",
    "require('node:https').request = deny; require('node:https').get = deny;",
    `require(${JSON.stringify(path.join(ROOT, "server.js"))});`
  ].join("\n");
  const child = spawn(process.execPath, ["-e", childSource], {
    cwd: ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (bytes) => { output += bytes.toString("utf8"); });
  child.stderr.on("data", (bytes) => { output += bytes.toString("utf8"); });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    const safeRoot = path.resolve(temporary);
    assert.equal(path.dirname(safeRoot), path.resolve(os.tmpdir()));
    assert.match(path.basename(safeRoot), /^ia4tube-app-review-login-/);
    fs.rmSync(safeRoot, { recursive: true, force: true });
  });
  const deadline = Date.now() + 15000;
  while (!output.includes("API rodando na porta") && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("isolated_login_server_start_failed");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(output.includes("API rodando na porta"), true);
  const registration = await request(port, "/auth/register", {
    whatsapp: REVIEW_LOGIN, senha: password, nome_time: REVIEW_NAME,
    company_id: "ia4tube_empresas_staging"
  });
  assert.equal(registration.status, 403);
  assert.equal(registration.value.ok, false);
  const prefixSquat = await request(port, "/auth/register", {
    whatsapp: `${APP_REVIEW_LOGIN_PREFIX}attacker`,
    senha: `Blocked-9-${crypto.randomBytes(18).toString("hex")}`,
    nome_time: "Blocked"
  });
  assert.equal(prefixSquat.status, 403);
  assert.equal(prefixSquat.value.ok, false);
  const login = await request(port, "/auth/login", { whatsapp: REVIEW_LOGIN, senha: password });
  assert.equal(login.status, 200);
  assert.equal(login.value.ok, true);
  assert.equal(login.value.nome_time, REVIEW_NAME);
  const claims = jwt.verify(login.value.token, SECRET, {
    algorithms: ["HS256"], issuer: "ia4tube-api", audience: "ia4tube-client"
  });
  assert.equal(claims.sub, REVIEW_LOGIN);
  assert.equal(claims.company_id, REVIEW_LOGIN);
  const auth = createSocialAuthAdapter({
    namespaceUuid: "e20195bc-e11e-4a9f-8560-7177f7156622",
    key: Buffer.alloc(32, 43), derivationVersion: "social-id-v1"
  });
  const principal = auth.fromVerifiedJwt(claims);
  const gate4Principal = auth.fromVerifiedJwt({
    ...claims, sub: "ia4tube_empresas_staging", whatsapp: "ia4tube_empresas_staging", company_id: "ia4tube_empresas_staging"
  });
  assert.notEqual(principal.companyId, gate4Principal.companyId);
  assert.throws(() => auth.fromVerifiedJwt({ ...claims, company_id: "ia4tube_empresas_staging" }));
  const me = await request(port, "/me", undefined, login.value.token);
  assert.equal(me.status, 200);
  const invalid = await request(port, "/auth/login", { whatsapp: REVIEW_LOGIN, senha: "Incorrect-9-Password" });
  assert.equal(invalid.status, 401);
  const clients = JSON.parse(fs.readFileSync(path.join(dataDir, "clientes.json"), "utf8"));
  assert.equal(Object.keys(clients).length, 1);
  assert.equal(clients.ia4tube_empresas_staging, undefined);
  assert.equal(bcrypt.compareSync(password, clients[REVIEW_LOGIN].senha_hash), true);
  assert.equal(JSON.stringify(clients).includes(password), false);
  assert.equal(output.includes(password), false);
  assert.equal(output.includes(login.value.token), false);
  assert.equal(output.includes("OFFLINE_EXTERNAL_DENIED"), false);
  const reviewer = await request(port, "/reviewer");
  assert.equal(reviewer.status, 200);
  assert.match(reviewer.value, /gate5a-reviewer-flow/);
});
