"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  HarnessFailure,
  validatePhaseResult
} = require("../scripts/social-3a0p-local-harness-core");
const {
  assertBundleMetricsSafe,
  assertDataChecksumsEnabled,
  collectBundleMetrics,
  collectMeasuredBundleMetrics,
  collectDataChecksumsMetric
} = require("../scripts/social-3a0p-local-bundle-cluster-metrics");

const BUNDLE_0003 = path.resolve("C:\\synthetic\\social-schema-0003.ia4sb");
const BUNDLE_0004 = path.resolve("C:\\synthetic\\social-schema-0004.ia4sb");
const HASH_0003 = "3".repeat(64);
const HASH_0004 = "4".repeat(64);

function expectCode(code) {
  return (error) => error instanceof HarnessFailure && error.code === code;
}

function descriptors(overrides = {}) {
  return [
    {
      profile: "social-schema-0003",
      path: BUNDLE_0003,
      tableCount: 6,
      rlsPolicyCount: 8,
      restoreApproved: true,
      ...overrides.profile0003
    },
    {
      profile: "social-schema-0004",
      path: BUNDLE_0004,
      tableCount: 7,
      rlsPolicyCount: 10,
      restoreApproved: true,
      ...overrides.profile0004
    }
  ];
}

function dependencies(overrides = {}) {
  const sizes = new Map([
    [BUNDLE_0003, 12_003],
    [BUNDLE_0004, 14_004]
  ]);
  const hashes = new Map([
    [BUNDLE_0003, HASH_0003],
    [BUNDLE_0004, HASH_0004]
  ]);
  return {
    statFile: async (file) => ({
      isFile: true,
      reparsePoint: false,
      size: sizes.get(file)
    }),
    sha256File: async (file) => hashes.get(file),
    ...overrides
  };
}

test("two bundles retain individual sizes, hashes and restore evidence", async () => {
  const measured = [];
  const base = dependencies();
  const result = await collectBundleMetrics({
    bundles: descriptors(),
    statFile: async (file) => {
      measured.push(["stat", file]);
      return base.statFile(file);
    },
    sha256File: async (file) => {
      measured.push(["hash", file]);
      return base.sha256File(file);
    }
  });

  assert.deepEqual(result.counts, {
    bundle0003Bytes: 12_003,
    bundle0003Tables: 6,
    bundle0003RlsPolicies: 8,
    bundle0004Bytes: 14_004,
    bundle0004Tables: 7,
    bundle0004RlsPolicies: 10
  });
  assert.deepEqual(result.hashes, {
    bundle0003Sha256: HASH_0003,
    bundle0004Sha256: HASH_0004
  });
  assert.deepEqual(result.checks, {
    bundle0003RestoreApproved: true,
    bundle0004RestoreApproved: true
  });
  assert.deepEqual(measured, [
    ["stat", BUNDLE_0003],
    ["hash", BUNDLE_0003],
    ["stat", BUNDLE_0004],
    ["hash", BUNDLE_0004]
  ]);
  assert.equal(assertBundleMetricsSafe(result), true);
  assert.equal(validatePhaseResult(result).code, "bundle_metrics_collected");
});

test("bundle order does not collapse the two individual profiles", async () => {
  const result = await collectBundleMetrics({
    bundles: descriptors().reverse(),
    ...dependencies()
  });
  assert.equal(result.counts.bundle0003Bytes, 12_003);
  assert.equal(result.counts.bundle0004Bytes, 14_004);
  assert.equal(result.hashes.bundle0003Sha256, HASH_0003);
  assert.equal(result.hashes.bundle0004Sha256, HASH_0004);
});

test("physical measured output uses the same hardened two-profile contract", () => {
  const result = collectMeasuredBundleMetrics({
    bundles: [
      {
        profile: "social-schema-0004",
        size: 14_004,
        sha256: HASH_0004,
        tableCount: 7,
        rlsPolicyCount: 10,
        restoreApproved: true
      },
      {
        profile: "social-schema-0003",
        size: 12_003,
        sha256: HASH_0003,
        tableCount: 6,
        rlsPolicyCount: 8,
        restoreApproved: true
      }
    ]
  });
  assert.equal(assertBundleMetricsSafe(result), true);
  assert.equal(result.counts.bundle0003Bytes, 12_003);
  assert.equal(result.hashes.bundle0004Sha256, HASH_0004);
});

