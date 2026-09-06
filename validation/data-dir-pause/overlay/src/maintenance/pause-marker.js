"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MARKER_NAME = ".ia4tube-pause.lock";
function fail() { throw Object.assign(new Error("pause_marker_refused"), { code: "pause_marker_refused" }); }
function need(value) { if (!value) fail(); }
function markerPath(dataDir) {
  need(typeof dataDir === "string" && path.isAbsolute(dataDir));
  const root = path.resolve(dataDir);
  need(root !== path.parse(root).root);
  return path.join(root, MARKER_NAME);
}

// Called synchronously before ALL legacy imports/initializers, even flag=false.
// Any entry (including a directory/dangling symlink/partial file) stops startup.
// This function never reads marker contents and never repairs or deletes it.
function assertNoUnfinishedPause({ dataDir } = {}) {
  const target = markerPath(dataDir);
  try { fs.lstatSync(target); }
  catch (error) { if (error.code === "ENOENT") return; fail(); }
  fail();
}

function createPauseMarker({ dataDir, testOnly = false, syncDirectory: fixtureSync } = {}) {
  const target = markerPath(dataDir);
  const root = path.dirname(target);
  if (testOnly) {
    need(root.startsWith(path.resolve(os.tmpdir()) + path.sep) && typeof fixtureSync === "function");
  } else need(process.platform === "linux" && root === "/var/data" && fixtureSync === undefined);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let owned = null;
  let directoryIdentity = null;
  let removed = false;
  const sameIdentity = (one, two) => one.dev === two.dev && one.ino === two.ino && one.uid === two.uid;
  async function directory() {
    const stat = await fsp.lstat(root);
    need(stat.isDirectory() && !stat.isSymbolicLink() && await fsp.realpath(root) === root);
    if (!testOnly) need(stat.uid === uid);
    if (directoryIdentity) need(sameIdentity(directoryIdentity, stat));
    else directoryIdentity = stat;
  }
  async function barrier() {
    if (testOnly) return fixtureSync(root);
    const handle = await fsp.open(root, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { need(sameIdentity(directoryIdentity, await handle.stat())); await handle.sync(); }
    finally { await handle.close(); }
  }
  async function absent() {
    try { await fsp.lstat(target); }
    catch (error) { if (error.code === "ENOENT") return; fail(); }
    fail();
  }
  async function acquire(epoch) {
    try {
      need(typeof epoch === "string" && UUID.test(epoch) && !owned);
      await directory();
      const handle = await fsp.open(target, "wx", 0o600);
      const bytes = Buffer.from(JSON.stringify({ format: "ia4tube-pause-marker-v1", epoch, pid: process.pid }) + "\n");
      try {
        const identity = await handle.stat();
        need(identity.isFile() && identity.nlink === 1);
        if (!testOnly) need(identity.uid === uid && (identity.mode & 0o777) === 0o600);
        owned = { epoch, bytes, identity };
        removed = false;
        await handle.writeFile(bytes);
        await handle.sync();
      } finally { await handle.close(); }
      await barrier();
    } catch (_) { fail(); } // Preserve partial/owned marker after any failure.
  }
  async function release(epoch) {
    try {
      need(typeof epoch === "string" && UUID.test(epoch));
      await directory();
      if (!owned) { await absent(); return; } // No acquisition occurred; never adopt an existing marker.
      need(epoch === owned.epoch);
      if (!removed) {
        const observed = await fsp.lstat(target);
        need(observed.isFile() && !observed.isSymbolicLink() && observed.nlink === 1 && sameIdentity(observed, owned.identity));
        if (!testOnly) need(observed.uid === uid && (observed.mode & 0o777) === 0o600);
        need(observed.size === owned.bytes.length);
        const handle = await fsp.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const bytes = Buffer.alloc(owned.bytes.length + 1);
        try {
          need(sameIdentity(observed, await handle.stat()));
          const result = await handle.read(bytes, 0, bytes.length, 0);
          need(result.bytesRead === owned.bytes.length && bytes.subarray(0, result.bytesRead).equals(owned.bytes));
          const latest = await fsp.lstat(target);
          need(sameIdentity(latest, observed) && latest.size === observed.size && latest.mtimeMs === observed.mtimeMs && latest.ctimeMs === observed.ctimeMs);
        } finally { bytes.fill(0); await handle.close(); }
        await fsp.unlink(target);
        removed = true;
      } else await absent();
      // If this barrier fails, keep bookkeeping and admission closed. The SAME
      // owner can retry absence+barrier; another process cannot remove/adopt it.
      await barrier();
      owned.bytes.fill(0);
      owned = null;
      removed = false;
    } catch (_) { fail(); }
  }
  return Object.freeze({ acquire, release, held: () => owned !== null });
}

module.exports = { assertNoUnfinishedPause, createPauseMarker, MARKER_NAME };
