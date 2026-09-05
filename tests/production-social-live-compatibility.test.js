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

test("default integration stays closed without opening a pool", async () => {
  const state = integration.createProductionSocialIntegration({ env: {} });
  assert.equal(state.enabled, false);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(await state.initialize(), false);
});
for (const name of integration.CLOSED_FLAGS) {
  for (const value of ["TRUE", " true ", "1", true, null]) {
    test(`${name} rejects ambiguous flag ${JSON.stringify(value)}`, () => {
      assert.throws(() => integration.assertProductionPreparationBoundary({ [name]: value }),
        errorCode("social_production_flag_invalid"));
    });
  }
  test(`${name} alone cannot activate an unprepared environment`, () => {
    assert.throws(() => integration.createProductionSocialIntegration({ env: { [name]: "true" } }),
      errorCode(integration.PREPARATION_INCOMPLETE));
  });
}
for (const [env, code] of [
  [{ ENVIRONMENT: "staging" }, "social_production_environment_mismatch"],
  [{ PUBLIC_API_BASE_URL: "https://ia4tube-api-staging-checkpoint-a.onrender.com" }, "social_production_origin_mismatch"],
  [{ RENDER_SERVICE_ID: "srv-wrong" }, "social_production_service_mismatch"],
  [{ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, "node_tls_verification_disabled"],
  [{ NODE_EXTRA_CA_CERTS: "sentinel.pem" }, "social_database_custom_trust_forbidden"],
  [{ PGPASSWORD: "sentinel" }, "web_service_libpq_environment_override_forbidden"],
  [{ SOCIAL_MIGRATIONS_DATABASE_URL: "sentinel" }, "web_service_privileged_database_credential_forbidden"],
  [{ DATABASE_URL: "sentinel" }, "web_service_runtime_database_credential_disabled"]
]) test(`production boundary ${code}`, () => {
  assert.throws(() => integration.assertProductionPreparationBoundary(env), errorCode(code));
});
test("closed middleware does not consume caller input", () => {
  const state = integration.createProductionSocialIntegration({env:{}});
  const response = {setHeader(){},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  state.middleware(new Proxy({}, {get(){assert.fail("input consumed");}}), response);
  assert.equal(response.statusCode,503);
  assert.equal(response.body.code,integration.PREPARATION_INCOMPLETE);
});
test("all legacy server code is preserved except explicit session issuance and startup assembly", () => {
  let candidate = source("server.js");
  assert.ok(candidate.startsWith(SERVER_IMPORT));
  candidate = candidate.slice(SERVER_IMPORT.length).replace(SERVER_MOUNT.trimEnd()+"\nproductionSocialIntegration.mountWeb(app);\n\n", "");
  candidate = candidate.replace('const { createProductionSession } = require("./src/social/production-session");\nconst productionSession = createProductionSession({ secret: JWT_SECRET, readClients: readClientes });\n', "");
  const live = liveSource("server.js");
  const originals = [...live.matchAll(/jwt\.sign\(\{ whatsapp(?:: (\w+))? \}, JWT_SECRET, \{\n\s*algorithm: "HS256",\n\s*expiresIn: "7d"\n\s*\}\)/g)];
  assert.equal(originals.length,5);
  let n=0;
  candidate = candidate.replace(/productionSession\.sign\((\w+)\)/g, () => originals[n++][0]);
  assert.equal(n,5);
  candidate = candidate.replace("function startLegacyBackgroundTasks() {\n","");
  const tail = candidate.indexOf("\n}\n\nproductionSocialIntegration.initialize({");
  assert.ok(tail>0);
  candidate = candidate.slice(0,tail)+"\napp.listen(PORT, () => {\n  console.log(\"API rodando na porta\", PORT);\n});\n";
  assert.equal(candidate,live);
  assert.ok(source("server.js").indexOf(SERVER_MOUNT.trim()) < source("server.js").indexOf("const globalJsonParser"));
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
  assert.equal(jwtClaims.token_version, 2, "a fresh authenticated login issues v2");
  assert.equal(jwtClaims.sub, owner);
  assert.equal(jwtClaims.company_id, owner);
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
