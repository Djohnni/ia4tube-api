"use strict";

const crypto = require("crypto");
const {
  safeRuntimeSummary,
  validateFcmRuntimeConfig
} = require("./fcm-config");
const {
  activeEncryptedFcmTokenRecords,
  decryptActiveFcmTokens
} = require("./fcm-token-store");
const {
  BODY: ART_READY_BODY,
  TITLE: ART_READY_TITLE,
  artReadyData
} = require("./art-ready-contract");
const {
  FcmFinalTestError,
  assertFinalTestAllowedTokenFingerprint,
  assertFinalTestProductionInvariants,
  assertFinalTestSendGates,
  assertFinalTestTokenRecord,
  createFcmFinalTestRunner,
  safeFinalTestCode
} = require("./fcm-final-test");

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const runtimeConfig = validateFcmRuntimeConfig(process.env);

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

function tokenRegistrationEnabled() {
  return runtimeConfig.tokenRegistrationEnabled === true;
}

function artReadyEventEnabled() {
  return runtimeConfig.artReadyEventEnabled === true;
}

function fcmDeliveryEnabled() {
  return runtimeConfig.deliveryEnabled === true;
}

function automaticNotificationsEnabled() {
  return runtimeConfig.automaticNotificationsEnabled === true;
}

function statusNotificationsEnabled() {
  return runtimeConfig.statusNotificationsEnabled === true;
}

function scheduledNotificationsEnabled() {
  return runtimeConfig.scheduledNotificationsEnabled === true;
}

function manualNotificationsEnabled() {
  return runtimeConfig.manualNotificationsEnabled === true;
}

function runtimeConfigSummary() {
  return safeRuntimeSummary(runtimeConfig);
}

function isFirebaseConfigured() {
  return runtimeConfig.credentialConfigured === true;
}

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function normalizePrivateKey(privateKey = "") {
  return String(privateKey || "").replace(/\\n/g, "\n");
}

