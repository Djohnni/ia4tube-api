"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const express = require("express");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const gate = require("../scripts/social-3b0-linux-physical-gate");
const historicGate = require("../scripts/social-3a0p-linux-gate");
const {
  PROCESS_LIFECYCLE_TEST_FILES
} = require("../scripts/run-node-tests");
const {
  INSTAGRAM_OAUTH_REDIRECT_URI,
  loadInstagramOAuthConfig
} = require("../src/social/oauth/instagram-config");
const {
  contextFromRow,
  envelopeFromRow
} = require("../src/social/credential-service");
const { createSocialVault } = require("../src/social/vault");
const {
  deriveVaultKeyVersion,
  vaultKeyringFingerprint
} = require("../src/social/vault-key-version");

const SHA = "a".repeat(40);
const O12_COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const O12_CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
const O12_CONNECTION_ID = "33333333-3333-4333-8333-333333333333";
const O12_CREDENTIAL_TYPE = "instagram_user_access_token";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function clonePendingCredentialRow(row, overrides = {}) {
  return {
    ...row,
    ciphertext: Buffer.from(row.ciphertext),
    nonce: Buffer.from(row.nonce),
    auth_tag: Buffer.from(row.auth_tag),
    ...overrides
  };
}

function assertPendingCredentialBuffersCleared(rows) {
  for (const row of rows || []) {
    for (const field of ["ciphertext", "nonce", "auth_tag"]) {
      if (!Buffer.isBuffer(row?.[field])) continue;
      assert.equal(row[field].every((byte) => byte === 0), true, field);
    }
  }
}

function createPendingCredentialFixture({ encryptionContext = {} } = {}) {
  const keyMaterial = crypto.randomBytes(32);
  const keyVersion = deriveVaultKeyVersion(1, keyMaterial);
  const keyringMaterial = Buffer.from(keyMaterial);
  const keyring = {
    activeVersion: keyVersion,
    keys: new Map([[keyVersion, keyringMaterial]])
  };
  const rawVault = createSocialVault({
    keyring,
    expectedKeyringFingerprint: vaultKeyringFingerprint(keyVersion, [keyVersion])
  });
  keyringMaterial.fill(0);
  keyring.keys.clear();
  keyMaterial.fill(0);

  const syntheticMaterial = crypto.randomBytes(32);
  const marker = Buffer.from(syntheticMaterial.toString("base64url"), "utf8");
  const expected = {
    companyId: O12_COMPANY_ID,
    credentialId: O12_CREDENTIAL_ID,
    connectionId: O12_CONNECTION_ID,
    provider: "instagram",
    credentialType: O12_CREDENTIAL_TYPE
  };
  const context = {
    companyId: expected.companyId,
    provider: expected.provider,
    credentialId: expected.credentialId,
    credentialType: expected.credentialType,
    subjectType: "connection",
    subjectId: expected.connectionId,
    ...encryptionContext
  };
  const envelope = rawVault.encrypt(marker, context);
  const expectedDigest = sha256(marker);
  marker.fill(0);
  const row = {
    company_id: expected.companyId,
    id: expected.credentialId,
    provider: expected.provider,
    connection_id: expected.connectionId,
    oauth_transaction_id: null,
    credential_type: expected.credentialType,
    ciphertext: envelope.ciphertext,
    nonce: envelope.nonce,
    auth_tag: envelope.authTag,
    key_version: envelope.keyVersion,
    aad_version: envelope.aadVersion,
    expires_at: null,
    revoked_at: null
  };
  const decryptedPlaintexts = [];
  let vaultDecryptCalls = 0;
  const vault = Object.freeze({
    ...rawVault,
    decrypt(...args) {
      vaultDecryptCalls += 1;
      const plaintext = rawVault.decrypt(...args);
      decryptedPlaintexts.push(plaintext);
      return plaintext;
    }
  });
  let operationalReads = 0;
  let operationalCallbackCalls = 0;
  const credentials = Object.freeze({
    async withDecryptedCredential(_identity, _operation) {
      operationalReads += 1;
      const error = new Error("pending credential unavailable");
      error.code = "credential_not_found";
      throw error;
    }
  });
  const evidenceCounts = { ...gate.zeroCounts() };
  const options = (overrides = {}) => ({
    result: { rows: [row] },
    expected,
    syntheticMaterial,
    expectedDigest,
    credentials,
    vault,
    contextFromRow,
    envelopeFromRow,
    operationCounts: () => ({
      vaultEncryptCalls: 1,
      vaultDecryptCalls,
      credentialStoreCalls: 1
    }),
    evidenceCounts,
    readBoundary: async () => {
      assert.equal(decryptedPlaintexts.length, 1);
      assert.equal(decryptedPlaintexts[0].every((byte) => byte === 0), true);
      return {
        status: "authorization_pending",
        externalAccounts: 0
      };
    },
    ...overrides
  });
  return {
    credentials,
    decryptedPlaintexts,
    evidenceCounts,
    expected,
    expectedDigest,
    options,
    rawVault,
    row,
    syntheticMaterial,
    get operationalCallbackCalls() { return operationalCallbackCalls; },
    get operationalReads() { return operationalReads; },
    get vaultDecryptCalls() { return vaultDecryptCalls; },
    recordOperationalCallback() { operationalCallbackCalls += 1; },
    destroy() {
      rawVault.destroy();
      syntheticMaterial.fill(0);
      for (const plaintext of decryptedPlaintexts) plaintext.fill(0);
      for (const field of ["ciphertext", "nonce", "auth_tag"]) {
        if (Buffer.isBuffer(row[field])) row[field].fill(0);
      }
    }
  };
}

function environment(overrides = {}) {
  return Object.freeze({
    RUNNER_TEMP: overrides.RUNNER_TEMP,
    GITHUB_RUN_ID: overrides.GITHUB_RUN_ID || "73190",
    SOCIAL_3B0_BRANCH: gate.BRANCH,
    SOCIAL_3B0_SHA: SHA,
    SOCIAL_3B0_RUN_ATTEMPT: "1",
    SOCIAL_3B0_WINDOWS_STATUS: "passed",
    SOCIAL_3B0_PRE_GATE_STATUS: "passed",
    SOCIAL_3B0_POSTGRES_IMAGE: gate.IMAGE,
    POSTGRES_CONNECTIVITY_MODE: "internal_bridge_direct_v1",
    POSTGRES_BACKUP_CONNECTIVITY_MODE:
      "logical_dns_to_internal_container_v1",
    SOCIAL_3A0P_POSTGRES_IMAGE: gate.IMAGE,
    SOCIAL_INSTAGRAM_ENABLED: "false",
    SOCIAL_EXTERNAL_CONNECTION_ENABLED: "false",
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false"
  });
}

function passedEvidence() {
  const evidence = gate.baseEvidence({
    branch: gate.BRANCH,
    sha: SHA,
    runAttempt: 1
  });
  evidence.gates1To5 = Object.freeze(gate.GATE_DEFINITIONS.map((entry) =>
    Object.freeze({ ...entry, status: "passed" })
  ));
  evidence.substeps = Object.freeze(gate.SUBSTEP_IDS.map((id) =>
    Object.freeze({ id, status: "passed" })
  ));
  evidence.counts = gate.EXPECTED_COUNTS;
  evidence.secretScan = Object.freeze({
    status: "passed",
    historicPhysicalPassed: true,
    oauthEvidencePassed: true
  });
  evidence.cleanup = Object.freeze({
    cleanupCompleted: true,
    intermediateEvidenceRemoved: true,
    syntheticMaterialsCleared: true
  });
  evidence.residuals = gate.zeroResiduals();
  evidence.status = "passed";
  return evidence;
}

function cleanupSnapshot(tracker, overrides = {}) {
  return tracker.snapshot({
    postgresCleanupCompleted: true,
    firstAttemptSyntheticMaterialsCleared: true,
    firstAttemptResiduals: gate.zeroResiduals(),
    ...overrides
  });
}

function cleanupProvenance(overrides = {}) {
  return Object.freeze({
    operation: "http_server_close",
    causalCode: "social_3b0_cleanup_operation_failed",
    cleanupErrorCount: 1,
    postgresCleanupCompleted: true,
    firstAttemptSyntheticMaterialsCleared: true,
    firstAttemptResiduals: gate.zeroResiduals(),
    ...overrides
  });
}

function failedO22Evidence(overrides = {}) {
  const evidence = passedEvidence();
  const provenance = overrides.cleanupFailureProvenance || cleanupProvenance();
  evidence.status = "failed";
  evidence.firstFailure = gate.closedFirstFailure({
    phase: gate.PHASE,
    substep: "O22",
    lastCompletedSubstep: "O21",
    causalCode: provenance.causalCode
  });
  evidence.cleanupFailureProvenance = provenance;
  evidence.substeps = Object.freeze(evidence.substeps.map((entry) =>
    Object.freeze(entry.id === "O22" ? { ...entry, status: "failed" } : entry)
  ));
  if (overrides.cleanup) evidence.cleanup = Object.freeze(overrides.cleanup);
  if (overrides.residuals) evidence.residuals = Object.freeze(overrides.residuals);
  return evidence;
}

async function supervisedEvidenceFixture({
  workerEvidence,
  exitCode = 1,
  cleanupResult = zeroCleanup(),
  runId = "73200"
}) {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "social-3b0-provenance-"));
  const directory = path.join(runnerTemp, gate.ARTIFACT_DIRECTORY);
  const outputPath = path.join(directory, gate.EVIDENCE_FILE);
  const processStatusPath = path.join(directory, gate.PROCESS_STATUS_FILE);
  const spawnImpl = (_executable, _args, options) => {
    const child = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      try {
        if (workerEvidence !== undefined) {
          gate.writePayload(
            path.join(options.env.RUNNER_TEMP, gate.ARTIFACT_DIRECTORY,
              gate.EVIDENCE_FILE),
            path.join(options.env.RUNNER_TEMP, gate.ARTIFACT_DIRECTORY,
              gate.EVIDENCE_HASH_FILE),
            workerEvidence
          );
        }
        child.emit("spawn");
        child.emit("close", exitCode, null);
      } catch (error) {
        child.emit("error", error);
      }
    });
    return child;
  };
  try {
    const result = await gate.superviseInstagramOAuthPhysicalGate({
      runnerTemp,
      outputPath,
      processStatusPath,
      repositoryRoot: path.join(__dirname, ".."),
      environment: environment({ RUNNER_TEMP: runnerTemp, GITHUB_RUN_ID: runId }),
      spawnImpl,
      cleanupImpl: async () => cleanupResult,
      timeoutMs: 1000
    });
    const serialized = fs.readFileSync(outputPath, "utf8");
    return Object.freeze({ result, evidence: JSON.parse(serialized), serialized });
  } finally {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
}

function zeroCleanup() {
  return Object.freeze({
    cleanupCompleted: true,
    artifactDirectoryRemoved: true,
    intermediateEvidenceRemoved: true,
    residuals: gate.zeroResiduals()
  });
}

