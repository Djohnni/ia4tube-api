"use strict";

const assert = require("assert/strict");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const repoDir = path.resolve(__dirname, "..");
const serverFile = path.join(repoDir, "server.js");
const jwtSecret = "checkpoint-a-test-secret-with-at-least-32-characters";
const SECURE_STARTUP_FAILURE_TIMEOUT_MS = 15_000;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function createOrder(dataDir, owner, id, finalBytes, previewBytes = finalBytes) {
  const base = path.join(dataDir, "pedidos", owner, "2026-07", id);
  fs.mkdirSync(base, { recursive: true });
  writeJson(path.join(base, "pedido.json"), {
    whatsapp: owner,
    categoria: "arte_empresa",
    product_id: "arte_empresa",
    status: "pronto",
    pagamento_pendente: false,
    criado_em: "2026-07-25T12:00:00.000Z"
  });
  fs.writeFileSync(path.join(base, "resultado_final.png"), finalBytes);
  fs.writeFileSync(path.join(base, "preview_ia4tube.jpg"), previewBytes);
  fs.writeFileSync(path.join(base, "status.txt"), "pronto", "utf8");
}

function baseEnvironment({ port, dataDir, jwt = jwtSecret } = {}) {
  return {
    ...process.env,
    PORT: String(port || 0),
    DATA_DIR: dataDir,
    NODE_ENV: "test",
    HTTPS_ENFORCE: "true",
    HTTPS_ALLOW_LOCAL_HTTP: "false",
    PUBLIC_API_BASE_URL: "https://ia4tube.test",
    JWT_SECRET: jwt,
    BOT_RUNNER_TOKEN: "",
    BOT_RUNNER_TOKEN_NEXT: "",
    MP_ACCESS_TOKEN: "",
    OPENAI_API_KEY: "",
    FCM_MOCK: "1",
    IA4TUBE_FREE_ART_ENABLED: "false",
    AUTH_LOGIN_RATE_LIMIT_MAX: "3",
    AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX: "2",
    AUTH_LOGIN_RATE_LIMIT_WINDOW_MS: "60000"
  };
}

