"use strict";
// No SSH, provider, network, real credentials or installation: only local
// protected files and injected transports with synthetically valid receipts.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const { createSshGuest } = require("../scripts/validation/vm-proof-ssh");
const { protectedPath } = require("../scripts/validation/vm-proof-local-state");
const { sha256 } = require("../scripts/validation/vm-proof-manifest");
const { STAGES, createInstallDiagnosticParser, classifyInstallDiagnostic, validateInstallDiagnostic } = require("../scripts/validation/vm-proof-install-diagnostics");
const { installationScript, collectInstallationScript } = require("../scripts/validation/vm-proof-install-shell");

const missionId = "00000000-0000-4000-8000-000000000137", address = "203.0.113.17";
const publicKey = "ssh-ed25519 " + Buffer.alloc(48, 7).toString("base64") + " synthetic-not-a-real-key";
const privateKey = ["-----BEGIN " + "OPENSSH PRIVATE KEY-----", Buffer.from("synthetic-not-a-real-key").toString("base64"), "-----END " + "OPENSSH PRIVATE KEY-----", ""].join("\n");

function observation({ exitCode = 0, failedStage = null, partial = false } = {}) {
  let at = 1770000000000, text = "";
  for (const stage of partial ? ["initialization"] : STAGES) {
    text += `IA4INSTALL ${stage} start ${at++} -\n`;
    text += `IA4INSTALL ${stage} ${stage === failedStage ? "failed" : "done"} ${at++} ${stage === failedStage ? 37 : 0}\n`;
    if (stage === failedStage) break;
  }
  if (!partial && !failedStage) text += "IA4INSTALL_COMPLETE=PASS\n";
  const parser = createInstallDiagnosticParser(); parser.push(text);
  const bytes = Buffer.byteLength(text);
  const result = { schema: 1, classification: "completion_unconfirmed", installationPassed: false,
    exitCode, signal: null, timedOut: false, aborted: false, spawnFailed: false, stdinFailed: false,
    startedAtMs: 1770000000000, completedAtMs: 1770000000010, durationMs: 10,
    stdoutBytes: bytes, stderrBytes: 0, captureLimitBytes: 65536,
    captureTruncated: { stdout: false, stderr: false }, retainedBytes: { stdout: bytes, stderr: 0 },
    ...parser.finish(), collectionError: false, spawnErrorCode: null, retryPermitted: false };
  result.classification = classifyInstallDiagnostic(result);
  result.installationPassed = result.classification === "installation_complete";
  assert.equal(validateInstallDiagnostic(result), true);
  return result;
}

async function temporary(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "ia4tube-install-ssh-synthetic-"));
  t.after(async () => {
    const actual = await fs.realpath(folder), base = await fs.realpath(os.tmpdir());
    assert.equal(path.dirname(actual).toLowerCase(), base.toLowerCase());
    assert.match(path.basename(actual), /^ia4tube-install-ssh-synthetic-/);
    await fs.rm(actual, { recursive: true, force: false }); // This exact newly created and verified synthetic fixture only.
  });
  if (process.platform === "win32") {
    const script = '$ErrorActionPreference="Stop"; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $a=New-Object System.Security.AccessControl.DirectorySecurity; $a.SetSecurityDescriptorSddlForm(("D:P(A;OICI;FA;;;"+$sid+")(A;OICI;FA;;;SY)"),[System.Security.AccessControl.AccessControlSections]::Access); (Get-Item -LiteralPath $env:IA4_INSTALL_SSH_FIXTURE -Force).SetAccessControl($a)';
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, shell: false, stdio: "ignore", timeout: 10000,
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, IA4_INSTALL_SSH_FIXTURE: folder }
    });
    assert.equal(result.status, 0, "private ACL applied only to this new synthetic fixture");
  } else await fs.chmod(folder, 0o700);
  await protectedPath(folder, { directory: true });
  return folder;
}

async function fixture(t, replies) {
  const folder = await temporary(t), packagePath = path.join(folder, "synthetic-package.tar"), packageBytes = Buffer.from("synthetic-package-with-no-real-files");
  await fs.writeFile(packagePath, packageBytes, { mode: 0o600 });
  const plan = { packageSha256: sha256(packageBytes), approvalSha256: "b".repeat(64) };
  const invocations = [], keygen = [];
  const run = async (command, args) => {
    assert.equal(path.basename(command), process.platform === "win32" ? "ssh-keygen.exe" : "ssh-keygen");
    keygen.push({ command, args });
    const file = args[args.indexOf("-f") + 1];
    assert.equal(path.dirname(file), folder);
    assert.ok(["proof-host-ed25519", "proof-admin-ed25519"].includes(path.basename(file)));
    await fs.writeFile(file, privateKey, { mode: 0o600 });
    await fs.writeFile(file + ".pub", publicKey + "\n", { mode: 0o600 });
    return "";
  };
  const diagnosticRun = async (command, args, options) => {
    invocations.push({ command, args, options });
    const reply = replies[invocations.length - 1];
    assert.notEqual(reply, undefined, "no unexpected repeat or network invocation");
    return typeof reply === "function" ? reply() : structuredClone(reply);
  };
  const guest = await createSshGuest({ stateRoot: folder, packagePath, plan, run, diagnosticRun, providerKind: "google" });
  await guest.prepareLocalIdentity({ missionId });
  await guest.bindHost({ networkInterfaces: [{ accessConfigs: [{ natIP: address }] }] }, { missionId });
  assert.equal(keygen.length, 2); assert.equal(invocations.length, 0);
  return { guest, folder, plan, invocations, keygen };
}

