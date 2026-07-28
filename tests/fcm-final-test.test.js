"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  FcmFinalTestError,
  assertFinalTestAllowedOwner,
  assertFinalTestAllowedTokenFingerprint,
  assertFinalTestProductionInvariants,
  assertFinalTestSendGates,
  createFcmFinalTestRunner,
  finalTestDevicePath,
  safeFinalTestOutput
} = require("../src/notifications/fcm-final-test");
const {
  createFcmTokenCrypto
} = require("../src/notifications/fcm-token-crypto");
const {
  registerFcmToken
} = require("../src/notifications/fcm-token-store");
const {
  assertNoArguments,
  runCli
} = require("../src/notifications/fcm-final-test-cli");

const OWNER = "synthetic-final-test-owner";
const OTHER_OWNER = "synthetic-legacy-owner";
const TOKEN = "synthetic-final-test-token";
const EVENT_ID = "art_123e4567-e89b-42d3-a456-426614174000";
const OTHER_EVENT_ID =
  "art_223e4567-e89b-42d3-a456-426614174001";
const PEDIDO_ID = "20260728_021500";

function ownerSha256(owner = OWNER) {
  return crypto
    .createHash("sha256")
    .update(owner, "utf8")
    .digest("hex");
}

function tokenKeyEnv() {
  const keyId = "synthetic-final-test-v1";
  return {
    FCM_TOKEN_ACTIVE_KEY_ID: keyId,
    FCM_TOKEN_ENCRYPTION_KEYS_JSON: JSON.stringify({
      [keyId]: crypto.randomBytes(32).toString("base64url")
    }),
    FCM_TOKEN_HMAC_KEYS_JSON: JSON.stringify({
      [keyId]: crypto.randomBytes(32).toString("base64url")
    })
  };
}

function closedAutomaticGateEnv(overrides = {}) {
  return {
    FCM_TOKEN_REGISTRATION_ENABLED: "false",
    FCM_ART_READY_EVENT_ENABLED: "false",
    FCM_DELIVERY_ENABLED: "true",
    FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "false",
    FCM_STATUS_NOTIFICATIONS_ENABLED: "false",
    FCM_SCHEDULED_NOTIFICATIONS_ENABLED: "false",
    FCM_MANUAL_NOTIFICATIONS_ENABLED: "false",
    ...overrides
  };
}

function syntheticFixture() {
  const keys = tokenKeyEnv();
  const tokenCrypto = createFcmTokenCrypto({ env: keys });
  const cliente = {
    nome_time: "Synthetic Final Test",
    whatsapp: OWNER
  };
  registerFcmToken({
    cliente,
    token: TOKEN,
    tokenCrypto
  });
  const fingerprint =
    cliente.notificacoes.fcm_tokens[0].fingerprint;
  const env = closedAutomaticGateEnv({
    ...keys,
    FCM_FINAL_TEST_ALLOWED_OWNER_SHA256: ownerSha256(),
    FCM_FINAL_TEST_ALLOWED_TOKEN_FINGERPRINT: fingerprint
  });
  const device = {
    format_version: 1,
    owner_sha256: ownerSha256(),
    notificacoes: {
      fcm_tokens: cliente.notificacoes.fcm_tokens
    }
  };
  return {
    cliente,
    device,
    env,
    fingerprint,
    tokenCrypto
  };
}

function errorCode(code) {
  return (error) =>
    error instanceof FcmFinalTestError &&
    error.code === code;
}

