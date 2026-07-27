"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createArtReadyNotificationService,
  createGenerationId
} = require("../src/notifications/art-ready-notification.service");
const {
  successfulCompletionTransition
} = require("../src/notifications/art-ready-generation");
const {
  createArtReadyOutbox
} = require("../src/notifications/art-ready-outbox");
const {
  activeEncryptedFcmTokenRecords,
  registerFcmToken
} = require("../src/notifications/fcm-token-store");
const {
  createFcmTokenCrypto
} = require("../src/notifications/fcm-token-crypto");

function syntheticCryptoEnv() {
  const activeKeyId = "synthetic-v1";
  return {
    FCM_TOKEN_ACTIVE_KEY_ID: activeKeyId,
    FCM_TOKEN_ENCRYPTION_KEYS_JSON: JSON.stringify({
      [activeKeyId]: crypto.randomBytes(32).toString("base64url")
    }),
    FCM_TOKEN_HMAC_KEYS_JSON: JSON.stringify({
      [activeKeyId]: crypto.randomBytes(32).toString("base64url")
    })
  };
}

function syntheticClient(token, tokenCrypto, active = true) {
  const cliente = {};
  registerFcmToken({
    cliente,
    token,
    tokenCrypto,
    now: "2026-07-27T12:00:00.000Z"
  });
  if (!active) {
    cliente.notificacoes.fcm_tokens[0].ativo = false;
  }
  return cliente;
}

function eventRecords(outboxPath) {
  if (!fs.existsSync(outboxPath)) return [];
  const parsed = JSON.parse(fs.readFileSync(outboxPath, "utf8"));
  return Object.values(parsed.events || {});
}

function createHarness({
  root,
  clientes,
  tokenCrypto,
  delivery = false,
  automatic = false,
  sender,
  outboxPath = path.join(root, "notifications", "art-ready-outbox.json")
}) {
  const counters = {
    decryptions: 0,
    oauth: 0,
    external: 0,
    transport: 0,
    notifications: 0
  };
  const validatingCrypto = {
    ...tokenCrypto,
    decryptToken(record) {
      counters.decryptions += 1;
      return tokenCrypto.decryptToken(record);
    }
  };

  const service = createArtReadyNotificationService({
    outboxPath,
    deliveryEnabled: () => delivery,
    automaticNotificationsEnabled: () => automatic,
    getClienteByOwner: (ownerId) => clientes[ownerId] || null,
    listActiveTokenRecords: (cliente) =>
      activeEncryptedFcmTokenRecords({
        cliente,
        tokenCrypto: validatingCrypto
      }),
    sendToClient: sender || (async () => {
      counters.transport += 1;
      throw new Error("synthetic_transport_must_not_run");
    })
  });

  return {
    counters,
    outboxPath,
    service
  };
}

