"use strict";

const assert = require("assert/strict");
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const repoDir = path.resolve(__dirname, "..");
const serverFile = path.join(repoDir, "server.js");
const jwtSecret = "body-parser-test-secret-with-at-least-32-characters";
const botToken = "body-parser-synthetic-runner-token";

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

function spawnServer(port, dataDir, options = {}) {
  const jwtValue = Object.hasOwn(options, "jwtValue")
    ? options.jwtValue
    : jwtSecret;
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    NODE_ENV: "test",
    HTTPS_ENFORCE: "true",
    HTTPS_ALLOW_LOCAL_HTTP: "false",
    PUBLIC_API_BASE_URL: "https://ia4tube.test",
    ORDER_MEDIA_SIGNING_SECRET: "body-parser-media-signing-secret-with-at-least-32-characters",
    BOT_ADMIN_WHATSAPP: "parser-admin",
    BOT_RUNNER_TOKEN: botToken,
    BOT_RUNNER_TOKEN_NEXT: "",
    MP_ACCESS_TOKEN: "",
    OPENAI_API_KEY: "",
    FCM_MOCK: "1",
    FCM_DELIVERY_ENABLED: "false",
    FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "false",
    IA4TUBE_FREE_ART_ENABLED: "false",
    AUTH_LOGIN_RATE_LIMIT_MAX: "50",
    AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX: "50",
    AUTH_ACCOUNT_CREATE_RATE_LIMIT_MAX: "50"
  };
  if (jwtValue !== undefined) env.JWT_SECRET = jwtValue;
  else delete env.JWT_SECRET;
  const child = spawn(process.execPath, [serverFile], {
    cwd: repoDir,
    windowsHide: true,
    env,
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
      throw new Error(`Servidor body-parser encerrou antes de iniciar: ${instance.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Servidor body-parser nao iniciou no prazo.");
}

function request(port, route, {
  method = "GET",
  token = "",
  body,
  rawBody,
  contentType = "application/json",
  headers = {}
} = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuffer = rawBody !== undefined
      ? Buffer.from(rawBody)
      : body === undefined
        ? null
        : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");

    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: route,
      method,
      headers: {
        Host: "ia4tube.test",
        "X-Forwarded-Proto": "https",
        ...(bodyBuffer ? {
          "Content-Type": contentType,
          "Content-Length": String(bodyBuffer.length)
        } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.once("error", reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

function multipartBody(fields) {
  const boundary = "----ia4tube-body-parser-test-boundary";
  const chunks = [];
  for (const field of fields) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"\r\n`
      + `Content-Type: ${field.contentType}\r\n\r\n`,
      "utf8"
    ));
    chunks.push(Buffer.from(field.content));
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

function temporaryUploadEntries(dataDir) {
  const directory = path.join(dataDir, "tmp_uploads");
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

async function waitForTemporaryUploadsToClear(dataDir, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const entries = temporaryUploadEntries(dataDir);
    if (entries.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(temporaryUploadEntries(dataDir), []);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-body-parser-"));
  const dataDir = path.join(tempRoot, "data");
  const uploadOrderId = "body-parser-upload-order";
  const uploadOrderDir = path.join(dataDir, "pedidos", "parser-user", "2026-07", uploadOrderId);
  fs.mkdirSync(uploadOrderDir, { recursive: true });
  writeJson(path.join(uploadOrderDir, "pedido.json"), {
    id: uploadOrderId,
    whatsapp: "parser-user",
    categoria: "arte_empresa",
    product_id: "arte_empresa",
    status: "novo",
    pagamento_pendente: false
  });
  fs.writeFileSync(path.join(uploadOrderDir, "status.txt"), "novo", "utf8");
  writeJson(path.join(dataDir, "clientes.json"), {
    "parser-user": {
      nome_time: "Empresa Parser Sintetica",
      senha_hash: bcrypt.hashSync("ParserSyntheticPassword!2026", 4),
      ativo: true
    }
  });

  const port = await getFreePort();
  const instance = spawnServer(port, dataDir);

  try {
    assert.equal(require("express/package.json").version, "4.22.2");
    assert.equal(require("body-parser/package.json").version, "1.20.6");
    assert.doesNotThrow(() => bodyParser.json({ limit: "50mb" }));
    assert.doesNotThrow(() => bodyParser.urlencoded({ extended: false, limit: "1mb" }));
    assert.throws(() => bodyParser.json({ limit: "valor-invalido" }));
    assert.throws(() => bodyParser.urlencoded({ extended: false, limit: Number.NaN }));

    const serverSource = fs.readFileSync(serverFile, "utf8");
    assert.match(serverSource, /express\.json\(\{ limit: "1mb" \}\)/);
    assert.match(serverSource, /express\.urlencoded\(\{ extended: false, limit: "1mb" \}\)/);
    assert.equal(
      (serverSource.match(/jwt\.verify\(/g) || []).length,
      1
    );
    assert.equal(
      (serverSource.match(/algorithms:\s*\["HS256"\]/g) || [])
        .length,
      1
    );
    assert.equal(
      (serverSource.match(/jwt\.sign\(/g) || []).length,
      1
    );
    assert.equal(
      (serverSource.match(/algorithm:\s*"HS256"/g) || []).length,
      1
    );

    await waitForServer(instance);

    const validJson = await request(port, "/webhook/mercadopago", {
      method: "POST",
      body: { data: { id: "synthetic-disabled-payment" } }
    });
    assert.equal(validJson.status, 503);

    const invalidJson = await request(port, "/webhook/mercadopago", {
      method: "POST",
      body: "{\"data\":"
    });
    assert.equal(invalidJson.status, 400);

    const invalidAuthJson = await request(port, "/auth/login", {
      method: "POST",
      body: "{\"whatsapp\":"
    });
    assert.equal(invalidAuthJson.status, 400);

    const register = await request(port, "/auth/register", {
      method: "POST",
      body: {
        whatsapp: "parser-register-user",
        senha: "ParserSyntheticPassword!2026",
        nome_time: "Empresa Parser Sintetica"
      }
    });
    assert.equal(register.status, 200);

    const login = await request(port, "/auth/login", {
      method: "POST",
      body: {
        whatsapp: "parser-user",
        senha: "ParserSyntheticPassword!2026"
      }
    });
    assert.equal(login.status, 200);
    const loginPayload = JSON.parse(login.body.toString("utf8"));
    assert.ok(loginPayload.token);

    const validPngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00
    ]);
    const earlyRejectedMultipart = multipartBody([{
      name: "logo",
      filename: "synthetic-logo.png",
      contentType: "image/png",
      content: validPngHeader
    }]);
    const earlyRejectedUpload = await request(port, "/pedidos", {
      method: "POST",
      token: loginPayload.token,
      rawBody: earlyRejectedMultipart.body,
      contentType: earlyRejectedMultipart.contentType
    });
    assert.equal(earlyRejectedUpload.status, 400);
    await waitForTemporaryUploadsToClear(dataDir);

    const maximumContractFiles = [
      "escudo1",
      "escudo2",
      "mascote",
      ...Array(20).fill("patrocinadores"),
      "logo",
      ...Array(20).fill("fotos"),
      ...Array(20).fill("referencias"),
      "modelo_existente"
    ].map((name, index) => ({
      name,
      filename: `synthetic-${index}.png`,
      contentType: "image/png",
      content: validPngHeader
    }));
    assert.equal(maximumContractFiles.length, 65);
    const maximumContractMultipart = multipartBody(maximumContractFiles);
    const maximumContractUpload = await request(port, "/pedidos", {
      method: "POST",
      token: loginPayload.token,
      rawBody: maximumContractMultipart.body,
      contentType: maximumContractMultipart.contentType
    });
    assert.equal(maximumContractUpload.status, 400);
    await waitForTemporaryUploadsToClear(dataDir);

    const maximumMonthlyContractFiles = [
      "escudo1",
      "escudo2",
      "mascote",
      ...Array(20).fill("patrocinadores"),
      "logo",
      ...Array(36).fill("fotos"),
      ...Array(20).fill("referencias"),
      "modelo_existente"
    ].map((name, index) => ({
      name,
      filename: `synthetic-monthly-${index}.png`,
      contentType: "image/png",
      content: validPngHeader
    }));
    assert.equal(maximumMonthlyContractFiles.length, 81);
    const maximumMonthlyContractMultipart = multipartBody(maximumMonthlyContractFiles);
    const maximumMonthlyContractUpload = await request(
      port,
      "/empresa/planejamento-mensal/solicitar",
      {
        method: "POST",
        token: loginPayload.token,
        rawBody: maximumMonthlyContractMultipart.body,
        contentType: maximumMonthlyContractMultipart.contentType
      }
    );
    assert.notEqual(maximumMonthlyContractUpload.status, 413);
    assert.notEqual(maximumMonthlyContractUpload.status, 500);
    await waitForTemporaryUploadsToClear(dataDir);

    const spoofedMultipart = multipartBody([{
      name: "logo",
      filename: "spoofed.png",
      contentType: "image/png",
      content: Buffer.from("not-an-image", "utf8")
    }]);
    const spoofedUpload = await request(port, "/pedidos", {
      method: "POST",
      token: loginPayload.token,
      rawBody: spoofedMultipart.body,
      contentType: spoofedMultipart.contentType
    });
    assert.equal(spoofedUpload.status, 415);
    assert.equal(
      JSON.parse(spoofedUpload.body.toString("utf8")).code,
      "invalid_image_content"
    );
    await waitForTemporaryUploadsToClear(dataDir);

    const oversizedImage = Buffer.alloc(8 * 1024 * 1024 + 1);
    validPngHeader.copy(oversizedImage);
    const oversizedMultipart = multipartBody([{
      name: "logo",
      filename: "oversized.png",
      contentType: "image/png",
      content: oversizedImage
    }]);
    const oversizedUpload = await request(port, "/pedidos", {
      method: "POST",
      token: loginPayload.token,
      rawBody: oversizedMultipart.body,
      contentType: oversizedMultipart.contentType
    });
    assert.equal(oversizedUpload.status, 413);
    assert.equal(
      JSON.parse(oversizedUpload.body.toString("utf8")).code,
      "upload_limit_exceeded"
    );
    await waitForTemporaryUploadsToClear(dataDir);

    const oversizedUrlencoded = Buffer.from(`campo=${"x".repeat(1024 * 1024 + 1024)}`, "utf8");
    const urlencoded413 = await request(port, "/auth/login", {
      method: "POST",
      rawBody: oversizedUrlencoded,
      contentType: "application/x-www-form-urlencoded"
    });
    assert.equal(urlencoded413.status, 413);

    const oversizedAuthJson = Buffer.from(
      `{"whatsapp":"parser-user","senha":"${"x".repeat(33 * 1024)}"}`,
      "utf8"
    );
    const authJson413 = await request(port, "/auth/login", {
      method: "POST",
      rawBody: oversizedAuthJson,
      contentType: "application/json"
    });
    assert.equal(authJson413.status, 413);

    const oversizedJson = Buffer.from(
      `{"payload":"${"x".repeat(1024 * 1024 + 1024)}"}`,
      "utf8"
    );
    const json413 = await request(port, "/webhook/mercadopago", {
      method: "POST",
      rawBody: oversizedJson,
      contentType: "application/json"
    });
    assert.equal(json413.status, 413);

    const multipart = multipartBody([
      {
        name: "resultado",
        filename: "resultado.png",
        contentType: "image/png",
        content: Buffer.from("synthetic-result-image")
      },
      {
        name: "preview",
        filename: "preview.jpg",
        contentType: "image/jpeg",
        content: Buffer.from("synthetic-preview-image")
      }
    ]);
    const upload = await request(port, `/bot/pedidos/${uploadOrderId}/upload-resultado`, {
      method: "POST",
      token: botToken,
      rawBody: multipart.body,
      contentType: multipart.contentType
    });
    assert.equal(upload.status, 200);
    assert.equal(
      fs.readFileSync(path.join(uploadOrderDir, "resultado_final.png"), "utf8"),
      "synthetic-result-image"
    );
    assert.equal(
      fs.readFileSync(path.join(uploadOrderDir, "preview_ia4tube.jpg"), "utf8"),
      "synthetic-preview-image"
    );

    assert.doesNotMatch(instance.output(), new RegExp(botToken));
    assert.doesNotMatch(instance.output(), /synthetic-disabled-payment/);
    process.stdout.write("body-parser 1.20.6 integration tests: OK\n");
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
