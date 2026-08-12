"use strict";

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const dns = require("node:dns");
const tls = require("node:tls");
const path = require("node:path");

const BRANCH =
  "social/checkpoint-3b0-instagram-oauth-local-contract-20260812";
const PHASE = "instagram_oauth_local_contract";
const IMAGE =
  "docker.io/library/postgres:18.4-bookworm@" +
  "sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568";
const EVIDENCE_FILE =
  "social-3b0-instagram-oauth-local-contract-evidence.json";
const EVIDENCE_HASH_FILE =
  "social-3b0-instagram-oauth-local-contract-evidence.sha256";
const PROCESS_STATUS_FILE =
  "social-3b0-instagram-oauth-local-contract-process-status.json";
const PROCESS_STATUS_HASH_FILE =
  "social-3b0-instagram-oauth-local-contract-process-status.sha256";
const ARTIFACT_DIRECTORY =
  "social-3b0-instagram-oauth-local-contract-evidence";
const HISTORIC_DIRECTORY_PREFIX = "social-3b0-3a0-intermediate-";
const LOOPBACK = "127.0.0.1";
const SERVER_SOCKETS = new WeakMap();
const IDENTITY_VERSION = "social-id-v1";
const IDENTITY_NAMESPACE = "41cb8c58-0bf4-4bd9-83b2-3f2f96dfe29f";
// Leave enough of the immutable 60 minute job budget for evidence publication,
// artifact upload and the idempotent ownership cleanup step.
const WORKER_TIMEOUT_MS = 44 * 60_000;
const HISTORIC_TIMEOUT_MS = 36 * 60_000;
const KILL_GRACE_MS = 10_000;
const SAFE_FAILURE = /^[a-z][a-z0-9_]{2,119}$/;
const SAFE_SUBSTEP = /^(?:O\d{2}|B\d{1,2}|S\d{1,2}|V\d{2}|[a-z][a-z0-9_]{2,119})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SIGNALS = new Set([
  "SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT",
  "SIGBUS", "SIGFPE", "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2",
  "SIGPIPE", "SIGALRM", "SIGTERM", "SIGSTKFLT", "SIGCHLD", "SIGCONT",
  "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGXCPU",
  "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGPWR",
  "SIGSYS"
]);

const GATE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "G01", phase: "migrations" }),
  Object.freeze({ id: "G02", phase: "rls_roles" }),
  Object.freeze({ id: "G03", phase: "concurrency_oauth_idempotency" }),
  Object.freeze({ id: "G04", phase: "vault" }),
  Object.freeze({ id: "G05", phase: "backup_restore" })
]);
const SUBSTEP_IDS = Object.freeze(
  Array.from({ length: 22 }, (_unused, index) =>
    `O${String(index + 1).padStart(2, "0")}`
  )
);
const RESIDUAL_KEYS = Object.freeze([
  "containers",
  "httpServers",
  "listeners",
  "networks",
  "nodeProcesses",
  "postgresConnections",
  "readers",
  "temporaryRoots",
  "timers",
  "volumes"
].sort());
const COUNT_KEYS = Object.freeze([
  "accountDiscoveryCalls",
  "authorizeRequests",
  "blockedBodyAborts",
  "callbackRequests",
  "cancellationExchanges",
  "concurrencyWinners",
  "credentialWrites",
  "publicationCalls",
  "replayRefusals",
  "syntheticExchangeCalls"
].sort());
const EXPECTED_COUNTS = Object.freeze({
  accountDiscoveryCalls: 0,
  authorizeRequests: 6,
  blockedBodyAborts: 1,
  callbackRequests: 8,
  cancellationExchanges: 0,
  concurrencyWinners: 1,
  credentialWrites: 2,
  publicationCalls: 0,
  replayRefusals: 1,
  syntheticExchangeCalls: 2
});
const EVIDENCE_KEYS = Object.freeze([
  "backupRestoreFailureProvenance",
  "branch",
  "cleanup",
  "counts",
  "externalGraphApiCalls",
  "externalInstagramCalls",
  "externalMetaCalls",
  "externalPublicationCalls",
  "firstFailure",
  "format",
  "gates1To5",
  "image",
  "kind",
  "phase",
  "preGateLinux",
  "publicationCalls",
  "realTokenCount",
  "residuals",
  "runAttempt",
  "secretScan",
  "sha",
  "status",
  "substeps",
  "windows"
].sort());
const PROCESS_STATUS_KEYS = Object.freeze([
  "exitCode", "signal", "stderrStored", "stdoutStored", "timedOut"
].sort());
const FIRST_FAILURE_KEYS = Object.freeze([
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
const BACKUP_RESTORE_PROVENANCE_KEYS = Object.freeze([
  "boundary",
  "causalCode",
  "externalTransportProcessStarted",
  "operation",
  "substep",
  "substepExact"
].sort());
const FORBIDDEN_EVIDENCE_KEY =
  /(?:^|_)(?:aad|app_secret|authorization_handle|body|ciphertext|code|company_id|headers|jti|nonce|oauth_state|state|tag|token|url|user_id)(?:$|_)/i;

class Social3B0PhysicalGateFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "Social3B0PhysicalGateFailure";
    this.code = code;
  }
}

function fail(code) {
  throw new Social3B0PhysicalGateFailure(code);
}

function failureCode(error, fallback = "social_3b0_physical_gate_failed") {
  const value = String(error?.code || "");
  return SAFE_FAILURE.test(value) ? value : fallback;
}

function closedFirstFailure(input = {}) {
  return Object.freeze({
    job: input.job === "linux_physical_gates"
      ? "linux_physical_gates"
      : "linux_physical_gate",
    phase: SAFE_FAILURE.test(String(input.phase || ""))
      ? String(input.phase)
      : PHASE,
    substep: SAFE_SUBSTEP.test(String(input.substep || ""))
      ? String(input.substep)
      : null,
    lastCompletedSubstep: SAFE_SUBSTEP.test(
      String(input.lastCompletedSubstep || "")
    ) ? String(input.lastCompletedSubstep) : null,
    causalCode: SAFE_FAILURE.test(String(input.causalCode || ""))
      ? String(input.causalCode)
      : "social_3b0_physical_gate_failed",
    externalProcessStarted: new Set([true, false, null]).has(
      input.externalProcessStarted
    ) ? input.externalProcessStarted : null,
    exitCode: Number.isSafeInteger(input.exitCode) && input.exitCode >= 0
      ? input.exitCode
      : null,
    signal: SIGNALS.has(input.signal) ? input.signal : null,
    timedOut: input.timedOut === true
  });
}

function plainObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value, expected) {
  return plainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!plainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])])
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function zeroResiduals() {
  return Object.freeze(Object.fromEntries(RESIDUAL_KEYS.map((key) => [key, 0])));
}

function zeroCounts() {
  return Object.freeze(Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])));
}

function skippedSubsteps() {
  return Object.freeze(SUBSTEP_IDS.map((id) => Object.freeze({ id, status: "skipped" })));
}

function walkEvidence(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value !== "object") return true;
  if (depth > 8 || seen.has(value)) return false;
  seen.add(value);
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  for (const [key, item] of entries) {
    if (!Array.isArray(value) && FORBIDDEN_EVIDENCE_KEY.test(key)) return false;
    if (!walkEvidence(item, seen, depth + 1)) return false;
  }
  seen.delete(value);
  return true;
}

function validFirstFailure(value, status) {
  if (status === "passed") return value === null;
  return exactKeys(value, FIRST_FAILURE_KEYS) &&
    SAFE_FAILURE.test(value.causalCode) &&
    new Set(["linux_physical_gate", "linux_physical_gates"]).has(value.job) &&
    typeof value.phase === "string" &&
    SAFE_FAILURE.test(value.phase) &&
    (value.substep === null || SAFE_SUBSTEP.test(value.substep)) &&
    (value.lastCompletedSubstep === null || (
      typeof value.lastCompletedSubstep === "string" &&
        SAFE_SUBSTEP.test(value.lastCompletedSubstep)
    )) &&
    new Set([true, false, null]).has(value.externalProcessStarted) &&
    (value.exitCode === null || (
      Number.isSafeInteger(value.exitCode) && value.exitCode >= 0
    )) &&
    (value.signal === null || SIGNALS.has(value.signal)) &&
    typeof value.timedOut === "boolean";
}

function validBackupRestoreFailureProvenance(value) {
  return value === null || (
    exactKeys(value, BACKUP_RESTORE_PROVENANCE_KEYS) &&
    ["string"].includes(typeof value.operation) &&
    SAFE_FAILURE.test(value.operation) &&
    typeof value.substep === "string" && SAFE_FAILURE.test(value.substep) &&
    typeof value.boundary === "string" && SAFE_FAILURE.test(value.boundary) &&
    typeof value.causalCode === "string" && SAFE_FAILURE.test(value.causalCode) &&
    new Set([true, false, null]).has(value.externalTransportProcessStarted) &&
    typeof value.substepExact === "boolean"
  );
}

function evidenceSafe(candidate) {
  if (!exactKeys(candidate, EVIDENCE_KEYS) || !walkEvidence(candidate)) return false;
  if (
    candidate.format !== 1 ||
    candidate.kind !== "ia4tube-social-3b0-instagram-oauth-local-contract" ||
    candidate.branch !== BRANCH ||
    !COMMIT_SHA.test(candidate.sha) ||
    candidate.runAttempt !== 1 ||
    candidate.phase !== PHASE ||
    candidate.image !== IMAGE ||
    !new Set(["passed", "failed"]).has(candidate.status) ||
    !exactKeys(candidate.windows, ["status"]) ||
    candidate.windows.status !== "passed" ||
    !exactKeys(candidate.preGateLinux, ["status"]) ||
    candidate.preGateLinux.status !== "passed" ||
    !Array.isArray(candidate.gates1To5) ||
    candidate.gates1To5.length !== GATE_DEFINITIONS.length ||
    !Array.isArray(candidate.substeps) ||
    candidate.substeps.length !== SUBSTEP_IDS.length ||
    !validFirstFailure(candidate.firstFailure, candidate.status) ||
    !validBackupRestoreFailureProvenance(
      candidate.backupRestoreFailureProvenance
    ) ||
    !exactKeys(candidate.secretScan, [
      "historicPhysicalPassed", "oauthEvidencePassed", "status"
    ].sort()) ||
    !new Set(["passed", "failed", "not_run"]).has(candidate.secretScan.status) ||
    typeof candidate.secretScan.historicPhysicalPassed !== "boolean" ||
    typeof candidate.secretScan.oauthEvidencePassed !== "boolean" ||
    (candidate.secretScan.status === "passed") !== (
      candidate.secretScan.historicPhysicalPassed === true &&
      candidate.secretScan.oauthEvidencePassed === true
    ) ||
    (candidate.secretScan.status === "not_run" &&
      candidate.secretScan.oauthEvidencePassed !== false) ||
    !exactKeys(candidate.cleanup, [
      "cleanupCompleted",
      "intermediateEvidenceRemoved",
      "syntheticMaterialsCleared"
    ].sort()) ||
    typeof candidate.cleanup.cleanupCompleted !== "boolean" ||
    typeof candidate.cleanup.intermediateEvidenceRemoved !== "boolean" ||
    typeof candidate.cleanup.syntheticMaterialsCleared !== "boolean" ||
    !exactKeys(candidate.residuals, RESIDUAL_KEYS) ||
    Object.values(candidate.residuals).some((value) =>
      !Number.isSafeInteger(value) || value < 0
    ) ||
    !exactKeys(candidate.counts, COUNT_KEYS) ||
    Object.values(candidate.counts).some((value) =>
      !Number.isSafeInteger(value) || value < 0
    )
  ) return false;
  for (let index = 0; index < GATE_DEFINITIONS.length; index += 1) {
    const expected = GATE_DEFINITIONS[index];
    const observed = candidate.gates1To5[index];
    if (
      !exactKeys(observed, ["id", "phase", "status"]) ||
      observed.id !== expected.id ||
      observed.phase !== expected.phase ||
      !new Set(["passed", "failed", "skipped"]).has(observed.status)
    ) return false;
  }
  for (let index = 0; index < SUBSTEP_IDS.length; index += 1) {
    const observed = candidate.substeps[index];
    if (
      !exactKeys(observed, ["id", "status"]) ||
      observed.id !== SUBSTEP_IDS[index] ||
      !new Set(["passed", "failed", "skipped"]).has(observed.status)
    ) return false;
  }
  const cleanupSubstepStatus = candidate.substeps[21].status;
  if (
    (candidate.cleanup.cleanupCompleted === true &&
      cleanupSubstepStatus !== "passed") ||
    (candidate.cleanup.cleanupCompleted === false &&
      cleanupSubstepStatus === "passed")
  ) return false;
  for (const key of [
    "externalGraphApiCalls",
    "externalInstagramCalls",
    "externalMetaCalls",
    "externalPublicationCalls",
    "publicationCalls",
    "realTokenCount"
  ]) {
    if (candidate[key] !== 0) return false;
  }
  if (candidate.status === "passed") {
    if (
      candidate.gates1To5.some((entry) => entry.status !== "passed") ||
      candidate.substeps.some((entry) => entry.status !== "passed") ||
      candidate.secretScan.status !== "passed" ||
      candidate.secretScan.historicPhysicalPassed !== true ||
      candidate.secretScan.oauthEvidencePassed !== true ||
      candidate.backupRestoreFailureProvenance !== null ||
      candidate.cleanup.cleanupCompleted !== true ||
      candidate.cleanup.intermediateEvidenceRemoved !== true ||
      candidate.cleanup.syntheticMaterialsCleared !== true ||
      canonicalJson(candidate.counts) !== canonicalJson(EXPECTED_COUNTS) ||
      Object.values(candidate.residuals).some((value) => value !== 0)
    ) return false;
  }
  return true;
}

