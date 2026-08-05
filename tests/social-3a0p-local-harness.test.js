"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  DEFAULT_PHASE_TIMEOUTS,
  DEFAULT_READINESS_TIMEOUTS,
  HarnessFailure,
  LOOPBACK_AUTHORIZATION,
  PHASES,
  assertClosedEvidenceReport,
  assertLoopbackAuthorization,
  assertNoReparsePoints,
  assertOwnedPath,
  buildAllowlistedEnvironment,
  buildMigrationCliEnvironment,
  createOwnedTemporaryRoot,
  createResourceJournal,
  establishDpapiCustody,
  executeWithTimeout,
  heartbeatEvent,
  isLoopbackHost,
  removeOwnedTree,
  roleBootstrapContract,
  rollbackContract,
  runPhasedHarness,
  safeSystemEnvironment,
  startPeriodicHeartbeat,
  validatePhaseResult,
  waitForReadiness,
  windowsBackupRestoreContract
} = require("../scripts/social-3a0p-local-harness-core");

function expectCode(code) {
  return (error) => error instanceof HarnessFailure && error.code === code;
}

function passingActions() {
  return Object.fromEntries(
    PHASES.map((phase) => [phase, async () => ({ code: `${phase.replaceAll("-", "_")}_ok` })])
  );
}

function readinessProbes(overrides = {}) {
  const session = {
    selectOne: async () => 1,
    serverVersion: async () => "18.4",
    close: async () => true
  };
  return {
    processAlive: async () => true,
    listeners: async (pid) => [{ address: "127.0.0.1", port: 64995, pid }],
    pgIsReady: async () => true,
    openAdminSession: async () => session,
    ...overrides
  };
}

test("autoriza exclusivamente 127.0.0.1 com opt-in explícito", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  for (const host of ["localhost", "::1", "127.0.0.1 ", "0.0.0.0", "db.local"]) {
    assert.equal(isLoopbackHost(host), false);
    assert.throws(
      () => assertLoopbackAuthorization({ [LOOPBACK_AUTHORIZATION]: "true" }, host),
      expectCode("harness_loopback_host_refused")
    );
  }
  assert.equal(
    assertLoopbackAuthorization(
      { [LOOPBACK_AUTHORIZATION]: "true" },
      "127.0.0.1"
    ),
    true
  );
});

test("recusa ausência ou forma não canônica da autorização local", () => {
  for (const value of [undefined, "false", "TRUE", " true", "1"]) {
    assert.throws(
      () =>
        assertLoopbackAuthorization(
          { [LOOPBACK_AUTHORIZATION]: value },
          "127.0.0.1"
        ),
      expectCode("harness_loopback_authorization_missing")
    );
  }
});

test("ambiente filho não herda NODE_PATH nem variáveis PostgreSQL ambientes", () => {
  const filtered = safeSystemEnvironment({
    Path: "C:\\Windows",
    NODE_PATH: "C:\\ambient-modules",
    PGHOST: "external.example",
    PGPASSWORD: "ambient-password",
    DATABASE_URL: "postgresql://ambient",
    TEMP: "C:\\Temp"
  });
  assert.deepEqual(filtered, { PATH: "C:\\Windows", TEMP: "C:\\Temp" });

  const child = buildAllowlistedEnvironment({
    systemEnvironment: {
      Path: "C:\\Windows",
      NODE_PATH: "C:\\ambient-modules",
      PGHOST: "external.example"
    },
    values: { NODE_ENV: "test" },
    allowedNames: ["NODE_ENV"],
    requiredNames: ["NODE_ENV"]
  });
  assert.deepEqual(child, { PATH: "C:\\Windows", NODE_ENV: "test" });
});

test("ambiente filho recusa chave não autorizada", () => {
  assert.throws(
    () =>
      buildAllowlistedEnvironment({
        systemEnvironment: {},
        values: { UNEXPECTED: "value" },
        allowedNames: []
      }),
    expectCode("harness_child_environment_key_refused")
  );
});

test("CLI de migration recebe opt-in no processo que conecta", () => {
  const environment = buildMigrationCliEnvironment({
    systemEnvironment: { Path: "C:\\Windows", PGHOST: "ambient" },
    configuration: {
      mode: "loopback",
      host: "127.0.0.1",
      port: 64995,
      database: "ia4tube_social_test"
    },
    loopbackAuthorization: "true",
    values: {
      migrationUrl:
        "postgresql://ia4tube_social_test_migrator@127.0.0.1:64995/ia4tube_social_test",
      expectedTargetFingerprint: "a".repeat(64),
      migrationLogin: "ia4tube_social_test_migrator",
      runtimeLogin: "ia4tube_social_test_runtime",
      ownerRole: "ia4tube_social_test_owner",
      migratorRole: "ia4tube_social_test_migrator",
      environment: "local-physical-gate",
      approval: "run-local-physical-gate",
      environmentId: "local-physical-gate-001",
      targetFingerprint: "a".repeat(64)
    }
  });
  assert.equal(environment[LOOPBACK_AUTHORIZATION], "true");
  assert.equal(environment.PGHOST, undefined);
  assert.equal(environment.NODE_PATH, undefined);
  assert.equal(
    assertLoopbackAuthorization(environment, "127.0.0.1"),
    true
  );
});

