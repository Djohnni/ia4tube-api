"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BODY,
  TITLE,
  createArtReadyNotificationService,
  createGenerationId
} = require("../src/notifications/art-ready-notification.service");
const {
  successfulCompletionTransition
} = require("../src/notifications/art-ready-generation");
const {
  readOutbox
} = require("../src/notifications/art-ready-outbox");
const {
  activeEncryptedFcmTokenRecords,
  registerFcmToken
} = require("../src/notifications/fcm-token-store");
const {
  createFcmTokenCrypto
} = require("../src/notifications/fcm-token-crypto");

function cryptoEnv() {
  const keyId = "synthetic-v1";
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

function encryptedClient(token, tokenCrypto) {
  const cliente = {};
  registerFcmToken({ cliente, token, tokenCrypto });
  return cliente;
}

function harness({
  root,
  event = true,
  delivery = false,
  automatic = false,
  clientes = {},
  tokenCrypto,
  sender
}) {
  const counters = {
    clientReads: 0,
    tokenReads: 0,
    sends: 0
  };
  const outboxPath = path.join(root, "notifications", "art-ready-outbox.json");
  const service = createArtReadyNotificationService({
    outboxPath,
    eventEnabled: () => event,
    deliveryEnabled: () => delivery,
    automaticNotificationsEnabled: () => automatic,
    getClienteByOwner(ownerId) {
      counters.clientReads += 1;
      return clientes[ownerId] || null;
    },
    listActiveTokenRecords(cliente) {
      counters.tokenReads += 1;
      return activeEncryptedFcmTokenRecords({ cliente, tokenCrypto });
    },
    sendToClient: sender || (async () => {
      counters.sends += 1;
      return { ok: true, sent: 1 };
    })
  });
  return { counters, outboxPath, service };
}

test("event gate returns before owner, token, outbox or transport", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-art-off-"));
  try {
    const instance = harness({
      root,
      event: false,
      clientes: {},
      tokenCrypto: null
    });
    const result = await instance.service.handleCompletion({
      generationId: "not-even-validated",
      ownerId: "not-even-read"
    });
    assert.equal(result.code, "art_ready_event_disabled");
    assert.deepEqual(instance.counters, {
      clientReads: 0,
      tokenReads: 0,
      sends: 0
    });
    assert.equal(fs.existsSync(path.join(root, "notifications")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("owner isolation, persisted idempotency and PII-free content", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-art-on-"));
  const tokenCrypto = createFcmTokenCrypto({ env: cryptoEnv() });
  const ownerA = "synthetic-owner-a";
  const ownerB = "synthetic-owner-b";
  const clientA = encryptedClient("synthetic-token-a", tokenCrypto);
  const clientB = encryptedClient("synthetic-token-b", tokenCrypto);
  const deliveries = [];

  try {
    const instance = harness({
      root,
      event: true,
      delivery: true,
      automatic: true,
      clientes: {
        [ownerA]: clientA,
        [ownerB]: clientB
      },
      tokenCrypto,
      sender: async (isolatedClient, message) => {
        deliveries.push({ isolatedClient, message });
        return { ok: true, sent: 1 };
      }
    });
    const generationId = createGenerationId();
    const first = await instance.service.handleCompletion({
      generationId,
      ownerId: ownerA
    });
    const second = await instance.service.handleCompletion({
      generationId,
      ownerId: ownerA
    });

    assert.equal(first.sent, 1);
    assert.equal(second.duplicates, 1);
    assert.equal(deliveries.length, 1);
    assert.equal(
      deliveries[0].isolatedClient.notificacoes.fcm_tokens.length,
      1
    );
    assert.equal(
      deliveries[0].isolatedClient.notificacoes.fcm_tokens[0].fingerprint,
      clientA.notificacoes.fcm_tokens[0].fingerprint
    );
    assert.notEqual(
      clientA.notificacoes.fcm_tokens[0].fingerprint,
      clientB.notificacoes.fcm_tokens[0].fingerprint
    );
    assert.deepEqual(deliveries[0].message, {
      title: TITLE,
      body: BODY,
      imageUrl: "",
      data: {
        tipo: "arte_pronta",
        route: "orders"
      }
    });
    const messageText = JSON.stringify(deliveries[0].message);
    assert.equal(messageText.includes(ownerA), false);
    assert.equal(messageText.includes(ownerB), false);
    assert.equal(messageText.includes("pedido"), false);

    const persisted = readOutbox(instance.outboxPath);
    assert.equal(Object.keys(persisted.events).length, 1);
    const event = Object.values(persisted.events)[0];
    assert.equal(event.event_type, "art_ready");
    assert.equal(event.generation_id, generationId);
    assert.equal(event.state, "sent");
    const rawOutbox = fs.readFileSync(instance.outboxPath, "utf8");
    assert.equal(rawOutbox.includes("synthetic-token-a"), false);
    assert.equal(rawOutbox.includes("ciphertext"), false);

    const restarted = harness({
      root,
      event: true,
      delivery: true,
      automatic: true,
      clientes: { [ownerA]: clientA },
      tokenCrypto,
      sender: async () => {
        throw new Error("persisted idempotency failed");
      }
    });
    const afterRestart = await restarted.service.handleCompletion({
      generationId,
      ownerId: ownerA
    });
    assert.equal(afterRestart.duplicates, 1);
    assert.equal(restarted.counters.sends, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generation remains immutable on reupload and changes for a revision", () => {
  const first = successfulCompletionTransition({
    previousStatus: "processando",
    previousOrderStatus: "em_producao",
    existingGenerationId: "",
    createGenerationId
  });
  assert.equal(first.transitioned, true);

  const reupload = successfulCompletionTransition({
    previousStatus: "pronto",
    previousOrderStatus: "pronto",
    existingGenerationId: first.generationId,
    createGenerationId
  });
  assert.equal(reupload.transitioned, false);
  assert.equal(reupload.generationId, first.generationId);

  const revision = successfulCompletionTransition({
    previousStatus: "ajuste_pendente",
    previousOrderStatus: "ajuste_pendente",
    existingGenerationId: first.generationId,
    createGenerationId
  });
  assert.equal(revision.transitioned, true);
  assert.notEqual(revision.generationId, first.generationId);
});

test("automatic gate blocks before token decryption and inactive tokens are skipped", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-art-auto-off-"));
  const tokenCrypto = createFcmTokenCrypto({ env: cryptoEnv() });
  const cliente = encryptedClient("synthetic-token-auto-off", tokenCrypto);
  let decryptions = 0;
  let sends = 0;
  const guardedCrypto = {
    ...tokenCrypto,
    decryptToken(record) {
      decryptions += 1;
      return tokenCrypto.decryptToken(record);
    }
  };
  try {
    const outboxPath = path.join(root, "notifications", "outbox.json");
    const service = createArtReadyNotificationService({
      outboxPath,
      eventEnabled: () => true,
      deliveryEnabled: () => true,
      automaticNotificationsEnabled: () => false,
      getClienteByOwner: () => cliente,
      listActiveTokenRecords: (value) =>
        activeEncryptedFcmTokenRecords({
          cliente: value,
          tokenCrypto: guardedCrypto
        }),
      sendToClient: async () => {
        sends += 1;
        return { ok: true, sent: 1 };
      }
    });
    const blocked = await service.handleCompletion({
      generationId: createGenerationId(),
      ownerId: "owner"
    });
    assert.equal(blocked.code, "art_ready_blocked");
    assert.equal(decryptions, 0);
    assert.equal(sends, 0);

    cliente.notificacoes.fcm_tokens[0].ativo = false;
    const inactive = await service.handleCompletion({
      generationId: createGenerationId(),
      ownerId: "owner"
    });
    assert.equal(inactive.code, "art_ready_no_active_tokens");
    assert.equal(decryptions, 0);
    assert.equal(sends, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing or unknown owner fails closed before outbox creation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-art-owner-"));
  try {
    const instance = harness({
      root,
      event: true,
      clientes: {},
      tokenCrypto: null
    });
    await assert.rejects(
      () => instance.service.handleCompletion({
        generationId: createGenerationId(),
        ownerId: ""
      }),
      (error) => error?.code === "art_ready_owner_missing"
    );
    await assert.rejects(
      () => instance.service.handleCompletion({
        generationId: createGenerationId(),
        ownerId: "unknown-owner"
      }),
      (error) => error?.code === "art_ready_owner_not_found"
    );
    assert.equal(fs.existsSync(instance.outboxPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("notification failures stay isolated from the completed-art flow", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-art-fail-"));
  const tokenCrypto = createFcmTokenCrypto({ env: cryptoEnv() });
  const cliente = encryptedClient("synthetic-token-failure", tokenCrypto);
  try {
    const instance = harness({
      root,
      event: true,
      delivery: true,
      automatic: true,
      clientes: { owner: cliente },
      tokenCrypto,
      sender: async () => {
        throw new Error("synthetic transport failure");
      }
    });
    const result = await instance.service.handleCompletion({
      generationId: createGenerationId(),
      ownerId: "owner"
    });
    assert.equal(result.failed, 1);
    assert.equal(result.sent, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
