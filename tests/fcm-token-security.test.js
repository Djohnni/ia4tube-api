"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  FcmTokenSecurityError,
  createFcmTokenCrypto
} = require("../src/notifications/fcm-token-crypto");
const {
  activeEncryptedFcmTokenRecords,
  deactivateFcmTokens,
  decryptActiveFcmTokens,
  registerFcmToken
} = require("../src/notifications/fcm-token-store");

const SYNTHETIC_TOKEN = "synthetic-fcm-token-never-use-outside-tests";

function keyEnv(keyId = "synthetic-v1") {
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

test("token storage is encrypted, authenticated and idempotent", () => {
  const tokenCrypto = createFcmTokenCrypto({ env: keyEnv() });
  const cliente = {};
  const first = registerFcmToken({
    cliente,
    token: SYNTHETIC_TOKEN,
    tokenCrypto,
    now: "2026-07-27T10:00:00.000Z"
  });
  const firstRecord = { ...cliente.notificacoes.fcm_tokens[0] };
  const second = registerFcmToken({
    cliente,
    token: SYNTHETIC_TOKEN,
    tokenCrypto,
    now: "2026-07-27T10:01:00.000Z"
  });

  assert.equal(first.totalCount, 1);
  assert.equal(second.totalCount, 1);
  assert.equal(second.activeCount, 1);
  assert.equal(JSON.stringify(cliente).includes(SYNTHETIC_TOKEN), false);
  assert.equal(Object.hasOwn(cliente.notificacoes.fcm_tokens[0], "token"), false);
  assert.notEqual(cliente.notificacoes.fcm_tokens[0].iv, firstRecord.iv);
  assert.equal(
    cliente.notificacoes.fcm_tokens[0].fingerprint,
    firstRecord.fingerprint
  );
  assert.deepEqual(
    decryptActiveFcmTokens({ cliente, tokenCrypto }),
    [SYNTHETIC_TOKEN]
  );
  assert.equal(
    activeEncryptedFcmTokenRecords({ cliente, tokenCrypto }).length,
    1
  );
});

test("tampering, wrong keys and legacy plaintext fail closed", () => {
  const tokenCrypto = createFcmTokenCrypto({ env: keyEnv() });
  const cliente = {};
  registerFcmToken({ cliente, token: SYNTHETIC_TOKEN, tokenCrypto });

  for (const field of ["iv", "ciphertext", "tag", "fingerprint"]) {
    const tampered = JSON.parse(JSON.stringify(cliente));
    const value = tampered.notificacoes.fcm_tokens[0][field];
    tampered.notificacoes.fcm_tokens[0][field] =
      `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
    assert.throws(() =>
      decryptActiveFcmTokens({ cliente: tampered, tokenCrypto })
    );
  }

  const wrongCrypto = createFcmTokenCrypto({ env: keyEnv() });
  assert.throws(() =>
    decryptActiveFcmTokens({ cliente, tokenCrypto: wrongCrypto })
  );
  assert.throws(
    () => decryptActiveFcmTokens({
      cliente: {
        notificacoes: {
          fcm_tokens: [{ token: SYNTHETIC_TOKEN, ativo: true }]
        }
      },
      tokenCrypto
    }),
    (error) =>
      error instanceof FcmTokenSecurityError &&
      error.code === "fcm_token_legacy_storage_detected"
  );
});

test("deactivation uses token fingerprint and never persists plaintext", () => {
  const tokenCrypto = createFcmTokenCrypto({ env: keyEnv() });
  const cliente = {};
  registerFcmToken({ cliente, token: SYNTHETIC_TOKEN, tokenCrypto });
  const result = deactivateFcmTokens({
    cliente,
    tokens: [SYNTHETIC_TOKEN],
    reason: "synthetic_invalid",
    now: "2026-07-27T10:02:00.000Z",
    tokenCrypto
  });
  assert.equal(result.deactivated, 1);
  assert.deepEqual(
    decryptActiveFcmTokens({ cliente, tokenCrypto }),
    []
  );
  assert.equal(JSON.stringify(cliente).includes(SYNTHETIC_TOKEN), false);
});

test("missing key material is accepted only while no token operation occurs", () => {
  assert.throws(
    () => createFcmTokenCrypto({ env: {} }),
    (error) =>
      error instanceof FcmTokenSecurityError &&
      error.code === "fcm_token_key_id_missing"
  );
});