function sanitizeProcessStatus(candidate) {
  if (
    !exactKeys(candidate, PROCESS_STATUS_KEYS) ||
    !(candidate.exitCode === null || (
      Number.isSafeInteger(candidate.exitCode) && candidate.exitCode >= 0
    )) ||
    !(candidate.signal === null || SIGNALS.has(candidate.signal)) ||
    typeof candidate.timedOut !== "boolean" ||
    candidate.stdoutStored !== false ||
    candidate.stderrStored !== false ||
    (candidate.signal !== null && candidate.exitCode !== null) ||
    (candidate.timedOut && candidate.exitCode !== null)
  ) return null;
  return Object.freeze({
    exitCode: candidate.exitCode,
    signal: candidate.signal,
    timedOut: candidate.timedOut,
    stdoutStored: false,
    stderrStored: false
  });
}

function validateEnvironment(environment = process.env) {
  if (
    !environment ||
    environment.SOCIAL_3B0_BRANCH !== BRANCH ||
    !COMMIT_SHA.test(String(environment.SOCIAL_3B0_SHA || "")) ||
    environment.SOCIAL_3B0_RUN_ATTEMPT !== "1" ||
    environment.SOCIAL_3B0_WINDOWS_STATUS !== "passed" ||
    environment.SOCIAL_3B0_PRE_GATE_STATUS !== "passed" ||
    environment.SOCIAL_3B0_POSTGRES_IMAGE !== IMAGE ||
    environment.POSTGRES_CONNECTIVITY_MODE !== "internal_bridge_direct_v1" ||
    environment.POSTGRES_BACKUP_CONNECTIVITY_MODE !==
      "logical_dns_to_internal_container_v1" ||
    environment.SOCIAL_3A0P_POSTGRES_IMAGE !== IMAGE ||
    environment.SOCIAL_INSTAGRAM_ENABLED !== "false" ||
    environment.SOCIAL_EXTERNAL_CONNECTION_ENABLED !== "false" ||
    environment.SOCIAL_EXTERNAL_PUBLICATION_ENABLED !== "false"
  ) fail("social_3b0_environment_invalid");
  return Object.freeze({
    branch: BRANCH,
    sha: environment.SOCIAL_3B0_SHA,
    runAttempt: 1
  });
}

function runNumber(environment = process.env) {
  const digits = String(environment.GITHUB_RUN_ID || "").replace(/[^0-9]/g, "");
  if (!/^[0-9]{1,30}$/.test(digits)) fail("social_3b0_run_id_invalid");
  return digits;
}

function within(candidate, root, code) {
  const absolute = path.resolve(String(candidate || ""));
  const base = path.resolve(String(root || ""));
  const relative = path.relative(base, absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) fail(code);
  return absolute;
}

function artifactPaths({ runnerTemp, outputPath, processStatusPath }) {
  const root = path.resolve(String(runnerTemp || ""));
  if (!path.isAbsolute(root) || root === path.parse(root).root) {
    fail("social_3b0_runner_temp_invalid");
  }
  const directory = within(path.join(root, ARTIFACT_DIRECTORY), root,
    "social_3b0_artifact_directory_invalid");
  const evidence = path.resolve(String(outputPath || ""));
  const processStatus = path.resolve(String(processStatusPath || ""));
  if (
    evidence !== path.join(directory, EVIDENCE_FILE) ||
    processStatus !== path.join(directory, PROCESS_STATUS_FILE)
  ) fail("social_3b0_artifact_path_invalid");
  return Object.freeze({
    directory,
    evidence,
    evidenceHash: path.join(directory, EVIDENCE_HASH_FILE),
    processStatus,
    processStatusHash: path.join(directory, PROCESS_STATUS_HASH_FILE)
  });
}

function writePayload(file, hashFile, payload) {
  const serialized = `${canonicalJson(payload)}\n`;
  const digest = sha256(serialized);
  fs.writeFileSync(file, serialized, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(
    hashFile,
    `${digest}  ${path.basename(file)}\n`,
    { flag: "wx", mode: 0o600 }
  );
  return digest;
}

function removeExactRegularFile(file) {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("social_3b0_artifact_entry_invalid");
  }
  fs.unlinkSync(file);
}

function replacePayload(file, hashFile, payload) {
  removeExactRegularFile(file);
  removeExactRegularFile(hashFile);
  return writePayload(file, hashFile, payload);
}

function verifySidecar(file, hashFile) {
  const serialized = fs.readFileSync(file);
  const line = fs.readFileSync(hashFile, "utf8");
  const match = line.match(/^([0-9a-f]{64})  ([a-z0-9._-]+)\n$/);
  if (
    !match ||
    match[2] !== path.basename(file) ||
    match[1] !== sha256(serialized)
  ) fail("social_3b0_sidecar_invalid");
  return match[1];
}

function parseJsonFile(file, code) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(code);
  }
  if (!plainObject(parsed)) fail(code);
  return parsed;
}

function containsSyntheticMarkerInTree(root, markers) {
  const needles = markers
    .filter((value) => typeof value === "string" && value.length >= 16)
    .map((value) => Buffer.from(value, "utf8"));
  let filesScanned = 0;
  let bytesScanned = 0;
  function scanFile(file) {
    const descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const overlap = Math.max(1, ...needles.map((needle) => needle.length));
    let carry = Buffer.alloc(0);
    const block = Buffer.alloc(1024 * 1024);
    try {
      while (true) {
        const read = fs.readSync(descriptor, block, 0, block.length, null);
        if (read === 0) break;
        bytesScanned += read;
        const combined = Buffer.concat([carry, block.subarray(0, read)]);
        const present = needles.some((needle) => combined.indexOf(needle) >= 0);
        carry.fill(0);
        if (present) {
          combined.fill(0);
          return true;
        }
        carry = Buffer.from(combined.subarray(
          Math.max(0, combined.length - overlap + 1)
        ));
        combined.fill(0);
      }
      filesScanned += 1;
      return false;
    } finally {
      carry.fill(0);
      block.fill(0);
      fs.closeSync(descriptor);
    }
  }
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) fail("social_3b0_secret_scan_symlink_refused");
      if (stat.isDirectory()) {
        if (walk(target)) return true;
      } else if (stat.isFile()) {
        if (scanFile(target)) return true;
      } else {
        fail("social_3b0_secret_scan_special_file_refused");
      }
    }
    return false;
  }
  const present = fs.existsSync(root) ? walk(root) : false;
  for (const needle of needles) needle.fill(0);
  return Object.freeze({ present, filesScanned, bytesScanned });
}

function childOnce(executable, args, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = options.timeoutMs || WORKER_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs || KILL_GRACE_MS;
  const platform = options.platform || process.platform;
  const processKill = options.processKill || process.kill;
  const ownsProcessGroup = options.ownsProcessGroup === true &&
    platform !== "win32";
  const groupAlive = (child) => {
    if (!ownsProcessGroup || !Number.isSafeInteger(child?.pid) || child.pid < 1) {
      return false;
    }
    try {
      processKill(-child.pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  };
  const signalChildTree = (child, signal) => {
    if (ownsProcessGroup && Number.isSafeInteger(child?.pid) && child.pid > 0) {
      try {
        processKill(-child.pid, signal);
        return;
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
        return;
      }
    }
    child.kill(signal);
  };
  const reapOwnedGroup = async (child) => {
    if (!groupAlive(child)) return 0;
    try { signalChildTree(child, "SIGKILL"); } catch {}
    const deadline = Date.now() + killGraceMs;
    while (groupAlive(child) && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    return groupAlive(child) ? 1 : 0;
  };
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let started = false;
    let killTimer = null;
    try {
      child = spawnImpl(executable, args, {
        cwd: options.cwd,
        env: options.environment,
        stdio: "ignore",
        windowsHide: true,
        detached: ownsProcessGroup
      });
    } catch {
      resolve(Object.freeze({
        exitCode: null,
        signal: null,
        timedOut: false,
        started: false,
        processResiduals: 0
      }));
      return;
    }
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      void (async () => {
        const processResiduals = await reapOwnedGroup(child);
        resolve(Object.freeze({
          exitCode: signal || timedOut ? null : exitCode,
          signal: signal == null ? null : String(signal),
          timedOut,
          started,
          processResiduals
        }));
      })();
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try { signalChildTree(child, "SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        try { signalChildTree(child, "SIGKILL"); } catch {}
      }, killGraceMs);
    }, timeoutMs);
    child.once("spawn", () => { started = true; });
    child.once("error", () => finish(null, null));
    child.once("close", finish);
  });
}

function historicDirectory(runnerTemp, environment = process.env) {
  const suffix = sha256(`social-3b0:${runNumber(environment)}`).slice(0, 16);
  return within(
    path.join(runnerTemp, `${HISTORIC_DIRECTORY_PREFIX}${suffix}`),
    runnerTemp,
    "social_3b0_historic_directory_invalid"
  );
}

function historicFailureDetails({
  historic,
  evidence,
  firstPhase,
  lastCompletedPhase,
  backupRestoreFailureProvenance
} = {}) {
  const firstCode = String(evidence?.firstFailure?.code || "");
  if (!SAFE_FAILURE.test(firstCode)) return null;
  let candidate = null;
  if (new Set([
    "rls_privilege_inventory_context_reproduction",
    "rls_runtime_write_contract_reproduction",
    "rls_runtime_attributes_text_resolution_reproduction",
    "rls_roles"
  ]).has(firstPhase)) {
    const provenance = historic?.sanitizedRlsFailureProvenance?.(
      evidence?.rlsFailureProvenance
    );
    if (provenance?.causalCode === firstCode) {
      candidate = {
        substep: provenance.substep,
        lastCompletedSubstep: lastCompletedPhase,
        causalCode: provenance.causalCode,
        externalProcessStarted: null,
        exitCode: null,
        signal: null
      };
    }
  } else if (firstPhase === "concurrency_oauth_idempotency") {
    const provenance = historic?.sanitizedGate3FailureProvenance?.(
      evidence?.gate3FailureProvenance
    );
    if (provenance?.causalCode === firstCode) candidate = provenance;
  } else if (firstPhase === "vault") {
    const provenance = historic?.sanitizedGate4FailureProvenance?.(
      evidence?.gate4FailureProvenance
    );
    if (provenance?.causalCode === firstCode) candidate = provenance;
  } else if (
    firstPhase === "backup_restore" &&
    backupRestoreFailureProvenance?.causalCode === firstCode
  ) {
    candidate = {
      substep: backupRestoreFailureProvenance.substep,
      lastCompletedSubstep: lastCompletedPhase,
      causalCode: backupRestoreFailureProvenance.causalCode,
      externalProcessStarted:
        backupRestoreFailureProvenance.externalTransportProcessStarted,
      exitCode: null,
      signal: null
    };
  }
  if (!candidate) return null;
  return Object.freeze({
    substep: SAFE_SUBSTEP.test(String(candidate.substep || ""))
      ? String(candidate.substep)
      : null,
    lastCompletedSubstep: SAFE_SUBSTEP.test(
      String(candidate.lastCompletedSubstep || "")
    ) ? String(candidate.lastCompletedSubstep) : null,
    causalCode: firstCode,
    externalProcessStarted: new Set([true, false, null]).has(
      candidate.externalProcessStarted
    ) ? candidate.externalProcessStarted : null,
    exitCode: Number.isSafeInteger(candidate.exitCode) && candidate.exitCode >= 0
      ? candidate.exitCode
      : null,
    signal: SIGNALS.has(candidate.signal) ? candidate.signal : null
  });
}

