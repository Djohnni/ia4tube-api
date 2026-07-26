"use strict";

const assert = require("assert/strict");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { EventEmitter } = require("events");
const { spawn } = require("child_process");

const { streamDirectoryZip } = require("../src/zip/zip-stream");

const repoDir = path.resolve(__dirname, "..");
const serverFile = path.join(repoDir, "server.js");
const jwtSecret = "zip-download-test-secret-with-at-least-32-characters";
const botToken = "zip-download-synthetic-runner-token";

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

function writeZipFixture(dirPath, idField, id, marker) {
  fs.mkdirSync(path.join(dirPath, "nested"), { recursive: true });
  writeJson(path.join(dirPath, "solicitacao.json"), {
    [idField]: id,
    id,
    whatsapp: "zip-client",
    ciclo: "202607",
    status: "novo"
  });
  fs.writeFileSync(path.join(dirPath, "status.txt"), "novo", "utf8");
  fs.writeFileSync(path.join(dirPath, "nested", `${marker}.txt`), `conteudo-${marker}`, "utf8");
}

function writeOrderFixture(dataDir, owner, id, marker, planning = false) {
  const dirPath = path.join(dataDir, "pedidos", owner, "2026-07", id);
  fs.mkdirSync(path.join(dirPath, "nested"), { recursive: true });
  writeJson(path.join(dirPath, "pedido.json"), {
    id,
    whatsapp: owner,
    categoria: "arte_empresa",
    product_id: "arte_empresa",
    status: "pronto",
    pagamento_pendente: false,
    criado_em: "2026-07-26T12:00:00.000Z",
    ...(planning ? {
      origem: "planejamento_mensal",
      planejamento_id: "zip-planning",
      planejamento_item_id: `item-${id}`
    } : {})
  });
  fs.writeFileSync(path.join(dirPath, "status.txt"), "pronto", "utf8");
  fs.writeFileSync(path.join(dirPath, "nested", `${marker}.txt`), `conteudo-${marker}`, "utf8");
  return dirPath;
}

