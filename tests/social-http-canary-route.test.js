"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const {
  HTTP_CANARY_APPROVAL,
  HTTP_CANARY_BRANCH,
  HTTP_CANARY_DATABASE_HOST,
  HTTP_CANARY_DATABASE_NAME,
  HTTP_CANARY_ENVIRONMENT_ID,
  HTTP_CANARY_HOSTNAME,
  HTTP_CANARY_PUBLIC_ORIGIN,
  HTTP_CANARY_REPOSITORY,
  HTTP_CANARY_ROUTE,
  HTTP_CANARY_RUNTIME_LOGIN,
  HTTP_CANARY_SERVICE_ID,
  HTTP_CANARY_SERVICE_NAME
} = require("../src/social/http-canary-availability");
const {
  createSocialHttpCanaryRouter
} = require("../src/social/http-canary-routes");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const COMMIT = "a".repeat(40);
const TOKEN = "synthetic_runner_token_" + "x".repeat(40);
const TOKEN_2 = "synthetic_runner_token_" + "y".repeat(40);
const PASSWORD_MARKER = "synthetic_password_never_returned";

function enabledEnvironment(overrides = {}) {
  return {
    SOCIAL_RUNTIME_HTTP_CANARY_ENABLED: "true",
    SOCIAL_RUNTIME_HTTP_CANARY_COMMIT: COMMIT,
    SOCIAL_RUNTIME_CANARY_APPROVED: HTTP_CANARY_APPROVAL,
    SOCIAL_RUNTIME_CANARY_ENVIRONMENT: "staging",
    SOCIAL_RUNTIME_CANARY_EXPECTED_ENVIRONMENT_ID:
      HTTP_CANARY_ENVIRONMENT_ID,
    SOCIAL_RUNTIME_CANARY_COMPANY_A_ID: COMPANY_A,
    SOCIAL_RUNTIME_CANARY_COMPANY_B_ID: COMPANY_B,
    SOCIAL_PERSISTENCE_ENABLED: "true",
    SOCIAL_DATABASE_POOL_MAX: "3",
    SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: HTTP_CANARY_RUNTIME_LOGIN,
    DATABASE_URL:
      `postgresql://${HTTP_CANARY_RUNTIME_LOGIN}:${PASSWORD_MARKER}@` +
      `${HTTP_CANARY_DATABASE_HOST}:5432/${HTTP_CANARY_DATABASE_NAME}` +
      "?sslmode=verify-full",
    RENDER: "true",
    NODE_ENV: "production",
    RENDER_SERVICE_ID: HTTP_CANARY_SERVICE_ID,
    RENDER_SERVICE_NAME: HTTP_CANARY_SERVICE_NAME,
    RENDER_SERVICE_TYPE: "web",
    RENDER_EXTERNAL_HOSTNAME: HTTP_CANARY_HOSTNAME,
    RENDER_GIT_REPO_SLUG: HTTP_CANARY_REPOSITORY,
    RENDER_GIT_BRANCH: HTTP_CANARY_BRANCH,
    RENDER_GIT_COMMIT: COMMIT,
    PUBLIC_API_BASE_URL: HTTP_CANARY_PUBLIC_ORIGIN,
    ...overrides
  };
}

function passedResult(runId = "33333333-3333-4333-8333-333333333333") {
  return {
    runId,
    status: "passed",
    ownReadA: true,
    ownReadB: true,
    crossTenantDeniedA: true,
    crossTenantDeniedB: true,
    missingContextDenied: true,
    tamperedContextDenied: true,
    idempotentWrites: true,
    mutationRolledBack: true,
    vaultRoundTripPassed: true,
    vaultCrossTenantDenied: true,
    vaultTamperDenied: true,
    cleanupCompleted: true,
    residualRecords: 0,
    durationMs: 5
  };
}

