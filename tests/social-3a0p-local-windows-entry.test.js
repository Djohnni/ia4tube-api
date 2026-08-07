"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  PHYSICAL_APPROVAL,
  REQUIRED_POSTGRES_VERSION,
  runLocalPreflightOnly
} = require("../scripts/social-3a0p-local-physical-harness");
const {
  commandLineEntry,
  POSTGRES_PACKAGE_NAME,
  PREFLIGHT_ONLY_ARGUMENT,
  PRODUCT_COMMIT,
  parseCommandLine,
  preflightOnlyPublicEvidence,
  prepareTrustedWindowsEntry,
  runPreparedEntry,
  validateTrustedWindowsEntryInput
} = require("../scripts/social-3a0p-local-windows-entry");

const HASH = "a".repeat(64);
const PACKAGE = path.resolve(`C:\\synthetic\\${POSTGRES_PACKAGE_NAME}`);

function validInput(overrides = {}) {
  return {
    approval: PHYSICAL_APPROVAL,
    expectedSha256: HASH,
    packagePath: PACKAGE,
    port: 64995,
    ...overrides
  };
}

function preflightOnlyOptions(events, overrides = {}) {
  const forbidden = [
    "validatePackage",
    "extractPackage",
    "initializeCluster",
    "startCluster",
    "createReadinessProbes",
    "bootstrapRoles",
    "establishDpapiCustody",
    "runMigrationGate",
    "runRlsGate",
    "runConcurrencyGate",
    "runVaultGate",
    "runBackupRestoreGate",
    "collectSanitizedEvidence",
    "finalizeSanitizedEvidence",
    "initializeEvidenceLedger",
    "transitionEvidenceLedger"
  ];
  const adapters = Object.fromEntries(forbidden.map((name) => [
    name,
    async () => {
      events.push(`forbidden:${name}`);
      throw new Error("physical phase reached by preflight-only");
    }
  ]));
  Object.assign(adapters, {
    async preflight() {
      events.push("preflight");
      return {
        code: "windows_preflight_passed",
        checks: { approved: true }
      };
    },
    async cleanup() {
      events.push("cleanup");
      return {
        code: "windows_cleanup_passed",
        checks: { clean: true }
      };
    },
    async verifyPackageSourcePreserved() {
      events.push("verify-source");
      return {
        code: "windows_package_source_preserved",
        checks: {
          packageSourceOwnedByRun: false,
          externalPackagePreserved: true,
          sourceHashUnchanged: true,
          externalPackageDeletionAttempted: false
        }
      };
    },
    async terminateProcessTree() {
      events.push("terminate-tree");
      return true;
    }
  });
  Object.assign(adapters, overrides.adapters || {});
  return {
    approval: PHYSICAL_APPROVAL,
    packageDescriptor: {
      archivePath: PACKAGE,
      expectedSha256: HASH,
      version: REQUIRED_POSTGRES_VERSION,
      sourceOwnedByRun: false,
      workingCopyOwnedByRun: true
    },
    target: { host: "127.0.0.1", port: 64995 },
    adapters,
    ...(overrides.timeouts && { timeouts: overrides.timeouts })
  };
}

test("entrada confiável aceita somente quatro campos não secretos exatos", () => {
  assert.deepEqual(validateTrustedWindowsEntryInput(validInput()), validInput());
  for (const extra of [
    { dependencies: {} },
    { adapterOptions: {} },
    { physicalGates: {} },
    { repositoryRoot: "C:\\other" },
    { powershell: "C:\\other.exe" },
    { timeouts: {} },
    { environment: {} }
  ]) {
    assert.throws(
      () => validateTrustedWindowsEntryInput({ ...validInput(), ...extra }),
      { code: "windows_entry_input_invalid" }
    );
  }
});

