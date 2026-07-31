"use strict";

// Operator-only entry point. It is deliberately not imported by server.js.
// All credentials are accepted only through the process environment.
const pg = require("pg");
const {
  createDisposableDatabase,
  dropDisposableDatabase,
  loadDisposableDatabaseLifecycleConfig
} = require(
  "../src/persistence/postgres/disposable-database-lifecycle"
);
const {
  completePhysicalEvidence,
  loadExecutionIdentity,
  startPhysicalEvidence
} = require("../src/persistence/postgres/physical-gate-evidence");

async function closePoolsConfirmed(pools) {
  const outcomes = await Promise.allSettled(
    pools.map(async (pool) => {
      if (!pool || typeof pool.end !== "function") {
        throw new Error("pool_close_unavailable");
      }
      await pool.end();
    })
  );
  if (outcomes.some((outcome) => outcome.status !== "fulfilled")) {
    const error = new Error("staging_disposable_pool_close_failed");
    error.code = "staging_disposable_pool_close_failed";
    throw error;
  }
}

async function closePoolBestEffort(pool) {
  if (!pool || typeof pool.end !== "function") return;
  try {
    await pool.end();
  } catch {
    // A prior safe code already represents this cleanup failure.
  }
}

async function main({
  env = process.env,
  argv = process.argv.slice(2),
  PoolClass = pg.Pool,
  stdout = process.stdout,
  stderr = process.stderr,
  loadIdentity = loadExecutionIdentity,
  startEvidence = startPhysicalEvidence,
  completeEvidence = completePhysicalEvidence,
  now = () => new Date()
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    stderr.write(
      `${JSON.stringify({
        ok: false,
        code: "staging_disposable_argv_refused"
      })}\n`
    );
    return 2;
  }

  let parentPool;
  let disposablePool;
  let stepEvidence;
  const lifecycleState = {};
  try {
    const identity = loadIdentity(env);
    const configuration =
      loadDisposableDatabaseLifecycleConfig(env);
    stepEvidence = startEvidence({
      identity,
      sequence: configuration.action === "create" ? 2 : 4,
      databasePurpose: configuration.restoreTopology
        ? "disposable-restore"
        : "disposable-gate",
      databaseName: configuration.target.disposableDatabase,
      targetFingerprint: configuration.targetFingerprint,
      now
    });
    parentPool = new PoolClass({
      ...configuration.parentPool,
      connectionString: configuration.parentPool.connectionString
    });
    disposablePool = new PoolClass({
      ...configuration.disposablePool,
      connectionString: configuration.disposablePool.connectionString
    });
    const result =
      configuration.action === "create"
        ? await createDisposableDatabase(
            parentPool,
            disposablePool,
            configuration
          )
        : await dropDisposableDatabase(
            parentPool,
            disposablePool,
            configuration,
            lifecycleState
          );
    if (lifecycleState.disposablePoolClosed) {
      disposablePool = null;
    }
    await closePoolsConfirmed(
      configuration.action === "drop"
        ? [parentPool]
        : [disposablePool, parentPool]
    );
    disposablePool = null;
    parentPool = null;
    const evidence = {
        ok: true,
        safe: result.safe,
        created: result.created === true,
        dropped: result.dropped === true,
        identityVerified: result.identityVerified,
        sessionsTerminated:
          result.sessionsTerminated === true,
        absenceConfirmed: result.absenceConfirmed === true
      };
    if (result.restoreTopologyPrepared === true) {
      evidence.restoreTopologyPrepared = true;
    }
    Object.assign(
      evidence,
      completeEvidence(stepEvidence, now)
    );
    stdout.write(`${JSON.stringify(evidence)}\n`);
    return 0;
  } catch (error) {
    stderr.write(
      `${JSON.stringify({
        ok: false,
        code: error?.code || "staging_disposable_failed"
      })}\n`
    );
    return 1;
  } finally {
    if (lifecycleState.disposablePoolClosed) {
      disposablePool = null;
    }
    await closePoolBestEffort(disposablePool);
    await closePoolBestEffort(parentPool);
  }
}

if (require.main === module) {
  main().then((status) => {
    process.exitCode = status;
  });
}

module.exports = { closePoolsConfirmed, main };
