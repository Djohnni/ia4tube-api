"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const APPROVAL = "RUN_SOCIAL_POSTGRES_REAL_TESTS";
const REMOTE_APPROVAL = "RUN_SOCIAL_POSTGRES_RENDER_FREE_DISPOSABLE";
const PAID_STAGING_DISPOSABLE_APPROVAL =
  "RUN_SOCIAL_POSTGRES_RENDER_PAID_STAGING_DISPOSABLE";
const LOOPBACK_MODE = "loopback";
const RENDER_REMOTE_MODE = "render_free_remote";
const RENDER_PAID_STAGING_DISPOSABLE_MODE =
  "render_paid_staging_disposable";
const REMOTE_DATABASE = "ia4tube_social_2b0_gate";
const REQUIRED = [
  "SOCIAL_TEST_ENVIRONMENT_ID",
  "SOCIAL_TEST_PROVISIONER_DATABASE_URL",
  "SOCIAL_TEST_MIGRATION_DATABASE_URL",
  "SOCIAL_TEST_RUNTIME_DATABASE_URL"
];
const REMOTE_EXPECTED = [
  "SOCIAL_TEST_EXPECTED_HOST",
  "SOCIAL_TEST_EXPECTED_PORT",
  "SOCIAL_TEST_EXPECTED_DATABASE",
  "SOCIAL_TEST_EXPECTED_PROVISIONER_USERNAME",
  "SOCIAL_TEST_EXPECTED_MIGRATION_USERNAME",
  "SOCIAL_TEST_EXPECTED_RUNTIME_USERNAME",
  "SOCIAL_TEST_EXPECTED_TARGET_FINGERPRINT"
];
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const BLOCKED_LABEL =
  /(^|[-_.])(prod|production|stage|staging|live|main)([-_.]|$)/i;
const PRODUCTION_LABEL =
  /(^|[-_.])(prod|production|live|main)([-_.]|$)/i;
const CONNECTION_NAMES = [
  "SOCIAL_TEST_PROVISIONER_DATABASE_URL",
  "SOCIAL_TEST_MIGRATION_DATABASE_URL",
  "SOCIAL_TEST_RUNTIME_DATABASE_URL"
];
const EVIDENCE_SCHEMA_VERSION = 2;
const SAFE_EVENT_PREFIX = "IA4TUBE_SAFE_EVENT=";
const TAP_TITLE =
  "real PostgreSQL proves migrations, physical RLS, vault and reauthentication";
const TAP_SUBTEST_TITLE = `# Subtest: ${TAP_TITLE}`;
const SAFE_OUTPUT_LIMIT = 16 * 1024 * 1024;
const SAFE_LINE_LIMIT = 8192;
const STDERR_CATEGORIES = Object.freeze([
  "npm_script_missing",
  "module_not_found",
  "syntax_error",
  "reference_error",
  "type_error",
  "permission_denied",
  "connection_refused",
  "tls_hostname",
  "environment_contract",
  "postgres_authentication",
  "postgres_schema",
  "tap_failure",
  "unknown"
]);
const FIRST_FAILURE_STAGES = Object.freeze([
  "postgres_start",
  "postgres_bootstrap",
  "composed_process",
  "npm",
  "runner_load",
  "environment_gate",
  "node_test_spawn",
  "node_test_bootstrap",
  "tap_start",
  "test_discovery",
  "test_execution",
  "safe_event_protocol",
  "physical_timeout",
  "cleanup",
  "artifact",
  "unknown"
]);
const SAFE_ERROR_CODES = Object.freeze([
  "MODULE_NOT_FOUND",
  "ERR_MODULE_NOT_FOUND",
  "EACCES",
  "EPERM",
  "ECONNREFUSED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "28P01",
  "3F000",
  "42P01",
  "42703",
  "42501",
  "ERR_TEST_FAILURE",
  "guard_failed",
  "test_process_failed",
  "safe_output_limit_exceeded",
  "safe_event_protocol_invalid",
  "tap_contract_failed",
  "test_timeout"
]);
const SAFE_MODULE_NAMES = Object.freeze([
  "social-postgres-real.test.js",
  "run-real-postgres-tests.js",
  "bcryptjs",
  "pg",
  "config.js",
  "tls.js",
  "staging-provisioner.js",
  "disposable-database-lifecycle.js",
  "login-bootstrap.js",
  "errors.js",
  "validation.js",
  "migrations.js",
  "pool.js",
  "runtime-validation.js",
  "social-repository.js",
  "vault-key-registry-admin.js",
  "credential-service.js",
  "reauth.js",
  "vault.js",
  "vault-key-version.js",
  "vault-key-rotation-service.js"
]);
const SAFE_SIGNALS = new Set([
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGKILL",
  "SIGPIPE",
  "SIGQUIT",
  "SIGSEGV",
  "SIGTERM",
  "SIGTRAP"
]);
const STDERR_CATEGORY_SET = new Set(STDERR_CATEGORIES);
const FIRST_FAILURE_STAGE_SET = new Set(FIRST_FAILURE_STAGES);
const SAFE_ERROR_CODE_SET = new Set(SAFE_ERROR_CODES);
const SAFE_MODULE_NAME_SET = new Set(SAFE_MODULE_NAMES);
let cachedGateDependencies;

