"use strict";

const crypto = require("node:crypto");
const net = require("node:net");

const SIZING_APPROVAL = "RUN_SOCIAL_POSTGRES_SIZING";
const SIZING_REMOTE_APPROVAL =
  "RUN_SOCIAL_POSTGRES_SIZING_RENDER_FREE_DISPOSABLE";
const LOOPBACK_MODE = "loopback";
const RENDER_REMOTE_MODE = "render_free_remote";
const REMOTE_DATABASE = "ia4tube_social_2b0_gate";
const SIZING_TASK_COUNT = 30;
const RUNTIME_POOL_MAX = 3;
const MAX_ATTEMPTS = 3;
const DEFAULT_HOLD_MS = 25;
const DEFAULT_BACKOFF_MS = 25;
const MAX_BACKOFF_MS = 200;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const BLOCKED_LABEL =
  /(^|[-_.])(prod|production|stage|staging|live|main)([-_.]|$)/i;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ERROR_CODE = /^[A-Z0-9_]{2,64}$/i;
const TRANSIENT_CODES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "53300",
  "57P03",
  "ECONNRESET",
  "ETIMEDOUT"
]);
const SYNTHETIC_QUERY = [
  "SELECT $1::integer AS synthetic_task,",
  "  pg_backend_pid()::integer AS backend_pid,",
  "  current_database() AS database_name,",
  "  session_user AS session_user_name,",
  "  current_setting('server_version_num')::integer AS version_num,",
  "  current_setting('transaction_read_only') AS read_only,",
  "  current_setting('application_name') AS application_name,",
  "  pg_is_in_recovery() AS in_recovery,",
  "  COALESCE((",
  "    SELECT ssl FROM pg_catalog.pg_stat_ssl",
  "    WHERE pid = pg_backend_pid()",
  "  ), FALSE) AS tls_active,",
  "  pg_size_bytes(current_setting('work_mem'))::bigint",
  "    AS work_mem_bytes,",
  "  pg_size_bytes(current_setting('temp_buffers'))::bigint",
  "    AS temp_buffers_bytes,",
  "  pg_size_bytes(current_setting('shared_buffers'))::bigint",
  "    AS shared_buffers_bytes,",
  "  current_setting('max_connections')::integer",
  "    AS server_max_connections,",
  "  pg_sleep($2::double precision)"
].join("\n");

class PostgresSizingRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "PostgresSizingRefusal";
    this.code = code;
  }
}

function refuse(code) {
  throw new PostgresSizingRefusal(code);
}

function requireValue(env, name) {
  const value = env[name];
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim()
  ) {
    refuse(`${name.toLowerCase()}_missing`);
  }
  return value;
}

function boundedInteger(value, fallback, minimum, maximum, code) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    refuse(code);
  }
  return parsed;
}

function requiredInteger(value, minimum, maximum, code) {
  if (value === undefined || value === null || value === "") refuse(code);
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    refuse(code);
  }
  return parsed;
}

function decodeUrlPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    refuse("sizing_database_url_encoding_invalid");
  }
}

