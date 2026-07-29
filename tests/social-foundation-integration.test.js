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
const jwt = require("jsonwebtoken");

const ROOT = path.resolve(__dirname, "..");
const SYNTHETIC_BOT_TOKEN = "R".repeat(64);

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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function createSyntheticOrder(dataDir, owner, orderId, {
  final = `final-${owner}`,
  protectedPreview = `protected-${owner}`,
  paymentPending = false
} = {}) {
  const base = path.join(dataDir, "pedidos", owner, "2026-07", orderId);
  fs.mkdirSync(base, { recursive: true });
  writeJson(path.join(base, "pedido.json"), {
    id: orderId,
    whatsapp: owner,
    nome_empresa: `Synthetic ${owner}`,
    pagamento_pendente: paymentPending
  });
  fs.writeFileSync(path.join(base, "resultado_final.png"), final, "utf8");
  fs.writeFileSync(path.join(base, "preview_ia4tube.jpg"), protectedPreview, "utf8");
  fs.writeFileSync(path.join(base, "status.txt"), "pronto", "utf8");
  return base;
}

function request(port, pathname, {
  method = "GET",
  token = "",
  body,
  headers = {}
} = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        ...(payload ? {
          "Content-Type": "application/json",
          "Content-Length": String(payload.length)
        } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(buffer.toString("utf8"));
        } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: buffer,
          json
        });
      });
    });
    req.once("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startServer({ port, dataDir, jwtSecret, mediaSecret }) {
  const logs = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      RENDER: "false",
      DATA_DIR: dataDir,
      PUBLIC_API_BASE_URL: `https://127.0.0.1:${port}`,
      JWT_SECRET: jwtSecret,
      ORDER_MEDIA_SIGNING_SECRET: mediaSecret,
      BOT_ADMIN_WHATSAPP: "synthetic-admin",
      BOT_RUNNER_TOKEN: SYNTHETIC_BOT_TOKEN,
      MP_ACCESS_TOKEN: "",
      HTTPS_ENFORCE: "false",
      HTTPS_ALLOW_LOCAL_HTTP: "true",
      FCM_TOKEN_REGISTRATION_ENABLED: "false",
      FCM_ART_READY_EVENT_ENABLED: "false",
      FCM_DELIVERY_ENABLED: "false",
      FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "false",
      FCM_MOCK: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString("utf8")));

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`synthetic server exited: ${logs.join("").slice(0, 500)}`);
    }
    try {
      const response = await request(port, "/");
      if (response.status === 200) return { child, logs };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error(`synthetic server timeout: ${logs.join("").slice(0, 500)}`);
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function runUntilExit(env, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("synthetic fail-closed process did not exit"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.join("") });
    });
  });
}

test("runtime implantado falha fechado sem URL publica ou segredo de midia", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-config-fail-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const baseEnv = {
    ...process.env,
    NODE_ENV: "production",
    RENDER: "true",
    DATA_DIR: dataDir,
    JWT_SECRET: "J".repeat(64),
    BOT_ADMIN_WHATSAPP: "synthetic-admin",
    BOT_RUNNER_TOKEN: "",
    MP_ACCESS_TOKEN: "",
    PUBLIC_API_BASE_URL: "",
    ORDER_MEDIA_SIGNING_SECRET: ""
  };

  const missingPublic = await runUntilExit(baseEnv);
  assert.notEqual(missingPublic.code, 0);
  assert.match(missingPublic.output, /PUBLIC_API_BASE_URL/);
  assert.ok(!missingPublic.output.includes("J".repeat(32)));

  const missingMediaSecret = await runUntilExit({
    ...baseEnv,
    PUBLIC_API_BASE_URL: "https://synthetic-api.example.test"
  });
  assert.notEqual(missingMediaSecret.code, 0);
  assert.match(missingMediaSecret.output, /ORDER_MEDIA_SIGNING_SECRET/);
  assert.ok(!missingMediaSecret.output.includes("J".repeat(32)));
});