test("CLI de migration sem opt-in falha antes de produzir ambiente para spawn", () => {
  assert.throws(
    () => buildMigrationCliEnvironment({
      systemEnvironment: { Path: "C:\\Windows" },
      configuration: {
        mode: "loopback",
        host: "127.0.0.1",
        port: 64995,
        database: "ia4tube_social_test"
      },
      values: {
        migrationUrl:
          "postgresql://ia4tube_social_test_migrator@127.0.0.1:64995/ia4tube_social_test",
        expectedTargetFingerprint: "a".repeat(64),
        migrationLogin: "ia4tube_social_test_migrator",
        runtimeLogin: "ia4tube_social_test_runtime",
        ownerRole: "ia4tube_social_test_owner",
        migratorRole: "ia4tube_social_test_migrator",
        environment: "local-physical-gate",
        approval: "run-local-physical-gate",
        environmentId: "local-physical-gate-001",
        targetFingerprint: "a".repeat(64)
      }
    }),
    expectCode("harness_loopback_authorization_missing")
  );
});

test("CLI de migration recusa host externo antes de montar ambiente", () => {
  assert.throws(
    () =>
      buildMigrationCliEnvironment({
        systemEnvironment: {},
        configuration: { mode: "loopback", host: "database.example" },
        loopbackAuthorization: "true",
        values: {}
      }),
    expectCode("harness_loopback_host_refused")
  );
});

test("CLI de migration recusa URL externa mesmo com alvo declarado como loopback", () => {
  assert.throws(
    () => buildMigrationCliEnvironment({
      systemEnvironment: {},
      configuration: {
        mode: "loopback",
        host: "127.0.0.1",
        port: 64995,
        database: "ia4tube_social_test"
      },
      loopbackAuthorization: "true",
      values: {
        migrationUrl:
          "postgresql://ia4tube_social_test_migrator@database.invalid:64995/ia4tube_social_test",
        migrationLogin: "ia4tube_social_test_migrator"
      }
    }),
    expectCode("harness_migration_url_target_mismatch")
  );
});

test("heartbeat usa tempo relativo e schema sanitizado", () => {
  const event = heartbeatEvent(
    "bootstrap-roles",
    "role_bootstrap_waiting",
    10_000,
    () => 10_375
  );
  assert.deepEqual(event, {
    phase: "bootstrap-roles",
    status: "running",
    step: "role_bootstrap_waiting",
    elapsedMs: 375
  });
});

test("resultado de fase aceita somente schema fechado", () => {
  assert.deepEqual(validatePhaseResult(undefined), { code: "phase_ok" });
  assert.throws(
    () => validatePhaseResult({ code: "phase_ok", arbitrary: true }),
    expectCode("harness_evidence_result_key_refused")
  );
  assert.throws(
    () =>
      validatePhaseResult({
        code: "phase_ok",
        checks: { databaseUrl: "postgresql://user:pass@example/db" }
      }),
    expectCode("harness_evidence_key_invalid")
  );
});

test("orquestrador conclui todas as fases e cleanup", async () => {
  const report = await runPhasedHarness({ actions: passingActions() });
  assert.equal(report.ok, true);
  assert.equal(report.phases.length, PHASES.length);
  assert.equal(report.phases.at(-1).phase, "cleanup");
  assert.equal(report.lastCompletedPhase, "collect-sanitized-evidence");
  assert.equal(assertClosedEvidenceReport(report), true);
});

test("ação ausente falha e ainda executa cleanup", async () => {
  const actions = passingActions();
  delete actions["validate-package"];
  let cleaned = false;
  actions.cleanup = async () => {
    cleaned = true;
    return { code: "cleanup_ok" };
  };
  await assert.rejects(
    runPhasedHarness({ actions }),
    (error) => {
      assert.equal(error.code, "harness_phase_action_missing");
      assert.equal(error.report.cleanupFailureCode, null);
      return true;
    }
  );
  assert.equal(cleaned, true);
});

test("falha primária é preservada quando cleanup também falha", async () => {
  const actions = passingActions();
  actions.preflight = async () => {
    throw new HarnessFailure("preflight_expected_failure");
  };
  actions.cleanup = async () => {
    throw new HarnessFailure("cleanup_expected_failure");
  };
  await assert.rejects(
    runPhasedHarness({ actions }),
    (error) => {
      assert.equal(error.code, "preflight_expected_failure");
      assert.equal(error.report.primaryFailureCode, "preflight_expected_failure");
      assert.equal(error.report.cleanupFailureCode, "cleanup_expected_failure");
      return true;
    }
  );
});

