"use strict";

// Operator-only entry point. It is deliberately not imported by server.js.
// The provisioner URL is accepted only through the process environment.
const pg = require("pg");
const {
  loadStagingProvisionConfig,
  provisionStagingBaseline
} = require("../src/persistence/postgres/staging-provisioner");

async function main({
  env = process.env,
  argv = process.argv.slice(2),
  PoolClass = pg.Pool,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    stderr.write(
      `${JSON.stringify({
        ok: false,
        code: "staging_provision_argv_refused"
      })}\n`
    );
    return 2;
  }

  let pool;
  try {
    const configuration = loadStagingProvisionConfig(env);
    pool = new PoolClass(configuration.pool);
    const result = await provisionStagingBaseline(pool, configuration);
    try {
      await pool.end();
    } catch {
      const error = new Error("staging_provision_pool_close_failed");
      error.code = "staging_provision_pool_close_failed";
      throw error;
    }
    pool = null;
    stdout.write(
      `${JSON.stringify({
        ok: true,
        safe: result.safe,
        changed: result.changed,
        baselineCanonical: result.baselineCanonical
      })}\n`
    );
    return 0;
  } catch (error) {
    stderr.write(
      `${JSON.stringify({
        ok: false,
        code: error?.code || "staging_provision_failed"
      })}\n`
    );
    return 1;
  } finally {
    if (pool && typeof pool.end === "function") {
      try {
        await pool.end();
      } catch {
        // Never emit driver details because they can contain connection state.
      }
    }
  }
}

if (require.main === module) {
  main().then((status) => {
    process.exitCode = status;
  });
}

module.exports = { main };