test("owner and token allowlists fail closed without exposing values", () => {
  const { env, fingerprint } = syntheticFixture();
  assert.equal(assertFinalTestAllowedOwner(OWNER, env), OWNER);
  assert.equal(
    assertFinalTestAllowedTokenFingerprint(fingerprint, env),
    fingerprint
  );

  assert.throws(
    () => assertFinalTestAllowedOwner(OTHER_OWNER, env),
    errorCode("fcm_final_test_owner_not_allowed")
  );
  assert.throws(
    () => assertFinalTestAllowedOwner(OWNER, {}),
    errorCode("fcm_final_test_owner_allowlist_unavailable")
  );
  assert.throws(
    () => assertFinalTestAllowedTokenFingerprint(
      "A".repeat(43),
      env
    ),
    errorCode("fcm_final_test_token_not_allowed")
  );

  const safe = JSON.stringify(
    safeFinalTestOutput(
      Object.assign(
        new Error(`${OWNER}:${TOKEN}:${fingerprint}`),
        { code: `${TOKEN}:${fingerprint}` }
      )
    )
  );
  assert.equal(safe.includes(OWNER), false);
  assert.equal(safe.includes(TOKEN), false);
  assert.equal(safe.includes(fingerprint), false);
  assert.deepEqual(JSON.parse(safe), {
    ok: false,
    code: "fcm_final_test_failed",
    recipients: 0,
    sent: 0
  });
  assert.equal(
    safeFinalTestOutput({
      code: "SyntheticSecretToken123"
    }).code,
    "fcm_final_test_failed"
  );
});

test("final-test CLI gates require delivery true and every other path false", () => {
  const safe = closedAutomaticGateEnv();
  assert.equal(assertFinalTestSendGates(safe), true);

  for (const [name, value, code] of [
    [
      "FCM_DELIVERY_ENABLED",
      "false",
      "fcm_final_test_delivery_gate_closed"
    ],
    [
      "FCM_DELIVERY_ENABLED",
      "TRUE",
      "fcm_final_test_delivery_gate_closed"
    ],
    [
      "FCM_TOKEN_REGISTRATION_ENABLED",
      "true",
      "fcm_final_test_safety_gates_invalid"
    ],
    [
      "FCM_ART_READY_EVENT_ENABLED",
      "true",
      "fcm_final_test_safety_gates_invalid"
    ],
    [
      "FCM_AUTOMATIC_NOTIFICATIONS_ENABLED",
      "true",
      "fcm_final_test_safety_gates_invalid"
    ],
    [
      "FCM_STATUS_NOTIFICATIONS_ENABLED",
      "true",
      "fcm_final_test_safety_gates_invalid"
    ],
    [
      "FCM_SCHEDULED_NOTIFICATIONS_ENABLED",
      "true",
      "fcm_final_test_safety_gates_invalid"
    ],
    [
      "FCM_MANUAL_NOTIFICATIONS_ENABLED",
      "true",
      "fcm_final_test_safety_gates_invalid"
    ]
  ]) {
    assert.throws(
      () => assertFinalTestSendGates({
        ...safe,
        [name]: value
      }),
      errorCode(code)
    );
  }
});

test("production invariants are exact and reject mock or another project", () => {
  const production = {
    NODE_ENV: "production",
    DATA_DIR: "/var/data",
    FIREBASE_EXPECTED_PROJECT_ID: "ia4tubedjo",
    FCM_MOCK: "false"
  };
  assert.equal(
    assertFinalTestProductionInvariants(production),
    "/var/data"
  );
  for (const [name, value] of [
    ["NODE_ENV", "test"],
    ["DATA_DIR", "/tmp/data"],
    ["FIREBASE_EXPECTED_PROJECT_ID", "synthetic-project"],
    ["FCM_MOCK", "true"]
  ]) {
    assert.throws(
      () => assertFinalTestProductionInvariants({
        ...production,
        [name]: value
      }),
      errorCode("fcm_final_test_production_invariant_invalid")
    );
  }
});