test("timeout é autoritativo, encerra árvore e executa cleanup", async () => {
  const actions = passingActions();
  let terminatedPhase;
  let cleaned = false;
  actions.preflight = async ({ signal }) =>
    new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  actions.cleanup = async () => {
    cleaned = true;
    return { code: "cleanup_ok" };
  };
  await assert.rejects(
    runPhasedHarness({
      actions,
      timeouts: { ...DEFAULT_PHASE_TIMEOUTS, preflight: 15 },
      terminateTree: async ({ phase }) => {
        terminatedPhase = phase;
        return true;
      },
      terminationTimeoutMs: 25,
      settlementTimeoutMs: 25
    }),
    (error) => {
      assert.equal(error.code, "preflight_timeout");
      assert.equal(error.terminationConfirmed, true);
      return true;
    }
  );
  assert.equal(terminatedPhase, "preflight");
  assert.equal(cleaned, true);
});

test("executor de timeout nunca transforma término tardio em sucesso", async () => {
  let resolveOperation;
  const operation = new Promise((resolve) => {
    resolveOperation = resolve;
  });
  const pending = executeWithTimeout({
    phase: "bootstrap-roles",
    timeoutMs: 10,
    operation: () => operation,
    terminateTree: async () => true
  });
  setTimeout(() => resolveOperation({ code: "late_success" }), 25);
  await assert.rejects(pending, expectCode("bootstrap_roles_timeout"));
});

test("readiness imediato usa uma sessão e sempre a fecha", async () => {
  let opened = 0;
  let closed = 0;
  const order = [];
  const probes = readinessProbes({
    processAlive: async () => {
      order.push("process");
      return true;
    },
    listeners: async (pid) => {
      order.push("listener");
      return [{ address: "127.0.0.1", port: 64995, pid }];
    },
    pgIsReady: async () => {
      order.push("pg_isready");
      return true;
    },
    openAdminSession: async () => {
      opened += 1;
      order.push("connect");
      return {
        selectOne: async () => {
          order.push("select");
          return 1;
        },
        serverVersion: async () => {
          order.push("version");
          return "18.4";
        },
        close: async () => {
          order.push("close");
          closed += 1;
        }
      };
    }
  });
  const result = await waitForReadiness({ probes, pid: 4242, port: 64995 });
  assert.equal(result.code, "readiness_passed");
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.ok(order.indexOf("listener") < order.indexOf("pg_isready"));
  assert.ok(order.indexOf("connect") < order.indexOf("select"));
  assert.ok(order.indexOf("select") < order.indexOf("version"));
  assert.ok(order.indexOf("version") < order.indexOf("close"));
});

test("readiness atrasado respeita polling por etapa", async () => {
  let clock = 0;
  let listenerAttempts = 0;
  let readyAttempts = 0;
  const probes = readinessProbes({
    listeners: async (pid) => {
      listenerAttempts += 1;
      return listenerAttempts < 3
        ? []
        : [{ address: "127.0.0.1", port: 64995, pid }];
    },
    pgIsReady: async () => {
      readyAttempts += 1;
      return readyAttempts >= 2;
    }
  });
  const result = await waitForReadiness({
    probes,
    pid: 9,
    port: 64995,
    stepTimeouts: Object.fromEntries(
      Object.keys(DEFAULT_READINESS_TIMEOUTS).map((key) => [key, 100])
    ),
    pollMs: 5,
    now: () => clock,
    sleep: async (delay) => {
      clock += delay;
    }
  });
  assert.equal(result.checks.pgIsReady, true);
  assert.equal(listenerAttempts, 3);
  assert.equal(readyAttempts, 2);
});

test("readiness recusa processo morto", async () => {
  await assert.rejects(
    waitForReadiness({
      probes: readinessProbes({ processAlive: async () => false }),
      pid: 44,
      port: 64995
    }),
    expectCode("harness_readiness_process_exited")
  );
});

test("readiness recusa listener externo ou de PID diferente", async () => {
  for (const listener of [
    { address: "0.0.0.0", port: 64995, pid: 44 },
    { address: "127.0.0.1", port: 64995, pid: 45 },
    { address: "127.0.0.1", port: 5432, pid: 44 }
  ]) {
    await assert.rejects(
      waitForReadiness({
        probes: readinessProbes({ listeners: async () => [listener] }),
        pid: 44,
        port: 64995
      }),
      expectCode("harness_external_listener_detected")
    );
  }
});

test("readiness recusa listener alvo acompanhado de qualquer listener extra", async () => {
  const expected = { address: "127.0.0.1", port: 64995, pid: 44 };
  for (const unexpected of [
    { address: "0.0.0.0", port: 64995, pid: 44 },
    { address: "::", port: 64995, pid: 44 },
    { address: "127.0.0.1", port: 64996, pid: 44 }
  ]) {
    await assert.rejects(
      waitForReadiness({
        probes: readinessProbes({ listeners: async () => [expected, unexpected] }),
        pid: 44,
        port: 64995
      }),
      expectCode("harness_external_listener_detected")
    );
  }
});

