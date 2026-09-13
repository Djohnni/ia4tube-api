"use strict";
// A proposal, never an activation switch. No provider code is loaded here.
const crypto = require("node:crypto");
const CASES = Object.freeze([
  ["installed-preflight", "installed preflight identity and immutable launcher", 30, ["native-preflight"]],
  ["identity-read-isolation", "installed codec cannot read coordinator or another tenant", 30, ["read-isolation"]],
  ["aggregate-space", "installed aggregate scratch quota fails closed", 190, ["aggregate-quota"]],
  ["deadline-descendants", "installed aggregate deadline terminates descendants", 30, ["aggregate-deadline"]],
  ["source-limit", "installed preparation and independent validation", 560, ["generate-source", "inspect-source", "prepare-media", "inspect-derivative"]]
].map(([id, testName, caseBudgetSeconds, attempts]) => Object.freeze({ id, testName, caseBudgetSeconds, maxAttemptSeconds: 180, attempts: Object.freeze(attempts), retries: 0 })));
const MANIFEST = Object.freeze({ schema: 1, kind: "ia4tube-synthetic-vm-proof", paidExecutionDefault: false,
  provider: "digitalocean", resource: Object.freeze({ region: "sfo3", size: "s-1vcpu-2gb", image: "ubuntu-24-04-x64",
    vcpus: 1, memoryMiB: 2048, diskGiB: 50, backups: false, ipv6: false, monitoring: false }),
  maxExistenceSeconds: 7200, collectReserveSeconds: 600, destroyReserveSeconds: 600,
  hostPreflightSeconds: 180, installSeconds: 2400, maxLaunches: 10, concurrency: 1,
  maxAttemptSeconds: 180, maxProviderRequestSeconds: 20, cases: CASES,
  sequenceSeconds: 900, sequenceProcessCount: 1,
  testFile: "tests/calendar-import-media-process-installed-linux.test.js",
  hostPreflight: "scripts/media-vm/preflight-ubuntu24.sh", installer: "scripts/media-vm/install-ubuntu24.sh",
  guestDispatcher: "scripts/validation/vm-proof-guest.js",
  finance: Object.freeze({ hourlyUsd: 0.01786, computeTwoHoursUsd: 0.03572, referenceUsd: 0.10,
    guaranteedInvoiceCap: false, monthlyOperationAuthorized: false }),
  realMedia: false, instagram: false, remoteMigrations: false, apiDeploy: false });
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function createPlan(packageSha256, providerSshKey = null) {
  if (!/^[a-f0-9]{64}$/.test(packageSha256 || "")) throw new Error("vm_proof_package_hash_invalid");
  if (providerSshKey !== null && (!providerSshKey || Object.keys(providerSshKey).sort().join(",") !== "fingerprint,id" ||
    !Number.isSafeInteger(providerSshKey.id) || providerSshKey.id <= 0 || !/^(?:[a-f0-9]{2}:){15}[a-f0-9]{2}$/.test(providerSshKey.fingerprint || ""))) throw new Error("vm_proof_ssh_key_reference_invalid");
  const plan = { manifest: MANIFEST, packageSha256, providerSshKey };
  return Object.freeze({ ...plan, approvalSha256: sha256(canonical(plan)) });
}
function validatePlan(plan) {
  const expected = createPlan(plan?.packageSha256, plan?.providerSshKey);
  if (canonical(plan) !== canonical(expected)) throw new Error("vm_proof_plan_changed");
  return expected;
}
module.exports = { MANIFEST, CASES, canonical, sha256, createPlan, validatePlan };