test("servidor isola empresas, protege midia e preserva sessao com o mesmo segredo", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-social-foundation-"));
  const port = await freePort();
  const jwtSecret = "J".repeat(64);
  const mediaSecret = "M".repeat(64);
  const passwordA = "SyntheticA123";
  const passwordB = "SyntheticB123";

  writeJson(path.join(dataDir, "clientes.json"), {
    "empresa-a": {
      nome_time: "Synthetic A",
      senha_hash: bcrypt.hashSync(passwordA, 4),
      ativo: true,
      ciclo_mes: "2026-07"
    },
    "empresa-b": {
      nome_time: "Synthetic B",
      senha_hash: bcrypt.hashSync(passwordB, 4),
      ativo: true,
      ciclo_mes: "2026-07"
    },
    "empresa-colisao": {
      nome_time: "Synthetic Collision",
      senha_hash: bcrypt.hashSync("SyntheticCollision123", 4),
      ativo: true,
      ciclo_mes: "2026-07"
    },
    "synthetic-admin": {
      nome_time: "Synthetic Admin",
      senha_hash: bcrypt.hashSync("SyntheticAdmin123", 4),
      ativo: true,
      ciclo_mes: "2026-07"
    }
  });
  createSyntheticOrder(dataDir, "empresa-a", "shared-id", {
    final: "final-a",
    protectedPreview: "protected-a"
  });
  createSyntheticOrder(dataDir, "empresa-b", "shared-id", {
    final: "final-b",
    protectedPreview: "protected-b"
  });
  createSyntheticOrder(dataDir, "empresa-a", "only-a", {
    final: "only-a-final",
    protectedPreview: "only-a-protected",
    paymentPending: true
  });
  const pendingWithoutPreviewBase = createSyntheticOrder(
    dataDir,
    "empresa-a",
    "pending-without-preview",
    {
      final: "must-never-leak",
      protectedPreview: "remove-this-preview",
      paymentPending: true
    }
  );
  fs.unlinkSync(path.join(pendingWithoutPreviewBase, "preview_ia4tube.jpg"));
  const misplacedNewBase = createSyntheticOrder(
    dataDir,
    "empresa-a",
    "misplaced-new",
    { final: "misplaced-final", protectedPreview: "misplaced-preview" }
  );
  const misplacedNewOrder = JSON.parse(
    fs.readFileSync(path.join(misplacedNewBase, "pedido.json"), "utf8")
  );
  misplacedNewOrder.whatsapp = "empresa-b";
  writeJson(path.join(misplacedNewBase, "pedido.json"), misplacedNewOrder);
  fs.writeFileSync(path.join(misplacedNewBase, "status.txt"), "novo", "utf8");
  createSyntheticOrder(dataDir, "empresa-a", "empresa-colisao", {
    final: "support-collision-final",
    protectedPreview: "support-collision-protected"
  });
  const calendarOrderBase = createSyntheticOrder(dataDir, "empresa-a", "calendar-a", {
    final: "calendar-a-final",
    protectedPreview: "calendar-a-protected"
  });
  const calendarOrder = JSON.parse(
    fs.readFileSync(path.join(calendarOrderBase, "pedido.json"), "utf8")
  );
  Object.assign(calendarOrder, {
    origem: "planejamento_mensal",
    planejamento_id: "planning-a",
    planejamento_item_id: "planning-a-item-001",
    descricao_instagram: "Synthetic calendar caption"
  });
  writeJson(path.join(calendarOrderBase, "pedido.json"), calendarOrder);
  const planningDir = path.join(
    dataDir,
    "planejamentos_mensais",
    "empresa-a",
    "2099-08",
    "planning-a"
  );
  writeJson(path.join(planningDir, "solicitacao.json"), {
    id: "planning-a",
    planejamento_id: "planning-a",
    tipo: "planejamento_mensal",
    whatsapp: "empresa-a",
    ciclo: "2099-08",
    status: "pronto",
    criado_em: "2099-08-01T12:00:00.000Z"
  });
  writeJson(path.join(planningDir, "plano_mensal.json"), {
    planejamento_id: "planning-a",
    postagens: [{
      ordem: 1,
      planejamento_item_id: "planning-a-item-001",
      pedido_id: "calendar-a",
      tema: "Synthetic calendar",
      data_sugerida: "2099-08-10",
      horario_sugerido: "09:00"
    }]
  });
  writeJson(path.join(planningDir, "pedidos_criados.json"), {
    planejamento_id: "planning-a",
    pedidos: [{
      pedido_id: "calendar-a",
      planejamento_item_id: "planning-a-item-001",
      ordem: 1
    }]
  });
  fs.writeFileSync(path.join(planningDir, "status.txt"), "pronto\n", "utf8");

  let runtime = await startServer({ port, dataDir, jwtSecret, mediaSecret });
  t.after(async () => {
    await stopServer(runtime?.child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const loginA = await request(port, "/auth/login", {
    method: "POST",
    body: { whatsapp: "empresa-a", senha: passwordA }
  });
  const loginB = await request(port, "/auth/login", {
    method: "POST",
    body: { whatsapp: "empresa-b", senha: passwordB }
  });
  assert.equal(loginA.status, 200);
  assert.equal(loginB.status, 200);
  const tokenA = loginA.json.token;
  const tokenB = loginB.json.token;
  const signedClaims = jwt.decode(tokenA);
  assert.equal(signedClaims.company_id, "empresa-a");
  assert.equal(signedClaims.sub, "empresa-a");
  assert.equal(signedClaims.token_version, 2);

  const weakRegistration = await request(port, "/auth/register", {
    method: "POST",
    body: { whatsapp: "empresa-c", senha: "123", nome_time: "Synthetic C" }
  });
  assert.equal(weakRegistration.status, 400);
  const reservedAdminRegistration = await request(port, "/auth/register", {
    method: "POST",
    body: {
      whatsapp: "synthetic-admin",
      senha: "SyntheticAdmin123",
      nome_time: "Reserved"
    }
  });
  assert.equal(reservedAdminRegistration.status, 403);
  const reservedProviderRegistration = await request(port, "/auth/register", {
    method: "POST",
    body: {
      whatsapp: "google_synthetic-subject",
      senha: "SyntheticGoogle123",
      nome_time: "Reserved Provider"
    }
  });
  assert.equal(reservedProviderRegistration.status, 403);

  fs.mkdirSync(path.join(dataDir, "pedidos", "empresa-orfa"), { recursive: true });
  const orphanNamespaceRegistration = await request(port, "/auth/register", {
    method: "POST",
    body: {
      whatsapp: "empresa-orfa",
      senha: "SyntheticOrphan123",
      nome_time: "Orphan"
    }
  });
  assert.equal(orphanNamespaceRegistration.status, 409);
  assert.equal(orphanNamespaceRegistration.json.code, "tenant_namespace_reserved");

  const oversizedRegistration = await request(port, "/auth/register", {
    method: "POST",
    body: {
      whatsapp: "empresa-grande",
      senha: "SyntheticLarge123",
      nome_time: "x".repeat(40 * 1024)
    }
  });
  assert.equal(oversizedRegistration.status, 413);
  assert.equal(oversizedRegistration.json.code, "request_payload_too_large");

  const strongRegistration = await request(port, "/auth/register", {
    method: "POST",
    body: {
      whatsapp: "empresa-c",
      senha: "SyntheticC123",
      nome_time: "Synthetic C"
    }
  });
  assert.equal(strongRegistration.status, 200);

  const automatic = await request(port, "/auth/auto-register", {
    method: "POST",
    body: { nome_time: "Synthetic Automatic", produto: "arte_empresa" }
  });
  assert.equal(automatic.status, 200);
  const immutableTenantKey = automatic.json.login;
  createSyntheticOrder(dataDir, immutableTenantKey, "auto-order", {
    final: "auto-final",
    protectedPreview: "auto-protected"
  });
  const automaticProtectedPreview = await request(
    port,
    "/pedidos/auto-order/preview",
    { token: automatic.json.token }
  );
  assert.equal(automaticProtectedPreview.status, 200);
  assert.equal(automaticProtectedPreview.body.toString("utf8"), "auto-protected");
  const finalized = await request(port, "/auth/finalizar-conta-auto", {
    method: "POST",
    token: automatic.json.token,
    body: { login: "empresa-auto-final", senha: "SyntheticAuto123" }
  });
  assert.equal(finalized.status, 200);
  assert.equal(jwt.decode(finalized.json.token).sub, immutableTenantKey);
  const finalizedLogin = await request(port, "/auth/login", {
    method: "POST",
    body: { whatsapp: "empresa-auto-final", senha: "SyntheticAuto123" }
  });
  assert.equal(finalizedLogin.status, 200);
  assert.equal(jwt.decode(finalizedLogin.json.token).sub, immutableTenantKey);
  assert.equal(
    (await request(port, "/pedidos/auto-order/preview", {
      token: finalizedLogin.json.token
    })).body.toString("utf8"),
    "auto-final"
  );
  const oldAutomaticLogin = await request(port, "/auth/login", {
    method: "POST",
    body: { whatsapp: immutableTenantKey, senha: "SyntheticAuto123" }
  });
  assert.equal(oldAutomaticLogin.status, 401);
  const reclaimedOldTenant = await request(port, "/auth/register", {
    method: "POST",
    body: {
      whatsapp: immutableTenantKey,
      senha: "SyntheticReclaim123",
      nome_time: "Reclaim"
    }
  });
  assert.notEqual(reclaimedOldTenant.status, 200);

  const headers = await request(port, "/me", { token: tokenA });
  assert.equal(headers.status, 200);
  assert.equal(headers.headers["x-content-type-options"], "nosniff");
  assert.equal(headers.headers["x-frame-options"], "DENY");
  assert.equal(headers.headers["cross-origin-resource-policy"], "same-origin");
  assert.equal(headers.headers["x-powered-by"], undefined);

  const anonymousPreview = await request(port, "/pedidos/shared-id/preview");
  assert.equal(anonymousPreview.status, 401);

  const previewA = await request(port, "/pedidos/shared-id/preview", { token: tokenA });
  const previewB = await request(port, "/pedidos/shared-id/preview", { token: tokenB });
  assert.equal(previewA.body.toString("utf8"), "final-a");
  assert.equal(previewB.body.toString("utf8"), "final-b");
  assert.equal(previewA.headers["cross-origin-resource-policy"], "cross-origin");

  const crossTenant = await request(port, "/pedidos/only-a/preview", { token: tokenB });
  assert.equal(crossTenant.status, 404);

  const lockedPreview = await request(
    port,
    "/pedidos/pending-without-preview/preview",
    { token: tokenA }
  );
  const lockedThumbnail = await request(
    port,
    "/pedidos/pending-without-preview/thumbnail",
    { token: tokenA }
  );
  assert.equal(lockedPreview.status, 404);
  assert.equal(lockedThumbnail.status, 404);
  assert.equal(lockedPreview.json.code, "protected_preview_unavailable");
  assert.equal(lockedPreview.body.includes(Buffer.from("must-never-leak")), false);

  const newOrders = await request(port, "/pedidos/novos", { token: tokenA });
  assert.equal(newOrders.status, 200);
  assert.equal(
    newOrders.json.pedidos.some((pedido) => pedido.id === "misplaced-new"),
    false
  );

  const mediaUrlResponse = await request(
    port,
    "/pedidos/only-a/media-url?variant=thumbnail",
    { token: tokenA }
  );
  assert.equal(mediaUrlResponse.status, 200);
  const signedUrl = new URL(mediaUrlResponse.json.url);
  assert.ok(!signedUrl.toString().includes("empresa-a"));
  const signedMedia = await request(port, `${signedUrl.pathname}${signedUrl.search}`);
  assert.equal(signedMedia.status, 200);
  assert.equal(signedMedia.body.toString("utf8"), "only-a-protected");
  assert.equal(signedMedia.headers["cross-origin-resource-policy"], "cross-origin");

  const calendar = await request(
    port,
    "/empresa/planejamento-mensal/calendario",
    { token: tokenA }
  );
  assert.equal(calendar.status, 200);
  const calendarItem = calendar.json.postagens.find(
    (item) => item.pedido_id === "calendar-a"
  );
  assert.ok(calendarItem);
  assert.match(calendarItem.thumbnail_url, /^https:\/\//);
  assert.match(calendarItem.thumbnail_url, /sig=/);
  const calendarThumbnailUrl = new URL(calendarItem.thumbnail_url);
  const anonymousCalendarThumbnail = await request(
    port,
    `${calendarThumbnailUrl.pathname}${calendarThumbnailUrl.search}`
  );
  assert.equal(anonymousCalendarThumbnail.status, 200);
  assert.equal(
    anonymousCalendarThumbnail.body.toString("utf8"),
    "calendar-a-final"
  );
  const repeatedCalendar = await request(
    port,
    "/empresa/planejamento-mensal/calendario",
    { token: tokenA }
  );
  const repeatedCalendarItem = repeatedCalendar.json.postagens.find(
    (item) => item.pedido_id === "calendar-a"
  );
  assert.equal(repeatedCalendarItem.thumbnail_url, calendarItem.thumbnail_url);

  const rescheduledCalendar = await request(
    port,
    "/empresa/planejamento-mensal/calendario/reagendar",
    {
      method: "POST",
      token: tokenA,
      body: {
        pedido_id: "calendar-a",
        planning_id: "planning-a",
        planejamento_item_id: "planning-a-item-001",
        data: "2099-08-11",
        horario: "10:00"
      }
    }
  );
  assert.equal(rescheduledCalendar.status, 200);
  assert.match(rescheduledCalendar.json.postagem.thumbnail_url, /^https:\/\//);
  assert.match(rescheduledCalendar.json.postagem.thumbnail_url, /sig=/);

  const originalStatus = fs.readFileSync(
    path.join(dataDir, "pedidos", "empresa-a", "2026-07", "shared-id", "status.txt"),
    "utf8"
  );
  const forbiddenClientStatus = await request(port, "/pedidos/shared-id/status", {
    method: "POST",
    token: tokenA,
    body: { status: "pronto" }
  });
  assert.equal(forbiddenClientStatus.status, 403);
  assert.equal(forbiddenClientStatus.json.code, "client_status_transition_forbidden");
  assert.equal(
    fs.readFileSync(
      path.join(dataDir, "pedidos", "empresa-a", "2026-07", "shared-id", "status.txt"),
      "utf8"
    ),
    originalStatus
  );

  const tamperedOrder = await request(
    port,
    `/pedidos/shared-id/thumbnail${signedUrl.search}`
  );
  assert.equal(tamperedOrder.status, 401);
  const tamperedContext = new URL(signedUrl);
  tamperedContext.searchParams.set("ctx", `${tamperedContext.searchParams.get("ctx")}x`);
  const tamperedContextResponse = await request(
    port,
    `${tamperedContext.pathname}${tamperedContext.search}`
  );
  assert.equal(tamperedContextResponse.status, 401);
  const expired = new URL(signedUrl);
  expired.searchParams.set("exp", "1");
  const expiredResponse = await request(
    port,
    `${expired.pathname}${expired.search}`
  );
  assert.equal(expiredResponse.status, 401);

  const info = await request(port, "/pedidos/only-a/info", { token: tokenA });
  assert.equal(info.status, 200);
  assert.match(info.json.preview_url, /^https:\/\//);
  assert.ok(info.json.preview_url.includes("nonce="));
  assert.ok(!info.json.preview_url.includes("empresa-a"));

  const anonymousOrderEvent = await request(port, "/evento", {
    method: "POST",
    body: { eventos: [{ e: "synthetic", pedido_id: "only-a" }] }
  });
  assert.equal(anonymousOrderEvent.status, 401);
  const scopedOrderEvent = await request(port, "/evento", {
    method: "POST",
    token: tokenB,
    body: { eventos: [{ e: "synthetic", pedido_id: "only-a" }] }
  });
  assert.equal(scopedOrderEvent.status, 404);
  assert.equal(scopedOrderEvent.json.code, "order_event_not_found");
  assert.equal(
    fs.existsSync(path.join(dataDir, "pedidos", "empresa-a", "2026-07", "only-a", "eventos_cliente.json")),
    false
  );

  const supportFile = path.join(dataDir, "suporte_conversas_abertas.json");
  const supportBefore = fs.existsSync(supportFile)
    ? fs.readFileSync(supportFile)
    : null;
  const mismatchedRunnerSupport = await request(
    port,
    "/bot/suporte/erro-pedido",
    {
      method: "POST",
      token: SYNTHETIC_BOT_TOKEN,
      body: {
        pedido_id: "only-a",
        whatsapp: "empresa-b",
        motivo: "synthetic-mismatch"
      }
    }
  );
  assert.equal(mismatchedRunnerSupport.status, 404);
  assert.equal(mismatchedRunnerSupport.json.code, "order_owner_mismatch");
  const supportAfter = fs.existsSync(supportFile)
    ? fs.readFileSync(supportFile)
    : null;
  assert.deepEqual(supportAfter, supportBefore);

  const adminToken = jwt.sign(
    { whatsapp: "synthetic-admin" },
    jwtSecret,
    { algorithm: "HS256", expiresIn: "5m" }
  );
  const ambiguousSupportDestination = await request(
    port,
    "/bot/suporte/enviar-cliente",
    {
      method: "POST",
      token: adminToken,
      body: {
        destino: "empresa-colisao",
        mensagem: "synthetic-admin-message"
      }
    }
  );
  assert.equal(ambiguousSupportDestination.status, 409);
  assert.equal(
    ambiguousSupportDestination.json.code,
    "support_destination_ambiguous"
  );
  const supportAfterAmbiguity = fs.existsSync(supportFile)
    ? fs.readFileSync(supportFile)
    : null;
  assert.deepEqual(supportAfterAmbiguity, supportBefore);

  const legacyToken = jwt.sign({ whatsapp: "empresa-a" }, jwtSecret, {
    algorithm: "HS256",
    expiresIn: "7d"
  });
  assert.equal((await request(port, "/me", { token: legacyToken })).status, 200);

  await stopServer(runtime.child);
  runtime = await startServer({ port, dataDir, jwtSecret, mediaSecret });
  assert.equal((await request(port, "/me", { token: tokenA })).status, 200);
  assert.equal((await request(port, "/me", { token: legacyToken })).status, 200);

  const legal = await request(port, "/privacidade");
  assert.equal(legal.status, 200);
  assert.match(legal.body.toString("utf8"), /RASCUNHO/);
  assert.match(legal.headers["x-robots-tag"], /noindex/);

  let limited = null;
  for (let attempt = 0; attempt < 13; attempt += 1) {
    limited = await request(port, "/auth/login", {
      method: "POST",
      body: { whatsapp: "empresa-a", senha: "wrong-password" }
    });
  }
  assert.equal(limited.status, 429);

  const allLogs = runtime.logs.join("");
  assert.ok(!allLogs.includes(passwordA));
  assert.ok(!allLogs.includes(passwordB));
  assert.ok(!allLogs.includes(tokenA));
  assert.ok(!allLogs.includes(legacyToken));
  assert.ok(!allLogs.includes(SYNTHETIC_BOT_TOKEN));
});