test("falha SELECT 1 fecha a mesma sessão", async () => {
  let closed = 0;
  await assert.rejects(
    waitForReadiness({
      probes: readinessProbes({
        openAdminSession: async () => ({
          selectOne: async () => 0,
          serverVersion: async () => "18.4",
          close: async () => {
            closed += 1;
          }
        })
      }),
      pid: 44,
      port: 64995
    }),
    expectCode("harness_select_one_failed")
  );
  assert.equal(closed, 1);
});

test("versão diferente de 18.4 é recusada e sessão fechada", async () => {
  let closed = false;
  await assert.rejects(
    waitForReadiness({
      probes: readinessProbes({
        openAdminSession: async () => ({
          selectOne: async () => 1,
          serverVersion: async () => "18.3",
          close: async () => {
            closed = true;
          }
        })
      }),
      pid: 44,
      port: 64995
    }),
    expectCode("harness_postgres_version_mismatch")
  );
  assert.equal(closed, true);
});

test("custódia DPAPI usa CurrentUser, zera material e remove temporário", async () => {
  const material = Buffer.alloc(32, 7);
  let removed = false;
  const result = await establishDpapiCustody({
    material,
    custodyPath: "C:\\Temp\\owned\\dpapi-proof.bin",
    ownedRoot: "C:\\Temp\\owned",
    adapter: {
      protectAndVerify: async ({ material: received, scope }) => {
        assert.equal(received.every((value) => value === 7), true);
        assert.equal(scope, "CurrentUser");
        return {
          dpapiProtected: true,
          roundTripVerified: true,
          plaintextPersisted: false,
          scope: "CurrentUser",
          custodyCreatedByThisRun: true,
          temporaryCustodyRemoved: false
        };
      },
      remove: async () => {
        removed = true;
        return true;
      }
    }
  });
  assert.equal(result.checks.temporaryCustodyRemoved, true);
  assert.equal(material.every((value) => value === 0), true);
  assert.equal(removed, true);
});

test("falha DPAPI zera material sem adotar custódia sem ownership", async () => {
  const material = Buffer.alloc(32, 9);
  let removed = false;
  await assert.rejects(
    establishDpapiCustody({
      material,
      custodyPath: "C:\\Temp\\owned\\dpapi-proof.bin",
      ownedRoot: "C:\\Temp\\owned",
      adapter: {
        protectAndVerify: async () => {
          throw new Error("sensitive detail that must not propagate");
        },
        remove: async () => {
          removed = true;
        }
      }
    }),
    expectCode("harness_dpapi_operation_failed")
  );
  assert.equal(material.every((value) => value === 0), true);
  assert.equal(removed, false);
});

test("resultado DPAPI inválido remove custódia parcial owned e preserva a falha primária", async () => {
  const material = Buffer.alloc(32, 11);
  let removed = 0;
  await assert.rejects(
    establishDpapiCustody({
      material,
      custodyPath: "C:\\Temp\\owned\\dpapi-partial.bin",
      ownedRoot: "C:\\Temp\\owned",
      adapter: {
        protectAndVerify: async () => ({
          dpapiProtected: true,
          roundTripVerified: false,
          plaintextPersisted: false,
          scope: "CurrentUser",
          custodyCreatedByThisRun: true,
          temporaryCustodyRemoved: false
        }),
        remove: async () => {
          removed += 1;
          return true;
        }
      }
    }),
    expectCode("harness_dpapi_round_trip_failed")
  );
  assert.equal(removed, 1);
  assert.equal(material.every((value) => value === 0), true);
});

test("falha de cleanup DPAPI parcial permanece separada da falha primária", async () => {
  const material = Buffer.alloc(32, 13);
  await assert.rejects(
    establishDpapiCustody({
      material,
      custodyPath: "C:\\Temp\\owned\\dpapi-partial.bin",
      ownedRoot: "C:\\Temp\\owned",
      adapter: {
        protectAndVerify: async () => ({
          dpapiProtected: true,
          roundTripVerified: false,
          plaintextPersisted: false,
          scope: "CurrentUser",
          custodyCreatedByThisRun: true,
          temporaryCustodyRemoved: false
        }),
        remove: async () => false
      }
    }),
    (error) => {
      assert.equal(error.code, "harness_dpapi_round_trip_failed");
      assert.equal(
        error.cleanupFailureCode,
        "harness_dpapi_cleanup_unconfirmed"
      );
      return true;
    }
  );
  assert.equal(material.every((value) => value === 0), true);
});

