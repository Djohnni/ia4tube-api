'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');
const MAX_BYTES = 1073741824;
const MAX_ENTRIES = 10000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const NAMES = ['00-data-dir-manifest.json', '01-data-dir-posix.tar'];
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function need(test, code) { if (!test) fail(code); }
function abortCheck(signal) { if (signal?.aborted) fail('capture_aborted'); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stable(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode), uid: String(stat.uid),
    gid: String(stat.gid), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
async function hashRegular(file, before, signal) {
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const bytes = Buffer.alloc(65536);
  try {
    const opened = await handle.stat({ bigint: true });
    need(opened.isFile() && opened.nlink === 1n && same(stable(before), stable(opened)), 'capture_file_changed');
    const hash = crypto.createHash('sha256'); let position = 0;
    while (true) {
      abortCheck(signal);
      const result = await handle.read(bytes, 0, bytes.length, position);
      if (result.bytesRead === 0) break;
      hash.update(bytes.subarray(0, result.bytesRead)); position += result.bytesRead;
    }
    need(BigInt(position) === before.size && same(stable(before), stable(await handle.stat({ bigint: true }))), 'capture_file_changed');
    return hash.digest('hex');
  } finally { bytes.fill(0); await handle.close(); }
}
async function inventoryTree(root, { exclude, signal, maxBytes = MAX_BYTES } = {}) {
  need(path.isAbsolute(root) && Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= MAX_BYTES, 'capture_inventory_contract');
  root = path.resolve(root);
  need(await fsp.realpath(root) === root, 'capture_root_redirected');
  const excluded = exclude ? path.resolve(exclude) : null;
  if (excluded) need(excluded.startsWith(root + path.sep), 'capture_exclusion_refused');
  const rows = []; let logicalBytes = 0; let files = 0; let directories = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  async function visit(current, relative) {
    abortCheck(signal);
    if (current === excluded) return;
    need(rows.length < MAX_ENTRIES, 'capture_entry_limit');
    need(Buffer.byteLength(relative, 'utf8') <= 1024, 'capture_path_length_limit');
    const before = await fsp.lstat(current, { bigint: true });
    need(!before.isSymbolicLink() && (before.isDirectory() || before.isFile()), 'capture_special_file_refused');
    const row = { path: relative, type: before.isDirectory() ? 'directory' : 'file', ...stable(before) };
    if (before.isFile()) {
      need(before.nlink === 1n, 'capture_hardlink_refused');
      need(before.size <= BigInt(maxBytes - logicalBytes), 'capture_size_limit');
      logicalBytes += Number(before.size); files++;
      row.sha256 = await hashRegular(current, before, signal);
      rows.push(row);
    } else {
      directories++; rows.push(row);
      const names = (await fsp.readdir(current, { encoding: 'buffer' })).sort(Buffer.compare);
      for (const name of names) {
        let text;
        try { text = decoder.decode(name); } catch (_) { fail('capture_filename_encoding_refused'); }
        need(Buffer.from(text).equals(name) && text !== '.' && text !== '..', 'capture_filename_refused');
        await visit(path.join(current, text), relative === '.' ? text : relative + '/' + text);
      }
      need(same(stable(before), stable(await fsp.lstat(current, { bigint: true }))), 'capture_directory_changed');
    }
  }
  await visit(root, '.');
  return { rows, files, directories, logicalBytes };
}
function compareInventories(before, after) { need(same(before, after), 'capture_inventory_changed'); return true; }
function buildTarArgs({ mode, sourceRoot, archive, list }) {
  need(mode === 'create' || mode === 'compare', 'capture_tar_mode_refused');
  const args = [mode === 'create' ? '--create' : '--compare', '--format=pax', '--numeric-owner', '--acls', '--xattrs', '--xattrs-include=*', '--file', archive, '--directory', sourceRoot];
  if (mode === 'create') args.push('--no-recursion', '--null', '--verbatim-files-from', '--files-from', list);
  return args;
}
async function privateDirectory(target, { existing = false, fixture = false } = {}) {
  if (!existing) await fsp.mkdir(target, { mode: 0o700 });
  const stat = await fsp.lstat(target);
  need(stat.isDirectory() && !stat.isSymbolicLink() && await fsp.realpath(target) === path.resolve(target), 'capture_workspace_refused');
  if (!fixture) need(stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700, 'capture_workspace_permissions');
  // Also cover an empty, validated directory left by an earlier failed sync.
  // Merely finding it again is not evidence that its parent entry is durable.
  if (!fixture) await syncNewDirectory(target);
}
async function writeNew(target, value) {
  const handle = await fsp.open(target, 'wx', 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(directory) {
  const h = await fsp.open(directory, fs.constants.O_RDONLY);
  try { await h.sync(); } finally { await h.close(); }
}
async function syncNewDirectory(directory, synchronize = syncDirectory) {
  // Persist both the directory metadata and the new name in its parent. A
  // failure is fatal; the caller must not publish a verified capture afterward.
  await synchronize(directory);
  await synchronize(path.dirname(directory));
}
function createTarRunner(signal) {
  return async args => {
    // Reserve the archive with O_EXCL. GNU tar writes the already opened inode,
    // never an ordinary pathname it could truncate/replace after preflight.
    let archiveHandle;
    const commandArgs = [...args];
    if (args[0] === '--create') {
      const index = args.indexOf('--file') + 1;
      archiveHandle = await fsp.open(args[index], 'wx', 0o600);
      commandArgs[index] = '/proc/self/fd/3';
    }
    try { return await new Promise((resolve, reject) => {
    let error = false; let stdout = ''; let exceeded = false;
    const child = spawn('/usr/bin/tar', commandArgs, { shell: false, stdio: archiveHandle ? ['ignore', 'pipe', 'pipe', archiveHandle.fd] : ['ignore', 'pipe', 'pipe'], env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' } });
    const stop = () => { child.kill('SIGTERM'); };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.on('error', () => { error = true; });
    child.stdout.on('data', chunk => { if (stdout.length + chunk.length > 4096) { exceeded = true; child.kill('SIGTERM'); } else stdout += chunk.toString('utf8'); });
    child.stderr.on('data', () => { error = true; }); // Paths/data never leave this process.
    child.once('close', (code, terminationSignal) => {
      signal?.removeEventListener('abort', stop);
      if (error || exceeded || code !== 0 || terminationSignal || signal?.aborted) reject(Object.assign(new Error('capture_tar_refused'), { code: 'capture_tar_refused' }));
      else resolve(stdout);
    });
    }); } finally {
      if (archiveHandle) {
        try { await archiveHandle.sync(); } finally { await archiveHandle.close(); }
      }
    }
  };
}
async function capture(request, adapters) {
  const { signal, bundle, runTar, fixture = false } = adapters;
  need(typeof request.captureId === 'string' && typeof request.epoch === 'string' && typeof request.sourceFingerprint === 'string' && UUID.test(request.captureId) && UUID.test(request.epoch) && SHA.test(request.sourceFingerprint), 'capture_request_invalid');
  need(Buffer.isBuffer(request.bundleKey) && request.bundleKey.length === 32, 'capture_key_invalid');
  const root = path.resolve(request.sourceRoot);
  if (fixture) need(root.startsWith(path.resolve(os.tmpdir()) + path.sep), 'capture_fixture_root_refused');
  else need(process.platform === 'linux' && root === '/var/data', 'capture_posix_root_required');
  need(await fsp.realpath(root) === root && (await fsp.lstat(root)).isDirectory(), 'capture_root_refused');
  const parent = path.join(root, '.ia4tube-recovery-c');
  try { await privateDirectory(parent, { fixture }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; await privateDirectory(parent, { existing: true, fixture }); }
  need((await fsp.readdir(parent)).length === 0, 'capture_prior_workspace_present');
  const operation = path.join(parent, request.captureId);
  await privateDirectory(operation, { fixture });
  const archive = path.join(operation, NAMES[1]);
  const manifestFile = path.join(operation, NAMES[0]);
  const list = path.join(operation, 'files.list');
  const output = path.join(operation, 'data-dir.bundle');
  const key = Buffer.from(request.bundleKey);
  try {
    abortCheck(signal);
    const before = await inventoryTree(root, { exclude: operation, signal });
    const capacity = await fsp.statfs(operation, { bigint: true });
    need(capacity.bavail * capacity.bsize >= BigInt(before.logicalBytes) * 3n + 1073741824n, 'capture_space_refused');
    await writeNew(list, Buffer.from(before.rows.map(row => row.path).join('\0') + '\0'));
    await runTar(buildTarArgs({ mode: 'create', sourceRoot: root, archive, list }));
    abortCheck(signal);
    const archiveStat = await fsp.lstat(archive, { bigint: true });
    need(archiveStat.isFile() && !archiveStat.isSymbolicLink() && archiveStat.nlink === 1n && archiveStat.size > 0n, 'capture_archive_invalid');
    // The destination was a fresh private directory; tar receives a fixed output.
    const archiveHash = await hashRegular(archive, archiveStat, signal);
    await runTar(buildTarArgs({ mode: 'compare', sourceRoot: root, archive, list }));
    const after = await inventoryTree(root, { exclude: operation, signal });
    compareInventories(before, after);
    const manifest = { format: 'ia4tube-data-dir-posix-capture-v1', captureId: request.captureId, epoch: request.epoch,
      sourceFingerprint: request.sourceFingerprint, excludedOperation: '.ia4tube-recovery-c/' + request.captureId,
      timestampPolicy: 'mtime-nanoseconds; ctime-observed-for-change-detection-not-restorable; atime-not-compared',
      aclXattrPolicy: fixture ? 'fixture-adapter-not-POSIX-proof' : 'GNU-tar-pax-acls-xattrs; isolated-restore-validation-still-required',
      archive: { name: NAMES[1], bytes: Number(archiveStat.size), sha256: archiveHash }, inventory: before,
      posixRestoreVerified: false, fixtureOnly: fixture };
    const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n');
    await writeNew(manifestFile, manifestBytes);
    abortCheck(signal);
    const created = await bundle.createEncryptedBundle({ entries: [{ name: NAMES[0], path: manifestFile }, { name: NAMES[1], path: archive }],
      expectedNames: NAMES, outputPath: output, label: 'data-dir-c-' + request.captureId,
      sourceFingerprint: request.sourceFingerprint, bundleKey: key });
    need(fixture || created.bundleDirectoryFsyncConfirmed === true, 'capture_directory_sync_unconfirmed');
    abortCheck(signal);
    await bundle.withExtractedEncryptedBundle({ containerPath: output, expectedNames: NAMES,
      expectedLabel: 'data-dir-c-' + request.captureId, expectedSourceFingerprint: request.sourceFingerprint,
      workDirectory: operation, workspacePurpose: 'data-dir-verify', bundleKey: key,
      operation: async extracted => { bundle.compareEntryEvidence(created.entries, extracted.files); } });
    abortCheck(signal);
    compareInventories(before, await inventoryTree(root, { exclude: operation, signal }));
    if (!fixture) await syncDirectory(operation);
    return { kind: 'ia4tube-data-dir-capture-result-v1', captureId: request.captureId, epoch: request.epoch,
      sourceFingerprint: request.sourceFingerprint, verified: true, posixArchiveCompared: !fixture,
      posixRestoreVerified: false, manifestSha256: digest(manifestBytes), bundleSha256: created.sha256,
      bundleBytes: created.size, files: before.files, directories: before.directories, logicalBytes: before.logicalBytes };
  } finally { key.fill(0); } // Preserve this operation's artifacts/partials; no broad cleanup.
}
async function runProductionRequest(message, signal) {
  need(process.platform === 'linux', 'capture_posix_required');
  need(message && Object.keys(message).sort().join('|') === ['kind','captureId','epoch','sourceRoot','sourceFingerprint','envelopeSha256','tarSha256','keyBase64'].sort().join('|') && message.kind === 'ia4tube-data-dir-capture-request-v1' && message.sourceRoot === '/var/data', 'capture_request_invalid');
  const modulePath = path.join(__dirname, 'recovery', 'encrypted-backup-bundle.js');
  for (const [file, pin] of [[modulePath, message.envelopeSha256], ['/usr/bin/tar', message.tarSha256]]) {
    need(typeof pin === 'string' && SHA.test(pin), 'capture_tool_pin_required');
    const stat = fs.lstatSync(file);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && digest(fs.readFileSync(file)) === pin, 'capture_tool_pin_mismatch');
  }
  need(typeof message.keyBase64 === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(message.keyBase64), 'capture_key_invalid');
  const key = Buffer.from(message.keyBase64, 'base64');
  if (key.length !== 32 || key.toString('base64') !== message.keyBase64) { key.fill(0); fail('capture_key_invalid'); }
  message.keyBase64 = undefined;
  const runTar = createTarRunner(signal);
  try {
    const version = await runTar(['--version']);
    need(/^tar \(GNU tar\) [0-9]+\.[0-9]+/.test(version), 'capture_gnu_tar_required');
    return await capture({ ...message, bundleKey: key }, { signal, runTar, bundle: require(modulePath) });
  } finally { key.fill(0); }
}
async function runFixtureCapture(request, adapters) {
  need(adapters && typeof adapters.runTar === 'function' && adapters.bundle, 'capture_fixture_adapters_required');
  return capture(request, { ...adapters, fixture: true });
}
if (require.main === module) {
  const abort = new AbortController();
  process.on('SIGTERM', () => abort.abort());
  let bytes = 0; const pieces = [];
  process.stdin.on('data', part => { bytes += part.length; if (bytes > 16384) { abort.abort(); process.stdin.destroy(); } else pieces.push(Buffer.from(part)); });
  process.stdin.once('end', async () => {
    let packet;
    try {
      need(bytes > 0 && bytes <= 16384, 'capture_request_size');
      packet = Buffer.concat(pieces); const message = JSON.parse(packet.toString('utf8')); packet.fill(0); for (const part of pieces) part.fill(0);
      const result = await runProductionRequest(message, abort.signal);
      abortCheck(abort.signal); process.stdout.write(JSON.stringify(result));
    } catch (_) { process.exitCode = 2; process.stdout.write('{"kind":"capture-refused"}'); }
    finally { if (packet) packet.fill(0); for (const part of pieces) part.fill(0); }
  });
}

module.exports = { inventoryTree, compareInventories, buildTarArgs, syncNewDirectory, runFixtureCapture, runProductionRequest };
