"use strict";

// Operator-only entry point. It is not imported by server.js and accepts no
// credentials. Inputs are the already-sanitized gate results and the
// encrypted backup bundle.
const {
  createDurableEvidenceReport
} = require(
  "../src/persistence/postgres/durable-evidence-report"
);
const {
  loadExecutionIdentity
} = require("../src/persistence/postgres/physical-gate-evidence");

const SAFE_CODE = /^[a-z0-9_]{3,96}$/;

function writePayload(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

async function main({
  env = process.env,
  argv = process.argv.slice(2),
  platform = process.platform,
  stdout = process.stdout,
  stderr = process.stderr,
  createReport = createDurableEvidenceReport,
  loadIdentity = loadExecutionIdentity
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    writePayload(stderr, {
      ok: false,
      code: "social_evidence_argv_refused"
    });
    return 2;
  }
  if (platform !== "linux") {
    writePayload(stderr, {
      ok: false,
      code: "social_evidence_linux_required"
    });
    return 1;
  }
  try {
    const currentIdentity = loadIdentity(env);
    const result = createReport({
      backupFile: env.SOCIAL_2B_EVIDENCE_BACKUP_FILE,
      createFile: env.SOCIAL_2B_EVIDENCE_CREATE_FILE,
      restoreFile: env.SOCIAL_2B_EVIDENCE_RESTORE_FILE,
      dropFile: env.SOCIAL_2B_EVIDENCE_DROP_FILE,
      bundleFile: env.SOCIAL_2B_EVIDENCE_BUNDLE_FILE,
      reportFile: env.SOCIAL_2B_EVIDENCE_REPORT_FILE,
      currentIdentity
    });
    const publication = result?.publication;
    if (
      !publication ||
      !/^[0-9a-f]{64}$/.test(
        String(publication.reportSha256 || "")
      ) ||
      publication.reportFileFsyncConfirmed !== true ||
      publication.reportDirectoryFsyncConfirmed !== true ||
      publication.sidecarFileFsyncConfirmed !== true ||
      publication.sidecarDirectoryFsyncConfirmed !== true ||
      publication.finalReportHashVerified !== true ||
      publication.finalBundleHashVerified !== true
    ) {
      const error = new Error("social_evidence_publication_unconfirmed");
      error.code = "social_evidence_publication_unconfirmed";
      throw error;
    }
    writePayload(stdout, {
      ok: true,
      reportSha256: publication.reportSha256,
      reportFileFsyncConfirmed: true,
      reportDirectoryFsyncConfirmed: true,
      sidecarFileFsyncConfirmed: true,
      sidecarDirectoryFsyncConfirmed: true,
      finalReportHashVerified: true,
      finalBundleHashVerified: true
    });
    return 0;
  } catch (error) {
    const code = SAFE_CODE.test(String(error?.code || ""))
      ? error.code
      : "social_evidence_report_failed";
    writePayload(stderr, { ok: false, code });
    return 1;
  }
}

if (require.main === module) {
  main().then((status) => {
    process.exitCode = status;
  });
}

module.exports = { main };
