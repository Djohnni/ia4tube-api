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

const bcrypt = require("bcryptjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER_FILE = path.join(ROOT, "server.js");
const STAGING_ORIGIN = "https://ia4tube-api-staging-checkpoint-a.onrender.com";
const PRODUCTION_TEST_ORIGIN = "https://synthetic-api.example.test";
const PRODUCTION_TEST_HOST = new URL(PRODUCTION_TEST_ORIGIN).host;
const LOGIN = "gate5a-reviewer-synthetic";
const PASSWORD = "Gate5AReviewerSynthetic2026";
const LOGIN_B = "gate5a-reviewer-empty-demo";
const PASSWORD_B = "Gate5AReviewerEmptyDemo2026";
const RUNNER_TOKEN = "gate5a-reviewer-synthetic-runner-token";
const GATE4_SHA256 =
  "4b9224fee69b707f304e11ad25ef7fe9d22f19904ba0b933172861f53b5bd773";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function syntheticJpegBytes() {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoH" +
    "BwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQME" +
    "BAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU" +
    "FBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEA" +
    "AAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIh" +
    "MUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6" +
    "Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZ" +
    "mqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx" +
    "8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA" +
    "AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAV" +
    "YnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hp" +
    "anN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPE" +
    "xcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9" +
    "U6KKKAP/2Q==",
    "base64"
  );
}

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

