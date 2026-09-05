"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const integration = require("../src/social/production-integration");

const root = path.resolve(__dirname, "..");
const LIVE_BASE = "1bd987f1ecbbd3a64f2ad0e905d30649704f4b3c";
const SERVER_IMPORT = [
  "const {",
  "  createProductionSocialIntegration",
  '} = require("./src/social/production-integration");',
  "const productionSocialIntegration = createProductionSocialIntegration({",
  "  env: process.env",
  "});",
  "",
  ""
].join("\n");
const SERVER_MOUNT =
  'app.use("/v1/social", productionSocialIntegration.middleware);\n\n';

function source(file) {
  return fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
}

function liveSource(file) {
  return execFileSync("git", ["show", `${LIVE_BASE}:${file}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  }).replace(/\r\n/g, "\n");
}

function errorCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message.includes("sentinel"), false);
    return true;
  };
}

test("the default integration is closed, immutable and has no runtime handle", () => {
  const state = integration.createProductionSocialIntegration({ env: {} });
  assert.equal(state.enabled, false);
  assert.equal(state.reason, integration.PREPARATION_INCOMPLETE);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.pendingContracts), true);
  assert.deepEqual(state.pendingContracts, [
    "production_session_v2",
    "publication_account_revision_binding",
    "production_schema_and_recovery"
  ]);
  assert.deepEqual(Object.keys(state).sort(), [
    "enabled", "middleware", "pendingContracts", "reason"
  ]);
});

test("official identity and explicitly closed flags are accepted without a DB", () => {
  assert.equal(integration.assertProductionPreparationBoundary({
    ENVIRONMENT: "production",
    PUBLIC_API_BASE_URL: `${integration.OFFICIAL_API_ORIGIN}/`,
    RENDER_SERVICE_ID: integration.OFFICIAL_WEB_SERVICE_ID,
    ...Object.fromEntries(integration.CLOSED_FLAGS.map((name) => [name, "false"]))
  }), true);
});

for (const name of integration.CLOSED_FLAGS) {
  test(`${name} cannot enable this preparation candidate`, () => {
    assert.throws(
      () => integration.createProductionSocialIntegration({ env: { [name]: "true" } }),
      errorCode(integration.PREPARATION_INCOMPLETE)
    );
  });
  for (const value of ["TRUE", " true ", "1", "yes", true, null]) {
    test(`${name} rejects ambiguous flag ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => integration.assertProductionPreparationBoundary({ [name]: value }),
        errorCode("social_production_flag_invalid")
      );
    });
  }
}