test("aprovação, caminho, hash e porta falham fechado antes da preparação", () => {
  assert.throws(
    () => validateTrustedWindowsEntryInput(validInput({ approval: "no" })),
    { code: "windows_entry_approval_missing" }
  );
  for (const packagePath of [
    "postgresql-18.4.zip",
    "\\\\server\\share\\postgresql-18.4.zip",
    "\\\\?\\C:\\postgresql-18.4.zip",
    path.resolve("C:\\synthetic\\postgresql-18.4.zip"),
    `${PACKAGE} `
  ]) {
    assert.throws(
      () => validateTrustedWindowsEntryInput(validInput({ packagePath })),
      { code: "windows_entry_package_path_invalid" }
    );
  }
  assert.throws(
    () => validateTrustedWindowsEntryInput(validInput({ expectedSha256: HASH.toUpperCase() })),
    { code: "windows_entry_package_sha256_invalid" }
  );
  for (const port of [0, 1023, 65536, "64995"]) {
    assert.throws(
      () => validateTrustedWindowsEntryInput(validInput({ port })),
      { code: "windows_entry_port_invalid" }
    );
  }
});

test("parser CLI recusa duplicações, extras e valores ausentes", () => {
  const args = [
    "--approval", PHYSICAL_APPROVAL,
    "--package-path", PACKAGE,
    "--expected-sha256", HASH,
    "--port", "64995"
  ];
  assert.deepEqual(parseCommandLine(args), validInput());
  assert.deepEqual(
    parseCommandLine([...args, PREFLIGHT_ONLY_ARGUMENT]),
    { ...validInput(), preflightOnly: true }
  );
  assert.throws(
    () => parseCommandLine([
      ...args,
      PREFLIGHT_ONLY_ARGUMENT,
      PREFLIGHT_ONLY_ARGUMENT
    ]),
    { code: "windows_entry_arguments_invalid" }
  );
  assert.throws(
    () => parseCommandLine([...args.slice(0, 6), "--approval", PHYSICAL_APPROVAL]),
    { code: "windows_entry_arguments_invalid" }
  );
  assert.throws(
    () => parseCommandLine([...args, "--extra", "value"]),
    { code: "windows_entry_arguments_invalid" }
  );
  assert.throws(
    () => parseCommandLine(args.slice(0, -1)),
    { code: "windows_entry_arguments_invalid" }
  );
});

test("flag única seleciona somente o preflight-only na entrada existente", async () => {
  const calls = [];
  const prepared = {
    async run() {
      calls.push("physical");
      return { ok: true };
    },
    async runPreflightOnly() {
      calls.push("preflight-only");
      return { ok: true };
    }
  };
  assert.deepEqual(await runPreparedEntry(prepared, true), { ok: true });
  assert.deepEqual(calls, ["preflight-only"]);
  calls.length = 0;
  assert.deepEqual(await runPreparedEntry(prepared, false), { ok: true });
  assert.deepEqual(calls, ["physical"]);
});

test("preflight-only executa preflight, cleanup e preservação sem ledger ou fase PostgreSQL", async () => {
  const events = [];
  const report = await runLocalPreflightOnly(preflightOnlyOptions(events));

  assert.equal(report.ok, true);
  assert.equal(report.lastCompletedPhase, "preflight");
  assert.deepEqual(report.phases.map((phase) => phase.phase), [
    "preflight",
    "cleanup"
  ]);
  assert.deepEqual(events, [
    "preflight",
    "cleanup",
    "verify-source"
  ]);
  assert.equal(events.some((event) => event.startsWith("forbidden:")), false);
  assert.doesNotMatch(JSON.stringify(report), /synthetic|postgres|package/i);
});

