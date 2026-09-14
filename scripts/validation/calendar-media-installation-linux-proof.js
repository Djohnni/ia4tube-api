"use strict";
// Synthetic installation only on a disposable standard GitHub Ubuntu runner.
// No credentials, external provider, real media, coordinator/codec launch, or
// replacement bootstrap. Environment inventory and CI differences are explicit.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "../..");
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function fail(code) { throw Object.assign(new Error(code), { code }); }
function safePrint(kind, value) { process.stdout.write(kind + "=" + JSON.stringify(value) + "\n"); }
function context() {
  if (process.platform !== "linux" || process.getuid() === 0 || process.version !== "v24.15.0" ||
      process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
      process.env.GITHUB_REPOSITORY !== "Djohnni/ia4tube-api" || !/^[a-f0-9]{64}$/.test(process.env.PACKAGE_SHA256 || "")) fail("installation_ci_context_refused");
  const temp = process.env.RUNNER_TEMP;
  if (!temp || !path.isAbsolute(temp) || /[\r\n'"`$\\]/.test(temp) || temp === "/") fail("installation_ci_temp_refused");
  return { temp, packagePath: path.join(temp, "ia4tube-real-installation-bundle.tar"), expected: process.env.PACKAGE_SHA256,
    receipt: path.join(temp, "ia4tube-real-installation-prepared.json"), evidence: path.join(temp, "ia4tube-real-installation-evidence.json") };
}
function sudo(script, input = null) {
  try { return execFileSync("/usr/bin/sudo", ["-n", "/usr/bin/env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "/bin/bash", "-c", script],
    { encoding: "utf8", input, timeout: 60000, maxBuffer: 65536, cwd: ROOT, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" } }); }
  catch (error) {
    // Only emit the dedicated closed marker from our own fixed script, never
    // child exception text or its raw stdout/stderr/command.
    const marker = /(?:^|\n)INSTALLATION_CI_PRECONDITION_FAILED=([a-z_]{1,40})\n/.exec(String(error.stdout || ""));
    if (marker) safePrint("INSTALLATION_CI_PRECONDITION", { failedStage: marker[1], exitCode: Number.isSafeInteger(error.status) ? error.status : null });
    fail(error.signal ? "installation_ci_precondition_interrupted" : "installation_ci_precondition_failed");
  }
}
function jsonSafeRecords(output) {
  const result = [];
  for (const line of output.trim().split("\n")) {
    if (!/^[a-z][a-z0-9_]*=[A-Za-z0-9:/.+_~@()\- ]{1,250}$/.test(line)) fail("installation_ci_inventory_invalid");
    const at = line.indexOf("="); result.push({ field: line.slice(0, at), value: line.slice(at + 1) });
  }
  if (result.length > 80) fail("installation_ci_inventory_limit");
  return result;
}
const inventoryScript = `set -euo pipefail
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 && "$(uname -m)" == x86_64 ]]
printf 'os=%s-%s\narchitecture=%s\n' "$ID" "$VERSION_ID" "$(uname -m)"
for package in gcc ffmpeg e2fsprogs util-linux sudo curl ca-certificates xz-utils; do
  value=$(dpkg-query -W -f='\${db:Status-Abbrev} \${Version}' "$package" 2>/dev/null || true)
  if [[ "$value" == 'ii '* ]]; then printf 'package_%s=%s\n' "\${package//-/_}" "\${value#ii }"; else printf 'package_%s=absent\n' "\${package//-/_}"; fi
done
for name in apt-get timeout tar sha256sum gcc ffmpeg ffprobe node npm; do
  command_path=$(command -v "$name" || true)
  printf 'tool_%s=%s\n' "\${name//-/_}" "\${command_path:-absent}"
done
printf 'opt_owner=%s\nopt_mode=%s\n' "$(stat -c '%u' /opt)" "$(stat -c '%a' /opt)"
`;
// Runner-only precondition, not part of the VM package or real installer. The
// public runner image supplies a second Node entry, unrelated to setup-node's
// controller runtime. Preserve that exact entry, never remove its runtime.
const normalizeRunnerNodeScript = String.raw`
precondition_stage=runner_node_backup_target
node_entry=/usr/local/bin/node
node_backup=/var/tmp/ia4tube-ci-original-node
[[ ! -e "$node_backup" && ! -L "$node_backup" ]]
if [[ -e "$node_entry" || -L "$node_entry" ]]; then
  precondition_stage=runner_node_entry_type
  if [[ -L "$node_entry" ]]; then
    node_type=symlink
    node_link=$(readlink -- "$node_entry")
    [[ $(stat -c '%s' -- "$node_entry") -le 4096 ]]
    read -r node_hash _ < <(readlink -n -- "$node_entry" | sha256sum)
    node_hash_kind=symlink_text_not_target
    node_link_observed=not_exported_unrecognized_path
    if [[ "$node_link" =~ ^/(usr/local|opt|usr/bin|home/runner)/[A-Za-z0-9._+/-]+$ && $(printf '%s' "$node_link" | wc -c) -le 240 ]]; then node_link_observed="$node_link"; fi
  elif [[ -f "$node_entry" ]]; then node_type=regular;
    [[ $(stat -c '%s' -- "$node_entry") -ge 1 && $(stat -c '%s' -- "$node_entry") -le 134217728 ]]
    read -r node_hash _ < <(sha256sum -- "$node_entry")
    node_hash_kind=regular_entry_bytes
    node_link_observed=not_a_symlink
  else refuse_precondition; fi
  precondition_stage=runner_node_entry_owner
  [[ $(stat -c '%u' -- "$node_entry") == 0 ]]
  node_mode=$(stat -c '%a' -- "$node_entry")
  [[ "$node_hash" =~ ^[a-f0-9]{64}$ ]]
  node_identity=$(stat -c '%d:%i:%u:%a:%h' -- "$node_entry")
  printf 'runner_node_entry_type=%s\nrunner_node_entry_owner=0\nrunner_node_entry_mode=%s\nrunner_node_entry_identity=%s\nrunner_node_link_observed=%s\nrunner_node_entry_sha256=%s\nrunner_node_hash_kind=%s\nrunner_node_execution=not_executed_not_trusted_as_installer_runtime\n' \
    "$node_type" "$node_mode" "$node_identity" "$node_link_observed" "$node_hash" "$node_hash_kind"
  precondition_stage=runner_node_preserve_entry
  mv -T -n -- "$node_entry" "$node_backup"
  [[ ! -e "$node_entry" && ! -L "$node_entry" && $(stat -c '%d:%i:%u:%a:%h' -- "$node_backup") == "$node_identity" ]]
  if [[ "$node_type" == symlink ]]; then read -r node_preserved_hash _ < <(readlink -n -- "$node_backup" | sha256sum);
  else read -r node_preserved_hash _ < <(sha256sum -- "$node_backup"); fi
  [[ "$node_preserved_hash" == "$node_hash" ]]
  printf 'runner_node_preserved=original_entry_moved_to_exclusive_backup\n'
else
  printf 'runner_node_preserved=entry_was_absent\n'
fi
`;
async function prepare() {
  const cfg = context(); process.umask(0o077);
  const tempStat = await fs.lstat(cfg.temp); if (!tempStat.isDirectory() || tempStat.isSymbolicLink()) fail("installation_ci_temp_unsafe");
  const before = jsonSafeRecords(sudo(inventoryScript));
  safePrint("INSTALLATION_CI_INVENTORY_BEFORE", before);
  const controllerRuntime = await fs.realpath(process.execPath);
  if (process.execPath === "/usr/local/bin/node" || controllerRuntime === "/usr/local/bin/node" || !/^\/opt\/hostedtoolcache\/node\/24\.15\.0\/x64\/bin\/node$/.test(controllerRuntime)) fail("installation_ci_controller_runtime_not_separate");
  safePrint("INSTALLATION_CI_CONTROLLER_RUNTIME", { source: "explicit_setup_node_cache", path: controllerRuntime, version: process.version });
  const { buildPackage } = require("./vm-proof-package");
  const built = await buildPackage(ROOT), packageHash = sha256(built.bytes);
  if (packageHash !== cfg.expected) { safePrint("INSTALLATION_CI_PACKAGE_MISMATCH", { expected: cfg.expected, observed: packageHash }); fail("installation_ci_package_changed"); }
  await fs.writeFile(cfg.packagePath, built.bytes, { flag: "wx", mode: 0o600 });
  // Explicit normalization is allowed ONLY on this disposable GitHub host.
  // The real preflight/installer never repairs unsafe shared-host ancestors.
  // The account, home and extracted package correspond to the remote proof's
  // already-tested SSH bootstrap/extraction, not to dependency preparation.
  const prepared = sudo(`set -euo pipefail
precondition_stage=identity
trap 'printf "INSTALLATION_CI_PRECONDITION_FAILED=%s\\n" "$precondition_stage"' ERR
refuse_precondition(){ printf 'INSTALLATION_CI_PRECONDITION_FAILED=%s\\n' "$precondition_stage"; exit 77; }
[[ $(id -u) == 0 ]]
precondition_stage=existing_targets
for target in /var/tmp/ia4tube-proof-bundle /var/tmp/ia4tube-proof-bundle.tar /var/tmp/ia4tube-proof-diagnostics /var/tmp/ia4tube-proof-node-v24.15.0-linux-x64.tar.xz /opt/node-v24.15.0-linux-x64 /opt/ia4tube-media /var/lib/ia4tube-media /etc/ia4tube-media; do
  case "$target" in
    /var/tmp/ia4tube-proof-bundle) precondition_stage=existing_bundle ;;
    /var/tmp/ia4tube-proof-bundle.tar) precondition_stage=existing_bundle_archive ;;
    /var/tmp/ia4tube-proof-diagnostics) precondition_stage=existing_diagnostics ;;
    /var/tmp/ia4tube-proof-node-v24.15.0-linux-x64.tar.xz) precondition_stage=existing_node_archive ;;
    /opt/node-v24.15.0-linux-x64) precondition_stage=existing_pinned_runtime ;;
    /opt/ia4tube-media) precondition_stage=existing_installed_package ;;
    /var/lib/ia4tube-media) precondition_stage=existing_media_state ;;
    /etc/ia4tube-media) precondition_stage=existing_media_config ;;
  esac
  [[ ! -e "$target" && ! -L "$target" ]]
done
precondition_stage=existing_accounts
for account in ia4proof ia4tube-coordinator ia4tube-codec; do ! getent passwd "$account" >/dev/null; done
precondition_stage=ephemeral_opt
[[ -d /opt && ! -L /opt && $(stat -c '%u' /opt) == 0 ]]
chmod 0755 -- /opt
${normalizeRunnerNodeScript}
precondition_stage=synthetic_account
useradd --create-home --user-group --home-dir /home/ia4proof --shell /bin/bash ia4proof
chmod 0700 /home/ia4proof
precondition_stage=package_extraction
install -d -m 0700 -o ia4proof -g ia4proof /var/tmp/ia4tube-proof-bundle
install -m 0600 -o ia4proof -g ia4proof '${cfg.packagePath}' /var/tmp/ia4tube-proof-bundle.tar
sudo -n -u ia4proof tar --no-same-owner --no-same-permissions -xf /var/tmp/ia4tube-proof-bundle.tar -C /var/tmp/ia4tube-proof-bundle
printf '%s  %s\n' '${cfg.expected}' /var/tmp/ia4tube-proof-bundle.tar | sha256sum -c - >/dev/null
precondition_stage=host_preflight
bash /var/tmp/ia4tube-proof-bundle/scripts/media-vm/preflight-ubuntu24.sh
printf 'INSTALLATION_CI_PRECONDITIONS=PASS\n'
`);
  if (!/^VM_HOST_PREFLIGHT=PASS$/m.test(prepared) || !/^INSTALLATION_CI_PRECONDITIONS=PASS$/m.test(prepared)) fail("installation_ci_preconditions_unconfirmed");
  const nodePrecondition = jsonSafeRecords(prepared.split("\n").filter(line => line.startsWith("runner_node_")).join("\n"));
  safePrint("INSTALLATION_CI_EXISTING_NODE_PRESERVED", nodePrecondition);
  const record = { schema: 1, syntheticOnly: true, expectedPackageSha256: cfg.expected, packageBytes: built.bytes.length,
    bootstrapReplaced: false, packageInstallerReplaced: false, preflightPassed: true,
    explicitCiDifferences: ["GitHub-hosted Ubuntu 24.04, not the exact Google image or E2 machine", "Existing distribution dependency inventory recorded before bootstrap",
      "External builder/controller uses setup-node; bootstrap still installs its separate official pinned runtime", "Ephemeral runner /opt normalized to root:0755 before unchanged preflight",
      "Existing root-owned runner Node entry preserved in an exclusive fixed backup; bundled NODE_PATH_OCCUPIED guard unchanged",
      "Synthetic ia4proof account and source bundle prepared without SSH or provider bootstrap"], before, nodePrecondition };
  await fs.writeFile(cfg.receipt, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  safePrint("INSTALLATION_CI_PREPARED", record);
}
async function run() {
  const cfg = context(); process.umask(0o077);
  const prepared = JSON.parse(await fs.readFile(cfg.receipt, "utf8"));
  if (prepared.expectedPackageSha256 !== cfg.expected || !prepared.preflightPassed || sha256(await fs.readFile(cfg.packagePath)) !== cfg.expected) fail("installation_ci_preparation_changed");
  const { runDiagnosticProcess, validateInstallDiagnostic } = require("./vm-proof-install-diagnostics");
  const { installationScript, collectInstallationScript } = require("./vm-proof-install-shell");
  const startedAt = Date.now();
  // EXACTLY one installation attempt. Collection is independent and always
  // runs, even before installed Node/coordinator/executor exists.
  let installation = null, collection = null, installationDiagnosticError = null, collectionDiagnosticError = null;
  try {
    installation = await runDiagnosticProcess("/usr/bin/sudo", ["-n", "/bin/bash", "-s"],
      { stdin: installationScript(), timeoutMs: 2400000 });
    if (!validateInstallDiagnostic(installation)) { installation = null; installationDiagnosticError = "invalid_schema"; }
  } catch { installationDiagnosticError = "diagnostic_invocation_failed"; }
  finally {
    try {
      collection = await runDiagnosticProcess("/usr/bin/sudo", ["-n", "/bin/bash", "-s"],
        { stdin: collectInstallationScript(), timeoutMs: 60000 });
      if (!validateInstallDiagnostic(collection)) { collection = null; collectionDiagnosticError = "invalid_schema"; }
    } catch { collectionDiagnosticError = "diagnostic_invocation_failed"; }
  }
  if (installation) safePrint("INSTALLATION_CI_RESULT", installation);
  else safePrint("INSTALLATION_CI_DIAGNOSTIC_ERROR", { code: installationDiagnosticError });
  if (collection) safePrint("INSTALLATION_CI_COLLECTION", collection);
  else safePrint("INSTALLATION_CI_COLLECTION_ERROR", { code: collectionDiagnosticError });
  let after = null, inventoryError = null;
  try { after = jsonSafeRecords(sudo(inventoryScript)); safePrint("INSTALLATION_CI_INVENTORY_AFTER", after); }
  catch { inventoryError = "post_inventory_unconfirmed"; safePrint("INSTALLATION_CI_INVENTORY_ERROR", { code: inventoryError }); }
  const collectionPassed = collection !== null && collection.exitCode === 0 && !collection.signal && !collection.timedOut && !collection.aborted &&
    !collection.spawnFailed && !collection.stdinFailed && !collection.protocolInvalid && !collection.collectionError && !collection.remoteCaptureFailed;
  const replayVerified = installation !== null && collection !== null && collectionPassed &&
    installation.finalMarkerReceived === collection.finalMarkerReceived && JSON.stringify(installation.markers) === JSON.stringify(collection.markers);
  const began = stage => installation?.markers.some(marker => marker.stage === stage && marker.event === "start") === true;
  const evidence = { schema: 1, syntheticOnly: true, packageSha256: cfg.expected, realBootstrapStarted: began("dependencies_runtime"), realPackageInstallerStarted: began("package_install"),
    installationInvocations: 1, converterLaunches: 0, physicalCasesRun: 0, installation, installationDiagnosticError, collection, collectionDiagnosticError, collectionPassed, replayVerified,
    explicitCiDifferences: prepared.explicitCiDifferences, before: prepared.before, after, inventoryError, durationMs: Date.now() - startedAt };
  await fs.writeFile(cfg.evidence, JSON.stringify(evidence), { flag: "wx", mode: 0o600 });
  safePrint("INSTALLATION_CI_SUMMARY", { packageSha256: cfg.expected, installationPassed: installation?.installationPassed === true, collectionPassed, replayVerified,
    attempts: 1, converterLaunches: 0, durationMs: evidence.durationMs, evidenceSha256: sha256(JSON.stringify(evidence)) });
  if (!installation?.installationPassed || !collectionPassed || !replayVerified || inventoryError) fail("installation_ci_proof_not_passed");
}
if (require.main === module) {
  const action = process.argv.length === 3 ? process.argv[2] : "";
  (action === "prepare" ? prepare() : action === "run" ? run() : Promise.reject(Object.assign(new Error("installation_ci_action_invalid"), { code: "installation_ci_action_invalid" })))
    .catch(error => { safePrint("INSTALLATION_CI_FAILURE", { code: /^installation_ci_[a-z_]+$/.test(error.code || "") ? error.code : "installation_ci_unclassified_error" }); process.exitCode = 1; });
}
module.exports = { inventoryScript, normalizeRunnerNodeScript, jsonSafeRecords };