async function runHistoricPhysicalGates(options = {}) {
  const runnerTemp = path.resolve(options.runnerTemp);
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const evidenceDirectory = historicDirectory(runnerTemp, options.environment);
  if (fs.existsSync(evidenceDirectory)) fail("social_3b0_historic_collision");
  const historicScript = path.join(
    repositoryRoot,
    "scripts",
    "social-3a0p-linux-gate.js"
  );
  const child = await childOnce(process.execPath, [historicScript, "--supervise-run"], {
    spawnImpl: options.spawnImpl,
    timeoutMs: options.timeoutMs || HISTORIC_TIMEOUT_MS,
    killGraceMs: options.killGraceMs,
    cwd: repositoryRoot,
    // Keep this supervisor and its child in the outer 3B worker's owned
    // process group. A second detached group could survive an outer crash.
    ownsProcessGroup: false,
    environment: Object.freeze({
      ...options.environment,
      RUNNER_TEMP: runnerTemp,
      SOCIAL_3A0P_EVIDENCE_DIR: evidenceDirectory
    })
  });
  const historic = require("./social-3a0p-linux-gate");
  const evidenceFile = path.join(evidenceDirectory, historic.EVIDENCE_FILE);
  const evidenceHashFile = path.join(evidenceDirectory, historic.EVIDENCE_HASH_FILE);
  const processFile = path.join(evidenceDirectory, historic.GATE_PROCESS_STATUS_FILE);
  const processHashFile = path.join(
    evidenceDirectory,
    historic.GATE_PROCESS_STATUS_HASH_FILE
  );
  const files = [evidenceFile, evidenceHashFile, processFile, processHashFile];
  let evidence = null;
  let processStatus = null;
  let evidenceValid = false;
  let processValid = false;
  const completeArtifact = files.every((file) => fs.existsSync(file));
  try {
    if (completeArtifact) {
      verifySidecar(evidenceFile, evidenceHashFile);
      verifySidecar(processFile, processHashFile);
      evidence = parseJsonFile(
        evidenceFile,
        "social_3b0_historic_evidence_invalid"
      );
      processStatus = parseJsonFile(
        processFile,
        "social_3b0_historic_process_status_invalid"
      );
      evidenceValid = historic.evidenceSafe(evidence) === true;
      processValid = Boolean(historic.sanitizedGateProcessStatus(processStatus));
    }
  } finally {
    if (fs.existsSync(evidenceDirectory)) {
      fs.rmSync(evidenceDirectory, {
        recursive: true,
        force: false,
        maxRetries: 0
      });
    }
  }
  if (fs.existsSync(evidenceDirectory)) {
    fail("social_3b0_historic_evidence_cleanup_failed");
  }

  const phases = evidenceValid && Array.isArray(evidence.phases)
    ? evidence.phases
    : [];
  const firstPhase = evidenceValid && SAFE_FAILURE.test(
    String(evidence.firstFailure?.phase || "")
  ) ? evidence.firstFailure.phase : "gates_1_5";
  const gates = GATE_DEFINITIONS.map((definition) => {
    const observed = phases.find((entry) => entry?.name === definition.phase);
    const gate2Failure = definition.id === "G02" && new Set([
      "rls_privilege_inventory_context_reproduction",
      "rls_runtime_write_contract_reproduction",
      "rls_runtime_attributes_text_resolution_reproduction",
      "rls_roles"
    ]).has(firstPhase);
    const status = observed?.status === "passed"
      ? "passed"
      : observed?.status === "failed" || firstPhase === definition.phase ||
          gate2Failure
        ? "failed"
        : "skipped";
    return Object.freeze({ ...definition, status });
  });
  const failedPhaseIndex = phases.findIndex((entry) => entry?.name === firstPhase);
  const completedBeforeFailure = failedPhaseIndex >= 0
    ? phases.slice(0, failedPhaseIndex)
    : evidenceValid && evidence.firstFailure
      ? []
      : phases;
  const lastCompleted = [...completedBeforeFailure].reverse().find((entry) => (
    entry?.status === "passed" && SAFE_FAILURE.test(String(entry.name || ""))
  ));
  const backupRestoreFailureProvenance = evidenceValid
    ? historic.sanitizedBackupRestoreFailureProvenance(
      evidence.backupRestoreFailureProvenance
    )
    : null;
  const observedProcess = processValid ? processStatus : Object.freeze({
    exitCode: child.signal || child.timedOut ? null : child.exitCode,
    signal: child.signal,
    timedOut: child.timedOut === true
  });
  const secretScanPassed = phases.some((entry) => (
    entry?.name === "secret_scan" && entry?.status === "passed"
  ));
  const ok = evidenceValid && processValid && child.exitCode === 0 &&
    child.signal === null && child.timedOut === false &&
    processStatus.exitCode === 0 && processStatus.signal === null &&
    processStatus.timedOut === false && evidence.status === "passed" &&
    evidence.firstFailure === null &&
    backupRestoreFailureProvenance === null &&
    evidence.cleanup?.cleanupCompleted === true && secretScanPassed &&
    child.processResiduals === 0 &&
    gates.every((gate) => gate.status === "passed");
  const causalCode = child.processResiduals > 0
    ? "social_3b0_historic_process_residual"
    : evidenceValid && SAFE_FAILURE.test(
    String(evidence.firstFailure?.code || "")
  ) ? evidence.firstFailure.code : (
    completeArtifact
      ? "social_3b0_historic_evidence_invalid"
      : "social_3b0_historic_evidence_missing"
  );
  const historicFailure = evidenceValid ? historicFailureDetails({
    historic,
    evidence,
    firstPhase,
    lastCompletedPhase: lastCompleted?.name || null,
    backupRestoreFailureProvenance
  }) : null;
  return Object.freeze({
    ok,
    gates1To5: Object.freeze(gates),
    backupRestoreFailureProvenance,
    historicSecretScanPassed: secretScanPassed,
    processResiduals: child.processResiduals,
    firstFailure: ok ? null : closedFirstFailure({
      job: "linux_physical_gates",
      phase: firstPhase,
      substep: historicFailure?.substep || null,
      lastCompletedSubstep: historicFailure?.lastCompletedSubstep ||
        lastCompleted?.name || null,
      causalCode: historicFailure?.causalCode || causalCode,
      externalProcessStarted: historicFailure
        ? historicFailure.externalProcessStarted
        : child.started,
      exitCode: historicFailure ? historicFailure.exitCode : observedProcess.exitCode,
      signal: historicFailure ? historicFailure.signal : observedProcess.signal,
      timedOut: observedProcess.timedOut
    }),
    intermediateEvidenceRemoved: true
  });
}

function createStepLedger() {
  const entries = SUBSTEP_IDS.map((id) => ({ id, status: "skipped" }));
  let next = 0;
  let firstFailure = null;
  async function run(id, operation) {
    if (id !== SUBSTEP_IDS[next] || typeof operation !== "function") {
      fail("social_3b0_substep_order_invalid");
    }
    const entry = entries[next];
    try {
      const result = await operation();
      entry.status = "passed";
      next += 1;
      return result;
    } catch (error) {
      entry.status = "failed";
      if (!firstFailure) {
        firstFailure = closedFirstFailure({
          phase: PHASE,
          substep: id,
          lastCompletedSubstep: next === 0 ? null : SUBSTEP_IDS[next - 1],
          causalCode: failureCode(error)
        });
      }
      throw error;
    }
  }
  return Object.freeze({
    run,
    failCleanup(error) {
      const cleanup = entries[21];
      cleanup.status = "failed";
      if (!firstFailure) {
        firstFailure = closedFirstFailure({
          phase: PHASE,
          substep: "O22",
          lastCompletedSubstep: entries[20].status === "passed" ? "O21" : null,
          causalCode: failureCode(error, "social_3b0_cleanup_failed")
        });
      }
    },
    passCleanup() {
      entries[21].status = "passed";
    },
    firstFailure() { return firstFailure; },
    snapshot() {
      return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
    }
  });
}

function createManualTimer() {
  let handle = null;
  let pending = false;
  let setCalls = 0;
  let clearCalls = 0;
  return Object.freeze({
    setTimeout(callback) {
      if (handle || typeof callback !== "function") {
        fail("social_3b0_timer_contract_invalid");
      }
      handle = Object.freeze({ id: ++setCalls, callback });
      pending = true;
      return handle;
    },
    clearTimeout(candidate) {
      // Real timers may still be cleared after their callback fired.  Preserve
      // the handle until the provider's finally block performs that clear.
      if (!handle || candidate !== handle) {
        fail("social_3b0_timer_contract_invalid");
      }
      clearCalls += 1;
      handle = null;
      pending = false;
    },
    fire() {
      if (!handle || !pending) fail("social_3b0_timer_contract_invalid");
      const callback = handle.callback;
      pending = false;
      callback();
    },
    snapshot() {
      return Object.freeze({
        active: pending ? 1 : 0,
        clearCalls,
        setCalls
      });
    }
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return Object.freeze({ promise, resolve, reject });
}

async function settleUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  fail("social_3b0_async_fixture_stalled");
}

function streamJson(payload, readers) {
  const source = Buffer.from(JSON.stringify(payload), "utf8");
  readers.add(source);
  let emitted = false;
  return Object.freeze({
    status: 200,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: Object.freeze({
      getReader() {
        let released = false;
        return Object.freeze({
          async read() {
            if (!emitted) {
              emitted = true;
              return Object.freeze({ done: false, value: source });
            }
            source.fill(0);
            readers.delete(source);
            return Object.freeze({ done: true });
          },
          async cancel() {
            source.fill(0);
            readers.delete(source);
          },
          releaseLock() { released = true; },
          get released() { return released; }
        });
      }
    })
  });
}

function httpJsonRequest({ port, method, route, headers = {}, body = null }) {
  if (
    !Number.isSafeInteger(port) || port < 1 ||
    !route.startsWith("/v1/social/")
  ) fail("social_3b0_loopback_request_invalid");
  const payload = body === null ? null : Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: LOOPBACK,
      port,
      method,
      path: route,
      headers: {
        accept: "application/json",
        ...(payload ? {
          "content-type": "application/json",
          "content-length": String(payload.length)
        } : {}),
        ...headers
      }
    }, (response) => {
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > 64 * 1024) {
          response.destroy();
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once("end", () => {
        const serialized = Buffer.concat(chunks, total);
        for (const chunk of chunks) chunk.fill(0);
        let value;
        try { value = JSON.parse(serialized.toString("utf8")); }
        catch { value = null; }
        serialized.fill(0);
        resolve(Object.freeze({ status: response.statusCode, value }));
      });
      response.once("error", reject);
    });
    request.once("error", reject);
    if (payload) request.write(payload);
    request.end();
    if (payload) payload.fill(0);
  });
}

function listenLoopback(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    const sockets = new Set();
    SERVER_SOCKETS.set(server, sockets);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      if (
        !address || typeof address === "string" ||
        address.address !== LOOPBACK ||
        !Number.isSafeInteger(address.port)
      ) {
        server.close();
        reject(new Social3B0PhysicalGateFailure(
          "social_3b0_loopback_listener_invalid"
        ));
        return;
      }
      resolve(Object.freeze({ server, port: address.port }));
    });
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

