"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { HarnessFailure } = require("../scripts/social-3a0p-local-harness-core");
const {
  assertProcessEnvironment,
  assertSafeArguments,
  createProcessRunner,
  createSecretRegistry,
  sanitizeProcessText,
  terminateProcessTree
} = require("../scripts/social-3a0p-local-process");

const APPROVED_EXECUTABLE = path.resolve("C:\\tools\\approved.exe");
const WORKING_DIRECTORY = path.resolve("C:\\Temp\\ia4tube-social-3a0p-unit");

function expectCode(code) {
  return (error) => error instanceof HarnessFailure && error.code === code;
}

function fakeChild(pid = 7788) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test("argumentos contendo URL ou segredo são recusados antes do spawn", () => {
  for (const argument of [
    "postgresql://user:pass@example/db",
    "password=value",
    "Authorization: Bearer value",
    "token=abc"
  ]) {
    assert.throws(
      () => assertSafeArguments([argument]),
      expectCode("harness_process_sensitive_argument_refused")
    );
  }
});

test("NODE_PATH e variável ambiente não allowlisted são recusados", () => {
  assert.throws(
    () => assertProcessEnvironment({ NODE_PATH: "C:\\modules" }, []),
    expectCode("harness_process_node_path_refused")
  );
  assert.throws(
    () => assertProcessEnvironment({ PGHOST: "ambient" }, []),
    expectCode("harness_process_environment_key_refused")
  );
  assert.equal(
    assertProcessEnvironment(
      { PATH: "C:\\Windows", PGHOST: "127.0.0.1" },
      ["PGHOST"]
    ),
    true
  );
});

test("sanitização separada remove URL, bearer e senha", () => {
  const sanitized = sanitizeProcessText(
    "postgresql://user:pass@example/db Authorization=Bearer abc.def password=hunter2"
  );
  assert.doesNotMatch(sanitized, /user:pass|abc\.def|hunter2/);
  assert.match(sanitized, /redacted/);
});

test("runner recusa executável fora da allowlist", async () => {
  const runner = createProcessRunner({
    allowedExecutables: [APPROVED_EXECUTABLE],
    spawnImpl: () => {
      throw new Error("must not spawn");
    }
  });
  await assert.rejects(
    runner.run({
      executable: path.resolve("C:\\tools\\other.exe"),
      environment: { PATH: "C:\\Windows" },
      cwd: WORKING_DIRECTORY,
      timeoutMs: 100
    }),
    expectCode("harness_process_executable_refused")
  );
});

test("runner registra PID, captura canais sanitizados e encerra normalmente", async () => {
  const child = fakeChild();
  const registered = [];
  const unregistered = [];
  const runner = createProcessRunner({
    allowedExecutables: [APPROVED_EXECUTABLE],
    resourceJournal: {
      registerProcess: (pid) => registered.push(pid),
      unregisterProcess: (pid) => unregistered.push(pid)
    },
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stdout.write("status ok password=hidden");
        child.stderr.write("postgresql://user:pass@example/db");
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    }
  });
  const result = await runner.run({
    executable: APPROVED_EXECUTABLE,
    args: ["--status"],
    environment: { PATH: "C:\\Windows", NODE_ENV: "test" },
    allowedEnvironmentNames: ["NODE_ENV"],
    cwd: WORKING_DIRECTORY,
    timeoutMs: 1_000,
    input: Buffer.from("synthetic-stdin", "utf8"),
    label: "synthetic_process"
  });
  assert.deepEqual(registered, [7788]);
  assert.deepEqual(unregistered, [7788]);
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.stdoutSanitized, /hidden/);
  assert.doesNotMatch(result.stderrSanitized, /user:pass/);
});

test("resource journal receives a live child ownership proof that closes with the child", async () => {
  const child = fakeChild(7799);
  let proof;
  const runner = createProcessRunner({
    allowedExecutables: [APPROVED_EXECUTABLE],
    spawnImpl: () => child,
    resourceJournal: {
      registerProcess(pid, candidate) {
        assert.equal(pid, 7799);
        proof = candidate;
      },
      unregisterProcess() {}
    }
  });

  const pending = runner.run({
    executable: APPROVED_EXECUTABLE,
    environment: { PATH: "C:\\Windows" },
    cwd: WORKING_DIRECTORY,
    timeoutMs: 1_000,
    label: "owned_process"
  });
  assert.equal(proof.pid, 7799);
  assert.equal(proof.executablePath, APPROVED_EXECUTABLE.toLowerCase());
  assert.equal(proof.isOriginalProcessActive(), true);

  child.emit("close", 0, null);
  await pending;
  assert.equal(proof.isOriginalProcessActive(), false);
});

