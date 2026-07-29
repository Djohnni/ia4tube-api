"use strict";

// Operator-only utility. It is deliberately not imported by server.js.
// Database passwords are accepted only through environment variables.
const { spawn } = require("node:child_process");
const pg = require("pg");
const {
  createPostgresBackupOperator,
  loadBackupConfig,
  loadRestoreConfig,
  runLogicalBackup,
  runLogicalRestore
} = require("../src/persistence/postgres/backup-restore");

const MAX_TOOL_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_RUNTIME_MS = 20 * 60 * 1000;
const TOOL_TERMINATION_GRACE_MS = 2 * 1000;

function toolFailure(code) {
  return Object.assign(new Error(code), { code });
}

function poolConfig(connection) {
  const parsed = new URL(connection.parsed.toString());
  for (const key of [...parsed.searchParams.keys()]) {
    parsed.searchParams.delete(key);
  }
  return Object.freeze({
    connectionString: parsed.toString(),
    ssl: Object.freeze({
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      servername: connection.public.host
    }),
    max: 1,
    min: 0,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
    query_timeout: 900000,
    application_name: "ia4tube-social-backup-operator",
    options: [
      "-c statement_timeout=900000",
      "-c lock_timeout=10000",
      "-c idle_in_transaction_session_timeout=900000",
      "-c search_path=pg_catalog"
    ].join(" "),
    allowExitOnIdle: false
  });
}

function runTool(plan, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs =
      options.timeoutMs === undefined
        ? MAX_TOOL_RUNTIME_MS
        : options.timeoutMs;
    const terminationGraceMs =
      options.terminationGraceMs === undefined
        ? TOOL_TERMINATION_GRACE_MS
        : options.terminationGraceMs;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      !Number.isSafeInteger(terminationGraceMs) ||
      terminationGraceMs < 1
    ) {
      reject(
        toolFailure("postgres_tool_timeout_invalid")
      );
      return;
    }
    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;
    let pendingFailure;
    let timeout;
    let forceTermination;
    const spawnFunction = options.spawnFunction || spawn;
    const child = spawnFunction(plan.executable, plan.args, {
      env: plan.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    function clearTimers() {
      if (timeout) clearTimeout(timeout);
      if (forceTermination) clearTimeout(forceTermination);
    }

    function settle(error, result) {
      if (settled) return;
      settled = true;
      clearTimers();
      if (error) reject(error);
      else resolve(result);
    }

    function refuse(error) {
      if (settled || pendingFailure) return;
      pendingFailure = error;
      try {
        child.kill("SIGTERM");
      } catch {
        // The forced termination below remains authoritative.
      }
      if (settled) return;
      forceTermination = setTimeout(() => {
        if (settled) return;
        let signaled = false;
        try {
          signaled = child.kill("SIGKILL");
        } catch {
          // The operation remains blocked until termination is confirmed.
        }
        if (
          !signaled &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          pendingFailure = toolFailure(
            "postgres_tool_termination_unconfirmed"
          );
        }
      }, terminationGraceMs);
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_TOOL_OUTPUT_BYTES) {
        refuse(
          toolFailure("postgres_tool_output_limit")
        );
        return;
      }
      stdout += chunk.toString("utf8");
    });
    // Never retain or emit stderr: a PostgreSQL error context can include a
    // generated INSERT containing protected backup data.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {
      refuse(toolFailure("postgres_tool_input_failed"));
    });
    child.stdout.on("error", () => {
      refuse(toolFailure("postgres_tool_output_failed"));
    });
    child.stderr.on("error", () => {
      refuse(toolFailure("postgres_tool_stderr_failed"));
    });
    child.on("error", () => {
      if (pendingFailure) return;
      settle(toolFailure("postgres_tool_spawn_failed"));
    });
    child.on("close", (code) => {
      if (pendingFailure) {
        settle(pendingFailure);
        return;
      }
      settle(undefined, { code, stdout });
    });
    timeout = setTimeout(() => {
      refuse(
        toolFailure("postgres_tool_timeout")
      );
    }, timeoutMs);
    try {
      if (typeof plan.input === "string") {
        child.stdin.end(plan.input, "utf8");
      } else {
        child.stdin.end();
      }
    } catch {
      refuse(toolFailure("postgres_tool_input_failed"));
    }
  });
}