function installApplicationNetworkGuard(allowedHosts) {
  const allowed = new Set([...allowedHosts].map((value) => String(value)));
  const originals = Object.freeze({
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
    socketConnect: net.Socket.prototype.connect,
    tlsConnect: tls.connect,
    dnsLookup: dns.lookup,
    fetch: globalThis.fetch
  });
  let deniedAttempts = 0;
  let externalConnections = 0;
  let restored = false;
  const hostFrom = (args) => {
    const first = args[0];
    if (Array.isArray(first)) return hostFrom(first);
    if (typeof first === "string" || first instanceof URL) {
      try { return new URL(String(first)).hostname; } catch { return ""; }
    }
    if (first && typeof first === "object") {
      return String(first.hostname || first.host || "").replace(/^\[|\]$/g, "");
    }
    if (Number.isSafeInteger(first) && typeof args[1] === "string") {
      return args[1];
    }
    return "";
  };
  const guarded = (original) => function guardedNetworkOperation(...args) {
    const host = hostFrom(args);
    if (!allowed.has(host)) {
      deniedAttempts += 1;
      fail("social_3b0_non_loopback_network_refused");
    }
    return original.apply(this, args);
  };
  http.request = guarded(originals.httpRequest);
  http.get = guarded(originals.httpGet);
  https.request = guarded(originals.httpsRequest);
  https.get = guarded(originals.httpsGet);
  net.connect = guarded(originals.netConnect);
  net.createConnection = guarded(originals.netCreateConnection);
  net.Socket.prototype.connect = guarded(originals.socketConnect);
  tls.connect = guarded(originals.tlsConnect);
  dns.lookup = function guardedLookup(host, ...args) {
    if (!allowed.has(String(host))) {
      deniedAttempts += 1;
      fail("social_3b0_non_loopback_network_refused");
    }
    return originals.dnsLookup.call(this, host, ...args);
  };
  if (typeof originals.fetch === "function") {
    globalThis.fetch = async function guardedFetch(input, init) {
      const host = hostFrom([input]);
      if (!allowed.has(host)) {
        deniedAttempts += 1;
        fail("social_3b0_non_loopback_network_refused");
      }
      return originals.fetch.call(this, input, init);
    };
  }
  return Object.freeze({
    snapshot() {
      return Object.freeze({ deniedAttempts, externalConnections, restored });
    },
    restore() {
      if (restored) return;
      http.request = originals.httpRequest;
      http.get = originals.httpGet;
      https.request = originals.httpsRequest;
      https.get = originals.httpsGet;
      net.connect = originals.netConnect;
      net.createConnection = originals.netCreateConnection;
      net.Socket.prototype.connect = originals.socketConnect;
      tls.connect = originals.tlsConnect;
      dns.lookup = originals.dnsLookup;
      if (typeof originals.fetch === "function") globalThis.fetch = originals.fetch;
      restored = true;
    }
  });
}

function syntheticClaims(label) {
  const legacy = `synthetic-linux-${label}`;
  const { SESSION_AUDIENCE, SESSION_ISSUER } = require("../src/social/reauth");
  return Object.freeze({
    token_version: 2,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    jti: `synthetic-linux-jwt-${label}`,
    sub: legacy,
    whatsapp: legacy,
    company_id: legacy
  });
}

async function runBlockedBodyProof(config, dependencies = {}) {
  const { createInstagramProvider } = require(
    "../src/social/oauth/instagram-provider"
  );
  const timer = (dependencies.createManualTimer || createManualTimer)();
  const blocked = deferred();
  let reads = 0;
  let cancels = 0;
  let releases = 0;
  let signal = null;
  const provider = createInstagramProvider({
    config,
    timeoutMs: 5000,
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    transport: async (_url, options) => {
      signal = options.signal;
      return Object.freeze({
        status: 200,
        headers: Object.freeze({ "content-type": "application/json" }),
        body: Object.freeze({
          getReader() {
            return Object.freeze({
              read() { reads += 1; return blocked.promise; },
              cancel() {
                cancels += 1;
                const error = new Error("closed");
                error.name = "AbortError";
                blocked.reject(error);
                return Promise.resolve();
              },
              releaseLock() { releases += 1; }
            });
          }
        })
      });
    }
  });
  const operation = provider.exchangeCode({
    code: crypto.randomBytes(24).toString("base64url")
  });
  await settleUntil(() => reads === 1);
  timer.fire();
  let refused = false;
  try { await operation; }
  catch (error) { refused = error?.code === "social_oauth_exchange_failed"; }
  await settleUntil(() => cancels === 1);
  const snapshot = timer.snapshot();
  if (
    !refused || reads !== 1 || cancels !== 1 || releases !== 1 ||
    signal?.aborted !== true || snapshot.active !== 0 ||
    snapshot.setCalls !== 1 || snapshot.clearCalls !== 1
  ) fail("social_3b0_blocked_body_timeout_invalid");
  return snapshot;
}