function spawnServer(port, dataDirectory, overrides = {}) {
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
    FIREBASE_EXPECTED_PROJECT_ID: "",
    FIREBASE_SERVICE_ACCOUNT_JSON: "",
    GOOGLE_APPLICATION_CREDENTIALS: "",
    FIREBASE_PROJECT_ID: "",
    FIREBASE_CLIENT_EMAIL: "",
    FIREBASE_PRIVATE_KEY: "",
    IA4TUBE_FREE_ART_ENABLED: "false",
    SOCIAL_PERSISTENCE_ENABLED: "false",
    SOCIAL_INSTAGRAM_ENABLED: "false",
    SOCIAL_EXTERNAL_CONNECTION_ENABLED: "false",
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false",
    INSTAGRAM_APP_SECRET: "gate5a-meta-signed-request-test-secret",
    OAUTH_RATE_LIMIT_MAX: "100",
    AUTH_LOGIN_RATE_LIMIT_MAX: "20",
    AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX: "20",
    ...overrides
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
        Host: options.host || "ia4tube-api-staging-checkpoint-a.onrender.com",
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
      nome_time: "Sabor da Vila Hamburgueria — DEMO",
      login_id: LOGIN,
      senha_hash: bcrypt.hashSync(PASSWORD, 4),
      plano: 0,
      saldo_mensal: 0,
      saldo_extra: 100,
      usados_no_ciclo: 0,
      ciclo_mes: "2026-08",
      conta_finalizada: true,
      ativo: true
    },
    [LOGIN_B]: {
      nome_time: "Empresa Vazia do Revisor — DEMO",
      login_id: LOGIN_B,
      senha_hash: bcrypt.hashSync(PASSWORD_B, 4),
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

  assert.equal(
    (instance.output().match(/API rodando na porta/g) || []).length,
    1
  );
  const health = await request(port, "/");
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true, msg: "omascote-api online" });

  for (const legalPath of [
    "/politica-de-privacidade",
    "/termos-de-uso",
    "/exclusao-de-dados"
  ]) {
    const legal = await request(port, legalPath);
    assert.equal(legal.status, 200, legalPath);
    assert.equal(legal.headers.location, undefined, legalPath);
    const legalBody = legal.raw.toString("utf8");
    assert.match(legalBody, /RASCUNHO TÉCNICO PÚBLICO/);
    assert.match(legalBody, /NÃO APROVADO JURIDICAMENTE/);
    assert.doesNotMatch(legalBody, /facebook\.com|example\.com|placeholder/i);
  }

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

  const loginB = await request(port, "/auth/login", {
    method: "POST",
    body: { whatsapp: LOGIN_B, senha: PASSWORD_B }
  });
  assert.equal(loginB.status, 200);
  assert.equal(loginB.json.ok, true);
  const tokenB = loginB.json.token;

  await request(port, "/v1/social/reviewer-sandbox/authorization", {
    method: "POST",
    token: tokenB,
    body: { accountType: "BUSINESS", purpose: "app_review" }
  });
  const callbackB = await request(
    port,
    "/v1/social/reviewer-sandbox/authorization/callback",
    { method: "POST", token: tokenB, body: {} }
  );
  assert.equal(callbackB.status, 200);
  const emptyMediaB = await request(port, "/v1/social/reviewer-sandbox/media", {
    method: "POST",
    token: tokenB,
    body: { asset: "controlled-review-jpeg" }
  });
  assert.equal(emptyMediaB.status, 404);
  assert.equal(emptyMediaB.json.error.code, "reviewer_media_unavailable");
  assert.deepEqual(emptyMediaB.json.state.media, {
    selected: false,
    item: null
  });
  assert.deepEqual(emptyMediaB.json.state.history, []);

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
      nome_time: "Sabor da Vila Hamburgueria — DEMO",
      rodada: "Gate 5A",
      data: "30/08/2026"
    }
  });
  assert.equal(productOrder.status, 200);
  assert.equal(typeof productOrder.json.pedido_id, "string");
  const productOrderId = productOrder.json.pedido_id;
  const syntheticCaption =
    "Combo da Casa — DEMO\nDEMO SINTÉTICA\nNÃO PUBLICAR";
  const syntheticPreview = syntheticJpegBytes();
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
      content: syntheticPreview
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

  const crossTenantProduct = await request(
    port,
    `/pedidos/${productOrderId}/info`,
    { token: tokenB }
  );
  assert.equal(crossTenantProduct.status, 404);

  const invalidJpegOrder = await request(port, "/pedidos", {
    method: "POST",
    token: tokenB,
    body: {
      flyer_tipo: "pedido",
      nome_time: "Empresa Vazia do Revisor — DEMO",
      rodada: "Gate 5A",
      data: "30/08/2026"
    }
  });
  assert.equal(invalidJpegOrder.status, 200);
  const malformedProduct = multipartBody([
    {
      name: "descricao_instagram",
      content: Buffer.from(syntheticCaption, "utf8")
    },
    {
      name: "resultado",
      filename: "gate5a-invalid-generated-art.png",
      contentType: "image/png",
      content: Buffer.from("gate5a-invalid-generated-art", "utf8")
    },
    {
      name: "preview",
      filename: "gate5a-invalid-preview.jpg",
      contentType: "image/jpeg",
      content: Buffer.from("not-a-jpeg", "utf8")
    }
  ]);
  const completedMalformedProduct = await request(
    port,
    `/bot/pedidos/${invalidJpegOrder.json.pedido_id}/upload-resultado`,
    {
      method: "POST",
      token: RUNNER_TOKEN,
      rawBody: malformedProduct.body,
      contentType: malformedProduct.contentType
    }
  );
  assert.equal(completedMalformedProduct.status, 200);
  const invalidMediaB = await request(port, "/v1/social/reviewer-sandbox/media", {
    method: "POST",
    token: tokenB,
    body: { asset: "controlled-review-jpeg" }
  });
  assert.equal(invalidMediaB.status, 404);
  assert.equal(invalidMediaB.json.error.code, "reviewer_media_unavailable");
  assert.deepEqual(invalidMediaB.json.state.media, {
    selected: false,
    item: null
  });

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

  for (const invalidBody of [
    { asset: "controlled-review-jpeg", company_id: LOGIN_B },
    { asset: "controlled-review-jpeg", orderId: productOrderId },
    { asset: "https://example.invalid/arbitrary.jpg" }
  ]) {
    const rejected = await request(port, "/v1/social/reviewer-sandbox/media", {
      method: "POST",
      token,
      body: invalidBody
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.json.error.code, "reviewer_request_invalid");
    assert.deepEqual(rejected.json.state.media, {
      selected: false,
      item: null
    });
  }

  const media = await request(port, "/v1/social/reviewer-sandbox/media", {
    method: "POST",
    token,
    body: { asset: "controlled-review-jpeg" }
  });
  assert.equal(media.status, 200);
  const mediaItem = media.json.state.media.item;
  assert.equal(mediaItem.mimeType, "image/jpeg");
  assert.equal(mediaItem.width, 2);
  assert.equal(mediaItem.height, 2);
  assert.equal(mediaItem.tenantOwned, true);
  assert.equal(mediaItem.id, "tenant-controlled-review-jpeg");
  assert.equal(mediaItem.assetPath.startsWith(
    "/v1/social/reviewer-sandbox/media-capability/"
  ), true);
  assert.equal(mediaItem.assetPath.includes("?"), false);
  assert.equal(mediaItem.assetPath.includes("#"), false);
  assert.equal(mediaItem.assetPath.includes("\\"), false);
  assert.equal(mediaItem.assetPath.length <= 300, true);
  assert.equal(mediaItem.assetPath.includes(LOGIN), false);
  assert.equal(mediaItem.assetPath.includes(GATE4_SHA256), false);
  assert.equal(JSON.stringify(media.json).includes("storageKey"), false);
  assert.equal(JSON.stringify(media.json).includes("ownerCompanyId"), false);
  assert.equal(JSON.stringify(media.json).includes("sha256"), false);
  assert.equal(JSON.stringify(media.json).includes("contentId"), false);

  const protectedAssetPath = mediaItem.assetPath;
  const protectedAsset = await request(port, protectedAssetPath);
  assert.equal(protectedAsset.status, 200);
  assert.match(protectedAsset.headers["content-type"], /^image\/jpeg/);
  assert.equal(protectedAsset.headers["cache-control"], "private, no-store, no-transform");
  assert.equal(protectedAsset.headers["x-content-type-options"], "nosniff");
  assert.equal(protectedAsset.raw.equals(syntheticPreview), true);
  assert.equal(sha256(protectedAsset.raw), sha256(syntheticPreview));
  assert.notEqual(sha256(protectedAsset.raw), GATE4_SHA256);

  const storedPreviewCandidates = fs.readdirSync(
    path.join(dataDirectory, "pedidos", LOGIN)
  ).map((month) => path.join(
    dataDirectory,
    "pedidos",
    LOGIN,
    month,
    productOrderId,
    "preview_ia4tube.jpg"
  )).filter((candidate) => fs.existsSync(candidate));
  assert.equal(storedPreviewCandidates.length, 1);
  const storageKey = path.relative(dataDirectory, storedPreviewCandidates[0])
    .split(path.sep)
    .join("/");
  assert.match(storageKey, new RegExp(`^pedidos/${LOGIN}/`));
  assert.equal(storageKey.endsWith(`/${productOrderId}/preview_ia4tube.jpg`), true);
  assert.equal(storageKey.includes("social/gate4"), false);
  assert.equal(sha256(fs.readFileSync(storedPreviewCandidates[0])), sha256(syntheticPreview));

  for (const tamperedPath of [
    protectedAssetPath.replace(productOrderId, `${productOrderId}x`),
    `${protectedAssetPath.slice(0, -1)}${protectedAssetPath.endsWith("A") ? "B" : "A"}`
  ]) {
    const tampered = await request(port, tamperedPath);
    assert.equal(tampered.status, 404);
  }

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
  const crossTenantDetails = await request(
    port,
    `/v1/social/reviewer-sandbox/publications/${publicationId}`,
    { token: tokenB }
  );
  assert.equal(crossTenantDetails.status, 404);
  assert.equal(
    crossTenantDetails.json.error.code,
    "reviewer_publication_not_found"
  );
  const stateBAfterPublication = await request(
    port,
    "/v1/social/reviewer-sandbox/state",
    { token: tokenB }
  );
  assert.deepEqual(stateBAfterPublication.json.state.media, {
    selected: false,
    item: null
  });
  assert.deepEqual(stateBAfterPublication.json.state.history, []);

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
  const revokedAsset = await request(port, protectedAssetPath);
  assert.equal(revokedAsset.status, 404);

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

  const reselectedMedia = await request(port, "/v1/social/reviewer-sandbox/media", {
    method: "POST",
    token,
    body: { asset: "controlled-review-jpeg" }
  });
  assert.equal(reselectedMedia.status, 200);
  const reselectedAssetPath = reselectedMedia.json.state.media.item.assetPath;
  const stillRevokedAsset = await request(port, protectedAssetPath);
  assert.equal(stillRevokedAsset.status, 404);
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
  const deletedAsset = await request(port, reselectedAssetPath);
  assert.equal(deletedAsset.status, 404);
  const serverOutput = instance.output();
  assert.equal(
    (serverOutput.match(/API rodando na porta/g) || []).length,
    1
  );
  assert.equal(serverOutput.includes("[social][startup]"), false);
  assert.doesNotMatch(serverOutput, /migration|migracao|migração/i);
  assert.equal(serverOutput.includes(PASSWORD), false);
  assert.equal(serverOutput.includes(PASSWORD_B), false);
  assert.equal(serverOutput.includes(RUNNER_TOKEN), false);
  assert.equal(serverOutput.includes(token), false);
  assert.equal(serverOutput.includes(tokenB), false);
});