function fakeChild({ exitCode = 1, emitSpawn = true } = {}) {
  return function spawnImpl() {
    const child = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      if (emitSpawn) child.emit("spawn");
      child.emit(emitSpawn ? "close" : "error", emitSpawn ? exitCode : null, null);
    });
    return child;
  };
}

function controlledHttpTransport({ destroyEmitsClose = true } = {}) {
  const request = new EventEmitter();
  let responseCallback;
  let endCallback;
  let payload = null;
  let endCalls = 0;
  const requestImpl = (options, onResponse) => {
    responseCallback = onResponse;
    request.options = options;
    request.end = (candidate, encoding, callback) => {
      endCalls += 1;
      if (Buffer.isBuffer(candidate)) payload = candidate;
      endCallback = typeof callback === "function"
        ? callback
        : typeof encoding === "function"
          ? encoding
          : typeof candidate === "function"
            ? candidate
            : null;
      return request;
    };
    return request;
  };
  const startResponse = (statusCode = 200) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;
    response.destroyCalls = 0;
    response.resumeCalls = 0;
    response.resume = () => {
      response.resumeCalls += 1;
      return response;
    };
    response.destroy = () => {
      response.destroyCalls += 1;
      if (destroyEmitsClose) response.emit("close");
    };
    responseCallback(response);
    return response;
  };
  const respond = (serialized, statusCode = 200) => {
    const response = startResponse(statusCode);
    if (serialized !== null) response.emit("data", Buffer.from(serialized));
    response.emit("end");
    response.emit("close");
    return response;
  };
  return {
    request,
    requestImpl,
    respond,
    startResponse,
    get endCallback() { return endCallback; },
    get endCalls() { return endCalls; },
    get payload() { return payload; }
  };
}

async function closeLoopbackServer(server, sockets) {
  const socketClosures = [...sockets].map((socket) => new Promise((resolve) => {
    socket.once("close", resolve);
  }));
  for (const socket of sockets) socket.destroy();
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  const serverClosure = new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await Promise.all([serverClosure, ...socketClosures]);
}

test("Social 3B physical gate freezes the Exact9 native-process serialization route", () => {
  assert.equal(
    gate.BRANCH,
    "social/checkpoint-3b0-windows-native-process-serialization-20260813"
  );
  assert.equal(
    gate.COMMIT_MESSAGE,
    "[run-social-3b0] serialize native Windows process tests"
  );
  assert.equal(
    gate.PARENT_COMMIT,
    "1eae6c50003c523ad80a473a5554eb9f84770389"
  );
  assert.deepEqual(gate.HISTORIC_COMMIT_CHAIN, [
    {
      level: "functional_parent",
      sha: "3dc3d8be62438216509f061f6c1a26ee39c9b5dc"
    },
    {
      level: "functional",
      sha: "33e3ea7abcea7f5dc51780c3a1efd4743352fe40"
    },
    {
      level: "prior_infrastructure",
      sha: "7bff67ac0c1acdd37473889a3f8b5c2017b30c9c"
    },
    {
      level: "previous_correction",
      sha: "27cd350a253ab3ff07a915570eb41f291bbd1b42"
    },
    {
      level: "o05",
      sha: "ad3c162aaee04bb66d79ea3c35c3d75297e8d0ab"
    },
    {
      level: "o12",
      sha: "1febe1211b0021d8c35cdfb840f581fd76ce39e7"
    },
    { level: "o22", sha: gate.PARENT_COMMIT }
  ]);
  assert.equal(
    gate.HISTORIC_COMMIT_CHAIN.at(-1).sha,
    gate.PARENT_COMMIT
  );
  assert.deepEqual(gate.CORRECTION_FILES, [
    ".github/workflows/social-3b0-instagram-oauth-local-contract.yml",
    "scripts/run-node-tests.js",
    "scripts/social-3a0p-local-scope.js",
    "scripts/social-3b0-linux-physical-gate.js",
    "tests/node-test-runner-safety.test.js",
    "tests/social-3a0p-current-diff-scope.test.js",
    "tests/social-3a0p-local-scope.test.js",
    "tests/social-3b0-linux-physical-gate.test.js",
    "tests/social-3b0-linux-workflow.test.js"
  ]);
  assert.equal(gate.CORRECTION_FILES.length, 9);
  assert.equal(new Set(gate.CORRECTION_FILES).size, 9);
  assert.deepEqual(gate.WINDOWS_NATIVE_SERIAL_TEST_FILES, [
    "social-3a0p-local-safe-zip-extract.test.js",
    "social-postgres-tls.test.js"
  ]);
  assert.equal(PROCESS_LIFECYCLE_TEST_FILES.length, 11);
  assert.equal(new Set(PROCESS_LIFECYCLE_TEST_FILES).size, 11);
  for (const name of gate.WINDOWS_NATIVE_SERIAL_TEST_FILES) {
    assert.equal(
      PROCESS_LIFECYCLE_TEST_FILES.filter((candidate) => candidate === name).length,
      1,
      name
    );
    assert.equal(gate.CORRECTION_FILES.includes(`tests/${name}`), false, name);
  }
  for (const protectedPath of [
    "scripts/social-3a0p-local-safe-zip-extract.ps1",
    "tests/helpers/local-tls-handshake.js"
  ]) assert.equal(gate.CORRECTION_FILES.includes(protectedPath), false);
  assert.equal(Object.isFrozen(gate.HISTORIC_COMMIT_CHAIN), true);
  assert.equal(
    gate.HISTORIC_COMMIT_CHAIN.every((entry) => Object.isFrozen(entry)),
    true
  );
  assert.equal(Object.isFrozen(gate.CORRECTION_FILES), true);
  assert.equal(Object.isFrozen(gate.WINDOWS_NATIVE_SERIAL_TEST_FILES), true);
  assert.equal(gate.PHASE, "instagram_oauth_local_contract");
  assert.equal(
    gate.IMAGE,
    "docker.io/library/postgres:18.4-bookworm@" +
      "sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568"
  );
  assert.equal(gate.WORKER_TIMEOUT_MS, 44 * 60_000);
  assert.equal(gate.HISTORIC_TIMEOUT_MS, 36 * 60_000);
  assert.ok(gate.HISTORIC_TIMEOUT_MS < gate.WORKER_TIMEOUT_MS);
  assert.ok(gate.WORKER_TIMEOUT_MS < 60 * 60_000);
  assert.deepEqual(gate.SUBSTEP_IDS, Array.from(
    { length: 22 },
    (_unused, index) => `O${String(index + 1).padStart(2, "0")}`
  ));
  const o22Evidence = passedEvidence();
  assert.equal(o22Evidence.substeps.at(-1).id, "O22");
  assert.equal(o22Evidence.substeps.at(-1).status, "passed");
  assert.equal(o22Evidence.cleanupFailureProvenance, null);
  assert.equal(gate.evidenceSafe(o22Evidence), true);
});

test("Linux physical gate does not prewarm or alter the ZIP/TLS native environment", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "social-3b0-linux-physical-gate.js"),
    "utf8"
  );
  assert.doesNotMatch(source, /\b(?:prewarm|openssl(?:\.exe)?|powershell(?:\.exe)?)\b/i);
  assert.doesNotMatch(
    source,
    /(?:process\.env|environment|env)\.PATH\s*=/
  );
  const valid = environment({
    RUNNER_TEMP: path.join(os.tmpdir(), "social-3b0-environment-contract")
  });
  assert.equal(
    Object.keys(valid).some((name) =>
      /^(?:PATH|OPENSSL|POWERSHELL|PREWARM)(?:_|$)/i.test(name)
    ),
    false
  );
  assert.deepEqual(gate.validateEnvironment(valid), {
    branch: gate.BRANCH,
    sha: SHA,
    runAttempt: 1
  });
});

test("remote environment requires every external runtime gate to remain exactly false", () => {
  const runnerTemp = path.join(os.tmpdir(), "social-3b0-environment-contract");
  const valid = environment({ RUNNER_TEMP: runnerTemp });
  assert.deepEqual(gate.validateEnvironment(valid), {
    branch: gate.BRANCH,
    sha: SHA,
    runAttempt: 1
  });
  for (const name of [
    "SOCIAL_INSTAGRAM_ENABLED",
    "SOCIAL_EXTERNAL_CONNECTION_ENABLED",
    "SOCIAL_EXTERNAL_PUBLICATION_ENABLED"
  ]) {
    assert.throws(
      () => gate.validateEnvironment({ ...valid, [name]: "true" }),
      (error) => error?.code === "social_3b0_environment_invalid"
    );
    const missing = { ...valid };
    delete missing[name];
    assert.throws(
      () => gate.validateEnvironment(missing),
      (error) => error?.code === "social_3b0_environment_invalid"
    );
  }
});

test("httpJsonRequest preserves the JSON payload through real loopback parser and Bearer boundaries", async () => {
  const originalRequest = http.request;
  const expectedBody = Object.freeze({ purpose: "connect" });
  const expectedSerialized = JSON.stringify(expectedBody);
  const validAuthorization = ["Bearer", "fixture-valid"].join(" ");
  const invalidAuthorization = ["Bearer", "fixture-invalid"].join(" ");
  const rawBodies = [];
  const parsedBodies = [];
  const sockets = new Set();
  let authenticationCalls = 0;
  let handlerCalls = 0;
  let parserFailures = 0;
  let delayedRequests = 0;
  const app = express();
  app.use(express.json({
    verify(_request, _response, buffer) {
      rawBodies.push(Buffer.from(buffer));
    }
  }));
  app.post(
    "/v1/social/connections/instagram/authorization",
    (request, response, next) => {
      authenticationCalls += 1;
      parsedBodies.push(request.body);
      if (request.headers.authorization !== validAuthorization) {
        response.status(401).json({ code: "synthetic_unauthorized" });
        return;
      }
      next();
    },
    (request, response) => {
      handlerCalls += 1;
      response.status(201).json({
        status: "authorization_pending",
        purpose: request.body.purpose
      });
    }
  );
  app.use((_error, _request, response, _next) => {
    parserFailures += 1;
    response.status(400).json({ code: "synthetic_parser_refusal" });
  });
  const server = http.createServer(app);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.equal(address.address, "127.0.0.1");

  http.request = (options, onResponse) => {
    const actual = originalRequest(options, onResponse);
    const originalWrite = actual.write.bind(actual);
    const originalEnd = actual.end.bind(actual);
    let retainedPayload = null;
    delayedRequests += 1;
    actual.write = (candidate) => {
      retainedPayload = candidate;
      return true;
    };
    actual.end = (candidate, encoding, callback) => {
      if (Buffer.isBuffer(candidate)) retainedPayload = candidate;
      const completion = typeof callback === "function"
        ? callback
        : typeof encoding === "function"
          ? encoding
          : typeof candidate === "function"
            ? candidate
            : undefined;
      setImmediate(() => {
        actual.write = originalWrite;
        actual.end = originalEnd;
        if (retainedPayload) originalEnd(retainedPayload, completion);
        else originalEnd(completion);
      });
      return actual;
    };
    return actual;
  };

  try {
    const missing = await gate.httpJsonRequest({
      port: address.port,
      method: "POST",
      route: "/v1/social/connections/instagram/authorization",
      body: expectedBody
    });
    const invalid = await gate.httpJsonRequest({
      port: address.port,
      method: "POST",
      route: "/v1/social/connections/instagram/authorization",
      headers: { authorization: invalidAuthorization },
      body: expectedBody
    });
    const valid = await gate.httpJsonRequest({
      port: address.port,
      method: "POST",
      route: "/v1/social/connections/instagram/authorization",
      headers: { authorization: validAuthorization },
      body: expectedBody
    });

    assert.equal(missing.status, 401);
    assert.equal(invalid.status, 401);
    assert.deepEqual(valid, {
      status: 201,
      value: { status: "authorization_pending", purpose: "connect" }
    });
    assert.equal(delayedRequests, 3);
    assert.equal(authenticationCalls, 3);
    assert.equal(handlerCalls, 1);
    assert.equal(parserFailures, 0);
    assert.equal(rawBodies.length, 3);
    assert.equal(rawBodies.every((buffer) => buffer.toString("utf8") === expectedSerialized), true);
    assert.equal(rawBodies.every((buffer) => !buffer.includes(0)), true);
    assert.deepEqual(parsedBodies, [expectedBody, expectedBody, expectedBody]);
  } finally {
    http.request = originalRequest;
    for (const buffer of rawBodies) buffer.fill(0);
    await closeLoopbackServer(server, sockets);
  }
  assert.equal(server.listening, false);
  assert.equal(sockets.size, 0);
  assert.equal(http.request, originalRequest);
});

