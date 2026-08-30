"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const bcrypt = require("bcryptjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER_FILE = path.join(ROOT, "server.js");
const STAGING_ORIGIN = "https://ia4tube-api-staging-checkpoint-a.onrender.com";
const LOGIN = "gate5a-reviewer-synthetic";
const PASSWORD = "Gate5AReviewerSynthetic2026";
const RUNNER_TOKEN = "gate5a-reviewer-synthetic-runner-token";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function spawnServer(port, dataDirectory) {
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDirectory,
    NODE_ENV: "test",
    HTTPS_ENFORCE: "true",
    HTTPS_ALLOW_LOCAL_HTTP: "false",
    PUBLIC_API_BASE_URL: STAGING_ORIGIN,
    JWT_SECRET: "gate5a-reviewer-server-test-secret-at-least-32-characters",
    ORDER_MEDIA_SIGNING_SECRET:
      "gate5a-reviewer-media-test-secret-at-least-32-characters",
    BOT_ADMIN_WHATSAPP: "gate5a-reviewer-admin",
    BOT_RUNNER_TOKEN: RUNNER_TOKEN,
    BOT_RUNNER_TOKEN_NEXT: "",
    MP_ACCESS_TOKEN: "",
    OPENAI_API_KEY: "",
    FCM_MOCK: "1",
    FCM_DELIVERY_ENABLED: "false",
    FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "false",
    IA4TUBE_FREE_ART_ENABLED: "false",
    SOCIAL_PERSISTENCE_ENABLED: "false",
    SOCIAL_INSTAGRAM_ENABLED: "false",
    SOCIAL_EXTERNAL_CONNECTION_ENABLED: "false",
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false",
    INSTAGRAM_APP_SECRET: "gate5a-meta-signed-request-test-secret",
    OAUTH_RATE_LIMIT_MAX: "100",
    AUTH_LOGIN_RATE_LIMIT_MAX: "20",
    AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX: "20"
  };
  const child = spawn(process.execPath, [SERVER_FILE], {
    cwd: ROOT,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  return Object.freeze({ child, output: () => output });
}

async function waitForServer(instance, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (instance.output().includes("API rodando na porta")) return;
    if (instance.child.exitCode !== null) {
      throw new Error(`Gate 5A server exited early: ${instance.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Gate 5A server did not start: ${instance.output()}`);
}

function request(port, requestPath, options = {}) {
  const method = options.method || "GET";
  const body = options.rawBody !== undefined
    ? Buffer.from(options.rawBody)
    : options.body === undefined
      ? null
      : Buffer.from(JSON.stringify(options.body), "utf8");
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: "127.0.0.1",
      port,
      path: requestPath,
      method,
      headers: {
        Host: "ia4tube-api-staging-checkpoint-a.onrender.com",
        "X-Forwarded-Proto": "https",
        ...(body ? {
          "Content-Type": options.contentType || "application/json",
          "Content-Length": String(body.length)
        } : {}),
        ...(options.token ? {
          Authorization: `Bearer ${options.token}`
        } : {}),
        ...(options.headers || {})
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(raw.toString("utf8"));
        } catch {
          // HTML and JavaScript assets are asserted as text.
        }
        resolve(Object.freeze({
          status: response.statusCode,
          headers: response.headers,
          raw,
          json
        }));
      });
    });
    outgoing.once("error", reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

function multipartBody(parts) {
  const boundary = "----ia4tube-gate5a-product-regression";
  const chunks = [];
  for (const part of parts) {
    const filename = part.filename
      ? `; filename="${part.filename}"`
      : "";
    const contentType = part.contentType
      ? `Content-Type: ${part.contentType}\r\n`
      : "";
    chunks.push(Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${part.name}"${filename}\r\n`
      + contentType
      + "\r\n",
      "utf8"
    ));
    chunks.push(Buffer.from(part.content));
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return Object.freeze({
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  });
}

test("canonical staging app completes the authenticated reviewer sandbox flow", async (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-gate5a-reviewer-server-")
  );
  const dataDirectory = path.join(temporaryRoot, "data");
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(path.join(dataDirectory, "clientes.json"), JSON.stringify({
    [LOGIN]: {
      nome_time: "Empresa Sintetica do Revisor",
      login_id: LOGIN,
      senha_hash: bcrypt.hashSync(PASSWORD, 4),
      plano: 0,
      saldo_mensal: 0,
      saldo_extra: 100,
      usados_no_ciclo: 0,
      ciclo_mes: "2026-08",
      conta_finalizada: true,
      ativo: true
    }
  }), "utf8");

  const port = await freePort();
  const instance = spawnServer(port, dataDirectory);
  t.after(async () => {
    if (instance.child.exitCode === null) {
      const exited = new Promise((resolve) => instance.child.once("exit", resolve));
      instance.child.kill();
      await exited;
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  await waitForServer(instance);

  const appPage = await request(
    port,
    "/app.html?review=instagram-publishing&stage=overview"
  );
  assert.equal(appPage.status, 200);
  assert.match(appPage.headers["content-type"], /text\/html/);
  assert.match(appPage.raw.toString("utf8"), /gate5aReviewerRoot/);
  assert.equal(appPage.headers["x-robots-tag"], "noindex, nofollow, noarchive");

  const reviewerScript = await request(port, "/gate5a-reviewer-flow.js");
  assert.equal(reviewerScript.status, 200);
  assert.match(reviewerScript.headers["content-type"], /javascript/);
  assert.match(reviewerScript.raw.toString("utf8"), /reviewer-sandbox/);

  const appVersion = await request(port, "/app/version");
  assert.equal(appVersion.status, 200);
  assert.equal(appVersion.json.ok, true);
  assert.equal(Number.isInteger(appVersion.json.latest_version_code), true);
  assert.equal(Number.isInteger(appVersion.json.minimum_version_code), true);
  assert.equal(typeof appVersion.json.latest_version_name, "string");

  const protectedMobileContracts = [
    { method: "POST", path: "/billing/saldo/pix", body: {} },
    { method: "POST", path: "/billing/arte-avulsa/pix", body: {} },
    { method: "POST", path: "/billing/planos/gate5a-synthetic/pix", body: {} },
    { method: "GET", path: "/suporte/minhas-mensagens" },
    { method: "POST", path: "/suporte/chat", body: { mensagem: "" } }
  ];
  for (const contract of protectedMobileContracts) {
    const response = await request(port, contract.path, contract);
    assert.equal(response.status, 401, contract.path);
  }

  const anonymous = await request(port, "/v1/social/reviewer-sandbox/state");
  assert.equal(anonymous.status, 401);

  const invalidDeauthorization = await request(
    port,
    "/v1/social/compliance/meta/deauthorization",
    { method: "POST", body: { signed_request: "invalid.request" } }
  );
  const invalidDeletion = await request(
    port,
    "/v1/social/compliance/meta/data-deletion",
    { method: "POST", body: { signed_request: "invalid.request" } }
  );
  const unavailableStatus = await request(
    port,
    "/v1/social/compliance/meta/data-deletion/status/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  );
  assert.equal(invalidDeauthorization.status, 503);
  assert.equal(invalidDeletion.status, 503);
  assert.equal(unavailableStatus.status, 503);
  assert.deepEqual(invalidDeauthorization.json, {
    error: "meta_compliance_unavailable"
  });
  assert.deepEqual(invalidDeletion.json, {
    error: "meta_compliance_unavailable"
  });

  const login = await request(port, "/auth/login", {
    method: "POST",
    body: { whatsapp: LOGIN, senha: PASSWORD }
  });
  assert.equal(login.status, 200);
  assert.equal(login.json.ok, true);
  assert.equal(typeof login.json.token, "string");
  const token = login.json.token;

  const supportMessages = await request(
    port,
    "/suporte/minhas-mensagens",
    { token }
  );
  assert.equal(supportMessages.status, 200);
  assert.equal(supportMessages.json.ok, true);
  assert.deepEqual(supportMessages.json.mensagens, []);

  const emptySupportMessage = await request(port, "/suporte/chat", {
    method: "POST",
    token,
    body: { mensagem: "" }
  });
  assert.equal(emptySupportMessage.status, 400);

  const productOrder = await request(port, "/pedidos", {
    method: "POST",
    token,
    body: {
      flyer_tipo: "pedido",
      nome_time: "Empresa Sintetica do Revisor",
      rodada: "Gate 5A",
      data: "30/08/2026"
    }
  });
  assert.equal(productOrder.status, 200);
  assert.equal(typeof productOrder.json.pedido_id, "string");
  const productOrderId = productOrder.json.pedido_id;
  const syntheticCaption =
    "Arte sintética concluída com legenda persistida para a revisão Gate 5A.";
  const generatedProduct = multipartBody([
    {
      name: "descricao_instagram",
      content: Buffer.from(syntheticCaption, "utf8")
    },
    {
      name: "resultado",
      filename: "gate5a-generated-art.png",
      contentType: "image/png",
      content: Buffer.from("gate5a-synthetic-generated-art", "utf8")
    },
    {
      name: "preview",
      filename: "gate5a-generated-preview.jpg",
      contentType: "image/jpeg",
      content: Buffer.from("gate5a-synthetic-generated-preview", "utf8")
    }
  ]);
  const completedProduct = await request(
    port,
    `/bot/pedidos/${productOrderId}/upload-resultado`,
    {
      method: "POST",
      token: RUNNER_TOKEN,
      rawBody: generatedProduct.body,
      contentType: generatedProduct.contentType
    }
  );
  assert.equal(completedProduct.status, 200);
  const rereadProduct = await request(
    port,
    `/pedidos/${productOrderId}/info`,
    { token }
  );
  assert.equal(rereadProduct.status, 200);
  assert.equal(rereadProduct.json.imagem_pronta, true);
  assert.equal(rereadProduct.json.status, "pronto");
  assert.equal(rereadProduct.json.descricao_instagram, syntheticCaption);

  const initial = await request(port, "/v1/social/reviewer-sandbox/state", { token });
  assert.equal(initial.status, 200);
  assert.equal(initial.json.state.connection.status, "not_connected");
  assert.equal(initial.json.externalCalls, 0);

  const authorization = await request(
    port,
    "/v1/social/reviewer-sandbox/authorization",
    {
      method: "POST",
      token,
      body: { accountType: "BUSINESS", purpose: "app_review" }
    }
  );
  assert.equal(authorization.status, 200);
  assert.equal(authorization.json.state.authorization.status, "authorization_pending");

  const callback = await request(
    port,
    "/v1/social/reviewer-sandbox/authorization/callback",
    { method: "POST", token, body: {} }
  );
  assert.equal(callback.status, 200);
  assert.equal(callback.json.state.authorization.callbackSanitized, true);
  assert.equal(callback.json.state.connection.status, "connected");
  assert.equal(callback.json.state.connection.account.accountType, "BUSINESS");

  const media = await request(port, "/v1/social/reviewer-sandbox/media", {
    method: "POST",
    token,
    body: { asset: "controlled-review-jpeg" }
  });
  assert.equal(media.status, 200);
  assert.equal(media.json.state.media.item.mimeType, "image/jpeg");

  const requestId = "gate5a-reviewer-manual-publish-v1";
  const publication = await request(port, "/v1/social/reviewer-sandbox/publications", {
    method: "POST",
    token,
    body: { clientRequestId: requestId }
  });
  const replay = await request(port, "/v1/social/reviewer-sandbox/publications", {
    method: "POST",
    token,
    body: { clientRequestId: requestId }
  });
  assert.equal(publication.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(publication.json.state.publication.attempts, 1);
  assert.equal(replay.json.idempotentReplay, true);
  const publicationId = publication.json.state.publication.details.publicationId;

  const confirming = await request(
    port,
    `/v1/social/reviewer-sandbox/publications/${publicationId}/advance`,
    { method: "POST", token, body: {} }
  );
  const published = await request(
    port,
    `/v1/social/reviewer-sandbox/publications/${publicationId}/advance`,
    { method: "POST", token, body: {} }
  );
  assert.equal(confirming.json.state.publication.state, "provider_confirming");
  assert.equal(published.json.state.publication.state, "published");
  assert.match(published.json.state.publication.details.mediaId, /^synthetic-media-/);
  assert.equal(published.json.state.publication.attempts, 1);
  assert.equal(published.json.externalCalls, 0);

  const history = await request(port, "/v1/social/reviewer-sandbox/publications", { token });
  const details = await request(
    port,
    `/v1/social/reviewer-sandbox/publications/${publicationId}`,
    { token }
  );
  assert.equal(history.json.publications.length, 1);
  assert.equal(details.json.publication.publicationId, publicationId);

  const disconnected = await request(port, "/v1/social/reviewer-sandbox/connection", {
    method: "DELETE",
    token
  });
  assert.equal(disconnected.json.state.connection.status, "disconnected");
  assert.equal(disconnected.json.state.connection.tokenPhysicallyDeleted, true);
  assert.deepEqual(disconnected.json.state.media, {
    selected: false,
    item: null
  });
  assert.deepEqual(disconnected.json.state.publication, {
    state: "idle",
    attempts: 0,
    details: null
  });
  assert.equal(disconnected.json.state.history.length, 1);
  assert.equal(disconnected.json.state.history[0].publicationId, publicationId);
  assert.equal(disconnected.json.state.history[0].state, "published");

  const delayed = await request(
    port,
    `/v1/social/reviewer-sandbox/publications/${publicationId}/advance`,
    { method: "POST", token, body: {} }
  );
  assert.equal(delayed.status, 404);
  assert.equal(delayed.json.error.code, "reviewer_publication_not_found");

  await request(port, "/v1/social/reviewer-sandbox/authorization", {
    method: "POST",
    token,
    body: { accountType: "BUSINESS", purpose: "app_review" }
  });
  await request(port, "/v1/social/reviewer-sandbox/authorization/callback", {
    method: "POST",
    token,
    body: {}
  });
  const oldAfterReconnect = await request(
    port,
    `/v1/social/reviewer-sandbox/publications/${publicationId}/advance`,
    { method: "POST", token, body: {} }
  );
  assert.equal(oldAfterReconnect.status, 404);
  assert.equal(
    oldAfterReconnect.json.error.code,
    "reviewer_publication_not_found"
  );

  await request(port, "/v1/social/reviewer-sandbox/media", {
    method: "POST",
    token,
    body: { asset: "controlled-review-jpeg" }
  });
  const newRequestId = "gate5a-reviewer-reconnected-publication";
  const newPublication = await request(
    port,
    "/v1/social/reviewer-sandbox/publications",
    { method: "POST", token, body: { clientRequestId: newRequestId } }
  );
  const newReplay = await request(
    port,
    "/v1/social/reviewer-sandbox/publications",
    { method: "POST", token, body: { clientRequestId: newRequestId } }
  );
  assert.equal(newPublication.status, 200);
  assert.equal(newPublication.json.state.publication.attempts, 1);
  assert.equal(newPublication.json.idempotentReplay, false);
  assert.equal(newReplay.json.idempotentReplay, true);
  assert.equal(newReplay.json.state.publication.attempts, 1);
  assert.notEqual(
    newPublication.json.state.publication.details.publicationId,
    publicationId
  );

  const deletion = await request(port, "/v1/social/reviewer-sandbox/data-deletion", {
    method: "POST",
    token,
    body: { confirm: true }
  });
  assert.equal(deletion.status, 200);
  assert.equal(deletion.json.state.deletion.status, "completed");
  assert.equal(deletion.json.state.deletion.technicalConnectionDataDeleted, true);
  assert.equal(deletion.json.externalCalls, 0);
  assert.equal(JSON.stringify(deletion.json).includes("access_token"), false);
});

test("reviewer sandbox rejects personal accounts and accepts Creator after reset", async (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-gate5a-reviewer-account-types-")
  );
  const dataDirectory = path.join(temporaryRoot, "data");
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(path.join(dataDirectory, "clientes.json"), JSON.stringify({
    [LOGIN]: {
      nome_time: "Empresa Sintetica do Revisor",
      login_id: LOGIN,
      senha_hash: bcrypt.hashSync(PASSWORD, 4),
      ativo: true
    }
  }), "utf8");
  const port = await freePort();
  const instance = spawnServer(port, dataDirectory);
  t.after(async () => {
    if (instance.child.exitCode === null) {
      const exited = new Promise((resolve) => instance.child.once("exit", resolve));
      instance.child.kill();
      await exited;
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  await waitForServer(instance);
  const login = await request(port, "/auth/login", {
    method: "POST",
    body: { whatsapp: LOGIN, senha: PASSWORD }
  });
  const token = login.json.token;

  await request(port, "/v1/social/reviewer-sandbox/authorization", {
    method: "POST",
    token,
    body: { accountType: "PERSONAL", purpose: "app_review" }
  });
  const personal = await request(
    port,
    "/v1/social/reviewer-sandbox/authorization/callback",
    { method: "POST", token, body: {} }
  );
  assert.equal(personal.status, 422);
  assert.equal(personal.json.error.code, "professional_account_required");
  assert.equal(personal.json.state.connection.status, "rejected");

  await request(port, "/v1/social/reviewer-sandbox/reset", {
    method: "POST",
    token,
    body: { confirm: true }
  });
  await request(port, "/v1/social/reviewer-sandbox/authorization", {
    method: "POST",
    token,
    body: { accountType: "CREATOR", purpose: "app_review" }
  });
  const creator = await request(
    port,
    "/v1/social/reviewer-sandbox/authorization/callback",
    { method: "POST", token, body: {} }
  );
  assert.equal(creator.status, 200);
  assert.equal(creator.json.state.connection.account.accountType, "CREATOR");
  assert.equal(creator.json.externalCalls, 0);
});
