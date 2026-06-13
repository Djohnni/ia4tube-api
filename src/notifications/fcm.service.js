const fs = require("fs");
const crypto = require("crypto");

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function parseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch {
      return null;
    }
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    try {
      return JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
    } catch {
      return null;
    }
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) return null;

  return {
    project_id: projectId,
    client_email: clientEmail,
    private_key: privateKey
  };
}

function normalizePrivateKey(privateKey = "") {
  return String(privateKey || "").replace(/\\n/g, "\n");
}

function serviceAccountIsValid(serviceAccount) {
  return Boolean(
    serviceAccount?.project_id &&
    serviceAccount?.client_email &&
    serviceAccount?.private_key
  );
}

function isFirebaseConfigured() {
  return serviceAccountIsValid(parseServiceAccount());
}

function localMockEnabled() {
  return process.env.FCM_MOCK === "true" || process.env.NODE_ENV !== "production";
}

function createSignedJwt(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT"
  };
  const payload = {
    iss: serviceAccount.client_email,
    scope: FCM_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600
  };

  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();

  const signature = signer
    .sign(normalizePrivateKey(serviceAccount.private_key), "base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${unsigned}.${signature}`;
}

async function getAccessToken(serviceAccount) {
  const now = Date.now();
  if (cachedAccessToken && cachedAccessTokenExpiresAt - now > 60 * 1000) {
    return cachedAccessToken;
  }

  const jwt = createSignedJwt(serviceAccount);
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const error = new Error(data.error_description || data.error || "Falha ao obter token Firebase.");
    error.code = "firebase_access_token_error";
    error.detail = data;
    throw error;
  }

  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

function activeFcmTokens(cliente = {}) {
  const tokens = Array.isArray(cliente?.notificacoes?.fcm_tokens)
    ? cliente.notificacoes.fcm_tokens
    : [];

  return tokens
    .filter((item) => item && item.ativo !== false && item.token)
    .map((item) => String(item.token).trim())
    .filter(Boolean);
}

async function sendToToken({ serviceAccount, accessToken, token, title, body, data = {} }) {
  const url = `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`;
  const payload = {
    message: {
      token,
      notification: {
        title,
        body
      },
      data: Object.fromEntries(
        Object.entries(data).map(([key, value]) => [key, String(value ?? "")])
      )
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error?.message || "Falha ao enviar FCM.");
    error.code = "firebase_send_error";
    error.detail = result;
    throw error;
  }

  return result;
}

async function sendToClient(cliente, message) {
  const tokens = activeFcmTokens(cliente);
  if (!tokens.length) {
    return {
      ok: false,
      code: "no_fcm_tokens",
      error: "Cliente sem token FCM ativo."
    };
  }

  const serviceAccount = parseServiceAccount();
  if (!serviceAccountIsValid(serviceAccount)) {
    if (localMockEnabled()) {
      return {
        ok: true,
        mock: true,
        sent: tokens.length,
        tokens: tokens.length,
        reason: "firebase_not_configured"
      };
    }

    return {
      ok: false,
      code: "firebase_not_configured",
      error: "Firebase nao configurado no backend."
    };
  }

  const accessToken = await getAccessToken(serviceAccount);
  const errors = [];
  let sent = 0;

  for (const token of tokens) {
    try {
      await sendToToken({
        serviceAccount,
        accessToken,
        token,
        title: message.title,
        body: message.body,
        data: message.data || {}
      });
      sent += 1;
    } catch (error) {
      errors.push({
        token_suffix: token.slice(-8),
        code: error.code || "firebase_send_error",
        message: error.message
      });
    }
  }

  return {
    ok: sent > 0,
    sent,
    tokens: tokens.length,
    errors
  };
}

module.exports = {
  activeFcmTokens,
  isFirebaseConfigured,
  sendToClient
};