test("httpJsonRequest retains one payload until finish and accepts a response started after finish", async () => {
  const control = controlledHttpTransport();
  const resultPromise = gate.httpJsonRequest({
    port: 7443,
    method: "POST",
    route: "/v1/social/test",
    body: { purpose: "connect" },
    requestImpl: control.requestImpl
  });
  const retained = control.payload;
  assert.ok(Buffer.isBuffer(retained));
  assert.equal(retained.toString("utf8"), JSON.stringify({ purpose: "connect" }));
  assert.equal(control.endCalls, 1);
  let wipeCalls = 0;
  const originalFill = retained.fill.bind(retained);
  retained.fill = (...args) => {
    wipeCalls += 1;
    return originalFill(...args);
  };

  control.request.emit("finish");
  assert.equal(retained.every((byte) => byte === 0), true);
  assert.equal(wipeCalls, 1);
  control.endCallback?.();
  const response = control.startResponse(200);
  control.request.emit("close");
  assert.equal(wipeCalls, 1);
  response.emit("data", Buffer.from('{"ok":true}'));
  response.emit("end");
  response.emit("close");
  assert.deepEqual(await resultPromise, { status: 200, value: { ok: true } });
  assert.equal(wipeCalls, 1);
  assert.deepEqual(control.request.eventNames(), []);
  assert.deepEqual(response.eventNames(), []);
});

test("httpJsonRequest rejects finish-close-before-response once and destroys a late response", async () => {
  const control = controlledHttpTransport();
  let responseChunkFactoryCalls = 0;
  const resultPromise = gate.httpJsonRequest({
    port: 7443,
    method: "POST",
    route: "/v1/social/test",
    body: { purpose: "connect" },
    requestImpl: control.requestImpl,
    responseChunkFactory(chunk) {
      responseChunkFactoryCalls += 1;
      return Buffer.from(chunk);
    }
  });
  const retained = control.payload;
  let wipeCalls = 0;
  let resolveCalls = 0;
  let rejectCalls = 0;
  const originalFill = retained.fill.bind(retained);
  retained.fill = (...args) => {
    wipeCalls += 1;
    return originalFill(...args);
  };
  const observed = resultPromise.then(
    (value) => {
      resolveCalls += 1;
      return value;
    },
    (error) => {
      rejectCalls += 1;
      throw error;
    }
  );

  control.request.emit("finish");
  control.endCallback?.();
  control.request.emit("close");
  await assert.rejects(
    observed,
    (error) => error?.code === "social_3b0_loopback_request_closed"
  );
  assert.equal(retained.every((byte) => byte === 0), true);
  assert.equal(wipeCalls, 1);
  assert.equal(resolveCalls, 0);
  assert.equal(rejectCalls, 1);
  assert.deepEqual(control.request.eventNames(), []);

  const lateResponse = control.startResponse(200);
  lateResponse.emit("data", Buffer.from('{"late":true}'));
  lateResponse.emit("end");
  assert.equal(lateResponse.resumeCalls, 1);
  assert.equal(lateResponse.destroyCalls, 1);
  assert.equal(responseChunkFactoryCalls, 0);
  assert.equal(resolveCalls, 0);
  assert.equal(rejectCalls, 1);
  assert.equal(wipeCalls, 1);
  assert.deepEqual(lateResponse.eventNames(), []);
});

