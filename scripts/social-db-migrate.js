"use strict";

const {
  loadMigrationPostgresConfig
} = require("../src/persistence/postgres/config");
const {
  closePostgresPool,
  createPostgresPool
} = require("../src/persistence/postgres/pool");
const {
  EXACT_FROM_PROFILE,
  EXACT_PENDING_MIGRATIONS,
  EXACT_TO_PROFILE,
  createMigrationRunner
} = require("../src/persistence/postgres/migrations");

const LEGACY_COMMANDS = new Set(["status", "validate", "apply"]);
const EXACT_COMMANDS = new Set(["plan-exact", "apply-exact"]);
const RECOVERY_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RECOVERY_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

class MigrationCommandFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "MigrationCommandFailure";
  }
}

function refuse(code) {
  throw new MigrationCommandFailure(code);
}

function parseNamedArguments(args) {
  const parsed = new Map();
  for (const argument of args) {
    const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(argument);
    if (!match) refuse("migration_exact_argument_invalid");
    if (parsed.has(match[1])) refuse("migration_exact_argument_duplicate");
    parsed.set(match[1], match[2]);
  }
  return parsed;
}

function parseMigrationCommand(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length < 1) {
    refuse("migration_command_invalid");
  }
  const command = String(argv[0] || "").trim().toLowerCase();
  if (LEGACY_COMMANDS.has(command)) {
    // Preserve the historical parser: legacy modes use only argv[0].
    return Object.freeze({ command, request: undefined });
  }
  if (!EXACT_COMMANDS.has(command)) refuse("migration_command_invalid");

  const named = parseNamedArguments(argv.slice(1));
  const expectedNames = new Set([
    "from-profile",
    "expect-pending",
    "to-profile",
    ...(command === "apply-exact"
      ? ["recovery-reference", "recovery-captured-at"]
      : [])
  ]);
  if (
    named.size !== expectedNames.size ||
    [...named.keys()].some((name) => !expectedNames.has(name)) ||
    [...expectedNames].some((name) => !named.has(name))
  ) {
    refuse("migration_exact_argument_set_invalid");
  }
  if (named.get("from-profile") !== EXACT_FROM_PROFILE) {
    refuse("migration_exact_from_profile_invalid");
  }
  if (named.get("to-profile") !== EXACT_TO_PROFILE) {
    refuse("migration_exact_to_profile_invalid");
  }
  if (named.get("expect-pending") !== EXACT_PENDING_MIGRATIONS[0]) {
    refuse("migration_exact_pending_migration_invalid");
  }

  const request = {
    fromProfile: EXACT_FROM_PROFILE,
    toProfile: EXACT_TO_PROFILE,
    expectedPending: Object.freeze([...EXACT_PENDING_MIGRATIONS])
  };
  if (command === "apply-exact") {
    request.recoveryReference = named.get("recovery-reference");
    request.recoveryCapturedAt = named.get("recovery-captured-at");
    if (!RECOVERY_REFERENCE.test(request.recoveryReference)) {
      refuse("migration_exact_recovery_reference_invalid");
    }
    const parsedTimestamp = Date.parse(request.recoveryCapturedAt);
    const canonicalTimestamp = RECOVERY_TIMESTAMP.test(
      request.recoveryCapturedAt
    )
      ? request.recoveryCapturedAt.includes(".")
        ? request.recoveryCapturedAt
        : request.recoveryCapturedAt.replace(/Z$/, ".000Z")
      : "";
    if (
      !Number.isFinite(parsedTimestamp) ||
      new Date(parsedTimestamp).toISOString() !== canonicalTimestamp
    ) {
      refuse("migration_exact_recovery_timestamp_invalid");
    }
  }
  return Object.freeze({ command, request: Object.freeze(request) });
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  PoolClass,
  createPoolImpl = (poolConfig, options) =>
    createPostgresPool(poolConfig, { ...options, PoolClass }),
  closePoolImpl = closePostgresPool,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  let parsed;
  try {
    parsed = parseMigrationCommand(argv);
  } catch (error) {
    const code =
      error instanceof MigrationCommandFailure
        ? error.code
        : "migration_command_invalid";
    if (code === "migration_command_invalid") {
      stderr.write("Uso: npm run db:social -- status|validate|apply\n");
    } else {
      stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    }
    return 2;
  }

  let pool;
  try {
    const configuration = loadMigrationPostgresConfig(env);
    pool = createPoolImpl(configuration.pool, {
      logger: {
        error(event) {
          stderr.write(`${JSON.stringify(event)}\n`);
        }
      }
    });
    const runner = createMigrationRunner({
      pool,
      ownerRole: configuration.ownerRole,
      migratorRole: configuration.migratorRole,
      target: configuration.target
    });

    let result;
    if (parsed.command === "status") result = await runner.inspect();
    if (parsed.command === "validate") result = await runner.validate();
    if (parsed.command === "apply") result = await runner.apply(env);
    if (parsed.command === "plan-exact") {
      result = await runner.planExact(parsed.request, env);
    }
    if (parsed.command === "apply-exact") {
      result = await runner.applyExact(parsed.request, env);
    }
    const output = { ok: true, command: parsed.command, result };
    stdout.write(
      `${JSON.stringify(output, null, LEGACY_COMMANDS.has(parsed.command) ? 2 : 0)}\n`
    );
    return 0;
  } catch (error) {
    const code =
      typeof error?.code === "string"
        ? error.code
        : "migration_command_failed";
    const failure = { ok: false, code };
    if (error?.applied === true) failure.applied = true;
    if (error?.outcomeUnknown === true) failure.outcomeUnknown = true;
    if (error?.retryAllowed === false) failure.retryAllowed = false;
    if (error?.requiresReadOnlyInspection === true) {
      failure.requiresReadOnlyInspection = true;
    }
    stderr.write(`${JSON.stringify(failure)}\n`);
    return 1;
  } finally {
    if (pool) await closePoolImpl(pool);
  }
}

if (require.main === module) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({
          ok: false,
          code: error?.code || "migration_command_failed"
        })}\n`
      );
      process.exitCode = 1;
    });
}

module.exports = {
  LEGACY_COMMANDS,
  MigrationCommandFailure,
  parseMigrationCommand,
  main
};
