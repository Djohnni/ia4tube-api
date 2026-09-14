"use strict";
// Executes the SAME shell functions with explicitly synthetic commands. These
// fixtures do not substitute for the separate full real bootstrap/install CI.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { installationScript, collectInstallationScript, diagnosticFunctions, collectionFunctions } = require("../scripts/validation/vm-proof-install-shell");
const { runDiagnosticProcess, validateInstallDiagnostic, STAGES } = require("../scripts/validation/vm-proof-install-diagnostics");
const native = { skip: process.platform !== "linux" || process.getuid() !== 0 };
const finish = "printf 'IA4INSTALL_COMPLETE=PASS\\n' | tee -a \"$root/events\" >&3\n";
const stages = STAGES.slice(1).map(stage => `run_stage ${stage} /bin/bash -c "printf 'VM_HOST_PREFLIGHT=PASS\\n'"\n`).join("");
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ia4tube-install-shell-fixture-")); await fs.chmod(directory, 0o700);
  assert.match(directory, /^\/tmp\/ia4tube-install-shell-fixture-[A-Za-z0-9]+$/);
  async function cleanupTrackedDescendant() {
    let identity;
    try { identity = await fs.readFile(path.join(directory, "owned-descendant.identity"), "utf8"); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    const match = /^([0-9]{1,10}) ([0-9]{1,20})\n$/.exec(identity); assert.ok(match);
    const pid = Number(match[1]); assert.ok(pid > 1);
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      assert.equal(fields[19], match[2]); assert.equal((await fs.readFile(`/proc/${pid}/comm`, "utf8")).trim(), "sleep");
      if (fields[0] !== "Z") process.kill(pid, "SIGKILL");
      for (let i = 0; i < 20; i++) {
        try { const next = await fs.readFile(`/proc/${pid}/stat`, "utf8"); if (next.slice(next.lastIndexOf(")") + 2).split(" ")[0] === "Z") return; }
        catch (error) { if (error.code === "ENOENT") return; throw error; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail("tracked synthetic descendant still running");
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
  }
  t.after(async () => { await cleanupTrackedDescendant(); await fs.rm(directory, { recursive: true, force: false }); });
  const prefix = `set -euo pipefail\numask 077\nexport PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C LC_ALL=C\nroot='${directory}'\nexec 3>&1\n${diagnosticFunctions()}\nemit initialization start -\nemit initialization done 0\n`;
  const run = async (body, deadline = "5s", cfg = {}) => {
    const result = await runDiagnosticProcess("/usr/bin/timeout", ["--signal=TERM", "--kill-after=0.1s", deadline, "/bin/bash", "-s"], { stdin: prefix + body, timeoutMs: 7000, ...cfg });
    assert.equal(validateInstallDiagnostic(result), true); return result;
  };
  const collect = async () => {
    const result = await runDiagnosticProcess("/bin/bash", ["-s"], { stdin: `set -euo pipefail\nroot='${directory}'\n${collectionFunctions()}\ncollect_diagnostics\n`, timeoutMs: 3000 });
    assert.equal(validateInstallDiagnostic(result), true); return result;
  };
  return { directory, run, collect, cleanupTrackedDescendant };
}
test("production shell retains fixed real commands, one-shot intent and remote overall deadline", () => {
  const install = installationScript(), collect = collectInstallationScript();
  assert.match(install, /exec \/usr\/bin\/timeout --signal=TERM --kill-after=5s 2375s/);
  assert.match(install, /bootstrap-ubuntu24\.sh/); assert.match(install, /install-ubuntu24\.sh.*--synthetic-proof/);
  assert.match(install, /mkdir -m 0700 "\$root" \|\| exit 78/);
  assert.doesNotMatch(collect, /\/opt\/ia4tube-media|node |vm-proof-guest|VM_INSTALLATION=PASS/);
  assert.match(install, /wait "\$stdout_pid"/); assert.match(install, /wait "\$stderr_pid"/);
});
test("real shell FIFO filters complete and independent collector replays without installed executor", native, async t => {
  const f = await fixture(t), result = await f.run(stages + finish), collected = await f.collect();
  assert.equal(result.installationPassed, true); assert.equal(collected.installationPassed, true);
  assert.deepEqual(collected.markers, result.markers);
  const stdoutCounts = result.remoteOutputNotes.filter(note => note.kind === "bytes" && note.stream === "stdout");
  const stderrCounts = result.remoteOutputNotes.filter(note => note.kind === "bytes" && note.stream === "stderr");
  assert.equal(stdoutCounts.length, 4); assert.equal(stderrCounts.length, 4);
  assert.equal(stdoutCounts.every(note => note.value === Buffer.byteLength("VM_HOST_PREFLIGHT=PASS\n")), true);
  assert.equal(stderrCounts.every(note => note.value === 0), true);
});
test("real shell identified command failure remains collectible before executor installation", native, async t => {
  const f = await fixture(t), result = await f.run("run_stage dependencies_runtime /bin/bash -c 'printf \"VM_BOOTSTRAP=BUNDLE_MISSING\\n\"; exit 23'\n"), collected = await f.collect();
  assert.equal(result.installationPassed, false); assert.equal(result.failedStage, "dependencies_runtime"); assert.equal(result.failedStageExitCode, 23);
  assert.equal(result.exitCode, 23); assert.equal(collected.exitCode, 0); assert.equal(collected.installationPassed, false);
  assert.deepEqual(collected.markers, result.markers); assert.equal(collected.remoteOutputNotes.some(note => note.value === "VM_BOOTSTRAP=BUNDLE_MISSING"), true);
});
test("real shell extensive output is drained and byte-counted exactly without raw output export", native, async t => {
  const f = await fixture(t), large = String.raw`run_stage dependencies_runtime /bin/bash -c 'head -c 2097152 /dev/zero | tr "\000" "x"; printf "\nVM_BOOTSTRAP=PASS\n"; printf "PRIVATE_SENTINEL_94327\n" >&2'
`;
  const result = await f.run(large + STAGES.slice(2).map(stage => `run_stage ${stage} true\n`).join("") + finish);
  assert.equal(result.installationPassed, true); assert.equal(result.remoteOutputNotes.some(note => note.stage === "dependencies_runtime" && note.stream === "stdout" && note.kind === "bytes" && note.value > 2097152), true);
  assert.equal(JSON.stringify(result).includes("PRIVATE_SENTINEL_94327"), false);
  for (const name of await fs.readdir(f.directory)) if (/\.(stdout|stderr)$/.test(name)) {
    const content = await fs.readFile(path.join(f.directory, name), "utf8"); assert.equal(content.includes("PRIVATE_SENTINEL_94327"), false); assert.equal(Buffer.byteLength(content) <= 8192, true);
  }
});
test("remote deadline terminates a command and leaves no false completion", native, async t => {
  const f = await fixture(t), result = await f.run("run_stage dependencies_runtime /bin/bash -c 'sleep 20'\n", "0.2s");
  assert.equal([124, 137].includes(result.exitCode), true); assert.equal(result.installationPassed, false); assert.equal(result.timedOut, false);
  assert.equal(result.lastCompletedStage, "initialization"); assert.equal(result.durationMs < 2500, true);
  const collected = await f.collect(); assert.equal(collected.installationPassed, false); assert.equal(collected.exitCode, 0);
});
test("remote overall deadline also ends descendant retaining stdout after its parent exits", native, async t => {
  const f = await fixture(t), result = await f.run("run_stage dependencies_runtime /bin/bash -c 'sleep 20 & exit 0'\n", "0.2s");
  assert.equal([124, 137].includes(result.exitCode), true); assert.equal(result.installationPassed, false); assert.equal(result.durationMs < 2500, true);
  assert.equal(result.finalMarkerReceived, false);
});
test("nested timeout process group is never inferred terminated; tracked fixture is explicitly cleaned", native, async t => {
  const f = await fixture(t);
  const body = String.raw`run_stage dependencies_runtime /usr/bin/timeout --signal=TERM --kill-after=0.1s 20s /bin/bash -c 'sleep 20 & child=$!; birth=$(awk "{print \$22}" /proc/$child/stat); printf "%s %s\n" "$child" "$birth" > "$1/owned-descendant.identity"; exit 0' _ "$root"
`;
  const result = await f.run(body, "0.2s", { timeoutMs: 700 });
  await f.cleanupTrackedDescendant();
  assert.equal(result.installationPassed, false); assert.equal(result.retryPermitted, false);
  assert.equal(result.timedOut || [124, 137].includes(result.exitCode), true);
  assert.equal(result.durationMs < 3000, true);
});
test("actual run_stage detects filter child failure separately from successful command", native, async t => {
  const f = await fixture(t), result = await f.run("safe_stream(){ cat >/dev/null; return 43; }\nrun_stage dependencies_runtime true\n");
  assert.equal(result.exitCode, 79); assert.equal(result.failedStage, null); assert.equal(result.lastCompletedStage, "dependencies_runtime");
  assert.equal(result.remoteCaptureFailed, true); assert.equal(result.classification, "collection_failure"); assert.equal(result.installationPassed, false);
  const collected = await f.collect(); assert.equal(collected.exitCode, 0); assert.equal(collected.remoteCaptureFailed, true); assert.equal(collected.installationPassed, false);
});
test("actual collector failure is separate and does not erase completed live diagnostics", native, async t => {
  const f = await fixture(t), result = await f.run(stages + finish); assert.equal(result.installationPassed, true);
  await fs.rename(path.join(f.directory, "events"), path.join(f.directory, "events-preserved"));
  const collected = await f.collect(); assert.equal(collected.exitCode, 77); assert.equal(collected.installationPassed, false);
  assert.equal(result.installationPassed, true); assert.equal((await fs.stat(path.join(f.directory, "events-preserved"))).isFile(), true);
});
test("real shell without final completion marker remains unconfirmed", native, async t => {
  const f = await fixture(t), result = await f.run(stages); assert.equal(result.exitCode, 0); assert.equal(result.installationPassed, false); assert.equal(result.classification, "completion_unconfirmed");
});
