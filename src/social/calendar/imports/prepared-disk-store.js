"use strict";

const fs = require("node:fs/promises"), { constants } = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { inspectedMedia, previewDigest } = require("./policy");
const { isImportAccessPolicy } = require("./access-policy");
const { isPreparedDiskAdmission } = require("./prepared-disk-admission");
const { createPreparedDiskOutputInspector, isPreparedDiskOutputInspector } = require("./prepared-disk-output-inspector");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const BINDING = ["companyId", "userId", "assetId", "mediaRevision", "resultRef", "dispatchKey", "executionDigest"];
const META_BYTES = 65536, META_FILE_BYTES = 32768, CHUNK_BYTES = 65536, RANGE_BYTES = 100 * 1024 ** 2;
const stores = new WeakMap();
function fail(code, statusCode = 503) { throw Object.assign(new Error(`prepared_disk_${code}`), { code: `prepared_disk_${code}`, statusCode }); }
function object(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))); }
function fields(value, allowed, required = allowed) {
  if (!object(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail("request_invalid", 400);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]));
  return value;
}
const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function localRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /^[/\\]{2}/.test(value) || /[\0\r\n]/.test(value) || value.replace(/^[a-z]:/i, "").includes(":")) fail("root_invalid");
  const resolved = path.resolve(value); if (resolved === path.parse(resolved).root) fail("root_invalid"); return resolved;
}
function binding(value) {
  fields(value, BINDING);
  if (!["companyId", "userId", "assetId", "resultRef"].every(key => typeof value[key] === "string" && UUID.test(value[key])) ||
      !Number.isSafeInteger(value.mediaRevision) || value.mediaRevision < 1 || value.mediaRevision > 999999 ||
      !HASH.test(value.dispatchKey || "") || !HASH.test(value.executionDigest || "")) fail("request_invalid", 400);
  return Object.fromEntries(BINDING.map(key => [key, value[key]]));
}
function objectVersion(key) {
  const bytes = Buffer.from(hash(key).slice(0, 32), "hex"); bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString("hex"); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
async function directory(value) {
  const stat = await fs.lstat(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await fs.realpath(value)) !== value ||
      process.platform !== "win32" && ((stat.mode & 0o077) || typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("root_unsafe");
}
async function syncDirectory(value) {
  if (process.platform === "win32") return; // No Linux/NTFS durability equivalence is claimed.
  const handle = await fs.open(value, constants.O_RDONLY | (constants.O_DIRECTORY || 0));
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readFile(value, maximum, expectedSize) {
  if (maximum > META_BYTES) fail("metadata_too_large");
  const before = await fs.lstat(value);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > maximum ||
      expectedSize !== undefined && before.size !== expectedSize) fail("file_invalid", 422);
  const handle = await fs.open(value, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1 || initial.dev !== before.dev || initial.ino !== before.ino || initial.size !== before.size) fail("file_changed", 422);
    const bytes = Buffer.alloc(initial.size); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, Math.min(CHUNK_BYTES, bytes.length - offset), offset);
      if (!bytesRead) fail("file_changed", 422); offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== initial.size || after.mtimeMs !== initial.mtimeMs || after.ctimeMs !== initial.ctimeMs || after.nlink !== 1) fail("file_changed", 422);
    return bytes;
  } finally { await handle.close(); }
}
async function openFile(value, maximum, expectedSize, expectedIdentity) {
  const before = await fs.lstat(value);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !Number.isSafeInteger(before.size) ||
      before.size < 1 || before.size > maximum || before.size !== expectedSize) fail("file_invalid", 422);
  const handle = await fs.open(value, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const initial = await handle.stat(), identity = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
    if (!initial.isFile() || initial.nlink !== 1 || !equal(identity(initial), identity(before)) ||
        expectedIdentity && !equal(expectedIdentity, identity(initial))) fail("file_changed", 422);
    return { handle, identity: identity(initial), async unchanged() {
      const final = await handle.stat(); if (final.nlink !== 1 || !equal(identity(final), identity(initial))) fail("file_changed", 422);
    } };
  } catch (error) { await handle.close(); throw error; }
}
async function digestFile(value, part, consume, expectedIdentity, check = () => {}) {
  const file = await openFile(value, part.mimeType === "image/jpeg" ? 8 * 1024 ** 2 : 100 * 1024 ** 2, part.size, expectedIdentity);
  const digest = crypto.createHash("sha256"), buffer = Buffer.alloc(CHUNK_BYTES); let offset = 0;
  try {
    while (offset < part.size) {
      check();
      const { bytesRead } = await file.handle.read(buffer, 0, Math.min(buffer.length, part.size - offset), offset);
      if (!bytesRead) fail("file_changed", 422);
      check();
      offset += bytesRead; const chunk = buffer.subarray(0, bytesRead); digest.update(chunk);
      if (consume) await consume(chunk);
    }
    check(); await file.unchanged(); if (digest.digest("hex") !== part.sha256) fail("checksum_invalid", 422);
    return file.identity;
  } finally { await file.handle.close(); }
}
async function exists(value) { try { await fs.lstat(value); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }

function createPreparedDiskResultStoreInternal({ rootDirectory, preparationRoot, tenantStore, admission, accessPolicy,
  outputInspector, enabled = false, allowVolatileForTests = false, clock = Date.now } = {}, readOnly = false) {
  const root = localRoot(rootDirectory), preparedRoot = localRoot(preparationRoot);
  if (root === preparedRoot || typeof clock !== "function") fail("configuration_invalid");
  if (!readOnly && outputInspector === undefined) outputInspector = createPreparedDiskOutputInspector();
  const testOnly = tenantStore?.capabilities?.persistence !== "durable" || !readOnly && admission?.capabilities?.testOnly === true;
  const available = Boolean(enabled && isImportAccessPolicy(accessPolicy) &&
    tenantStore?.capabilities?.atomicCompanyUpdates === true && typeof tenantStore.update === "function" &&
    (readOnly ? typeof tenantStore.read === "function" : isPreparedDiskOutputInspector(outputInspector) &&
      isPreparedDiskAdmission(admission, { allowVolatileForTests, rootDirectory: root })) && (!testOnly || allowVolatileForTests));
  const readState = (companyId, operation) => readOnly ? tenantStore.read(companyId, operation) : tenantStore.update(companyId, operation);
  function time() { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) fail("clock_invalid"); return value; }
  async function safe(operation) {
    if (!available) fail("unavailable");
    try { return await operation(); }
    catch (error) {
      if (/^prepared_disk_[a-z_]{1,80}$/.test(error?.code || "")) fail(error.code.slice("prepared_disk_".length), error.statusCode || 503);
      // Preserve only the closed, metadata-free process error code. Paths,
      // stderr and user content are never included in this diagnostic.
      if (/^media_process_[a-z_]{1,60}$/.test(error?.code || "")) fail("process_" + error.code.slice("media_process_".length));
      fail("operation_failed");
    }
  }
  function authorize(context) {
    try { return accessPolicy.resolve(context); } catch (_) { fail("not_allowed", 403); }
  }
  function queryFor(task, resultRef) { return binding(Object.fromEntries(BINDING.map(key => [key, key === "resultRef" ? resultRef : task?.[key]]))); }
  async function owned(query, suppliedTask, ready = false) {
    return readState(query.companyId, state => {
      const asset = state.preparation?.assets?.[query.assetId], jobId = asset?.revisions?.[String(query.mediaRevision)];
      const job = state.preparation?.jobs?.[jobId], upload = state.uploads?.[job?.uploadId];
      if (!asset || !job || !upload || asset.userId !== query.userId || job.companyId !== query.companyId || job.userId !== query.userId ||
          job.assetId !== query.assetId || job.mediaRevision !== query.mediaRevision || job.dispatchKey !== query.dispatchKey ||
          job.executionDigest !== query.executionDigest || upload.companyId !== query.companyId || upload.userId !== query.userId ||
          upload.assetId !== query.assetId || upload.state !== "uploaded" || upload.sha256 !== job.source?.sha256 ||
          upload.verified?.sha256 !== job.source.sha256 || upload.verified?.sizeBytes !== job.source.sizeBytes ||
          upload.objectKey !== job.source.objectKey || upload.objectVersion !== job.source.objectVersion ||
          !["dispatching", "processing", "reconciliation", "ready"].includes(job.state) || ready && job.state !== "ready" ||
          job.state === "ready" && job.result?.resultRef !== query.resultRef) fail("owner_invalid", 403);
      if (suppliedTask) {
        const fence = job.state === "ready" ? job.completedFence : job.fence;
        const token = job.state === "ready" ? job.completedToken : job.lease?.token;
        if (suppliedTask.schema !== 1 || suppliedTask.jobId !== job.jobId || suppliedTask.uploadId !== job.uploadId ||
            suppliedTask.fence !== fence || suppliedTask.leaseToken !== token || suppliedTask.maxRuntimeMs !== job.runtimeBudgetMs ||
            suppliedTask.reservedOutputBytes !== job.reservedBytes || !equal(suppliedTask.source, job.source) ||
            !equal(suppliedTask.selection, job.selection) || !equal(suppliedTask.plan, job.plan) ||
            job.state !== "ready" && suppliedTask.deadlineAt !== job.lease?.deadlineAt || !equal(queryFor(suppliedTask, query.resultRef), query)) fail("task_changed", 409);
      }
      return structuredClone(job);
    });
  }
  async function folders(query, create = false) {
    await directory(root); let current = root;
    for (const part of [query.companyId, query.assetId, query.dispatchKey]) {
      current = path.join(current, part);
      if (create) await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      await directory(current);
    }
    return current;
  }
  function canonicalPrepared(task, value) {
    if (!object(value) || !object(value.variants) || !object(value.sourceInspection) ||
        value.sourceSha256 !== task.source.sha256 || value.sourceSize !== task.source.sizeBytes || value.sourceKind !== task.selection.kind ||
        value.commercialReady !== !task.plan.testOnly) fail("result_invalid", 422);
    const inspected = inspectedMedia(value.sourceInspection, task.selection.kind), expected = task.source.inspection;
    if (inspected.sha256 !== task.source.sha256 || inspected.size !== task.source.sizeBytes || inspected.width !== expected.width ||
        inspected.height !== expected.height || task.selection.kind === "video" &&
        (Math.abs(inspected.durationSeconds - expected.durationSeconds) > 0.25 || inspected.hasAudio !== expected.hasAudio)) fail("source_changed", 422);
    const sourceInspection = { ...inspected, decoded: true, ...(task.selection.kind === "image" ? { frames: 1 } : { colorMode: "sdr" }) };
    function part(value, target) {
      if (!object(value) || !HASH.test(value.sha256 || "") || value.sourceSha256 !== task.source.sha256 ||
          !["image/jpeg", "video/mp4"].includes(value.mimeType) || value.width !== 1080 || value.height !== (target === "feed" ? 1350 : 1920) ||
          !Number.isSafeInteger(value.size) || value.size < 1 || value.size > (value.mimeType === "image/jpeg" ? 8 : 100) * 1024 ** 2 ||
          typeof value.hasAudio !== "boolean" || !["none", "original", "muted", "music"].includes(value.audioMode) ||
          value.fileName !== `${value.sha256}.${value.mimeType === "image/jpeg" ? "jpg" : "mp4"}` ||
          (value.mimeType === "image/jpeg" ? value.durationSeconds != null || value.hasAudio || value.audioMode !== "none" :
            !Number.isFinite(value.durationSeconds) || value.durationSeconds <= 0 || value.durationSeconds > 60.25 ||
            value.videoCodec !== "h264" || value.audioCodec !== (value.hasAudio ? "aac" : null) || value.color !== "bt709" || value.fps !== 30) ||
          value.musicSha256 !== undefined && !HASH.test(value.musicSha256)) fail("descriptor_invalid", 422);
      return Object.fromEntries(["mimeType", "width", "height", "sourceSha256", "durationSeconds", "audioMode", "hasAudio", "fileName", "sha256", "size",
        "musicSha256", "videoCodec", "audioCodec", "color", "fps"].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
    }
    const variants = Object.fromEntries(Object.entries(value.variants).map(([target, descriptor]) => {
      if (!["feed", "story", "reel"].includes(target)) fail("descriptor_invalid", 422); return [target, part(descriptor, target)];
    }));
    previewDigest(task.plan, variants);
    for (const delivery of task.plan.deliveries) {
      const value = variants[delivery.target];
      if (delivery.audioMode === "music" && !value.hasAudio || ["none", "muted"].includes(delivery.audioMode) && value.hasAudio ||
          delivery.audioMode === "original" && value.hasAudio !== expected.hasAudio) fail("descriptor_invalid", 422);
    }
    const needsThumbnail = task.plan.deliveries.some(value => value.mediaType === "video");
    const thumbnail = needsThumbnail ? part(value.thumbnail, "thumbnail") : undefined;
    if (thumbnail && thumbnail.mimeType !== "image/jpeg" || !needsThumbnail && value.thumbnail != null) fail("descriptor_invalid", 422);
    const logicalBytes = Object.values(variants).reduce((sum, value) => sum + value.size, thumbnail?.size || 0);
    if (logicalBytes > task.reservedOutputBytes) fail("result_too_large", 422);
    return { sourceSha256: task.source.sha256, sourceSize: task.source.sizeBytes, sourceKind: task.selection.kind,
      sourceInspection, variants, ...(thumbnail ? { thumbnail } : {}), commercialReady: value.commercialReady };
  }
  function allFiles(prepared) {
    const map = new Map();
    for (const value of [...Object.values(prepared.variants), ...(prepared.thumbnail ? [prepared.thumbnail] : [])]) {
      if (map.has(value.fileName) && !equal(map.get(value.fileName), value)) fail("descriptor_conflict", 422);
      map.set(value.fileName, value);
    }
    return map;
  }
  function makeActual(query, task, prepared, finishedAt, elapsedMs) {
    if (!Number.isSafeInteger(finishedAt) || finishedAt < task.deadlineAt - task.maxRuntimeMs || finishedAt > task.deadlineAt || finishedAt > time() ||
        !Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > task.maxRuntimeMs) fail("timing_invalid", 422);
    function ref(part) {
      const key = hash(JSON.stringify([query.companyId, query.userId, query.assetId, query.mediaRevision, query.dispatchKey, query.resultRef, part.sha256]));
      return { objectKey: key, objectVersion: objectVersion(key), sha256: part.sha256, sizeBytes: part.size,
        companyId: query.companyId, assetId: query.assetId, mediaRevision: query.mediaRevision };
    }
    return { complete: true, immutable: true, actualInspection: true, ...query, finishedAt, elapsedMs, prepared,
      objects: Object.fromEntries(Object.entries(prepared.variants).map(([target, value]) => [target, ref(value)])),
      ...(prepared.thumbnail ? { thumbnailObject: ref(prepared.thumbnail) } : {}) };
  }
  async function held(task, resultRef, prepared, intent) {
    const requiredBytes = [...allFiles(prepared).values()].reduce((sum, part) => sum + part.size, META_BYTES);
    if (await admission.assertHeld({ task, resultRef, requiredBytes, intent }) !== true) fail("storage_not_held");
  }
  async function verifiedFile(dirname, part, decode = false, remaining = () => 30000, check) {
    const filename = path.join(dirname, part.fileName), identity = await digestFile(filename, part, undefined, undefined, check);
    let inspection;
    if (decode) {
      const result = await outputInspector.inspectFile({ filePath: filename, descriptor: part, timeoutMs: remaining() });
      validateInspection(part, result);
      inspection = { ...result, sha256: part.sha256, sizeBytes: part.size };
      await digestFile(filename, part, undefined, identity, check);
    }
    return decode ? { identity, inspection } : identity;
  }
  function validateInspection(part, result) {
      if (!result || result.decoded !== true || result.mimeType !== part.mimeType || result.width !== part.width || result.height !== part.height ||
          result.hasAudio !== part.hasAudio || (part.mimeType === "image/jpeg" ? result.durationSeconds != null :
            !Number.isFinite(result.durationSeconds) || result.durationSeconds > 60.25 || Math.abs(result.durationSeconds - part.durationSeconds) > 0.25 ||
            result.videoCodec !== part.videoCodec || result.audioCodec !== part.audioCodec || result.color !== part.color || result.fps !== part.fps)) fail("inspection_invalid", 422);
  }
  function inspectionBudget(task, elapsedMs, start) {
    return () => {
      const commitElapsed = performance.now() - start;
      const left = Math.floor(Math.min(30000 - commitElapsed, task.deadlineAt - time(), task.maxRuntimeMs - elapsedMs - commitElapsed));
      if (left < 1) fail("deadline_exceeded", 409);
      return left;
    };
  }
  async function manifest(query) {
    const dirname = await folders(query), saved = JSON.parse((await readFile(path.join(dirname, "manifest.json"), META_FILE_BYTES)).toString("utf8"));
    fields(saved, ["schema", "task", "actual", "inspection"]);
    if (saved.schema !== 1 || !equal(queryFor(saved.task, saved.actual?.resultRef), query)) fail("result_conflict", 409);
    await owned(query, saved.task);
    const prepared = canonicalPrepared(saved.task, saved.actual.prepared);
    const actual = makeActual(query, saved.task, prepared, saved.actual.finishedAt, saved.actual.elapsedMs);
    if (!equal(actual, saved.actual)) fail("manifest_invalid", 422);
    fields(saved.inspection, ["schema", "profile", "files"]);
    if (saved.inspection.schema !== 1 || saved.inspection.profile !== "prepared_disk_decode_v1" || !object(saved.inspection.files) ||
        !equal(Object.keys(saved.inspection.files).sort(), [...allFiles(prepared).keys()].sort())) fail("manifest_invalid", 422);
    for (const part of allFiles(prepared).values()) {
      const proof = saved.inspection.files[part.fileName];
      fields(proof, ["decoded", "mimeType", "width", "height", "durationSeconds", "hasAudio", "videoCodec", "audioCodec", "color", "fps", "sha256", "sizeBytes"],
        ["decoded", "mimeType", "width", "height", "durationSeconds", "hasAudio", "sha256", "sizeBytes"]);
      if (proof.sha256 !== part.sha256 || proof.sizeBytes !== part.size) fail("manifest_invalid", 422);
      validateInspection(part, proof);
    }
    const intent = JSON.parse((await readFile(path.join(dirname, "intent.json"), META_FILE_BYTES)).toString("utf8"));
    fields(intent, ["schema", "task", "resultRef", "prepared", "finishedAt", "elapsedMs"]);
    if (intent.schema !== 1 || !equal(intent.task, saved.task) || intent.resultRef !== query.resultRef || !equal(intent.prepared, prepared) ||
        !Number.isSafeInteger(intent.elapsedMs) || intent.elapsedMs < 0 || intent.elapsedMs > actual.elapsedMs ||
        !Number.isSafeInteger(intent.finishedAt) || intent.finishedAt > actual.finishedAt) fail("manifest_invalid", 422);
    const names = new Set(["manifest.json", "intent.json", "operation.lock", ...allFiles(prepared).keys()]);
    if ((await fs.readdir(dirname)).some(name => !names.has(name))) fail("busy_or_recovery_required", 409);
    // A permanent reader reaches this only for the durable ready revision
    // checked by preview(). It has no capacity/worker authority. Retention,
    // exact owner, committed task/result and immutable bytes stay verified;
    // reopening a processing reservation is not required to view stored media.
    if (!readOnly) await held(saved.task, query.resultRef, prepared, "read");
    return { dirname, task: saved.task, actual };
  }
  async function immutableWrite(filename, bytes) {
    if (await exists(filename)) { if (!(await readFile(filename, bytes.length, bytes.length)).equals(bytes)) fail("file_conflict", 409); return; }
    const temporary = path.join(path.dirname(filename), `.pending-${crypto.randomUUID()}`);
    let handle, created = false;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      created = true;
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      await fs.link(temporary, filename);
    } finally {
      if (handle) await handle.close();
      if (created && await exists(temporary)) await fs.unlink(temporary);
    }
    await fs.chmod(filename, 0o400); await syncDirectory(path.dirname(filename));
  }
  async function immutableCopy(source, filename, part, identity, check = () => {}) {
    check(); if (await exists(filename)) { await digestFile(filename, part, undefined, undefined, check); return; }
    const temporary = path.join(path.dirname(filename), `.pending-${crypto.randomUUID()}`);
    let handle, created = false;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600); created = true;
      await digestFile(source, part, chunk => handle.writeFile(chunk), identity, check);
      await handle.sync(); await handle.close(); handle = null;
      check();
      await fs.link(temporary, filename);
    } finally {
      if (handle) await handle.close();
      if (created && await exists(temporary)) await fs.unlink(temporary);
    }
    await fs.chmod(filename, 0o400); await syncDirectory(path.dirname(filename));
  }
  async function preview(args, rangeAllowed) {
    fields(args, ["context", "assetId", "mediaRevision", "resultRef", "target", "sha256", "signal", "timeoutMs", ...(rangeAllowed ? ["range", "consume"] : [])],
      ["context", "assetId", "mediaRevision", "resultRef", "target", "sha256"]);
    const timeoutMs = args.timeoutMs === undefined ? 30000 : args.timeoutMs, started = performance.now();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
        args.signal !== undefined && !(args.signal instanceof AbortSignal)) fail("request_invalid", 400);
    function check() { if (args.signal?.aborted) fail("stream_aborted", 499); if (performance.now() - started >= timeoutMs) fail("stream_timeout", 408); }
    check();
    const owner = authorize(args.context);
    if (!UUID.test(args.assetId || "") || !UUID.test(args.resultRef || "") || !HASH.test(args.sha256 || "") ||
        !Number.isSafeInteger(args.mediaRevision) || args.mediaRevision < 1 || !["feed", "story", "reel", "thumbnail"].includes(args.target)) fail("request_invalid", 400);
    const job = await readState(owner.companyId, state => {
      const asset = state.preparation?.assets?.[args.assetId], jobId = asset?.revisions?.[String(args.mediaRevision)];
      const row = state.preparation?.jobs?.[jobId];
      if (!asset || asset.userId !== owner.userId || !row || row.userId !== owner.userId || row.state !== "ready" || row.result?.resultRef !== args.resultRef) fail("not_found", 404);
      return structuredClone(row);
    });
    const query = queryFor(job, args.resultRef); await owned(query, undefined, true);
    const saved = await manifest(query), part = args.target === "thumbnail" ? saved.actual.prepared.thumbnail : saved.actual.prepared.variants[args.target];
    const published = args.target === "thumbnail" ? job.result.thumbnail : job.result.variants?.[args.target];
    if (!part || !published || part.sha256 !== args.sha256 || published.sha256 !== part.sha256 || published.size !== part.size || published.mimeType !== part.mimeType) fail("preview_changed", 409);
    const reference = args.target === "thumbnail" ? job.result.thumbnail : job.result.objects?.[args.target];
    const committedReference = args.target === "thumbnail" ? saved.actual.thumbnailObject : saved.actual.objects[args.target];
    if (!reference || reference.objectKey !== committedReference.objectKey || reference.objectVersion !== committedReference.objectVersion ||
        ["sourceSha256", "width", "height", "audioMode", "hasAudio", "musicSha256"].some(key => published[key] !== part[key]) ||
        (published.durationSeconds ?? null) !== (part.durationSeconds ?? null) ||
        args.target !== "thumbnail" && (reference.sha256 !== part.sha256 || reference.sizeBytes !== part.size)) fail("preview_changed", 409);
    check(); const fileIdentity = await verifiedFile(saved.dirname, part, false, undefined, check);
    authorize(args.context); await owned(query, saved.task, true); check();
    return { query, saved, part, fileIdentity };
  }
  const api = Object.freeze({
    capabilities: Object.freeze({ available, testOnly, actualInspection: available, immutableObjects: available,
      ownerScopedPreview: available, readyForProduction: false, maxRangeBytes: RANGE_BYTES, maxChunkBytes: CHUNK_BYTES }),
    async commit({ task, prepared, resultRef, finishedAt, elapsedMs } = {}) { return safe(async () => {
      const commitStarted = performance.now();
      const query = queryFor(task, resultRef); await owned(query, task);
      const canonical = canonicalPrepared(task, prepared);
      const expectedDirectory = path.join(root, query.companyId, query.assetId, query.dispatchKey);
      async function replay() {
        const prior = await manifest(query);
        if (!equal(prior.task, task) || !equal(prior.actual.prepared, canonical)) fail("result_conflict", 409);
        for (const part of allFiles(canonical).values()) await verifiedFile(prior.dirname, part);
        return prior.actual;
      }
      if (await exists(path.join(expectedDirectory, "manifest.json"))) return replay();
      makeActual(query, task, canonical, finishedAt, elapsedMs);
      await held(task, resultRef, canonical, "write");
      const dirname = await folders(query, true), lockPath = path.join(dirname, "operation.lock");
      let lock;
      try { lock = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600); }
      catch (error) { if (error.code === "EEXIST") fail("busy_or_recovery_required", 409); throw error; }
      try {
        await lock.sync(); await syncDirectory(dirname);
        if (await exists(path.join(dirname, "manifest.json"))) return replay();
        const intent = { schema: 1, task, resultRef, prepared: canonical, finishedAt, elapsedMs };
        const intentPath = path.join(dirname, "intent.json"), intentBytes = Buffer.from(JSON.stringify(intent));
        if (intentBytes.length > META_FILE_BYTES) fail("manifest_too_large", 422);
        if (await exists(intentPath)) {
          const previous = JSON.parse((await readFile(intentPath, META_FILE_BYTES)).toString("utf8"));
          if (!equal(previous, intent)) fail("result_conflict", 409);
        } else await immutableWrite(intentPath, intentBytes);
        const expectedNames = new Set(["intent.json", "operation.lock", ...allFiles(canonical).keys()]);
        if ((await fs.readdir(dirname)).some(name => !expectedNames.has(name))) fail("busy_or_recovery_required", 409);
        await directory(preparedRoot); let input = preparedRoot;
        for (const part of [query.companyId, query.assetId]) { input = path.join(input, part); await directory(input); }
        const remaining = inspectionBudget(task, elapsedMs, commitStarted), inspections = {};
        for (const part of allFiles(canonical).values()) {
          remaining();
          await owned(query, task); await held(task, resultRef, canonical, "write");
          const identity = await verifiedFile(input, part, false, remaining, remaining);
          await immutableCopy(path.join(input, part.fileName), path.join(dirname, part.fileName), part, identity, remaining);
          inspections[part.fileName] = (await verifiedFile(dirname, part, true, remaining, remaining)).inspection;
        }
        remaining();
        await owned(query, task); await held(task, resultRef, canonical, "write");
        if (time() > task.deadlineAt) fail("deadline_exceeded", 409);
        const actual = makeActual(query, task, canonical, time(), elapsedMs + Math.ceil(performance.now() - commitStarted));
        const content = Buffer.from(JSON.stringify({ schema: 1, task, actual,
          inspection: { schema: 1, profile: "prepared_disk_decode_v1", files: inspections } }));
        if (content.length > META_FILE_BYTES) fail("manifest_too_large", 422);
        await immutableWrite(path.join(dirname, "manifest.json"), content);
        if (time() > task.deadlineAt) fail("deadline_exceeded", 409);
        return structuredClone(actual);
      } finally { await lock.close(); await fs.unlink(lockPath); await syncDirectory(dirname); }
    }); },
    async inspectCommitted(input) { return safe(async () => {
      const query = binding(input); await owned(query);
      const saved = await manifest(query);
      for (const part of allFiles(saved.actual.prepared).values()) await verifiedFile(saved.dirname, part);
      await owned(query, saved.task); return structuredClone(saved.actual);
    }); },
    async inspectPreview(args) { return safe(async () => {
      const { part } = await preview(args, false);
      return { assetId: args.assetId, mediaRevision: args.mediaRevision, resultRef: args.resultRef, target: args.target,
        sha256: part.sha256, mimeType: part.mimeType, sizeBytes: part.size, width: part.width, height: part.height,
        durationSeconds: part.durationSeconds ?? null, hasAudio: part.hasAudio, audioMode: part.audioMode, maxRangeBytes: RANGE_BYTES };
    }); },
    async streamPreview(args) { return safe(async () => {
      if (typeof args?.consume !== "function") fail("request_invalid", 400);
      const timeoutMs = args.timeoutMs === undefined ? 30000 : args.timeoutMs;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
          args.signal !== undefined && !(args.signal instanceof AbortSignal)) fail("request_invalid", 400);
      const started = performance.now();
      function check() { if (args.signal?.aborted) fail("stream_aborted", 499); if (performance.now() - started >= timeoutMs) fail("stream_timeout", 408); }
      check();
      const { part, saved, fileIdentity } = await preview(args, true);
      check();
      let start = 0, end = part.size - 1;
      if (args.range !== undefined) {
        fields(args.range, ["start", "end"]); start = args.range.start; end = args.range.end;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= part.size || end - start + 1 > RANGE_BYTES) fail("range_invalid", 416);
      }
      const file = await openFile(path.join(saved.dirname, part.fileName), RANGE_BYTES, part.size, fileIdentity), buffer = Buffer.alloc(CHUNK_BYTES);
      try { for (let offset = start; offset <= end;) {
        check(); authorize(args.context);
        const { bytesRead } = await file.handle.read(buffer, 0, Math.min(buffer.length, end - offset + 1), offset);
        if (!bytesRead) fail("file_changed", 422); offset += bytesRead;
        let timer, abort;
        try {
          const stopped = new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error("prepared_disk_stream_timeout"), { code: "prepared_disk_stream_timeout", statusCode: 408 })),
              Math.max(1, timeoutMs - (performance.now() - started)));
            abort = () => reject(Object.assign(new Error("prepared_disk_stream_aborted"), { code: "prepared_disk_stream_aborted", statusCode: 499 }));
            args.signal?.addEventListener("abort", abort, { once: true });
          });
          await Promise.race([Promise.resolve(args.consume(Buffer.from(buffer.subarray(0, bytesRead)))), stopped]);
        } finally { clearTimeout(timer); args.signal?.removeEventListener("abort", abort); }
      } await file.unchanged(); } finally { await file.handle.close(); }
      return { sha256: part.sha256, mimeType: part.mimeType, sizeBytes: part.size, transferredBytes: end - start + 1, start, end };
    }); }
  });
  if (readOnly) return Object.freeze({ capabilities: Object.freeze({ ...api.capabilities, readOnly: true }),
    inspectPreview: api.inspectPreview, streamPreview: api.streamPreview });
  stores.set(api, { available, testOnly }); return api;
}
function createPreparedDiskResultStore(options) { return createPreparedDiskResultStoreInternal(options); }
// Stored derivatives are read without a processing/admission composition. No
// commit, executor, bridge credential or capacity reservation is exposed here.
function createPreparedDiskResultReader(options) { return createPreparedDiskResultStoreInternal(options, true); }
function isPreparedDiskResultStore(value, { allowVolatileForTests = false } = {}) {
  const record = stores.get(value); return Boolean(record?.available && (!record.testOnly || allowVolatileForTests));
}
module.exports = { createPreparedDiskResultStore, createPreparedDiskResultReader, isPreparedDiskResultStore };
