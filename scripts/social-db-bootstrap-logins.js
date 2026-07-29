"use strict";

// This operator-only utility is deliberately not imported by server.js.
// Secrets are accepted through environment variables, never command arguments.
const pg = require("pg");
const {
  bootstrapDatabaseLogins,
  loadLoginBootstrapConfig,
  verifyProvisionedLoginCredentials
} = require("../src/persistence/postgres/login-bootstrap");

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
        code: "login_bootstrap_argv_refused"
      })}\n`
    );
    return 2;
  }

  let pool;
  try {
    const configuration = loadLoginBootstrapConfig(env);
    pool = new PoolClass({
      ...configuration.provisionerPool,
      connectionString: configuration.provisionerPool.connectionString
    });
    const result = await bootstrapDatabaseLogins(pool, configuration);
    const verification = await verifyProvisionedLoginCredentials(
      PoolClass,
      configuration
    );
    stdout.write(
      `${JSON.stringify({
        ok: true,
        safe: result.safe,
        migrationCreated: result.created.migration,
        runtimeCreated: result.created.runtime,
        migrationConnectionLimitUpdated:
          result.migrationConnectionLimitUpdated,
        credentialsVerified: verification.verified === 2
      })}\n`
    );
    return 0;
  } catch (error) {
    stderr.write(
      `${JSON.stringify({
        ok: false,
        code: error?.code || "login_bootstrap_failed"
      })}\n`
    );
    return 1;
  } finally {
    if (pool && typeof pool.end === "function") {
      try {
        await pool.end();
      } catch {
        // The exit code already reports the operation outcome. Never print a
        // driver error because it can contain connection configuration.
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