function assertPinned(call, folder, script) {
  assert.equal(path.basename(call.command), process.platform === "win32" ? "ssh.exe" : "ssh");
  assert.deepEqual(call.args.slice(-2), ["ia4proof@" + address, "sudo -n bash -s"]);
  for (const option of ["BatchMode=yes", "StrictHostKeyChecking=yes", "UserKnownHostsFile=" + path.join(folder, "proof-known-hosts"), "ForwardAgent=no", "ClearAllForwardings=yes", "PermitLocalCommand=no", "ProxyCommand=none", "IdentitiesOnly=yes", "ServerAliveInterval=5", "ServerAliveCountMax=2"]) assert.ok(call.args.includes(option), option);
  assert.ok(call.args.includes("GlobalKnownHostsFile=" + (process.platform === "win32" ? "NUL" : "/dev/null")));
  assert.deepEqual(call.args.slice(0, 2), ["-F", process.platform === "win32" ? "NUL" : "/dev/null"]);
  assert.equal(call.args[call.args.indexOf("-i") + 1], path.join(folder, "proof-admin-ed25519"));
  assert.equal(call.options.stdin, script); assert.equal(call.options.maxBytes, 65536);
  assert.equal(call.options.timeoutMs, 15000);
  assert.equal(call.args.some(arg => arg.includes(privateKey)), false);
}

test("SSH guest makes one pinned installer invocation and persists sanitized proof", async t => {
  const installed = observation(), collected = observation();
  const { guest, folder, plan, invocations } = await fixture(t, [installed, collected]);
  const cfg = { timeoutMs: 20000, signal: new AbortController().signal };
  const result = await guest.install(cfg);
  assert.equal(result.passed, true); assert.equal(result.convertersStarted, 0); assert.deepEqual(result.diagnostic, installed);
  assert.equal(invocations.length, 1); assertPinned(invocations[0], folder, installationScript());
  assert.equal(invocations[0].options.signal, cfg.signal);
  const savedPath = path.join(folder, "installation-diagnostics.json"), saved = JSON.parse(await fs.readFile(savedPath, "utf8"));
  await protectedPath(savedPath);
  assert.deepEqual(saved, { schema: 1, missionId, planSha256: plan.approvalSha256, observation: installed });
  assert.equal(JSON.stringify(saved).includes(privateKey), false); assert.equal(Object.hasOwn(saved.observation, "stdout"), false);
  const evidence = await guest.collectInstallationDiagnostics({ ...cfg, missionId });
  assert.equal(evidence.collectionSucceeded, true); assertPinned(invocations[1], folder, collectInstallationScript());
  await protectedPath(path.join(folder, "installation-collection.json"));
  const record = JSON.parse(await fs.readFile(path.join(folder, "installation-collection.json"), "utf8"));
  assert.deepEqual(record.initialObservation, installed); assert.deepEqual(record.collectedObservation, collected);
  assert.equal(evidence.sha256, sha256(JSON.stringify(record)));
  await assert.rejects(guest.install(cfg), /installation_repeat_refused/); assert.equal(invocations.length, 2);
  assert.equal(await fs.readFile(path.join(folder, "proof-known-hosts"), "utf8"), address + " " + publicKey + "\n");
});

test("unknown transport never repeats installation even after independent complete collection", async t => {
  const unknown = observation({ exitCode: 255 }), complete = observation();
  const { guest, folder, invocations } = await fixture(t, [unknown, complete]);
  let failure;
  try { await guest.install({ timeoutMs: 20000 }); } catch (error) { failure = error; }
  assert.equal(failure.code, "vm_proof_ssh_installation_transport_interrupted_unknown");
  assert.deepEqual(failure.diagnostic, unknown);
  await assert.rejects(guest.install({ timeoutMs: 20000 }), /installation_repeat_refused/);
  assert.equal(invocations.length, 1);
  const result = await guest.collectInstallationDiagnostics({ missionId, timeoutMs: 20000 });
  assert.equal(result.collectionSucceeded, true); assert.equal(result.diagnostic.installationPassed, true);
  const saved = JSON.parse(await fs.readFile(path.join(folder, "installation-collection.json"), "utf8"));
  assert.equal(saved.initialObservation.installationPassed, false); assert.equal(saved.initialObservation.exitCode, 255);
  await assert.rejects(guest.install({ timeoutMs: 20000 }), /installation_repeat_refused/);
  assert.equal(invocations.length, 2);
});