test("custódia DPAPI já removida pelo adapter não é removida novamente", async () => {
  const material = Buffer.alloc(32, 5);
  let removed = false;
  const result = await establishDpapiCustody({
    material,
    custodyPath: "C:\\Temp\\owned\\dpapi-proof.bin",
    ownedRoot: "C:\\Temp\\owned",
    adapter: {
      protectAndVerify: async () => ({
        dpapiProtected: true,
        roundTripVerified: true,
        plaintextPersisted: false,
        scope: "CurrentUser",
        custodyCreatedByThisRun: true,
        temporaryCustodyRemoved: true
      }),
      remove: async () => {
        removed = true;
        return true;
      }
    }
  });
  assert.equal(result.checks.temporaryCustodyRemoved, true);
  assert.equal(removed, false);
});

test("raiz temporária é filha direta owned e caminho não escapa", () => {
  const parent = path.join(os.tmpdir(), "ia4tube-harness-parent");
  const root = path.join(parent, "ia4tube-social-3a0p-unit");
  assert.equal(assertOwnedPath(path.join(root, "cluster"), root), path.join(root, "cluster"));
  assert.throws(
    () => assertOwnedPath(path.join(parent, "outside"), root),
    expectCode("harness_resource_path_refused")
  );
});

test("reparse point é recusado sem ser seguido", () => {
  const root = path.resolve("C:\\Temp\\ia4tube-social-3a0p-unit");
  const child = path.join(root, "junction");
  const fakeFs = {
    existsSync: () => true,
    lstatSync: (entry) => ({
      isSymbolicLink: () => entry === child,
      isDirectory: () => entry !== child
    }),
    readdirSync: (entry) => (entry === root ? ["junction"] : [])
  };
  assert.throws(
    () => assertNoReparsePoints(root, root, fakeFs),
    expectCode("harness_reparse_point_refused")
  );
});

test("resource journal encerra PIDs registrados e remove somente raiz owned", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-harness-test-"));
  const ownershipProof = createOwnedTemporaryRoot({ parent });
  const root = ownershipProof.root;
  const proof = path.join(root, "proof.tmp");
  fs.writeFileSync(proof, "synthetic", "utf8");
  const terminated = [];
  try {
    const journal = createResourceJournal({
      ownedRoot: root,
      parent,
      ownershipProof,
      terminateProcessTree: async (pid) => {
        terminated.push(pid);
        return true;
      }
    });
    journal.registerProcess(1234);
    journal.registerPath(proof);
    const result = await journal.cleanup();
    assert.deepEqual(terminated, [1234]);
    assert.equal(result.checks.ownedRootRemoved, true);
    assert.equal(fs.existsSync(parent), true);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("remoção owned não aceita nome amplo ou pasta pai", () => {
  const parent = path.join(os.tmpdir(), "ia4tube-parent");
  assert.throws(
    () => removeOwnedTree(parent, parent),
    expectCode("harness_temporary_root_refused")
  );
  assert.throws(
    () => removeOwnedTree(path.join(parent, "other"), parent),
    expectCode("harness_temporary_root_refused")
  );
});

test("contratos de roles, rollback forward-only e limitações Windows são explícitos", () => {
  const roles = roleBootstrapContract();
  assert.equal(roles.authentication, "scram-sha-256");
  assert.equal(roles.roles.runtime.superuser, false);
  assert.equal(roles.roles.runtime.bypassRls, false);
  assert.equal(roles.roles.runtime.migrationPrivileges, false);
  assert.equal(roles.roles.migration.provisioningPrivileges, false);

  const rollback = rollbackContract();
  assert.equal(rollback.architecture, "forward-only");
  assert.equal(rollback.downMigrationCreated, false);
  assert.ok(rollback.transactional.includes("verify-transaction-rollback"));
  assert.ok(rollback.operational.includes("restore-0001-0003-to-disposable-database"));

  const backup = windowsBackupRestoreContract();
  assert.deepEqual(backup.profiles, ["social-schema-0003", "social-schema-0004"]);
  assert.equal(backup.directoryFsync, "pending-linux-durability-gate");
  assert.equal(backup.noFollow, "pending-linux-durability-gate");
});

test("helper DPAPI não envia plaintext por argumento ou stdout", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "social-3a0p-local-dpapi.ps1"),
    "utf8"
  );
  assert.match(source, /DataProtectionScope\]::CurrentUser/);
  assert.match(source, /\[Console\]::In\.ReadToEnd\(\)/);
  assert.doesNotMatch(source, /Write-(?:Host|Output|Verbose|Debug).*plain/i);
  assert.match(source, /Clear-ByteArray -Bytes \$plainBytes/);
  assert.match(source, /Remove-Item -LiteralPath/);
  assert.match(source, /FileMode\]::CreateNew/);
  assert.match(source, /custody_preexisting_refused/);
  assert.match(source, /OwnedParent/);
  assert.match(source, /stdin_too_large/);
  assert.match(
    source,
    /\$custodyValidated -and \$custodyCreated[\s\S]*Remove-Item -LiteralPath \$custodyFull/
  );
  assert.ok(
    source.indexOf("$custodyCreated = $true") <
      source.indexOf("$custodyStream.Write("),
    "a custódia passa a pertencer ao run assim que CreateNew abre o arquivo"
  );
  assert.doesNotMatch(source, /WriteAllBytes\(\$custodyFull/);
});