test("evidência pública do preflight é fechada, sanitizada e exige resíduos zero", () => {
  const report = {
    ok: true,
    phases: [{
      result: {
        counts: {
          packageBytes: 337_444_127,
          diskInitialFreeBytes: 8 * 1024 ** 3,
          diskMinimumRequiredFreeBytes: 7 * 1024 ** 3,
          postgresProcessesBefore: 0,
          postgresServicesBeforeIncludingStopped: 0,
          targetPortListenersBefore: 0,
          firewallProfiles: 3,
          firewallGlobalSettings: 1,
          firewallRules: 525
        },
        hashes: {
          firewallProfilesBeforeSha256: "b".repeat(64),
          firewallGlobalSettingsBeforeSha256: "c".repeat(64),
          firewallRulesBeforeSha256: "d".repeat(64),
          firewallBeforeSha256: "e".repeat(64)
        },
        inventory: ["firewall-evidence-mode-loopback-nonmutation-v1"],
        checks: {
          minimumFreeSpaceSatisfied: true,
          postgresProcessesZero: true,
          postgresServicesZeroIncludingStopped: true,
          postgresServiceExecutablePathsInspected: true,
          targetPortListenersZero: true,
          processNonElevated: true,
          integrityNonAdministrative: true,
          currentUserResolved: true,
          firewallMutationCommandsAbsent: true,
          uacElevationCommandsAbsent: true,
          scheduledTaskMutationCommandsAbsent: true,
          serviceMutationCommandsAbsent: true,
          localUserMutationCommandsAbsent: true,
          fullFirewallFilterSnapshotProved: false
        }
      }
    }, {
      result: {
        counts: {
          postgresProcessesRemaining: 0,
          postgresServicesRemaining: 0,
          postgresListenersRemaining: 0,
          firewallProfilesBefore: 3,
          firewallProfilesAfter: 3,
          firewallGlobalSettingsBefore: 1,
          firewallGlobalSettingsAfter: 1,
          firewallRulesBefore: 525,
          firewallRulesAfter: 525
        },
        hashes: {
          firewallProfilesAfterSha256: "b".repeat(64),
          firewallGlobalSettingsAfterSha256: "c".repeat(64),
          firewallRulesAfterSha256: "d".repeat(64),
          firewallAfterSha256: "e".repeat(64)
        },
        checks: {
          ownedRootRemoved: true,
          workingPackageRemoved: true,
          firewallLightEvidenceStable: true,
          firewallProfilesAndRulesMetadataStable: true,
          firewallGlobalSettingsStable: true,
          fullFirewallFilterSnapshotProved: false,
          systemClean: true,
          postgresServiceExecutablePathsInspected: true,
          noResidualProcesses: true,
          helpersZero: true,
          temporaryCustodiesZero: true,
          finalPortClosed: true
        }
      }
    }]
  };
  const evidence = preflightOnlyPublicEvidence(report, {
    packageSha256: HASH
  });
  assert.equal(evidence.firewallEvidenceMode, "loopback_nonmutation_v1");
  assert.equal(evidence.preflightOnlyResiduesZero, true);
  assert.equal(evidence.fullFirewallFilterSnapshotProved, false);
  assert.equal(evidence.currentUserResolved, true);
  assert.equal(evidence.uacElevationCommandsAbsent, true);
  assert.equal(evidence.postgresServiceExecutableInspected, true);
  assert.equal(evidence.packageSha256, HASH);
  assert.equal(evidence.firewallProfilesCount, 3);
  assert.equal(evidence.firewallRulesCount, 525);
  assert.doesNotMatch(JSON.stringify(evidence), /password|token|username|path/i);

  report.phases[1].result.checks.finalPortClosed = false;
  assert.throws(
    () => preflightOnlyPublicEvidence(report, { packageSha256: HASH }),
    { code: "windows_entry_preflight_evidence_invalid" }
  );
});

