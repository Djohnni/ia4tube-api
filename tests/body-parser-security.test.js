"use strict";

const assert = require("assert/strict");
const bodyParser = require("body-parser");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const jwt = require("jsonwebtoken");

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
    BOT_RUNNER_TOKEN: botToken,
    BOT_RUNNER_TOKEN_NEXT: "",
    MP_ACCESS_TOKEN: "",
    OPENAI_API_KEY: "",
    FCM_MOCK: "1",
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

async function assertJwtStartupRejected(dataDir, jwtValue) {
  const port = await getFreePort();
  const instance = spawnServer(port, dataDir, { jwtValue });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("JWT startup rejection timeout")),
      5_000
    );
    instance.child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  }).finally(() => {
    if (instance.child.exitCode === null) {
      instance.child.kill("SIGKILL");
    }
  });
  assert.notEqual(exitCode, 0);
  assert.match(instance.output(), /JWT_SECRET/);
  if (jwtValue) {
    assert.equal(instance.output().includes(jwtValue), false);
  }
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
  writeJson(path.join(dataDir, "clientes.json"), {});

  await assertJwtStartupRejected(dataDir, undefined);
  await assertJwtStartupRejected(
    dataDir,
    "synthetic-weak-jwt"
  );
  await assertJwtStartupRejected(
    dataDir,
    "TROQUE_ISSO_AGORA"
  );

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
    assert.match(serverSource, /express\.json\(\{ limit: "50mb" \}\)/);
    assert.match(serverSource, /express\.urlencoded\(\{ extended: false, limit: "1mb" \}\)/);
    assert.equal(
      (serverSource.match(/jwt\.verify\(/g) || []).length,
      4
    );
    assert.equal(
      (serverSource.match(/algorithms:\s*\["HS256"\]/g) || [])
        .length,
      4
    );
    assert.equal(
      (serverSource.match(/jwt\.sign\(/g) || []).length,
      5
    );
    assert.equal(
      (serverSource.match(/algorithm:\s*"HS256"/g) || []).length,
      5
    );

    await waitForServer(instance);

    const validJson = await request(port, "/webhook/mercadopago", {
      method: "POST",
      body: { data: { id: "synthetic-disabled-payment" } }
    });
    assert.equal(validJson.status, 200);

    const invalidJson = await request(port, "/webhook/mercadopago", {
      method: "POST",
      body: "{\"data\":"
    });
    assert.equal(invalidJson.status, 400);

    const register = await request(port, "/auth/register", {
      method: "POST",
      body: {
        whatsapp: "parser-user",
        senha: "ParserSyntheticPassword!2026",
        nome_time: "Empresa Parser Sintetica"
      }
    });
    assert.equal(register.status, 200);

    const existingHs256Session = jwt.sign(
      { whatsapp: "parser-user" },
      jwtSecret,
      { expiresIn: "5m" }
    );
    const existingSessionResponse = await request(port, "/me", {
      method: "GET",
      token: existingHs256Session
    });
    assert.equal(existingSessionResponse.status, 200);

    const rejectedHs384Session = jwt.sign(
      { whatsapp: "parser-user" },
      jwtSecret,
      {
        algorithm: "HS384",
        expiresIn: "5m"
      }
    );
    const rejectedAlgorithmResponse = await request(port, "/me", {
      method: "GET",
      token: rejectedHs384Session
    });
    assert.equal(rejectedAlgorithmResponse.status, 401);

    const login = await request(port, "/auth/login", {
      method: "POST",
      body: {
        whatsapp: "parser-user",
        senha: "ParserSyntheticPassword!2026"
      }
    });
    assert.equal(login.status, 200);
    const loginPayload = JSON.parse(login.body.toString("utf8"));
    assert.equal(
      jwt.decode(loginPayload.token, { complete: true }).header.alg,
      "HS256"
    );

    const oversizedUrlencoded = Buffer.from(`campo=${"x".repeat(1024 * 1024 + 1024)}`, "utf8");
    const urlencoded413 = await request(port, "/auth/login", {
      method: "POST",
      rawBody: oversizedUrlencoded,
      contentType: "application/x-www-form-urlencoded"
    });
    assert.equal(urlencoded413.status, 413);

    const oversizedJson = Buffer.from(
      `{"payload":"${"x".repeat(50 * 1024 * 1024 + 1024)}"}`,
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
