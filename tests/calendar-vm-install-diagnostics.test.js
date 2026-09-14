"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { STAGES, runDiagnosticProcess, createInstallDiagnosticParser, validateInstallDiagnostic } = require("../scripts/validation/vm-proof-install-diagnostics");
const emit = text => `process.stdout.write(${JSON.stringify(text)});`;
function markers({ failedStage = null, final = true } = {}) {
  let now = 1770000000000, text = "";
  for (const stage of STAGES) {
    text += `IA4INSTALL ${stage} start ${now++} -\n`;
    text += `IA4INSTALL ${stage} ${stage === failedStage ? "failed" : "done"} ${now++} ${stage === failedStage ? 37 : 0}\n`;
    if (stage === failedStage) break;
  }
  if (final && !failedStage) text += "IA4INSTALL_COMPLETE=PASS\n";
  return text;
}
const run = (script, opts = {}) => runDiagnosticProcess(process.execPath, ["-e", script], { timeoutMs: 5000, ...opts });
const safe = result => { assert.equal(validateInstallDiagnostic(result), true); assert.equal(result.retryPermitted, false); assert.equal(Object.hasOwn(result, "stdout"), false); assert.equal(Object.hasOwn(result, "stderr"), false); return result; };

test("local process completes all actual protocol stages and final marker", async () => {
  const result = safe(await run(emit(markers())));
  assert.equal(result.classification, "installation_complete"); assert.equal(result.installationPassed, true); assert.equal(result.exitCode, 0);
  assert.equal(result.markers.length, 10); assert.equal(result.lastCompletedStage, "final_validation");
  assert.ok(result.completedAtMs >= result.startedAtMs); assert.ok(result.durationMs >= 0);
});
test("nonzero substage is preserved separately from local transport and capture", async () => {
  const result = safe(await run(emit(markers({ failedStage: "version_checks" })) + "process.exitCode=37;"));
  assert.equal(result.classification, "substep_failed"); assert.equal(result.exitCode, 37); assert.equal(result.lastCompletedStage, "dependencies_runtime");
  assert.equal(result.failedStage, "version_checks"); assert.equal(result.failedStageExitCode, 37);
  assert.deepEqual(result.markers.at(-1), { stage: "version_checks", event: "failed", atMs: 1770000000005, exitCode: 37, stream: "stdout" });
});
test("successful collector can return partial failed installation with its own exit zero", async () => {
  const result = safe(await run(emit(markers({ failedStage: "package_install" }))));
  assert.equal(result.classification, "substep_failed"); assert.equal(result.exitCode, 0); assert.equal(result.installationPassed, false);
});
test("large stdout/stderr before and after markers is bounded without killing installer", async () => {
  const result = safe(await run("process.stdout.write('a'.repeat(180000)+'\\n');process.stderr.write('b'.repeat(150000)+'\\n');" + emit(markers()) + "process.stdout.write('c'.repeat(160000));process.stderr.write('d'.repeat(150000));", { maxBytes: 512 }));
  assert.equal(result.installationPassed, true); assert.equal(result.stdoutBytes > 340000, true); assert.equal(result.stderrBytes, 300001);
  assert.deepEqual(result.captureTruncated, { stdout: true, stderr: true }); assert.deepEqual(result.retainedBytes, { stdout: 512, stderr: 512 });
});
test("timeout is local and cannot claim remote failure or remote termination", async () => {
  const result = safe(await run(emit("IA4INSTALL initialization start 1770000000000 -\n") + "setInterval(()=>{},1000);", { timeoutMs: 500 }));
  assert.equal(result.classification, "local_timeout"); assert.equal(result.timedOut, true); assert.equal(result.installationPassed, false); assert.equal(result.lastCompletedStage, null);
});
test("abort signal stops local child without automatic retry", async () => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 400);
  const result = safe(await run("setInterval(()=>{},1000);", { signal: controller.signal })); clearTimeout(timer);
  assert.equal(result.aborted, true); assert.equal(result.classification, "local_abort"); assert.equal(result.installationPassed, false);
});
test("preaborted invocation does not spawn process", async () => {
  const controller = new AbortController(); controller.abort();
  const result = safe(await run(emit(markers()), { signal: controller.signal }));
  assert.equal(result.classification, "local_abort"); assert.equal(result.stdoutBytes, 0); assert.equal(result.exitCode, null);
});
for (const [name, text] of [["before marker", ""], ["after substage", "IA4INSTALL initialization start 1 -\nIA4INSTALL initialization done 2 0\n"], ["after final marker", markers()]]) {
  test(`SSH255 ${name} is uncertain transport, never installation PASS`, async () => {
    const result = safe(await run(emit(text) + "process.exitCode=255;"));
    assert.equal(result.classification, "transport_interrupted_unknown"); assert.equal(result.installationPassed, false); assert.equal(result.exitCode, 255);
    assert.equal(result.markers.length > 0, Boolean(text));
  });
}
test("zero exit without final marker remains unconfirmed", async () => {
  const result = safe(await run(emit(markers({ final: false }))));
  assert.equal(result.classification, "completion_unconfirmed"); assert.equal(result.installationPassed, false); assert.equal(result.lastCompletedStage, "final_validation");
});
test("final marker alone or out of sequence is not proof", async () => {
  for (const text of ["IA4INSTALL_COMPLETE=PASS\n", markers().replace("IA4INSTALL initialization done 1770000000001 0\n", ""), markers() + "IA4INSTALL_COMPLETE=PASS\n"]) {
    const result = safe(await run(emit(text)));
    assert.equal(result.classification, "invalid_installation_protocol"); assert.equal(result.installationPassed, false);
  }
});
test("done marker without an explicit zero exit cannot prove installation", async () => {
  const result = safe(await run(emit(markers().replace("initialization done 1770000000001 0", "initialization done 1770000000001 -"))));
  assert.equal(result.classification, "invalid_installation_protocol"); assert.equal(result.installationPassed, false);
  assert.equal(result.markers.some(marker => marker.event === "done" && marker.exitCode === null), false);
});
test("failed remote stage and observed SSH return remain distinct", async () => {
  const result = safe(await run(emit(markers({ failedStage: "package_install" })) + "process.exitCode=79;"));
  assert.equal(result.classification, "substep_failed"); assert.equal(result.failedStageExitCode, 37); assert.equal(result.exitCode, 79);
  const lost = safe(await run(emit(markers({ failedStage: "package_install" })) + "process.exitCode=255;"));
  assert.equal(lost.classification, "transport_interrupted_unknown"); assert.equal(lost.failedStageExitCode, 37);
});
test("safe notes retain exact stage/stream association even when collected after final", async () => {
  const notes = "IA4SAFE dependencies_runtime stdout bytes 60000\nIA4SAFE dependencies_runtime stderr dropped 123\nIA4SAFE package_install stdout marker VM_INSTALLATION=PASS\n";
  const result = safe(await run(emit(markers() + notes)));
  assert.equal(result.installationPassed, true);
  assert.deepEqual(result.remoteOutputNotes, [
    { stage: "dependencies_runtime", stream: "stdout", kind: "bytes", value: 60000 },
    { stage: "dependencies_runtime", stream: "stderr", kind: "dropped", value: 123 },
    { stage: "package_install", stream: "stdout", kind: "marker", value: "VM_INSTALLATION=PASS" }
  ]);
});
test("safe-note cap does not discard late capture-failure fact or kill process", async () => {
  const result = safe(await run(emit(markers() + "IA4SAFE dependencies_runtime stdout bytes 1\n".repeat(341) + "IA4SAFE dependencies_runtime stderr capture_failed 74\n")));
  assert.equal(result.remoteOutputNotes.length, 340); assert.equal(result.remoteOutputNotesTruncated, true);
  assert.equal(result.remoteCaptureFailed, true); assert.equal(result.classification, "collection_failure"); assert.equal(result.exitCode, 0);
});
test("collector failure is not misclassified as installer failure even with wrapper exit79", async () => {
  const result = safe(await run(emit(markers({ final: false }) + "IA4SAFE final_validation stderr capture_failed 74\n") + "process.exitCode=79;"));
  assert.equal(result.classification, "collection_failure"); assert.equal(result.exitCode, 79); assert.equal(result.failedStage, null);
});
test("safe-note arbitrary strings and unsigned-overflow quantities fail closed without export", async () => {
  for (const note of ["IA4SAFE package_install stdout marker SECRET_SENTINEL_123\n", "IA4SAFE package_install stdout bytes 9007199254740992\n", "IA4SAFE package_install stdout capture_failed 0\n", "IA4SAFE package_install stdout bytes -1\n"]) {
    const result = safe(await run(emit(markers() + note)));
    assert.equal(result.installationPassed, false); assert.equal(result.protocolInvalid, true);
    assert.equal(JSON.stringify(result).includes("SECRET_SENTINEL_123"), false); assert.deepEqual(result.remoteOutputNotes, []);
  }
});
test("arbitrary secret-like stderr cannot enter structured result", async () => {
  const privateValue = "SECRET_SENTINEL_NOT_FOR_OUTPUT_94327";
  const result = safe(await run(`process.stderr.write(${JSON.stringify("password=" + privateValue + "\n")});` + emit(markers())));
  assert.equal(JSON.stringify(result).includes(privateValue), false); assert.equal(result.stderrBytes > 0, true);
});
test("child does not inherit unrelated environment values", async () => {
  const result = safe(await run("if(process.env.PRIVATE_SENTINEL)process.exitCode=5;" + emit(markers()), { env: { ...process.env, PRIVATE_SENTINEL: "not_inherited" } }));
  assert.equal(result.installationPassed, true);
});
test("collector command failure is explicit and separate from partial markers", async () => {
  const result = safe(await run("process.stderr.write('collector unavailable\\n');process.exitCode=73;"));
  assert.equal(result.classification, "remote_command_failed"); assert.equal(result.exitCode, 73); assert.equal(result.markers.length, 0);
});
test("spawn failure exports only allowlisted code, never error path/message", async () => {
  const result = safe(await runDiagnosticProcess("vm-proof-no-such-program-private-sentinel", [], { timeoutMs: 1000 }));
  assert.equal(result.classification, "spawn_failure"); assert.equal(result.spawnErrorCode, "ENOENT"); assert.equal(JSON.stringify(result).includes("private-sentinel"), false);
});
test("bounded parser accepts split protocol lines and ignores bounded arbitrary text", () => {
  const parser = createInstallDiagnosticParser(), text = Buffer.from(markers());
  parser.push("x".repeat(100000) + "\n", "stderr");
  for (let i = 0; i < text.length; i += 3) parser.push(text.subarray(i, i + 3));
  const result = parser.finish(); assert.equal(result.finalMarkerReceived, true); assert.equal(result.protocolInvalid, false); assert.equal(result.markers.length, 10);
  assert.deepEqual(parser.finish(), result); assert.throws(() => parser.push("x"), /parser_input_invalid/);
});
test("malformed protocol, overlong protocol and too many markers fail closed", () => {
  for (const value of ["IA4INSTALL token_secret bad 1 -\n", "IA4INSTALL " + "x".repeat(10000) + "\n", "IA4INSTALL initialization start 1 0\n", "IA4INSTALL initialization failed 2 0\n", "IA4INSTALL initialization start 9007199254740992 -\n", markers() + markers()]) {
    const parser = createInstallDiagnosticParser(); parser.push(value); assert.equal(parser.finish().protocolInvalid, true);
  }
});
test("strict validator rejects injected keys, arbitrary text and contradictory flags", async () => {
  const result = safe(await run(emit(markers())));
  assert.equal(validateInstallDiagnostic({ ...result, token: "secret" }), false);
  assert.equal(validateInstallDiagnostic({ ...result, classification: "arbitrary secret" }), false);
  assert.equal(validateInstallDiagnostic({ ...result, installationPassed: false }), false);
  assert.equal(validateInstallDiagnostic({ ...result, signal: "arbitrary secret" }), false);
  assert.equal(validateInstallDiagnostic({ ...result, captureTruncated: { stdout: true, stderr: false } }), false);
  assert.equal(validateInstallDiagnostic({ ...result, remoteOutputNotesTruncated: true }), false);
  assert.equal(validateInstallDiagnostic({ ...result, remoteCaptureFailed: true }), false);
  assert.equal(validateInstallDiagnostic({ ...result, failedStage: "package_install", failedStageExitCode: 1 }), false);
});
test("unsafe local options produce fixed error without echoing options", async () => {
  await assert.rejects(runDiagnosticProcess("x", ["private\0sentinel"]), error => error.message === "vm_install_diagnostic_options_invalid");
});
test("zero raw capture budget preserves only strict markers and byte facts", async () => {
  const result = safe(await run(emit(markers()), { maxBytes: 0 }));
  assert.equal(result.installationPassed, true); assert.equal(result.captureTruncated.stdout, true); assert.equal(result.retainedBytes.stdout, 0);
});
test("received signal is exposed as a signal, not a fabricated exit code", { skip: process.platform === "win32" }, async () => {
  const result = safe(await run("process.kill(process.pid,'SIGTERM');"));
  assert.equal(result.classification, "process_signal"); assert.equal(result.signal, "SIGTERM"); assert.equal(result.exitCode, null);
});
