"use strict";
// Explicit composition only. Importing this module performs no authentication,
// resource creation, DB/API change or worker launch. Caller owns the readiness
// callbacks and must have their protected configuration channel prepared.
const fs = require("node:fs/promises"), path = require("node:path");
const { sha256 } = require("../validation/vm-proof-manifest");
const { createLocalStore } = require("../validation/vm-proof-local-state");
const { gcloudReader } = require("../validation/vm-proof-google-cli");
const { createGoogleProvider } = require("../validation/vm-proof-google-provider");
const { validateOperationalPlan, fail } = require("./google-plan");
const { createOperationalGuest } = require("./google-guest");
const { runOperationalPilot } = require("./google-controller");
async function createOperationalSession({ plan, stateRoot, packagePath, google, getBridgeKey, prepareApi, observeApi }) {
  validateOperationalPlan(plan);
  if (!path.isAbsolute(packagePath || "") || typeof prepareApi !== "function" || typeof observeApi !== "function" || typeof getBridgeKey !== "function") fail("session_configuration_invalid");
  const st = await fs.lstat(packagePath);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 67108864 || st.size < 1024 || sha256(await fs.readFile(packagePath)) !== plan.packageSha256) fail("package_changed");
  const store = await createLocalStore(stateRoot);
  const getAccessToken = await gcloudReader(google);
  const provider = createGoogleProvider({ plan: plan.infrastructure, getAccessToken });
  const guest = await createOperationalGuest({ plan, stateRoot: store.root, packagePath, getBridgeKey });
  return Object.freeze({
    // No implicit/default confirmation. Root binds the already given mission
    // authorization to the final reviewed plan after verifying its full cost.
    execute({ approvalSha256, signal, onState } = {}) {
      return runOperationalPilot({ plan, approvalSha256, store, provider, guest, prepareApi, observeApi, signal, onState });
    }
  });
}
module.exports = { createOperationalSession };
