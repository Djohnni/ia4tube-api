"use strict";

const { Pool } = require("pg");
const {
  databaseTargetFingerprint,
  loadRuntimePostgresConfig
} = require("../src/persistence/postgres/config");
const {
  verifyRuntimeRole
} = require("../src/persistence/postgres/pool");
const {
  verifyRuntimeSchema
} = require("../src/persistence/postgres/runtime-validation");
const {
  CUSTOM_TRUST_ENVIRONMENT_NAMES
} = require("../src/persistence/postgres/tls");
const {
  LOOPBACK_MODE,
  RENDER_PAID_STAGING_MODE,
  RUNTIME_POOL_MAX,
  runSizingHarness,
  validateSizingEnvironment
} = require("../src/persistence/postgres/sizing-harness");

async function main(env = process.env, options = {}) {
  let pool;
  let exitCode = 2;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  try {
    const target = validateSizingEnvironment(env);
    const customTrustEnvironment = Object.fromEntries(
      CUSTOM_TRUST_ENVIRONMENT_NAMES.map((name) => [name, env[name]])
    );
    const runtime = loadRuntimePostgresConfig({
      NODE_ENV: target.mode === LOOPBACK_MODE ? "test" : "sizing",
      NODE_TLS_REJECT_UNAUTHORIZED:
        env.NODE_TLS_REJECT_UNAUTHORIZED,
      SOCIAL_PERSISTENCE_ENABLED: "true",
      SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST:
        target.mode === LOOPBACK_MODE ? "true" : "false",
      DATABASE_URL: target.databaseUrl,
      SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
        databaseTargetFingerprint(new URL(target.databaseUrl)),
      SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: target.username,
      SOCIAL_DATABASE_POOL_MAX: String(RUNTIME_POOL_MAX),
      ...customTrustEnvironment
    });
    pool = new (options.PoolClass || Pool)(runtime.pool);
    if (target.mode === RENDER_PAID_STAGING_MODE) {
      await (options.verifyRuntimeRole || verifyRuntimeRole)(
        pool,
        runtime.role
      );
      await (options.verifyRuntimeSchema || verifyRuntimeSchema)(
        pool,
        runtime.role
      );
    }
    const metrics = await (options.runSizingHarness || runSizingHarness)({
      pool,
      holdMs: target.holdMs,
      expectedDatabase: target.database,
      expectedUsername: target.username,
      expectTls: target.mode !== LOOPBACK_MODE
    });
    stdout.write(
      `${JSON.stringify({
        event: "social_postgres_sizing_complete",
        metrics
      })}\n`
    );
    exitCode = metrics.passed ? 0 : 1;
  } catch (error) {
    const rawCode = String(error?.code || "");
    const code = /^[a-zA-Z0-9_]{2,64}$/.test(rawCode)
      ? rawCode
      : "sizing_failed";
    stderr.write(
      `${JSON.stringify({
        event: "social_postgres_sizing_refused",
        code
      })}\n`
    );
    exitCode = 2;
  } finally {
    if (pool && typeof pool.end === "function") {
      try {
        await pool.end();
      } catch {
        stderr.write(
          `${JSON.stringify({
            event: "social_postgres_sizing_cleanup_failed",
            code: "sizing_pool_close_failed"
          })}\n`
        );
        exitCode = 2;
      }
    }
  }
  return exitCode;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { main };
