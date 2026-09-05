"use strict";

const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");

const OPENSSL_CANDIDATES = Object.freeze([
  "openssl",
  "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
  "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe"
]);
const BUNDLED_PYTHON = path.join(
  os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime",
  "dependencies", "python", process.platform === "win32" ? "python.exe" : "bin/python3"
);
const HANDSHAKE_TIMEOUT_MS = 5000;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function findOpenSsl() {
  for (const candidate of OPENSSL_CANDIDATES) {
    const probe = spawnSync(candidate, ["version"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true
    });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function createPythonCertificateFixture(correctHostname, wrongHostname) {
  // Offline test-only fallback for the existing bundled cryptography runtime.
  // This generates ephemeral fixture material; it changes no OS trust store,
  // production TLS option or Node handshake/assertion. No package is installed.
  if (!fs.existsSync(BUNDLED_PYTHON)) {
    fail("synthetic_tls_fixture_generator_unavailable");
  }
  const result = spawnSync(BUNDLED_PYTHON, [
    "-I", path.join(__dirname, "create-local-tls-fixture.py"),
    correctHostname, wrongHostname
  ], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 15000,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    fail("synthetic_tls_certificate_generation_failed");
  }
  try {
    const fixture = JSON.parse(result.stdout);
    for (const name of ["trustedCa", "wrongCa"]) {
      if (typeof fixture[name] !== "string") throw new Error("invalid");
      new crypto.X509Certificate(fixture[name]);
    }
    for (const name of ["correctLeaf", "wrongHostnameLeaf", "missingSanLeaf"]) {
      const leaf = fixture[name];
      if (typeof leaf?.certificate !== "string" || typeof leaf.key !== "string") {
        throw new Error("invalid");
      }
      const certificate = new crypto.X509Certificate(leaf.certificate);
      if (!certificate.checkPrivateKey(crypto.createPrivateKey(leaf.key))) {
        throw new Error("invalid");
      }
      Object.freeze(leaf);
    }
    return Object.freeze({
      ...fixture,
      tamperedLeaf: Object.freeze({
        certificate: tamperCertificateSignature(fixture.correctLeaf.certificate),
        key: fixture.correctLeaf.key
      })
    });
  } catch {
    fail("synthetic_tls_certificate_generation_failed");
  }
}

function runOpenSsl(binary, cwd, args) {
  const result = spawnSync(binary, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 15000,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    fail("synthetic_tls_certificate_generation_failed");
  }
}

function writeAscii(file, value) {
  fs.writeFileSync(file, value, {
    encoding: "ascii",
    mode: 0o600,
    flag: "wx"
  });
}

function createCa(binary, directory, label) {
  const key = `${label}-ca.key`;
  const certificate = `${label}-ca.pem`;
  runOpenSsl(binary, directory, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-subj",
    `/CN=IA4Tube-Synthetic-CA-${label}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout",
    key,
    "-out",
    certificate
  ]);
  return Object.freeze({
    certificate: fs.readFileSync(path.join(directory, certificate), "ascii"),
    certificateFile: certificate,
    keyFile: key
  });
}

function createLeaf(
  binary,
  directory,
  ca,
  label,
  hostname,
  includeSubjectAltName = true
) {
  const key = `${label}-leaf.key`;
  const request = `${label}-leaf.csr`;
  const certificate = `${label}-leaf.pem`;
  const extensions = `${label}-leaf.ext`;
  const extensionLines = [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth"
  ];
  if (includeSubjectAltName) {
    extensionLines.push(`subjectAltName=DNS:${hostname}`);
  }
  extensionLines.push("");
  writeAscii(
    path.join(directory, extensions),
    extensionLines.join("\n")
  );
  runOpenSsl(binary, directory, [
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-subj",
    `/CN=${hostname}`,
    "-keyout",
    key,
    "-out",
    request
  ]);
  runOpenSsl(binary, directory, [
    "x509",
    "-req",
    "-in",
    request,
    "-CA",
    ca.certificateFile,
    "-CAkey",
    ca.keyFile,
    "-CAcreateserial",
    "-days",
    "1",
    "-sha256",
    "-extfile",
    extensions,
    "-out",
    certificate
  ]);
  return Object.freeze({
    certificate: fs.readFileSync(path.join(directory, certificate), "ascii"),
    key: fs.readFileSync(path.join(directory, key), "ascii")
  });
}

function pemFromDer(der) {
  const encoded = der.toString("base64");
  return [
    "-----BEGIN CERTIFICATE-----",
    ...(encoded.match(/.{1,64}/g) || []),
    "-----END CERTIFICATE-----"
  ].join("\n");
}

function tamperCertificateSignature(pem) {
  const certificate = new crypto.X509Certificate(pem);
  const der = Buffer.from(certificate.raw);
  der[der.length - 1] ^= 0x01;
  const tampered = pemFromDer(der);
  der.fill(0);
  return tampered;
}

function createLocalTlsFixture(context, correctHostname, wrongHostname) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-local-tls-")
  );
  fs.chmodSync(directory, 0o700);
  context.after(() => {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("ia4tube-local-tls-")
    ) {
      fail("synthetic_tls_cleanup_path_invalid");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const binary = findOpenSsl();
  if (!binary) {
    return createPythonCertificateFixture(correctHostname, wrongHostname);
  }
  const trustedCa = createCa(binary, directory, "trusted");
  const wrongCa = createCa(binary, directory, "wrong");
  const correctLeaf = createLeaf(
    binary,
    directory,
    trustedCa,
    "correct",
    correctHostname
  );
  const wrongHostnameLeaf = createLeaf(
    binary,
    directory,
    trustedCa,
    "wrong-host",
    wrongHostname
  );
  const missingSanLeaf = createLeaf(
    binary,
    directory,
    trustedCa,
    "missing-san",
    correctHostname,
    false
  );
  return Object.freeze({
    correctLeaf,
    missingSanLeaf,
    trustedCa: trustedCa.certificate,
    wrongCa: wrongCa.certificate,
    wrongHostnameLeaf,
    tamperedLeaf: Object.freeze({
      certificate: tamperCertificateSignature(correctLeaf.certificate),
      key: correctLeaf.key
    })
  });
}

function attemptLocalTlsHandshake(serverMaterial, clientOptions) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let client;
    const server = tls.createServer(
      {
        cert: serverMaterial.certificate,
        key: serverMaterial.key,
        minVersion: "TLSv1.2"
      },
      (socket) => {
        socket.end();
      }
    );
    const timer = setTimeout(() => {
      finish({ errorCode: "synthetic_tls_handshake_timeout" });
    }, HANDSHAKE_TIMEOUT_MS);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (client && !client.destroyed) client.destroy();
      server.close((error) => {
        if (error) {
          reject(
            Object.assign(new Error("synthetic_tls_server_close_failed"), {
              code: "synthetic_tls_server_close_failed"
            })
          );
          return;
        }
        resolve(Object.freeze(result));
      });
    }

    server.on("tlsClientError", () => {});
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(
        Object.assign(new Error("synthetic_tls_server_failed"), {
          cause: error,
          code: "synthetic_tls_server_failed"
        })
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        finish({ errorCode: "synthetic_tls_server_address_invalid" });
        return;
      }
      client = tls.connect({
        host: "127.0.0.1",
        port: address.port,
        ...clientOptions
      });
      client.once("secureConnect", () => {
        finish({
          authorizationError: client.authorizationError || null,
          authorized: client.authorized === true,
          errorCode: null
        });
      });
      client.once("error", (error) => {
        finish({
          authorized: false,
          errorCode: String(error?.code || "tls_handshake_refused")
        });
      });
    });
  });
}

module.exports = {
  attemptLocalTlsHandshake,
  createLocalTlsFixture
};
