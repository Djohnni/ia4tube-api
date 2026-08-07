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
  HarnessFailure,
  PHASES
} = require("../scripts/social-3a0p-local-harness-core");

function packageDescriptor(overrides = {}) {
  return {
    archivePath: path.resolve("synthetic-postgresql-18.4.zip"),
    expectedSha256: "a".repeat(64),
    version: REQUIRED_POSTGRES_VERSION,
    sourceOwnedByRun: false,
    workingCopyOwnedByRun: true,
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
            listenAddresses: async () => "127.0.0.1",
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
    initializeEvidenceLedger: async () => ({ code: "ledger_initialized" }),
    transitionEvidenceLedger: async () => ({ code: "ledger_transitioned" }),
    verifyPackageSourcePreserved: async () => ({
      code: "windows_package_source_preserved",
      checks: {
        packageSourceOwnedByRun: false,
        externalPackagePreserved: true,
        sourceHashUnchanged: true,
        externalPackageDeletionAttempted: false
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

test("controller exige propriedade declarada e cópia de trabalho owned", () => {
  for (const invalid of [
    { workingCopyOwnedByRun: false },
    { sourceOwnedByRun: undefined },
    { workingCopyOwnedByRun: undefined }
  ]) {
    assert.throws(
      () => controllerContract(options({
        packageDescriptor: packageDescriptor(invalid)
      })),
      { code: "harness_package_ownership_invalid" }
    );
  }
});

test("controller aceita ZIP criado pela execução somente após remoção comprovada", async () => {
  const report = await runLocalPhysicalHarness(options({
    packageDescriptor: packageDescriptor({ sourceOwnedByRun: true }),
    adapters: adapters([], {
      async verifyPackageSourcePreserved() {
        return {
          code: "windows_package_source_preserved",
          checks: {
            packageSourceOwnedByRun: true,
            runOwnedPackageRemoved: true,
            externalPackageDeletionAttempted: false
          }
        };
      }
    })
  }));
  assert.equal(report.ok, true);
});

test("controller recusa prova cruzada entre ZIP externo e ZIP criado pela execução", async () => {
  for (const configured of [
    {
      descriptor: packageDescriptor({ sourceOwnedByRun: true }),
      checks: {
        packageSourceOwnedByRun: false,
        externalPackagePreserved: true,
        sourceHashUnchanged: true,
        externalPackageDeletionAttempted: false
      }
    },
    {
      descriptor: packageDescriptor({ sourceOwnedByRun: false }),
      checks: {
        packageSourceOwnedByRun: true,
        runOwnedPackageRemoved: true,
        externalPackageDeletionAttempted: false
      }
    }
  ]) {
    await assert.rejects(
      runLocalPhysicalHarness(options({
        packageDescriptor: configured.descriptor,
        adapters: adapters([], {
          async verifyPackageSourcePreserved() {
            return {
              code: "windows_package_source_preserved",
              checks: configured.checks
            };
          }
        })
      })),
      { code: "harness_package_source_verification_invalid" }
    );
  }
});

test("ledger incremental recebe início e término de todas as fases, inclusive cleanup", async () => {
  const ledgerEvents = [];
  const configuredAdapters = adapters([], {
    async initializeEvidenceLedger() {
      ledgerEvents.push({ kind: "initialize" });
      return { code: "ledger_initialized" };
    },
    async transitionEvidenceLedger(event) {
      ledgerEvents.push({ ...event });
      return { code: "ledger_transitioned" };
    }
  });
  const report = await runLocalPhysicalHarness(
    options({ adapters: configuredAdapters })
  );
  assert.equal(report.ok, true);
  assert.equal(ledgerEvents[0].kind, "initialize");
  for (const phase of PHASES) {
    const events = ledgerEvents.filter((entry) => entry.phase === phase);
    assert.deepEqual(events.map((entry) => entry.kind), ["started", "finished"]);
    assert.equal(events[1].status, "passed");
  }
});

test("falha de persistência do ledger bloqueia a fase física, mas cleanup real ainda é tentado", async () => {
  let preflightRan = false;
  let cleanupRan = false;
  const configuredAdapters = adapters([], {
    async transitionEvidenceLedger(event) {
      if (event.phase === "preflight" && event.kind === "started") {
        throw new Error("synthetic_ledger_write_failed");
      }
      return { code: "ledger_transitioned" };
    },
    async preflight() {
      preflightRan = true;
      return { code: "adapter_approved" };
    },
    async cleanup() {
      cleanupRan = true;
      return { code: "adapter_approved", checks: { approved: true } };
    }
  });
  await assert.rejects(
    runLocalPhysicalHarness(options({ adapters: configuredAdapters }))
  );
  assert.equal(preflightRan, false);
  assert.equal(cleanupRan, true);
});

test("ledger bootstrap failure blocks preflight, extraction and PostgreSQL before cleanup", async () => {
  const calls = [];
  const configuredAdapters = adapters([], {
    async initializeEvidenceLedger() {
      calls.push("initialize-ledger");
      throw new HarnessFailure("evidence_parent_validation_failed");
    },
    async transitionEvidenceLedger() {
      calls.push("transition-ledger");
      return { code: "ledger_transitioned" };
    },
    async preflight() {
      calls.push("preflight");
      return { code: "adapter_approved" };
    },
    async extractPackage() {
      calls.push("extract-package");
      return { code: "adapter_approved" };
    },
    async startCluster() {
      calls.push("start-cluster");
      return { code: "adapter_approved" };
    },
    async cleanup() {
      calls.push("cleanup");
      return { code: "adapter_approved", checks: { approved: true } };
    }
  });
  await assert.rejects(
    runLocalPhysicalHarness(options({ adapters: configuredAdapters })),
    { code: "evidence_parent_validation_failed" }
  );
  assert.deepEqual(calls, ["initialize-ledger", "cleanup"]);
});

test("pacote externo é revalidado antes da promoção da evidência canônica", async () => {
  let finalized = false;
  await assert.rejects(
    runLocalPhysicalHarness(options({
      adapters: adapters([], {
        async verifyPackageSourcePreserved() {
          throw new Error("synthetic_external_package_changed");
        },
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
    }))
  );
  assert.equal(finalized, false);
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
  const ledgerEvents = [];
  await assert.rejects(
    runLocalPhysicalHarness(options({
      timeouts: { cleanup: 5 },
      adapters: adapters([], {
        async transitionEvidenceLedger(event) {
          ledgerEvents.push({ ...event });
          return { code: "ledger_transitioned" };
        },
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
  const cleanupFinished = ledgerEvents.find(
    (event) => event.phase === "cleanup" && event.kind === "finished"
  );
  assert.equal(cleanupFinished.status, "failed");
  assert.equal(cleanupFinished.code, "cleanup_timeout");
  assert.equal(cleanupFinished.result.code, "cleanup_aborted");
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
                  listenAddresses: async () => "127.0.0.1",
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
  const ledgerEvents = [];
  await assert.rejects(
    runLocalPhysicalHarness(
      options({
        timeouts: { preflight: 5 },
        adapters: adapters([], {
          async transitionEvidenceLedger(event) {
            ledgerEvents.push({ ...event });
            return { code: "ledger_transitioned" };
          },
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
  const preflightFinished = ledgerEvents.find(
    (event) => event.phase === "preflight" && event.kind === "finished"
  );
  assert.equal(preflightFinished.status, "failed");
  assert.equal(preflightFinished.code, "preflight_timeout");
  assert.equal(preflightFinished.result.code, "preflight_aborted");
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
