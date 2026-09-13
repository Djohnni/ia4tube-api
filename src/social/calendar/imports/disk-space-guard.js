"use strict";

const fs = require("node:fs/promises"), path = require("node:path");
const DEFAULT_MARGIN_BYTES = 1024 ** 3, DEFAULT_MAX_EVIDENCE_AGE_MS = 1000;
const guards = new WeakMap(), evidenceTokens = new WeakSet(), evidenceDetails = new WeakMap();
function fail(code) { throw Object.assign(new Error(`disk_space_${code}`), { code: `disk_space_${code}` }); }
function integer(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum; }
function makeGuard(options, testOnly, statfs, monotonicClock) {
  const { rootDirectory, enabled = false, marginBytes = DEFAULT_MARGIN_BYTES,
    maxEvidenceAgeMs = DEFAULT_MAX_EVIDENCE_AGE_MS } = options;
  if (!path.isAbsolute(rootDirectory || "") || typeof enabled !== "boolean" || !integer(marginBytes) ||
      !integer(maxEvidenceAgeMs, 1) || maxEvidenceAgeMs > DEFAULT_MAX_EVIDENCE_AGE_MS ||
      typeof statfs !== "function" || typeof monotonicClock !== "function") fail("configuration_invalid");
  const root = path.resolve(rootDirectory);
  if (root === path.parse(root).root) fail("root_unsafe");
  function monotonicNow() {
    const value = monotonicClock();
    if (typeof value !== "bigint" || value < 0n) fail("clock_invalid");
    return value;
  }
  async function rootIdentity() {
    const value = await fs.lstat(root, { bigint: true });
    if (!value.isDirectory() || value.isSymbolicLink() || path.resolve(await fs.realpath(root)) !== root ||
        process.platform !== "win32" && ((value.mode & 0o077n) !== 0n || typeof process.getuid === "function" && value.uid !== BigInt(process.getuid()))) fail("root_unsafe");
    return { dev: value.dev, ino: value.ino };
  }
  const guard = Object.freeze({
    capabilities: Object.freeze({ available: enabled, testOnly, physicalFreeSpaceObservation: true,
      operatingSystemQuota: false, financialHardCap: false, marginBytes, maxEvidenceAgeMs }),
    async sample() {
      if (!enabled) fail("guard_disabled");
      try {
        const before = await rootIdentity(), observedAt = monotonicNow();
        const stats = await statfs(root, { bigint: true });
        const after = await rootIdentity();
        if (before.dev !== after.dev || before.ino !== after.ino) fail("root_changed");
        if (!stats || typeof stats.bavail !== "bigint" || typeof stats.bsize !== "bigint" || stats.bavail < 0n || stats.bsize < 1n) fail("stats_invalid");
        const freeBytes = stats.bavail * stats.bsize, maximum = freeBytes > BigInt(marginBytes) ? freeBytes - BigInt(marginBytes) : 0n;
        if (maximum > BigInt(Number.MAX_SAFE_INTEGER)) fail("stats_invalid");
        const token = Object.freeze(Object.create(null));
        evidenceTokens.add(token);
        evidenceDetails.set(token, { issuer: guard, observedAt, maximumHeldBytes: Number(maximum) });
        // An observation delayed during statfs/directory checks is already stale.
        assertDiskSpaceEvidence(token, { guard, allowVolatileForTests: testOnly });
        return token;
      } catch (error) {
        if (/^disk_space_[a-z_]{1,64}$/.test(error?.code || "")) fail(error.code.slice("disk_space_".length));
        fail("unavailable");
      }
    }
  });
  guards.set(guard, { root, enabled, testOnly, maxEvidenceAgeMs, monotonicNow });
  return guard;
}
function createDiskSpaceGuard(options = {}) {
  if (!options || Object.keys(options).some(key => !["rootDirectory", "enabled", "marginBytes", "maxEvidenceAgeMs"].includes(key))) fail("configuration_invalid");
  return makeGuard(options, false, (...args) => fs.statfs(...args), () => process.hrtime.bigint());
}
function createDiskSpaceGuardForTests({ statfsForTests, monotonicClockForTests = () => process.hrtime.bigint(), ...options } = {}) {
  if (Object.keys(options).some(key => !["rootDirectory", "enabled", "marginBytes", "maxEvidenceAgeMs"].includes(key))) fail("configuration_invalid");
  return makeGuard(options, true, statfsForTests, monotonicClockForTests);
}
function isDiskSpaceGuard(guard, { rootDirectory, allowVolatileForTests = false } = {}) {
  const record = guards.get(guard);
  return Boolean(record && record.enabled && (!record.testOnly || allowVolatileForTests) &&
    (rootDirectory === undefined || path.isAbsolute(rootDirectory || "") && path.resolve(rootDirectory) === record.root));
}
function assertDiskSpaceEvidence(token, { guard, allowVolatileForTests = false } = {}) {
  if (!isDiskSpaceGuard(guard, { allowVolatileForTests }) || !evidenceTokens.has(token)) fail("evidence_invalid");
  const record = guards.get(guard), details = evidenceDetails.get(token);
  if (!details || details.issuer !== guard || !integer(details.maximumHeldBytes)) fail("evidence_invalid");
  const age = record.monotonicNow() - details.observedAt;
  if (age < 0n || age > BigInt(record.maxEvidenceAgeMs) * 1000000n) fail("evidence_stale");
  return details.maximumHeldBytes;
}

module.exports = { createDiskSpaceGuard, createDiskSpaceGuardForTests, isDiskSpaceGuard, assertDiskSpaceEvidence,
  DEFAULT_MARGIN_BYTES, DEFAULT_MAX_EVIDENCE_AGE_MS };