function normalizedHost(parsed) {
  return parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function fingerprint(input) {
  const canonical = [
    "ia4tube-social-postgres-sizing-v1",
    input.mode,
    input.environmentId.toLowerCase(),
    input.host.toLowerCase(),
    input.port,
    input.database,
    input.username.toLowerCase(),
    input.mode === RENDER_REMOTE_MODE ? "tls-verify-full" : "loopback",
    `tasks-${SIZING_TASK_COUNT}`,
    `pool-${RUNTIME_POOL_MAX}`
  ].join("/");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function equalFingerprint(left, right) {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return crypto.timingSafeEqual(
    Buffer.from(left, "hex"),
    Buffer.from(right, "hex")
  );
}

function validateSizingEnvironment(env = process.env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    refuse("sizing_tls_verification_disabled");
  }
  for (const [name, value] of Object.entries(env)) {
    if (/^PGSSL/i.test(name) && String(value || "").trim()) {
      refuse("sizing_ambient_pgssl_refused");
    }
    if (
      /(?:MIGRATIONS?|PROVISIONER).*DATABASE_URL$/i.test(name) &&
      String(value || "").trim()
    ) {
      refuse("sizing_privileged_database_url_refused");
    }
    if (
      /^(PGDATABASE|PGHOST|PGOPTIONS|PGPASSFILE|PGPASSWORD|PGPORT|PGSERVICE|PGUSER)$/i.test(
        name
      ) &&
      String(value || "").trim()
    ) {
      refuse("sizing_ambient_postgres_configuration_refused");
    }
  }
  if (String(env.DATABASE_URL || "").trim()) {
    refuse("sizing_ambient_database_url_refused");
  }
  if (
    requireValue(env, "SOCIAL_POSTGRES_SIZING_APPROVED") !==
    SIZING_APPROVAL
  ) {
    refuse("sizing_explicit_approval_missing");
  }

  const mode = String(
    env.SOCIAL_POSTGRES_SIZING_TARGET_MODE || LOOPBACK_MODE
  )
    .trim()
    .toLowerCase();
  if (![LOOPBACK_MODE, RENDER_REMOTE_MODE].includes(mode)) {
    refuse("sizing_target_mode_invalid");
  }
  const environmentId = requireValue(
    env,
    "SOCIAL_POSTGRES_SIZING_ENVIRONMENT_ID"
  ).toLowerCase();
  if (!UUID.test(environmentId)) refuse("sizing_environment_id_invalid");

  let parsed;
  try {
    parsed = new URL(
      requireValue(env, "SOCIAL_POSTGRES_SIZING_DATABASE_URL")
    );
  } catch {
    refuse("sizing_database_url_invalid");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.username ||
    !parsed.pathname ||
    parsed.pathname === "/"
  ) {
    refuse("sizing_database_url_invalid");
  }

  const host = normalizedHost(parsed);
  const port = parsed.port || "5432";
  const database = decodeUrlPart(parsed.pathname.slice(1));
  const username = decodeUrlPart(parsed.username).toLowerCase();
  if (
    [database, username].some((value) => BLOCKED_LABEL.test(value))
  ) {
    refuse("sizing_target_not_synthetic");
  }

  if (mode === LOOPBACK_MODE) {
    if (
      !LOOPBACK_HOSTS.has(host) ||
      !/^ia4tube_social_test_[a-z0-9_]+$/.test(database)
    ) {
      refuse("sizing_target_not_synthetic");
    }
    if (
      parsed.searchParams.has("sslmode") &&
      parsed.searchParams.get("sslmode") !== "disable"
    ) {
      refuse("sizing_loopback_tls_invalid");
    }
  } else {
    if (
      requireValue(
        env,
        "SOCIAL_POSTGRES_SIZING_RENDER_REMOTE_APPROVED"
      ) !== SIZING_REMOTE_APPROVAL
    ) {
      refuse("sizing_remote_approval_missing");
    }
    if (
      !parsed.password ||
      net.isIP(host) !== 0 ||
      !host.endsWith(".render.com") ||
      database !== REMOTE_DATABASE
    ) {
      refuse("sizing_remote_target_invalid");
    }
    const queryKeys = [...new Set([...parsed.searchParams.keys()])];
    if (
      queryKeys.length !== 1 ||
      queryKeys[0] !== "sslmode" ||
      parsed.searchParams.getAll("sslmode").length !== 1 ||
      parsed.searchParams.get("sslmode").toLowerCase() !== "verify-full"
    ) {
      refuse("sizing_remote_tls_invalid");
    }
  }

  const expected = {
    host: requireValue(env, "SOCIAL_POSTGRES_SIZING_EXPECTED_HOST")
      .replace(/^\[|\]$/g, "")
      .toLowerCase(),
    port: requireValue(env, "SOCIAL_POSTGRES_SIZING_EXPECTED_PORT"),
    database: requireValue(env, "SOCIAL_POSTGRES_SIZING_EXPECTED_DATABASE"),
    username: requireValue(env, "SOCIAL_POSTGRES_SIZING_EXPECTED_USERNAME")
      .toLowerCase()
  };
  if (
    host !== expected.host ||
    port !== expected.port ||
    database !== expected.database ||
    username !== expected.username
  ) {
    refuse("sizing_expected_target_mismatch");
  }

  const actualFingerprint = fingerprint({
    mode,
    environmentId,
    host,
    port,
    database,
    username
  });
  const expectedFingerprint = requireValue(
    env,
    "SOCIAL_POSTGRES_SIZING_EXPECTED_TARGET_FINGERPRINT"
  ).toLowerCase();
  if (!equalFingerprint(actualFingerprint, expectedFingerprint)) {
    refuse("sizing_target_fingerprint_mismatch");
  }

  const holdMs = boundedInteger(
    env.SOCIAL_POSTGRES_SIZING_HOLD_MS,
    DEFAULT_HOLD_MS,
    5,
    250,
    "sizing_hold_ms_invalid"
  );
  for (const key of [...parsed.searchParams.keys()]) {
    parsed.searchParams.delete(key);
  }
  return Object.freeze({
    mode,
    environmentId,
    host,
    port,
    database,
    username,
    databaseUrl: parsed.toString(),
    targetFingerprint: actualFingerprint,
    holdMs
  });
}

function milliseconds(value) {
  return Math.max(0, Number(value) || 0);
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  );
  return Math.round(sorted[index] * 1000) / 1000;
}

