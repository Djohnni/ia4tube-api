"use strict";

const crypto = require("crypto");

const { createArtReadyOutbox } = require("./art-ready-outbox");

const TITLE = "Sua arte está pronta!";
const BODY = "Toque para visualizar sua criação na IA4Tube.";
const GENERATION_ID_PATTERN = /^art_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER_ID_PATTERN = /^[^\u0000-\u001f\u007f/\\]{1,200}$/;

class ArtReadyNotificationError extends Error {
  constructor(code) {
    super("Notificacao de arte pronta recusada por uma regra de seguranca.");
    this.name = "ArtReadyNotificationError";
    this.code = code;
  }
}

function fail(code) {
  throw new ArtReadyNotificationError(code);
}

function createGenerationId(randomUUID = crypto.randomUUID) {
  const generationId = `art_${randomUUID()}`;
  if (!GENERATION_ID_PATTERN.test(generationId)) {
    fail("art_ready_generation_id_invalid");
  }
  return generationId;
}

function validateGenerationId(value) {
  const normalized = String(value || "").trim();
  if (!GENERATION_ID_PATTERN.test(normalized)) {
    fail("art_ready_generation_id_invalid");
  }
  return normalized;
}

function validateOwnerId(value) {
  const normalized = String(value || "").trim();
  if (!OWNER_ID_PATTERN.test(normalized)) {
    fail("art_ready_owner_missing");
  }
  return normalized;
}

function safeResultCode(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,99}$/.test(normalized)
    ? normalized
    : fallback;
}

function createArtReadyNotificationService({
  outboxPath,
  deliveryEnabled,
  automaticNotificationsEnabled,
  getClienteByOwner,
  listActiveTokenRecords,
  sendToClient,
  deactivateInvalidTokens = () => {},
  outbox = createArtReadyOutbox({ filePath: outboxPath })
}) {
  for (const dependency of [
    deliveryEnabled,
    automaticNotificationsEnabled,
    getClienteByOwner,
    listActiveTokenRecords,
    sendToClient
  ]) {
    if (typeof dependency !== "function") {
      fail("art_ready_dependency_invalid");
    }
  }

  async function handleCompletion({
    generationId,
    ownerId
  }) {
    const normalizedGenerationId = validateGenerationId(generationId);
    const normalizedOwnerId = validateOwnerId(ownerId);
    const cliente = getClienteByOwner(normalizedOwnerId);
    if (!cliente || typeof cliente !== "object" || Array.isArray(cliente)) {
      fail("art_ready_owner_not_found");
    }

    let tokenRecords;
    try {
      tokenRecords = listActiveTokenRecords(cliente);
    } catch {
      fail("art_ready_token_storage_unavailable");
    }
    if (!Array.isArray(tokenRecords)) {
      fail("art_ready_token_storage_unavailable");
    }

    const activeRecords = tokenRecords.filter((record) => record?.ativo !== false);
    if (!activeRecords.length) {
      return {
        ok: true,
        code: "art_ready_no_active_tokens",
        recipients: 0,
        sent: 0,
        blocked: 0
      };
    }

    const canDeliver = deliveryEnabled() === true;
    const canRunAutomatically = automaticNotificationsEnabled() === true;
    const gatesOpen = canDeliver && canRunAutomatically;
    const summary = {
      ok: true,
      code: gatesOpen ? "art_ready_processed" : "art_ready_blocked",
      recipients: activeRecords.length,
      sent: 0,
      blocked: 0,
      duplicates: 0,
      failed: 0
    };

    for (const record of activeRecords) {
      const fingerprint = String(record?.fingerprint || "").trim();
      const existing = outbox.get({
        generationId: normalizedGenerationId,
        tokenFingerprint: fingerprint
      });

      if (!gatesOpen) {
        if (["sent", "prepared", "failed"].includes(existing?.state)) {
          summary.duplicates += 1;
          continue;
        }
        outbox.transition({
          generationId: normalizedGenerationId,
          tokenFingerprint: fingerprint,
          state: "blocked",
          resultCode: !canDeliver
            ? "fcm_delivery_disabled"
            : "fcm_automatic_notifications_disabled"
        });
        summary.blocked += 1;
        continue;
      }

      if (["sent", "prepared", "failed"].includes(existing?.state)) {
        summary.duplicates += 1;
        continue;
      }

      const prepared = outbox.transition({
        generationId: normalizedGenerationId,
        tokenFingerprint: fingerprint,
        state: "prepared",
        resultCode: "delivery_prepared"
      });
      if (prepared.state !== "prepared") {
        summary.duplicates += 1;
        continue;
      }

      const invalidTokens = [];
      let result;
      try {
        result = await sendToClient(
          {
            notificacoes: {
              fcm_tokens: [{ ...record }]
            }
          },
          {
            title: TITLE,
            body: BODY,
            imageUrl: "",
            data: {
              tipo: "arte_pronta",
              route: "orders"
            }
          },
          {
            onInvalidToken: (token) => invalidTokens.push(token)
          }
        );
      } catch {
        outbox.transition({
          generationId: normalizedGenerationId,
          tokenFingerprint: fingerprint,
          state: "failed",
          resultCode: "delivery_outcome_uncertain"
        });
        summary.failed += 1;
        continue;
      }

      if (invalidTokens.length) {
        deactivateInvalidTokens(normalizedOwnerId, invalidTokens);
      }

      if (result?.ok === true && Number(result.sent) === 1) {
        outbox.transition({
          generationId: normalizedGenerationId,
          tokenFingerprint: fingerprint,
          state: "sent",
          resultCode: "delivery_confirmed"
        });
        summary.sent += 1;
      } else {
        outbox.transition({
          generationId: normalizedGenerationId,
          tokenFingerprint: fingerprint,
          state: "failed",
          resultCode: safeResultCode(
            result?.code,
            "delivery_not_confirmed"
          )
        });
        summary.failed += 1;
      }
    }

    return summary;
  }

  return Object.freeze({
    createGenerationId,
    handleCompletion,
    message: Object.freeze({
      title: TITLE,
      body: BODY
    })
  });
}

module.exports = {
  ArtReadyNotificationError,
  BODY,
  TITLE,
  createArtReadyNotificationService,
  createGenerationId,
  validateGenerationId,
  validateOwnerId
};