test("timeout encerra exatamente a árvore do PID registrado", async () => {
  const child = fakeChild(9911);
  const terminated = [];
  const registered = [];
  const unregistered = [];
  const runner = createProcessRunner({
    allowedExecutables: [APPROVED_EXECUTABLE],
    spawnImpl: () => child,
    terminateTree: async (pid) => {
      terminated.push(pid);
      return true;
    },
    resourceJournal: {
      registerProcess: (pid) => registered.push(pid),
      unregisterProcess: (pid) => unregistered.push(pid)
    }
  });
  await assert.rejects(
    runner.run({
      executable: APPROVED_EXECUTABLE,
      environment: { PATH: "C:\\Windows" },
      cwd: WORKING_DIRECTORY,
      timeoutMs: 15,
      label: "blocked_process"
    }),
    (error) => {
      assert.equal(error.code, "blocked_process_timeout");
      assert.equal(error.terminationConfirmed, true);
      return true;
    }
  );
  assert.deepEqual(registered, [9911]);
  assert.deepEqual(terminated, [9911]);
  assert.deepEqual(unregistered, [9911]);
});

test("AbortSignal já cancelado recusa o subprocesso antes do spawn", async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  const runner = createProcessRunner({
    allowedExecutables: [APPROVED_EXECUTABLE],
    spawnImpl: () => {
      spawned = true;
      return fakeChild(9913);
    }
  });
  await assert.rejects(
    runner.run({
      executable: APPROVED_EXECUTABLE,
      environment: { PATH: "C:\\Windows" },
      cwd: WORKING_DIRECTORY,
      timeoutMs: 1_000,
      signal: controller.signal,
      label: "cancelled_process"
    }),
    expectCode("cancelled_process_aborted")
  );
  assert.equal(spawned, false);
});

test("AbortSignal durante a execução encerra a árvore e confirma o PID", async () => {
  const controller = new AbortController();
  const child = fakeChild(9914);
  const terminated = [];
  const registered = [];
  const unregistered = [];
  const runner = createProcessRunner({
    allowedExecutables: [APPROVED_EXECUTABLE],
    spawnImpl: () => child,
    terminateTree: async (pid) => {
      terminated.push(pid);
      return true;
    },
    resourceJournal: {
      registerProcess: (pid) => registered.push(pid),
      unregisterProcess: (pid) => unregistered.push(pid)
    }
  });
  const pending = runner.run({
    executable: APPROVED_EXECUTABLE,
    environment: { PATH: "C:\\Windows" },
    cwd: WORKING_DIRECTORY,
    timeoutMs: 1_000,
    signal: controller.signal,
    label: "cancelled_process"
  });
  controller.abort();
  await assert.rejects(pending, expectCode("cancelled_process_aborted"));
  assert.deepEqual(registered, [9914]);
  assert.deepEqual(terminated, [9914]);
  assert.deepEqual(unregistered, [9914]);
});

test("PID inválido após spawn encerra o filho antes de falhar", async () => {
  const child = fakeChild(0);
  child.kill = () => {
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  };
  const runner = createProcessRunner({
    allowedExecutables: [APPROVED_EXECUTABLE],
    spawnImpl: () => child,
    terminationTimeoutMs: 100
  });
  await assert.rejects(
    runner.run({
      executable: APPROVED_EXECUTABLE,
      environment: { PATH: "C:\\Windows" },
      cwd: WORKING_DIRECTORY,
      timeoutMs: 100,
      label: "invalid_pid"
    }),
    expectCode("invalid_pid_pid_invalid")
  );
});