test("evidência pública do preflight recusa limite, contagem ou hash adulterado", () => {
  const base = {
    ok: true,
    phases: [{ result: {
      counts: {
        packageBytes: 1,
        diskInitialFreeBytes: 8 * 1024 ** 3,
        diskMinimumRequiredFreeBytes: 7 * 1024 ** 3,
        postgresProcessesBefore: 0,
        postgresServicesBeforeIncludingStopped: 0,
        targetPortListenersBefore: 0,
        firewallProfiles: 3,
        firewallGlobalSettings: 1,
        firewallRules: 525
      },
      hashes: {
        firewallProfilesBeforeSha256: "b".repeat(64),
        firewallGlobalSettingsBeforeSha256: "c".repeat(64),
        firewallRulesBeforeSha256: "d".repeat(64),
        firewallBeforeSha256: "e".repeat(64)
      },
      inventory: ["firewall-evidence-mode-loopback-nonmutation-v1"],
      checks: {
        minimumFreeSpaceSatisfied: true,
        postgresProcessesZero: true,
        postgresServicesZeroIncludingStopped: true,
        postgresServiceExecutablePathsInspected: true,
        targetPortListenersZero: true,
        processNonElevated: true,
        integrityNonAdministrative: true,
        currentUserResolved: true,
        firewallMutationCommandsAbsent: true,
        uacElevationCommandsAbsent: true,
        scheduledTaskMutationCommandsAbsent: true,
        serviceMutationCommandsAbsent: true,
        localUserMutationCommandsAbsent: true,
        fullFirewallFilterSnapshotProved: false
      }
    } }, { result: {
      counts: {
        postgresProcessesRemaining: 0,
        postgresServicesRemaining: 0,
        postgresListenersRemaining: 0,
        firewallProfilesBefore: 3,
        firewallProfilesAfter: 3,
        firewallGlobalSettingsBefore: 1,
        firewallGlobalSettingsAfter: 1,
        firewallRulesBefore: 525,
        firewallRulesAfter: 525
      },
      hashes: {
        firewallProfilesAfterSha256: "b".repeat(64),
        firewallGlobalSettingsAfterSha256: "c".repeat(64),
        firewallRulesAfterSha256: "d".repeat(64),
        firewallAfterSha256: "e".repeat(64)
      },
      checks: {
        ownedRootRemoved: true,
        workingPackageRemoved: true,
        firewallLightEvidenceStable: true,
        firewallProfilesAndRulesMetadataStable: true,
        firewallGlobalSettingsStable: true,
        fullFirewallFilterSnapshotProved: false,
        systemClean: true,
        postgresServiceExecutablePathsInspected: true,
        noResidualProcesses: true,
        helpersZero: true,
        temporaryCustodiesZero: true,
        finalPortClosed: true
      }
    } }]
  };
  const clone = () => structuredClone(base);
  for (const mutate of [
    (value) => { value.phases[0].result.counts.diskMinimumRequiredFreeBytes -= 1; },
    (value) => { value.phases[0].result.counts.postgresProcessesBefore = 1; },
    (value) => { value.phases[1].result.counts.postgresListenersRemaining = 1; },
    (value) => { value.phases[1].result.counts.firewallRulesAfter = 524; },
    (value) => { value.phases[1].result.hashes.firewallRulesAfterSha256 = "f".repeat(64); }
  ]) {
    const value = clone();
    mutate(value);
    assert.throws(
      () => preflightOnlyPublicEvidence(value, { packageSha256: HASH }),
      { code: "windows_entry_preflight_evidence_invalid" }
    );
  }
});

test("timeout do preflight encerra a árvore, executa cleanup e não avança", async () => {
  const events = [];
  const configured = preflightOnlyOptions(events, {
    timeouts: { preflight: 5 },
    adapters: {
      async preflight({ signal }) {
        events.push("preflight");
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({
            code: "preflight_aborted"
          }), { once: true });
        });
      }
    }
  });

  await assert.rejects(
    runLocalPreflightOnly(configured),
    (error) => {
      assert.equal(error.code, "preflight_timeout");
      assert.deepEqual(error.report.phases.map((phase) => phase.phase), [
        "preflight",
        "cleanup"
      ]);
      assert.equal(error.report.phases[0].status, "failed");
      assert.equal(error.report.phases[1].status, "passed");
      return true;
    }
  );
  assert.equal(events.includes("terminate-tree"), true);
  assert.equal(events.includes("cleanup"), true);
  assert.equal(events.includes("verify-source"), true);
  assert.equal(events.some((event) => event.startsWith("forbidden:")), false);
});