test("physical measured output refuses duplicate profiles and malformed evidence", () => {
  assert.throws(
    () => collectMeasuredBundleMetrics({
      bundles: [
        { profile: "social-schema-0003", size: 1, sha256: HASH_0003, tableCount: 1, rlsPolicyCount: 1, restoreApproved: true },
        { profile: "social-schema-0003", size: 2, sha256: HASH_0004, tableCount: 1, rlsPolicyCount: 1, restoreApproved: true }
      ]
    }),
    expectCode("harness_bundle_profile_duplicate")
  );
  assert.throws(
    () => collectMeasuredBundleMetrics({
      bundles: [
        { profile: "social-schema-0003", size: 1, sha256: HASH_0003, tableCount: 1, rlsPolicyCount: 1, restoreApproved: true },
        { profile: "social-schema-0004", size: 2, sha256: "broken", tableCount: 1, rlsPolicyCount: 1, restoreApproved: true }
      ]
    }),
    expectCode("harness_bundle_sha256_invalid")
  );
});

test("final bundle assertion refuses missing counts or incomplete inventory", () => {
  const valid = collectMeasuredBundleMetrics({
    bundles: [
      { profile: "social-schema-0003", size: 1, sha256: HASH_0003, tableCount: 1, rlsPolicyCount: 1, restoreApproved: true },
      { profile: "social-schema-0004", size: 2, sha256: HASH_0004, tableCount: 1, rlsPolicyCount: 1, restoreApproved: true }
    ]
  });
  assert.throws(
    () => assertBundleMetricsSafe({ ...valid, counts: {} }),
    expectCode("harness_bundle_restore_not_approved")
  );
  assert.throws(
    () => assertBundleMetricsSafe({ ...valid, inventory: ["social-schema-0003"] }),
    expectCode("harness_bundle_restore_not_approved")
  );
});

test("duplicate or missing profile is refused before file measurement", async () => {
  let measured = false;
  const repeated = descriptors();
  repeated[1] = { ...repeated[0], path: BUNDLE_0004 };
  await assert.rejects(
    collectBundleMetrics({
      bundles: repeated,
      statFile: async () => {
        measured = true;
        return { isFile: true, reparsePoint: false, size: 1 };
      },
      sha256File: async () => HASH_0003
    }),
    expectCode("harness_bundle_profile_duplicate")
  );
  assert.equal(measured, false);
});

test("reparse point and malformed SHA-256 are refused", async () => {
  await assert.rejects(
    collectBundleMetrics({
      bundles: descriptors(),
      ...dependencies({
        statFile: async () => ({ isFile: true, reparsePoint: true, size: 4_096 })
      })
    }),
    expectCode("harness_bundle_stat_invalid")
  );
  await assert.rejects(
    collectBundleMetrics({
      bundles: descriptors(),
      ...dependencies({ sha256File: async () => "not-a-sha256" })
    }),
    expectCode("harness_bundle_sha256_invalid")
  );
});

test("restore result remains evidence and a failed restore blocks the gate", async () => {
  const result = await collectBundleMetrics({
    bundles: descriptors({ profile0004: { restoreApproved: false } }),
    ...dependencies()
  });
  assert.equal(result.checks.bundle0004RestoreApproved, false);
  assert.throws(
    () => assertBundleMetricsSafe(result),
    expectCode("harness_bundle_restore_not_approved")
  );
});

test("data checksums on and off are both recorded, but off fails the gate", async () => {
  const enabled = await collectDataChecksumsMetric({
    readSetting: async () => "on"
  });
  assert.deepEqual(enabled.checks, { dataChecksumsEnabled: true });
  assert.equal(assertDataChecksumsEnabled(enabled), true);
  assert.equal(
    validatePhaseResult(enabled).code,
    "data_checksums_metric_collected"
  );

  const disabled = await collectDataChecksumsMetric({
    readSetting: async () => "off"
  });
  assert.deepEqual(disabled.checks, { dataChecksumsEnabled: false });
  assert.throws(
    () => assertDataChecksumsEnabled(disabled),
    expectCode("harness_data_checksums_disabled")
  );
});

test("data checksums probe rejects ambiguous values and sanitizes failures", async () => {
  await assert.rejects(
    collectDataChecksumsMetric({ readSetting: async () => "enabled" }),
    expectCode("harness_data_checksums_value_invalid")
  );
  await assert.rejects(
    collectDataChecksumsMetric({
      readSetting: async () => {
        const sensitive = [
          "post",
          "gresql",
          "://",
          "synthetic-user",
          ":",
          "sensitive-value",
          "@example.invalid/db"
        ].join("");
        throw new Error(sensitive);
      }
    }),
    (error) => {
      assert.equal(error.code, "harness_data_checksums_probe_failed");
      assert.doesNotMatch(error.message, /postgresql|sensitive-value|example/);
      return true;
    }
  );
});