function createSignedJwt(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64Url(JSON.stringify({
    alg: "RS256",
    typ: "JWT"
  }))}.${base64Url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: FCM_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600
  }))}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer
    .sign(normalizePrivateKey(serviceAccount.private_key))
    .toString("base64url")}`;
}

async function getAccessToken(serviceAccount) {
  const now = Date.now();
  if (cachedAccessToken && cachedAccessTokenExpiresAt - now > 60 * 1000) {
    return cachedAccessToken;
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: createSignedJwt(serviceAccount)
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const error = new Error("Falha ao obter token Firebase.");
    error.code = "firebase_access_token_error";
    throw error;
  }

  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiresAt =
    Date.now() + Number(data.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

function activeFcmTokens(cliente = {}) {
  return decryptActiveFcmTokens({ cliente });
}

function normalizeData(data = {}) {
  return Object.fromEntries(
    Object.entries(data || {}).map(([key, value]) => [key, String(value ?? "")])
  );
}

function normalizeImageUrl(payload = {}) {
  const value = payload.image_url ||
    payload.imageUrl ||
    payload.image ||
    payload.picture ||
    payload.preview_url ||
    payload.previewUrl ||
    "";
  const imageUrl = String(value || "").trim();
  return /^https?:\/\//i.test(imageUrl) ? imageUrl : "";
}

function isInvalidFcmTokenError(error = {}) {
  const firebaseError = error?.detail?.error || {};
  const status = String(firebaseError.status || "").trim().toUpperCase();
  const message = String(
    error?.message || firebaseError.message || ""
  ).trim().toLowerCase();
  const details = Array.isArray(firebaseError.details)
    ? firebaseError.details
    : [];
  const codes = details
    .map((detail) => String(
      detail?.errorCode || detail?.error_code || ""
    ).trim().toUpperCase())
    .filter(Boolean);
  return (
    status === "NOT_FOUND" ||
    status === "UNREGISTERED" ||
    message.includes("requested entity was not found") ||
    codes.includes("UNREGISTERED")
  );
}

function notificationMessage(type, payload = {}) {
  const pedidoId = payload.pedido_id || payload.pedidoId || "";
  const planejamentoId =
    payload.planejamento_id || payload.planejamentoId || "";
  const planejamentoItemId =
    payload.planejamento_item_id || payload.planejamentoItemId || "";
  const imageUrl = normalizeImageUrl(payload);
  const baseData = normalizeData({
    tipo: type,
    pedido_id: pedidoId,
    planejamento_id: planejamentoId,
    planejamento_item_id: planejamentoItemId,
    image_url: imageUrl,
    ...(payload.data || {})
  });

  switch (type) {
    case "arte_pronta":
      return {
        title: ART_READY_TITLE,
        body: ART_READY_BODY,
        imageUrl: "",
        data: { ...artReadyData({
          eventId:
            payload.event_id ||
            payload.eventId ||
            payload.generation_id ||
            payload.generationId,
          pedidoId
        }) }
      };
    case "pedido_atualizado":
      return {
        title: payload.title || "Pedido atualizado",
        body: payload.body || "Seu pedido teve uma atualizacao. Toque para acompanhar.",
        imageUrl,
        data: {
          ...baseData,
          route: pedidoId ? "order_detail" : "orders",
          status: payload.status || ""
        }
      };
    case "planejamento_mensal":
      return {
        title: payload.title || "Hora de postar",
        body: payload.body || "Sua arte planejada para hoje esta pronta. Toque para ver e copiar a legenda.",
        imageUrl,
        data: {
          ...baseData,
          route: planejamentoId ? "monthly_planning_detail" : "monthly_planning"
        }
      };
    case "arte_gratis_semanal":
      return {
        title: payload.title || "Arte Gratis da Semana",
        body: payload.body || payload.message || "Sua arte gratis da semana esta pronta. Toque para ver.",
        imageUrl,
        data: {
          ...baseData,
          route: pedidoId ? "order_detail" : "orders",
          campaign_id: payload.campaign_id || payload.campaignId || "",
          assignment_id: payload.assignment_id || payload.assignmentId || ""
        }
      };
    case "nova_versao":
      return {
        title: payload.title || "Nova versao disponivel",
        body: payload.body || "Atualize o app para receber melhorias e correcoes.",
        imageUrl,
        data: {
          ...baseData,
          route: "app_version",
          latest_version_code:
            payload.latest_version_code || payload.latestVersionCode || "",
          latest_version_name:
            payload.latest_version_name || payload.latestVersionName || ""
        }
      };
    case "aviso_geral":
    default:
      return {
        title: payload.title || "Aviso da iA4tube",
        body: payload.body || payload.message || "Voce tem uma novidade no app.",
        imageUrl,
        data: {
          ...baseData,
          route: payload.route || "home"
        }
      };
  }
}

async function sendToToken({
  serviceAccount,
  accessToken,
  token,
  title,
  body,
  imageUrl = "",
  data = {}
}) {
  const url =
    `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`;
  const normalizedImageUrl = normalizeImageUrl({ image_url: imageUrl });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: {
        token,
        notification: {
          title,
          body,
          ...(normalizedImageUrl ? { image: normalizedImageUrl } : {})
        },
        data: normalizeData(data),
        android: {
          priority: "high",
          notification: {
            channel_id: "ia4tube_updates",
            ...(normalizedImageUrl ? { image: normalizedImageUrl } : {})
          }
        }
      }
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const firebaseError = result?.error || {};
    const error = new Error("Falha ao enviar FCM.");
    error.code = "firebase_send_error";
    error.detail = {
      error: {
        status: String(firebaseError.status || ""),
        message: String(firebaseError.message || ""),
        details: Array.isArray(firebaseError.details)
          ? firebaseError.details.map((detail) => ({
              errorCode: String(
                detail?.errorCode || detail?.error_code || ""
              )
            }))
          : []
      }
    };
    throw error;
  }
  return result;
}

function buildArtReadyFcmRequest({ token, eventId, pedidoId }) {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) {
    const error = new Error("Destinatario FCM invalido.");
    error.code = "fcm_token_invalid";
    throw error;
  }
  return {
    message: {
      token: normalizedToken,
      data: { ...artReadyData({ eventId, pedidoId }) },
      android: {
        priority: "high"
      }
    }
  };
}

async function sendArtReadyToToken({
  serviceAccount,
  accessToken,
  token,
  eventId,
  pedidoId
}) {
  const url =
    `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(
      buildArtReadyFcmRequest({ token, eventId, pedidoId })
    )
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const firebaseError = result?.error || {};
    const error = new Error("Falha ao enviar FCM.");
    error.code = "firebase_send_error";
    error.detail = {
      error: {
        status: String(firebaseError.status || ""),
        message: String(firebaseError.message || ""),
        details: Array.isArray(firebaseError.details)
          ? firebaseError.details.map((detail) => ({
              errorCode: String(
                detail?.errorCode || detail?.error_code || ""
              )
            }))
          : []
      }
    };
    throw error;
  }
  return result;
}