test("heartbeat periodico e relativo usa timer unref", () => {
  let callback;
  let unrefCalled = false;
  let cleared = false;
  let clock = 1_000;
  const events = [];
  const stop = startPeriodicHeartbeat({
    phase: "bootstrap-roles",
    startedAt: 1_000,
    intervalMs: 10,
    now: () => clock,
    heartbeat: (event) => events.push(event),
    setIntervalImpl: (handler) => {
      callback = handler;
      return { unref: () => { unrefCalled = true; } };
    },
    clearIntervalImpl: () => { cleared = true; }
  });
  clock = 1_125;
  callback();
  stop();
  assert.equal(unrefCalled, true);
  assert.equal(cleared, true);
  assert.equal(events[0].elapsedMs, 125);
  assert.equal(events[0].step, "phase_heartbeat");
});

test("readiness nunca alcancado falha por deadline da etapa", async () => {
  let clock = 0;
  await assert.rejects(
    waitForReadiness({
      probes: readinessProbes({ listeners: async () => [] }),
      pid: 44,
      port: 64995,
      stepTimeouts: { ...DEFAULT_READINESS_TIMEOUTS, listener: 20 },
      pollMs: 5,
      now: () => clock,
      sleep: async (delay) => { clock += delay; }
    }),
    expectCode("harness_readiness_listener_timeout")
  );
});

test("processo que morre durante polling interrompe readiness", async () => {
  let aliveChecks = 0;
  let clock = 0;
  await assert.rejects(
    waitForReadiness({
      probes: readinessProbes({
        processAlive: async () => ++aliveChecks < 3,
        listeners: async () => []
      }),
      pid: 44,
      port: 64995,
      stepTimeouts: { ...DEFAULT_READINESS_TIMEOUTS, listener: 50 },
      pollMs: 5,
      now: () => clock,
      sleep: async (delay) => { clock += delay; }
    }),
    expectCode("harness_readiness_process_exited")
  );
});

test("pg_isready que nunca aprova falha fechado", async () => {
  let clock = 0;
  await assert.rejects(
    waitForReadiness({
      probes: readinessProbes({ pgIsReady: async () => false }),
      pid: 44,
      port: 64995,
      stepTimeouts: { ...DEFAULT_READINESS_TIMEOUTS, pgIsReady: 20 },
      pollMs: 5,
      now: () => clock,
      sleep: async (delay) => { clock += delay; }
    }),
    expectCode("harness_readiness_pg_isready_timeout")
  );
});

test("AbortSignal e propagado ao readiness", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    waitForReadiness({
      probes: readinessProbes(),
      pid: 44,
      port: 64995,
      signal: controller.signal
    }),
    expectCode("harness_readiness_aborted")
  );
});

test("bootstrap atrasado dentro do timeout passa", async () => {
  const actions = passingActions();
  actions["bootstrap-roles"] = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { code: "bootstrap_delayed_ok" };
  };
  const report = await runPhasedHarness({
    actions,
    timeouts: { ...DEFAULT_PHASE_TIMEOUTS, "bootstrap-roles": 50 }
  });
  assert.equal(report.ok, true);
});

test("falha no bootstrap bloqueia fases seguintes e ainda limpa", async () => {
  const actions = passingActions();
  let nextPhaseRan = false;
  let cleanupRan = false;
  actions["bootstrap-roles"] = async () => {
    throw new HarnessFailure("bootstrap_roles_expected_failure");
  };
  actions["establish-dpapi-custody"] = async () => {
    nextPhaseRan = true;
    return { code: "must_not_run" };
  };
  actions.cleanup = async () => {
    cleanupRan = true;
    return { code: "cleanup_ok" };
  };
  await assert.rejects(
    runPhasedHarness({ actions }),
    expectCode("bootstrap_roles_expected_failure")
  );
  assert.equal(nextPhaseRan, false);
  assert.equal(cleanupRan, true);
});

test("timeout parametrizado cobre cada fase sem espera longa", async () => {
  for (const phase of PHASES.slice(0, -1)) {
    const actions = passingActions();
    actions[phase] = async ({ signal }) =>
      new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    await assert.rejects(
      runPhasedHarness({
        actions,
        timeouts: { ...DEFAULT_PHASE_TIMEOUTS, [phase]: 1 },
        terminationTimeoutMs: 10,
        settlementTimeoutMs: 10
      }),
      expectCode(`${phase.replaceAll("-", "_")}_timeout`)
    );
  }
});