test("independent collector works before installer or executor exists", async t => {
  const partial = observation({ partial: true });
  const { guest, folder, invocations } = await fixture(t, [partial]);
  const result = await guest.collectInstallationDiagnostics({ missionId, timeoutMs: 20000 });
  assert.equal(result.collectionSucceeded, true); assert.equal(result.diagnostic.installationPassed, false);
  assert.equal(result.diagnostic.lastCompletedStage, "initialization");
  assert.equal(invocations.length, 1); assertPinned(invocations[0], folder, collectInstallationScript());
  assert.equal(invocations[0].options.stdin.includes("/opt/ia4tube-media/runtime/usr/bin/node"), false);
  assert.equal(invocations[0].options.stdin.includes("vm-proof-guest.js"), false);
  await assert.rejects(fs.access(path.join(folder, "installation-diagnostics.json")), { code: "ENOENT" });
  const saved = JSON.parse(await fs.readFile(path.join(folder, "installation-collection.json"), "utf8"));
  assert.equal(saved.initialObservation, null); assert.deepEqual(saved.collectedObservation, partial);
});

test("collector persistence failure retains received diagnosis and prior installation evidence", async t => {
  const failed = observation({ failedStage: "dependencies_runtime", exitCode: 37 });
  const collected = observation({ failedStage: "dependencies_runtime" });
  const { guest, folder, invocations } = await fixture(t, [failed, collected]);
  await assert.rejects(guest.install({ timeoutMs: 20000 }), /installation_substep_failed/);
  const prior = await fs.readFile(path.join(folder, "installation-diagnostics.json"), "utf8");
  await fs.mkdir(path.join(folder, "installation-collection.json"), { mode: 0o700 });
  let failure;
  try { await guest.collectInstallationDiagnostics({ missionId, timeoutMs: 20000 }); } catch (error) { failure = error; }
  assert.equal(failure.code, "vm_proof_ssh_installation_collection_persistence_failed");
  assert.equal(validateInstallDiagnostic(failure.diagnostic), true); assert.deepEqual(failure.diagnostic, collected);
  assert.equal(await fs.readFile(path.join(folder, "installation-diagnostics.json"), "utf8"), prior);
  assert.equal(invocations.length, 2);
  await assert.rejects(guest.install({ timeoutMs: 20000 }), /installation_repeat_refused/);
});

test("installer persistence failure retains observation and still permits independent collection only", async t => {
  const installed = observation(), collected = observation();
  const { guest, folder, invocations } = await fixture(t, [installed, collected]);
  await fs.mkdir(path.join(folder, "installation-diagnostics.json"), { mode: 0o700 });
  let failure;
  try { await guest.install({ timeoutMs: 20000 }); } catch (error) { failure = error; }
  assert.equal(failure.code, "vm_proof_ssh_installation_persistence_failed"); assert.deepEqual(failure.diagnostic, installed);
  await assert.rejects(guest.install({ timeoutMs: 20000 }), /installation_repeat_refused/);
  const result = await guest.collectInstallationDiagnostics({ missionId, timeoutMs: 20000 });
  assert.equal(result.collectionSucceeded, true);
  const saved = JSON.parse(await fs.readFile(path.join(folder, "installation-collection.json"), "utf8"));
  assert.deepEqual(saved.initialObservation, installed); assert.equal(invocations.length, 2);
});

test("invalid diagnostic response is rejected without persisting arbitrary payload or repeating install", async t => {
  const { guest, folder, invocations } = await fixture(t, [{ ...observation(), rawSecret: "SYNTHETIC_MUST_NOT_PERSIST" }]);
  await assert.rejects(guest.install({ timeoutMs: 20000 }), error => error.code === "vm_proof_ssh_installation_diagnostic_invalid" && !JSON.stringify(error).includes("SYNTHETIC_MUST_NOT_PERSIST"));
  await assert.rejects(guest.install({ timeoutMs: 20000 }), /installation_repeat_refused/);
  assert.equal(invocations.length, 1);
  await assert.rejects(fs.access(path.join(folder, "installation-diagnostics.json")), { code: "ENOENT" });
});

test("collector transport failure remains collection failure without changing installer receipt", async t => {
  const installed = observation(), lostCollector = observation({ partial: true, exitCode: 255 });
  const { guest, folder, invocations } = await fixture(t, [installed, lostCollector]);
  await guest.install({ timeoutMs: 20000 });
  const result = await guest.collectInstallationDiagnostics({ missionId, timeoutMs: 20000 });
  assert.equal(result.collectionSucceeded, false); assert.equal(result.diagnostic.classification, "transport_interrupted_unknown");
  const saved = JSON.parse(await fs.readFile(path.join(folder, "installation-collection.json"), "utf8"));
  assert.equal(saved.initialObservation.installationPassed, true); assert.equal(saved.collectedObservation.installationPassed, false);
  assert.equal(invocations.length, 2);
});