test("falha ao registrar PID encerra a árvore ainda não monitorada", async () => {
  const child = fakeChild(8822);
  const terminated = [];
  const runner = createProcessRunner({
    allowedExecutables: [APPROVED_EXECUTABLE],
    spawnImpl: () => child,
    terminateTree: async (pid) => {
      terminated.push(pid);
      return true;
    },
    resourceJournal: {
      registerProcess: () => {
        throw new Error("closed journal");
      }
    }
  });
  await assert.rejects(
    runner.run({
      executable: APPROVED_EXECUTABLE,
      environment: { PATH: "C:\\Windows" },
      cwd: WORKING_DIRECTORY,
      timeoutMs: 100,
      label: "journal"
    }),
    expectCode("journal_journal_registration_failed")
  );
  assert.deepEqual(terminated, [8822]);
});

test("erro pós-spawn encerra a árvore antes de remover o PID do journal", async () => {
  const child = fakeChild(8833);
  const terminated = [];
  const unregistered = [];
  const runner = createProcessRunner({
    allowedExecutables: [APPROVED_EXECUTABLE],
    spawnImpl: () => {
      queueMicrotask(() => child.emit("error", new Error("synthetic")));
      return child;
    },
    terminateTree: async (pid) => {
      terminated.push(pid);
      return true;
    },
    resourceJournal: {
      registerProcess: () => {},
      unregisterProcess: (pid) => unregistered.push(pid)
    }
  });
  await assert.rejects(
    runner.run({
      executable: APPROVED_EXECUTABLE,
      environment: { PATH: "C:\\Windows" },
      cwd: WORKING_DIRECTORY,
      timeoutMs: 100,
      label: "post_spawn"
    }),
    expectCode("post_spawn_spawn_failed")
  );
  assert.deepEqual(terminated, [8833]);
  assert.deepEqual(unregistered, [8833]);
});

test("terminador Windows usa taskkill por PID com árvore e força", async () => {
  let invocation;
  const result = await terminateProcessTree(3210, {
    platform: "win32",
    taskkillPath: "C:\\Windows\\System32\\taskkill.exe",
    execFileImpl: (file, args, options, callback) => {
      invocation = { file, args, options };
      callback(null, "", "");
    }
  });
  assert.equal(result, true);
  assert.equal(invocation.file, "C:\\Windows\\System32\\taskkill.exe");
  assert.deepEqual(invocation.args, ["/PID", "3210", "/T", "/F"]);
  assert.equal(invocation.options.windowsHide, true);
});

test("saída é truncada sem ultrapassar limite", () => {
  const output = sanitizeProcessText("x".repeat(1_000), 128);
  assert.match(output, /\[truncated\]$/);
  assert.ok(Buffer.byteLength(output, "utf8") <= 140);
});

test("registry explicito redige segredo cru, URL-encoded e base64", () => {
  const secret = "S3nh@ runtime/com espaco";
  const registry = createSecretRegistry([secret]);
  const output = sanitizeProcessText(
    [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")].join(" "),
    4_096,
    registry
  );
  assert.doesNotMatch(output, /S3nh@|S3nh%40|UzNuaEA/);
  assert.equal((output.match(/\[scrubbed\]/g) || []).length, 3);
});

test("registry aceita material binario e redige base64, base64url e hex", () => {
  const material = Buffer.from([0, 255, 1, 2, 3, 4, 128, 64]);
  const registry = createSecretRegistry([material]);
  const output = sanitizeProcessText(
    [
      material.toString("base64"),
      material.toString("base64url"),
      material.toString("hex")
    ].join(" "),
    4_096,
    registry
  );
  assert.doesNotMatch(output, /AP8BAgMEgEA|00ff010203048040/i);
  assert.equal((output.match(/\[scrubbed\]/g) || []).length, 3);
});

test("runner redige segredo dividido entre chunks antes de truncar", async () => {
  const secret = "segredo-runtime-sintetico-ABC123";
  const child = fakeChild(8123);
  const runner = createProcessRunner({
    allowedExecutables: [APPROVED_EXECUTABLE],
    secretRegistry: createSecretRegistry([secret]),
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stdout.write("prefixo segredo-runtime-");
        child.stdout.write("sintetico-ABC123 sufixo");
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    }
  });
  const result = await runner.run({
    executable: APPROVED_EXECUTABLE,
    environment: { PATH: "C:\\Windows" },
    cwd: WORKING_DIRECTORY,
    timeoutMs: 1_000,
    label: "split_secret"
  });
  assert.doesNotMatch(result.stdoutSanitized, /segredo-runtime|ABC123/);
  assert.match(result.stdoutSanitized, /\[scrubbed\]/);
});