test("httpJsonRequest rejects a real loopback peer close before response without residual resources", async () => {
  const sockets = new Set();
  let responseCallbacks = 0;
  let dnsCalls = 0;
  let bodyExact = false;
  let bodyContainsNull = true;
  const server = http.createServer((request) => {
    const chunks = [];
    let total = 0;
    request.on("data", (chunk) => {
      const copy = Buffer.from(chunk);
      chunks.push(copy);
      total += copy.length;
    });
    request.once("end", () => {
      const serialized = Buffer.concat(chunks, total);
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      bodyExact = serialized.toString("utf8") === JSON.stringify({ purpose: "connect" });
      bodyContainsNull = serialized.includes(0);
      serialized.fill(0);
      request.socket.destroy();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.equal(address.address, "127.0.0.1");

  try {
    const requestImpl = (options, onResponse) => {
      assert.equal(options.host, "127.0.0.1");
      return http.request({
        ...options,
        agent: false,
        lookup(hostname, _options, callback) {
          dnsCalls += 1;
          callback(new Error(`unexpected lookup for ${hostname}`));
        }
      }, (response) => {
        responseCallbacks += 1;
        onResponse(response);
      });
    };
    await assert.rejects(
      gate.httpJsonRequest({
        port: address.port,
        method: "POST",
        route: "/v1/social/test",
        body: { purpose: "connect" },
        requestImpl
      }),
      (error) => error?.code === "social_3b0_loopback_request_closed"
    );
    assert.equal(bodyExact, true);
    assert.equal(bodyContainsNull, false);
    assert.equal(responseCallbacks, 0);
    assert.equal(dnsCalls, 0);
  } finally {
    await closeLoopbackServer(server, sockets);
  }
  assert.equal(server.listening, false);
  assert.equal(sockets.size, 0);
});

test("httpJsonRequest wipes on error or premature close and settles each failure once", async (context) => {
  for (const scenario of ["error", "close"]) {
    await context.test(scenario, async () => {
      const control = controlledHttpTransport();
      const resultPromise = gate.httpJsonRequest({
        port: 7443,
        method: "POST",
        route: "/v1/social/test",
        body: { purpose: "connect" },
        requestImpl: control.requestImpl
      });
      const retained = control.payload;
      let wipeCalls = 0;
      let rejectionCalls = 0;
      const originalFill = retained.fill.bind(retained);
      retained.fill = (...args) => {
        wipeCalls += 1;
        return originalFill(...args);
      };
      const observed = resultPromise.catch((error) => {
        rejectionCalls += 1;
        throw error;
      });
      if (scenario === "error") {
        control.request.emit("error", new Error("synthetic transport refusal"));
        control.request.emit("close");
      } else {
        control.request.emit("close");
      }
      await assert.rejects(
        observed,
        (error) => error?.code === (scenario === "error"
          ? "social_3b0_loopback_request_failed"
          : "social_3b0_loopback_request_closed") &&
          !String(error?.message).includes("synthetic transport refusal")
      );
      assert.equal(retained.every((byte) => byte === 0), true);
      assert.equal(wipeCalls, 1);
      assert.equal(rejectionCalls, 1);
    });
  }
});

test("httpJsonRequest absorbs aborted-error-close and drains a response after request failure", async (context) => {
  await context.test("aborted then error then close", async () => {
    const control = controlledHttpTransport({ destroyEmitsClose: false });
    const resultPromise = gate.httpJsonRequest({
      port: 7443,
      method: "GET",
      route: "/v1/social/test",
      requestImpl: control.requestImpl
    });
    control.request.emit("finish");
    control.endCallback?.();
    const response = control.startResponse(200);
    response.emit("data", Buffer.from('{"partial":'));
    response.emit("aborted");
    response.emit("error", new Error("synthetic post-abort detail"));
    response.emit("close");
    await assert.rejects(
      resultPromise,
      (error) => error?.code === "social_3b0_loopback_response_failed" &&
        !String(error?.message).includes("synthetic post-abort detail")
    );
    assert.equal(response.resumeCalls, 1);
    assert.equal(response.destroyCalls, 1);
    assert.deepEqual(response.eventNames(), []);
    assert.deepEqual(control.request.eventNames(), []);
  });

  await context.test("request error after response start", async () => {
    const control = controlledHttpTransport({ destroyEmitsClose: false });
    const resultPromise = gate.httpJsonRequest({
      port: 7443,
      method: "GET",
      route: "/v1/social/test",
      requestImpl: control.requestImpl
    });
    control.request.emit("finish");
    control.endCallback?.();
    const response = control.startResponse(200);
    response.emit("data", Buffer.from('{"partial":'));
    control.request.emit("error", new Error("synthetic request detail"));
    response.emit("error", new Error("synthetic drained detail"));
    response.emit("close");
    await assert.rejects(
      resultPromise,
      (error) => error?.code === "social_3b0_loopback_request_failed" &&
        !String(error?.message).includes("synthetic request detail")
    );
    assert.equal(response.resumeCalls, 1);
    assert.equal(response.destroyCalls, 1);
    assert.deepEqual(response.eventNames(), []);
    assert.deepEqual(control.request.eventNames(), []);
  });
});

test("httpJsonRequest preserves null bodies, JSON parsing, response limits and loopback pinning", async (context) => {
  await context.test("null and invalid JSON responses", async () => {
    const control = controlledHttpTransport();
    const resultPromise = gate.httpJsonRequest({
      port: 7443,
      method: "GET",
      route: "/v1/social/test",
      requestImpl: control.requestImpl
    });
    assert.equal(control.payload, null);
    assert.equal(control.request.options.host, "127.0.0.1");
    control.request.emit("finish");
    control.endCallback?.();
    control.respond("not-json", 202);
    assert.deepEqual(await resultPromise, { status: 202, value: null });
  });

  await context.test("oversized response", async () => {
    const control = controlledHttpTransport();
    const resultPromise = gate.httpJsonRequest({
      port: 7443,
      method: "GET",
      route: "/v1/social/test",
      requestImpl: control.requestImpl
    });
    control.request.emit("finish");
    control.endCallback?.();
    const response = control.respond("x".repeat(64 * 1024 + 1), 200);
    await assert.rejects(
      resultPromise,
      (error) => error?.code === "social_3b0_loopback_response_too_large"
    );
    assert.equal(response.destroyCalls, 1);
  });

  await context.test("response chunks and response errors", async () => {
    const control = controlledHttpTransport();
    let observedCopy;
    const resultPromise = gate.httpJsonRequest({
      port: 7443,
      method: "GET",
      route: "/v1/social/test",
      requestImpl: control.requestImpl,
      responseChunkFactory(chunk) {
        observedCopy = Buffer.from(chunk);
        return observedCopy;
      }
    });
    control.request.emit("finish");
    control.endCallback?.();
    control.respond('{"ok":true}', 200);
    assert.deepEqual(await resultPromise, { status: 200, value: { ok: true } });
    assert.ok(Buffer.isBuffer(observedCopy));
    assert.equal(observedCopy.every((byte) => byte === 0), true);

    const failed = controlledHttpTransport();
    const failedPromise = gate.httpJsonRequest({
      port: 7443,
      method: "GET",
      route: "/v1/social/test",
      requestImpl: failed.requestImpl
    });
    failed.request.emit("finish");
    failed.endCallback?.();
    const failedResponse = failed.startResponse(200);
    failedResponse.emit("data", Buffer.from('{"partial":'));
    failedResponse.emit("error", new Error("synthetic response detail"));
    failedResponse.emit("close");
    await assert.rejects(
      failedPromise,
      (error) => error?.code === "social_3b0_loopback_response_failed" &&
        !String(error?.message).includes("synthetic response detail")
    );
  });

  let requestCalls = 0;
  assert.throws(
    () => gate.httpJsonRequest({
      port: 7443,
      method: "GET",
      route: "https://example.invalid/v1/social/test",
      requestImpl() { requestCalls += 1; }
    }),
    (error) => error?.code === "social_3b0_loopback_request_invalid"
  );
  assert.equal(requestCalls, 0);
});

test("O05 refusal predicates preserve four exact and non-overlapping causal codes", () => {
  const valid = Object.freeze({
    missingStatus: 401,
    invalidStatus: 401,
    beforeCount: 0,
    afterCount: 0,
    bearerAccepts: 0
  });
  assert.equal(gate.assertAuthorizeRefusalContract(valid), true);
  const scenarios = [
    ["missingStatus", 400, "social_3b0_authorize_missing_bearer_status_invalid"],
    ["invalidStatus", 400, "social_3b0_authorize_invalid_bearer_status_invalid"],
    ["afterCount", 1, "social_3b0_authorize_refusal_persistence_invalid"],
    ["bearerAccepts", 1, "social_3b0_authorize_refusal_acceptance_invalid"]
  ];
  for (const [field, value, code] of scenarios) {
    assert.throws(
      () => gate.assertAuthorizeRefusalContract({ ...valid, [field]: value }),
      (error) => error?.code === code && error?.message === code
    );
    assert.throws(
      () => gate.assertAuthorizeRefusalContract({ ...valid, [field]: value }),
      (error) => !String(error?.code).startsWith(`${code}_`)
    );
  }
});

test("O05 source preserves refusal ordering, request counts and the valid authorize contract", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "social-3b0-linux-physical-gate.js"),
    "utf8"
  );
  const start = source.indexOf('await ledger.run("O05"');
  const end = source.indexOf('await ledger.run("O06"', start);
  const o05 = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.equal((o05.match(/counts\.authorizeRequests \+= 1/g) || []).length, 3);
  assert.match(o05, /assertAuthorizeRefusalContract\(\{/);
  assert.match(o05, /missingStatus: missing\.status/);
  assert.match(o05, /invalidStatus: invalid\.status/);
  assert.match(o05, /beforeCount: Number\(before\.rows/);
  assert.match(o05, /afterCount: Number\(afterRefusal\.rows/);
  assert.match(o05, /bearerAccepts\s*\n\s*\}\);/);
  assert.doesNotMatch(o05, /social_3b0_authorize_bearer_refusal_invalid/);
  assert.match(o05, /response\.status !== 201/);
  assert.match(o05, /response\.value\?\.status !== "authorization_pending"/);
  assert.match(o05, /bearerAccepts !== 1/);
  assert.match(o05, /fail\("social_3b0_authorize_http_invalid"\)/);
  const refusalCheck = o05.indexOf("assertAuthorizeRefusalContract({");
  const validRequest = o05.indexOf("const response = await httpJsonRequest({");
  const requestCounts = [...o05.matchAll(/counts\.authorizeRequests \+= 1/g)]
    .map((match) => match.index);
  assert.equal(requestCounts.filter((index) => index < refusalCheck).length, 2);
  assert.equal(requestCounts.filter((index) => index > validRequest).length, 1);
  assert.ok(refusalCheck < validRequest);
  assert.ok(o05.indexOf("response.status !== 201") < o05.indexOf("primaryState = new URL"));
  assert.doesNotMatch(o05, /startsWith|endsWith|\.includes\(|\bRegExp\b|\|\|\s*\[|catch\s*\(/);
});

test("O12 accepts one encrypted pending credential and proves it with the real vault", async () => {
  const fixture = createPendingCredentialFixture();
  const syntheticToken = fixture.syntheticMaterial.toString("base64url");
  try {
    const result = await gate.verifyPendingCredentialPhysicalProof(
      fixture.options()
    );
    assert.equal(result, true);
    assert.equal(fixture.operationalReads, 1);
    assert.equal(fixture.operationalCallbackCalls, 0);
    assert.equal(fixture.vaultDecryptCalls, 1);
    assert.equal(fixture.evidenceCounts.credentialWrites, 1);
    assert.equal(fixture.evidenceCounts.accountDiscoveryCalls, 0);
    assert.equal(fixture.evidenceCounts.publicationCalls, 0);
    assert.equal(fixture.decryptedPlaintexts.length, 1);
    assert.equal(
      fixture.decryptedPlaintexts[0].every((byte) => byte === 0),
      true
    );
    assertPendingCredentialBuffersCleared([fixture.row]);
    assert.equal(JSON.stringify(result).includes(syntheticToken), false);
  } finally {
    fixture.destroy();
  }
});

test("O12 rejects every malformed physical pending credential row and clears its buffers", async (context) => {
  const alternateCompany = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const alternateCredential = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const alternateConnection = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const alternateTransaction = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const cases = [
    {
      name: "missing row",
      code: "social_3b0_pending_credential_row_invalid",
      rows: () => []
    },
    {
      name: "more than one row",
      code: "social_3b0_pending_credential_row_invalid",
      rows: (fixture) => [
        fixture.row,
        clonePendingCredentialRow(fixture.row)
      ]
    },
    {
      name: "company mismatch",
      code: "social_3b0_pending_credential_row_invalid",
      rows: (fixture) => [{ ...fixture.row, company_id: alternateCompany }]
    },
    {
      name: "credential id mismatch",
      code: "social_3b0_pending_credential_row_invalid",
      rows: (fixture) => [{ ...fixture.row, id: alternateCredential }]
    },
    {
      name: "connection id mismatch",
      code: "social_3b0_pending_credential_row_invalid",
      rows: (fixture) => [{ ...fixture.row, connection_id: alternateConnection }]
    },
    {
      name: "provider mismatch",
      code: "social_3b0_pending_credential_row_invalid",
      rows: (fixture) => [{ ...fixture.row, provider: "facebook" }]
    },
    {
      name: "credential type mismatch",
      code: "social_3b0_pending_credential_row_invalid",
      rows: (fixture) => [{ ...fixture.row, credential_type: "other_token" }]
    },
    {
      name: "oauth transaction is not null",
      code: "social_3b0_pending_credential_row_invalid",
      rows: (fixture) => [{
        ...fixture.row,
        oauth_transaction_id: alternateTransaction
      }]
    },
    {
      name: "revoked timestamp is not null",
      code: "social_3b0_pending_credential_row_invalid",
      rows: (fixture) => [{ ...fixture.row, revoked_at: new Date(0) }]
    },
    {
      name: "empty ciphertext",
      code: "social_3b0_credential_ciphertext_invalid",
      rows: (fixture) => [{ ...fixture.row, ciphertext: Buffer.alloc(0) }]
    },
    {
      name: "nonce is not twelve bytes",
      code: "social_3b0_credential_ciphertext_invalid",
      rows: (fixture) => [{ ...fixture.row, nonce: Buffer.alloc(11, 1) }]
    },
    {
      name: "authentication tag is not sixteen bytes",
      code: "social_3b0_credential_ciphertext_invalid",
      rows: (fixture) => [{ ...fixture.row, auth_tag: Buffer.alloc(15, 1) }]
    },
    {
      name: "AAD version is not one",
      code: "social_3b0_credential_ciphertext_invalid",
      rows: (fixture) => [{ ...fixture.row, aad_version: 2 }]
    },
    {
      name: "ciphertext contains the synthetic plaintext",
      code: "social_3b0_credential_ciphertext_invalid",
      rows: (fixture) => [{
        ...fixture.row,
        ciphertext: Buffer.from(
          fixture.syntheticMaterial.toString("base64url"),
          "utf8"
        )
      }]
    }
  ];
  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const fixture = createPendingCredentialFixture();
      const rows = entry.rows(fixture);
      try {
        await assert.rejects(
          gate.verifyPendingCredentialPhysicalProof(
            fixture.options({ result: { rows } })
          ),
          (error) => error?.code === entry.code
        );
        assert.equal(fixture.operationalReads, 0);
        assert.equal(fixture.vaultDecryptCalls, 0);
        assert.equal(fixture.evidenceCounts.credentialWrites, 0);
        assertPendingCredentialBuffersCleared(rows);
      } finally {
        fixture.destroy();
        for (const row of rows) {
          for (const field of ["ciphertext", "nonce", "auth_tag"]) {
            if (Buffer.isBuffer(row?.[field])) row[field].fill(0);
          }
        }
      }
    });
  }
});

test("O12 requires exact credential_not_found and never accepts an operational plaintext", async (context) => {
  await context.test("exact pending refusal is accepted without invoking the callback", async () => {
    const fixture = createPendingCredentialFixture();
    try {
      assert.equal(
        await gate.verifyPendingCredentialPhysicalProof(fixture.options()),
        true
      );
      assert.equal(fixture.operationalReads, 1);
      assert.equal(fixture.operationalCallbackCalls, 0);
    } finally {
      fixture.destroy();
    }
  });

  await context.test("resolved plaintext is rejected and zeroed", async () => {
    const fixture = createPendingCredentialFixture();
    const resolved = Buffer.from(
      fixture.syntheticMaterial.toString("base64url"),
      "utf8"
    );
    try {
      await assert.rejects(
        gate.verifyPendingCredentialPhysicalProof(fixture.options({
          credentials: {
            async withDecryptedCredential() { return resolved; }
          }
        })),
        (error) =>
          error?.code === "social_3b0_pending_credential_unexpectedly_operational"
      );
      assert.equal(resolved.every((byte) => byte === 0), true);
      assert.equal(fixture.vaultDecryptCalls, 0);
    } finally {
      resolved.fill(0);
      fixture.destroy();
    }
  });

  await context.test("an invoked operational callback is rejected even if credential_not_found follows", async () => {
    const fixture = createPendingCredentialFixture();
    const delivered = Buffer.from(
      fixture.syntheticMaterial.toString("base64url"),
      "utf8"
    );
    try {
      await assert.rejects(
        gate.verifyPendingCredentialPhysicalProof(fixture.options({
          credentials: {
            async withDecryptedCredential(_identity, operation) {
              fixture.recordOperationalCallback();
              await operation(delivered);
              const error = new Error("pending credential unavailable");
              error.code = "credential_not_found";
              throw error;
            }
          }
        })),
        (error) =>
          error?.code === "social_3b0_pending_credential_unexpectedly_operational"
      );
      assert.equal(fixture.operationalCallbackCalls, 1);
      assert.equal(delivered.every((byte) => byte === 0), true);
      assert.equal(fixture.vaultDecryptCalls, 0);
    } finally {
      delivered.fill(0);
      fixture.destroy();
    }
  });

  for (const refusal of [
    { name: "different code", value: "credential_expired" },
    { name: "prefixed code", value: "credential_not_found_pending" },
    { name: "missing code", value: undefined },
    { name: "undefined rejection", value: undefined, bare: true },
    { name: "null rejection", value: null, bare: true }
  ]) {
    await context.test(`${refusal.name} is rejected`, async () => {
      const fixture = createPendingCredentialFixture();
      try {
        await assert.rejects(
          gate.verifyPendingCredentialPhysicalProof(fixture.options({
            credentials: {
              async withDecryptedCredential() {
                if (refusal.bare) throw refusal.value;
                const error = new Error("wrong refusal");
                error.code = refusal.value;
                throw error;
              }
            }
          })),
          (error) =>
            error?.code === "social_3b0_pending_credential_visibility_guard_invalid"
        );
        assert.equal(fixture.vaultDecryptCalls, 0);
      } finally {
        fixture.destroy();
      }
    });
  }
});

test("O12 physical proof binds row context, real vault AAD, digest and zeroization", async (context) => {
  await context.test("context and envelope are derived from the selected row", async () => {
    const fixture = createPendingCredentialFixture();
    let contextRow;
    let envelopeRow;
    let contextExpected;
    try {
      await gate.verifyPendingCredentialPhysicalProof(fixture.options({
        contextFromRow(row, expected) {
          contextRow = row;
          contextExpected = expected;
          return contextFromRow(row, expected);
        },
        envelopeFromRow(row) {
          envelopeRow = row;
          return envelopeFromRow(row);
        }
      }));
      assert.equal(contextRow, fixture.row);
      assert.equal(envelopeRow, fixture.row);
      assert.deepEqual(contextExpected, {
        companyId: fixture.expected.companyId,
        credentialId: fixture.expected.credentialId
      });
      assert.equal(fixture.decryptedPlaintexts[0].every((byte) => byte === 0), true);
      assertPendingCredentialBuffersCleared([fixture.row]);
    } finally {
      fixture.destroy();
    }
  });

  await context.test("AAD mismatch is rejected by the real vault", async () => {
    const fixture = createPendingCredentialFixture({
      encryptionContext: {
        subjectId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
      }
    });
    try {
      await assert.rejects(
        gate.verifyPendingCredentialPhysicalProof(fixture.options()),
        (error) =>
          error?.code === "social_3b0_pending_credential_vault_proof_invalid"
      );
      assert.equal(fixture.vaultDecryptCalls, 1);
      assertPendingCredentialBuffersCleared([fixture.row]);
    } finally {
      fixture.destroy();
    }
  });

  await context.test("a different vault cannot authenticate the envelope", async () => {
    const fixture = createPendingCredentialFixture();
    const other = createPendingCredentialFixture();
    try {
      await assert.rejects(
        gate.verifyPendingCredentialPhysicalProof(fixture.options({
          vault: other.options().vault,
          operationCounts: () => ({
            vaultEncryptCalls: 1,
            vaultDecryptCalls: other.vaultDecryptCalls,
            credentialStoreCalls: 1
          })
        })),
        (error) =>
          error?.code === "social_3b0_pending_credential_vault_proof_invalid"
      );
      assert.equal(other.vaultDecryptCalls, 1);
      assertPendingCredentialBuffersCleared([fixture.row]);
    } finally {
      fixture.destroy();
      other.destroy();
    }
  });

  await context.test("digest mismatch zeroes plaintext and physical buffers", async () => {
    const fixture = createPendingCredentialFixture();
    try {
      await assert.rejects(
        gate.verifyPendingCredentialPhysicalProof(fixture.options({
          expectedDigest: "0".repeat(64)
        })),
        (error) =>
          error?.code === "social_3b0_pending_credential_vault_proof_invalid"
      );
      assert.equal(fixture.decryptedPlaintexts.length, 1);
      assert.equal(fixture.decryptedPlaintexts[0].every((byte) => byte === 0), true);
      assertPendingCredentialBuffersCleared([fixture.row]);
    } finally {
      fixture.destroy();
    }
  });
});

test("O12 enforces one encrypt, decrypt, store and credentialWrites increment", async (context) => {
  for (const entry of [
    ["vault encrypt", { vaultEncryptCalls: 0, vaultDecryptCalls: 1, credentialStoreCalls: 1 }],
    ["vault decrypt", { vaultEncryptCalls: 1, vaultDecryptCalls: 0, credentialStoreCalls: 1 }],
    ["credential store", { vaultEncryptCalls: 1, vaultDecryptCalls: 1, credentialStoreCalls: 0 }]
  ]) {
    await context.test(`${entry[0]} count mismatch`, async () => {
      const fixture = createPendingCredentialFixture();
      try {
        await assert.rejects(
          gate.verifyPendingCredentialPhysicalProof(fixture.options({
            operationCounts: () => ({ ...entry[1] })
          })),
          (error) => error?.code === "social_3b0_credential_single_write_invalid"
        );
        assert.equal(fixture.evidenceCounts.credentialWrites, 0);
      } finally {
        fixture.destroy();
      }
    });
  }

  await context.test("a pre-existing credential write is rejected", async () => {
    const fixture = createPendingCredentialFixture();
    fixture.evidenceCounts.credentialWrites = 1;
    try {
      await assert.rejects(
        gate.verifyPendingCredentialPhysicalProof(fixture.options()),
        (error) => error?.code === "social_3b0_credential_single_write_invalid"
      );
      assert.equal(fixture.evidenceCounts.credentialWrites, 1);
    } finally {
      fixture.destroy();
    }
  });
});

test("O12 keeps authorization pending with zero accounts, discovery and publication", async (context) => {
  const cases = [
    {
      name: "connection activated before O13",
      override: () => ({
        readBoundary: async () => ({ status: "active", externalAccounts: 0 })
      })
    },
    {
      name: "external account created before O13",
      override: () => ({
        readBoundary: async () => ({
          status: "authorization_pending",
          externalAccounts: 1
        })
      })
    },
    {
      name: "account discovery called",
      override: (fixture) => ({
        evidenceCounts: {
          ...fixture.evidenceCounts,
          accountDiscoveryCalls: 1
        }
      })
    },
    {
      name: "publication called",
      override: (fixture) => ({
        evidenceCounts: {
          ...fixture.evidenceCounts,
          publicationCalls: 1
        }
      })
    }
  ];
  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const fixture = createPendingCredentialFixture();
      const overrides = entry.override(fixture);
      try {
        await assert.rejects(
          gate.verifyPendingCredentialPhysicalProof(
            fixture.options(overrides)
          ),
          (error) => error?.code === "social_3b0_account_discovery_boundary_invalid"
        );
        assert.equal((overrides.evidenceCounts || fixture.evidenceCounts).credentialWrites, 0);
      } finally {
        fixture.destroy();
      }
    });
  }
});

