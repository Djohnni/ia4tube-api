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
async function createOperationalSession({ plan, stateRoot, packagePath, google, getBridgeKey, prepareApi, observeApi, closeApi, cleanupOnly = false }) {
  validateOperationalPlan(plan);
  if (typeof cleanupOnly !== "boolean" || typeof closeApi !== "function") fail("session_configuration_invalid");
  if (!cleanupOnly) {
    if (!path.isAbsolute(packagePath || "") || typeof prepareApi !== "function" || typeof observeApi !== "function" || typeof getBridgeKey !== "function") fail("session_configuration_invalid");
    const st = await fs.lstat(packagePath);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 67108864 || st.size < 1024 || sha256(await fs.readFile(packagePath)) !== plan.packageSha256) fail("package_changed");
  }
  const store = await createLocalStore(stateRoot);
  const getAccessToken = await gcloudReader(google);
  const liveProvider = createGoogleProvider({ plan: plan.infrastructure, getAccessToken });
  const forbidden = async () => fail("cleanup_only_operation_refused");
  const provider = cleanupOnly ? { ...liveProvider, create: forbidden, preflight: forbidden } : liveProvider;
  // Independent emergency teardown does not read the media package, credentials
  // or SSH guest state. Native termination cannot be claimed after this route;
  // external deletion and its absence check remain available.
  const guest = cleanupOnly ? { prepareLocalIdentity: forbidden, stopWorker: forbidden, collectOperational: forbidden } :
    await createOperationalGuest({ plan, stateRoot: store.root, packagePath, getBridgeKey });
  return Object.freeze({
    // No implicit/default confirmation. Root binds the already given mission
    // authorization to the final reviewed plan after verifying its full cost.
    execute({ approvalSha256, signal, onState } = {}) {
      return runOperationalPilot({ plan, approvalSha256, store, provider, guest, cleanupOnly,
        prepareApi: cleanupOnly ? forbidden : prepareApi, observeApi: cleanupOnly ? forbidden : observeApi, closeApi,
        signal: cleanupOnly ? null : signal, onState });
    }
  });
}
module.exports = { createOperationalSession };
