"use strict";

const path = require("node:path");
const {
  HarnessFailure
} = require("./social-3a0p-local-harness-core");

const BUNDLE_PROFILES = Object.freeze([
  "social-schema-0003",
  "social-schema-0004"
]);
const SHA256 = /^[0-9a-f]{64}$/;

function fail(code) {
  throw new HarnessFailure(code);
}

function isPlainObject(value) {
  return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requirePositiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}

function metricSuffix(profile) {
  return profile === "social-schema-0003" ? "0003" : "0004";
}

function normalizeBundleDescriptor(bundle) {
  if (!isPlainObject(bundle) || !BUNDLE_PROFILES.includes(bundle.profile)) {
    fail("harness_bundle_profile_invalid");
  }
  if (
    typeof bundle.path !== "string" ||
    !path.isAbsolute(bundle.path) ||
    bundle.path.includes("\0")
  ) {
    fail("harness_bundle_path_invalid");
  }
  return Object.freeze({
    profile: bundle.profile,
    path: path.resolve(bundle.path),
    tableCount: requirePositiveInteger(
      bundle.tableCount,
      "harness_bundle_table_count_invalid"
    ),
    rlsPolicyCount: requirePositiveInteger(
      bundle.rlsPolicyCount,
      "harness_bundle_rls_policy_count_invalid"
    ),
    restoreApproved: bundle.restoreApproved === true
  });
}

function normalizeMeasuredBundle(bundle) {
  if (!isPlainObject(bundle) || !BUNDLE_PROFILES.includes(bundle.profile)) {
    fail("harness_bundle_profile_invalid");
  }
  if (!Number.isSafeInteger(bundle.size) || bundle.size < 1) {
    fail("harness_bundle_stat_invalid");
  }
  if (typeof bundle.sha256 !== "string" || !SHA256.test(bundle.sha256)) {
    fail("harness_bundle_sha256_invalid");
  }
  return Object.freeze({
    profile: bundle.profile,
    size: bundle.size,
    sha256: bundle.sha256,
    tableCount: requirePositiveInteger(
      bundle.tableCount,
      "harness_bundle_table_count_invalid"
    ),
    rlsPolicyCount: requirePositiveInteger(
      bundle.rlsPolicyCount,
      "harness_bundle_rls_policy_count_invalid"
    ),
    restoreApproved: bundle.restoreApproved === true
  });
}

function collectMeasuredBundleMetrics({ bundles } = {}) {
  if (!Array.isArray(bundles) || bundles.length !== BUNDLE_PROFILES.length) {
    fail("harness_bundle_metrics_configuration_invalid");
  }
  const byProfile = new Map();
  for (const raw of bundles) {
    const bundle = normalizeMeasuredBundle(raw);
    if (byProfile.has(bundle.profile)) fail("harness_bundle_profile_duplicate");
    byProfile.set(bundle.profile, bundle);
  }
  if (BUNDLE_PROFILES.some((profile) => !byProfile.has(profile))) {
    fail("harness_bundle_profile_missing");
  }

  const counts = {};
  const hashes = {};
  const checks = {};
  for (const profile of BUNDLE_PROFILES) {
    const bundle = byProfile.get(profile);
    const suffix = metricSuffix(profile);
    counts[`bundle${suffix}Bytes`] = bundle.size;
    counts[`bundle${suffix}Tables`] = bundle.tableCount;
    counts[`bundle${suffix}RlsPolicies`] = bundle.rlsPolicyCount;
    hashes[`bundle${suffix}Sha256`] = bundle.sha256;
    checks[`bundle${suffix}RestoreApproved`] = bundle.restoreApproved;
  }
  return Object.freeze({
    code: "bundle_metrics_collected",
    counts: Object.freeze(counts),
    hashes: Object.freeze(hashes),
    checks: Object.freeze(checks),
    inventory: BUNDLE_PROFILES
  });
}

