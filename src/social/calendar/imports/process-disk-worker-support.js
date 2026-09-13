"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { safePath, immutableJson, readJson, digest } = require("./media-process-executor");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fail(code) { throw Object.assign(new Error("process_disk_" + code), { code: "process_disk_" + code }); }
function validateId(id) { if (!UUID.test(id || "")) fail("binding_invalid"); }
function budget(task, clock) { const start = performance.now(); return { elapsed: () => Math.ceil(performance.now() - start), remaining() { const left = Math.floor(Math.min(task.maxRuntimeMs - (performance.now() - start), task.deadlineAt - clock())); if (left < 1) fail("deadline_exceeded"); return left; } }; }
async function initialize(root, executionId, task, resultRef) {
  validateId(executionId); await safePath(root); const attempt = path.join(root, executionId);
  try { await fs.mkdir(attempt, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; return { attempt, fresh: false }; }
  await immutableJson(path.join(attempt, "intent.json"), { schema: 1, executionId, task, ...(resultRef ? { resultRef } : {}) });
  return { attempt, fresh: true };
}
async function intent(root, executionId, task, resultRef) {
  validateId(executionId); const value = await readJson(path.join(root, executionId, "intent.json"));
  if (value.schema !== 1 || value.executionId !== executionId || digest(value.task) !== digest(task) || value.resultRef !== resultRef) fail("binding_invalid");
  return value;
}
async function snapshot({ provider, task, source, attempt, filename, held, remaining }) {
  await held(); const company = path.join(attempt, task.companyId); await fs.mkdir(company, { mode: 0o700 });
  const file = path.join(company, filename), handle = await fs.open(file, "wx", 0o600), hash = crypto.createHash("sha256"); let bytes = 0;
  try {
    const observed = await provider.streamSealedObject({ context: { authenticated: true, companyId: task.companyId, userId: task.userId }, objectKey: source.objectKey, objectVersion: source.objectVersion,
      consume: async chunk => { remaining(); if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) || chunk.length > 65536 || bytes + chunk.length > source.sizeBytes) fail("source_invalid");
        hash.update(chunk); let offset = 0; while (offset < chunk.length) { const written = await handle.write(chunk, offset, chunk.length - offset); if (!written.bytesWritten) fail("source_invalid"); offset += written.bytesWritten; } bytes += chunk.length;
      } });
    if (bytes !== source.sizeBytes || hash.digest("hex") !== source.sha256 || observed?.sha256 !== source.sha256 || observed.sizeBytes !== source.sizeBytes) fail("source_invalid");
    await handle.sync();
  } finally { await handle.close(); }
  await held(); return file;
}
async function cleanupSnapshot(root, executionId, companyId, filename) {
  const attempt = path.join(root, executionId), company = path.join(attempt, companyId), file = path.join(company, filename);
  await safePath(root); await safePath(attempt);
  try {
    await safePath(company); const files = await fs.readdir(company);
    if (files.some(name => name !== filename)) fail("cleanup_unknown_file");
    if (files.length) { await safePath(file, { file: true }); await fs.unlink(file); }
    await fs.rmdir(company);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function saveTerminal(attempt, response) {
  try { await immutableJson(path.join(attempt, "worker-terminal.json"), response); } catch (error) { if (error.code !== "EEXIST") throw error; const old = await readJson(path.join(attempt, "worker-terminal.json")); if (digest(old) !== digest(response)) fail("terminal_conflict"); }
  return response;
}
module.exports = { fail, validateId, budget, initialize, intent, snapshot, cleanupSnapshot, saveTerminal, digest, readJson, immutableJson, safePath };