test("CLI sem aprovação não lê pacote nem inicia o harness", async () => {
  let output = "";
  const code = await commandLineEntry({
    argv: [
      "--approval", "invalid",
      "--package-path", "C:\\does-not-exist\\postgresql.zip",
      "--expected-sha256", HASH,
      "--port", "64995"
    ],
    stdout: { write(value) { output += value; } },
    stderr: { write(value) { output += value; } }
  });
  assert.equal(code, 2);
  assert.match(output, /windows_entry_approval_missing/);
  assert.doesNotMatch(output, /does-not-exist/);
});

test("preparação confiável copia o pacote por hash e cancela sem executar PostgreSQL", {
  skip: process.platform !== "win32"
}, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-entry-source-"));
  const source = path.join(parent, POSTGRES_PACKAGE_NAME);
  const bytes = Buffer.from("synthetic-package-not-executed", "utf8");
  fs.writeFileSync(source, bytes, { flag: "wx" });
  const expectedSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  try {
    const prepared = await prepareTrustedWindowsEntry({
      approval: PHYSICAL_APPROVAL,
      expectedSha256,
      packagePath: source,
      port: 64995
    });
    assert.deepEqual(prepared.summary, {
      packageSha256: expectedSha256,
      packageName: POSTGRES_PACKAGE_NAME,
      packageBuild: "18.4-2",
      sourceOwnedByRun: false,
      workingCopyOwnedByRun: true,
      port: 64995,
      postgresVersion: "18.4",
      targetHost: "127.0.0.1"
    });
    assert.equal(prepared.cancelPreparation(), true);
    assert.throws(
      () => prepared.cancelPreparation(),
      { code: "windows_entry_state_invalid" }
    );
  } finally {
    bytes.fill(0);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("hash incorreto é recusado antes de criar uma execução física", {
  skip: process.platform !== "win32"
}, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-entry-hash-"));
  const source = path.join(parent, POSTGRES_PACKAGE_NAME);
  fs.writeFileSync(source, "synthetic", { flag: "wx" });
  try {
    await assert.rejects(
      prepareTrustedWindowsEntry({
        approval: PHYSICAL_APPROVAL,
        expectedSha256: "f".repeat(64),
        packagePath: source,
        port: 64995
      }),
      { code: "windows_entry_package_sha256_mismatch" }
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("entrada confiável ignora SystemRoot e PATH manipulados pelo chamador", {
  skip: process.platform !== "win32"
}, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-entry-env-"));
  const source = path.join(parent, POSTGRES_PACKAGE_NAME);
  const bytes = Buffer.from("synthetic-package-environment-proof", "utf8");
  fs.writeFileSync(source, bytes, { flag: "wx" });
  const expectedSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const previous = {
    ComSpec: process.env.ComSpec,
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR
  };
  process.env.ComSpec = path.join(parent, "cmd.exe");
  process.env.PATH = parent;
  process.env.SystemRoot = parent;
  process.env.WINDIR = parent;
  try {
    const prepared = await prepareTrustedWindowsEntry({
      approval: PHYSICAL_APPROVAL,
      expectedSha256,
      packagePath: source,
      port: 64994
    });
    assert.equal(prepared.cancelPreparation(), true);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    bytes.fill(0);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("identidade do produto e nome do build futuro permanecem canônicos", () => {
  assert.match(PRODUCT_COMMIT, /^[0-9a-f]{40}$/);
  assert.equal(POSTGRES_PACKAGE_NAME, "postgresql-18.4-2-windows-x64-binaries.zip");
});