function spawnServer(env) {
  const child = spawn(process.execPath, [serverFile], {
    cwd: repoDir,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  return { child, output: () => output };
}

async function waitForServer(instance, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (instance.output().includes("API rodando na porta")) return;
    if (instance.child.exitCode !== null) {
      throw new Error(`Servidor encerrou antes de iniciar. Saida redigida: ${instance.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Servidor de teste nao iniciou no prazo.");
}

function request(port, route, {
  method = "GET",
  token = "",
  secure = true,
  body,
  headers = {}
} = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuffer = body === undefined
      ? null
      : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");

    const requestHeaders = {
      Host: "ia4tube.test",
      ...(secure ? { "X-Forwarded-Proto": "https" } : {}),
      ...(bodyBuffer ? {
        "Content-Type": "application/json",
        "Content-Length": String(bodyBuffer.length)
      } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    };

    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: route,
      method,
      headers: requestHeaders
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: responseBody,
          json: () => JSON.parse(responseBody.toString("utf8") || "{}")
        });
      });
    });

    req.once("error", reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

async function expectMissingJwtFailsSecurely(dataDir) {
  const port = await getFreePort();
  const env = baseEnvironment({ port, dataDir });
  delete env.JWT_SECRET;
  const instance = spawnServer(env);
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      instance.child.kill();
      reject(new Error("Servidor sem JWT_SECRET nao encerrou."));
    }, SECURE_STARTUP_FAILURE_TIMEOUT_MS);
    instance.child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  assert.notEqual(exitCode, 0);
  assert.match(instance.output(), /JWT_SECRET/);
  assert.doesNotMatch(instance.output(), /TROQUE_ISSO_AGORA/);
}

async function expectInvalidPublicApiBaseFailsSecurely(dataDir, value) {
  const port = await getFreePort();
  const env = baseEnvironment({ port, dataDir });
  if (value === undefined) {
    delete env.PUBLIC_API_BASE_URL;
  } else {
    env.PUBLIC_API_BASE_URL = value;
  }
  const instance = spawnServer(env);
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      instance.child.kill();
      reject(new Error("Servidor com PUBLIC_API_BASE_URL invalida nao encerrou."));
    }, SECURE_STARTUP_FAILURE_TIMEOUT_MS);
    instance.child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  assert.notEqual(exitCode, 0);
  assert.match(instance.output(), /PUBLIC_API_BASE_URL/);
  assert.doesNotMatch(instance.output(), /ia4tube-api\.onrender\.com/);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-checkpoint-a-"));
  const dataDir = path.join(tempRoot, "data");
  const passwordA = "SenhaTesteA!2026";
  const passwordB = "SenhaTesteB!2026";
  const orderA = "20260725_120001";
  const orderB = "20260725_120002";
  const collisionOrder = "20260725_120003";

  const clients = {
    "cliente-a": {
      nome_time: "Cliente A",
      senha_hash: bcrypt.hashSync(passwordA, 8),
      plano: 0,
      saldo_mensal: 0,
      saldo_extra: 100,
      usados_no_ciclo: 0,
      ciclo_mes: "202607",
      conta_finalizada: true,
      ativo: true
    },
    "cliente-b": {
      nome_time: "Cliente B",
      senha_hash: bcrypt.hashSync(passwordB, 8),
      plano: 0,
      saldo_mensal: 0,
      saldo_extra: 100,
      usados_no_ciclo: 0,
      ciclo_mes: "202607",
      conta_finalizada: true,
      ativo: true
    }
  };
  writeJson(path.join(dataDir, "clientes.json"), clients);
  createOrder(dataDir, "cliente-a", orderA, Buffer.from("A_FINAL"), Buffer.from("A_THUMB"));
  createOrder(dataDir, "cliente-b", orderB, Buffer.from("B_FINAL"), Buffer.from("B_THUMB"));
  createOrder(dataDir, "cliente-a", collisionOrder, Buffer.from("A_COLLISION"));
  createOrder(dataDir, "cliente-b", collisionOrder, Buffer.from("B_COLLISION"));

  await expectMissingJwtFailsSecurely(dataDir);
  await expectInvalidPublicApiBaseFailsSecurely(dataDir, undefined);
  await expectInvalidPublicApiBaseFailsSecurely(dataDir, "http://staging.invalid");

  const port = await getFreePort();
  const instance = spawnServer(baseEnvironment({ port, dataDir }));
  try {
    await waitForServer(instance);

    const insecureLogin = await request(port, "/auth/login", {
      method: "POST",
      secure: false,
      body: { whatsapp: "cliente-a", senha: passwordA }
    });
    assert.equal(insecureLogin.status, 426);

    const insecureGet = await request(port, "/", { secure: false });
    assert.equal(insecureGet.status, 308);
    assert.match(String(insecureGet.headers.location || ""), /^https:\/\//);

    const disabledPaymentWebhook = await request(port, "/webhook/mercadopago", {
      method: "POST",
      body: { data: { id: "pagamento-sintetico" } }
    });
    assert.equal(disabledPaymentWebhook.status, 503);

    const sitemap = await request(port, "/sitemap.xml");
    assert.equal(sitemap.status, 200);
    assert.ok(sitemap.body.toString("utf8").includes("https://ia4tube.test/"));
    assert.ok(!sitemap.body.toString("utf8").includes("ia4tube-api.onrender.com"));

    const robots = await request(port, "/robots.txt");
    assert.equal(robots.status, 200);
    assert.ok(robots.body.toString("utf8").includes("https://ia4tube.test/sitemap.xml"));

    const loginA = await request(port, "/auth/login", {
      method: "POST",
      body: { whatsapp: "cliente-a", senha: passwordA }
    });
    assert.equal(loginA.status, 200);
    const tokenA = loginA.json().token;
    assert.ok(tokenA);
    assert.equal(loginA.headers["x-content-type-options"], "nosniff");
    assert.equal(loginA.headers["x-frame-options"], "DENY");
    assert.match(String(loginA.headers["strict-transport-security"] || ""), /max-age=/);

    const marketingVideo = await request(port, "/marketing/video", { token: tokenA });
    assert.equal(marketingVideo.status, 200);
    assert.ok(marketingVideo.json().url_video.startsWith("https://ia4tube.test/"));
    assert.ok(marketingVideo.json().thumbnail.startsWith("https://ia4tube.test/"));

    const loginB = await request(port, "/auth/login", {
      method: "POST",
      body: { whatsapp: "cliente-b", senha: passwordB }
    });
    assert.equal(loginB.status, 200);
    const tokenB = loginB.json().token;
    assert.ok(tokenB);

    const noAuth = await request(port, `/pedidos/${orderA}/preview`);
    assert.equal(noAuth.status, 401);

    const ownPreview = await request(port, `/pedidos/${orderA}/preview`, { token: tokenA });
    assert.equal(ownPreview.status, 200);
    assert.equal(ownPreview.body.toString("utf8"), "A_FINAL");

    const crossPreview = await request(port, `/pedidos/${orderB}/preview`, { token: tokenA });
    assert.equal(crossPreview.status, 404);
    const crossThumbnail = await request(port, `/pedidos/${orderB}/thumbnail`, { token: tokenA });
    assert.equal(crossThumbnail.status, 404);

    const ownThumbnail = await request(port, `/pedidos/${orderA}/thumbnail`, { token: tokenA });
    assert.equal(ownThumbnail.status, 200);
    assert.equal(ownThumbnail.body.toString("utf8"), "A_THUMB");

    const signedResponse = await request(
      port,
      `/pedidos/${orderA}/media-url?variant=preview`,
      { token: tokenA }
    );
    assert.equal(signedResponse.status, 200);
    const signedUrl = new URL(signedResponse.json().url);
    assert.ok(signedUrl.searchParams.get("exp"));
    assert.ok(signedUrl.searchParams.get("sig"));

    const signedFetch = await request(port, `${signedUrl.pathname}${signedUrl.search}`);
    assert.equal(signedFetch.status, 200);
    assert.equal(signedFetch.body.toString("utf8"), "A_FINAL");

    const tamperedPath = signedUrl.pathname.replace(orderA, orderB) + signedUrl.search;
    const tamperedFetch = await request(port, tamperedPath);
    assert.equal(tamperedFetch.status, 404);

    const expiredUrl = new URL(signedUrl.toString());
    expiredUrl.searchParams.set("exp", "1");
    const expiredFetch = await request(port, `${expiredUrl.pathname}${expiredUrl.search}`);
    assert.equal(expiredFetch.status, 404);

    const collisionAResponse = await request(
      port,
      `/pedidos/${collisionOrder}/media-url?variant=preview`,
      { token: tokenA }
    );
    const collisionBResponse = await request(
      port,
      `/pedidos/${collisionOrder}/media-url?variant=preview`,
      { token: tokenB }
    );
    const collisionAUrl = new URL(collisionAResponse.json().url);
    const collisionBUrl = new URL(collisionBResponse.json().url);
    const collisionA = await request(port, `${collisionAUrl.pathname}${collisionAUrl.search}`);
    const collisionB = await request(port, `${collisionBUrl.pathname}${collisionBUrl.search}`);
    assert.equal(collisionA.body.toString("utf8"), "A_COLLISION");
    assert.equal(collisionB.body.toString("utf8"), "B_COLLISION");

    const orderList = await request(port, "/meus-pedidos", { token: tokenA });
    assert.equal(orderList.status, 200);
    const listedOrder = orderList.json().pedidos.find((item) => item.id === orderA);
    assert.ok(listedOrder?.imagem_url);
    assert.ok(new URL(listedOrder.imagem_url).searchParams.get("sig"));

    const orderInfo = await request(port, `/pedidos/${orderA}/info`, { token: tokenA });
    assert.equal(orderInfo.status, 200);
    assert.ok(new URL(orderInfo.json().preview_url).searchParams.get("sig"));

    const download = await request(port, `/pedidos/${orderA}/download-resultado`, { token: tokenA });
    assert.equal(download.status, 200);
    assert.equal(download.body.toString("utf8"), "A_FINAL");

    const created = await request(port, "/pedidos", {
      method: "POST",
      token: tokenA,
      body: { flyer_tipo: "pedido", nome_time: "Teste isolado", rodada: "1", data: "25/07/2026" }
    });
    assert.equal(created.status, 200);
    const createdId = created.json().pedido_id;
    assert.ok(createdId);
    const createdCrossRead = await request(port, `/pedidos/${createdId}/info`, { token: tokenB });
    assert.equal(createdCrossRead.status, 404);

    const wrong1 = await request(port, "/auth/login", {
      method: "POST",
      body: { whatsapp: "cliente-a", senha: "incorreta-1" }
    });
    const wrong2 = await request(port, "/auth/login", {
      method: "POST",
      body: { whatsapp: "cliente-a", senha: "incorreta-2" }
    });
    const blocked = await request(port, "/auth/login", {
      method: "POST",
      body: { whatsapp: "cliente-a", senha: "incorreta-3" }
    });
    assert.equal(wrong1.status, 401);
    assert.equal(wrong2.status, 401);
    assert.equal(blocked.status, 429);

    const { createOrderMediaAccess } = require("../src/security/order-media-access");
    const mediaAccess = createOrderMediaAccess({ secret: jwtSecret, defaultTtlSeconds: 1 });
    const signedPath = new URL(mediaAccess.buildUrl({
      baseUrl: "https://ia4tube.test",
      owner: "cliente-a",
      orderId: orderA,
      variant: "preview",
      ttlSeconds: 1,
      now: 1000
    }));
    assert.equal(mediaAccess.verify({
      owner: "cliente-a",
      orderId: orderA,
      variant: "preview",
      nonce: signedPath.searchParams.get("nonce"),
      expiresAt: Number(signedPath.searchParams.get("exp")),
      signature: signedPath.searchParams.get("sig"),
      now: 1000
    }), true);
    assert.equal(mediaAccess.verify({
      owner: "cliente-a",
      orderId: orderA,
      variant: "preview",
      nonce: signedPath.searchParams.get("nonce"),
      expiresAt: Number(signedPath.searchParams.get("exp")),
      signature: signedPath.searchParams.get("sig"),
      now: 3000
    }), false);

    const { redactString, redactLogValue, REDACTED } = require("../src/security/log-redaction");
    const fakeBearer = "Bearer checkpointA_fake_authorization_value";
    const fakeCode = "checkpointA_fake_oauth_code";
    const fakeToken = "eyJmYWtl.fake.signature";
    const redacted = JSON.stringify(redactLogValue({
      authorization: fakeBearer,
      nested: `https://example.test/callback?code=${fakeCode}&token=${fakeToken}`,
      access_token: fakeToken
    })) + redactString(`${fakeBearer} https://example.test/?code=${fakeCode}`);
    assert.ok(redacted.includes(REDACTED));
    assert.ok(!redacted.includes("checkpointA_fake_authorization_value"));
    assert.ok(!redacted.includes(fakeCode));
    assert.ok(!redacted.includes(fakeToken));

    const { getPedidoBase, isSafePathSegment } = require("../src/orders/order.storage");
    assert.equal(isSafePathSegment(".."), false);
    assert.equal(isSafePathSegment("../cliente-b"), false);
    assert.equal(getPedidoBase(path.join(dataDir, "pedidos"), "cliente-a", "../cliente-b"), null);

    assert.ok(!instance.output().includes(tokenA));
    assert.ok(!instance.output().includes(tokenB));

    process.stdout.write("Checkpoint A security integration tests: OK\n");
  } finally {
    instance.child.kill();
    await new Promise((resolve) => instance.child.once("exit", resolve));
    const resolvedTemp = path.resolve(tempRoot);
    if (resolvedTemp.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