async function runPhysicalOAuthContract(options = {}) {
  const ledger = createStepLedger();
  const counts = { ...zeroCounts() };
  const external = {
    graph: 0,
    instagram: 0,
    meta: 0,
    publication: 0,
    realTokens: 0
  };
  const readers = new Set();
  const materials = [];
  const sensitiveStrings = new Set();
  const rememberSensitive = (value) => {
    const text = String(value || "");
    if (text.length >= 16) sensitiveStrings.add(text);
    return text;
  };
  let postgres;
  let bootstrap;
  let stateEnvelope;
  let vault;
  let server;
  let serverPort = 0;
  let authorizationHeader = "";
  let concurrentAuthorizationHeader = "";
  let cancellationAuthorizationHeader = "";
  let isolationAuthorizationHeader = "";
  let physicalFailure = null;
  let cleanupFailure = null;
  let vaultEncryptCalls = 0;
  let credentialStoreCalls = 0;
  let timerResiduals = 0;
  let networkGuard = null;
  const providerTransportCalls = {
    tokenExchange: 0,
    mediaContainer: 0,
    mediaPublish: 0,
    permalink: 0
  };
  let cleanup = {
    cleanupCompleted: false,
    intermediateEvidenceRemoved: true,
    syntheticMaterialsCleared: false
  };
  let residuals = { ...zeroResiduals(), temporaryRoots: 1 };
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const runnerTemp = path.resolve(options.runnerTemp);
  const environment = options.environment;
  const runId = `social-3b0-${runNumber(environment)}`;
  try {
    const { Pool } = require("pg");
    const { createPoolMetricsRegistry } = require(
      "./social-3a0p-local-runtime-evidence-metrics"
    );
    const {
      DATABASE,
      MIGRATION_LOGIN,
      MIGRATOR_ROLE,
      OWNER_ROLE,
      RUNTIME_ROLE,
      createLinuxPostgres
    } = require("./social-3a0p-linux-postgres");
    const { createTenant, seedTenant } = require(
      "./social-3a0p-linux-physical-gates"
    );
    const migrations = require("../src/persistence/postgres/migrations");
    const { withTransaction } = require("../src/persistence/postgres/pool");
    const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
    const { createSocialRepository } = require(
      "../src/persistence/postgres/social-repository"
    );
    const { createPostgresOAuthRepository } = require(
      "../src/persistence/postgres/social-oauth-repository"
    );
    const { createSocialCredentialService } = require(
      "../src/social/credential-service"
    );
    const {
      deriveVaultKeyVersion,
      vaultKeyringFingerprint
    } = require("../src/social/vault-key-version");
    const { createSocialVault } = require("../src/social/vault");
    const { createVaultKeyRegistryAdmin } = require(
      "../src/persistence/postgres/vault-key-registry-admin"
    );
    const {
      INSTAGRAM_OAUTH_REDIRECT_URI,
      INSTAGRAM_PROVIDER,
      INSTAGRAM_TOKEN_ENDPOINT,
      loadInstagramOAuthConfig
    } = require("../src/social/oauth/instagram-config");
    const { createInstagramOAuthStateEnvelope } = require(
      "../src/social/oauth/instagram-state-envelope"
    );
    const { createInstagramProvider } = require(
      "../src/social/oauth/instagram-provider"
    );
    const { createInstagramOAuthService } = require(
      "../src/social/oauth/instagram-oauth-service"
    );
    const { createInstagramOAuthRouter } = require(
      "../src/social/oauth/instagram-oauth-router"
    );
    const express = require("express");

    let config;
    await ledger.run("O01", async () => {
      const disabled = loadInstagramOAuthConfig(Object.freeze({}));
      if (
        disabled.enabled !== false ||
        disabled.instagramEnabled !== false ||
        disabled.externalConnectionEnabled !== false ||
        disabled.externalPublicationEnabled !== false
      ) fail("social_3b0_default_flags_not_closed");
      const applicationId = Buffer.from(
        String(10000 + crypto.randomInt(89999)),
        "utf8"
      );
      const applicationMaterial = crypto.randomBytes(32);
      const identityMaterial = crypto.randomBytes(32);
      const vaultMaterial = crypto.randomBytes(32);
      const bearerMaterials = Array.from({ length: 4 }, () =>
        crypto.randomBytes(32)
      );
      materials.push(
        applicationId,
        applicationMaterial,
        identityMaterial,
        vaultMaterial,
        ...bearerMaterials
      );
      rememberSensitive(applicationMaterial.toString("base64url"));
      rememberSensitive(identityMaterial.toString("base64url"));
      rememberSensitive(vaultMaterial.toString("base64url"));
      for (const material of bearerMaterials) {
        rememberSensitive(material.toString("base64url"));
      }
      config = loadInstagramOAuthConfig(Object.freeze({
        SOCIAL_INSTAGRAM_ENABLED: "true",
        SOCIAL_EXTERNAL_CONNECTION_ENABLED: "true",
        SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false",
        INSTAGRAM_APP_ID: applicationId.toString("utf8"),
        INSTAGRAM_APP_SECRET: applicationMaterial.toString("base64url"),
        INSTAGRAM_OAUTH_REDIRECT_URI,
        INSTAGRAM_GRAPH_API_VERSION: "v24.0"
      }));
      [
        authorizationHeader,
        concurrentAuthorizationHeader,
        cancellationAuthorizationHeader,
        isolationAuthorizationHeader
      ] = bearerMaterials.map((material) =>
        `Bearer ${material.toString("base64url")}`
      );
      if (!config.enabled || config.externalPublicationEnabled !== false) {
        fail("social_3b0_synthetic_configuration_invalid");
      }
    });

    await ledger.run("O02", async () => {
      postgres = (options.createPostgres || createLinuxPostgres)({
        runnerTemp,
        runId,
        PoolClass: options.PoolClass || Pool,
        metricsRegistry: createPoolMetricsRegistry(),
        randomBytes: options.randomBytes
      });
      for (const key of ["admin", "provisioner", "migration", "runtime"]) {
        const material = postgres.materials?.[key];
        if (!Buffer.isBuffer(material) || material.length < 16) {
          fail("social_3b0_postgres_material_invalid");
        }
        rememberSensitive(material.toString("utf8"));
      }
      await postgres.start();
      bootstrap = await postgres.bootstrap(repositoryRoot, crypto.randomUUID());
      const target = {
        approval: migrations.APPLY_APPROVAL,
        productionApproval: "not-applicable-local-harness",
        environment: "local",
        environmentId: await withTransaction(
          bootstrap.pools.migration,
          async (client) => (await client.query(
            "SELECT environment_id FROM ia4tube_migrations.environment_identity WHERE singleton=TRUE"
          )).rows[0].environment_id,
          { role: MIGRATOR_ROLE }
        ),
        host: LOOPBACK,
        port: String(postgres.port),
        database: DATABASE,
        username: MIGRATION_LOGIN
      };
      const runner = migrations.createMigrationRunner({
        pool: bootstrap.pools.migration,
        ownerRole: OWNER_ROLE,
        migratorRole: MIGRATOR_ROLE,
        target,
        manifestOptions: { root: repositoryRoot }
      });
      const applied = await runner.apply({
        SOCIAL_MIGRATION_TARGET_FINGERPRINT: migrations.targetFingerprint(target)
      });
      const validated = await runner.validate();
      if (applied.length !== 4 || validated.applied !== 4 || validated.pending !== 0) {
        fail("social_3b0_migrations_invalid");
      }
    });

    const identityMaterial = materials[2];
    const tenantA = createTenant("oauth-physical-a", {
      identityKey: identityMaterial,
      randomUUID: crypto.randomUUID
    });
    const tenantB = createTenant("oauth-physical-b", {
      identityKey: identityMaterial,
      randomUUID: crypto.randomUUID
    });
    const tenantConcurrent = createTenant("oauth-physical-concurrent", {
      identityKey: identityMaterial,
      randomUUID: crypto.randomUUID
    });
    const tenantCancellation = createTenant("oauth-physical-cancellation", {
      identityKey: identityMaterial,
      randomUUID: crypto.randomUUID
    });
    const tenantIsolationA = createTenant("oauth-physical-isolation-a", {
      identityKey: identityMaterial,
      randomUUID: crypto.randomUUID
    });
    await ledger.run("O03", async () => {
      for (const tenant of [
        tenantA,
        tenantB,
        tenantConcurrent,
        tenantCancellation,
        tenantIsolationA
      ]) {
        await seedTenant(bootstrap.pools.migration, tenant.fixture);
      }
    });
    const claimsA = syntheticClaims("oauth-physical-a");
    const claimsB = syntheticClaims("oauth-physical-b");
    const claimsConcurrent = syntheticClaims("oauth-physical-concurrent");
    const claimsCancellation = syntheticClaims("oauth-physical-cancellation");
    const claimsIsolationA = syntheticClaims("oauth-physical-isolation-a");
    const authAdapter = createSocialAuthAdapter({
      namespaceUuid: IDENTITY_NAMESPACE,
      derivationVersion: IDENTITY_VERSION,
      key: identityMaterial
    });
    await ledger.run("O04", async () => {
      const sessions = [
        [claimsA, tenantA],
        [claimsB, tenantB],
        [claimsConcurrent, tenantConcurrent],
        [claimsCancellation, tenantCancellation],
        [claimsIsolationA, tenantIsolationA]
      ].map(([claims, tenant]) => {
        const principal = authAdapter.fromVerifiedJwt(claims);
        if (
          principal.companyId !== tenant.fixture.companyId ||
          principal.userId !== tenant.fixture.userId ||
          principal.jti !== claims.jti
        ) fail("social_3b0_synthetic_session_invalid");
        return principal;
      });
      const userCounts = await Promise.all([
        tenantA,
        tenantB,
        tenantConcurrent,
        tenantCancellation,
        tenantIsolationA
      ].map((tenant) => withTransaction(
        bootstrap.pools.migration,
        (client) => client.query([
          "SELECT COUNT(*)::integer AS count",
          "FROM ia4tube_social.users",
          "WHERE company_id=$1 AND id=$2"
        ].join("\n"), [tenant.fixture.companyId, tenant.fixture.userId]),
        { role: OWNER_ROLE, companyId: tenant.fixture.companyId }
      )));
      if (
        sessions.length !== 5 ||
        userCounts.some((result) => Number(result.rows?.[0]?.count) !== 1) ||
        claimsA.jti === claimsB.jti ||
        claimsA.company_id === claimsB.company_id ||
        tenantA.fixture.companyId === tenantB.fixture.companyId ||
        tenantA.fixture.userId === tenantB.fixture.userId
      ) fail("social_3b0_tenant_fixture_invalid");
    });

    const vaultMaterial = materials[3];
    const vaultVersion = deriveVaultKeyVersion(1, vaultMaterial);
    const keyring = Object.freeze({
      activeVersion: vaultVersion,
      keys: new Map([[vaultVersion, Buffer.from(vaultMaterial)]])
    });
    const rawVault = createSocialVault({
      keyring,
      expectedKeyringFingerprint: vaultKeyringFingerprint(
        vaultVersion,
        [vaultVersion]
      )
    });
    vault = Object.freeze({
      ...rawVault,
      encrypt(...args) {
        vaultEncryptCalls += 1;
        return rawVault.encrypt(...args);
      }
    });
    keyring.keys.get(vaultVersion).fill(0);
    keyring.keys.clear();
    const vaultAdmin = createVaultKeyRegistryAdmin({
      pool: bootstrap.pools.migration,
      ownerRole: OWNER_ROLE
    });
    await vaultAdmin.register({ keyVersion: vaultVersion });
    await vaultAdmin.withActiveVersion({ keyVersion: vaultVersion }, async () => true);

    const rawEnvelope = createInstagramOAuthStateEnvelope({
      derivationKey: identityMaterial,
      keyVersion: IDENTITY_VERSION,
      redirectUri: config.redirectUri
    });
    const callbackOrder = [];
    stateEnvelope = Object.freeze({
      destroy: rawEnvelope.destroy,
      open: rawEnvelope.open,
      seal: rawEnvelope.seal,
      openForCallback(value) {
        const authenticated = rawEnvelope.openForCallback(value);
        callbackOrder.push("aead_authenticated");
        return authenticated;
      }
    });
    const social = createSocialRepository({
      pool: bootstrap.pools.runtime,
      runtimeRole: RUNTIME_ROLE,
      identityDerivationVersion: IDENTITY_VERSION
    });
    const credentials = createSocialCredentialService({ repository: social, vault });
    const rawOAuthRepository = createPostgresOAuthRepository({
      pool: bootstrap.pools.runtime,
      runtimeRole: RUNTIME_ROLE
    });
    const oauthRepository = Object.freeze({
      scope(context) {
        scopeCalls += 1;
        callbackOrder.push("tenant_scope_installed");
        const scoped = rawOAuthRepository.scope(context);
        return Object.freeze({
          ...scoped,
          storeConsumedAuthorizationCredential(...args) {
            credentialStoreCalls += 1;
            return scoped.storeConsumedAuthorizationCredential(...args);
          }
        });
      }
    });
    const exchangeByCode = new Map();
    const syntheticUser = rememberSensitive(
      crypto.randomBytes(18).toString("base64url")
    );
    const syntheticMaterial = crypto.randomBytes(32);
    rememberSensitive(syntheticMaterial.toString("base64url"));
    const expectedCredentialMarker = Buffer.from(
      syntheticMaterial.toString("base64url"),
      "utf8"
    );
    const expectedCredentialDigest = sha256(expectedCredentialMarker);
    expectedCredentialMarker.fill(0);
    materials.push(syntheticMaterial);
    const provider = createInstagramProvider({
      config,
      transport: async (url, request) => {
        if (url !== INSTAGRAM_TOKEN_ENDPOINT) {
          const route = String(url || "").toLowerCase();
          if (route.includes("media_publish")) providerTransportCalls.mediaPublish += 1;
          else if (route.includes("permalink")) providerTransportCalls.permalink += 1;
          else providerTransportCalls.mediaContainer += 1;
          fail("social_3b0_transport_contract_invalid");
        }
        providerTransportCalls.tokenExchange += 1;
        if (request.signal?.aborted) fail("social_3b0_transport_contract_invalid");
        const codeValue = new URLSearchParams(request.body).get("code");
        exchangeByCode.set(codeValue, (exchangeByCode.get(codeValue) || 0) + 1);
        counts.syntheticExchangeCalls += 1;
        return streamJson({
          access_token: syntheticMaterial.toString("base64url"),
          user_id: syntheticUser
        }, readers);
      }
    });
    const service = createInstagramOAuthService({
      config,
      stateEnvelope,
      provider,
      oauthRepository,
      credentials,
      authAdapter,
      environment: "test"
    });
    const app = express();
    app.use(express.json({ limit: "32kb" }));
    let bearerAccepts = 0;
    let scopeCalls = 0;
    const bearerPrincipals = () => [
      [authorizationHeader, claimsA],
      [concurrentAuthorizationHeader, claimsConcurrent],
      [cancellationAuthorizationHeader, claimsCancellation],
      [isolationAuthorizationHeader, claimsIsolationA]
    ];
    app.use("/v1/social", createInstagramOAuthRouter({
      authenticate(req, res, next) {
        const supplied = Buffer.from(String(req.headers.authorization || ""), "utf8");
        let acceptedClaims = null;
        for (const [header, claims] of bearerPrincipals()) {
          const expected = Buffer.from(header, "utf8");
          const accepted = supplied.length === expected.length &&
            crypto.timingSafeEqual(supplied, expected);
          expected.fill(0);
          if (accepted) acceptedClaims = claims;
        }
        supplied.fill(0);
        if (!acceptedClaims) return res.status(401).json({ ok: false });
        bearerAccepts += 1;
        req.user = acceptedClaims;
        return next();
      },
      getService() { return service; }
    }));
    const listener = await listenLoopback(app);
    server = listener.server;
    serverPort = listener.port;
    networkGuard = installApplicationNetworkGuard(new Set([
      LOOPBACK,
      postgres.databaseHost
    ]));

    let primaryState = "";
    let primaryPayload;
    let primaryRow;
    const primaryCode = rememberSensitive(
      crypto.randomBytes(24).toString("base64url")
    );
    await ledger.run("O05", async () => {
      const before = await withTransaction(
        bootstrap.pools.runtime,
        (client) => client.query(
          "SELECT COUNT(*)::integer AS count FROM ia4tube_social.social_oauth_transactions WHERE company_id=$1",
          [tenantA.fixture.companyId]
        ),
        { role: RUNTIME_ROLE, companyId: tenantA.fixture.companyId }
      );
      const missing = await httpJsonRequest({
        port: serverPort,
        method: "POST",
        route: "/v1/social/connections/instagram/authorization",
        body: { purpose: "connect" }
      });
      counts.authorizeRequests += 1;
      const invalidMaterial = crypto.randomBytes(32);
      materials.push(invalidMaterial);
      rememberSensitive(invalidMaterial.toString("base64url"));
      const invalid = await httpJsonRequest({
        port: serverPort,
        method: "POST",
        route: "/v1/social/connections/instagram/authorization",
        headers: { authorization: `Bearer ${invalidMaterial.toString("base64url")}` },
        body: { purpose: "connect" }
      });
      counts.authorizeRequests += 1;
      const afterRefusal = await withTransaction(
        bootstrap.pools.runtime,
        (client) => client.query(
          "SELECT COUNT(*)::integer AS count FROM ia4tube_social.social_oauth_transactions WHERE company_id=$1",
          [tenantA.fixture.companyId]
        ),
        { role: RUNTIME_ROLE, companyId: tenantA.fixture.companyId }
      );
      if (
        missing.status !== 401 || invalid.status !== 401 ||
        Number(before.rows?.[0]?.count) !== Number(afterRefusal.rows?.[0]?.count) ||
        bearerAccepts !== 0
      ) fail("social_3b0_authorize_bearer_refusal_invalid");
      const response = await httpJsonRequest({
        port: serverPort,
        method: "POST",
        route: "/v1/social/connections/instagram/authorization",
        headers: { authorization: authorizationHeader },
        body: { purpose: "connect" }
      });
      counts.authorizeRequests += 1;
      if (
        response.status !== 201 ||
        response.value?.status !== "authorization_pending" ||
        bearerAccepts !== 1
      ) fail("social_3b0_authorize_http_invalid");
      primaryState = new URL(response.value.authorizationUrl).searchParams.get("state");
      if (typeof primaryState !== "string") fail("social_3b0_state_missing");
      rememberSensitive(primaryState);
    });
    await ledger.run("O06", async () => {
      primaryPayload = rawEnvelope.open(primaryState);
      const selected = await withTransaction(
        bootstrap.pools.runtime,
        (client) => client.query([
          "SELECT id,connection_id,state_digest,purpose",
          "FROM ia4tube_social.social_oauth_transactions",
          "WHERE company_id=$1 AND id=$2"
        ].join("\n"), [tenantA.fixture.companyId, primaryPayload.authorizationHandle]),
        { role: RUNTIME_ROLE, companyId: tenantA.fixture.companyId }
      );
      primaryRow = selected.rows?.[0];
      if (
        !primaryRow ||
        primaryRow.state_digest !== sha256(primaryState) ||
        primaryRow.purpose !== "connect"
      ) fail("social_3b0_state_digest_invalid");
    });
    await ledger.run("O07", async () => {
      const segments = primaryState.split(".");
      const decoded = segments.slice(1).map((segment) => Buffer.from(segment, "base64url"));
      try {
        const forbidden = [
          tenantA.fixture.companyId,
          tenantA.fixture.userId,
          claimsA.jti,
          primaryPayload.authorizationHandle
        ];
        if (decoded.some((part) => forbidden.some((value) =>
          part.includes(Buffer.from(value, "utf8"))
        ))) fail("social_3b0_state_plaintext_binding_found");
      } finally {
        for (const part of decoded) part.fill(0);
      }
    });
    await ledger.run("O08", async () => {
      callbackOrder.length = 0;
      const segments = primaryState.split(".");
      const last = segments.at(-1);
      segments[segments.length - 1] = `${last.slice(0, -1)}${
        last.endsWith("A") ? "B" : "A"
      }`;
      const tamperedState = rememberSensitive(segments.join("."));
      const beforeScope = scopeCalls;
      const beforeExchange = counts.syntheticExchangeCalls;
      const tampered = await httpJsonRequest({
        port: serverPort,
        method: "GET",
        route: "/v1/social/oauth/callback?state=" +
          encodeURIComponent(tamperedState) + "&code=" +
          encodeURIComponent(rememberSensitive(
            crypto.randomBytes(24).toString("base64url")
          ))
      });
      counts.callbackRequests += 1;
      if (
        tampered.status !== 400 ||
        tampered.value?.code !== "social_oauth_state_invalid" ||
        scopeCalls !== beforeScope ||
        counts.syntheticExchangeCalls !== beforeExchange ||
        callbackOrder.length !== 0
      ) fail("social_3b0_unauthenticated_state_boundary_invalid");
      const authorityQuery = await httpJsonRequest({
        port: serverPort,
        method: "GET",
        route: "/v1/social/oauth/callback?state=" +
          encodeURIComponent(primaryState) + "&code=" +
          encodeURIComponent(rememberSensitive(
            crypto.randomBytes(24).toString("base64url")
          )) +
          "&company_id=" + encodeURIComponent(tenantB.fixture.companyId)
      });
      counts.callbackRequests += 1;
      if (
        authorityQuery.status !== 400 ||
        authorityQuery.value?.code !== "social_oauth_callback_invalid" ||
        scopeCalls !== beforeScope ||
        counts.syntheticExchangeCalls !== beforeExchange
      ) fail("social_3b0_callback_query_authority_invalid");
      const response = await httpJsonRequest({
        port: serverPort,
        method: "GET",
        route: "/v1/social/oauth/callback?state=" +
          encodeURIComponent(primaryState) + "&code=" +
          encodeURIComponent(primaryCode)
      });
      counts.callbackRequests += 1;
      const responseSerialized = JSON.stringify(response.value);
      if (
        response.status !== 200 ||
        !exactKeys(response.value, ["ok", "provider", "returnPathId", "status"].sort()) ||
        response.value.status !== "authorization_completed" ||
        responseSerialized.includes(syntheticMaterial.toString("base64url"))
      ) {
        fail("social_3b0_callback_http_invalid");
      }
    });
    await ledger.run("O09", async () => {
      if (
        callbackOrder[0] !== "aead_authenticated" ||
        callbackOrder[1] !== "tenant_scope_installed"
      ) fail("social_3b0_tenant_before_aead");
    });
    await ledger.run("O10", async () => {
      const result = await withTransaction(
        bootstrap.pools.runtime,
        (client) => client.query([
          "SELECT consumed_at IS NOT NULL AS consumed,",
          "  (SELECT relrowsecurity AND relforcerowsecurity",
          "   FROM pg_catalog.pg_class c",
          "   JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace",
          "   WHERE n.nspname='ia4tube_social'",
          "     AND c.relname='social_oauth_transactions') AS force_rls",
          "FROM ia4tube_social.social_oauth_transactions",
          "WHERE company_id=$1 AND id=$2"
        ].join("\n"), [tenantA.fixture.companyId, primaryPayload.authorizationHandle]),
        { role: RUNTIME_ROLE, companyId: tenantA.fixture.companyId }
      );
      if (result.rows?.[0]?.consumed !== true || result.rows[0].force_rls !== true) {
        fail("social_3b0_force_rls_consumption_invalid");
      }
    });
    await ledger.run("O11", async () => {
      if (exchangeByCode.get(primaryCode) !== 1) {
        fail("social_3b0_primary_exchange_count_invalid");
      }
    });
    await ledger.run("O12", async () => {
      const result = await withTransaction(
        bootstrap.pools.runtime,
        (client) => client.query([
          "SELECT ciphertext,nonce,auth_tag",
          "FROM ia4tube_social.social_encrypted_credentials",
          "WHERE company_id=$1 AND id=$2 AND connection_id=$3",
          "  AND revoked_at IS NULL"
        ].join("\n"), [
          tenantA.fixture.companyId,
          primaryPayload.authorizationHandle,
          primaryRow.connection_id
        ]),
        { role: RUNTIME_ROLE, companyId: tenantA.fixture.companyId }
      );
      const row = result.rows?.[0];
      const marker = Buffer.from(syntheticMaterial.toString("base64url"), "utf8");
      try {
        if (
          result.rows?.length !== 1 ||
          !Buffer.isBuffer(row.ciphertext) || row.ciphertext.length < 1 ||
          !Buffer.isBuffer(row.nonce) || row.nonce.length !== 12 ||
          !Buffer.isBuffer(row.auth_tag) || row.auth_tag.length !== 16 ||
          row.ciphertext.includes(marker)
        ) fail("social_3b0_credential_ciphertext_invalid");
      } finally { marker.fill(0); }
      const decryptedDigest = await credentials.withDecryptedCredential({
        companyId: tenantA.fixture.companyId,
        credentialId: primaryPayload.authorizationHandle
      }, async (plaintext) => sha256(plaintext));
      if (
        decryptedDigest !== expectedCredentialDigest ||
        vaultEncryptCalls !== 1 || credentialStoreCalls !== 1
      ) fail("social_3b0_credential_single_write_invalid");
      counts.credentialWrites += 1;
    });
    await ledger.run("O13", async () => {
      const result = await withTransaction(
        bootstrap.pools.runtime,
        (client) => client.query([
          "SELECT c.status,",
          " (SELECT COUNT(*)::integer",
          "  FROM ia4tube_social.social_external_accounts a",
          "  WHERE a.company_id=$1) AS accounts",
          "FROM ia4tube_social.social_connections c",
          "WHERE c.company_id=$1 AND c.id=$2"
        ].join("\n"), [tenantA.fixture.companyId, primaryRow.connection_id]),
        { role: RUNTIME_ROLE, companyId: tenantA.fixture.companyId }
      );
      if (
        result.rows?.[0]?.status !== "authorization_pending" ||
        Number(result.rows[0].accounts) !== 0
      ) fail("social_3b0_account_discovery_boundary_invalid");
    });
    await ledger.run("O14", async () => {
      const response = await httpJsonRequest({
        port: serverPort,
        method: "GET",
        route: "/v1/social/oauth/callback?state=" +
          encodeURIComponent(primaryState) + "&code=" +
          encodeURIComponent(primaryCode)
      });
      counts.callbackRequests += 1;
      if (
        response.status !== 409 ||
        response.value?.code !== "social_oauth_state_already_consumed" ||
        exchangeByCode.get(primaryCode) !== 1
      ) fail("social_3b0_replay_refusal_invalid");
      counts.replayRefusals += 1;
    });
    await ledger.run("O15", async () => {
      const authorization = await httpJsonRequest({
        port: serverPort,
        method: "POST",
        route: "/v1/social/connections/instagram/authorization",
        headers: { authorization: concurrentAuthorizationHeader },
        body: { purpose: "connect" }
      });
      counts.authorizeRequests += 1;
      const concurrentState = rememberSensitive(new URL(
        authorization.value.authorizationUrl
      ).searchParams.get("state"));
      const concurrentCode = rememberSensitive(
        crypto.randomBytes(24).toString("base64url")
      );
      const route = "/v1/social/oauth/callback?state=" +
        encodeURIComponent(concurrentState) + "&code=" +
        encodeURIComponent(concurrentCode);
      const results = await Promise.all([
        httpJsonRequest({ port: serverPort, method: "GET", route }),
        httpJsonRequest({ port: serverPort, method: "GET", route })
      ]);
      counts.callbackRequests += 2;
      const successes = results.filter((item) => item.status === 200).length;
      const refusals = results.filter((item) => item.status === 409).length;
      if (successes !== 1 || refusals !== 1 || exchangeByCode.get(concurrentCode) !== 1) {
        fail("social_3b0_concurrent_callback_invalid");
      }
      counts.concurrencyWinners = 1;
      counts.credentialWrites += 1;
    });
    await ledger.run("O16", async () => {
      const authorization = await httpJsonRequest({
        port: serverPort,
        method: "POST",
        route: "/v1/social/connections/instagram/authorization",
        headers: { authorization: isolationAuthorizationHeader },
        body: { purpose: "connect" }
      });
      counts.authorizeRequests += 1;
      if (authorization.status !== 201) {
        fail("social_3b0_cross_tenant_fixture_invalid");
      }
      const isolationState = rememberSensitive(new URL(
        authorization.value.authorizationUrl
      ).searchParams.get("state"));
      const isolationPayload = rawEnvelope.open(isolationState);
      const segments = isolationState.split(".");
      const last = segments.at(-1);
      segments[segments.length - 1] = `${last.slice(0, -1)}${
        last.endsWith("A") ? "B" : "A"
      }`;
      const isolationTamperedState = rememberSensitive(segments.join("."));
      const isolationTamperedCode = rememberSensitive(
        crypto.randomBytes(24).toString("base64url")
      );
      const beforeScope = scopeCalls;
      const beforeExchange = counts.syntheticExchangeCalls;
      const tampered = await httpJsonRequest({
        port: serverPort,
        method: "GET",
        route: "/v1/social/oauth/callback?state=" +
          encodeURIComponent(isolationTamperedState) + "&code=" +
          encodeURIComponent(isolationTamperedCode)
      });
      counts.callbackRequests += 1;
      if (
        tampered.status !== 400 ||
        tampered.value?.code !== "social_oauth_state_invalid" ||
        scopeCalls !== beforeScope ||
        counts.syntheticExchangeCalls !== beforeExchange
      ) fail("social_3b0_cross_tenant_aead_boundary_invalid");
      let refused = false;
      try {
        await rawOAuthRepository.scope(tenantB.context).consumeAuthorization({
          authorizationHandle: isolationPayload.authorizationHandle,
          state: isolationState,
          redirectUri: config.redirectUri,
          sessionJti: claimsIsolationA.jti,
          purpose: "connect",
          observedAt: new Date()
        });
      } catch (error) {
        refused = error?.code === "authorization_expired";
      }
      const sourceIsolation = await withTransaction(
        bootstrap.pools.runtime,
        (client) => client.query([
          "SELECT COUNT(*)::integer AS count",
          "FROM ia4tube_social.social_oauth_transactions",
          "WHERE company_id=$1 AND id=$2 AND consumed_at IS NULL"
        ].join("\n"), [
          tenantIsolationA.fixture.companyId,
          isolationPayload.authorizationHandle
        ]),
        { role: RUNTIME_ROLE, companyId: tenantIsolationA.fixture.companyId }
      );
      const targetIsolation = await withTransaction(
        bootstrap.pools.runtime,
        (client) => client.query([
          "SELECT COUNT(*)::integer AS count",
          "FROM ia4tube_social.social_oauth_transactions",
          "WHERE company_id=$1 AND id=$2"
        ].join("\n"), [
          tenantB.fixture.companyId,
          isolationPayload.authorizationHandle
        ]),
        { role: RUNTIME_ROLE, companyId: tenantB.fixture.companyId }
      );
      if (
        !refused ||
        Number(sourceIsolation.rows?.[0]?.count) !== 1 ||
        Number(targetIsolation.rows?.[0]?.count) !== 0
      ) fail("social_3b0_cross_tenant_refusal_invalid");
    });
    await ledger.run("O17", async () => {
      const authorization = await httpJsonRequest({
        port: serverPort,
        method: "POST",
        route: "/v1/social/connections/instagram/authorization",
        headers: { authorization: cancellationAuthorizationHeader },
        body: { purpose: "connect" }
      });
      counts.authorizeRequests += 1;
      const cancelledState = rememberSensitive(new URL(
        authorization.value.authorizationUrl
      ).searchParams.get("state"));
      const before = counts.syntheticExchangeCalls;
      const cancelled = await httpJsonRequest({
        port: serverPort,
        method: "GET",
        route: "/v1/social/oauth/callback?state=" +
          encodeURIComponent(cancelledState) + "&error=access_denied"
      });
      counts.callbackRequests += 1;
      if (
        cancelled.status !== 400 ||
        cancelled.value?.code !== "social_oauth_state_cancelled" ||
        counts.syntheticExchangeCalls !== before
      ) fail("social_3b0_cancellation_invalid");
      const cancelledPayload = rawEnvelope.open(cancelledState);
      const terminal = await withTransaction(
        bootstrap.pools.runtime,
        (client) => client.query([
          "SELECT consumed_at,cancelled_at,failed_at",
          "FROM ia4tube_social.social_oauth_transactions",
          "WHERE company_id=$1 AND id=$2"
        ].join("\n"), [
          tenantCancellation.fixture.companyId,
          cancelledPayload.authorizationHandle
        ]),
        {
          role: RUNTIME_ROLE,
          companyId: tenantCancellation.fixture.companyId
        }
      );
      if (
        terminal.rows?.length !== 1 ||
        terminal.rows[0].consumed_at !== null ||
        terminal.rows[0].cancelled_at === null ||
        terminal.rows[0].failed_at !== null
      ) fail("social_3b0_cancellation_terminal_invalid");
      counts.cancellationExchanges = 0;
    });
    await ledger.run("O18", async () => {
      const timerProof = await runBlockedBodyProof(config, options);
      timerResiduals = timerProof.active;
      counts.blockedBodyAborts = 1;
    });
    await ledger.run("O19", async () => {
      let attempts = 0;
      let refused = false;
      try {
        createInstagramProvider({
          config: loadInstagramOAuthConfig(Object.freeze({})),
          transport: async () => { attempts += 1; }
        });
      } catch (error) {
        refused = error?.code === "social_oauth_exchange_failed";
      }
      if (!refused || attempts !== 0) fail("social_3b0_disabled_gate_invalid");
    });
    await ledger.run("O20", async () => {
      const result = await withTransaction(
        bootstrap.pools.runtime,
        (client) => client.query([
          "SELECT",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.social_publications",
          "  WHERE company_id=$1) AS publications,",
          " (SELECT COUNT(*)::integer FROM ia4tube_social.social_publication_attempts",
          "  WHERE company_id=$1) AS attempts"
        ].join("\n"), [tenantA.fixture.companyId]),
        { role: RUNTIME_ROLE, companyId: tenantA.fixture.companyId }
      );
      if (
        Number(result.rows?.[0]?.publications) !== 0 ||
        Number(result.rows?.[0]?.attempts) !== 0 ||
        vaultEncryptCalls !== 2 || credentialStoreCalls !== 2 ||
        providerTransportCalls.tokenExchange !==
          counts.syntheticExchangeCalls ||
        providerTransportCalls.mediaContainer !== 0 ||
        providerTransportCalls.mediaPublish !== 0 ||
        providerTransportCalls.permalink !== 0
      ) fail("social_3b0_publication_boundary_invalid");
      let refused = false;
      try {
        http.request({ host: "198.51.100.1", port: 80, path: "/" });
      } catch (error) {
        refused = error?.code === "social_3b0_non_loopback_network_refused";
      }
      const network = networkGuard.snapshot();
      if (
        !refused || network.deniedAttempts !== 1 ||
        network.externalConnections !== 0
      ) fail("social_3b0_application_firewall_invalid");
      external.graph = network.externalConnections;
      external.instagram = network.externalConnections;
      external.meta = network.externalConnections;
      external.publication = network.externalConnections;
      counts.publicationCalls = 0;
    });
    await ledger.run("O21", async () => {
      const auditedTenants = [
        tenantA,
        tenantB,
        tenantConcurrent,
        tenantCancellation,
        tenantIsolationA
      ];
      const results = await Promise.all(auditedTenants.map((tenant) =>
        withTransaction(
          bootstrap.pools.runtime,
          (client) => client.query([
            "SELECT action,outcome,details_code",
            "FROM ia4tube_social.social_audit_events",
            "WHERE company_id=$1 ORDER BY occurred_at,id"
          ].join("\n"), [tenant.fixture.companyId]),
          { role: RUNTIME_ROLE, companyId: tenant.fixture.companyId }
        )
      ));
      const rows = results.flatMap((result) => result.rows || []);
      const serialized = JSON.stringify(rows);
      const forbidden = [...sensitiveStrings];
      if (
        !Array.isArray(rows) || rows.length < 1 ||
        rows.some((row) =>
          typeof row.action !== "string" ||
          typeof row.outcome !== "string" ||
          !(row.details_code === null || SAFE_FAILURE.test(row.details_code))
        ) ||
        forbidden.some((value) => value && serialized.includes(value))
      ) fail("social_3b0_audit_sanitization_invalid");
      const markers = [...sensitiveStrings];
      const treeScan = containsSyntheticMarkerInTree(
        postgres.workDirectory,
        markers
      );
      const dataScan = await postgres.scanDataDirectoryMarkers(markers);
      if (treeScan.present || dataScan.markersPresent) {
        fail("social_3b0_secret_scan_marker_found");
      }
    });
  } catch (error) {
    physicalFailure = error;
  } finally {
    const cleanupErrors = [];
    const captureCleanup = async (operation) => {
      try { await operation(); } catch (error) { cleanupErrors.push(error); }
    };
    await captureCleanup(async () => networkGuard?.restore());
    networkGuard = null;
    await captureCleanup(() => closeServer(server));
    const httpServerResiduals = server?.listening === true ? 1 : 0;
    const httpSocketResiduals = SERVER_SOCKETS.get(server)?.size || 0;
    server = null;
    serverPort = 0;
    await captureCleanup(async () => stateEnvelope?.destroy());
    stateEnvelope = null;
    await captureCleanup(async () => vault?.destroy());
    vault = null;
    for (const reader of readers) reader.fill(0);
    readers.clear();
    authorizationHeader = "";
    concurrentAuthorizationHeader = "";
    cancellationAuthorizationHeader = "";
    isolationAuthorizationHeader = "";
    for (const material of materials) material.fill(0);
    sensitiveStrings.clear();
    let postgresCleanup = null;
    if (postgres) {
      await captureCleanup(async () => {
        postgresCleanup = await postgres.cleanup();
      });
    }
    residuals = {
      ...zeroResiduals(),
      containers: postgresCleanup?.containerResiduals ?? (postgres ? 1 : 0),
      volumes: postgresCleanup?.volumeResiduals ?? (postgres ? 1 : 0),
      networks: postgresCleanup?.networkResiduals ?? (postgres ? 1 : 0),
      listeners: (postgresCleanup?.listenerResiduals ?? (postgres ? 1 : 0)) +
        httpServerResiduals + httpSocketResiduals,
      temporaryRoots: postgresCleanup?.temporaryRootResiduals ?? (postgres ? 1 : 0),
      postgresConnections: postgres?.trackedPoolCount ?? (postgres ? 1 : 0),
      httpServers: httpServerResiduals,
      readers: readers.size,
      timers: timerResiduals,
      nodeProcesses: 0
    };
    const syntheticMaterialsCleared = materials.every((material) =>
      material.every((byte) => byte === 0)
    );
    cleanup = {
      cleanupCompleted: cleanupErrors.length === 0 &&
        (!postgres || postgresCleanup?.cleanupCompleted === true) &&
        Object.values(residuals).every((value) => value === 0),
      intermediateEvidenceRemoved: true,
      syntheticMaterialsCleared
    };
    if (cleanupErrors.length > 0 || !cleanup.cleanupCompleted) {
      cleanupFailure = cleanupErrors[0] || new Social3B0PhysicalGateFailure(
        "social_3b0_cleanup_incomplete"
      );
      ledger.failCleanup(cleanupFailure);
    } else {
      ledger.passCleanup();
    }
  }
  const firstFailure = ledger.firstFailure() || (
    physicalFailure || cleanupFailure
      ? closedFirstFailure({
          phase: PHASE,
          substep: null,
          causalCode: failureCode(physicalFailure || cleanupFailure)
        })
      : null
  );
  return Object.freeze({
    ok: firstFailure === null && cleanup.cleanupCompleted === true,
    firstFailure,
    substeps: ledger.snapshot(),
    counts: Object.freeze({ ...counts }),
    cleanup: Object.freeze({ ...cleanup }),
    residuals: Object.freeze({ ...residuals }),
    external: Object.freeze({ ...external }),
    secretScanPassed: ledger.snapshot()[20].status === "passed"
  });
}