function safeToolEnvironment(env = process.env) {
  const safe = {};
  for (const name of [
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL"
  ]) {
    if (typeof env[name] === "string" && env[name]) safe[name] = env[name];
  }
  return safe;
}

async function toolMajor18(executable) {
  const result = await runTool({
    executable,
    args: ["--version"],
    env: safeToolEnvironment()
  });
  return (
    result.code === 0 &&
    /\(PostgreSQL\)\s+18(?:\.|\s|$)/.test(result.stdout)
  );
}

async function validateTools(tools) {
  for (const executable of new Set(Object.values(tools))) {
    if (!(await toolMajor18(executable))) {
      const error = new Error("postgres_18_tool_required");
      error.code = "postgres_18_tool_required";
      throw error;
    }
  }
}

function successPayload(mode, result) {
  const common = {
    ok: true,
    mode,
    evidenceVerified: /^[0-9a-f]{64}$/.test(result.evidenceSha256)
  };
  if (mode === "backup") {
    if (
      result.files !== 1 ||
      !Number.isSafeInteger(result.bundleSize) ||
      result.bundleSize < 1 ||
      typeof result.bundleDirectoryFsyncConfirmed !== "boolean" ||
      !/^[0-9a-f]{64}$/.test(result.bundleSha256)
    ) {
      const error = new Error("backup_result_metadata_invalid");
      error.code = "backup_result_metadata_invalid";
      throw error;
    }
    return Object.freeze({
      ...common,
      fileCount: 1,
      bundleSize: result.bundleSize,
      bundleSha256: result.bundleSha256,
      bundleDirectoryFsyncConfirmed:
        result.bundleDirectoryFsyncConfirmed
    });
  }
  return Object.freeze({
    ...common,
    runtimeIsolation: result.runtimeIsolation,
    vault: result.vault,
    compatibleWith2A: result.compatibleWith2A
  });
}

async function main({
  env = process.env,
  argv = process.argv.slice(2),
  PoolClass = pg.Pool,
  stdout = process.stdout,
  stderr = process.stderr,
  verifiers
} = {}) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 1 ||
    !["backup", "restore"].includes(argv[0])
  ) {
    stderr.write(
      `${JSON.stringify({
        ok: false,
        code: "backup_restore_argv_refused"
      })}\n`
    );
    return 2;
  }

  const mode = argv[0];
  let pool;
  let config;
  try {
    config =
      mode === "backup"
        ? loadBackupConfig(env)
        : loadRestoreConfig(env);
    if (
      mode === "restore" &&
      (!verifiers ||
        !/^[0-9a-f]{64}$/.test(
          String(verifiers.verifierTargetFingerprint || "")
        ) ||
        typeof verifiers.verifyRuntimeIsolation !== "function" ||
        typeof verifiers.verifyVault !== "function" ||
        typeof verifiers.verify2ACompatibility !== "function")
    ) {
      const error = new Error("restore_external_verifiers_required");
      error.code = "restore_external_verifiers_required";
      throw error;
    }
    await validateTools(config.tools);
    pool = new PoolClass(poolConfig(config.operator));
    const operator = createPostgresBackupOperator(pool);
    const result =
      mode === "backup"
        ? await runLogicalBackup({ config, operator, runTool })
        : await runLogicalRestore({
            config,
            operator,
            runTool,
            ...verifiers
          });
    stdout.write(`${JSON.stringify(successPayload(mode, result))}\n`);
    return 0;
  } catch (error) {
    stderr.write(
      `${JSON.stringify({
        ok: false,
        code: error?.code || "backup_restore_failed"
      })}\n`
    );
    return 1;
  } finally {
    if (pool && typeof pool.end === "function") {
      try {
        await pool.end();
      } catch {
        // Never emit a driver error because it can contain connection state.
      }
    }
    if (Buffer.isBuffer(config?.bundleKey)) config.bundleKey.fill(0);
  }
}

if (require.main === module) {
  main().then((status) => {
    process.exitCode = status;
  });
}

module.exports = {
  MAX_TOOL_RUNTIME_MS,
  TOOL_TERMINATION_GRACE_MS,
  main,
  poolConfig,
  runTool,
  safeToolEnvironment,
  successPayload,
  toolMajor18,
  validateTools
};
