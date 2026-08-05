"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  PHYSICAL_APPROVAL,
  REQUIRED_POSTGRES_VERSION,
  commandLineEntry,
  controllerContract,
  runLocalPhysicalHarness
} = require("../scripts/social-3a0p-local-physical-harness");
const {
  PHASES
} = require("../scripts/social-3a0p-local-harness-core");

function packageDescriptor(overrides = {}) {
  return {
    archivePath: path.resolve("synthetic-postgresql-18.4.zip"),
    expectedSha256: "a".repeat(64),
    version: REQUIRED_POSTGRES_VERSION,
    ...overrides
  };
}

function adapters(events = [], overrides = {}) {
  const phase = (name) => async () => {
    events.push(name);
    return { code: "adapter_approved", checks: { approved: true } };
  };
  return {
    preflight: phase("preflight"),
    validatePackage: phase("validate-package"),
    extractPackage: phase("extract-package"),
    initializeCluster: phase("initialize-cluster"),
    startCluster: phase("start-cluster"),
    async createReadinessProbes() {
      events.push("wait-for-readiness");
      return {
        pid: 4242,
        probes: {
          processAlive: async () => true,
          listeners: async () => [
            { address: "127.0.0.1", port: 64995, pid: 4242 }
          ],
          pgIsReady: async () => true,
          openAdminSession: async () => ({
            selectOne: async () => 1,
            serverVersion: async () => "18.4",
            close: async () => true
          })
        }
      };
    },
    bootstrapRoles: phase("bootstrap-roles"),
    establishDpapiCustody: phase("establish-dpapi-custody"),
    runMigrationGate: phase("run-migration-gate"),
    runRlsGate: phase("run-rls-gate"),
    runConcurrencyGate: phase("run-concurrency-gate"),
    runVaultGate: phase("run-vault-gate"),
    runBackupRestoreGate: phase("run-backup-restore-gate"),
    collectSanitizedEvidence: phase("collect-sanitized-evidence"),
    cleanup: phase("cleanup"),
    finalizeSanitizedEvidence: () => ({
      code: "windows_evidence_finalized",
      checks: {
        closedReportApproved: true,
        canonicalEvidenceCreated: true,
        pendingEvidenceRemoved: true
      }
    }),
    terminateProcessTree: async () => true,
    ...overrides
  };
}

function options(overrides = {}) {
  return {
    approval: PHYSICAL_APPROVAL,
    packageDescriptor: packageDescriptor(),
    target: { host: "127.0.0.1", port: 64995 },
    adapters: adapters(),
    ...overrides
  };
}

test("controller refuses execution without the exact approval", () => {
  let invoked = false;
  const configured = options({
    approval: "",
    adapters: adapters([], {
      preflight: async () => {
        invoked = true;
      }
    })
  });
  assert.throws(
    () => controllerContract(configured),
    { code: "harness_explicit_approval_missing" }
  );
  assert.equal(invoked, false);
});

test("controller refuses a package other than PostgreSQL 18.4", () => {
  assert.throws(
    () =>
      controllerContract(
        options({ packageDescriptor: packageDescriptor({ version: "18.3" }) })
      ),
    { code: "harness_postgres_version_mismatch" }
  );
});

test("controller requires an absolute archive and a canonical SHA-256", () => {
  assert.throws(
    () =>
      controllerContract(
        options({
          packageDescriptor: packageDescriptor({ archivePath: "relative.zip" })
        })
      ),
    { code: "harness_package_path_invalid" }
  );
  assert.throws(
    () =>
      controllerContract(
        options({
          packageDescriptor: packageDescriptor({ expectedSha256: "invalid" })
        })
      ),
    { code: "harness_package_sha256_invalid" }
  );
});

test("controller accepts only the exact IPv4 loopback target", () => {
  assert.throws(
    () =>
      controllerContract(
        options({ target: { host: "db.example.invalid", port: 5432 } })
      ),
    { code: "harness_loopback_host_refused" }
  );
});

test("controller refuses download and network adapters", () => {
  assert.throws(
    () =>
      controllerContract(
        options({
          adapters: adapters([], { downloadPackage: async () => true })
        })
      ),
    { code: "harness_network_adapter_refused" }
  );
});

test("controller wires all fifteen phases in deterministic order", async () => {
  const events = [];
  const report = await runLocalPhysicalHarness(
    options({ adapters: adapters(events) })
  );
  assert.equal(report.ok, true);
  assert.deepEqual(events, PHASES);
  assert.deepEqual(
    report.phases.map((item) => item.phase),
    PHASES
  );
});