test("runner claims one global attempt before send and never reads another owner", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-final-test-")
  );
  const { device, env, fingerprint } = syntheticFixture();
  let sends = 0;

  try {
    const runner = createFcmFinalTestRunner({
      env,
      dataDir: root,
      readTargetDevice: () => device,
      sendFinalTestArtReady: async (
        isolatedCliente,
        payload
      ) => {
        sends += 1;
        assert.equal(
          fs.existsSync(runner.ledgerPath),
          true,
          "ledger must exist before transport"
        );
        assert.equal(
          fs.readdirSync(path.dirname(runner.ledgerPath))
            .some((name) => name.endsWith(".tmp")),
          false
        );
        assert.deepEqual(payload, {
          eventId: EVENT_ID,
          pedidoId: PEDIDO_ID,
          expectedTokenFingerprint: fingerprint
        });
        assert.equal(
          isolatedCliente.notificacoes.fcm_tokens.length,
          1
        );
        assert.equal(
          isolatedCliente.notificacoes.fcm_tokens[0].fingerprint,
          fingerprint
        );
        return {
          ok: true,
          sent: 1,
          tokens: 1
        };
      }
    });

    const concurrent = await Promise.allSettled([
      runner.run({
        ownerId: OWNER,
        eventId: EVENT_ID,
        pedidoId: PEDIDO_ID
      }),
      runner.run({
        ownerId: OWNER,
        eventId: OTHER_EVENT_ID,
        pedidoId: "controlled-concurrent-order"
      })
    ]);
    const fulfilled = concurrent.filter(
      (result) => result.status === "fulfilled"
    );
    const rejected = concurrent.filter(
      (result) => result.status === "rejected"
    );
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.deepEqual(fulfilled[0].value, {
      ok: true,
      code: "fcm_final_test_sent",
      recipients: 1,
      sent: 1
    });
    assert.equal(
      errorCode("fcm_final_test_run_already_claimed")(
        rejected[0].reason
      ),
      true
    );
    assert.equal(sends, 1);

    const ledgerText = fs.readFileSync(runner.ledgerPath, "utf8");
    assert.equal(ledgerText.includes(OWNER), false);
    assert.equal(ledgerText.includes(TOKEN), false);
    assert.equal(ledgerText.includes(fingerprint), false);
    assert.deepEqual(
      JSON.parse(ledgerText).claim,
      {
        event_id: EVENT_ID,
        pedido_id: PEDIDO_ID,
        reserved_at: JSON.parse(ledgerText).claim.reserved_at,
        state: "claimed"
      }
    );
    await assert.rejects(
      runner.run({
        ownerId: OWNER,
        eventId: OTHER_EVENT_ID,
        pedidoId: "different-controlled-order"
      }),
      errorCode("fcm_final_test_run_already_claimed")
    );
    assert.equal(sends, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("uncertain delivery remains durably claimed after a transport crash", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-final-test-crash-")
  );
  const { device, env } = syntheticFixture();
  let sends = 0;

  try {
    const runner = createFcmFinalTestRunner({
      env,
      dataDir: root,
      readTargetDevice: () => device,
      sendFinalTestArtReady: async () => {
        sends += 1;
        assert.equal(fs.existsSync(runner.ledgerPath), true);
        throw new Error("synthetic-network-outcome-unknown");
      }
    });
    await assert.rejects(
      runner.run({
        ownerId: OWNER,
        eventId: EVENT_ID,
        pedidoId: PEDIDO_ID
      }),
      errorCode("fcm_final_test_delivery_outcome_uncertain")
    );
    assert.equal(sends, 1);

    await assert.rejects(
      runner.run({
        ownerId: OWNER,
        eventId: OTHER_EVENT_ID,
        pedidoId: "controlled-second-order"
      }),
      errorCode("fcm_final_test_run_already_claimed")
    );
    assert.equal(sends, 1);
    assert.equal(
      JSON.parse(
        fs.readFileSync(runner.ledgerPath, "utf8")
      ).claim.state,
      "claimed"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ledger persistence failure happens before transport and leaves no partial claim", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-final-test-ledger-fail-")
  );
  const { device, env } = syntheticFixture();
  const failingFileSystem = Object.create(fs);
  let sends = 0;
  failingFileSystem.renameSync = (source, target) => {
    if (String(target).endsWith("fcm-final-test-ledger.json")) {
      const error = new Error("synthetic-ledger-rename-failure");
      error.code = "EIO";
      throw error;
    }
    return fs.renameSync(source, target);
  };

  try {
    const runner = createFcmFinalTestRunner({
      env,
      dataDir: root,
      fileSystem: failingFileSystem,
      readTargetDevice: () => device,
      sendFinalTestArtReady: async () => {
        sends += 1;
        return { ok: true, sent: 1, tokens: 1 };
      }
    });
    await assert.rejects(
      runner.run({
        ownerId: OWNER,
        eventId: EVENT_ID,
        pedidoId: PEDIDO_ID
      })
    );
    assert.equal(sends, 0);
    assert.equal(fs.existsSync(runner.ledgerPath), false);
    assert.deepEqual(
      fs.existsSync(path.dirname(runner.ledgerPath))
        ? fs.readdirSync(path.dirname(runner.ledgerPath))
            .filter((name) => name.endsWith(".tmp"))
        : [],
      []
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default reader ignores synthetic legacy records belonging to another owner", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-final-test-json-")
  );
  const { device, env } = syntheticFixture();
  const legacyToken = "synthetic-other-owner-legacy";
  fs.mkdirSync(path.join(root, "notifications"), {
    recursive: true
  });
  fs.writeFileSync(
    path.join(root, "clientes.json"),
    `{malformed:${legacyToken}}`,
    "utf8"
  );
  fs.writeFileSync(
    finalTestDevicePath(root),
    JSON.stringify(device),
    "utf8"
  );
  let sends = 0;

  try {
    const runner = createFcmFinalTestRunner({
      env,
      dataDir: root,
      sendFinalTestArtReady: async () => {
        sends += 1;
        return { ok: true, sent: 1, tokens: 1 };
      }
    });
    const result = await runner.run({
      ownerId: OWNER,
      eventId: EVENT_ID,
      pedidoId: PEDIDO_ID
    });
    assert.equal(result.ok, true);
    assert.equal(sends, 1);
    const ledger = fs.readFileSync(runner.ledgerPath, "utf8");
    assert.equal(ledger.includes(legacyToken), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runner rejects wrong owner, fingerprint, token count and target legacy before send", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-final-test-reject-")
  );
  const { cliente, device, env } = syntheticFixture();
  let sends = 0;
  const send = async () => {
    sends += 1;
    return { ok: true, sent: 1, tokens: 1 };
  };

  try {
    const wrongOwnerRunner = createFcmFinalTestRunner({
      env,
      dataDir: root,
      readTargetDevice: () => device,
      sendFinalTestArtReady: send
    });
    await assert.rejects(
      wrongOwnerRunner.run({
        ownerId: OTHER_OWNER,
        eventId: EVENT_ID,
        pedidoId: PEDIDO_ID
      }),
      errorCode("fcm_final_test_owner_not_allowed")
    );

    const ownerRecordMismatchRunner = createFcmFinalTestRunner({
      env,
      dataDir: root,
      readTargetDevice: () => ({
        ...device,
        owner_sha256: ownerSha256(OTHER_OWNER)
      }),
      sendFinalTestArtReady: send
    });
    await assert.rejects(
      ownerRecordMismatchRunner.run({
        ownerId: OWNER,
        eventId: EVENT_ID,
        pedidoId: PEDIDO_ID
      }),
      errorCode("fcm_final_test_owner_record_mismatch")
    );

    const wrongFingerprintRunner = createFcmFinalTestRunner({
      env: {
        ...env,
        FCM_FINAL_TEST_ALLOWED_TOKEN_FINGERPRINT: "A".repeat(43)
      },
      dataDir: root,
      readTargetDevice: () => device,
      sendFinalTestArtReady: send
    });
    await assert.rejects(
      wrongFingerprintRunner.run({
        ownerId: OWNER,
        eventId: EVENT_ID,
        pedidoId: PEDIDO_ID
      }),
      errorCode("fcm_final_test_token_not_allowed")
    );

    const multipleRunner = createFcmFinalTestRunner({
      env,
      dataDir: root,
      readTargetDevice: () => device,
      listActiveTokenRecords: () => [
        { fingerprint: "A".repeat(43) },
        { fingerprint: "B".repeat(43) }
      ],
      sendFinalTestArtReady: send
    });
    await assert.rejects(
      multipleRunner.run({
        ownerId: OWNER,
        eventId: EVENT_ID,
        pedidoId: PEDIDO_ID
      }),
      errorCode("fcm_final_test_active_token_count_invalid")
    );

    const extraStoredRecordRunner = createFcmFinalTestRunner({
      env,
      dataDir: root,
      readTargetDevice: () => ({
        ...device,
        notificacoes: {
          fcm_tokens: [
            cliente.notificacoes.fcm_tokens[0],
            {
              ...cliente.notificacoes.fcm_tokens[0],
              ativo: false
            }
          ]
        }
      }),
      sendFinalTestArtReady: send
    });
    await assert.rejects(
      extraStoredRecordRunner.run({
        ownerId: OWNER,
        eventId: EVENT_ID,
        pedidoId: PEDIDO_ID
      }),
      errorCode("fcm_final_test_active_token_count_invalid")
    );

    const wrongPlatformRunner = createFcmFinalTestRunner({
      env,
      dataDir: root,
      readTargetDevice: () => device,
      listActiveTokenRecords: () => [{
        fingerprint:
          cliente.notificacoes.fcm_tokens[0].fingerprint,
        ativo: true,
        platform: "ios"
      }],
      sendFinalTestArtReady: send
    });
    await assert.rejects(
      wrongPlatformRunner.run({
        ownerId: OWNER,
        eventId: EVENT_ID,
        pedidoId: PEDIDO_ID
      }),
      errorCode("fcm_final_test_token_record_invalid")
    );

    const activeRecord =
      cliente.notificacoes.fcm_tokens[0];
    const inactiveRunner = createFcmFinalTestRunner({
      env,
      dataDir: root,
      readTargetDevice: () => device,
      listActiveTokenRecords: () => [{
        ...activeRecord,
        ativo: false
      }],
      sendFinalTestArtReady: send
    });
    await assert.rejects(
      inactiveRunner.run({
        ownerId: OWNER,
        eventId: EVENT_ID,
        pedidoId: PEDIDO_ID
      }),
      errorCode("fcm_final_test_token_record_invalid")
    );

    const wrongKeyIdRunner = createFcmFinalTestRunner({
      env: {
        ...env,
        FCM_TOKEN_ACTIVE_KEY_ID: "different-key-id"
      },
      dataDir: root,
      readTargetDevice: () => device,
      listActiveTokenRecords: () => [{ ...activeRecord }],
      sendFinalTestArtReady: send
    });
    await assert.rejects(
      wrongKeyIdRunner.run({
        ownerId: OWNER,
        eventId: EVENT_ID,
        pedidoId: PEDIDO_ID
      }),
      errorCode("fcm_final_test_token_key_id_mismatch")
    );

    const targetLegacyRunner = createFcmFinalTestRunner({
      env,
      dataDir: root,
      readTargetDevice: () => ({
        format_version: 1,
        owner_sha256: ownerSha256(),
        notificacoes: {
          fcm_tokens: [{
            token: "synthetic-legacy-target",
            ativo: true
          }]
        }
      }),
      sendFinalTestArtReady: send
    });
    await assert.rejects(
      targetLegacyRunner.run({
        ownerId: OWNER,
        eventId: EVENT_ID,
        pedidoId: PEDIDO_ID
      }),
      errorCode("fcm_final_test_token_storage_unavailable")
    );
    assert.equal(sends, 0);
    assert.equal(
      fs.existsSync(
        path.join(
          root,
          "notifications",
          "fcm-final-test-ledger.json"
        )
      ),
      false
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exported sender has no NODE_ENV test or alternate data-dir bypass", async () => {
  const fixture = syntheticFixture();
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-final-test-service-")
  );
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const env = {
    ...fixture.env,
    NODE_ENV: "test",
    DATA_DIR: root,
    FIREBASE_EXPECTED_PROJECT_ID: "synthetic-final-project",
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: "synthetic-final-project",
      client_email: "synthetic-final@example.invalid",
      private_key: privateKey
    }),
    GOOGLE_APPLICATION_CREDENTIALS: "",
    FIREBASE_PROJECT_ID: "",
    FIREBASE_CLIENT_EMAIL: "",
    FIREBASE_PRIVATE_KEY: "",
    FCM_MOCK: ""
  };
  const envNames = Object.keys(env);
  const previous = new Map(
    envNames.map((name) => [name, process.env[name]])
  );
  for (const [name, value] of Object.entries(env)) {
    process.env[name] = String(value);
  }

  const servicePath = require.resolve(
    "../src/notifications/fcm.service"
  );
  delete require.cache[servicePath];
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    throw new Error("synthetic-network-must-not-run");
  };

  try {
    const service = require(servicePath);
    assert.equal(
      Object.hasOwn(
        service,
        "sendClaimedFinalTestArtReadyToClient"
      ),
      false
    );
    await assert.rejects(
      service.runFinalTestArtReady({
        ownerId: OWNER,
        eventId: EVENT_ID,
        pedidoId: PEDIDO_ID,
        dataDir: "/var/data"
      }),
      errorCode("fcm_final_test_production_invariant_invalid")
    );
    assert.equal(requests, 0);

    assert.equal(
      fs.existsSync(
        path.join(
          root,
          "notifications",
          "fcm-final-test-ledger.json"
        )
      ),
      false
    );
  } finally {
    global.fetch = originalFetch;
    delete require.cache[servicePath];
    for (const [name, value] of previous.entries()) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI accepts no alternate arguments and prints no supplied secret on failure", async () => {
  assert.equal(assertNoArguments([]), true);
  assert.throws(
    () => assertNoArguments(["--event-id", EVENT_ID]),
    errorCode("fcm_final_test_argument_invalid")
  );

  let output = "";
  const exitCode = await runCli({
    argv: [],
    env: {
      NODE_ENV: "development",
      DATA_DIR: "/var/data",
      FIREBASE_EXPECTED_PROJECT_ID: "ia4tubedjo",
      FCM_FINAL_TEST_OWNER_ID: OWNER,
      FCM_FINAL_TEST_ALLOWED_OWNER_SHA256: ownerSha256(),
      FCM_FINAL_TEST_ALLOWED_TOKEN_FINGERPRINT: TOKEN
    },
    output: {
      write(value) {
        output += String(value);
      }
    }
  });
  assert.equal(exitCode, 1);
  assert.equal(output.includes(OWNER), false);
  assert.equal(output.includes(TOKEN), false);
  assert.deepEqual(JSON.parse(output), {
    ok: false,
    code: "fcm_final_test_production_invariant_invalid",
    recipients: 0,
    sent: 0
  });

  output = "";
  const argumentExitCode = await runCli({
    argv: ["--event-id", `${EVENT_ID}:${TOKEN}`],
    env: {
      NODE_ENV: "production",
      DATA_DIR: "/var/data",
      FIREBASE_EXPECTED_PROJECT_ID: "ia4tubedjo"
    },
    output: {
      write(value) {
        output += String(value);
      }
    }
  });
  assert.equal(argumentExitCode, 1);
  assert.equal(output.includes(EVENT_ID), false);
  assert.equal(output.includes(TOKEN), false);
  assert.deepEqual(JSON.parse(output), {
    ok: false,
    code: "fcm_final_test_argument_invalid",
    recipients: 0,
    sent: 0
  });

  output = "";
  const closedGateExitCode = await runCli({
    argv: [],
    env: {
      NODE_ENV: "production",
      DATA_DIR: "/var/data",
      FIREBASE_EXPECTED_PROJECT_ID: "ia4tubedjo",
      FCM_MOCK: "false",
      FCM_DELIVERY_ENABLED: "false",
      FCM_TOKEN_REGISTRATION_ENABLED: "false",
      FCM_ART_READY_EVENT_ENABLED: "false",
      FCM_AUTOMATIC_NOTIFICATIONS_ENABLED: "false",
      FCM_STATUS_NOTIFICATIONS_ENABLED: "false",
      FCM_SCHEDULED_NOTIFICATIONS_ENABLED: "false",
      FCM_MANUAL_NOTIFICATIONS_ENABLED: "false",
      FIREBASE_SERVICE_ACCOUNT_JSON:
        `malformed-secret-${TOKEN}`
    },
    output: {
      write(value) {
        output += String(value);
      }
    }
  });
  assert.equal(closedGateExitCode, 1);
  assert.equal(output.includes(TOKEN), false);
  assert.deepEqual(JSON.parse(output), {
    ok: false,
    code: "fcm_final_test_delivery_gate_closed",
    recipients: 0,
    sent: 0
  });
});