for (const [env, code] of [
  [{ ENVIRONMENT: "staging" }, "social_production_environment_mismatch"],
  [{ ENVIRONMENT: "test" }, "social_production_environment_mismatch"],
  [{ PUBLIC_API_BASE_URL: "https://ia4tube-api-staging-checkpoint-a.onrender.com" }, "social_production_origin_mismatch"],
  [{ PUBLIC_API_BASE_URL: `${integration.OFFICIAL_API_ORIGIN}/unexpected` }, "social_production_origin_mismatch"],
  [{ PUBLIC_API_BASE_URL: `${integration.OFFICIAL_API_ORIGIN}?sentinel=1` }, "social_production_origin_mismatch"],
  [{ RENDER_SERVICE_ID: "srv-sentinel-staging" }, "social_production_service_mismatch"],
  [{ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, "node_tls_verification_disabled"],
  [{ NODE_EXTRA_CA_CERTS: "sentinel.pem" }, "social_database_custom_trust_forbidden"],
  [{ SOCIAL_DATABASE_CA_BASE64: "sentinel" }, "social_database_custom_trust_forbidden"],
  [{ PGPASSWORD: "sentinel" }, "web_service_libpq_environment_override_forbidden"],
  [{ SOCIAL_MIGRATIONS_DATABASE_URL: "sentinel" }, "web_service_privileged_database_credential_forbidden"],
  [{ SOCIAL_LOGIN_BOOTSTRAP_RUNTIME_PASSWORD: "sentinel" }, "web_service_operator_secret_forbidden"],
  [{ SOCIAL_BACKUP_BUNDLE_KEY: "sentinel" }, "web_service_operator_secret_forbidden"],
  [{ DATABASE_URL: "sentinel" }, "web_service_runtime_database_credential_disabled"]
]) {
  test(`closed startup preserves identity/secret/TLS boundary: ${Object.keys(env)[0]} (${code})`, () => {
    assert.throws(
      () => integration.assertProductionPreparationBoundary(env),
      errorCode(code)
    );
  });
}

test("caller-supplied readiness cannot activate the social module", () => {
  let touched = false;
  const state = integration.createProductionSocialIntegration({
    env: {},
    enabled: true,
    ready: true,
    createRuntime() { touched = true; throw new Error("must not initialize"); },
    schemaValidated: true,
    recoveryValidated: true,
    bindingValidated: true
  });
  assert.equal(touched, false);
  assert.equal(state.enabled, false);
});

test("legacy offline origins remain test-only, without a persistence/gate bypass", () => {
  for (const origin of ["https://synthetic.invalid", "https://ia4tube.test"]) {
    const env = { NODE_ENV: "test", PUBLIC_API_BASE_URL: origin };
    assert.equal(integration.createProductionSocialIntegration({ env }).enabled, false);
    for (const extra of [
      { NODE_ENV: "production" },
      { ENVIRONMENT: "production" },
      { RENDER_SERVICE_ID: integration.OFFICIAL_WEB_SERVICE_ID }
    ]) {
      assert.throws(() => integration.assertProductionPreparationBoundary({ ...env, ...extra }),
        errorCode("social_production_origin_mismatch"));
    }
    for (const name of integration.CLOSED_FLAGS) {
      assert.throws(() => integration.assertProductionPreparationBoundary({ ...env, [name]: "true" }),
        errorCode(integration.PREPARATION_INCOMPLETE));
    }
  }
  assert.throws(() => integration.assertProductionPreparationBoundary({
    NODE_ENV: "test",
    PUBLIC_API_BASE_URL: "https://ia4tube-api-staging-checkpoint-a.onrender.com"
  }), errorCode("social_production_origin_mismatch"));
});

for (const method of ["GET", "POST", "DELETE", "PATCH", "PUT", "HEAD", "OPTIONS"]) {
  test(`${method} social middleware returns a non-cacheable error without reading authority or body`, () => {
    const state = integration.createProductionSocialIntegration({ env: {} });
    const headers = {};
    const response = {
      setHeader(name, value) { headers[name] = value; },
      status(value) { this.statusCode = value; return this; },
      json(value) { this.body = value; return this; }
    };
    const request = new Proxy({ method }, {
      get() { throw new Error("request data must not be consumed"); }
    });
    state.middleware(request, response, () => assert.fail("must not fall through"));
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.code, integration.PREPARATION_INCOMPLETE);
    assert.equal(headers["Cache-Control"], "private, no-store");
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.equal(headers["X-Robots-Tag"], "noindex, nofollow, noarchive");
    assert.equal(JSON.stringify(response.body).includes("sentinel"), false);
  });
}

test("server retains the entire live body, including FCM/auth/DATA_DIR/timers/route paths", () => {
  const candidate = source("server.js");
  assert.equal(candidate.startsWith(SERVER_IMPORT), true);
  assert.equal(candidate.split(SERVER_MOUNT).length, 2);
  const unchanged = candidate.slice(SERVER_IMPORT.length).replace(SERVER_MOUNT, "");
  assert.equal(unchanged, liveSource("server.js"));
  assert.ok(candidate.indexOf(SERVER_MOUNT) < candidate.indexOf("const globalJsonParser"));
  assert.ok(candidate.indexOf(SERVER_MOUNT) < candidate.indexOf("express.static"));
});

test("invalid social startup stops before importing legacy modules, scheduling or I/O", () => {
  let legacyImports = 0;
  assert.throws(() => vm.runInNewContext(source("server.js"), {
    process: { env: { SOCIAL_PERSISTENCE_ENABLED: "true" } },
    require(name) {
      if (name === "./src/social/production-integration") return integration;
      legacyImports += 1;
      throw new Error("legacy imports must not run");
    },
    setTimeout() { assert.fail("no timer before boundary"); },
    setInterval() { assert.fail("no timer before boundary"); },
    fetch() { assert.fail("no network before boundary"); }
  }, { timeout: 1000 }), errorCode(integration.PREPARATION_INCOMPLETE));
  assert.equal(legacyImports, 0);
});