test("canonical evidence finalization runs only after the cleanup report is closed", async () => {
  const events = [];
  let observedReport;
  const configuredAdapters = adapters(events, {
    finalizeSanitizedEvidence({ report }) {
      events.push("finalize-after-report");
      observedReport = report;
      return {
        code: "windows_evidence_finalized",
        checks: {
          closedReportApproved: true,
          canonicalEvidenceCreated: true,
          pendingEvidenceRemoved: true
        }
      };
    }
  });
  const report = await runLocalPhysicalHarness(
    options({ adapters: configuredAdapters })
  );
  assert.equal(observedReport, report);
  assert.equal(report.ok, true);
  assert.equal(report.phases.at(-1).phase, "cleanup");
  assert.equal(report.phases.at(-1).status, "passed");
  assert.equal(events.at(-2), "cleanup");
  assert.equal(events.at(-1), "finalize-after-report");
});

test("an asynchronous evidence finalizer is refused", async () => {
  await assert.rejects(
    runLocalPhysicalHarness(options({
      adapters: adapters([], {
        finalizeSanitizedEvidence: async () => ({
          code: "windows_evidence_finalized",
          checks: {
            closedReportApproved: true,
            canonicalEvidenceCreated: true,
            pendingEvidenceRemoved: true
          }
        })
      })
    })),
    { code: "harness_evidence_finalizer_async_refused" }
  );
});

test("cleanup timeout never invokes canonical evidence finalization", async () => {
  let finalized = false;
  await assert.rejects(
    runLocalPhysicalHarness(options({
      timeouts: { cleanup: 5 },
      adapters: adapters([], {
        cleanup: async ({ signal }) => new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({
            code: "cleanup_aborted",
            checks: { sanitizedEvidencePrepared: true }
          }), { once: true });
        }),
        finalizeSanitizedEvidence() {
          finalized = true;
          return {
            code: "windows_evidence_finalized",
            checks: {
              closedReportApproved: true,
              canonicalEvidenceCreated: true,
              pendingEvidenceRemoved: true
            }
          };
        }
      })
    })),
    { code: "cleanup_timeout" }
  );
  assert.equal(finalized, false);
});

test("controller readiness requires PostgreSQL 18.4", async () => {
  const events = [];
  await assert.rejects(
    runLocalPhysicalHarness(
      options({
        adapters: adapters(events, {
          async createReadinessProbes() {
            events.push("wait-for-readiness");
            return {
              pid: 4242,
              probes: {
                processAlive: async () => true,
                listeners: async () => [
                  { address: "127.0.0.1", port: 64995, pid: 4242 }
                ],
                pgIsReady: async () => true,
                openAdminSession: async () => ({
                  selectOne: async () => 1,
                  serverVersion: async () => "18.3",
                  close: async () => true
                })
              }
            };
          }
        })
      })
    ),
    { code: "harness_postgres_version_mismatch" }
  );
  assert.equal(events.at(-1), "cleanup");
});

test("controller rejects an unknown timeout phase", () => {
  assert.throws(
    () => controllerContract(options({ timeouts: { unknown: 100 } })),
    { code: "harness_timeout_phase_unknown" }
  );
});

test("controller forwards the exact timed-out phase to the owned terminator", async () => {
  let terminationInput;
  await assert.rejects(
    runLocalPhysicalHarness(
      options({
        timeouts: { preflight: 5 },
        adapters: adapters([], {
          preflight: async ({ signal }) =>
            new Promise((resolve) => {
              signal.addEventListener("abort", () => resolve({
                code: "preflight_aborted"
              }), { once: true });
            }),
          terminateProcessTree: async (input) => {
            terminationInput = input;
            return true;
          }
        })
      })
    ),
    { code: "preflight_timeout" }
  );
  assert.deepEqual(terminationInput, {
    phase: "preflight",
    target: { host: "127.0.0.1", port: 64995 }
  });
});

test("direct command-line entry is fail-closed and runs no adapter", async () => {
  let output = "";
  const code = await commandLineEntry({
    stderr: { write(value) { output += value; } }
  });
  assert.equal(code, 2);
  assert.equal(
    output,
    '{"ok":false,"code":"harness_injected_adapters_required"}\n'
  );
});

test("controller recusa archive UNC e device path antes dos adapters", () => {
  for (const archivePath of [
    "\\\\server\\share\\postgresql-18.4.zip",
    "\\\\?\\C:\\Temp\\postgresql-18.4.zip",
    "\\\\.\\C:\\Temp\\postgresql-18.4.zip"
  ]) {
    assert.throws(
      () => controllerContract(options({
        packageDescriptor: packageDescriptor({ archivePath })
      })),
      { code: "harness_package_path_invalid" }
    );
  }
});

test("controller valida inclusive o timeout de cleanup antes da primeira fase", () => {
  assert.throws(
    () => controllerContract(options({ timeouts: { cleanup: 0 } })),
    { code: "harness_timeout_invalid" }
  );
});

test("controller fecha snapshot dos adapters após validação", () => {
  const source = adapters();
  const originalPreflight = source.preflight;
  const contract = controllerContract(options({ adapters: source }));
  source.preflight = async () => ({ code: "mutated" });
  assert.equal(contract.adapters.preflight, originalPreflight);
  assert.equal(Object.isFrozen(contract.adapters), true);
});