test("production origin keeps the reviewer sandbox and its media capability disabled", async (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-gate5a-production-gate-")
  );
  const dataDirectory = path.join(temporaryRoot, "data");
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(path.join(dataDirectory, "clientes.json"), "{}", "utf8");

  const port = await freePort();
  const instance = spawnServer(port, dataDirectory, {
    NODE_ENV: "production",
    PUBLIC_API_BASE_URL: PRODUCTION_TEST_ORIGIN,
    PUBLIC_WEB_BASE_URL: PRODUCTION_TEST_ORIGIN,
    FCM_MOCK: ""
  });
  t.after(async () => {
    if (instance.child.exitCode === null) {
      const exited = new Promise((resolve) => instance.child.once("exit", resolve));
      instance.child.kill();
      await exited;
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  await waitForServer(instance);

  assert.notEqual(PRODUCTION_TEST_ORIGIN, STAGING_ORIGIN);
  assert.equal(new URL(PRODUCTION_TEST_ORIGIN).hostname.endsWith(".test"), true);

  assert.equal(
    (instance.output().match(/API rodando na porta/g) || []).length,
    1
  );
  const health = await request(port, "/", {
    host: PRODUCTION_TEST_HOST
  });
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true, msg: "omascote-api online" });

  for (const legalPath of [
    "/politica-de-privacidade",
    "/termos-de-uso",
    "/exclusao-de-dados"
  ]) {
    const legal = await request(port, legalPath, {
      host: PRODUCTION_TEST_HOST
    });
    assert.equal(legal.status, 200, legalPath);
    assert.equal(legal.headers.location, undefined, legalPath);
  }

  for (const disabledPath of [
    "/reviewer",
    "/app.html",
    "/gate5a-reviewer-flow.js",
    "/v1/social/reviewer-sandbox/state",
    "/v1/social/reviewer-sandbox/media-capability/order/1/nonce/owner/signature"
  ]) {
    const disabled = await request(port, disabledPath, {
      host: PRODUCTION_TEST_HOST
    });
    assert.equal(disabled.status, 404, disabledPath);
  }
  const serverOutput = instance.output();
  assert.equal(
    (serverOutput.match(/API rodando na porta/g) || []).length,
    1
  );
  assert.equal(serverOutput.includes("[social][startup]"), false);
  assert.doesNotMatch(serverOutput, /migration|migracao|migração/i);
  assert.equal(
    (serverOutput.match(/\[fcm\]\[safety\]/g) || []).length,
    1
  );
  assert.match(serverOutput, /delivery_enabled:\s*false/);
  assert.match(serverOutput, /automatic_notifications_enabled:\s*false/);
  assert.match(serverOutput, /credential_configured:\s*false/);
  assert.doesNotMatch(
    serverOutput,
    /oauth2\.googleapis\.com|fcm\.googleapis\.com|ia4tube-api\.onrender\.com/i
  );
});

test("reviewer sandbox rejects personal accounts and accepts Creator after reset", async (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-gate5a-reviewer-account-types-")
  );
  const dataDirectory = path.join(temporaryRoot, "data");
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(path.join(dataDirectory, "clientes.json"), JSON.stringify({
    [LOGIN]: {
      nome_time: "Sabor da Vila Hamburgueria — DEMO",
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