test("O12 never returns or propagates synthetic credential material", async () => {
  const fixture = createPendingCredentialFixture();
  const syntheticToken = fixture.syntheticMaterial.toString("base64url");
  const unsafe = new Error(syntheticToken);
  unsafe.code = "credential_expired";
  try {
    let observed;
    try {
      await gate.verifyPendingCredentialPhysicalProof(fixture.options({
        credentials: {
          async withDecryptedCredential() { throw unsafe; }
        }
      }));
    } catch (error) {
      observed = error;
    }
    assert.equal(
      observed?.code,
      "social_3b0_pending_credential_visibility_guard_invalid"
    );
    assert.equal(String(observed?.message || "").includes(syntheticToken), false);
    assert.equal(JSON.stringify(observed || {}).includes(syntheticToken), false);
    assert.equal(JSON.stringify(fixture.evidenceCounts).includes(syntheticToken), false);
    assertPendingCredentialBuffersCleared([fixture.row]);
  } finally {
    fixture.destroy();
  }
});

test("O12 source keeps physical proof separate from the fail-closed operational repository", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "social-3b0-linux-physical-gate.js"),
    "utf8"
  );
  const start = source.indexOf('await ledger.run("O12"');
  const end = source.indexOf('await ledger.run("O13"', start);
  const o12 = source.slice(start, end);
  const helperStart = source.indexOf("async function verifyPendingCredentialPhysicalProof");
  const helperEnd = source.indexOf("function zeroResiduals", helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.ok(start >= 0 && end > start && helperStart >= 0 && helperEnd > helperStart);
  for (const field of [
    "company_id", "id", "provider", "connection_id", "oauth_transaction_id",
    "credential_type", "ciphertext", "nonce", "auth_tag", "key_version",
    "aad_version", "expires_at", "revoked_at"
  ]) assert.match(o12, new RegExp(`\\b${field}\\b`));
  assert.match(o12, /verifyPendingCredentialPhysicalProof\(\{/);
  assert.match(o12, /credentials,/);
  assert.match(o12, /vault,/);
  assert.match(o12, /contextFromRow,/);
  assert.match(o12, /envelopeFromRow,/);
  assert.match(helper, /withDecryptedCredential\(\{/);
  assert.match(helper, /operationalRejected = true/);
  assert.match(helper, /operationalError\?\.code !== "credential_not_found"/);
  assert.match(helper, /options\.vault\.decrypt\(/);
  assert.match(helper, /options\.envelopeFromRow\(row\)/);
  assert.match(helper, /options\.contextFromRow\(row,/);
  assert.match(helper, /physicalPlaintext\.fill\(0\)/);
  assert.match(helper, /clearPendingCredentialRows\(rows\)/);
  assert.doesNotMatch(o12 + helper, /findEncryptedCredentialForKeyRotation/);
  assert.doesNotMatch(o12 + helper, /createDecipheriv|createDecipher|setAAD|setAuthTag/);
  assert.doesNotMatch(o12 + helper, /console\.|stdout|stderr/);
  assert.doesNotMatch(o12, /\bUPDATE\b|\bINSERT\b|\bDELETE\b/);
  assert.doesNotMatch(o12, /status\s*=\s*["']active["']/);
});

test("O13 remains a second independent pending, account, discovery and publication boundary", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "social-3b0-linux-physical-gate.js"),
    "utf8"
  );
  const start = source.indexOf('await ledger.run("O13"');
  const end = source.indexOf('await ledger.run("O14"', start);
  const o13 = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(o13, /status !== "authorization_pending"/);
  assert.match(o13, /Number\(result\.rows\[0\]\.accounts\) !== 0/);
  assert.match(o13, /counts\.accountDiscoveryCalls !== 0/);
  assert.match(o13, /counts\.publicationCalls !== 0/);
  assert.doesNotMatch(o13, /\bUPDATE\b|\bINSERT\b|\bDELETE\b|status\s*=\s*["']active["']/);
});

test("evidence contract requires exact Gates, O01-O22, counts, scans and zero residuals", () => {
  const base = gate.baseEvidence({
    branch: gate.BRANCH,
    sha: SHA,
    runAttempt: 1
  });
  assert.equal(base.externalRenderCalls, 0);
  const evidence = passedEvidence();
  assert.equal(gate.evidenceSafe(evidence), true);
  assert.equal(evidence.externalRenderCalls, 0);

  for (const secretScan of [
    { status: "passed", historicPhysicalPassed: false, oauthEvidencePassed: true },
    { status: "passed", historicPhysicalPassed: true, oauthEvidencePassed: false },
    { status: "not_run", historicPhysicalPassed: true, oauthEvidencePassed: true },
    { status: "failed", historicPhysicalPassed: true, oauthEvidencePassed: true }
  ]) {
    assert.equal(gate.evidenceSafe({ ...evidence, secretScan }), false);
  }
  assert.equal(gate.evidenceSafe({
    ...evidence,
    counts: { ...gate.EXPECTED_COUNTS, credentialWrites: 1 }
  }), false);
  assert.equal(gate.evidenceSafe({
    ...evidence,
    residuals: { ...gate.zeroResiduals(), timers: 1 }
  }), false);
  assert.equal(gate.evidenceSafe({
    ...evidence,
    cleanup: { ...evidence.cleanup, cleanupCompleted: false }
  }), false);
  assert.equal(gate.evidenceSafe({
    ...evidence,
    substeps: evidence.substeps.map((entry) => entry.id === "O22"
      ? { ...entry, status: "failed" }
      : entry)
  }), false);
  assert.equal(gate.evidenceSafe({
    ...evidence,
    state: crypto.randomBytes(24).toString("base64url")
  }), false);
});

test("cleanupFailureProvenance 1: an integral first cleanup attempt produces null", async () => {
  const tracker = gate.createCleanupAttemptTracker();
  for (const operation of [
    "network_guard_restore",
    "http_server_close",
    "state_envelope_destroy",
    "vault_destroy",
    "postgres_cleanup_call"
  ]) {
    await tracker.capture(operation, async () => true);
  }
  assert.equal(cleanupSnapshot(tracker), null);
  assert.equal(gate.validCleanupFailureProvenance(null), true);
  assert.equal(gate.baseEvidence({
    branch: gate.BRANCH,
    sha: SHA,
    runAttempt: 1
  }).cleanupFailureProvenance, null);
});

for (const [number, operation] of [
  [2, "network_guard_restore"],
  [3, "http_server_close"],
  [4, "state_envelope_destroy"],
  [5, "vault_destroy"],
  [6, "postgres_cleanup_call"]
]) {
  test(`cleanupFailureProvenance ${number}: a thrown cleanup error records ${operation}`, async () => {
    const tracker = gate.createCleanupAttemptTracker();
    const error = new Error("fixture cleanup failure");
    error.code = `social_3b0_fixture_${operation}_failed`;
    await tracker.capture(operation, async () => { throw error; });
    const provenance = cleanupSnapshot(tracker, {
      postgresCleanupCompleted: operation === "postgres_cleanup_call" ? null : true
    });
    assert.equal(provenance.operation, operation);
    assert.equal(provenance.causalCode, error.code);
    assert.equal(provenance.cleanupErrorCount, 1);
    assert.deepEqual(
      Object.keys(provenance).sort(),
      gate.CLEANUP_FAILURE_PROVENANCE_KEYS
    );
    assert.equal(gate.validCleanupFailureProvenance(provenance), true);
  });
}

test("cleanupFailureProvenance 7: an incomplete PostgreSQL result has its closed cause", () => {
  const provenance = cleanupSnapshot(gate.createCleanupAttemptTracker(), {
    postgresCleanupCompleted: false
  });
  assert.equal(provenance.operation, "postgres_cleanup_result");
  assert.equal(
    provenance.causalCode,
    "social_3b0_postgres_cleanup_incomplete"
  );
  assert.equal(provenance.cleanupErrorCount, 0);
  assert.equal(gate.validCleanupFailureProvenance(provenance), true);
});

test("cleanupFailureProvenance 8: a nonzero residual has its closed validation cause", () => {
  const firstAttemptResiduals = { ...gate.zeroResiduals(), timers: 1 };
  const provenance = cleanupSnapshot(gate.createCleanupAttemptTracker(), {
    firstAttemptResiduals,
    firstAttemptSyntheticMaterialsCleared: false
  });
  assert.equal(provenance.operation, "residual_validation");
  assert.equal(
    provenance.causalCode,
    "social_3b0_cleanup_residuals_nonzero"
  );
  assert.equal(provenance.cleanupErrorCount, 0);
  assert.equal(provenance.firstAttemptSyntheticMaterialsCleared, false);
  assert.deepEqual(provenance.firstAttemptResiduals, firstAttemptResiduals);
});

test("cleanupFailureProvenance 9: every residual is observed in isolation", () => {
  const residualKeys = Object.keys(gate.zeroResiduals());
  assert.equal(residualKeys.length, 10);
  for (const key of residualKeys) {
    const firstAttemptResiduals = { ...gate.zeroResiduals(), [key]: 1 };
    const provenance = cleanupSnapshot(gate.createCleanupAttemptTracker(), {
      firstAttemptResiduals
    });
    assert.equal(provenance.operation, "residual_validation", key);
    assert.equal(provenance.firstAttemptResiduals[key], 1, key);
    assert.deepEqual(
      Object.entries(provenance.firstAttemptResiduals)
        .filter(([, value]) => value !== 0),
      [[key, 1]],
      key
    );
  }
});

test("cleanupFailureProvenance 10: the first thrown operation wins", async () => {
  const tracker = gate.createCleanupAttemptTracker();
  const first = Object.assign(new Error("first"), {
    code: "social_3b0_first_cleanup_failed"
  });
  const later = Object.assign(new Error("later"), {
    code: "social_3b0_later_cleanup_failed"
  });
  await tracker.capture("network_guard_restore", async () => { throw first; });
  await tracker.capture("http_server_close", async () => { throw later; });
  const provenance = cleanupSnapshot(tracker);
  assert.equal(provenance.operation, "network_guard_restore");
  assert.equal(provenance.causalCode, first.code);
});

test("cleanupFailureProvenance 11: all thrown cleanup operations are counted", async () => {
  const tracker = gate.createCleanupAttemptTracker();
  const thrownOperations = [
    "network_guard_restore",
    "http_server_close",
    "state_envelope_destroy",
    "vault_destroy",
    "postgres_cleanup_call"
  ];
  for (const operation of thrownOperations) {
    await tracker.capture(operation, async () => {
      throw new Error("count-only fixture");
    });
  }
  assert.equal(cleanupSnapshot(tracker, {
    postgresCleanupCompleted: null
  }).cleanupErrorCount, thrownOperations.length);
});

test("cleanupFailureProvenance 12: messages and stacks never enter evidence", async () => {
  const marker = "sensitive-cleanup-message-and-stack";
  const tracker = gate.createCleanupAttemptTracker();
  const error = new Error(marker);
  error.code = "not a closed code";
  error.stack = `${marker}\nprivate stack material`;
  await tracker.capture("vault_destroy", async () => { throw error; });
  const provenance = cleanupSnapshot(tracker);
  const serialized = JSON.stringify(provenance);
  assert.equal(provenance.causalCode, "social_3b0_cleanup_operation_failed");
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes("private stack material"), false);
  assert.deepEqual(
    Object.keys(provenance).sort(),
    gate.CLEANUP_FAILURE_PROVENANCE_KEYS
  );
});

test("cleanupFailureProvenance rejects open schemas and unsafe scalar or residual values", () => {
  const valid = cleanupProvenance();
  assert.equal(gate.validCleanupFailureProvenance(valid), true);
  const missing = { ...valid };
  delete missing.operation;
  const missingResidual = { ...valid.firstAttemptResiduals };
  delete missingResidual.timers;
  const invalid = [
    missing,
    { ...valid, unexpected: 0 },
    { ...valid, operation: "unknown_cleanup" },
    { ...valid, causalCode: "not a closed code" },
    { ...valid, cleanupErrorCount: -1 },
    { ...valid, cleanupErrorCount: 1.5 },
    { ...valid, cleanupErrorCount: "1" },
    { ...valid, cleanupErrorCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, postgresCleanupCompleted: "true" },
    { ...valid, firstAttemptSyntheticMaterialsCleared: 1 },
    { ...valid, firstAttemptResiduals: missingResidual },
    { ...valid, firstAttemptResiduals: { ...valid.firstAttemptResiduals, extra: 0 } },
    { ...valid, firstAttemptResiduals: { ...valid.firstAttemptResiduals, timers: -1 } },
    { ...valid, firstAttemptResiduals: { ...valid.firstAttemptResiduals, timers: 0.5 } },
    { ...valid, firstAttemptResiduals: { ...valid.firstAttemptResiduals, timers: "0" } },
    {
      ...valid,
      firstAttemptResiduals: {
        ...valid.firstAttemptResiduals,
        timers: Number.MAX_SAFE_INTEGER + 1
      }
    }
  ];
  for (const candidate of invalid) {
    assert.equal(gate.validCleanupFailureProvenance(candidate), false);
  }
  const passed = passedEvidence();
  const missingEvidenceField = { ...passed };
  delete missingEvidenceField.cleanupFailureProvenance;
  assert.equal(gate.evidenceSafe(missingEvidenceField), false);
  assert.equal(gate.evidenceSafe({ ...passed, cleanupFailureDetail: null }), false);
});

test("cleanupFailureProvenance 13: compensating cleanup preserves first provenance", async () => {
  const firstAttemptResiduals = { ...gate.zeroResiduals(), timers: 2 };
  const provenance = cleanupProvenance({
    operation: "state_envelope_destroy",
    causalCode: "social_3b0_state_cleanup_failed",
    cleanupErrorCount: 2,
    postgresCleanupCompleted: true,
    firstAttemptResiduals
  });
  const workerEvidence = failedO22Evidence({
    cleanupFailureProvenance: provenance,
    cleanup: {
      cleanupCompleted: false,
      intermediateEvidenceRemoved: true,
      syntheticMaterialsCleared: true
    },
    residuals: firstAttemptResiduals
  });
  assert.equal(gate.evidenceSafe(workerEvidence), true);
  const supervised = await supervisedEvidenceFixture({
    workerEvidence,
    cleanupResult: zeroCleanup(),
    runId: "73213"
  });
  assert.equal(supervised.result.ok, false);
  assert.deepEqual(supervised.evidence.cleanupFailureProvenance, provenance);
  assert.equal(supervised.evidence.substeps[21].status, "failed");
  assert.equal(supervised.evidence.firstFailure.substep, "O22");
  assert.equal(supervised.evidence.cleanup.cleanupCompleted, true);
});

test("cleanupFailureProvenance 14: final zero residuals do not erase first residuals", async () => {
  const firstAttemptResiduals = { ...gate.zeroResiduals(), containers: 1 };
  const provenance = cleanupProvenance({
    operation: "residual_validation",
    causalCode: "social_3b0_cleanup_residuals_nonzero",
    cleanupErrorCount: 0,
    firstAttemptResiduals
  });
  const supervised = await supervisedEvidenceFixture({
    workerEvidence: failedO22Evidence({
      cleanupFailureProvenance: provenance,
      cleanup: {
        cleanupCompleted: false,
        intermediateEvidenceRemoved: true,
        syntheticMaterialsCleared: true
      },
      residuals: firstAttemptResiduals
    }),
    cleanupResult: zeroCleanup(),
    runId: "73214"
  });
  assert.deepEqual(supervised.evidence.residuals, gate.zeroResiduals());
  assert.deepEqual(
    supervised.evidence.cleanupFailureProvenance.firstAttemptResiduals,
    firstAttemptResiduals
  );
});

test("cleanupFailureProvenance 15: O22 remains failed after its first attempt fails", () => {
  const failed = failedO22Evidence();
  const passedO22 = failed.substeps.map((entry) => entry.id === "O22"
    ? { ...entry, status: "passed" }
    : entry);
  assert.equal(gate.evidenceSafe(failed), true);
  assert.equal(failed.substeps[21].status, "failed");
  assert.equal(failed.firstFailure.substep, "O22");
  assert.notEqual(failed.cleanupFailureProvenance, null);
  assert.equal(gate.evidenceSafe({
    ...failed,
    cleanupFailureProvenance: null
  }), false);
  assert.equal(gate.evidenceSafe({
    ...failed,
    substeps: passedO22
  }), false);
  assert.equal(gate.evidenceSafe({
    ...failed,
    firstFailure: gate.closedFirstFailure({
      phase: gate.PHASE,
      substep: "O22",
      lastCompletedSubstep: "O21",
      causalCode: "social_3b0_cleanup_operation_failed"
    }),
    substeps: passedO22,
    cleanupFailureProvenance: null
  }), false);
});

test("cleanupFailureProvenance 16: an earlier functional failure keeps passed O22", () => {
  const evidence = passedEvidence();
  evidence.status = "failed";
  evidence.firstFailure = gate.closedFirstFailure({
    phase: gate.PHASE,
    substep: "O13",
    lastCompletedSubstep: "O12",
    causalCode: "social_3b0_fixture_functional_failure"
  });
  evidence.substeps = Object.freeze(evidence.substeps.map((entry, index) =>
    Object.freeze(index === 12
      ? { ...entry, status: "failed" }
      : index > 12 && index < 21
        ? { ...entry, status: "skipped" }
        : entry)
  ));
  assert.equal(evidence.substeps[21].status, "passed");
  assert.equal(evidence.cleanupFailureProvenance, null);
  assert.equal(gate.evidenceSafe(evidence), true);
});

test("cleanupFailureProvenance 17: an integral passed run requires null provenance", () => {
  const evidence = passedEvidence();
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.firstFailure, null);
  assert.equal(evidence.substeps[21].status, "passed");
  assert.equal(evidence.cleanupFailureProvenance, null);
  assert.equal(gate.evidenceSafe(evidence), true);
  assert.equal(gate.evidenceSafe({
    ...evidence,
    cleanupFailureProvenance: cleanupProvenance()
  }), false);
});

test("cleanupFailureProvenance 18: sanitized fallback retains only the closed schema", async () => {
  const marker = "sensitive cleanup exception detail";
  const invalidWorkerEvidence = failedO22Evidence();
  invalidWorkerEvidence.cleanupFailureProvenance = {
    ...invalidWorkerEvidence.cleanupFailureProvenance,
    message: marker,
    stack: marker
  };
  assert.equal(gate.evidenceSafe(invalidWorkerEvidence), false);
  const supervised = await supervisedEvidenceFixture({
    workerEvidence: invalidWorkerEvidence,
    cleanupResult: zeroCleanup(),
    runId: "73218"
  });
  const base = gate.baseEvidence({
    branch: gate.BRANCH,
    sha: SHA,
    runAttempt: 1
  });
  assert.equal(gate.evidenceSafe(supervised.evidence), true);
  assert.deepEqual(Object.keys(supervised.evidence).sort(), Object.keys(base).sort());
  assert.equal(supervised.evidence.cleanupFailureProvenance, null);
  assert.equal(supervised.evidence.substeps[21].status, "skipped");
  assert.equal(supervised.serialized.includes(marker), false);
  assert.equal("message" in supervised.evidence, false);
  assert.equal("stack" in supervised.evidence, false);
});

test("external render evidence rejects missing, malformed, nonzero and aliased counters", () => {
  const evidence = passedEvidence();
  const missing = { ...evidence };
  delete missing.externalRenderCalls;
  assert.equal(gate.evidenceSafe(missing), false);

  for (const externalRenderCalls of [
    null,
    "0",
    -1,
    1,
    Number.MAX_SAFE_INTEGER + 1
  ]) {
    assert.equal(gate.evidenceSafe({
      ...evidence,
      externalRenderCalls
    }), false);
  }

  assert.equal(gate.evidenceSafe({
    ...missing,
    externalRendererCalls: 0
  }), false);
  assert.equal(gate.evidenceSafe({
    ...evidence,
    renderCalls: 0
  }), false);
});

test("closed first failure preserves observed process facts without sensitive fields", () => {
  const failure = gate.closedFirstFailure({
    job: "linux_physical_gates",
    phase: "backup_restore",
    lastCompletedSubstep: "vault",
    causalCode: "backup_external_tool_failed",
    externalProcessStarted: true,
    exitCode: 7,
    signal: null,
    timedOut: false
  });
  assert.deepEqual(Object.keys(failure).sort(), [
    "causalCode",
    "exitCode",
    "externalProcessStarted",
    "job",
    "lastCompletedSubstep",
    "phase",
    "signal",
    "substep",
    "timedOut"
  ].sort());
  assert.equal(failure.externalProcessStarted, true);
  assert.equal(failure.exitCode, 7);
  assert.equal(JSON.stringify(failure).includes("stdout"), false);
  assert.equal(JSON.stringify(failure).includes("stderr"), false);
});

test("historic Gates 2-4 preserve their sanitized failing and last completed substeps", () => {
  const cases = [
    {
      firstPhase: "rls_roles",
      lastCompletedPhase: "rls_runtime_attributes_text_resolution_reproduction",
      firstCode: "postgres_insufficient_privilege",
      evidenceKey: "rlsFailureProvenance",
      provenance: {
        substep: "rls_cross_tenant_write",
        causalCode: "postgres_insufficient_privilege"
      },
      expectedSubstep: "rls_cross_tenant_write",
      expectedLast: "rls_runtime_attributes_text_resolution_reproduction"
    },
    {
      firstPhase: "concurrency_oauth_idempotency",
      lastCompletedPhase: "rls_roles",
      firstCode: "gate3_type_error",
      evidenceKey: "gate3FailureProvenance",
      provenance: {
        operation: "base",
        substep: "B2",
        operationClass: "postgres_transaction",
        causalCode: "gate3_type_error",
        lastCompletedSubstep: "B1",
        externalProcessStarted: false,
        exitCode: null,
        signal: null
      },
      expectedSubstep: "B2",
      expectedLast: "B1"
    },
    {
      firstPhase: "vault",
      lastCompletedPhase: "concurrency_oauth_idempotency",
      firstCode: "gate4_type_error",
      evidenceKey: "gate4FailureProvenance",
      provenance: {
        operation: "base",
        substep: "V02",
        operationClass: "memory_crypto",
        causalCode: "gate4_type_error",
        lastCompletedSubstep: "V01",
        externalProcessStarted: false,
        exitCode: null,
        signal: null
      },
      expectedSubstep: "V02",
      expectedLast: "V01"
    }
  ];
  for (const item of cases) {
    const details = gate.historicFailureDetails({
      historic: historicGate,
      evidence: {
        firstFailure: { phase: item.firstPhase, code: item.firstCode },
        [item.evidenceKey]: item.provenance
      },
      firstPhase: item.firstPhase,
      lastCompletedPhase: item.lastCompletedPhase,
      backupRestoreFailureProvenance: null
    });
    assert.equal(details.substep, item.expectedSubstep);
    assert.equal(details.lastCompletedSubstep, item.expectedLast);
    const closed = gate.closedFirstFailure({
      job: "linux_physical_gates",
      phase: item.firstPhase,
      substep: details.substep,
      lastCompletedSubstep: details.lastCompletedSubstep,
      causalCode: details.causalCode,
      externalProcessStarted: details.externalProcessStarted,
      exitCode: details.exitCode,
      signal: details.signal,
      timedOut: false
    });
    assert.equal(closed.substep, item.expectedSubstep);
    assert.equal(closed.lastCompletedSubstep, item.expectedLast);
  }
});

test("blocked response body uses one timer, aborts, cancels and releases without a residual", async () => {
  const appMaterial = crypto.randomBytes(32);
  const config = loadInstagramOAuthConfig(Object.freeze({
    SOCIAL_INSTAGRAM_ENABLED: "true",
    SOCIAL_EXTERNAL_CONNECTION_ENABLED: "true",
    SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false",
    INSTAGRAM_APP_ID: "73190",
    INSTAGRAM_APP_SECRET: appMaterial.toString("base64url"),
    INSTAGRAM_OAUTH_REDIRECT_URI,
    INSTAGRAM_GRAPH_API_VERSION: "v24.0"
  }));
  try {
    const proof = await gate.runBlockedBodyProof(config);
    assert.deepEqual(proof, { active: 0, clearCalls: 1, setCalls: 1 });
  } finally {
    appMaterial.fill(0);
  }
});

test("timeout owns and terminates the complete Linux process group without a residual", async () => {
  const signals = [];
  let groupAlive = true;
  let spawnOptions;
  let child;
  const spawnImpl = (_executable, _args, options) => {
    spawnOptions = options;
    child = new EventEmitter();
    child.pid = 4242;
    child.kill = () => assert.fail("direct child kill bypassed the process group");
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const processKill = (target, signal) => {
    assert.equal(target, -4242);
    if (signal === 0) {
      if (groupAlive) return true;
      const error = new Error("missing process group");
      error.code = "ESRCH";
      throw error;
    }
    signals.push(signal);
    if (signal === "SIGKILL") {
      groupAlive = false;
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    }
    return true;
  };
  const result = await gate.childOnce(process.execPath, ["synthetic-worker"], {
    spawnImpl,
    timeoutMs: 1,
    killGraceMs: 1,
    ownsProcessGroup: true,
    platform: "linux",
    processKill
  });
  assert.equal(spawnOptions.detached, true);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.started, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.processResiduals, 0);
});

test("application firewall refuses http, Socket and fetch non-loopback before I/O and restores globals", async () => {
  const originalRequest = http.request;
  const originalConnect = net.Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  const loopbackServer = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    loopbackServer.once("error", reject);
    loopbackServer.listen(0, "127.0.0.1", resolve);
  });
  const guard = gate.installApplicationNetworkGuard(new Set([
    "127.0.0.1",
    "172.18.0.2"
  ]));
  try {
    const address = loopbackServer.address();
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({
        host: "127.0.0.1",
        port: address.port
      });
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", reject);
    });
    assert.throws(
      () => http.request({ host: "198.51.100.1", port: 80, path: "/" }),
      (error) => error?.code === "social_3b0_non_loopback_network_refused"
    );
    const socket = new net.Socket();
    assert.throws(
      () => socket.connect(80, "203.0.113.1"),
      (error) => error?.code === "social_3b0_non_loopback_network_refused"
    );
    if (typeof originalFetch === "function") {
      await assert.rejects(
        globalThis.fetch("https://example.invalid/"),
        (error) => error?.code === "social_3b0_non_loopback_network_refused"
      );
    }
    const observed = guard.snapshot();
    assert.equal(observed.externalConnections, 0);
    assert.equal(observed.deniedAttempts, typeof originalFetch === "function" ? 3 : 2);
  } finally {
    guard.restore();
    await new Promise((resolve) => loopbackServer.close(resolve));
  }
  assert.equal(http.request, originalRequest);
  assert.equal(net.Socket.prototype.connect, originalConnect);
  assert.equal(globalThis.fetch, originalFetch);
});