function gateDependencies() {
  if (cachedGateDependencies) return cachedGateDependencies;
  const {
    assertNoAmbientPostgresEnvironment
  } = require("../src/persistence/postgres/config");
  const {
    loadSystemPostgresTls
  } = require("../src/persistence/postgres/tls");
  const {
    PAID_STAGING_PUBLIC_TARGET
  } = require("../src/persistence/postgres/staging-provisioner");
  const {
    DISPOSABLE_DATABASE_NAME
  } = require("../src/persistence/postgres/disposable-database-lifecycle");
  cachedGateDependencies = Object.freeze({
    assertNoAmbientPostgresEnvironment,
    loadSystemPostgresTls,
    PAID_STAGING_PUBLIC_TARGET,
    DISPOSABLE_DATABASE_NAME
  });
  return cachedGateDependencies;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function validateSafeEvent(event) {
  if (
    !event ||
    event.evidenceSchemaVersion !== EVIDENCE_SCHEMA_VERSION ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    typeof event.event !== "string"
  ) return false;
  const markerFields = new Map([
    ["runnerReached", "runnerReached"],
    ["gateValidated", "gateValidated"],
    ["nodeTestSpawnAttempted", "nodeTestSpawnAttempted"],
    ["nodeTestProcessCreated", "nodeTestProcessCreated"],
    ["tapStarted", "tapStarted"],
    ["tapTitleObserved", "tapTitleObserved"],
    ["firstTestDiscovered", "firstTestDiscovered"]
  ]);
  if (markerFields.has(event.event)) {
    const field = markerFields.get(event.event);
    return exactKeys(event, [
      "event",
      "evidenceSchemaVersion",
      "sequence",
      field
    ]) && event[field] === true;
  }
  if (event.event === "nodeTestClosed") {
    const exitObserved = Number.isSafeInteger(event.nodeTestExitCode) &&
      event.nodeTestExitCode >= 0 && event.nodeTestSignal === null &&
      event.nodeTestTimedOut === false;
    const signalObserved = event.nodeTestExitCode === null &&
      typeof event.nodeTestSignal === "string" &&
      SAFE_SIGNALS.has(event.nodeTestSignal) &&
      event.nodeTestTimedOut === null;
    return exactKeys(event, [
      "event",
      "evidenceSchemaVersion",
      "nodeTestExitCode",
      "nodeTestSignal",
      "nodeTestTimedOut",
      "sequence"
    ]) && (exitObserved || signalObserved);
  }
  if (event.event === "failure") {
    return exactKeys(event, [
      "event",
      "evidenceSchemaVersion",
      "firstFailureStage",
      "safeErrorCode",
      "safeModuleName",
      "sequence",
      "stderrCategory"
    ]) &&
      FIRST_FAILURE_STAGE_SET.has(event.firstFailureStage) &&
      STDERR_CATEGORY_SET.has(event.stderrCategory) &&
      (event.safeErrorCode === null ||
        SAFE_ERROR_CODE_SET.has(event.safeErrorCode)) &&
      (event.safeModuleName === null ||
        SAFE_MODULE_NAME_SET.has(event.safeModuleName)) &&
      (event.safeModuleName === null ||
        event.stderrCategory === "module_not_found");
  }
  return false;
}

function safeEventLine(event) {
  if (!validateSafeEvent(event)) throw new Error("safe_event_invalid");
  return SAFE_EVENT_PREFIX + canonicalJson(event) + "\n";
}

function sanitizedModuleName(candidate) {
  if (typeof candidate !== "string") return null;
  const normalized = candidate.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(basename)) return null;
  return SAFE_MODULE_NAME_SET.has(basename) ? basename : null;
}

