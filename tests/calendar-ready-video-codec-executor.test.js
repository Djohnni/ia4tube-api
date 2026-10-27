"use strict";
// Isolated VM contract tests. Production has no dependency-injection or
// synthetic-proof switch. No compiler, codec, process signal or remote runs.
const test = require("node:test"), assert = require("node:assert/strict");
const hostFs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const source = hostFs.readFileSync(path.join(__dirname, "../src/social/calendar/imports/ready-video-codec-executor.js"), "utf8");
const OPTIONS = { workingRoot: "/work/executor", allowedRoots: ["/media/input", "/media/output"] };
function fixture(options = {}) {
  const entries = new Map(), calls = [], events = [], pending = [];
  let inode = 10, processId = 400, uuid = 0;
  function item(filename, data, mode = 0o600) {
    entries.set(filename, { file: data !== null, data: data === null ? null : Buffer.from(data), mode,
      uid: 1000, nlink: 1, dev: 1, ino: ++inode, mtimeMs: 1, ctimeMs: 1, symlink: false });
  }
  for (const directory of ["/repo", "/work", "/work/executor", "/media", "/media/input", "/media/output", "/usr", "/usr/bin"]) item(directory, null, 0o700);
  item("/repo/ready-video-codec-launcher.c", "int main(void) { return 0; }", 0o644);
  for (const name of ["ffmpeg", "ffprobe", "gcc"]) item(`/usr/bin/${name}`, "trusted OS executable", 0o755);
  item("/media/input/source.mp4", "synthetic MP4 source bytes");
  const missing = () => Object.assign(new Error("PRIVATE_PATH_MUST_NOT_ESCAPE"), { code: "ENOENT" });
  const exists = () => Object.assign(new Error("PRIVATE_PATH_MUST_NOT_ESCAPE"), { code: "EEXIST" });
  function stat(filename) {
    const value = entries.get(filename); if (!value) throw missing();
    return { ...value, size: value.data?.length || 0, isFile: () => value.file, isDirectory: () => !value.file,
      isSymbolicLink: () => value.symlink };
  }
  const fakeFs = {
    async lstat(filename) { return stat(filename); },
    async realpath(filename) { if (filename === "/usr/bin/cc") return "/usr/bin/gcc"; if (!entries.has(filename)) throw missing(); return filename; },
    async mkdir(filename, config) { assert.equal(config.mode, 0o700); if (entries.has(filename)) throw exists();item(filename, null, config.mode);events.push(["mkdir", filename]); },
    async writeFile(filename, bytes, config) { assert.equal(config.flag, "wx"); if (entries.has(filename)) throw exists();item(filename, bytes, config.mode); },
    async chmod(filename, mode) { const entry = entries.get(filename);if (!entry) throw missing();entry.mode = mode;entry.ctimeMs++; },
    async rename(from, to) { if (!entries.has(from)) throw missing();entries.set(to, entries.get(from));entries.delete(from); },
    async open(filename, flags, mode) {
      if (flags & hostFs.constants.O_CREAT) {
        assert.ok(flags & hostFs.constants.O_EXCL);assert.ok(flags & 131072);
        if (entries.has(filename)) throw exists();assert.equal(mode, 0o600);item(filename, "", mode);events.push(["precreate", filename]);
      } else { if (!entries.has(filename)) throw missing();assert.ok(flags & 131072); }
      return { async stat() { return stat(filename); },async sync() {},async close() {},
        async read(buffer, offset, length, position) {
          const entry = entries.get(filename);if (!entry) throw missing();
          const bytesRead = Math.min(length, Math.max(0, entry.data.length - position));
          entry.data.copy(buffer, offset, position, position + bytesRead);return { bytesRead };
        } };
    }
  };
  const fakeProcess = { platform: options.platform || "linux", pid: 100,getuid: () => 1000,env: { SECRET: "PRIVATE_PATH_MUST_NOT_ESCAPE" },
    kill(pid, signal) { events.push(["kill", pid, signal]); } };
  function spawn(executable, args, config) {
    const child = new EventEmitter();child.stdout = new EventEmitter();child.stderr = new EventEmitter();child.pid = ++processId;
    child.kill = signal => events.push(["childKill", child.pid, signal]);
    calls.push({ executable, args, config, child });
    assert.equal(config.shell, false);assert.equal(config.detached, true);assert.equal(config.env.SECRET, undefined);
    assert.deepEqual(Object.keys(config.env).sort(), ["LANG", "LC_ALL", "PATH", "TMPDIR"]);
    if (executable === "/usr/bin/gcc") {
      queueMicrotask(() => {
        if (options.compileFails) { child.stderr.emit("data", Buffer.from("PRIVATE_PATH_MUST_NOT_ESCAPE"));child.emit("close", 1, null);return; }
        item(args.at(-1), "compiled launcher bytes", 0o755);child.emit("close", 0, null);
      });
      return child;
    }
    assert.equal(args.length, 8);
    const [operation, codec, input, output, receiptPath, timeout, memory, maxFile] = args;
    assert.equal(codec, operation === "probe" || operation === "selftest" ? "/usr/bin/ffprobe" : "/usr/bin/ffmpeg");
    if (operation === "selftest") { assert.equal(input, "-");assert.equal(output, "-"); }
    if (output !== "-") { assert.ok(entries.has(output), "parent creates output before native launch");assert.equal(entries.get(output).mode, 0o600); }
    assert.equal(entries.has(receiptPath), false, "receipt is created only by native parent");
    assert.equal(entries.get(path.posix.dirname(receiptPath)).mode, 0o700);
    const finish = () => {
      const behavior = operation === "selftest" ? options.selftest || {} : options;
      if (output !== "-" && !behavior.emptyOutput) {
        const current = entries.get(output);current.data = Buffer.from(operation === "thumbnail" ? [255, 216, 255, 217] : "muted MP4 stream copy");current.mtimeMs++;
        if (behavior.replaceOutput) current.ino++;
      }
      const receipt = { schema: 1,operation,pid: child.pid + 1000,exitCode: behavior.exitCode || 0,signal: 0,
        timedOut: false,outputLimit: false,elapsedMs: 5,maxRssKiB: 10000,addressSpaceBytes: Number(memory),
        cpuSeconds: Math.ceil(Number(timeout) / 1000) + 1,filesystemIsolation: true,networkDenied: true,forkDenied: true,
        descendants: 0,terminated: true,...behavior.receipt };
      assert.ok(Number(maxFile) > 0);
      if (!behavior.noReceipt) item(receiptPath, JSON.stringify(receipt), 0o600);
      if (behavior.unsafeReceipt && entries.has(receiptPath)) entries.get(receiptPath).mode = 0o644;
      if (behavior.changeSource) entries.get(input).mtimeMs++;
      const stdout = behavior.stdout ?? (operation === "selftest" ? "ffprobe version 5.1.9\n" : operation === "probe"
        ? '{"streams":[{"codec_type":"video"}],"format":{"format_name":"mp4"}}'
        : operation === "decode" ? "out_time_us=3000000\nprogress=end\n" : "");
      child.stdout.emit("data", Buffer.from(stdout));child.stderr.emit("data", Buffer.from(behavior.stderr || ""));
      child.emit("close", behavior.launcherCode ?? 0, behavior.launcherSignal || null);
    };
    if (options.holdOperation === operation) pending.push(finish);else queueMicrotask(finish);
    return child;
  }
  const allowed = { "node:fs/promises": fakeFs,"node:fs": { constants: { ...hostFs.constants, O_NOFOLLOW: 131072 } },
    "node:path": path,"node:crypto": { createHash: crypto.createHash,randomUUID: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++uuid).padStart(12, "0")}` },
    "node:child_process": { spawn } };
  const context = vm.createContext({ require(name) { if (!(name in allowed)) throw new Error("UNEXPECTED_IMPORT");return allowed[name]; },
    module: { exports: {} },__dirname: "/repo",process: fakeProcess,Buffer,setTimeout,clearTimeout,queueMicrotask });
  vm.runInContext(source, context, { timeout: 1000 });
  return { api: context.module.exports,entries,calls,events,pending };
}
function rejection(error, code, proved = false) {
  assert.equal(error.code, `ready_video_codec_${code}`);
  assert.equal(error.message.includes("PRIVATE_PATH_MUST_NOT_ESCAPE"), false);
  if (proved) { assert.equal(error.termination.proved, true);assert.match(error.termination.proofId, /^[a-f0-9]{64}$/); }
  else assert.equal(Object.hasOwn(error, "termination"), false);
  return true;
}
const request = (operation = "probe", extra = {}) => ({ operation,inputPath: "/media/input/source.mp4",timeoutMs: 1000,...extra });

test("factory is inert and only actual private branded instances are accepted", async () => {
  const f = fixture(), executor = f.api.createReadyVideoCodecExecutor(OPTIONS);
  assert.equal(f.calls.length, 0);assert.equal(f.events.length, 0);assert.equal(executor.capabilities.hardTermination, false);
  assert.equal(f.api.isReadyVideoCodecExecutor(executor), true);assert.equal(f.api.isReadyVideoCodecExecutor({ ...executor }), false);
  assert.throws(() => f.api.createReadyVideoCodecExecutor({ ...OPTIONS,syntheticTests: true }), error => rejection(error, "configuration_invalid"));
  await assert.rejects(executor.run(request()), error => rejection(error, "runtime_unproved"));
});
test("ready compiles source hash cache privately and proves native selftest before claiming hard termination", async () => {
  const f = fixture(), executor = f.api.createReadyVideoCodecExecutor(OPTIONS);
  assert.equal(await executor.ready(), true);assert.equal(executor.capabilities.hardTermination, true);
  assert.equal(executor.capabilities.filesystemIsolation, true);assert.equal(executor.capabilities.networkDenied, true);
  assert.equal(await executor.prepareRuntime(), true);assert.equal(f.calls.length, 2);
  assert.deepEqual(Array.from(f.calls[0].args.slice(0, 2)), ["-O2", "-std=c11"]);
  assert.match(f.calls[1].executable, /^\/work\/executor\/cache\/launcher-[a-f0-9]{64}$/);
  assert.equal(f.entries.get(f.calls[1].executable).mode, 0o700);
});
test("probe and decode return unmodified codec stdout and independently bound receipt proofs", async () => {
  const f = fixture(), executor = f.api.createReadyVideoCodecExecutor(OPTIONS);await executor.ready();
  const probe = await executor.run(request()), decode = await executor.run(request("decode"));
  assert.equal(probe.stdout, '{"streams":[{"codec_type":"video"}],"format":{"format_name":"mp4"}}');
  assert.equal(decode.stdout, "out_time_us=3000000\nprogress=end\n");
  assert.equal(probe.code, 0);assert.equal(probe.termination.proved, true);assert.equal(probe.termination.descendants, 0);
  assert.match(probe.termination.proofId, /^[a-f0-9]{64}$/);assert.notEqual(probe.termination.proofId, decode.termination.proofId);
});
test("thumbnail and mute precreate exclusive private output files and send the exact operation contract", async () => {
  const f = fixture(), executor = f.api.createReadyVideoCodecExecutor(OPTIONS);await executor.ready();
  for (const [operation, outputPath] of [["thumbnail", "/media/output/thumbnail.jpg"], ["mute", "/media/output/muted.mp4"]]) {
    const result = await executor.run(request(operation, { outputPath }));assert.equal(result.code, 0);
    assert.equal(result.termination.proved, true);assert.equal(f.entries.get(outputPath).mode, 0o600);
  }
  assert.deepEqual(f.calls.slice(2).map(call => call.args[0]), ["thumbnail", "mute"]);
});
test("missing or invalid native receipt never creates a proof and closes further codec admission", async () => {
  for (const options of [{ noReceipt: true }, { unsafeReceipt: true }, { receipt: { operation: "other" } },
    { receipt: { terminated: false } }, { receipt: { descendants: 1 } }, { receipt: { networkDenied: false } },
    { receipt: { filesystemIsolation: false } }, { receipt: { forkDenied: false } }, { receipt: { addressSpaceBytes: 1234 } }]) {
    const f = fixture(options), executor = f.api.createReadyVideoCodecExecutor(OPTIONS);await executor.ready();
    await assert.rejects(executor.run(request()), error => rejection(error, "termination_unconfirmed"));
    assert.equal(executor.capabilities.hardTermination, false);
    await assert.rejects(executor.run(request()), error => rejection(error, "runtime_unproved"));
  }
});
test("native timeout, output limit and signal errors retain only a validated termination proof", async () => {
  for (const [options, code] of [[{ receipt: { timedOut: true } }, "timeout"], [{ receipt: { outputLimit: true } }, "output_limit"],
    [{ receipt: { signal: 9,exitCode: -1 } }, "signalled"]]) {
    const f = fixture(options), executor = f.api.createReadyVideoCodecExecutor(OPTIONS);await executor.ready();
    await assert.rejects(executor.run(request()), error => rejection(error, code, true));assert.equal(executor.capabilities.hardTermination, true);
  }
});
test("failed compile, unsupported host and unproved selftest cannot advertise termination capability", async () => {
  for (const [options, code] of [[{ compileFails: true }, "compile_failed"], [{ platform: "win32" }, "platform_unproved"],
    [{ selftest: { noReceipt: true } }, "termination_unconfirmed"], [{ selftest: { stdout: "not a codec version" } }, "selftest_failed"]]) {
    const f = fixture(options), executor = f.api.createReadyVideoCodecExecutor(OPTIONS);
    await assert.rejects(executor.ready(), error => { assert.equal(error.code, `ready_video_codec_${code}`);assert.equal(error.message.includes("PRIVATE"), false);return true; });
    assert.equal(executor.capabilities.hardTermination, false);
  }
});
test("unlisted paths, links, pre-existing outputs and invalid requests cannot start native work", async () => {
  for (const alter of [f => { f.entries.get("/media/input/source.mp4").nlink = 2; },
    f => { f.entries.get("/media/input/source.mp4").symlink = true; },
    f => { f.entries.get("/media/input").symlink = true; }]) {
    const f = fixture(), executor = f.api.createReadyVideoCodecExecutor(OPTIONS);await executor.ready();alter(f);
    await assert.rejects(executor.run(request()), error => rejection(error, "path_invalid"));assert.equal(f.calls.length, 2);
  }
  const f = fixture(), executor = f.api.createReadyVideoCodecExecutor(OPTIONS);await executor.ready();
  for (const bad of [request("selftest"), request("probe", { outputPath: "/media/output/a" }), request("probe", { timeoutMs: 30001 }),
    request("probe", { shell: true }), request("mute")]) await assert.rejects(executor.run(bad), error => rejection(error, "request_invalid"));
  await assert.rejects(executor.run(request("probe", { inputPath: "/elsewhere/source.mp4" })), error => rejection(error, "path_forbidden"));
  assert.equal(f.calls.length, 2);
  const g = fixture(), second = g.api.createReadyVideoCodecExecutor(OPTIONS);await second.ready();
  g.entries.set("/media/output/taken.mp4", { ...g.entries.get("/media/input/source.mp4") });
  await assert.rejects(second.run(request("mute", { outputPath: "/media/output/taken.mp4" })), error => rejection(error, "execution_failed"));
  assert.equal(g.calls.length, 2);
});
test("changed source or replaced output is refused while preserving independently proved termination", async () => {
  for (const [options, operation, extra, code] of [[{ changeSource: true }, "probe", {}, "input_changed"],
    [{ replaceOutput: true }, "mute", { outputPath: "/media/output/muted.mp4" }, "output_invalid"],
    [{ emptyOutput: true }, "thumbnail", { outputPath: "/media/output/thumbnail.jpg" }, "output_invalid"]]) {
    const f = fixture(options), executor = f.api.createReadyVideoCodecExecutor(OPTIONS);await executor.ready();
    await assert.rejects(executor.run(request(operation, extra)), error => rejection(error, code, true));
  }
});
test("changed launcher invalidates proof before another native launch", async () => {
  const f = fixture(), executor = f.api.createReadyVideoCodecExecutor(OPTIONS);await executor.ready();
  f.entries.get(f.calls[1].executable).data = Buffer.from("changed executable");
  await assert.rejects(executor.run(request()), error => rejection(error, "launcher_changed"));
  assert.equal(executor.capabilities.hardTermination, false);assert.equal(f.calls.length, 2);
});
test("one active codec invocation excludes a concurrent request", async () => {
  const f = fixture({ holdOperation: "probe" }), executor = f.api.createReadyVideoCodecExecutor(OPTIONS);await executor.ready();
  const first = executor.run(request());
  await assert.rejects(executor.run(request("decode")), error => rejection(error, "busy"));
  for (let i = 0; i < 3 && !f.pending.length; i++) await new Promise(setImmediate);
  assert.equal(f.pending.length, 1);f.pending.shift()();assert.equal((await first).termination.proved, true);
});
test("bounded output overflow kills the native process group and never invents a missing receipt", async () => {
  const f = fixture({ stdout: "x".repeat(262145),noReceipt: true }), executor = f.api.createReadyVideoCodecExecutor(OPTIONS);await executor.ready();
  await assert.rejects(executor.run(request()), error => rejection(error, "termination_unconfirmed"));
  assert.ok(f.events.some(event => event[0] === "kill" && event[1] < 0 && event[2] === "SIGKILL"));
  assert.equal(executor.capabilities.hardTermination, false);
});
test("replaced codec executable is rejected before launch", async () => {
  const f = fixture(), executor = f.api.createReadyVideoCodecExecutor(OPTIONS);await executor.ready();
  f.entries.get("/usr/bin/ffprobe").ino++;
  await assert.rejects(executor.run(request()), error => rejection(error, "codec_changed"));assert.equal(f.calls.length, 2);
});