test("cleanup roda apos sucesso, falha e timeout proprio", async () => {
  const successful = await runPhasedHarness({ actions: passingActions() });
  assert.equal(successful.phases.at(-1).status, "passed");

  const failedActions = passingActions();
  let cleanupAfterFailure = false;
  failedActions.preflight = async () => { throw new HarnessFailure("preflight_failed"); };
  failedActions.cleanup = async () => {
    cleanupAfterFailure = true;
    return { code: "cleanup_ok" };
  };
  await assert.rejects(runPhasedHarness({ actions: failedActions }), expectCode("preflight_failed"));
  assert.equal(cleanupAfterFailure, true);

  const timedActions = passingActions();
  timedActions.cleanup = async ({ signal }) =>
    new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  await assert.rejects(
    runPhasedHarness({
      actions: timedActions,
      timeouts: { ...DEFAULT_PHASE_TIMEOUTS, cleanup: 1 },
      terminationTimeoutMs: 10,
      settlementTimeoutMs: 10
    }),
    expectCode("cleanup_timeout")
  );
});

test("termination nao confirmada possui codigo distinto", async () => {
  await assert.rejects(
    executeWithTimeout({
      phase: "bootstrap-roles",
      timeoutMs: 1,
      operation: () => new Promise((resolve) => setTimeout(resolve, 40)),
      terminateTree: async () => false,
      terminationTimeoutMs: 5,
      settlementTimeoutMs: 5
    }),
    (error) => {
      assert.equal(error.code, "bootstrap_roles_timeout_termination_unconfirmed");
      assert.equal(error.terminationConfirmed, false);
      assert.equal(error.operationSettled, false);
      return true;
    }
  );
});