async function deliverToClient(cliente, sendOne, options = {}) {
  // Esta verificacao precisa permanecer antes de token, chave, JWT ou rede.
  if (!fcmDeliveryEnabled()) {
    return {
      ok: false,
      code: "fcm_delivery_disabled",
      error: "Entrega FCM desativada por configuracao segura."
    };
  }

  let tokens;
  try {
    tokens = activeFcmTokens(cliente);
  } catch {
    return {
      ok: false,
      code: "fcm_token_storage_unavailable",
      error: "Armazenamento seguro de token FCM indisponivel."
    };
  }
  if (!tokens.length) {
    return {
      ok: false,
      code: "no_fcm_tokens",
      error: "Cliente sem token FCM ativo."
    };
  }

  const serviceAccount = runtimeConfig.serviceAccount;
  if (!serviceAccount) {
    return {
      ok: false,
      code: "firebase_not_configured",
      error: "Firebase nao configurado no backend."
    };
  }

  const accessToken = await getAccessToken(serviceAccount);
  const errors = [];
  let sent = 0;
  let invalidTokenCount = 0;
  for (const token of tokens) {
    try {
      await sendOne({ serviceAccount, accessToken, token });
      sent += 1;
    } catch (error) {
      const invalidToken = isInvalidFcmTokenError(error);
      if (invalidToken) {
        invalidTokenCount += 1;
        if (typeof options.onInvalidToken === "function") {
          await Promise.resolve(options.onInvalidToken(token, error));
        }
      }
      errors.push({
        code: error.code || "firebase_send_error",
        message: "Falha ao enviar FCM.",
        invalid_token: invalidToken
      });
    }
  }

  return {
    ok: sent > 0,
    sent,
    tokens: tokens.length,
    invalid_tokens: invalidTokenCount,
    errors
  };
}

function sendToClient(cliente, message, options = {}) {
  return deliverToClient(
    cliente,
    ({ serviceAccount, accessToken, token }) =>
      sendToToken({
        serviceAccount,
        accessToken,
        token,
        title: message.title,
        body: message.body,
        imageUrl: message.imageUrl || message.image_url || "",
        data: message.data || {}
      }),
    options
  );
}

function sendArtReadyToClient(
  cliente,
  { eventId, pedidoId } = {},
  options = {}
) {
  // Defesa em profundidade: este transporte dedicado nao pode contornar
  // as travas de evento ou de notificacoes automaticas.
  if (!artReadyEventEnabled()) {
    return Promise.resolve({
      ok: false,
      code: "art_ready_event_disabled",
      error: "Evento de arte pronta desativado por configuracao segura."
    });
  }
  if (!automaticNotificationsEnabled()) {
    return Promise.resolve({
      ok: false,
      code: "fcm_automatic_notifications_disabled",
      error: "Notificacoes automaticas desativadas por configuracao segura."
    });
  }
  return deliverToClient(
    cliente,
    ({ serviceAccount, accessToken, token }) =>
      sendArtReadyToToken({
        serviceAccount,
        accessToken,
        token,
        eventId,
        pedidoId
      }),
    options
  );
}