function spawnServer(port, dataDir) {
  const child = spawn(process.execPath, [serverFile], {
    cwd: repoDir,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      NODE_ENV: "test",
      HTTPS_ENFORCE: "true",
      HTTPS_ALLOW_LOCAL_HTTP: "false",
      PUBLIC_API_BASE_URL: "https://ia4tube.test",
      JWT_SECRET: jwtSecret,
      BOT_RUNNER_TOKEN: botToken,
      BOT_RUNNER_TOKEN_NEXT: "",
      MP_ACCESS_TOKEN: "",
      OPENAI_API_KEY: "",
      FCM_MOCK: "1",
      IA4TUBE_FREE_ART_ENABLED: "false"
    },
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
      throw new Error(`Servidor ZIP encerrou antes de iniciar: ${instance.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Servidor ZIP nao iniciou no prazo.");
}

function request(port, route, { method = "GET", token = "", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuffer = body === undefined
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
          "Content-Type": "application/json",
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

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP sem End of Central Directory.");
}

function readZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();

  for (let index = 0; index < totalEntries; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "Central Directory invalido");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `Cabecalho local invalido: ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let content = Buffer.alloc(0);
    if (!name.endsWith("/")) {
      if (method === 0) content = compressed;
      else if (method === 8) content = zlib.inflateRawSync(compressed);
      else throw new Error(`Metodo ZIP nao suportado no teste: ${method}`);
      assert.equal(content.length, uncompressedSize, `Tamanho invalido: ${name}`);
    }

    entries.set(name, content);
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function testHelperEdgeCases(tempRoot) {
  const emptyDir = path.join(tempRoot, "empty");
  fs.mkdirSync(emptyDir, { recursive: true });
  const missingDir = path.join(tempRoot, "missing");
  const port = await getFreePort();

  const server = http.createServer(async (req, res) => {
    if (req.url === "/empty") {
      await streamDirectoryZip({ res, directory: emptyDir, filename: "empty.zip" });
      return;
    }
    if (req.url === "/missing") {
      await streamDirectoryZip({ res, directory: missingDir, filename: "missing.zip" });
      return;
    }
    if (req.url === "/stream-error") {
      const archiveFactory = async () => {
        const archive = new EventEmitter();
        archive.pipe = () => {};
        archive.directory = (directory, destination) => {
          assert.equal(directory, emptyDir);
          assert.equal(destination, false);
        };
        archive.finalize = () => {
          const error = new Error("synthetic-stream-error");
          archive.emit("error", error);
          return Promise.reject(error);
        };
        return archive;
      };
      await streamDirectoryZip({
        res,
        directory: emptyDir,
        filename: "error.zip",
        archiveFactory
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  try {
    const empty = await request(port, "/empty", { headers: { Host: "127.0.0.1" } });
    assert.equal(empty.status, 200);
    assert.equal(readZipEntries(empty.body).size, 0);
    assert.match(empty.headers["content-disposition"], /filename="empty\.zip"/);

    const missing = await request(port, "/missing", { headers: { Host: "127.0.0.1" } });
    assert.equal(missing.status, 404);

    const streamError = await request(port, "/stream-error", { headers: { Host: "127.0.0.1" } });
    assert.equal(streamError.status, 500);
    assert.doesNotMatch(streamError.body.toString("utf8"), /synthetic-stream-error/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-zip-downloads-"));
  const dataDir = path.join(tempRoot, "data");
  const owner = "zip-client";
  const password = "ZipSyntheticPassword!2026";
  const documentId = "zip-material";
  const carouselId = "zip-carousel";
  const planningId = "zip-planning";
  const planningArtId = "zip-planning-art";
  const botOrderId = "zip-bot-order";
  const userOrderId = "zip-user-order";

  writeJson(path.join(dataDir, "clientes.json"), {
    [owner]: {
      nome_time: "Empresa ZIP Sintetica",
      senha_hash: bcrypt.hashSync(password, 8),
      plano: 0,
      saldo_mensal: 0,
      saldo_extra: 100,
      usados_no_ciclo: 0,
      ciclo_mes: "202607",
      conta_finalizada: true,
      ativo: true
    }
  });

  writeZipFixture(
    path.join(dataDir, "materiais_graficos", owner, "202607", documentId),
    "document_id",
    documentId,
    "material-marker"
  );
  writeZipFixture(
    path.join(dataDir, "carrosseis", owner, "202607", carouselId),
    "carrossel_id",
    carouselId,
    "carousel-marker"
  );
  writeZipFixture(
    path.join(dataDir, "planejamentos_mensais", owner, "202607", planningId),
    "planejamento_id",
    planningId,
    "planning-marker"
  );
  writeOrderFixture(dataDir, owner, planningArtId, "planning-art-marker", true);
  writeOrderFixture(dataDir, owner, botOrderId, "bot-order-marker");
  writeOrderFixture(dataDir, owner, userOrderId, "user-order-marker");

  const port = await getFreePort();
  const instance = spawnServer(port, dataDir);

  try {
    await waitForServer(instance);
    const login = await request(port, "/auth/login", {
      method: "POST",
      body: { whatsapp: owner, senha: password }
    });
    assert.equal(login.status, 200);
    const userToken = JSON.parse(login.body.toString("utf8")).token;
    assert.ok(userToken);

    const flows = [
      {
        name: "materiais graficos",
        route: `/bot/empresa/materiais-graficos/${documentId}/zip`,
        token: botToken,
        filename: `${documentId}.zip`,
        expected: "nested/material-marker.txt"
      },
      {
        name: "carrosseis",
        route: `/bot/empresa/carrosseis/${carouselId}/zip`,
        token: botToken,
        filename: `${carouselId}.zip`,
        expected: "nested/carousel-marker.txt"
      },
      {
        name: "planejamento mensal",
        route: `/bot/empresa/planejamento-mensal/${planningId}/zip`,
        token: botToken,
        filename: `${planningId}.zip`,
        expected: "nested/planning-marker.txt"
      },
      {
        name: "arte do planejamento",
        route: `/bot/empresa/planejamento-mensal/artes/${planningArtId}/zip`,
        token: botToken,
        filename: `${planningArtId}.zip`,
        expected: "nested/planning-art-marker.txt"
      },
      {
        name: "pedido do runner",
        route: `/bot/pedidos/${botOrderId}/zip`,
        token: botToken,
        filename: `${botOrderId}.zip`,
        expected: "nested/bot-order-marker.txt"
      },
      {
        name: "pedido do cliente",
        route: `/pedidos/${userOrderId}/zip`,
        token: userToken,
        filename: `${userOrderId}.zip`,
        expected: "nested/user-order-marker.txt"
      }
    ];

    for (const flow of flows) {
      const unauthorized = await request(port, flow.route);
      assert.equal(unauthorized.status, 401, `${flow.name}: autenticacao`);

      const response = await request(port, flow.route, { token: flow.token });
      assert.equal(response.status, 200, `${flow.name}: status`);
      assert.match(response.headers["content-type"], /^application\/zip/, `${flow.name}: content-type`);
      assert.equal(
        response.headers["content-disposition"],
        `attachment; filename="${flow.filename}"`,
        `${flow.name}: filename`
      );
      const entries = readZipEntries(response.body);
      assert.ok(entries.has(flow.expected), `${flow.name}: arquivo esperado`);
      assert.equal(
        entries.get(flow.expected).toString("utf8"),
        `conteudo-${path.basename(flow.expected, ".txt")}`,
        `${flow.name}: conteudo`
      );
    }

    const missingBot = await request(port, "/bot/pedidos/inexistente/zip", { token: botToken });
    assert.equal(missingBot.status, 404);
    const missingUser = await request(port, "/pedidos/inexistente/zip", { token: userToken });
    assert.equal(missingUser.status, 404);

    const serverSource = fs.readFileSync(serverFile, "utf8");
    const zipSource = fs.readFileSync(path.join(repoDir, "src", "zip", "zip-stream.js"), "utf8");
    assert.doesNotMatch(serverSource, /archive\s*\.\s*glob\s*\(/);
    assert.doesNotMatch(zipSource, /\.glob\s*\(/);
    assert.match(zipSource, /archive\.directory\(directory, false\)/);

    await testHelperEdgeCases(tempRoot);

    assert.doesNotMatch(instance.output(), new RegExp(botToken));
    assert.doesNotMatch(instance.output(), new RegExp(userToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    process.stdout.write("Archiver 8 six ZIP flow tests: OK\n");
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
