"use strict";

const { Pool } = require("pg");
const {
  databaseTargetFingerprint,
  loadRuntimePostgresConfig
} = require("../src/persistence/postgres/config");
const {
  LOOPBACK_MODE,
  RUNTIME_POOL_MAX,
  runSizingHarness,
  validateSizingEnvironment
} = require("../src/persistence/postgres/sizing-harness");

async function main(env = process.env, options = {}) {
  let pool;
  let exitCode = 2;
  try {
    const target = validateSizingEnvironment(env);
    const runtime = loadRuntimePostgresConfig({
      NODE_ENV: target.mode === LOOPBACK_MODE ? "test" : "sizing",
      SOCIAL_PERSISTENCE_ENABLED: "true",
      SOCIAL_DATABASE_ALLOW_INSECURE_LOCALHOST:
        target.mode === LOOPBACK_MODE ? "true" : "false",
      DATABASE_URL: target.databaseUrl,
      SOCIAL_DATABASE_EXPECTED_TARGET_FINGERPRINT:
        databaseTargetFingerprint(new URL(target.databaseUrl)),
      SOCIAL_DATABASE_EXPECTED_RUNTIME_LOGIN: target.username,
      SOCIAL_DATABASE_POOL_MAX: String(RUNTIME_POOL_MAX)
    });
    pool = new (options.PoolClass || Pool)(runtime.pool);
    const metrics = await runSizingHarness({
      pool,
      holdMs: target.holdMs,
      expectedDatabase: target.database,
      expectedUsername: target.username,
      expectTls: target.mode !== LOOPBACK_MODE
    });
    process.stdout.write(
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
    process.stderr.write(
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
        process.stderr.write(
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