function sendClaimedFinalTestArtReadyToClient(
  cliente,
  {
    eventId,
    pedidoId,
    expectedTokenFingerprint
  } = {},
  options = {}
) {
  let record;
  try {
    assertFinalTestSendGates(process.env);
    artReadyData({ eventId, pedidoId });
    const records = activeEncryptedFcmTokenRecords({ cliente });
    if (records.length !== 1) {
      throw new FcmFinalTestError(
        "fcm_final_test_active_token_count_invalid"
      );
    }
    record = records[0];
    const fingerprint = assertFinalTestTokenRecord(
      record,
      process.env
    );
    const expectedFingerprint =
      assertFinalTestAllowedTokenFingerprint(
        expectedTokenFingerprint,
        process.env
      );
    if (fingerprint !== expectedFingerprint) {
      throw new FcmFinalTestError(
        "fcm_final_test_token_not_allowed"
      );
    }
  } catch (error) {
    return Promise.resolve({
      ok: false,
      code: error instanceof FcmFinalTestError
        ? error.code
        : safeFinalTestCode(
            error?.code,
            "fcm_final_test_preflight_failed"
          ),
      sent: 0,
      tokens: 0
    });
  }

  return deliverToClient(
    {
      notificacoes: {
        fcm_tokens: [{ ...record }]
      }
    },
    ({ serviceAccount, accessToken, token }) =>
      sendArtReadyToToken({
        serviceAccount,
        accessToken,
        token,
        eventId,
        pedidoId
      }),
    options
  );
}

function runFinalTestArtReady({
  ownerId,
  eventId,
  pedidoId
} = {}) {
  try {
    assertFinalTestProductionInvariants(process.env);
  } catch (error) {
    return Promise.reject(error);
  }
  const dataDir = "/var/data";
  const runner = createFcmFinalTestRunner({
    env: process.env,
    dataDir,
    sendFinalTestArtReady:
      sendClaimedFinalTestArtReadyToClient
  });
  return runner.run({ ownerId, eventId, pedidoId });
}

function sendArtePronta(cliente, payload = {}, options = {}) {
  return sendArtReadyToClient(
    cliente,
    {
      eventId:
        payload.event_id ||
        payload.eventId ||
        payload.generation_id ||
        payload.generationId,
      pedidoId: payload.pedido_id || payload.pedidoId
    },
    options
  );
}

function sendPedidoAtualizado(cliente, payload = {}, options = {}) {
  return sendToClient(
    cliente,
    notificationMessage("pedido_atualizado", payload),
    options
  );
}

function sendPlanejamentoMensal(cliente, payload = {}, options = {}) {
  return sendToClient(
    cliente,
    notificationMessage("planejamento_mensal", payload),
    options
  );
}

function sendArteGratisSemanal(cliente, payload = {}, options = {}) {
  return sendToClient(
    cliente,
    notificationMessage("arte_gratis_semanal", payload),
    options
  );
}

function sendNovaVersao(cliente, payload = {}, options = {}) {
  return sendToClient(
    cliente,
    notificationMessage("nova_versao", payload),
    options
  );
}

function sendAvisoGeral(cliente, payload = {}, options = {}) {
  return sendToClient(
    cliente,
    notificationMessage("aviso_geral", payload),
    options
  );
}

module.exports = {
  activeFcmTokens,
  artReadyEventEnabled,
  automaticNotificationsEnabled,
  buildArtReadyFcmRequest,
  fcmDeliveryEnabled,
  isFirebaseConfigured,
  isInvalidFcmTokenError,
  manualNotificationsEnabled,
  notificationMessage,
  runtimeConfigSummary,
  scheduledNotificationsEnabled,
  sendArteGratisSemanal,
  sendArtePronta,
  sendArtReadyToClient,
  runFinalTestArtReady,
  sendAvisoGeral,
  sendNovaVersao,
  sendPedidoAtualizado,
  sendPlanejamentoMensal,
  sendToClient,
  statusNotificationsEnabled,
  tokenRegistrationEnabled
};