async function createServer(options = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  const router = createSocialHttpCanaryRouter({
    env: options.env || enabledEnvironment(),
    internalTokens: options.internalTokens || [TOKEN],
    getRuntimeState:
      options.getRuntimeState ||
      (() => ({
        enabled: true,
        async runHttpCanary() {
          return passedResult();
        }
      })),
    rateLimitMax: options.rateLimitMax,
    rateLimitWindowMs: options.rateLimitWindowMs,
    clock: options.clock,
    idempotencyTtlMs: options.idempotencyTtlMs
  });
  if (router) app.use(router);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use((error, _req, res, _next) => {
    if (Array.isArray(options.errorLogs)) {
      options.errorLogs.push(String(error?.message || ""));
    }
    return res.status(500).json({ code: "unexpected_error" });
  });
  app.use((_req, res) => res.status(404).json({ code: "not_found" }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function closeServer(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

function request(server, options = {}) {
  const address = server.address();
  const headers = { ...(options.headers || {}) };
  let body;
  if (options.rawBody !== undefined) {
    body = Buffer.from(String(options.rawBody), "utf8");
    headers["Content-Type"] = options.contentType || "text/plain";
    headers["Content-Length"] = body.length;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        method: options.method || "POST",
        path: options.path || HTTP_CANARY_ROUTE,
        headers
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => {
          let json;
          try { json = JSON.parse(text); } catch { json = null; }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function authorizedHeaders(key = "k".repeat(32), token = TOKEN) {
  return {
    Authorization: `Bearer ${token}`,
    "Idempotency-Key": key
  };
}

test("route is absent when flag is off or the unique staging service identity differs", async () => {
  const cases = [
    { SOCIAL_RUNTIME_HTTP_CANARY_ENABLED: "false" },
    {
      RENDER_SERVICE_ID: "srv-production",
      RENDER_SERVICE_NAME: "ia4tube-api",
      RENDER_GIT_BRANCH: "main"
    }
  ];
  for (const overrides of cases) {
    const server = await createServer({
      env: enabledEnvironment(overrides)
    });
    try {
      const response = await request(server, {
        headers: authorizedHeaders()
      });
      assert.equal(response.status, 404);
    } finally {
      await closeServer(server);
    }
  }
});

test("explicit activation on the staging service fails closed on invalid metadata or auth configuration", async () => {
  for (const overrides of [
    { RENDER_SERVICE_NAME: "wrong-staging-name" },
    { RENDER_GIT_REPO_SLUG: "other/repository" },
    { RENDER_GIT_BRANCH: "main" },
    { RENDER_GIT_COMMIT: "b".repeat(40) },
    { NODE_ENV: "development" }
  ]) {
    await assert.rejects(
      createServer({ env: enabledEnvironment(overrides) }),
      { code: "social_http_canary_configuration_invalid" }
    );
  }
  await assert.rejects(
    createServer({ internalTokens: [] }),
    { code: "social_http_canary_configuration_invalid" }
  );
});

test("strict internal auth refuses missing, JWT-like and wrong credentials", async () => {
  const server = await createServer();
  try {
    assert.equal((await request(server)).status, 401);
    assert.equal(
      (await request(server, {
        headers: {
          Authorization: `Bearer ${"j".repeat(64)}`,
          "Idempotency-Key": "j".repeat(32)
        }
      })).status,
      403
    );
    assert.equal(
      (await request(server, {
        headers: {
          Authorization: `Bearer ${"w".repeat(64)}`,
          "Idempotency-Key": "w".repeat(32)
        }
      })).status,
      403
    );
  } finally {
    await closeServer(server);
  }
});

test("cookie, browser origin, referer, query and every body transport are refused before global parsers", async () => {
  const errorLogs = [];
  const server = await createServer({ rateLimitMax: 20, errorLogs });
  try {
    for (const headers of [
      { ...authorizedHeaders("c".repeat(32)), Cookie: "admin=synthetic" },
      { ...authorizedHeaders("o".repeat(32)), Origin: "https://example.test" },
      { ...authorizedHeaders("r".repeat(32)), Referer: "https://example.test" }
    ]) {
      assert.equal((await request(server, { headers })).status, 403);
    }
    assert.equal(
      (await request(server, {
        path: `${HTTP_CANARY_ROUTE}?company_id=${COMPANY_A}`,
        headers: authorizedHeaders("q".repeat(32))
      })).status,
      400
    );
    assert.equal(
      (await request(server, {
        headers: authorizedHeaders("b".repeat(32)),
        body: { companyId: COMPANY_A }
      })).status,
      400
    );
    assert.equal(
      (await request(server, {
        headers: authorizedHeaders("t".repeat(32)),
        rawBody: "synthetic text body",
        contentType: "text/plain"
      })).status,
      400
    );
    assert.equal(
      (await request(server, {
        headers: authorizedHeaders("m".repeat(32)),
        rawBody: "{malformed-json",
        contentType: "application/json"
      })).status,
      400
    );
    const invalidMethodWithBody = await request(server, {
      method: "PUT",
      headers: authorizedHeaders("u".repeat(32)),
      rawBody: "{malformed-json",
      contentType: "application/json"
    });
    assert.equal(invalidMethodWithBody.status, 405);
    assert.equal(invalidMethodWithBody.headers["cache-control"], "no-store");
    assert.equal(invalidMethodWithBody.headers.allow, "POST");
    const invalidMethod = await request(server, {
      method: "PUT",
      headers: authorizedHeaders("v".repeat(32))
    });
    assert.equal(invalidMethod.status, 405);
    assert.equal(invalidMethod.headers["cache-control"], "no-store");
    for (const method of ["PATCH", "DELETE"]) {
      const response = await request(server, {
        method,
        headers: authorizedHeaders(method[0].toLowerCase().repeat(32)),
        rawBody: "synthetic_secret_marker_{malformed",
        contentType: "application/json"
      });
      assert.equal(response.status, 405);
      assert.equal(response.headers.allow, "POST");
    }
    assert.deepEqual(errorLogs, []);
  } finally {
    await closeServer(server);
  }
});

test("the real server mounts the canary boundary before global body parsers", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "server.js"),
    "utf8"
  );
  const canaryMount = source.indexOf(
    "if (socialHttpCanaryRouter) app.use(socialHttpCanaryRouter);"
  );
  const globalParser = source.indexOf(
    "const globalJsonParser = express.json"
  );
  assert.ok(canaryMount >= 0);
  assert.ok(globalParser >= 0);
  assert.ok(canaryMount < globalParser);
  assert.ok(canaryMount < source.indexOf("function auth(req, res, next)"));

  const canarySources = [
    "src/social/http-canary-routes.js",
    "src/social/http-canary-service.js",
    "src/persistence/postgres/http-canary-probe.js"
  ].map((file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
  for (const canarySource of canarySources) {
    assert.doesNotMatch(
      canarySource,
      /readClientes|clientes\.json|pedidos|artes|legacy_entity_mappings/i
    );
  }
});

test("valid internal request is no-store and response is allowlisted", async () => {
  const server = await createServer();
  try {
    const response = await request(server, { headers: authorizedHeaders() });
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.json.status, "passed");
    const output = JSON.stringify(response.json);
    for (const forbidden of [
      TOKEN,
      PASSWORD_MARKER,
      COMPANY_A,
      COMPANY_B,
      HTTP_CANARY_DATABASE_HOST,
      "ciphertext",
      "DATABASE_URL"
    ]) {
      assert.equal(output.includes(forbidden), false);
    }
  } finally {
    await closeServer(server);
  }
});

test("rate limit rejects excess attempts without another execution", async () => {
  let calls = 0;
  const server = await createServer({
    rateLimitMax: 1,
    getRuntimeState: () => ({
      enabled: true,
      async runHttpCanary() {
        calls += 1;
        return passedResult();
      }
    })
  });
  try {
    assert.equal(
      (await request(server, {
        headers: authorizedHeaders("1".repeat(32))
      })).status,
      200
    );
    assert.equal(
      (await request(server, {
        headers: authorizedHeaders("2".repeat(32))
      })).status,
      429
    );
    assert.equal(calls, 1);
  } finally {
    await closeServer(server);
  }
});

test("only one different canary execution runs concurrently", async () => {
  let calls = 0;
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });
  const server = await createServer({
    rateLimitMax: 10,
    getRuntimeState: () => ({
      enabled: true,
      async runHttpCanary() {
        calls += 1;
        firstStarted();
        await blocked;
        return passedResult();
      }
    })
  });
  try {
    const first = request(server, {
      headers: authorizedHeaders("a".repeat(32))
    });
    await started;
    const second = await request(server, {
      headers: authorizedHeaders("b".repeat(32))
    });
    assert.equal(second.status, 429);
    assert.equal(calls, 1);
    releaseFirst();
    assert.equal((await first).status, 200);
  } finally {
    releaseFirst();
    await closeServer(server);
  }
});

test("same idempotency key shares one in-flight and one completed execution", async () => {
  let calls = 0;
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });
  const server = await createServer({
    rateLimitMax: 10,
    getRuntimeState: () => ({
      enabled: true,
      async runHttpCanary() {
        calls += 1;
        firstStarted();
        await blocked;
        return passedResult();
      }
    })
  });
  try {
    const headers = authorizedHeaders("i".repeat(32));
    const first = request(server, { headers });
    await started;
    const second = request(server, { headers });
    releaseFirst();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    const thirdResponse = await request(server, { headers });
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(thirdResponse.status, 200);
    assert.equal(calls, 1);
    assert.equal(firstResponse.json.runId, secondResponse.json.runId);
    assert.equal(firstResponse.json.runId, thirdResponse.json.runId);
  } finally {
    releaseFirst();
    await closeServer(server);
  }
});

test("idempotency key is namespaced by the authenticated internal principal", async () => {
  let calls = 0;
  const server = await createServer({
    internalTokens: [TOKEN, TOKEN_2],
    rateLimitMax: 10,
    getRuntimeState: () => ({
      enabled: true,
      async runHttpCanary() {
        calls += 1;
        return passedResult(
          calls === 1
            ? "33333333-3333-4333-8333-333333333333"
            : "44444444-4444-4444-8444-444444444444"
        );
      }
    })
  });
  try {
    const key = "p".repeat(32);
    const first = await request(server, {
      headers: authorizedHeaders(key, TOKEN)
    });
    const second = await request(server, {
      headers: authorizedHeaders(key, TOKEN_2)
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls, 2);
    assert.notEqual(first.json.runId, second.json.runId);
  } finally {
    await closeServer(server);
  }
});

test("client disconnect does not release the execution lock before the operation settles", async () => {
  let calls = 0;
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });
  const server = await createServer({
    rateLimitMax: 10,
    getRuntimeState: () => ({
      enabled: true,
      async runHttpCanary() {
        calls += 1;
        if (calls === 1) {
          firstStarted();
          await blocked;
        }
        return passedResult();
      }
    })
  });
  const address = server.address();
  const firstRequest = http.request({
    hostname: "127.0.0.1",
    port: address.port,
    method: "POST",
    path: HTTP_CANARY_ROUTE,
    headers: authorizedHeaders("d".repeat(32))
  });
  firstRequest.on("error", () => {});
  firstRequest.end();
  try {
    await started;
    firstRequest.destroy();
    const whileAbortedOperationRuns = await request(server, {
      headers: authorizedHeaders("e".repeat(32))
    });
    assert.equal(whileAbortedOperationRuns.status, 429);
    assert.equal(calls, 1);
    releaseFirst();
    await new Promise((resolve) => setImmediate(resolve));
    const afterSettlement = await request(server, {
      headers: authorizedHeaders("f".repeat(32))
    });
    assert.equal(afterSettlement.status, 200);
    assert.equal(calls, 2);
  } finally {
    releaseFirst();
    firstRequest.destroy();
    await closeServer(server);
  }
});
