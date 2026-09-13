"use strict";
// Private fixed entrypoint. No generic shell, URLs, DB clients or credentials.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { safePath, digest, readJson, immutableJson } = require("./media-process-executor");
async function hashFile(file) { const hash = crypto.createHash("sha256"); let size = 0; const stream = require("node:fs").createReadStream(file, { highWaterMark: 65536 }); for await (const chunk of stream) { size += chunk.length; hash.update(chunk); } return { size, sha256: hash.digest("hex") }; }
async function main() {
  if (process.argv[2] === "--synthetic-descendant") {
    const root = await safePath(process.cwd());
    await fs.writeFile(path.join(root, "descendant.json"), JSON.stringify({ pid: process.pid }));
    setInterval(() => { require("node:fs").writeFileSync(path.join(root, "descendant.tick"), String(Date.now())); }, 20); return;
  }
  if (process.argv.length !== 3) throw Error("input_invalid");
  const requestPath = await safePath(process.argv[2], { file: true }), root = path.dirname(requestPath), request = await readJson(requestPath);
  if (request.schema !== 1 || path.basename(requestPath) !== "request.json" || request.executionId !== path.basename(root)) throw Error("input_invalid");
  const input = request.input, started = Date.now(), clock = () => (input.logicalNow ?? started) + Date.now() - started;
  let value;
  if (request.operation === "prepare") {
    const { createImportMediaPreparer } = require("./preparation");
    const preparer = createImportMediaPreparer({ inputRoot: input.inputRoot, outputRoot: input.outputRoot, ffmpegPath: request.ffmpegPath,
      musicRoot: input.music?.root, resolveMusicTrack: input.music ? async () => ({ sourceName: input.music.name, sha256: input.music.sha256, synthetic: input.music.synthetic, rights: input.music.rights }) : undefined,
      allowSyntheticAudio: input.music?.synthetic === true, clock, maxPreparationMs: request.timeoutMs });
    value = await preparer.prepare({ companyId: input.companyId, assetId: input.assetId, sourceName: input.sourceName, ...input.selection }, { deadlineAt: input.deadlineAt });
  } else if (request.operation === "inspect") {
    const source = await safePath(input.sourcePath, { file: true });
    const before = await hashFile(source);
    if (before.size !== input.task.sizeBytes || before.sha256 !== input.task.sha256) throw Error("source_invalid");
    value = await require("./media-process-decode").inspectSnapshot({ task: input.task, sourcePath: source, ffmpegPath: request.ffmpegPath, clock, timeoutMs: request.timeoutMs });
    if (digest(before) !== digest(await hashFile(source))) throw Error("source_changed");
  } else if (request.operation === "inspect_output") {
    const before = await hashFile(input.filePath);
    if (before.size !== input.descriptor.size || before.sha256 !== input.descriptor.sha256) throw Error("source_invalid");
    value = await require("./prepared-disk-output-inspector").createPreparedDiskOutputInspector({ ffmpegPath: request.ffmpegPath, workingDirectory: root }).inspectFile({ ...input, timeoutMs: request.timeoutMs });
    if (digest(before) !== digest(await hashFile(input.filePath))) throw Error("source_changed");
  } else if (request.operation === "test_tree") {
    if (input.mode === "environment") value = { secretAbsent: process.env.IA4TUBE_EXECUTOR_SECRET_TEST === undefined, nodeOptionsAbsent: process.env.NODE_OPTIONS === undefined, environmentKeys: Object.keys(process.env).sort(), pid: process.pid };
    else if (input.mode === "linux_containment" && process.platform === "linux") {
      const refused = async target => { try { await fs.writeFile(target, "synthetic-forgery"); return false; } catch (error) { return ["EROFS", "EACCES", "EPERM"].includes(error.code); } };
      value = { uid: process.getuid(), pid: process.pid,
        requestWriteRefused: await refused(requestPath),
        nativeReceiptWriteRefused: await refused(root + ".supervision/terminal.json"),
        sourceWriteRefused: await refused(__filename),
        otherAssetWriteRefused: await refused(path.join(path.dirname(root), "other-company-art.txt")),
        cgroupEscapeRefused: await refused("/sys/fs/cgroup/cgroup.procs"),
        interfaces: (await fs.readFile("/proc/net/dev", "utf8")).split("\n").filter(line => line.includes(":" )).map(line => line.split(":")[0].trim()) };
    }
    else if (input.mode === "linux_memory_pressure" && process.platform === "linux") {
      const allocations = []; setInterval(() => { allocations.push(Buffer.alloc(32 * 1024 ** 2, 0xa5)); }, 1); return;
    }
    else if (input.mode === "linux_task_pressure" && process.platform === "linux") {
      const children = [];
      for (let index = 0; index < 64; index++) {
        const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", env: { LANG: "C", UV_THREADPOOL_SIZE: "2" } });
        child.on("error", () => {}); children.push(child);
      }
      setInterval(() => {}, 1000); return;
    }
    else if (input.mode === "output") { while (true) require("node:fs").writeSync(1, Buffer.alloc(4096, 120)); }
    else if (input.mode === "finite_output") { for (let index = 0; index < 65; index++) require("node:fs").writeSync(1, Buffer.alloc(4096, 120)); value = { finite: true }; }
    else {
      const descendant = require("node:child_process").spawn(process.execPath, [__filename, "--synthetic-descendant"], { cwd: root, shell: false, windowsHide: true, detached: true, stdio: "ignore", env: { SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root } });
      if (input.mode === "child_exit") descendant.unref();
      if (input.mode === "child_exit") return;
      await new Promise(() => {}); setInterval(() => {}, 1000);
    }
  } else throw Error("operation_invalid");
  await immutableJson(path.join(root, "result.json"), { schema: 1, executionId: request.executionId, requestDigest: digest(request), complete: true, value });
}
if (require.main === module) main().catch(async error => {
  try { if (process.argv.length === 3 && path.basename(process.argv[2]) === "request.json") {
    const code = /^(media_|disk_|prepared_disk_|process_disk_)[a-z_]{1,80}$/.test(error?.code || "") ? error.code : "media_child_failed";
    await immutableJson(path.join(path.dirname(process.argv[2]), "failure.json"), { schema: 1, code });
  } } catch {}
  process.exitCode = 1;
});