function aggregate(values) {
  if (values.length === 0) {
    return Object.freeze({ min: 0, p50: 0, p95: 0, p99: 0, max: 0 });
  }
  return Object.freeze({
    min: percentile(values, 0),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: percentile(values, 1)
  });
}

function safeErrorCode(error) {
  const code = String(error?.code || "");
  return SAFE_ERROR_CODE.test(code) ? code : "sizing_operation_failed";
}

function transient(error) {
  const code = String(error?.code || "");
  return code.startsWith("08") || TRANSIENT_CODES.has(code);
}

function parseMemoryBytes(value) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > 1024 * 1024 * 1024
  ) {
    refuse("sizing_backend_memory_invalid");
  }
  return parsed;
}

function requireTargetLabel(value, code) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value)
  ) {
    refuse(code);
  }
  return value;
}

function backoffDelay(attempt, baseMs) {
  return Math.min(MAX_BACKOFF_MS, baseMs * 2 ** (attempt - 1));
}

async function runSizingHarness(options = {}) {
  const pool = options.pool;
  if (!pool || typeof pool.connect !== "function") {
    refuse("sizing_pool_invalid");
  }
  if (Number(pool.options?.max) !== RUNTIME_POOL_MAX) {
    refuse("sizing_pool_max_mismatch");
  }
  const now =
    typeof options.now === "function"
      ? options.now
      : () => Number(process.hrtime.bigint()) / 1e6;
  const sleep =
    typeof options.sleep === "function"
      ? options.sleep
      : (duration) =>
          new Promise((resolve) => setTimeout(resolve, duration));
  const processMemory =
    typeof options.processMemory === "function"
      ? options.processMemory
      : () => process.memoryUsage();
  const holdMs = boundedInteger(
    options.holdMs,
    DEFAULT_HOLD_MS,
    5,
    250,
    "sizing_hold_ms_invalid"
  );
  const baseBackoffMs = boundedInteger(
    options.baseBackoffMs,
    DEFAULT_BACKOFF_MS,
    1,
    100,
    "sizing_backoff_ms_invalid"
  );
  const expectedDatabase = requireTargetLabel(
    options.expectedDatabase,
    "sizing_expected_database_invalid"
  );
  const expectedUsername = requireTargetLabel(
    options.expectedUsername,
    "sizing_expected_username_invalid"
  ).toLowerCase();
  if (typeof options.expectTls !== "boolean") {
    refuse("sizing_expected_tls_invalid");
  }

  let active = 0;
  let peakActive = 0;
  let peakPoolTotal = Number(pool.totalCount || 0);
  let peakPoolWaiting = Number(pool.waitingCount || 0);
  let peakProcessRss = Number(processMemory().rss || 0);
  const started = now();

  function sample() {
    peakActive = Math.max(peakActive, active);
    peakPoolTotal = Math.max(
      peakPoolTotal,
      Number(pool.totalCount || 0)
    );
    peakPoolWaiting = Math.max(
      peakPoolWaiting,
      Number(pool.waitingCount || 0)
    );
    peakProcessRss = Math.max(
      peakProcessRss,
      Number(processMemory().rss || 0)
    );
  }

  async function task(taskId) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let client;
      let acquiredAt;
      let shouldRetry = false;
      let failureCode;
      let releaseError;
      const attemptStarted = now();
      try {
        const acquisition = pool.connect();
        sample();
        client = await acquisition;
        acquiredAt = now();
        active += 1;
        sample();
        const queryStarted = now();
        const result = await client.query(SYNTHETIC_QUERY, [
          taskId,
          holdMs / 1000
        ]);
        const completedAt = now();
        const row = result?.rows?.[0];
        if (
          result?.rowCount !== 1 ||
          Number(row?.synthetic_task) !== taskId ||
          !Number.isSafeInteger(Number(row?.backend_pid)) ||
          row?.database_name !== expectedDatabase ||
          String(row?.session_user_name || "").toLowerCase() !==
            expectedUsername ||
          Number(row?.version_num) < 180000 ||
          Number(row?.version_num) >= 190000 ||
          row?.read_only !== "off" ||
          row?.application_name !== "ia4tube-social-runtime" ||
          row?.in_recovery !== false ||
          row?.tls_active !== options.expectTls
        ) {
          refuse("sizing_synthetic_result_invalid");
        }
        sample();
        return Object.freeze({
          ok: true,
          attempts: attempt,
          backendId: Number(row.backend_pid),
          sessionMemoryBudgetBytes:
            parseMemoryBytes(row.temp_buffers_bytes) +
            2 * parseMemoryBytes(row.work_mem_bytes),
          sharedBuffersBytes: parseMemoryBytes(
            row.shared_buffers_bytes
          ),
          serverMaxConnections: requiredInteger(
            row.server_max_connections,
            1,
            100000,
            "sizing_server_max_connections_invalid"
          ),
          acquireMs: milliseconds(acquiredAt - attemptStarted),
          queryMs: milliseconds(completedAt - queryStarted),
          totalMs: milliseconds(completedAt - attemptStarted)
        });
      } catch (error) {
        failureCode = safeErrorCode(error);
        shouldRetry = transient(error) && attempt < MAX_ATTEMPTS;
        if (String(error?.code || "").startsWith("08")) {
          releaseError = error;
        }
      } finally {
        if (client) {
          active -= 1;
          client.release(releaseError);
          sample();
        }
      }
      if (!shouldRetry) {
        return Object.freeze({
          ok: false,
          attempts: attempt,
          failureCode
        });
      }
      await sleep(backoffDelay(attempt, baseBackoffMs));
    }
    return Object.freeze({
      ok: false,
      attempts: MAX_ATTEMPTS,
      failureCode: "sizing_attempts_exhausted"
    });
  }

  const results = await Promise.all(
    Array.from({ length: SIZING_TASK_COUNT }, (_, index) => task(index + 1))
  );
  sample();
  const successful = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  const failures = {};
  for (const failure of failed) {
    failures[failure.failureCode] =
      (failures[failure.failureCode] || 0) + 1;
  }
  const sessionMemoryBudget = successful.map(
    (result) => result.sessionMemoryBudgetBytes
  );
  const sharedBuffers = successful.map(
    (result) => result.sharedBuffersBytes
  );
  const serverConnectionLimits = new Set(
    successful.map((result) => result.serverMaxConnections)
  );
  if (serverConnectionLimits.size > 1) {
    refuse("sizing_server_connection_limit_drift");
  }
  const sessionMemoryPeak =
    sessionMemoryBudget.length === 0
      ? 0
      : Math.max(...sessionMemoryBudget);
  const sharedBufferPeak =
    sharedBuffers.length === 0 ? 0 : Math.max(...sharedBuffers);
  return Object.freeze({
    passed:
      failed.length === 0 &&
      peakActive <= RUNTIME_POOL_MAX &&
      peakPoolTotal <= RUNTIME_POOL_MAX,
    tasks: SIZING_TASK_COUNT,
    succeeded: successful.length,
    failed: failed.length,
    retries: results.reduce(
      (total, result) => total + Math.max(0, result.attempts - 1),
      0
    ),
    failures: Object.freeze({ ...failures }),
    connections: Object.freeze({
      configuredMax: RUNTIME_POOL_MAX,
      peakActive,
      peakPoolTotal,
      peakPoolWaiting,
      uniqueBackends: new Set(
        successful.map((result) => result.backendId)
      ).size,
      serverMax:
        serverConnectionLimits.size === 0
          ? 0
          : [...serverConnectionLimits][0]
    }),
    latencyMs: Object.freeze({
      acquisition: aggregate(
        successful.map((result) => result.acquireMs)
      ),
      query: aggregate(successful.map((result) => result.queryMs)),
      total: aggregate(successful.map((result) => result.totalMs)),
      harness: Math.round(milliseconds(now() - started) * 1000) / 1000
    }),
    approximateMemoryBytes: Object.freeze({
      sessionSettingAverage:
        sessionMemoryBudget.length === 0
          ? 0
          : Math.round(
              sessionMemoryBudget.reduce((sum, value) => sum + value, 0) /
                sessionMemoryBudget.length
            ),
      sessionSettingPeak: sessionMemoryPeak,
      sharedBuffers: sharedBufferPeak,
      configuredConcurrentEstimate:
        sharedBufferPeak + sessionMemoryPeak * peakActive,
      nodeProcessRssPeak: peakProcessRss
    })
  });
}

module.exports = {
  DEFAULT_BACKOFF_MS,
  DEFAULT_HOLD_MS,
  LOOPBACK_MODE,
  MAX_ATTEMPTS,
  PostgresSizingRefusal,
  REMOTE_DATABASE,
  RENDER_REMOTE_MODE,
  RUNTIME_POOL_MAX,
  SIZING_APPROVAL,
  SIZING_REMOTE_APPROVAL,
  SIZING_TASK_COUNT,
  SYNTHETIC_QUERY,
  fingerprint,
  runSizingHarness,
  validateSizingEnvironment
};
