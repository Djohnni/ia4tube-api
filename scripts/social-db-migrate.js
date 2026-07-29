"use strict";

const {
  loadMigrationPostgresConfig
} = require("../src/persistence/postgres/config");
const {
  closePostgresPool,
  createPostgresPool
} = require("../src/persistence/postgres/pool");
const {
  createMigrationRunner
} = require("../src/persistence/postgres/migrations");

const command = String(process.argv[2] || "").trim().toLowerCase();
if (!["status", "validate", "apply"].includes(command)) {
  process.stderr.write("Uso: npm run db:social -- status|validate|apply\n");
  process.exit(2);
}

async function main() {
  const config = loadMigrationPostgresConfig(process.env);
  const pool = createPostgresPool(config.pool, {
    logger: {
      error(event) {
        process.stderr.write(`${JSON.stringify(event)}\n`);
      }
    }
  });
  try {
    const runner = createMigrationRunner({
      pool,
      ownerRole: config.ownerRole,
      migratorRole: config.migratorRole,
      target: config.target
    });
    const result =
      command === "status"
        ? await runner.inspect()
        : command === "validate"
          ? await runner.validate()
          : await runner.apply(process.env);
    process.stdout.write(
      `${JSON.stringify({ ok: true, command, result }, null, 2)}\n`
    );
  } finally {
    await closePostgresPool(pool);
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      code: error?.code || "migration_command_failed"
    })}\n`
  );
  process.exitCode = 1;
});