async function assertRejectedCode(callback, code) {
  await assert.rejects(
    callback,
    (error) => error?.code === code
  );
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-art-ready-"));
  const markerPath = path.join(root, "preexisting-marker.bin");
  const marker = crypto.randomBytes(128);
  fs.writeFileSync(markerPath, marker);
  const markerHashBefore = crypto
    .createHash("sha256")
    .update(fs.readFileSync(markerPath))
    .digest("hex");

  try {
    const tokenA = "synthetic-token-company-a-never-log";
    const tokenB = "synthetic-token-company-b-never-log";
    const tokenCrypto = createFcmTokenCrypto({
      env: syntheticCryptoEnv()
    });
    const clienteA = syntheticClient(tokenA, tokenCrypto);
    const clienteB = syntheticClient(tokenB, tokenCrypto);
    const clientes = {
      "synthetic-company-a": clienteA,
      "synthetic-company-b": clienteB
    };

    assert.strictEqual(
      Object.hasOwn(clienteA.notificacoes.fcm_tokens[0], "token"),
      false
    );

    const generationA = createGenerationId();
    const firstTransition = successfulCompletionTransition({
      previousStatus: "processando",
      previousOrderStatus: "em_producao",
      existingGenerationId: "",
      createGenerationId
    });
    assert.strictEqual(firstTransition.transitioned, true);
    const repeatedTransition = successfulCompletionTransition({
      previousStatus: "pronto",
      previousOrderStatus: "pronto",
      existingGenerationId: firstTransition.generationId,
      createGenerationId
    });
    assert.strictEqual(repeatedTransition.transitioned, false);
    assert.strictEqual(
      repeatedTransition.generationId,
      firstTransition.generationId
    );
    const revisionTransition = successfulCompletionTransition({
      previousStatus: "ajuste_pendente",
      previousOrderStatus: "ajuste_pendente",
      existingGenerationId: firstTransition.generationId,
      createGenerationId
    });
    assert.strictEqual(revisionTransition.transitioned, true);
    assert.notStrictEqual(
      revisionTransition.generationId,
      firstTransition.generationId
    );

    const harness = createHarness({
      root,
      clientes,
      tokenCrypto
    });

    const first = await harness.service.handleCompletion({
      generationId: generationA,
      ownerId: "synthetic-company-a"
    });
    assert.strictEqual(first.code, "art_ready_blocked");
    assert.strictEqual(first.recipients, 1);
    assert.strictEqual(first.blocked, 1);
    assert.strictEqual(first.sent, 0);
    assert.strictEqual(eventRecords(harness.outboxPath).length, 1);
    assert.strictEqual(eventRecords(harness.outboxPath)[0].state, "blocked");

    const repeated = await harness.service.handleCompletion({
      generationId: generationA,
      ownerId: "synthetic-company-a"
    });
    assert.strictEqual(repeated.sent, 0);
    assert.strictEqual(eventRecords(harness.outboxPath).length, 1);

    const restarted = createHarness({
      root,
      clientes,
      tokenCrypto,
      outboxPath: harness.outboxPath
    });
    await restarted.service.handleCompletion({
      generationId: generationA,
      ownerId: "synthetic-company-a"
    });
    assert.strictEqual(eventRecords(harness.outboxPath).length, 1);
    assert.strictEqual(restarted.counters.decryptions, 0);
    assert.strictEqual(restarted.counters.transport, 0);

    const generationB = createGenerationId();
    await harness.service.handleCompletion({
      generationId: generationB,
      ownerId: "synthetic-company-b"
    });
    const recordsAfterB = eventRecords(harness.outboxPath);
    assert.strictEqual(recordsAfterB.length, 2);
    assert.strictEqual(
      recordsAfterB.find((event) => event.generation_id === generationB)
        .token_fingerprint,
      clienteB.notificacoes.fcm_tokens[0].fingerprint
    );
    assert.notStrictEqual(
      clienteA.notificacoes.fcm_tokens[0].fingerprint,
      clienteB.notificacoes.fcm_tokens[0].fingerprint
    );

    await assertRejectedCode(
      () => harness.service.handleCompletion({
        generationId: createGenerationId(),
        ownerId: ""
      }),
      "art_ready_owner_missing"
    );
    await assertRejectedCode(
      () => harness.service.handleCompletion({
        generationId: createGenerationId(),
        ownerId: "synthetic-company-missing"
      }),
      "art_ready_owner_not_found"
    );

    const noTokenHarness = createHarness({
      root: path.join(root, "no-token"),
      clientes: { "synthetic-empty": {} },
      tokenCrypto
    });
    const noToken = await noTokenHarness.service.handleCompletion({
      generationId: createGenerationId(),
      ownerId: "synthetic-empty"
    });
    assert.strictEqual(noToken.code, "art_ready_no_active_tokens");
    assert.strictEqual(noToken.counters, undefined);
    assert.strictEqual(fs.existsSync(noTokenHarness.outboxPath), false);

    const inactiveHarness = createHarness({
      root: path.join(root, "inactive"),
      clientes: {
        "synthetic-inactive": syntheticClient(
          "synthetic-inactive-token-never-log",
          tokenCrypto,
          false
        )
      },
      tokenCrypto
    });
    const inactive = await inactiveHarness.service.handleCompletion({
      generationId: createGenerationId(),
      ownerId: "synthetic-inactive"
    });
    assert.strictEqual(inactive.recipients, 0);
    assert.strictEqual(inactiveHarness.counters.decryptions, 0);
    assert.strictEqual(inactiveHarness.counters.transport, 0);

    const deliveryOnlyHarness = createHarness({
      root: path.join(root, "delivery-only"),
      clientes,
      tokenCrypto,
      delivery: true,
      automatic: false
    });
    const deliveryOnly = await deliveryOnlyHarness.service.handleCompletion({
      generationId: createGenerationId(),
      ownerId: "synthetic-company-a"
    });
    assert.strictEqual(deliveryOnly.code, "art_ready_blocked");
    assert.strictEqual(deliveryOnlyHarness.counters.decryptions, 0);
    assert.strictEqual(deliveryOnlyHarness.counters.transport, 0);

    const automaticOnlyHarness = createHarness({
      root: path.join(root, "automatic-only"),
      clientes,
      tokenCrypto,
      delivery: false,
      automatic: true
    });
    await automaticOnlyHarness.service.handleCompletion({
      generationId: createGenerationId(),
      ownerId: "synthetic-company-a"
    });
    assert.strictEqual(automaticOnlyHarness.counters.decryptions, 0);
    assert.strictEqual(automaticOnlyHarness.counters.transport, 0);

    const tamperedClient = JSON.parse(JSON.stringify(clienteA));
    tamperedClient.notificacoes.fcm_tokens[0].tag =
      tamperedClient.notificacoes.fcm_tokens[0].tag.slice(0, -2);
    const tamperedHarness = createHarness({
      root: path.join(root, "tampered"),
      clientes: { "synthetic-tampered": tamperedClient },
      tokenCrypto
    });
    await assertRejectedCode(
      () => tamperedHarness.service.handleCompletion({
        generationId: createGenerationId(),
        ownerId: "synthetic-tampered"
      }),
      "art_ready_token_storage_unavailable"
    );
    assert.strictEqual(tamperedHarness.counters.decryptions, 0);
    assert.strictEqual(tamperedHarness.counters.transport, 0);

    const authenticatedTamperClient = JSON.parse(JSON.stringify(clienteA));
    const encryptedToken =
      authenticatedTamperClient.notificacoes.fcm_tokens[0].ciphertext;
    authenticatedTamperClient.notificacoes.fcm_tokens[0].ciphertext =
      `${encryptedToken[0] === "A" ? "B" : "A"}${encryptedToken.slice(1)}`;
    let externalAfterTamper = 0;
    const authenticatedTamperHarness = createHarness({
      root: path.join(root, "authenticated-tamper"),
      clientes: {
        "synthetic-authenticated-tamper": authenticatedTamperClient
      },
      tokenCrypto,
      delivery: true,
      automatic: true,
      sender: async (isolatedClient) => {
        tokenCrypto.decryptToken(
          isolatedClient.notificacoes.fcm_tokens[0]
        );
        externalAfterTamper += 1;
        return { ok: true, sent: 1 };
      }
    });
    const authenticatedTamperResult =
      await authenticatedTamperHarness.service.handleCompletion({
        generationId: createGenerationId(),
        ownerId: "synthetic-authenticated-tamper"
      });
    assert.strictEqual(authenticatedTamperResult.sent, 0);
    assert.strictEqual(authenticatedTamperResult.failed, 1);
    assert.strictEqual(externalAfterTamper, 0);

    const missingKeysHarness = createHarness({
      root: path.join(root, "missing-keys"),
      clientes,
      tokenCrypto
    });
    const missingKeysService = createArtReadyNotificationService({
      outboxPath: missingKeysHarness.outboxPath,
      deliveryEnabled: () => false,
      automaticNotificationsEnabled: () => false,
      getClienteByOwner: () => clienteA,
      listActiveTokenRecords: () => {
        const missingKeyCrypto = createFcmTokenCrypto({ env: {} });
        return activeEncryptedFcmTokenRecords({
          cliente: clienteA,
          tokenCrypto: missingKeyCrypto
        });
      },
      sendToClient: async () => {
        throw new Error("must_not_send");
      }
    });
    await assertRejectedCode(
      () => missingKeysService.handleCompletion({
        generationId: createGenerationId(),
        ownerId: "synthetic-company-a"
      }),
      "art_ready_token_storage_unavailable"
    );

    const sentCalls = [];
    const simulatedSendRoot = path.join(root, "simulated-send");
    let simulatedTransportCalls = 0;
    const simulatedSendHarness = createHarness({
      root: simulatedSendRoot,
      clientes,
      tokenCrypto,
      delivery: true,
      automatic: true,
      sender: async (isolatedClient, message) => {
        simulatedTransportCalls += 1;
        sentCalls.push({ isolatedClient, message });
        return { ok: true, sent: 1 };
      }
    });
    const simulatedGeneration = createGenerationId();
    const simulated = await simulatedSendHarness.service.handleCompletion({
      generationId: simulatedGeneration,
      ownerId: "synthetic-company-a"
    });
    assert.strictEqual(simulated.sent, 1);
    assert.strictEqual(simulatedTransportCalls, 1);
    assert.strictEqual(sentCalls[0].message.title, "Sua arte está pronta!");
    assert.strictEqual(
      sentCalls[0].message.body,
      "Toque para visualizar sua criação na IA4Tube."
    );
    assert.strictEqual(sentCalls[0].message.imageUrl, "");
    assert.deepStrictEqual(sentCalls[0].message.data, {
      tipo: "arte_pronta",
      route: "orders"
    });
    assert.strictEqual(
      sentCalls[0].isolatedClient.notificacoes.fcm_tokens.length,
      1
    );
    await simulatedSendHarness.service.handleCompletion({
      generationId: simulatedGeneration,
      ownerId: "synthetic-company-a"
    });
    assert.strictEqual(simulatedTransportCalls, 1);
    assert.strictEqual(
      eventRecords(simulatedSendHarness.outboxPath)[0].state,
      "sent"
    );

    const uncertainRoot = path.join(root, "uncertain");
    let uncertainCalls = 0;
    const uncertainHarness = createHarness({
      root: uncertainRoot,
      clientes,
      tokenCrypto,
      delivery: true,
      automatic: true,
      sender: async () => {
        uncertainCalls += 1;
        throw new Error("synthetic_uncertain_outcome");
      }
    });
    const uncertainGeneration = createGenerationId();
    await uncertainHarness.service.handleCompletion({
      generationId: uncertainGeneration,
      ownerId: "synthetic-company-a"
    });
    await uncertainHarness.service.handleCompletion({
      generationId: uncertainGeneration,
      ownerId: "synthetic-company-a"
    });
    assert.strictEqual(uncertainCalls, 1);
    assert.strictEqual(
      eventRecords(uncertainHarness.outboxPath)[0].state,
      "failed"
    );

    const revisionGeneration = createGenerationId();
    await harness.service.handleCompletion({
      generationId: revisionGeneration,
      ownerId: "synthetic-company-a"
    });
    assert.strictEqual(
      eventRecords(harness.outboxPath)
        .filter((event) =>
          event.token_fingerprint ===
          clienteA.notificacoes.fcm_tokens[0].fingerprint
        ).length,
      2
    );

    const persisted = fs.readFileSync(harness.outboxPath, "utf8");
    assert.strictEqual(persisted.includes(tokenA), false);
    assert.strictEqual(persisted.includes(tokenB), false);
    assert.strictEqual(persisted.includes("ciphertext"), false);
    assert.strictEqual(JSON.stringify(first).includes(tokenA), false);
    assert.strictEqual(JSON.stringify(first).includes(tokenB), false);
    if (process.platform !== "win32") {
      assert.strictEqual(
        fs.statSync(harness.outboxPath).mode & 0o777,
        0o600
      );
    }

    assert.strictEqual(harness.counters.decryptions, 0);
    assert.strictEqual(harness.counters.oauth, 0);
    assert.strictEqual(harness.counters.external, 0);
    assert.strictEqual(harness.counters.transport, 0);
    assert.strictEqual(harness.counters.notifications, 0);

    const markerHashAfter = crypto
      .createHash("sha256")
      .update(fs.readFileSync(markerPath))
      .digest("hex");
    assert.strictEqual(markerHashAfter, markerHashBefore);

    const serverSource = fs.readFileSync(
      path.join(__dirname, "..", "server.js"),
      "utf8"
    );
    assert.ok(
      serverSource.includes("previousOrderStatus: existingPedido.status"),
      "Server must use the stored order status for transition detection."
    );
    assert.ok(
      serverSource.includes(
        'String(existingPedido.whatsapp || "").trim() !== ownerId'
      ),
      "Server must confirm that the order owner matches its storage path."
    );
    assert.strictEqual(serverSource.includes("sendClientPushAsync"), false);

    const outbox = createArtReadyOutbox({
      filePath: harness.outboxPath
    }).read();
    assert.strictEqual(outbox.format_version, 1);

    console.log("art-ready-notification.test.js ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error({
    code: error?.code || "art_ready_notification_test_failed",
    message: "Art-ready notification test failed.",
    stack: error?.stack
  });
  process.exit(1);
});