function baseEvidence(identity) {
  return {
    format: 1,
    kind: "ia4tube-social-3b0-instagram-oauth-local-contract",
    branch: identity.branch,
    sha: identity.sha,
    runAttempt: identity.runAttempt,
    image: IMAGE,
    windows: Object.freeze({ status: "passed" }),
    preGateLinux: Object.freeze({ status: "passed" }),
    gates1To5: Object.freeze(GATE_DEFINITIONS.map((item) =>
      Object.freeze({ ...item, status: "skipped" })
    )),
    phase: PHASE,
    substeps: skippedSubsteps(),
    counts: zeroCounts(),
    secretScan: Object.freeze({
      status: "not_run",
      historicPhysicalPassed: false,
      oauthEvidencePassed: false
    }),
    firstFailure: null,
    backupRestoreFailureProvenance: null,
    cleanup: Object.freeze({
      cleanupCompleted: false,
      intermediateEvidenceRemoved: false,
      syntheticMaterialsCleared: false
    }),
    residuals: Object.freeze({ ...zeroResiduals(), temporaryRoots: 1 }),
    externalMetaCalls: 0,
    externalInstagramCalls: 0,
    externalGraphApiCalls: 0,
    externalPublicationCalls: 0,
    realTokenCount: 0,
    publicationCalls: 0,
    status: "failed"
  };
}