async function collectBundleMetrics({
  bundles,
  statFile,
  sha256File
} = {}) {
  if (
    !Array.isArray(bundles) ||
    bundles.length !== BUNDLE_PROFILES.length ||
    typeof statFile !== "function" ||
    typeof sha256File !== "function"
  ) {
    fail("harness_bundle_metrics_configuration_invalid");
  }
  const normalized = bundles.map(normalizeBundleDescriptor);
  const byProfile = new Map();
  for (const bundle of normalized) {
    if (byProfile.has(bundle.profile)) fail("harness_bundle_profile_duplicate");
    byProfile.set(bundle.profile, bundle);
  }
  if (BUNDLE_PROFILES.some((profile) => !byProfile.has(profile))) {
    fail("harness_bundle_profile_missing");
  }

  const measured = [];
  for (const profile of BUNDLE_PROFILES) {
    const bundle = byProfile.get(profile);
    let stat;
    let sha256;
    try {
      stat = await statFile(bundle.path);
      sha256 = await sha256File(bundle.path);
    } catch {
      fail("harness_bundle_measurement_failed");
    }
    if (
      !isPlainObject(stat) ||
      stat.isFile !== true ||
      stat.reparsePoint !== false ||
      !Number.isSafeInteger(stat.size) ||
      stat.size < 1
    ) {
      fail("harness_bundle_stat_invalid");
    }
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
      fail("harness_bundle_sha256_invalid");
    }
    measured.push({
      profile,
      size: stat.size,
      sha256,
      tableCount: bundle.tableCount,
      rlsPolicyCount: bundle.rlsPolicyCount,
      restoreApproved: bundle.restoreApproved
    });
  }
  return collectMeasuredBundleMetrics({ bundles: measured });
}

function assertBundleMetricsSafe(result) {
  if (
    !isPlainObject(result) ||
    result.code !== "bundle_metrics_collected" ||
    !Array.isArray(result.inventory) ||
    result.inventory.length !== BUNDLE_PROFILES.length ||
    result.inventory.some((profile, index) => profile !== BUNDLE_PROFILES[index]) ||
    !isPlainObject(result.counts) ||
    [
      result.counts.bundle0003Bytes,
      result.counts.bundle0003Tables,
      result.counts.bundle0003RlsPolicies,
      result.counts.bundle0004Bytes,
      result.counts.bundle0004Tables,
      result.counts.bundle0004RlsPolicies
    ].some((value) => !Number.isSafeInteger(value) || value < 1) ||
    !isPlainObject(result.checks) ||
    result.checks.bundle0003RestoreApproved !== true ||
    result.checks.bundle0004RestoreApproved !== true
  ) {
    fail("harness_bundle_restore_not_approved");
  }
  if (
    !isPlainObject(result.hashes) ||
    typeof result.hashes.bundle0003Sha256 !== "string" ||
    !SHA256.test(result.hashes.bundle0003Sha256) ||
    typeof result.hashes.bundle0004Sha256 !== "string" ||
    !SHA256.test(result.hashes.bundle0004Sha256)
  ) {
    fail("harness_bundle_individual_hashes_invalid");
  }
  return true;
}

async function collectDataChecksumsMetric({ readSetting } = {}) {
  if (typeof readSetting !== "function") {
    fail("harness_data_checksums_probe_missing");
  }
  let raw;
  try {
    raw = await readSetting();
  } catch {
    fail("harness_data_checksums_probe_failed");
  }
  if (raw !== "on" && raw !== "off" && raw !== true && raw !== false) {
    fail("harness_data_checksums_value_invalid");
  }
  const enabled = raw === "on" || raw === true;
  return Object.freeze({
    code: "data_checksums_metric_collected",
    checks: Object.freeze({ dataChecksumsEnabled: enabled })
  });
}

function assertDataChecksumsEnabled(result) {
  if (
    !isPlainObject(result) ||
    !isPlainObject(result.checks) ||
    result.checks.dataChecksumsEnabled !== true
  ) {
    fail("harness_data_checksums_disabled");
  }
  return true;
}

module.exports = {
  BUNDLE_PROFILES,
  assertBundleMetricsSafe,
  assertDataChecksumsEnabled,
  collectBundleMetrics,
  collectMeasuredBundleMetrics,
  collectDataChecksumsMetric
};