test("production boundary neither loads a social runtime nor introduces external actions", () => {
  const moduleSource = source("src/social/production-integration.js");
  const imports = [...moduleSource.matchAll(/require\("([^"]+)"\)/g)]
    .map((match) => match[1]);
  assert.deepEqual(imports, ["../persistence/postgres/config"]);
  assert.doesNotMatch(moduleSource, /\b(?:fetch|setInterval|setTimeout|createPool|createSocialRuntime|initializeSocialServerRuntime)\s*\(/);
});

test("dependency additions preserve every legacy dependency and locked package record", () => {
  const previousPackage = JSON.parse(liveSource("package.json"));
  const currentPackage = JSON.parse(source("package.json"));
  for (const [name, version] of Object.entries(previousPackage.dependencies)) {
    assert.equal(currentPackage.dependencies[name], version, name);
  }
  assert.deepEqual(Object.keys(currentPackage.dependencies)
    .filter((name) => !Object.hasOwn(previousPackage.dependencies, name)).sort(),
  ["pg", "tar-stream"]);
  for (const [name, value] of Object.entries(previousPackage)) {
    if (!["dependencies", "scripts"].includes(name)) {
      assert.deepEqual(currentPackage[name], value, name);
    }
  }
  assert.equal(currentPackage.scripts.start, previousPackage.scripts.start);
  const previousLock = JSON.parse(liveSource("package-lock.json"));
  const currentLock = JSON.parse(source("package-lock.json"));
  for (const [name, record] of Object.entries(previousLock.packages)) {
    if (name) assert.deepEqual(currentLock.packages[name], record, name);
  }
  assert.deepEqual(currentLock.packages[""].dependencies, currentPackage.dependencies);
  const added = Object.keys(currentLock.packages)
    .filter((name) => !Object.hasOwn(previousLock.packages, name));
  assert.equal(added.length, 13);
  assert.equal(currentLock.packages["node_modules/pg"].version, "8.22.0");
  assert.equal(currentLock.packages["node_modules/tar-stream"].version, "3.2.0");
});

test("isolated legacy login/profile/orders/planning and disabled FCM coexist with closed social routes", async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-production-compat-"));
  const dataDirectory = path.join(temporaryRoot, "data");
  fs.mkdirSync(dataDirectory);
  const owner = "synthetic-production-compat";
  const password = "synthetic-compat-password";
  fs.writeFileSync(path.join(dataDirectory, "clientes.json"), JSON.stringify({
    [owner]: {
      whatsapp: owner,
      nome_time: "Empresa sintetica local",
      ativo: true,
      plano: "free",
      saldo_mensal: 0,
      saldo_extra: 0,
      usados_no_ciclo: 0,
      senha_hash: require("bcryptjs").hashSync(password, 4)
    }
  }));

  // This process has no inherited service credentials. All outbound network
  // entry points and command execution are denied before loading server.js;
  // application timers are recorded but never run. Only its HTTP listener uses
  // loopback. The parent drives requests through that listener.
  const bootstrap = String.raw`
    "use strict";
    const blocked = () => { process.stderr.write("COMPAT_FORBIDDEN_EFFECT\n"); throw new Error("compat_external_forbidden"); };
    global.fetch = blocked;
    const http = require("node:http");
    const https = require("node:https");
    http.request = http.get = https.request = https.get = blocked;
    const net = require("node:net");
    net.connect = net.createConnection = net.Socket.prototype.connect = blocked;
    require("node:tls").connect = blocked;
    const child = require("node:child_process");
    for (const method of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]) child[method] = blocked;
    let scheduled = 0;
    global.setTimeout = global.setInterval = () => {
      scheduled += 1;
      return { unref() {}, ref() {} };
    };
    global.clearTimeout = global.clearInterval = () => {};
    const express = require("express");
    const wrapped = (...args) => {
      const app = express(...args);
      const listen = app.listen;
      app.listen = (_port, callback) => {
        const server = listen.call(app, 0, "127.0.0.1", () => {
          if (callback) callback();
          process.stdout.write("COMPAT_READY " + JSON.stringify({port: server.address().port, scheduled}) + "\n");
        });
        return server;
      };
      return app;
    };
    Object.assign(wrapped, express);
    require.cache[require.resolve("express")].exports = wrapped;
    require("./server.js");
  `;
  const env = {
    NODE_ENV: "test",
    DATA_DIR: dataDirectory,
    PORT: "0",
    JWT_SECRET: "synthetic-local-compat-jwt-secret-longer-than-32",
    PUBLIC_API_BASE_URL: "https://synthetic.invalid",
    SOCIAL_PERSISTENCE_ENABLED: "false",
    FCM_TOKEN_REGISTRATION_ENABLED: "false",
    FCM_ART_READY_EVENT_ENABLED: "false",
    FCM_DELIVERY_ENABLED: "false",
    FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "false",
    FCM_STATUS_NOTIFICATIONS_ENABLED: "false",
    FCM_SCHEDULED_NOTIFICATIONS_ENABLED: "false",
    FCM_MANUAL_NOTIFICATIONS_ENABLED: "false",
    IA4TUBE_ADMIN_FREE_ARTS_ENABLED: "false",
    IA4TUBE_ADMIN_FREE_ARTS_NOTIFICATIONS_ENABLED: "false"
  };
  for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const child = spawn(process.execPath, ["-e", bootstrap], {
    cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const resolved = path.resolve(temporaryRoot);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("ia4tube-production-compat-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`isolated startup timed out: ${output}`)), 10000);
    const inspect = () => {
      const match = output.match(/COMPAT_READY (\{[^\n]+\})/);
      if (match) { clearTimeout(timer); resolve(JSON.parse(match[1])); }
    };
    child.stdout.on("data", inspect);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`isolated startup exited: ${output}`));
    });
    inspect();
  });
  assert.equal(ready.scheduled, 2, "only the two unchanged maintenance intervals are registered");

  async function request(route, { method = "GET", token, body } = {}) {
    return new Promise((resolve, reject) => {
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const req = http.request({ hostname: "127.0.0.1", port: ready.port,
        path: route, method, headers, timeout: 5000 }, (res) => {
        let bytes = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { bytes += chunk; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(bytes) }); }
          catch (error) { reject(error); }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("isolated request timeout")));
      req.end(body);
    });
  }

  const login = await request("/auth/login", { method: "POST",
    body: JSON.stringify({ whatsapp: owner, senha: password }) });
  assert.equal(login.status, 200);
  assert.equal(login.body.ok, true);
  assert.equal(login.body.nome_time, "Empresa sintetica local");
  const token = login.body.token;
  const jwtClaims = require("jsonwebtoken").verify(token, env.JWT_SECRET, { algorithms: ["HS256"] });
  assert.equal(jwtClaims.whatsapp, owner);
  assert.equal(jwtClaims.token_version, undefined, "legacy session was not silently upgraded");
  for (const route of ["/me", "/meus-pedidos", "/empresa/planejamento-mensal"]) {
    const result = await request(route, { token });
    assert.equal(result.status, 200, route);
    assert.equal(result.body.ok, true, route);
  }
  for (const route of [
    "/v1/social/connections/instagram",
    "/v1/social/reviewer/publications",
    "/v1/social/reviewer/media"
  ]) {
    const result = await request(route, { token });
    assert.equal(result.status, 503, route);
    assert.equal(result.body.code, integration.PREPARATION_INCOMPLETE);
    assert.equal(result.headers["cache-control"], "private, no-store");
  }
  const malformed = await request("/v1/social/reviewer/publications", {
    method: "POST", token, body: "{ deliberately invalid JSON"
  });
  assert.equal(malformed.status, 503, "closed social route precedes the global JSON parser");
  const fcm = await request("/me/fcm-token", { method: "POST", body: "{" });
  assert.equal(fcm.status, 503);
  assert.equal(fcm.body.code, "fcm_token_registration_disabled");
  assert.equal(output.includes("COMPAT_FORBIDDEN_EFFECT"), false);
  assert.equal(fs.existsSync(path.join(dataDirectory, "notifications", "art-ready-outbox.json")), false);
  assert.equal(fs.existsSync(path.join(dataDirectory, "reviewer_media")), false);
});