async function runInstagramOAuthPhysicalGate(options = {}) {
  const environment = options.environment || process.env;
  const identity = validateEnvironment(environment);
  const runnerTemp = path.resolve(options.runnerTemp || environment.RUNNER_TEMP || "");
  const repositoryRoot = path.resolve(options.repositoryRoot || path.join(__dirname, ".."));
  const paths = artifactPaths({
    runnerTemp,
    outputPath: options.outputPath,
    processStatusPath: path.join(path.dirname(options.outputPath), PROCESS_STATUS_FILE)
  });
  const evidence = baseEvidence(identity);
  let firstFailure = null;
  try {
    const historic = await (options.runHistoricPhysicalGates ||
      runHistoricPhysicalGates)({
        runnerTemp,
        repositoryRoot,
        environment,
        spawnImpl: options.spawnImpl
      });
    evidence.gates1To5 = historic.gates1To5;
    evidence.backupRestoreFailureProvenance =
      historic.backupRestoreFailureProvenance;
    evidence.cleanup = Object.freeze({
      ...evidence.cleanup,
      intermediateEvidenceRemoved: historic.intermediateEvidenceRemoved
    });
    evidence.residuals = Object.freeze({
      ...evidence.residuals,
      nodeProcesses: historic.processResiduals || 0
    });
    evidence.secretScan = Object.freeze({
      status: "not_run",
      historicPhysicalPassed: historic.historicSecretScanPassed,
      oauthEvidencePassed: false
    });
    firstFailure = historic.firstFailure;
    if (!historic.ok) {
      throw new Social3B0PhysicalGateFailure(
        firstFailure?.causalCode || "social_3b0_historic_gate_failed"
      );
    }
    const oauth = await (options.runPhysicalOAuthContract ||
      runPhysicalOAuthContract)({
        runnerTemp,
        repositoryRoot,
        environment,
        ...options.physicalDependencies
      });
    evidence.substeps = oauth.substeps;
    evidence.counts = oauth.counts;
    evidence.cleanup = Object.freeze({
      ...oauth.cleanup,
      intermediateEvidenceRemoved: historic.intermediateEvidenceRemoved
    });
    evidence.residuals = oauth.residuals;
    evidence.externalMetaCalls = oauth.external.meta;
    evidence.externalInstagramCalls = oauth.external.instagram;
    evidence.externalGraphApiCalls = oauth.external.graph;
    evidence.externalPublicationCalls = oauth.external.publication;
    evidence.realTokenCount = oauth.external.realTokens;
    evidence.publicationCalls = oauth.counts.publicationCalls;
    evidence.secretScan = Object.freeze({
      status: oauth.substeps[20]?.status === "passed" ? "passed" :
        oauth.substeps[20]?.status === "failed" ? "failed" : "not_run",
      historicPhysicalPassed: historic.historicSecretScanPassed,
      oauthEvidencePassed: oauth.substeps[20]?.status === "passed"
    });
    firstFailure = oauth.firstFailure;
    if (!oauth.ok) throw new Social3B0PhysicalGateFailure(
      firstFailure?.causalCode || "social_3b0_oauth_contract_failed"
    );
    evidence.status = "passed";
    evidence.firstFailure = null;
    evidence.secretScan = Object.freeze({
      status: "passed",
      historicPhysicalPassed: historic.historicSecretScanPassed,
      oauthEvidencePassed: oauth.secretScanPassed
    });
    if (!evidenceSafe(evidence)) {
      fail("social_3b0_evidence_sanitization_failed");
    }
    const serialized = canonicalJson(evidence);
    if (
      /https?:\/\//i.test(serialized) ||
      /(?:bearer|access[_-]?token|app[_-]?secret)/i.test(serialized)
    ) fail("social_3b0_evidence_secret_scan_failed");
  } catch (error) {
    evidence.status = "failed";
    const finalScanFailure = failureCode(error) ===
      "social_3b0_evidence_secret_scan_failed";
    evidence.secretScan = Object.freeze({
      status: finalScanFailure ? "failed" :
        evidence.secretScan.status,
      historicPhysicalPassed: evidence.secretScan.historicPhysicalPassed,
      oauthEvidencePassed: finalScanFailure
        ? false
        : evidence.secretScan.oauthEvidencePassed
    });
    evidence.firstFailure = firstFailure || closedFirstFailure({
      phase: evidence.gates1To5.some((entry) => entry.status !== "passed")
        ? "gates_1_5"
        : PHASE,
      causalCode: failureCode(error)
    });
    if (!evidenceSafe(evidence)) {
      const fallback = baseEvidence(identity);
      fallback.firstFailure = closedFirstFailure({
        phase: PHASE,
        causalCode: "social_3b0_evidence_sanitization_failed"
      });
      fallback.secretScan = Object.freeze({
        status: "failed",
        historicPhysicalPassed: false,
        oauthEvidencePassed: false
      });
      Object.assign(evidence, fallback);
    }
  }
  if (!evidenceSafe(evidence)) fail("social_3b0_evidence_invalid");
  writePayload(paths.evidence, paths.evidenceHash, Object.freeze(evidence));
  return Object.freeze({
    ok: evidence.status === "passed",
    firstFailure: evidence.firstFailure
  });
}