test("runner redige material sensivel exclusivo de uma invocacao", async () => {
  const secret = "material-efemero-sintetico-XYZ789";
  const child = fakeChild(8124);
  const runner = createProcessRunner({
    allowedExecutables: [APPROVED_EXECUTABLE],
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stdout.write(`eco ${secret}`);
        child.stderr.write(Buffer.from(secret).toString("base64"));
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    }
  });
  const result = await runner.run({
    executable: APPROVED_EXECUTABLE,
    environment: { PATH: "C:\\Windows" },
    cwd: WORKING_DIRECTORY,
    timeoutMs: 1_000,
    label: "per_run_secret",
    secretValues: [secret]
  });
  assert.doesNotMatch(result.stdoutSanitized, /material-efemero|XYZ789/);
  assert.doesNotMatch(result.stderrSanitized, /bWF0ZXJpYWwt/);
  assert.match(result.stdoutSanitized, /\[scrubbed\]/);
  assert.match(result.stderrSanitized, /\[scrubbed\]/);
});

test("registry por invocacao invalido falha antes do spawn", async () => {
  let spawned = false;
  const runner = createProcessRunner({
    allowedExecutables: [APPROVED_EXECUTABLE],
    spawnImpl: () => {
      spawned = true;
      return fakeChild(8125);
    }
  });
  await assert.rejects(
    runner.run({
      executable: APPROVED_EXECUTABLE,
      environment: { PATH: "C:\\Windows" },
      cwd: WORKING_DIRECTORY,
      timeoutMs: 1_000,
      label: "invalid_per_run_secret",
      secretValues: ["x"]
    }),
    expectCode("harness_process_secret_registry_value_invalid")
  );
  assert.equal(spawned, false);
});

test("timeout sem confirmacao de termino usa codigo distinto", async () => {
  const child = fakeChild(9912);
  let ownershipProof;
  const unregistered = [];
  const runner = createProcessRunner({
    allowedExecutables: [APPROVED_EXECUTABLE],
    spawnImpl: () => child,
    terminateTree: async () => false,
    resourceJournal: {
      registerProcess: (_pid, proof) => { ownershipProof = proof; },
      unregisterProcess: (pid) => unregistered.push(pid)
    }
  });
  await assert.rejects(
    runner.run({
      executable: APPROVED_EXECUTABLE,
      environment: { PATH: "C:\\Windows" },
      cwd: WORKING_DIRECTORY,
      timeoutMs: 5,
      label: "blocked_process"
    }),
    (error) => {
      assert.equal(error.code, "blocked_process_timeout_termination_unconfirmed");
      assert.equal(error.terminationConfirmed, false);
      return true;
    }
  );
  assert.deepEqual(unregistered, []);
  assert.equal(ownershipProof.isOriginalProcessActive(), true);

  child.emit("close", null, "SIGTERM");
  assert.equal(ownershipProof.isOriginalProcessActive(), false);
  assert.deepEqual(unregistered, [9912]);
});

for (const channel of ["stdin", "stdout", "stderr"]) {
  test(`erro assincrono em ${channel} encerra arvore e preserva codigo`, async () => {
    const child = fakeChild(9000 + channel.length);
    const terminated = [];
    const runner = createProcessRunner({
      allowedExecutables: [APPROVED_EXECUTABLE],
      spawnImpl: () => {
        queueMicrotask(() => child[channel].emit("error", new Error("sensitive")));
        return child;
      },
      terminateTree: async (pid) => {
        terminated.push(pid);
        return true;
      }
    });
    await assert.rejects(
      runner.run({
        executable: APPROVED_EXECUTABLE,
        environment: { PATH: "C:\\Windows" },
        cwd: WORKING_DIRECTORY,
        timeoutMs: 1_000,
        label: "stream_probe"
      }),
      expectCode(`stream_probe_${channel}_failed`)
    );
    assert.deepEqual(terminated, [child.pid]);
  });
}
