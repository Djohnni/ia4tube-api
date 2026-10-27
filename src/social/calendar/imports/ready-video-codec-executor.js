"use strict";

const fs = require("node:fs/promises"), { constants } = require("node:fs");
const path = require("node:path").posix, crypto = require("node:crypto"), { spawn } = require("node:child_process");
const instances = new WeakSet();
const MAX_OUTPUT = 262144, MAX_RECEIPT = 16384, MAX_RUNTIME = 30000;
const MAX_MEDIA = 100 * 1024 ** 2, DEFAULT_MEMORY = 384 * 1024 ** 2;
const OPERATIONS = new Set(["probe", "decode", "thumbnail", "mute"]);
function failure(code, termination) {
  const error = Object.assign(new Error("Execução do vídeo não confirmada."), { code: `ready_video_codec_${code}` });
  if (termination) error.termination = termination;
  return error;
}
function fail(code) { throw failure(code); }
function absolute(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/" || value !== path.resolve(value) ||
      /[\0\r\n\\]/.test(value) || value.startsWith("//")) fail("path_invalid");
  return value;
}
function inside(value, root) { return value !== root && value.startsWith(root + "/"); }
function identity(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"); }
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
async function checkedPath(value, { file = false, privatePath = false, maxBytes = Infinity } = {}) {
  absolute(value); let current = "";
  for (const part of value.slice(1).split("/")) {
    current += "/" + part;
    const item = await fs.lstat(current);
    if (item.isSymbolicLink() || current !== value && !item.isDirectory()) fail("path_invalid");
  }
  const stat = await fs.lstat(value);
  if (await fs.realpath(value) !== value || (file ? !stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes : !stat.isDirectory()) ||
      privatePath && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) fail("path_invalid");
  return stat;
}
async function privateDirectory(value, create = false) {
  if (create) {
    await checkedPath(path.dirname(value));
    try { await fs.mkdir(value, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  return checkedPath(value, { privatePath: true });
}
async function boundedRead(filename, maxBytes, privatePath = false) {
  const before = await checkedPath(filename, { file: true, privatePath, maxBytes });
  if (before.size < 1) fail("file_invalid");
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (identity(opened) !== identity(before) || opened.nlink !== 1) fail("file_changed");
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break; offset += read.bytesRead;
    }
    if (offset !== before.size || identity(await handle.stat()) !== identity(before) ||
        identity(await checkedPath(filename, { file: true, privatePath, maxBytes })) !== identity(before)) fail("file_changed");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
function cleanEnvironment(directory) {
  return { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TMPDIR: directory };
}
function capture(executable, args, directory, timeoutMs) {
  return new Promise(resolve => {
    let child, settled = false, timer, fallback, overflow = false, expired = false, launchError = false;
    let stdoutBytes = 0, stderrBytes = 0; const stdout = [], stderr = [];
    function done(code, signal) {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(fallback);
      resolve({ code, signal, overflow, expired, launchError, pid: child?.pid,
        stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    }
    function kill() {
      if (!Number.isSafeInteger(child?.pid) || child.pid < 1) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
      fallback ||= setTimeout(() => done(null, "SIGKILL"), 1000);
    }
    try { child = spawn(executable, args, { shell: false, detached: true, cwd: directory,
      stdio: ["ignore", "pipe", "pipe"], env: cleanEnvironment(directory) }); }
    catch { launchError = true; done(null, null); return; }
    timer = setTimeout(() => { expired = true; kill(); }, timeoutMs);
    child.once("error", () => { launchError = true; kill(); done(null, null); });
    child.once("close", done);
    for (const [stream, target, kind] of [[child.stdout, stdout, "stdout"], [child.stderr, stderr, "stderr"]]) {
      if (!stream) { launchError = true; kill(); continue; }
      stream.on("data", chunk => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const count = kind === "stdout" ? stdoutBytes += bytes.length : stderrBytes += bytes.length;
        if (count > MAX_OUTPUT) { overflow = true; kill(); return; }
        target.push(bytes);
      });
    }
  });
}
function validReceipt(value, operation, memoryBytes, timeoutMs) {
  const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  return Boolean(value && !Array.isArray(value) && value.schema === 1 && value.operation === operation &&
    integer(value.pid, 1, 2147483647) && value.pid !== process.pid && integer(value.exitCode, -1, 255) &&
    integer(value.signal, 0, 64) && typeof value.timedOut === "boolean" && typeof value.outputLimit === "boolean" &&
    integer(value.elapsedMs, 0, timeoutMs + 10000) && integer(value.maxRssKiB, 0, 1024 ** 3) &&
    value.addressSpaceBytes === memoryBytes && integer(value.cpuSeconds, 1, Math.ceil(timeoutMs / 1000) + 2) &&
    value.filesystemIsolation === true && value.networkDenied === true && value.forkDenied === true &&
    value.descendants === 0 && value.terminated === true);
}
function createReadyVideoCodecExecutor(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).some(key => !["workingRoot", "allowedRoots", "ffmpegPath", "ffprobePath", "memoryBytes"].includes(key))) fail("configuration_invalid");
  const { workingRoot, allowedRoots, ffmpegPath = "/usr/bin/ffmpeg", ffprobePath = "/usr/bin/ffprobe", memoryBytes = DEFAULT_MEMORY } = options;
  const root = absolute(workingRoot);
  if (!Array.isArray(allowedRoots) || !allowedRoots.length || allowedRoots.length > 16 ||
      !Number.isSafeInteger(memoryBytes) || memoryBytes < 128 * 1024 ** 2 || memoryBytes > DEFAULT_MEMORY) fail("configuration_invalid");
  const roots = [...new Set(allowedRoots.map(absolute))], ffmpeg = absolute(ffmpegPath), ffprobe = absolute(ffprobePath);
  if (ffmpeg === ffprobe) fail("configuration_invalid");
  let launcher, launcherHash, sourceHash, proof = null, preparation = null, active = false;
  const codecIdentities = new Map();
  async function permitted(value, file) {
    absolute(value);
    if (!roots.some(parent => inside(value, parent) || !file && value === parent)) fail("path_forbidden");
    const parent = roots.filter(candidate => inside(value, candidate) || !file && value === candidate).sort((a, b) => b.length - a.length)[0];
    await privateDirectory(parent);
    const directory = file ? path.dirname(value) : value;
    await privateDirectory(directory);
    return checkedPath(value, { file, privatePath: true, maxBytes: MAX_MEDIA });
  }
  async function compile() {
    await privateDirectory(root);
    for (const parent of roots) await privateDirectory(parent);
    for (const codec of [ffmpeg, ffprobe]) {
      const stat = await checkedPath(codec, { file: true });
      if (!(stat.mode & 0o111) || (stat.mode & 0o022)) fail("codec_invalid");
      codecIdentities.set(codec, identity(stat));
    }
    const source = await boundedRead(path.join(__dirname, "ready-video-codec-launcher.c"), 262144);
    sourceHash = hash(source);
    const cache = path.join(root, "cache"); await privateDirectory(cache, true);
    launcher = path.join(cache, `launcher-${sourceHash}`);
    let found;
    try { found = await checkedPath(launcher, { file: true, privatePath: true, maxBytes: 4 * 1024 ** 2 }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!found) {
      const directory = path.join(cache, `compile-${crypto.randomUUID()}`); await privateDirectory(directory, true);
      const snapshot = path.join(directory, "launcher.c"), target = path.join(directory, "launcher");
      await fs.writeFile(snapshot, source, { flag: "wx", mode: 0o600 });
      // /usr/bin/cc is a fixed OS alternative; resolve its normal symlink, never
      // a caller-supplied compiler or inherited PATH/LD_PRELOAD configuration.
      const compiler = await fs.realpath("/usr/bin/cc"), compilerStat = await checkedPath(compiler, { file: true });
      if (!compiler.startsWith("/usr/bin/") || !(compilerStat.mode & 0o111) || (compilerStat.mode & 0o022)) fail("compiler_invalid");
      const compiled = await capture(compiler, ["-O2", "-std=c11", snapshot, "-o", target], directory, 30000);
      if (compiled.launchError || compiled.expired || compiled.overflow || compiled.code !== 0 || compiled.signal) fail("compile_failed");
      const compiledStat = await checkedPath(target, { file: true, maxBytes: 4 * 1024 ** 2 });
      if (compiledStat.uid !== process.getuid()) fail("compiler_invalid");
      await fs.chmod(target, 0o700);
      await fs.rename(target, launcher);
    }
    const stat = await checkedPath(launcher, { file: true, privatePath: true, maxBytes: 4 * 1024 ** 2 });
    if ((stat.mode & 0o777) !== 0o700) fail("launcher_invalid");
    launcherHash = hash(await boundedRead(launcher, 4 * 1024 ** 2, true));
  }
  async function execute(operation, inputPath, outputPath, timeoutMs) {
    let termination;
    try {
      await privateDirectory(root);
      if (hash(await boundedRead(launcher, 4 * 1024 ** 2, true)) !== launcherHash) fail("launcher_changed");
      const source = operation === "selftest" ? null : await permitted(inputPath, true);
      if (source && source.size < 1) fail("input_invalid");
      let output;
      const maxFileBytes = operation === "thumbnail" ? 8 * 1024 ** 2 : MAX_MEDIA;
      if (outputPath) {
        absolute(outputPath);
        if (outputPath === inputPath || !roots.some(parent => inside(outputPath, parent))) fail("path_forbidden");
        await permitted(path.dirname(outputPath), false);
        const handle = await fs.open(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { output = await handle.stat();await handle.sync(); } finally { await handle.close(); }
        await permitted(outputPath, true);
      }
      const attemptId = crypto.randomUUID(), attempt = path.join(root, attemptId);
      await privateDirectory(attempt, true);
      const receiptPath = path.join(attempt, "receipt.json");
      const codec = operation === "probe" || operation === "selftest" ? ffprobe : ffmpeg;
      if (identity(await checkedPath(codec, { file: true })) !== codecIdentities.get(codec)) fail("codec_changed");
      const result = await capture(launcher, [operation, codec, inputPath || "-", outputPath || "-", receiptPath,
        String(timeoutMs), String(memoryBytes), String(maxFileBytes)], attempt, timeoutMs + 2000);
      let receiptBytes, receipt;
      try { receiptBytes = await boundedRead(receiptPath, MAX_RECEIPT, true);receipt = JSON.parse(receiptBytes.toString("utf8")); }
      catch { fail("termination_unconfirmed"); }
      if (!validReceipt(receipt, operation, memoryBytes, timeoutMs)) fail("termination_unconfirmed");
      termination = Object.freeze({ proved: true, descendants: 0,
        proofId: hash(JSON.stringify(["ready-video-codec-v1", sourceHash, launcherHash, attemptId, operation, hash(receiptBytes)])) });
      if (result.launchError || result.expired) throw failure("launcher_failed", termination);
      if (receipt.timedOut) throw failure("timeout", termination);
      if (result.overflow || receipt.outputLimit) throw failure("output_limit", termination);
      if (receipt.signal || result.signal) throw failure("signalled", termination);
      if (source && identity(await permitted(inputPath, true)) !== identity(source)) throw failure("input_changed", termination);
      if (output) {
        const actual = await permitted(outputPath, true);
        if (actual.dev !== output.dev || actual.ino !== output.ino || actual.size > maxFileBytes || receipt.exitCode === 0 && actual.size < 1) throw failure("output_invalid", termination);
      }
      return { code: receipt.exitCode, stdout: result.stdout, stderr: result.stderr, termination };
    } catch (error) {
      if (!termination) proof = null;
      if (/^ready_video_codec_[a-z_]+$/.test(error?.code || "")) {
        if (termination && !error.termination) error.termination = termination;
        throw error;
      }
      throw failure("execution_failed", termination);
    }
  }
  async function prepareRuntime() {
    if (process.platform !== "linux" || typeof process.getuid !== "function" || !constants.O_NOFOLLOW) fail("platform_unproved");
    if (proof) return true;
    if (preparation) return preparation;
    if (active) fail("busy");
    preparation = (async () => {
      try {
        await compile();
        const checked = await execute("selftest", null, null, 5000);
        if (checked.code !== 0 || !/^ffprobe version\s/m.test(checked.stdout)) throw failure("selftest_failed", checked.termination);
        proof = checked.termination;return true;
      } catch (error) { proof = null;throw /^ready_video_codec_[a-z_]+$/.test(error?.code || "") ? error : failure("runtime_unproved"); }
      finally { preparation = null; }
    })();
    return preparation;
  }
  const executor = Object.freeze({
    capabilities: Object.freeze({ platform: process.platform, supported: process.platform === "linux", testOnly: false,
      maxRuntimeMs: MAX_RUNTIME, maxOutputBytes: MAX_OUTPUT, maxConcurrent: 1, memoryBytes,
      get hardTermination() { return Boolean(proof); },get filesystemIsolation() { return Boolean(proof); },
      get networkDenied() { return Boolean(proof); },get forkDenied() { return Boolean(proof); } }),
    ready: prepareRuntime, prepareRuntime,
    async run(input) {
      if (!input || typeof input !== "object" || Array.isArray(input) ||
          Object.keys(input).some(key => !["operation", "inputPath", "outputPath", "timeoutMs"].includes(key)) ||
          !OPERATIONS.has(input.operation) || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_RUNTIME ||
          (["thumbnail", "mute"].includes(input.operation) ? typeof input.outputPath !== "string" : input.outputPath !== undefined)) fail("request_invalid");
      if (!proof || preparation) fail("runtime_unproved");
      if (active) fail("busy");active = true;
      try { return await execute(input.operation, input.inputPath, input.outputPath, input.timeoutMs); }
      finally { active = false; }
    }
  });
  instances.add(executor);return executor;
}
function isReadyVideoCodecExecutor(value) { return Boolean(value && instances.has(value)); }
module.exports = { createReadyVideoCodecExecutor, isReadyVideoCodecExecutor };
