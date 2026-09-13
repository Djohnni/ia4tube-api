"use strict";
const fs = require("node:fs/promises"), path = require("node:path");
const { createPlan, validatePlan, canonical, sha256 } = require("./vm-proof-manifest");
function argumentsOf(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!/^--[a-z][a-z0-9-]*$/.test(argv[i] || "") || typeof argv[i + 1] !== "string" || argv[i + 1].startsWith("--") || values[argv[i]]) throw new Error("vm_proof_arguments_invalid");
    values[argv[i]] = argv[i + 1];
  }
  return values;
}
async function main(argv) {
  const args = argumentsOf(argv), mode = args["--mode"];
  if (mode === "prepare") {
    if (Object.keys(args).some(k => !["--mode", "--package", "--plan", "--provider-ssh-key-id", "--provider-ssh-key-fingerprint"].includes(k)) || !args["--package"] || !args["--plan"]) throw new Error("vm_proof_prepare_arguments_invalid");
    // This mode has no provider import, credentials or key generation.
    const { buildPackage } = require("./vm-proof-package");
    const bundle = await buildPackage(path.resolve(__dirname, "../.."));
    const key = args["--provider-ssh-key-id"] || args["--provider-ssh-key-fingerprint"] ? { id: Number(args["--provider-ssh-key-id"]), fingerprint: args["--provider-ssh-key-fingerprint"] } : null;
    const plan = createPlan(sha256(bundle.bytes), key);
    await fs.writeFile(path.resolve(args["--package"]), bundle.bytes, { flag: "wx", mode: 0o600 });
    await fs.writeFile(path.resolve(args["--plan"]), canonical(plan) + "\n", { flag: "wx", mode: 0o600 });
    return { mode, paidExecution: false, packageSha256: plan.packageSha256, approvalSha256: plan.approvalSha256, sourceFiles: bundle.index.files.length, accountPrerequisitesPending: key === null };
  }
  if (mode !== "execute" || Object.keys(args).some(k => !["--mode", "--package", "--plan", "--approval-sha256", "--external-state-dir", "--credential-file", "--confirm"].includes(k)) ||
      args["--confirm"] !== "CREATE_ONE_SYNTHETIC_VM_MAX_2_HOURS_AND_DESTROY_ONLY_ITS_ID" ||
      ["--package", "--plan", "--approval-sha256", "--external-state-dir", "--credential-file"].some(k => !args[k])) throw new Error("vm_proof_specific_paid_confirmation_required");
  const planBytes = await fs.readFile(path.resolve(args["--plan"]));
  if (planBytes.length > 32768) throw new Error("vm_proof_plan_too_large");
  const plan = validatePlan(JSON.parse(planBytes.toString("utf8")));
  if (plan.approvalSha256 !== args["--approval-sha256"]) throw new Error("vm_proof_plan_confirmation_mismatch");
  if (plan.providerSshKey === null) throw new Error("vm_proof_existing_account_ssh_key_required");
  const { createLocalStore, readProviderCredential } = require("./vm-proof-local-state");
  const store = await createLocalStore(args["--external-state-dir"]);
  // Must already be an accepted account/payment method. This program has no
  // billing setup API and cannot consent to payments, backups, or larger plans.
  const token = await readProviderCredential(args["--credential-file"], store.root);
  const { createDigitalOceanProvider } = require("./vm-proof-digitalocean");
  const { createSshGuest } = require("./vm-proof-ssh");
  const { runProof } = require("./vm-proof-controller");
  const guest = await createSshGuest({ stateRoot: store.root, packagePath: path.resolve(args["--package"]), plan });
  return runProof({ plan, approvalSha256: args["--approval-sha256"], store, provider: createDigitalOceanProvider({ token }), guest });
}
if (require.main === module) main(process.argv.slice(2)).then(result => {
  process.stdout.write("VM_PROOF_CONTROL=" + JSON.stringify(result) + "\n");
  if (result.mode !== "prepare" && (!result.destructionConfirmed || result.failure)) process.exitCode = 1;
}).catch(error => {
  // Never emit raw provider, SSH, environment or file contents/paths.
  const code = /^vm_proof_[a-z_]+$/.test(error?.message || "") ? error.message : "vm_proof_closed_failure";
  process.stderr.write("VM_PROOF_ERROR=" + code + "\n"); process.exitCode = 1;
});
module.exports = { main, argumentsOf };