test("lease bloqueia efeito tardio antes de cleanup", async () => {
  const actions = passingActions();
  let lateFailureCode = null;
  let cleanupCommitted = false;
  actions.preflight = async ({ context }) => {
    setTimeout(() => {
      try {
        context.state.lateMutation = true;
      } catch (error) {
        lateFailureCode = error.code;
      }
    }, 15);
    return new Promise((resolve) => setTimeout(resolve, 40));
  };
  actions.cleanup = async ({ context }) => {
    context.state.cleanupCommitted = true;
    cleanupCommitted = true;
    return { code: "cleanup_ok" };
  };
  await assert.rejects(
    runPhasedHarness({
      actions,
      timeouts: { ...DEFAULT_PHASE_TIMEOUTS, preflight: 1 },
      terminationTimeoutMs: 3,
      settlementTimeoutMs: 3
    }),
    expectCode("preflight_timeout_operation_unsettled")
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(lateFailureCode, "harness_phase_lease_inactive");
  assert.equal(cleanupCommitted, false);
});

test("resource journal tenta todos os recursos mesmo com falha", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-journal-best-effort-"));
  const ownershipProof = createOwnedTemporaryRoot({ parent });
  const root = ownershipProof.root;
  const proof = path.join(root, "proof.tmp");
  fs.writeFileSync(proof, "synthetic", "utf8");
  const attempted = [];
  try {
    const journal = createResourceJournal({
      ownedRoot: root,
      parent,
      ownershipProof,
      terminationTimeoutMs: 10,
      terminateProcessTree: async (pid) => {
        attempted.push(pid);
        return pid === 1001;
      }
    });
    journal.registerProcess(1001);
    journal.registerProcess(1002);
    journal.registerPath(proof);
    await assert.rejects(
      journal.cleanup(),
      (error) => {
        assert.equal(error.code, "harness_resource_cleanup_incomplete");
        assert.equal(error.cleanupResult.counts.processesAttempted, 2);
        assert.equal(error.cleanupResult.counts.processesTerminated, 1);
        assert.equal(error.cleanupResult.counts.pathsRemoved, 0);
        assert.equal(error.cleanupResult.checks.ownedRootRemoved, false);
        assert.equal(error.cleanupResult.checks.filesystemCleanupDeferred, true);
        return true;
      }
    );
    assert.deepEqual(attempted, [1002, 1001]);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("checks de evidência recusam referência opaca mesmo sob chave inocente", () => {
  assert.throws(
    () => validatePhaseResult({
      code: "synthetic_result",
      checks: { reference: "x".repeat(96) }
    }),
    expectCode("harness_evidence_check_invalid")
  );
});

test("relatório fechado recusa sequência e coerência adulteradas", async () => {
  const report = await runPhasedHarness({
    actions: passingActions(),
    timeouts: DEFAULT_PHASE_TIMEOUTS
  });
  assert.throws(
    () => assertClosedEvidenceReport({ ...report, ok: false }),
    expectCode("harness_evidence_report_coherence_invalid")
  );
  const reordered = [...report.phases];
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.throws(
    () => assertClosedEvidenceReport({ ...report, phases: reordered }),
    expectCode("harness_evidence_phase_sequence_invalid")
  );
});

test("relatório fechado e falha final não preservam segredo cru ou codificado", async () => {
  const secret = "segredo-sintetico-XyZ987";
  const encoded = encodeURIComponent(secret);
  const base64 = Buffer.from(secret).toString("base64");
  const actions = passingActions();
  actions.preflight = async () => {
    throw new Error(
      `postgresql://user:${secret}@127.0.0.1/db ${encoded} ${base64}`
    );
  };
  await assert.rejects(
    runPhasedHarness({
      actions,
      timeouts: DEFAULT_PHASE_TIMEOUTS
    }),
    (error) => {
      const serialized = JSON.stringify({
        code: error.code,
        message: error.message,
        report: error.report
      });
      assert.equal(error.code, "harness_phase_unexpected_failure");
      assert.equal(serialized.includes(secret), false);
      assert.equal(serialized.includes(encoded), false);
      assert.equal(serialized.includes(base64), false);
      assert.equal(serialized.includes("postgresql://"), false);
      return true;
    }
  );
});

test("sessão administrativa que chega após deadline é fechada", async () => {
  let closed = 0;
  const lateSession = {
    selectOne: async () => 1,
    serverVersion: async () => "18.4",
    close: async () => { closed += 1; return true; }
  };
  await assert.rejects(
    waitForReadiness({
      probes: readinessProbes({
        openAdminSession: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return lateSession;
        }
      }),
      pid: 44,
      port: 64995,
      stepTimeouts: {
        ...DEFAULT_READINESS_TIMEOUTS,
        adminConnection: 5,
        closeSession: 25
      },
      pollMs: 1
    }),
    expectCode("harness_readiness_admin_connection_probe_timeout")
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(closed, 1);
});

test("sessão administrativa inválida é fechada quando possível", async () => {
  let closed = 0;
  await assert.rejects(
    waitForReadiness({
      probes: readinessProbes({
        openAdminSession: async () => ({
          close: async () => { closed += 1; return true; }
        })
      }),
      pid: 44,
      port: 64995
    }),
    expectCode("harness_admin_session_invalid")
  );
  assert.equal(closed, 1);
});

test("resource journal recusa adotar raiz preexistente sem proof", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-unowned-"));
  const root = path.join(parent, "ia4tube-social-3a0p-preexisting");
  fs.mkdirSync(root);
  try {
    assert.throws(
      () => createResourceJournal({
        ownedRoot: root,
        parent,
        ownershipProof: { root, parent },
        terminateProcessTree: async () => true
      }),
      expectCode("harness_resource_ownership_unproven")
    );
    assert.equal(fs.existsSync(root), true);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("fabrica de raiz owned recusa parent UNC ou device antes de acessar o filesystem", () => {
  let accessed = false;
  const fileSystem = {
    lstatSync() {
      accessed = true;
      throw new Error("must_not_access");
    },
    mkdtempSync() {
      accessed = true;
      throw new Error("must_not_access");
    }
  };
  for (const parent of [
    "\\\\server\\share\\temp",
    "\\\\?\\C:\\Temp",
    "\\\\.\\C:\\Temp"
  ]) {
    assert.throws(
      () => createOwnedTemporaryRoot({ parent, fileSystem }),
      expectCode("harness_temporary_parent_invalid")
    );
  }
  assert.equal(accessed, false);
});

test("proof de raiz owned pode ser consumida uma unica vez", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-proof-once-"));
  const ownershipProof = createOwnedTemporaryRoot({ parent });
  const root = ownershipProof.root;
  try {
    const journal = createResourceJournal({
      ownedRoot: root,
      parent,
      ownershipProof,
      terminateProcessTree: async () => true
    });
    assert.throws(
      () => createResourceJournal({
        ownedRoot: root,
        parent,
        ownershipProof,
        terminateProcessTree: async () => true
      }),
      expectCode("harness_resource_ownership_unproven")
    );
    const cleanup = await journal.cleanup();
    assert.equal(cleanup.checks.ownedRootRemoved, true);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("custódia DPAPI recusa caminho fora da raiz owned", async () => {
  const material = Buffer.alloc(32, 1);
  await assert.rejects(
    establishDpapiCustody({
      material,
      ownedRoot: "C:\\Temp\\owned",
      custodyPath: "C:\\Temp\\outside\\dpapi-proof.bin",
      adapter: { protectAndVerify: async () => ({}) }
    }),
    expectCode("harness_resource_path_refused")
  );
  assert.equal(material.every((value) => value === 0), true);
});

test("timeouts inválidos falham antes de qualquer ação", async () => {
  let invoked = false;
  const actions = passingActions();
  actions.preflight = async () => { invoked = true; return { code: "unexpected" }; };
  await assert.rejects(
    runPhasedHarness({
      actions,
      timeouts: { ...DEFAULT_PHASE_TIMEOUTS, cleanup: 0 }
    }),
    expectCode("cleanup_timeout_invalid")
  );
  assert.equal(invoked, false);
});