async function cleanupInstagramOAuthPhysicalGate(options = {}) {
  const environment = options.environment || process.env;
  const runnerTemp = path.resolve(options.runnerTemp || environment.RUNNER_TEMP || "");
  const digits = runNumber(environment);
  const {
    createLinuxPostgres
  } = require("./social-3a0p-linux-postgres");
  const {
    createPoolMetricsRegistry
  } = require("./social-3a0p-local-runtime-evidence-metrics");
  const { Pool } = require("pg");
  const historic = require("./social-3a0p-linux-gate");
  let complete = true;
  let postgresCleanup = null;
  try {
    await historic.cleanupOnly({
      runnerTemp,
      runId: digits,
      evidenceDirectory: historicDirectory(runnerTemp, environment)
    });
  } catch { complete = false; }
  try {
    const postgres = createLinuxPostgres({
      runnerTemp,
      runId: `social-3b0-${digits}`,
      PoolClass: Pool,
      metricsRegistry: createPoolMetricsRegistry()
    });
    postgresCleanup = await postgres.cleanup();
  } catch { complete = false; }
  const intermediate = historicDirectory(runnerTemp, environment);
  try {
    if (fs.existsSync(intermediate)) {
      fs.rmSync(intermediate, { recursive: true, force: false, maxRetries: 0 });
    }
  } catch { complete = false; }
  const residuals = Object.freeze({
    ...zeroResiduals(),
    containers: postgresCleanup?.containerResiduals ?? (complete ? 0 : 1),
    volumes: postgresCleanup?.volumeResiduals ?? (complete ? 0 : 1),
    networks: postgresCleanup?.networkResiduals ?? (complete ? 0 : 1),
    listeners: postgresCleanup?.listenerResiduals ?? (complete ? 0 : 1),
    temporaryRoots: (
      postgresCleanup?.temporaryRootResiduals ?? (complete ? 0 : 1)
    ) + (fs.existsSync(intermediate) ? 1 : 0),
    postgresConnections: complete ? 0 : 1,
    httpServers: 0,
    readers: 0,
    timers: 0,
    nodeProcesses: 0
  });
  const runtimeCleanupCompleted = complete &&
    !fs.existsSync(intermediate) &&
    Object.values(residuals).every((value) => value === 0);
  let artifactDirectoryRemoved = !options.removeArtifactDirectory;
  if (options.removeArtifactDirectory !== false) {
    const artifactDirectory = within(
      path.join(runnerTemp, ARTIFACT_DIRECTORY),
      runnerTemp,
      "social_3b0_artifact_directory_invalid"
    );
    try {
      if (fs.existsSync(artifactDirectory)) {
        const stat = fs.lstatSync(artifactDirectory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          fail("social_3b0_artifact_directory_invalid");
        }
        const allowed = new Set([
          EVIDENCE_FILE,
          EVIDENCE_HASH_FILE,
          PROCESS_STATUS_FILE,
          PROCESS_STATUS_HASH_FILE
        ]);
        const entries = fs.readdirSync(artifactDirectory);
        if (entries.some((entry) => !allowed.has(entry))) {
          fail("social_3b0_artifact_entry_invalid");
        }
        for (const entry of entries) {
          const candidate = path.join(artifactDirectory, entry);
          const childStat = fs.lstatSync(candidate);
          if (!childStat.isFile() || childStat.isSymbolicLink()) {
            fail("social_3b0_artifact_entry_invalid");
          }
        }
        fs.rmSync(artifactDirectory, {
          recursive: true,
          force: false,
          maxRetries: 0
        });
      }
      artifactDirectoryRemoved = !fs.existsSync(artifactDirectory);
    } catch {
      artifactDirectoryRemoved = false;
    }
  }
  return Object.freeze({
    cleanupCompleted: runtimeCleanupCompleted && artifactDirectoryRemoved,
    artifactDirectoryRemoved,
    intermediateEvidenceRemoved: !fs.existsSync(intermediate),
    residuals
  });
}

async function superviseInstagramOAuthPhysicalGate(options = {}) {
  const environment = options.environment || process.env;
  const identity = validateEnvironment(environment);
  const paths = artifactPaths({
    runnerTemp: options.runnerTemp || environment.RUNNER_TEMP,
    outputPath: options.outputPath,
    processStatusPath: options.processStatusPath
  });
  if (fs.existsSync(paths.directory)) fail("social_3b0_artifact_collision");
  fs.mkdirSync(paths.directory, { recursive: false, mode: 0o700 });
  const child = await childOnce(process.execPath, [
    __filename,
    "--worker",
    "--output",
    paths.evidence
  ], {
    spawnImpl: options.spawnImpl,
    timeoutMs: options.timeoutMs,
    killGraceMs: options.killGraceMs,
    cwd: options.repositoryRoot || path.join(__dirname, ".."),
    environment,
    ownsProcessGroup: true
  });
  const status = sanitizeProcessStatus({
    exitCode: child.signal || child.timedOut ? null : child.exitCode,
    signal: child.signal,
    timedOut: child.timedOut,
    stdoutStored: false,
    stderrStored: false
  });
  if (!status) fail("social_3b0_process_status_invalid");
  const compensatingCleanup = await (
    options.cleanupImpl || cleanupInstagramOAuthPhysicalGate
  )({
    environment,
    runnerTemp: options.runnerTemp || environment.RUNNER_TEMP,
    removeArtifactDirectory: false
  });
  const observedCleanup = Object.freeze({
    ...compensatingCleanup,
    cleanupCompleted: compensatingCleanup.cleanupCompleted === true &&
      child.processResiduals === 0,
    residuals: Object.freeze({
      ...compensatingCleanup.residuals,
      nodeProcesses: (compensatingCleanup.residuals?.nodeProcesses || 0) +
        (child.processResiduals || 0)
    })
  });
  const evidencePresent = fs.existsSync(paths.evidence) &&
    fs.existsSync(paths.evidenceHash);
  let evidence = null;
  let evidenceValid = false;
  if (evidencePresent) {
    try {
      verifySidecar(paths.evidence, paths.evidenceHash);
      evidence = parseJsonFile(paths.evidence, "social_3b0_evidence_invalid");
      evidenceValid = evidenceSafe(evidence);
    } catch {
      evidenceValid = false;
    }
  }
  const evidenceNodeResiduals = evidenceValid
    ? evidence.residuals.nodeProcesses
    : 0;
  const effectiveCleanup = Object.freeze({
    ...observedCleanup,
    cleanupCompleted: observedCleanup.cleanupCompleted &&
      evidenceNodeResiduals === 0,
    residuals: Object.freeze({
      ...observedCleanup.residuals,
      nodeProcesses: observedCleanup.residuals.nodeProcesses +
        evidenceNodeResiduals
    })
  });
  const childPassed = status.exitCode === 0 && status.signal === null &&
    status.timedOut === false;
  if (
    !evidenceValid || !childPassed || evidence.status !== "passed" ||
    !effectiveCleanup.cleanupCompleted
  ) {
    const fallback = evidenceValid ? { ...evidence } : baseEvidence(identity);
    fallback.status = "failed";
    fallback.firstFailure = evidenceValid && evidence.firstFailure
      ? evidence.firstFailure
      : closedFirstFailure({
        phase: PHASE,
        causalCode: !effectiveCleanup.cleanupCompleted
          ? "social_3b0_cleanup_incomplete"
          : status.timedOut
          ? "social_3b0_worker_timeout"
          : status.signal
            ? "social_3b0_worker_signalled"
            : "social_3b0_worker_failed",
        externalProcessStarted: child.started === true,
        exitCode: status.exitCode,
        signal: status.signal,
        timedOut: status.timedOut
      });
    fallback.cleanup = Object.freeze({
      cleanupCompleted: effectiveCleanup.cleanupCompleted,
      intermediateEvidenceRemoved:
        effectiveCleanup.intermediateEvidenceRemoved,
      syntheticMaterialsCleared:
        fallback.cleanup.syntheticMaterialsCleared === true
    });
    fallback.residuals = effectiveCleanup.residuals;
    const substeps = fallback.substeps.map((entry) => ({ ...entry }));
    substeps[21].status = effectiveCleanup.cleanupCompleted ? "passed" : "failed";
    fallback.substeps = Object.freeze(
      substeps.map((entry) => Object.freeze(entry))
    );
    if (!evidenceSafe(fallback)) {
      const closed = baseEvidence(identity);
      closed.firstFailure = closedFirstFailure({
        phase: PHASE,
        causalCode: "social_3b0_evidence_sanitization_failed",
        externalProcessStarted: child.started === true,
        exitCode: status.exitCode,
        signal: status.signal,
        timedOut: status.timedOut
      });
      closed.cleanup = Object.freeze({
        cleanupCompleted: effectiveCleanup.cleanupCompleted,
        intermediateEvidenceRemoved:
          effectiveCleanup.intermediateEvidenceRemoved,
        syntheticMaterialsCleared: false
      });
      closed.residuals = effectiveCleanup.residuals;
      if (effectiveCleanup.cleanupCompleted) {
        const substeps = closed.substeps.map((entry) => ({ ...entry }));
        substeps[21].status = "passed";
        closed.substeps = Object.freeze(
          substeps.map((entry) => Object.freeze(entry))
        );
      }
      evidence = closed;
    } else {
      evidence = fallback;
    }
    replacePayload(paths.evidence, paths.evidenceHash, Object.freeze(evidence));
  }
  if (!evidenceSafe(evidence)) fail("social_3b0_evidence_invalid");
  writePayload(paths.processStatus, paths.processStatusHash, status);
  const exactFiles = fs.readdirSync(paths.directory).sort();
  if (JSON.stringify(exactFiles) !== JSON.stringify([
    EVIDENCE_FILE,
    EVIDENCE_HASH_FILE,
    PROCESS_STATUS_FILE,
    PROCESS_STATUS_HASH_FILE
  ].sort())) fail("social_3b0_artifact_inventory_invalid");
  const ok = evidence.status === "passed" && childPassed &&
    effectiveCleanup.cleanupCompleted;
  return Object.freeze({ ok, status });
}

function parseCli(args, environment = process.env) {
  if (args.length === 1 && args[0] === "--cleanup") {
    return Object.freeze({ mode: "cleanup" });
  }
  if (
    args.length === 4 &&
    args[0] === "--output" &&
    args[2] === "--process-status-output"
  ) {
    const paths = artifactPaths({
      runnerTemp: environment.RUNNER_TEMP,
      outputPath: args[1],
      processStatusPath: args[3]
    });
    return Object.freeze({ mode: "supervisor", paths });
  }
  if (
    args.length === 3 &&
    args[0] === "--worker" &&
    args[1] === "--output"
  ) {
    const paths = artifactPaths({
      runnerTemp: environment.RUNNER_TEMP,
      outputPath: args[2],
      processStatusPath: path.join(path.dirname(args[2]), PROCESS_STATUS_FILE)
    });
    return Object.freeze({ mode: "worker", paths });
  }
  fail("social_3b0_cli_invalid");
}

async function main() {
  const command = parseCli(process.argv.slice(2));
  if (command.mode === "cleanup") {
    const result = await cleanupInstagramOAuthPhysicalGate();
    if (!result.cleanupCompleted) process.exitCode = 1;
    return;
  }
  if (command.mode === "worker") {
    const result = await runInstagramOAuthPhysicalGate({
      outputPath: command.paths.evidence
    });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const result = await superviseInstagramOAuthPhysicalGate({
    outputPath: command.paths.evidence,
    processStatusPath: command.paths.processStatus
  });
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(() => { process.exitCode = 1; });
}

module.exports = {
  ARTIFACT_DIRECTORY,
  BRANCH,
  EVIDENCE_FILE,
  EVIDENCE_HASH_FILE,
  EXPECTED_COUNTS,
  GATE_DEFINITIONS,
  IMAGE,
  HISTORIC_TIMEOUT_MS,
  PHASE,
  PROCESS_STATUS_FILE,
  PROCESS_STATUS_HASH_FILE,
  SUBSTEP_IDS,
  WORKER_TIMEOUT_MS,
  Social3B0PhysicalGateFailure,
  artifactPaths,
  baseEvidence,
  canonicalJson,
  childOnce,
  closedFirstFailure,
  cleanupInstagramOAuthPhysicalGate,
  evidenceSafe,
  historicFailureDetails,
  installApplicationNetworkGuard,
  parseCli,
  runBlockedBodyProof,
  runHistoricPhysicalGates,
  runInstagramOAuthPhysicalGate,
  runPhysicalOAuthContract,
  sanitizeProcessStatus,
  superviseInstagramOAuthPhysicalGate,
  validateEnvironment,
  verifySidecar,
  writePayload,
  zeroCounts,
  zeroResiduals
};