test("worker crash still publishes exactly four sanitized files after measured cleanup", async () => {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "social-3b0-crash-"));
  const directory = path.join(runnerTemp, gate.ARTIFACT_DIRECTORY);
  const outputPath = path.join(directory, gate.EVIDENCE_FILE);
  const processStatusPath = path.join(directory, gate.PROCESS_STATUS_FILE);
  try {
    const result = await gate.superviseInstagramOAuthPhysicalGate({
      runnerTemp,
      outputPath,
      processStatusPath,
      repositoryRoot: path.join(__dirname, ".."),
      environment: environment({ RUNNER_TEMP: runnerTemp }),
      spawnImpl: fakeChild({ exitCode: 19 }),
      cleanupImpl: async () => zeroCleanup(),
      timeoutMs: 1000
    });
    assert.equal(result.ok, false);
    assert.deepEqual(fs.readdirSync(directory).sort(), [
      gate.EVIDENCE_FILE,
      gate.EVIDENCE_HASH_FILE,
      gate.PROCESS_STATUS_FILE,
      gate.PROCESS_STATUS_HASH_FILE
    ].sort());
    const evidence = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(gate.evidenceSafe(evidence), true);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.firstFailure.externalProcessStarted, true);
    assert.equal(evidence.firstFailure.exitCode, 19);
    assert.equal(evidence.cleanup.cleanupCompleted, true);
    assert.deepEqual(evidence.residuals, gate.zeroResiduals());
    assert.equal(evidence.substeps[21].status, "skipped");
    assert.equal(evidence.cleanupFailureProvenance, null);
    assert.equal(evidence.externalRenderCalls, 0);
    gate.verifySidecar(outputPath, path.join(directory, gate.EVIDENCE_HASH_FILE));
    gate.verifySidecar(
      processStatusPath,
      path.join(directory, gate.PROCESS_STATUS_HASH_FILE)
    );
  } finally {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("compensating cleanup failure downgrades the run without rewriting worker O22", async () => {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "social-3b0-cleanup-"));
  const directory = path.join(runnerTemp, gate.ARTIFACT_DIRECTORY);
  const outputPath = path.join(directory, gate.EVIDENCE_FILE);
  const processStatusPath = path.join(directory, gate.PROCESS_STATUS_FILE);
  let wroteWorkerEvidence = false;
  let workerWriteError = null;
  const spawnImpl = (_executable, _args, options) => {
    const child = new EventEmitter();
    child.kill = (signal) => {
      queueMicrotask(() => child.emit("close", null, signal));
      return true;
    };
    queueMicrotask(() => {
      try {
        const evidence = passedEvidence();
        gate.writePayload(
          path.join(options.env.RUNNER_TEMP, gate.ARTIFACT_DIRECTORY,
            gate.EVIDENCE_FILE),
          path.join(options.env.RUNNER_TEMP, gate.ARTIFACT_DIRECTORY,
            gate.EVIDENCE_HASH_FILE),
          evidence
        );
        wroteWorkerEvidence = true;
        child.emit("spawn");
        child.emit("close", 0, null);
      } catch (error) {
        workerWriteError = error;
        child.emit("error", error);
      }
    });
    return child;
  };
  try {
    const result = await gate.superviseInstagramOAuthPhysicalGate({
      runnerTemp,
      outputPath,
      processStatusPath,
      repositoryRoot: path.join(__dirname, ".."),
      environment: environment({ RUNNER_TEMP: runnerTemp, GITHUB_RUN_ID: "73193" }),
      spawnImpl,
      cleanupImpl: async () => Object.freeze({
        cleanupCompleted: false,
        artifactDirectoryRemoved: false,
        intermediateEvidenceRemoved: true,
        residuals: Object.freeze({ ...gate.zeroResiduals(), timers: 1 })
      }),
      timeoutMs: 1000
    });
    if (workerWriteError) throw workerWriteError;
    assert.equal(wroteWorkerEvidence, true);
    assert.equal(result.ok, false);
    const evidence = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(gate.evidenceSafe(evidence), true);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.firstFailure.causalCode, "social_3b0_cleanup_incomplete");
    assert.equal(evidence.cleanup.cleanupCompleted, false);
    assert.equal(evidence.residuals.timers, 1);
    assert.equal(evidence.substeps[21].status, "passed");
    assert.equal(evidence.cleanupFailureProvenance, null);
    assert.equal(evidence.externalRenderCalls, 0);
  } finally {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("spawn refusal records that no worker process started and still closes the artifact", async () => {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "social-3b0-spawn-"));
  const directory = path.join(runnerTemp, gate.ARTIFACT_DIRECTORY);
  const outputPath = path.join(directory, gate.EVIDENCE_FILE);
  try {
    await gate.superviseInstagramOAuthPhysicalGate({
      runnerTemp,
      outputPath,
      processStatusPath: path.join(directory, gate.PROCESS_STATUS_FILE),
      repositoryRoot: path.join(__dirname, ".."),
      environment: environment({ RUNNER_TEMP: runnerTemp, GITHUB_RUN_ID: "73191" }),
      spawnImpl: fakeChild({ emitSpawn: false }),
      cleanupImpl: async () => zeroCleanup(),
      timeoutMs: 1000
    });
    const evidence = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(evidence.firstFailure.externalProcessStarted, false);
    assert.equal(evidence.firstFailure.exitCode, null);
    assert.equal(evidence.firstFailure.timedOut, false);
  } finally {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("historic Gate failure preserves its first cause and never starts the OAuth contract", async () => {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "social-3b0-historic-"));
  const directory = path.join(runnerTemp, gate.ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { mode: 0o700 });
  const outputPath = path.join(directory, gate.EVIDENCE_FILE);
  const provenance = Object.freeze({
    operation: "restore",
    substep: "bundle_authentication",
    boundary: "before_transport",
    causalCode: "backup_bundle_authentication_failed",
    externalTransportProcessStarted: false,
    substepExact: true
  });
  let oauthCalled = false;
  try {
    const result = await gate.runInstagramOAuthPhysicalGate({
      runnerTemp,
      outputPath,
      repositoryRoot: path.join(__dirname, ".."),
      environment: environment({ RUNNER_TEMP: runnerTemp, GITHUB_RUN_ID: "73192" }),
      runHistoricPhysicalGates: async () => Object.freeze({
        ok: false,
        gates1To5: Object.freeze(gate.GATE_DEFINITIONS.map((entry, index) =>
          Object.freeze({ ...entry, status: index < 4 ? "passed" : "failed" })
        )),
        backupRestoreFailureProvenance: provenance,
        historicSecretScanPassed: true,
        processResiduals: 0,
        firstFailure: gate.closedFirstFailure({
          job: "linux_physical_gates",
          phase: "backup_restore",
          lastCompletedSubstep: "vault",
          causalCode: "backup_bundle_authentication_failed",
          externalProcessStarted: false,
          exitCode: 1,
          timedOut: false
        }),
        intermediateEvidenceRemoved: true
      }),
      runPhysicalOAuthContract: async () => {
        oauthCalled = true;
        assert.fail("OAuth contract ran after a historic Gate failure");
      }
    });
    assert.equal(result.ok, false);
    assert.equal(oauthCalled, false);
    const evidence = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(evidence.firstFailure.phase, "backup_restore");
    assert.equal(
      evidence.firstFailure.causalCode,
      "backup_bundle_authentication_failed"
    );
    assert.equal(evidence.firstFailure.lastCompletedSubstep, "vault");
    assert.deepEqual(evidence.backupRestoreFailureProvenance, provenance);
    assert.equal(evidence.substeps.every((entry) => entry.status === "skipped"), true);
    assert.equal(evidence.externalRenderCalls, 0);
  } finally {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("source keeps the physical O01-O22 proofs and closed cleanup interfaces", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "social-3b0-linux-physical-gate.js"),
    "utf8"
  );
  for (const id of gate.SUBSTEP_IDS.slice(0, 21)) {
    assert.match(source, new RegExp(`ledger\\.run\\(\"${id}\"`));
  }
  assert.ok(source.includes("ledger.passCleanup()"));
  assert.ok(source.includes("ledger.failCleanup(cleanupFailure)"));
  for (const marker of [
    "createLinuxPostgres",
    "createInstagramOAuthRouter",
    "openForCallback",
    "relrowsecurity AND relforcerowsecurity",
    "withDecryptedCredential",
    "cancelled_at",
    "containsSyntheticMarkerInTree",
    "scanDataDirectoryMarkers",
    "installApplicationNetworkGuard",
    "social_3b0_non_loopback_network_refused",
    "external.render = network.externalConnections",
    "secret_scan",
    "cleanupInstagramOAuthPhysicalGate",
    "artifactDirectoryRemoved"
  ]) assert.match(source, new RegExp(marker));
  for (const marker of [
    "detached: ownsProcessGroup",
    "ownsProcessGroup: false",
    "processKill(-child.pid, signal)",
    "child.processResiduals",
    "postgres.materials",
    "rememberSensitive"
  ]) assert.ok(source.includes(marker), marker);
});