function safeCodeFromLine(line) {
  for (const code of SAFE_ERROR_CODES) {
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`).test(line)) {
      return code;
    }
  }
  return null;
}

function safeModuleFromLine(line) {
  const match = /(?:Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND)[^'"\r\n]*['"]([^'"\r\n]+)['"]/.exec(line);
  return match ? sanitizedModuleName(match[1]) : null;
}

function classifySafeLine(line) {
  const value = String(line || "");
  let stderrCategory = "unknown";
  if (/Missing script:\s*["']test:postgres-real["']/.test(value)) {
    stderrCategory = "npm_script_missing";
  } else if (/\b(?:MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b|Cannot find (?:module|package)/.test(value)) {
    stderrCategory = "module_not_found";
  } else if (/(?:^|\s)SyntaxError:/.test(value)) {
    stderrCategory = "syntax_error";
  } else if (/(?:^|\s)ReferenceError:/.test(value)) {
    stderrCategory = "reference_error";
  } else if (/(?:^|\s)TypeError:/.test(value)) {
    stderrCategory = "type_error";
  } else if (/\b(?:EACCES|EPERM)\b|permission denied/i.test(value)) {
    stderrCategory = "permission_denied";
  } else if (/\bECONNREFUSED\b|connection refused/i.test(value)) {
    stderrCategory = "connection_refused";
  } else if (/\bERR_TLS_CERT_ALTNAME_INVALID\b|TLS[^\r\n]{0,80}hostname|hostname[^\r\n]{0,80}TLS/i.test(value)) {
    stderrCategory = "tls_hostname";
  } else if (/\b28P01\b|password authentication failed/i.test(value)) {
    stderrCategory = "postgres_authentication";
  } else if (/\b(?:3F000|42P01|42703|42501)\b|(?:schema|relation)[^\r\n]{0,80}does not exist/i.test(value)) {
    stderrCategory = "postgres_schema";
  }
  return Object.freeze({
    stderrCategory,
    safeErrorCode: safeCodeFromLine(value),
    safeModuleName:
      stderrCategory === "module_not_found" ? safeModuleFromLine(value) : null
  });
}

function createLineFramer(onLine) {
  const states = {
    stdout: { decoder: new StringDecoder("utf8"), carry: "" },
    stderr: { decoder: new StringDecoder("utf8"), carry: "" }
  };
  let bytes = 0;
  let overflow = false;
  function push(channel, chunk) {
    if (!Object.prototype.hasOwnProperty.call(states, channel)) {
      overflow = true;
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > SAFE_OUTPUT_LIMIT) overflow = true;
    const state = states[channel];
    const joined = state.carry + state.decoder.write(buffer);
    const parts = joined.split("\n");
    state.carry = parts.pop();
    if (Buffer.byteLength(state.carry, "utf8") > SAFE_LINE_LIMIT) {
      overflow = true;
      state.carry = "";
    }
    for (const item of parts) {
      if (Buffer.byteLength(item, "utf8") > SAFE_LINE_LIMIT) overflow = true;
      else onLine(channel, item.endsWith("\r") ? item.slice(0, -1) : item);
    }
  }
  function finish() {
    for (const [channel, state] of Object.entries(states)) {
      const tail = state.carry + state.decoder.end();
      if (tail) {
        if (Buffer.byteLength(tail, "utf8") > SAFE_LINE_LIMIT) overflow = true;
        else onLine(channel, tail.endsWith("\r") ? tail.slice(0, -1) : tail);
      }
      state.carry = "";
    }
    return Object.freeze({ bytes, overflow });
  }
  return Object.freeze({ push, finish });
}

function createNodeTestObserver(onMarker = () => {}) {
  const totals = { tests: [], pass: [], fail: [], skipped: [], cancelled: [] };
  const markers = {
    tapStarted: false,
    tapTitleObserved: false,
    firstTestDiscovered: false
  };
  let classification = null;
  function mark(name) {
    if (markers[name]) return;
    markers[name] = true;
    onMarker(name);
  }
  const framer = createLineFramer((channel, line) => {
    if (channel === "stdout") {
      if (line === "TAP version 13") mark("tapStarted");
      if (line === TAP_SUBTEST_TITLE) mark("tapTitleObserved");
      if (line.startsWith("# Subtest: ")) mark("firstTestDiscovered");
      const total = /^(?:#|\u2139)\s*(tests|pass|fail|skipped|cancelled)\s+([0-9]+)\s*$/.exec(line);
      if (total) totals[total[1]].push(Number(total[2]));
    }
    if (classification === null) {
      const candidate = classifySafeLine(line);
      if (candidate.stderrCategory !== "unknown") classification = candidate;
    }
  });
  function finish() {
    const framed = framer.finish();
    const one = (name) => totals[name].length === 1 ? totals[name][0] : null;
    const tapFail = one("fail");
    const observed = classification || Object.freeze({
      stderrCategory: tapFail !== null && tapFail > 0 ? "tap_failure" : "unknown",
      safeErrorCode: null,
      safeModuleName: null
    });
    return Object.freeze({
      overflow: framed.overflow,
      tapStarted: markers.tapStarted,
      tapTitleObserved: markers.tapTitleObserved,
      firstTestDiscovered: markers.firstTestDiscovered,
      tapTests: one("tests"),
      tapPass: one("pass"),
      tapFail,
      tapSkipped: one("skipped"),
      tapCancelled: one("cancelled"),
      stderrCategory: observed.stderrCategory,
      safeErrorCode: observed.safeErrorCode,
      safeModuleName: observed.safeModuleName
    });
  }
  return Object.freeze({ push: framer.push, finish });
}

function createSafeEventCollector() {
  const seen = new Set();
  const state = {
    runnerReached: null,
    gateValidated: null,
    nodeTestSpawnAttempted: null,
    nodeTestProcessCreated: null,
    nodeTestExitCode: null,
    nodeTestSignal: null,
    nodeTestTimedOut: null,
    tapStarted: null,
    tapTitleObserved: null,
    firstTestDiscovered: null,
    stderrCategory: null,
    safeErrorCode: null,
    safeModuleName: null,
    firstFailureStage: null
  };
  let expectedSequence = 1;
  let protocolInvalid = false;
  let closed = false;
  let failure = false;
  let rawClassification = null;
  function invalidate() {
    protocolInvalid = true;
  }
  function markerAllowed(name) {
    if (failure || closed || seen.has(name)) return false;
    if (name === "runnerReached") return seen.size === 0;
    if (name === "gateValidated") return state.runnerReached === true;
    if (name === "nodeTestSpawnAttempted") return state.gateValidated === true;
    if (name === "nodeTestProcessCreated") {
      return state.nodeTestSpawnAttempted === true;
    }
    if (name === "tapStarted") return state.nodeTestProcessCreated === true;
    if (name === "tapTitleObserved" || name === "firstTestDiscovered") {
      return state.tapStarted === true;
    }
    return false;
  }
  function failureAllowed(event) {
    if (failure || seen.has("failure") || state.runnerReached !== true) return false;
    if (event.firstFailureStage === "runner_load" ||
        event.firstFailureStage === "environment_gate") {
      return state.gateValidated !== true &&
        state.nodeTestSpawnAttempted !== true && !closed;
    }
    if (event.firstFailureStage === "node_test_spawn") {
      return state.nodeTestSpawnAttempted === true &&
        state.nodeTestProcessCreated !== true && !closed;
    }
    if (event.firstFailureStage === "node_test_bootstrap") {
      return state.nodeTestProcessCreated === true;
    }
    if (!closed) return false;
    if (event.firstFailureStage === "tap_start") {
      return state.tapStarted !== true;
    }
    if (event.firstFailureStage === "test_discovery") {
      return state.tapStarted === true &&
        state.firstTestDiscovered !== true;
    }
    if (event.firstFailureStage === "test_execution") {
      return state.firstTestDiscovered === true;
    }
    return false;
  }
  function applyEvent(event) {
    if (
      protocolInvalid ||
      !validateSafeEvent(event) ||
      event.sequence !== expectedSequence
    ) {
      invalidate();
      return;
    }
    expectedSequence += 1;
    if ([
      "runnerReached",
      "gateValidated",
      "nodeTestSpawnAttempted",
      "nodeTestProcessCreated",
      "tapStarted",
      "tapTitleObserved",
      "firstTestDiscovered"
    ].includes(event.event)) {
      if (!markerAllowed(event.event)) {
        invalidate();
        return;
      }
      seen.add(event.event);
      state[event.event] = true;
      return;
    }
    if (event.event === "nodeTestClosed") {
      if (
        failure ||
        closed ||
        state.nodeTestProcessCreated !== true ||
        seen.has("nodeTestClosed")
      ) {
        invalidate();
        return;
      }
      closed = true;
      seen.add(event.event);
      state.nodeTestExitCode = event.nodeTestExitCode;
      state.nodeTestSignal = event.nodeTestSignal;
      state.nodeTestTimedOut = event.nodeTestTimedOut;
      return;
    }
    if (event.event === "failure") {
      if (!failureAllowed(event)) {
        invalidate();
        return;
      }
      failure = true;
      seen.add(event.event);
      state.stderrCategory = event.stderrCategory;
      state.safeErrorCode = event.safeErrorCode;
      state.safeModuleName = event.safeModuleName;
      state.firstFailureStage = event.firstFailureStage;
      return;
    }
    invalidate();
  }
  const framer = createLineFramer((channel, line) => {
    if (line.startsWith(SAFE_EVENT_PREFIX)) {
      if (channel !== "stdout") {
        invalidate();
        return;
      }
      const body = line.slice(SAFE_EVENT_PREFIX.length);
      let event;
      try {
        event = JSON.parse(body);
      } catch {
        invalidate();
        return;
      }
      if (canonicalJson(event) !== body) {
        invalidate();
        return;
      }
      applyEvent(event);
      return;
    }
    if (channel === "stderr" && rawClassification === null) {
      const candidate = classifySafeLine(line);
      if (candidate.stderrCategory !== "unknown") rawClassification = candidate;
    }
  });
  function finish() {
    const framed = framer.finish();
    if (framed.overflow) invalidate();
    if (protocolInvalid && !failure) {
      state.stderrCategory = "unknown";
      state.safeErrorCode = framed.overflow
        ? "safe_output_limit_exceeded"
        : "safe_event_protocol_invalid";
      state.safeModuleName = null;
      state.firstFailureStage = "safe_event_protocol";
    } else if (!failure && rawClassification !== null) {
      state.stderrCategory = rawClassification.stderrCategory;
      state.safeErrorCode = rawClassification.safeErrorCode;
      state.safeModuleName = rawClassification.safeModuleName;
    }
    return Object.freeze({
      protocolValid: !protocolInvalid,
      closed,
      failure,
      eventCount: expectedSequence - 1,
      ...state
    });
  }
  return Object.freeze({ push: framer.push, finish });
}

function safeFailureFromError(error, fallbackCategory = "unknown") {
  const code = typeof error?.code === "string" &&
    SAFE_ERROR_CODE_SET.has(error.code) ? error.code : null;
  const classified = classifySafeLine(
    [error?.name, error?.code, error?.message].filter(Boolean).join(" ")
  );
  return Object.freeze({
    stderrCategory:
      classified.stderrCategory === "unknown"
        ? fallbackCategory
        : classified.stderrCategory,
    safeErrorCode: code || classified.safeErrorCode,
    safeModuleName: classified.safeModuleName
  });
}

function nodeTestFailure(facts, result) {
  const exactTap = facts.tapStarted &&
    facts.tapTitleObserved &&
    facts.firstTestDiscovered &&
    facts.tapTests === 1 &&
    facts.tapPass === 1 &&
    facts.tapFail === 0 &&
    facts.tapSkipped === 0 &&
    facts.tapCancelled === 0;
  if (result.status === 0 && result.signal === null &&
      !facts.overflow && exactTap) return null;
  let firstFailureStage = "node_test_bootstrap";
  if (facts.firstTestDiscovered) firstFailureStage = "test_execution";
  else if (facts.tapStarted) firstFailureStage = "test_discovery";
  else if (result.status === 0) firstFailureStage = "tap_start";
  let stderrCategory = facts.stderrCategory;
  if (stderrCategory === "unknown" && facts.tapStarted) {
    stderrCategory = "tap_failure";
  }
  let safeErrorCode = facts.safeErrorCode;
  if (facts.overflow) safeErrorCode = "safe_output_limit_exceeded";
  else if (safeErrorCode === null && result.status === 0) {
    safeErrorCode = "tap_contract_failed";
  } else if (safeErrorCode === null && result.status !== 0) {
    safeErrorCode = "ERR_TEST_FAILURE";
  }
  return Object.freeze({
    firstFailureStage,
    stderrCategory,
    safeErrorCode,
    safeModuleName:
      stderrCategory === "module_not_found" ? facts.safeModuleName : null
  });
}

function runNodeTest({
  configuration,
  env,
  onCreated,
  onMarker,
  spawnImpl = spawn
}) {
  return new Promise((resolve) => {
    const observer = createNodeTestObserver(onMarker);
    let child;
    try {
      child = spawnImpl(
        process.execPath,
        [
          "--test-reporter=tap",
          "--test-reporter-destination=stdout",
          "--test",
          path.resolve(__dirname, "..", "tests", "social-postgres-real.test.js")
        ],
        {
          cwd: path.resolve(__dirname, ".."),
          env: {
            ...env,
            SOCIAL_REAL_POSTGRES_REQUIRED: "true",
            SOCIAL_TEST_GATE_VALIDATED_FINGERPRINT: configuration.fingerprint
          },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        }
      );
    } catch (error) {
      resolve(Object.freeze({
        created: false,
        error,
        status: null,
        signal: null,
        facts: null
      }));
      return;
    }
    let created = false;
    let settled = false;
    let streamError = false;
    if (child.stdout) {
      child.stdout.on("data", (chunk) => observer.push("stdout", chunk));
      child.stdout.once("error", () => { streamError = true; });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => observer.push("stderr", chunk));
      child.stderr.once("error", () => { streamError = true; });
    }
    child.once("spawn", () => {
      created = true;
      onCreated();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      resolve(Object.freeze({
        created,
        error,
        status: null,
        signal: null,
        facts: null
      }));
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      const facts = observer.finish();
      resolve(Object.freeze({
        created,
        error: streamError ? Object.assign(new Error("stream_error"), {
          code: "test_process_failed"
        }) : null,
        status,
        signal,
        facts
      }));
    });
  });
}

class PostgresGateRefusal extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "PostgresGateRefusal";
  }
}

function refuse(code) {
  throw new PostgresGateRefusal(code);
}

function requireValue(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    refuse(`${name.toLowerCase()}_missing`);
  }
  return value;
}

function decodeUrlPart(value, code) {
  try {
    return decodeURIComponent(value);
  } catch {
    refuse(code);
  }
}

function normalizedHost(parsed) {
  return parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function parsePort(value, code) {
  if (!/^[0-9]{1,5}$/.test(String(value || ""))) refuse(code);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) refuse(code);
  return String(port);
}

function connectionIdentity(parsed) {
  return Object.freeze({
    host: normalizedHost(parsed),
    port: parsed.port || "5432",
    database: decodeUrlPart(
      parsed.pathname.slice(1),
      "database_url_encoding_invalid"
    ),
    username: decodeUrlPart(
      parsed.username,
      "database_url_encoding_invalid"
    )
  });
}

function targetFingerprint(input) {
  const normalized = [
    "ia4tube-social-postgres-real-gate-v1",
    input.mode,
    String(input.environmentId || "").toLowerCase(),
    String(input.host || "").toLowerCase(),
    String(input.port || "5432"),
    String(input.database || ""),
    String(input.provisionerUsername || "").toLowerCase(),
    String(input.migrationUsername || "").toLowerCase(),
    String(input.runtimeUsername || "").toLowerCase(),
    input.mode === LOOPBACK_MODE ? "loopback" : "tls-verify-full",
    "disposable-empty-v1"
  ].join("/");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function equalFingerprint(actual, expected) {
  if (!SHA256.test(actual) || !SHA256.test(expected)) return false;
  return crypto.timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex")
  );
}

function parseDatabaseUrl(name, env, mode, expected) {
  const raw = requireValue(env, name);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    refuse(`${name.toLowerCase()}_invalid`);
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.username ||
    (mode !== LOOPBACK_MODE && !parsed.password) ||
    !parsed.pathname ||
    parsed.pathname === "/"
  ) {
    refuse(`${name.toLowerCase()}_invalid`);
  }

  const identity = connectionIdentity(parsed);
  if (mode === LOOPBACK_MODE) {
    if (!LOOPBACK.has(identity.host)) {
      refuse(`${name.toLowerCase()}_invalid`);
    }
  } else {
    if (
      net.isIP(identity.host) !== 0 ||
      identity.host !== expected.host ||
      !identity.host.endsWith(".render.com") ||
      identity.port !== expected.port
    ) {
      refuse(`${name.toLowerCase()}_target_mismatch`);
    }
    const keys = [...new Set([...parsed.searchParams.keys()])];
    const sslModes = parsed.searchParams.getAll("sslmode");
    if (
      keys.length !== 1 ||
      keys[0] !== "sslmode" ||
      sslModes.length !== 1 ||
      sslModes[0].toLowerCase() !== "verify-full"
    ) {
      refuse(`${name.toLowerCase()}_tls_invalid`);
    }
  }
  return Object.freeze({ parsed, raw, identity });
}

function secureConnection(raw, configuration) {
  const parsed = new URL(raw);
  for (const key of [...parsed.searchParams.keys()]) {
    parsed.searchParams.delete(key);
  }
  if (
    configuration.mode !== LOOPBACK_MODE &&
    (
      !configuration.ssl ||
      configuration.ssl.rejectUnauthorized !== true ||
      configuration.ssl.servername !== configuration.host ||
      Object.prototype.hasOwnProperty.call(configuration.ssl, "ca")
    )
  ) {
    refuse("system_trust_configuration_invalid");
  }
  return Object.freeze({
    connectionString: parsed.toString(),
    ssl:
      configuration.mode !== LOOPBACK_MODE
        ? configuration.ssl
        : false
  });
}

function validateGateEnvironment(env = process.env) {
  const {
    assertNoAmbientPostgresEnvironment,
    loadSystemPostgresTls,
    PAID_STAGING_PUBLIC_TARGET,
    DISPOSABLE_DATABASE_NAME
  } = gateDependencies();
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    refuse("node_tls_verification_disabled");
  }
  for (const [name, value] of Object.entries(env)) {
    if (/^PGSSL/i.test(name) && String(value || "").trim()) {
      refuse("ambient_pgssl_configuration_refused");
    }
  }
  try {
    assertNoAmbientPostgresEnvironment(
      env,
      "ambient_postgres_configuration_refused"
    );
  } catch (error) {
    if (
      error?.code === "ambient_postgres_configuration_refused"
    ) {
      refuse("ambient_postgres_configuration_refused");
    }
    throw error;
  }
  if (requireValue(env, "SOCIAL_TEST_POSTGRES_APPROVED") !== APPROVAL) {
    refuse("explicit_approval_missing");
  }
  for (const name of REQUIRED) requireValue(env, name);
  const environmentId = requireValue(env, "SOCIAL_TEST_ENVIRONMENT_ID")
    .toLowerCase();
  if (!UUID.test(environmentId)) refuse("environment_id_invalid");

  const mode = String(env.SOCIAL_TEST_TARGET_MODE || LOOPBACK_MODE)
    .trim()
    .toLowerCase();
  if (
    ![
      LOOPBACK_MODE,
      RENDER_REMOTE_MODE,
      RENDER_PAID_STAGING_DISPOSABLE_MODE
    ].includes(mode)
  ) {
    refuse("target_mode_invalid");
  }

  let expected = Object.freeze({});
  if (mode !== LOOPBACK_MODE) {
    const approval =
      mode === RENDER_REMOTE_MODE
        ? REMOTE_APPROVAL
        : PAID_STAGING_DISPOSABLE_APPROVAL;
    if (
      requireValue(env, "SOCIAL_TEST_RENDER_REMOTE_APPROVED") !== approval
    ) {
      refuse("remote_approval_missing");
    }
    for (const name of REMOTE_EXPECTED) requireValue(env, name);
    expected = Object.freeze({
      host: env.SOCIAL_TEST_EXPECTED_HOST.toLowerCase(),
      port: parsePort(
        env.SOCIAL_TEST_EXPECTED_PORT,
        "expected_port_invalid"
      ),
      database: env.SOCIAL_TEST_EXPECTED_DATABASE,
      usernames: Object.freeze([
        env.SOCIAL_TEST_EXPECTED_PROVISIONER_USERNAME,
        env.SOCIAL_TEST_EXPECTED_MIGRATION_USERNAME,
        env.SOCIAL_TEST_EXPECTED_RUNTIME_USERNAME
      ]),
      fingerprint: env.SOCIAL_TEST_EXPECTED_TARGET_FINGERPRINT.toLowerCase()
    });
    const targetLabels = [expected.database, ...expected.usernames];
    const freeTargetInvalid =
      mode === RENDER_REMOTE_MODE &&
      (
        expected.database !== REMOTE_DATABASE ||
        targetLabels.some((label) => BLOCKED_LABEL.test(label))
      );
    const paidDisposableTargetInvalid =
      mode === RENDER_PAID_STAGING_DISPOSABLE_MODE &&
      (
        environmentId !== PAID_STAGING_PUBLIC_TARGET.environmentId ||
        expected.host !== PAID_STAGING_PUBLIC_TARGET.host ||
        expected.port !== PAID_STAGING_PUBLIC_TARGET.port ||
        expected.database !== DISPOSABLE_DATABASE_NAME ||
        expected.usernames[0] !==
          PAID_STAGING_PUBLIC_TARGET.provisionerLogin ||
        expected.usernames[1] !==
          PAID_STAGING_PUBLIC_TARGET.migrationLogin ||
        expected.usernames[2] !==
          PAID_STAGING_PUBLIC_TARGET.runtimeLogin ||
        targetLabels.some((label) => PRODUCTION_LABEL.test(label))
      );
    if (
      net.isIP(expected.host) !== 0 ||
      !expected.host.endsWith(".render.com") ||
      freeTargetInvalid ||
      paidDisposableTargetInvalid
    ) {
      refuse("expected_target_not_disposable");
    }
  }

  const urls = CONNECTION_NAMES.map((name) =>
    parseDatabaseUrl(name, env, mode, expected)
  );
  const identities = urls.map((item) => item.identity);
  if (new Set(urls.map((item) => item.raw)).size !== urls.length) {
    refuse("database_urls_must_be_distinct");
  }
  if (new Set(identities.map((item) => item.username)).size !== 3) {
    refuse("database_users_must_be_distinct");
  }
  for (const identity of identities.slice(1)) {
    if (
      identity.host !== identities[0].host ||
      identity.port !== identities[0].port ||
      identity.database !== identities[0].database
    ) {
      refuse("database_targets_must_match");
    }
  }

  if (mode === LOOPBACK_MODE) {
    if (
      !/^ia4tube_social_test_[a-z0-9_]+$/.test(identities[0].database) ||
      BLOCKED_LABEL.test(identities[0].database) ||
      identities.some((identity) => BLOCKED_LABEL.test(identity.username))
    ) {
      refuse("database_target_not_synthetic");
    }
  } else {
    if (
      identities[0].database !== expected.database ||
      identities.some(
        (identity, index) =>
          identity.username !== expected.usernames[index]
      )
    ) {
      refuse("database_identity_mismatch");
    }
    const actualFingerprint = targetFingerprint({
      mode,
      environmentId,
      host: expected.host,
      port: expected.port,
      database: expected.database,
      provisionerUsername: expected.usernames[0],
      migrationUsername: expected.usernames[1],
      runtimeUsername: expected.usernames[2]
    });
    if (!equalFingerprint(actualFingerprint, expected.fingerprint)) {
      refuse("external_target_fingerprint_mismatch");
    }
  }

  let ssl;
  if (mode !== LOOPBACK_MODE) {
    try {
      ssl = loadSystemPostgresTls(env, identities[0].host);
    } catch (error) {
      if (typeof error?.code === "string") refuse(error.code);
      throw error;
    }
  }
  const configuration = {
    mode,
    environmentId,
    host: identities[0].host,
    port: identities[0].port,
    database: identities[0].database,
    identities: Object.freeze(identities),
    urls: Object.freeze(urls.map((item) => item.raw)),
    fingerprint: targetFingerprint({
      mode,
      environmentId,
      host: identities[0].host,
      port: identities[0].port,
      database: identities[0].database,
      provisionerUsername: identities[0].username,
      migrationUsername: identities[1].username,
      runtimeUsername: identities[2].username
    })
  };
  if (ssl) {
    Object.defineProperty(configuration, "ssl", {
      value: ssl,
      enumerable: false,
      writable: false,
      configurable: false
    });
  }
  return Object.freeze(configuration);
}

async function main(env = process.env, options = {}) {
  const writeLine = options.writeLine || ((line) => process.stdout.write(line));
  const validateGateEnvironmentImpl =
    options.validateGateEnvironmentImpl || validateGateEnvironment;
  const runNodeTestImpl = options.runNodeTestImpl || runNodeTest;
  let sequence = 0;
  function emit(event, fields) {
    sequence += 1;
    writeLine(safeEventLine({
      event,
      evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
      sequence,
      ...fields
    }));
  }
  function emitFailure(firstFailureStage, failureFacts) {
    emit("failure", {
      firstFailureStage,
      safeErrorCode: failureFacts.safeErrorCode,
      safeModuleName: failureFacts.safeModuleName,
      stderrCategory: failureFacts.stderrCategory
    });
  }

  emit("runnerReached", { runnerReached: true });
  let configuration;
  try {
    configuration = validateGateEnvironmentImpl(env);
  } catch (error) {
    if (error instanceof PostgresGateRefusal) {
      emitFailure("environment_gate", {
        stderrCategory: "environment_contract",
        safeErrorCode: "guard_failed",
        safeModuleName: null
      });
    } else {
      emitFailure("runner_load", safeFailureFromError(error));
    }
    return 2;
  }

  emit("gateValidated", { gateValidated: true });
  emit("nodeTestSpawnAttempted", { nodeTestSpawnAttempted: true });
  let result;
  try {
    result = await runNodeTestImpl({
      configuration,
      env,
      spawnImpl: options.spawnImpl || spawn,
      onCreated: () => emit("nodeTestProcessCreated", {
        nodeTestProcessCreated: true
      }),
      onMarker: (name) => emit(name, { [name]: true })
    });
  } catch (error) {
    emitFailure("node_test_spawn", safeFailureFromError(error));
    return 2;
  }

  if (!result.created || result.facts === null) {
    emitFailure(
      result.created ? "node_test_bootstrap" : "node_test_spawn",
      safeFailureFromError(result.error, "unknown")
    );
    return 2;
  }

  const nodeTestTimedOut = result.signal === null ? false : null;
  emit("nodeTestClosed", {
    nodeTestExitCode: result.status,
    nodeTestSignal: result.signal,
    nodeTestTimedOut
  });
  let failureFacts = result.error
    ? {
        firstFailureStage: "node_test_bootstrap",
        ...safeFailureFromError(result.error)
      }
    : nodeTestFailure(result.facts, result);
  if (failureFacts) {
    emitFailure(failureFacts.firstFailureStage, failureFacts);
    if (Number.isSafeInteger(result.status) && result.status !== 0) {
      return result.status;
    }
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    () => { process.exitCode = 2; }
  );
}

module.exports = {
  APPROVAL,
  EVIDENCE_SCHEMA_VERSION,
  FIRST_FAILURE_STAGES,
  LOOPBACK_MODE,
  PAID_STAGING_DISPOSABLE_APPROVAL,
  PostgresGateRefusal,
  REMOTE_APPROVAL,
  REMOTE_DATABASE,
  RENDER_PAID_STAGING_DISPOSABLE_MODE,
  RENDER_REMOTE_MODE,
  SAFE_ERROR_CODES,
  SAFE_EVENT_PREFIX,
  SAFE_MODULE_NAMES,
  STDERR_CATEGORIES,
  TAP_TITLE,
  canonicalJson,
  classifySafeLine,
  createNodeTestObserver,
  createSafeEventCollector,
  main,
  runNodeTest,
  safeEventLine,
  secureConnection,
  targetFingerprint,
  validateGateEnvironment
};
