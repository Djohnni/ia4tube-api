"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  completePhysicalEvidence,
  executionCodeManifest,
  hashStableCodeFile,
  loadExecutionIdentity,
  startPhysicalEvidence
} = require("../src/persistence/postgres/physical-gate-evidence");
const {
  PAID_STAGING_PUBLIC_TARGET
} = require("../src/persistence/postgres/staging-provisioner");

const RUN_ID = "12345678-1234-4abc-8def-1234567890ab";
const COMMIT = "3204e876401175c37f028eaa8ebbff90c5c909f9";
const TARGET_FINGERPRINT = "a".repeat(64);
const CURRENT_MANIFEST = executionCodeManifest();

function environment(overrides = {}) {
  return {
    SOCIAL_2B_EVIDENCE_RUN_ID: RUN_ID,
    SOCIAL_2B_EVIDENCE_COMMIT: COMMIT,
    RENDER_GIT_COMMIT: COMMIT,
    SOCIAL_2B_EVIDENCE_EXPECTED_CODE_MANIFEST_SHA256:
      CURRENT_MANIFEST.sha256,
    SOCIAL_2B_EVIDENCE_EXPECTED_CODE_MANIFEST_FILE_COUNT:
      String(CURRENT_MANIFEST.fileCount),
    ...overrides
  };
}

test("code manifest canonicalizes CRLF and rejects ambiguous CR bytes", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-code-manifest-")
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lf = path.join(directory, "lf.js");
  const crlf = path.join(directory, "crlf.js");
  const ambiguous = path.join(directory, "ambiguous.js");
  fs.writeFileSync(lf, "\"use strict\";\nconst value = 1;\n", "utf8");
  fs.writeFileSync(
    crlf,
    "\"use strict\";\r\nconst value = 1;\r\n",
    "utf8"
  );
  fs.writeFileSync(ambiguous, "\"use strict\";\rconst value = 1;\n", "utf8");
  assert.deepEqual(hashStableCodeFile(lf), hashStableCodeFile(crlf));
  assert.throws(
    () => hashStableCodeFile(ambiguous),
    { code: "physical_evidence_code_line_ending_invalid" }
  );
});

test("execution identity binds the Render commit to a stable code manifest", () => {
  const firstManifest = executionCodeManifest();
  const secondManifest = executionCodeManifest();
  assert.deepEqual(firstManifest, secondManifest);
  assert.deepEqual(firstManifest, CURRENT_MANIFEST);
  assert.match(firstManifest.sha256, /^[0-9a-f]{64}$/);
  assert.ok(firstManifest.fileCount > 20);

  const identity = loadExecutionIdentity(environment());
  assert.deepEqual(identity, {
    runId: RUN_ID,
    commit: COMMIT,
    renderCommitVerified: true,
    codeManifestSha256: firstManifest.sha256,
    codeManifestFileCount: firstManifest.fileCount,
    environment: "staging",
    environmentId: PAID_STAGING_PUBLIC_TARGET.environmentId,
    region: "oregon"
  });
});

test("a mismatched or malformed execution identity is refused", () => {
  assert.throws(
    () =>
      loadExecutionIdentity(
        environment({ RENDER_GIT_COMMIT: "f".repeat(40) })
      ),
    { code: "physical_evidence_render_commit_mismatch" }
  );
  assert.throws(
    () =>
      loadExecutionIdentity(
        environment({ SOCIAL_2B_EVIDENCE_RUN_ID: "not-a-uuid" })
      ),
    { code: "physical_evidence_run_id_invalid" }
  );
  assert.throws(
    () =>
      loadExecutionIdentity(
        environment({ SOCIAL_2B_EVIDENCE_COMMIT: "short" })
      ),
    { code: "physical_evidence_commit_invalid" }
  );
  assert.throws(
    () =>
      loadExecutionIdentity(
        environment({
          SOCIAL_2B_EVIDENCE_EXPECTED_CODE_MANIFEST_SHA256:
            "f".repeat(64)
        })
      ),
    { code: "physical_evidence_code_manifest_mismatch" }
  );
  assert.throws(
    () =>
      loadExecutionIdentity(
        environment({
          SOCIAL_2B_EVIDENCE_EXPECTED_CODE_MANIFEST_FILE_COUNT: "9999"
        })
      ),
    { code: "physical_evidence_code_manifest_mismatch" }
  );
});

test("step evidence binds sequence, target and monotonic timestamps", () => {
  const identity = Object.freeze({
    runId: RUN_ID,
    commit: COMMIT,
    renderCommitVerified: true,
    codeManifestSha256: "b".repeat(64),
    codeManifestFileCount: 42,
    environment: "staging",
    environmentId: PAID_STAGING_PUBLIC_TARGET.environmentId,
    region: "oregon"
  });
  const started = startPhysicalEvidence({
    identity,
    sequence: 1,
    databasePurpose: "primary-backup",
    databaseName: PAID_STAGING_PUBLIC_TARGET.database,
    targetFingerprint: TARGET_FINGERPRINT,
    now: () => new Date("2026-07-31T12:00:00.000Z")
  });
  const completed = completePhysicalEvidence(
    started,
    () => new Date("2026-07-31T12:01:00.000Z"),
    {
      manifestLoader: () => ({
        sha256: identity.codeManifestSha256,
        fileCount: identity.codeManifestFileCount
      })
    }
  );
  assert.equal(completed.startedAt, "2026-07-31T12:00:00.000Z");
  assert.equal(completed.completedAt, "2026-07-31T12:01:00.000Z");
  assert.equal(completed.targetFingerprint, TARGET_FINGERPRINT);

  assert.throws(
    () =>
      completePhysicalEvidence(
        started,
        () => new Date("2026-07-31T11:59:59.000Z"),
        {
          manifestLoader: () => ({
            sha256: identity.codeManifestSha256,
            fileCount: identity.codeManifestFileCount
          })
        }
      ),
    { code: "physical_evidence_time_order_invalid" }
  );
  assert.throws(
    () =>
      completePhysicalEvidence(started, undefined, {
        manifestLoader: () => ({
          sha256: "f".repeat(64),
          fileCount: identity.codeManifestFileCount
        })
      }),
    { code: "physical_evidence_code_changed_during_step" }
  );
  assert.throws(
    () =>
      startPhysicalEvidence({
        identity,
        sequence: 5,
        databasePurpose: "primary-backup",
        databaseName: PAID_STAGING_PUBLIC_TARGET.database,
        targetFingerprint: TARGET_FINGERPRINT
      }),
    { code: "physical_evidence_step_identity_invalid" }
  );
});
