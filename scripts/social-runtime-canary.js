"use strict";

const {
  runSyntheticRuntimeCanary
} = require("../src/social/runtime-canary");

const SAFE_ERROR_CODE = /^[a-z0-9_]{2,96}$/i;

async function main({
  env = process.env,
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  runCanary = runSyntheticRuntimeCanary
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    stderr.write(
      `${JSON.stringify({
        ok: false,
        code: "social_runtime_canary_argv_refused"
      })}\n`
    );
    return 2;
  }
  try {
    const result = await runCanary({ env });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const rawCode = String(error?.code || "");
    stderr.write(
      `${JSON.stringify({
        ok: false,
        code: SAFE_ERROR_CODE.test(rawCode)
          ? rawCode
          : "social_runtime_canary_failed"
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
