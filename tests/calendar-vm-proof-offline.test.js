"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const { createLocalStore, protectedPath, protectCreatedFile } = require("../scripts/validation/vm-proof-local-state");
const { parseEvidence, closedFailure, validateFailure } = require("../scripts/validation/vm-proof-guest");
const { MANIFEST, sha256 } = require("../scripts/validation/vm-proof-manifest");
const { buildPackage } = require("../scripts/validation/vm-proof-package");
const { main } = require("../scripts/validation/vm-proof-cli");
const root = path.resolve(__dirname, "..");
async function temporary(t, secure = false) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "ia4tube-vm-proof-synthetic-"));
  t.after(async () => {
    const actual = await fs.realpath(folder), base = await fs.realpath(os.tmpdir());
    assert.equal(path.dirname(actual).toLowerCase(), base.toLowerCase());
    assert.match(path.basename(actual), /^ia4tube-vm-proof-synthetic-/);
    await fs.rm(actual, { recursive: true, force: false }); // Only this newly created, verified synthetic fixture.
  });
  if (secure && process.platform === "win32") {
    const script = '$ErrorActionPreference="Stop"; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object System.Security.AccessControl.DirectorySecurity; $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); foreach($s in @($sid.Value,"S-1-5-18")) { $r=New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($s)),"FullControl","ContainerInherit,ObjectInherit","None","Allow"); $a.AddAccessRule($r) }; Set-Acl -LiteralPath $env:VM_PROOF_FIXTURE -AclObject $a';
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, shell: false, encoding: "utf8", timeout: 10000,
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, VM_PROOF_FIXTURE: folder } });
    assert.equal(r.status, 0, "synthetic fixture private ACL created: " + r.stderr);
  } else if (secure) await fs.chmod(folder, 0o700);
  return folder;
}
function state(phase) { return { missionId: "00000000-0000-4000-8000-000000000000", planSha256: "a".repeat(64), phase }; }
test("physical protected journal survives a new controller and records create intent durably", async t => {
  const directory = await temporary(t, true), first = await createLocalStore(directory);
  await first.exclusive(async () => { assert.equal(await first.read(), null); await first.write(state("prepared")); await first.write(state("create_intent")); });
  const next = await createLocalStore(directory);
  await next.exclusive(async () => assert.equal((await next.read()).phase, "create_intent"));
  const lines = (await fs.readFile(path.join(directory, "lifecycle.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2); assert.equal(lines[1].previous, lines[0].hash);
  await protectedPath(path.join(directory, "lifecycle.jsonl")); await protectedPath(path.join(directory, "session-marker.json"));
});
test("physical partial journal tail after separate process exit blocks fallback and new work", async t => {
  const directory = await temporary(t, true), s = await createLocalStore(directory);
  await s.exclusive(async () => s.write(state("prepared")));
  const child = spawnSync(process.execPath, ["-e", 'const f=require("node:fs"),p=process.argv[1];const h=f.openSync(p,"a");f.writeSync(h,"{\\\"revision\\\":2,");f.fsyncSync(h);process.exit(77)', path.join(directory, "lifecycle.jsonl")], { shell: false, windowsHide: true, stdio: "ignore" });
  assert.equal(child.status, 77);
  const fresh = await createLocalStore(directory);
  await fresh.exclusive(async () => {
    await assert.rejects(fresh.read(), /journal_incomplete_no_repeat/);
    await assert.rejects(fresh.write(state("prepared")), /journal_incomplete_no_repeat/);
  });
});
test("physical marker and journal loss or modified hash never become an empty fresh session", async t => {
  for (const mode of ["lost-journal", "lost-marker", "modified-hash"]) {
    const directory = await temporary(t, true), s = await createLocalStore(directory);
    await s.exclusive(async () => s.write(state("create_intent")));
    const journal = path.join(directory, "lifecycle.jsonl"), marker = path.join(directory, "session-marker.json");
    if (mode === "lost-journal") await fs.unlink(journal);
    else if (mode === "lost-marker") await fs.unlink(marker);
    else await fs.writeFile(journal, (await fs.readFile(journal, "utf8")).replace('"create_intent"', '"prepared"'));
    const fresh = await createLocalStore(directory);
    await fresh.exclusive(async () => {
      await assert.rejects(fresh.read(), /vm_proof_(journal_missing_no_repeat|session_marker_missing_or_invalid|journal_chain_invalid)/);
    });
  }
});
test("physical OS-owned exclusion blocks concurrent controllers and releases on process exit", async t => {
  const directory = await temporary(t, true), first = await createLocalStore(directory), second = await createLocalStore(directory);
  await first.exclusive(async () => {
    await assert.rejects(second.exclusive(async () => { throw new Error("must not enter"); }), /controller_already_running/);
  });
  await second.exclusive(async () => assert.equal(await second.read(), null));
  const modulePath = path.join(root, "scripts/validation/vm-proof-local-state.js");
  const child = spawnSync(process.execPath, ["-e", 'require(process.argv[1]).createLocalStore(process.argv[2]).then(s=>s.exclusive(async()=>process.exit(78)))', modulePath, directory], { shell: false, windowsHide: true, stdio: "ignore", timeout: 15000 });
  assert.equal(child.status, 78);
  await second.exclusive(async () => assert.equal(await second.read(), null));
});
test("unsafe output directory and inherited broad credential file fail closed", async t => {
  const directory = await temporary(t, true), outputs = path.join(directory, "outputs"); await fs.mkdir(outputs, { mode: 0o700 });
  await assert.rejects(createLocalStore(outputs), /state_must_be_external/);
  const file = path.join(directory, "synthetic-key.txt"); await fs.writeFile(file, "synthetic-only-not-a-provider-key", { mode: 0o644 });
  if (process.platform === "win32") await assert.rejects(protectedPath(file), /protected_acl_required/);
  else await assert.rejects(protectedPath(file), /protected_mode_required/);
  await protectCreatedFile(file); await protectedPath(file);
});
function evidenceLines() {
  return ["# " + JSON.stringify({ case: "installed-pipeline", source: { size: 104857600 }, decoded: { seconds: 60 }, prepared: {
    elapsedMs: 45000, metrics: { cpuMs: 42000, peakTreeMemoryBytes: 300000000, peakTasks: 20 } } }),
    ...MANIFEST.cases.map(c => "# VM_INSTALLED_CASE=" + JSON.stringify({ id: c.id, passed: true, terminationProved: true, nativeLaunches: c.attempts.length, failure: null })),
    "# VM_INSTALLED_TOTAL=" + JSON.stringify({ launches: 8, allTerminated: true, attemptIds: MANIFEST.cases.flatMap(c => c.attempts) })].join("\n");
}
test("guest evidence binds the eight supervised attempt IDs, not just five test cases", () => {
  const r = parseEvidence(evidenceLines(), 0, 100000); assert.equal(r.allPassed, true); assert.equal(r.launches, 8); assert.equal(r.allTerminated, true);
  assert.equal(r.metrics.sequenceElapsedMs, 100000); assert.equal(r.metrics.sourceBytes, 104857600);
  assert.throws(() => parseEvidence(evidenceLines().replace('"launches":8', '"launches":11'), 0, 100000), /receipt/);
  assert.throws(() => parseEvidence(evidenceLines().replace(JSON.stringify(MANIFEST.cases[0].attempts[0]), '"wrong-attempt"'), 0, 100000), /receipt/);
  assert.throws(() => parseEvidence(evidenceLines().replace('"installed-preflight"', '"source-limit"'), 0, 100000), /receipt/);
  assert.throws(() => parseEvidence(evidenceLines().replace('"cpuMs":42000', '"cpuMs":"secret"'), 0, 100000), /metrics_invalid/);
  assert.equal(parseEvidence(evidenceLines(), 1, 100000).allPassed, false);
  assert.throws(() => parseEvidence("no physical receipts", 0), /receipt/);
});
test("installed failure diagnosis carries only allowlisted stage/code, never raw exception content", () => {
  const secret = "synthetic-private-path-and-token-never-export", safe = closedFailure({ code: "ERR_ASSERTION", message: secret }, "launcher-identity");
  assert.deepEqual(safe, { stage: "launcher-identity", code: "assertion_failed" }); assert.equal(JSON.stringify(safe).includes(secret), false);
  assert.deepEqual(closedFailure({ code: secret, message: secret }, secret), { stage: "case-body", code: "unexpected_error" });
  for (const stage of ["host_identity", "installed_accounts", "installed_caller", "installed_ancestry", "installed_paths", "volume_mount", "volume_backing",
    "pidfd", "jail_prepare", "cgroup", "clone", "assignment", "release", "child_namespace", "child_privileges", "child_probe", "child_stdio", "child_exec", "child_failed", "cleanup"]) {
    const code = "media_process_linux_probe_" + stage;
    assert.deepEqual(closedFailure({ code, message: secret }, "runtime-probe"), { stage: "runtime-probe", code });
  }
  assert.equal(closedFailure({ code: "media_process_linux_probe_" + secret }, "runtime-probe").code, "unexpected_error");
  for (const suffix of ["installed_path_symlink", "installed_path_owner", "installed_path_writable", "installed_path_type", "installed_path_hardlink", "installed_file_writable"]) {
    const code = "media_process_linux_" + suffix;
    assert.deepEqual(closedFailure({ code, message: secret }, "runtime-probe"), { stage: "runtime-probe", code });
  }
  assert.equal(validateFailure({ ...safe, message: secret }), false);
  const failed = "# VM_INSTALLED_CASE=" + JSON.stringify({ id: MANIFEST.cases[0].id, passed: false, terminationProved: false, nativeLaunches: 0, failure: safe }) +
    "\n# VM_INSTALLED_TOTAL=" + JSON.stringify({ launches: 0, allTerminated: false, attemptIds: [] });
  const r = parseEvidence(failed, 1, 100); assert.deepEqual(r.failure, safe); assert.equal(r.allPassed, false); assert.equal(r.launches, 0);
  assert.throws(() => parseEvidence(failed.replace('"assertion_failed"', JSON.stringify(secret)), 1, 100), /case_receipt_invalid/);
});
test("real source package builds twice identically, includes installed dependencies and excludes administrative controller", async () => {
  const a = await buildPackage(root), b = await buildPackage(root);
  assert.equal(sha256(a.bytes), sha256(b.bytes)); assert.deepEqual(a.index, b.index);
  const names = a.index.files.map(f => f.path);
  for (const required of ["scripts/media-vm/bootstrap-ubuntu24.sh", "scripts/media-vm/package-install.cjs", "scripts/media-vm/prepare-cgroup.sh",
    "src/social/calendar/imports/media-process-installed-linux.h", "workflows/calendar-media-vm.cjs", "workflows/calendar-media.mjs", "tests/calendar-vm-private-physical.test.js", MANIFEST.testFile]) assert.ok(names.includes(required), required);
  assert.ok(names.some(n => n.startsWith("db/migrations/") && n.endsWith(".sql")));
  assert.ok(names.some(n => n.startsWith("db/calendar-migrations/") && n.endsWith(".sql")));
  assert.ok(names.every(n => !/(?:^|\/)(?:outputs|\.git|node_modules|nichos|data)(?:\/|$)/.test(n)));
  assert.equal(names.includes("scripts/validation/vm-proof-cli.js"), false);
  assert.equal(names.includes("scripts/validation/vm-proof-digitalocean.js"), false);
  assert.equal(a.index.containsProviderController, false);
});
test("real CLI preparation needs no provider credential; unbound execution fails before external access", async t => {
  const directory = await temporary(t), bundle = path.join(directory, "package.tar"), planFile = path.join(directory, "plan.json");
  const prepared = await main(["--mode", "prepare", "--package", bundle, "--plan", planFile]);
  assert.equal(prepared.paidExecution, false); assert.equal(prepared.accountPrerequisitesPending, true);
  assert.equal(sha256(await fs.readFile(bundle)), prepared.packageSha256);
  const plan = JSON.parse(await fs.readFile(planFile, "utf8")); assert.equal(plan.providerSshKey, null);
  await assert.rejects(main(["--mode", "execute"]), /specific_paid_confirmation/);
  await assert.rejects(main(["--mode", "execute", "--package", bundle, "--plan", planFile, "--approval-sha256", plan.approvalSha256,
    "--external-state-dir", directory, "--credential-file", path.join(directory, "NO_CREDENTIAL_EXISTS"),
    "--confirm", "CREATE_ONE_SYNTHETIC_VM_MAX_2_HOURS_AND_DESTROY_ONLY_ITS_ID"]), /existing_account_ssh_key/);
});
