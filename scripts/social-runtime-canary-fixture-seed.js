"use strict";

const {
  seedRuntimeCanaryFixtures
} = require("../src/social/runtime-canary-fixture-seeder");

const SAFE_ERROR_CODE = /^[a-z0-9_]{2,96}$/i;

async function main({
  env = process.env,
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  seedFixtures = seedRuntimeCanaryFixtures
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    stderr.write(
      `${JSON.stringify({
        ok: false,
        code: "runtime_canary_fixture_argv_refused"
      })}\n`
    );
    return 2;
  }
  try {
    const result = await seedFixtures({ env });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const rawCode = String(error?.code || "");
    stderr.write(
      `${JSON.stringify({
        ok: false,
        code: SAFE_ERROR_CODE.test(rawCode)
          ? rawCode
          : "runtime_canary_fixture_seed_failed"
      })}\n`
    );
    return 1;
  }
}

if (require.main === module) {
  main().then((status) => {
    process.exitCode = status;
  });
}

module.exports = { main };
