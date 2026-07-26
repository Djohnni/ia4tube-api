"use strict";

function requireHttpsOrigin(name, rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    throw new Error(`Configuracao segura obrigatoria ausente: ${name}`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Configuracao segura obrigatoria invalida: ${name}`);
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/")
  ) {
    throw new Error(`Configuracao segura obrigatoria invalida: ${name} deve ser uma origem HTTPS`);
  }

  return parsed.origin;
}

function appendPath(origin, pathname) {
  const cleanPath = String(pathname || "").startsWith("/")
    ? String(pathname || "")
    : `/${pathname || ""}`;
  return `${origin}${cleanPath}`;
}

function paymentPayerEmailDomain(rawValue) {
  const value = String(rawValue || "ia4tube.invalid").trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(value) || value.startsWith(".") || value.endsWith(".")) {
    throw new Error("Configuracao invalida: PAYMENT_PAYER_EMAIL_DOMAIN");
  }
  return value;
}

function createPublicUrlConfig(env = process.env) {
  const publicApiBaseUrl = requireHttpsOrigin(
    "PUBLIC_API_BASE_URL",
    env.PUBLIC_API_BASE_URL
  );
  const publicWebBaseUrl = env.PUBLIC_WEB_BASE_URL
    ? requireHttpsOrigin("PUBLIC_WEB_BASE_URL", env.PUBLIC_WEB_BASE_URL)
    : publicApiBaseUrl;

  return Object.freeze({
    publicApiBaseUrl,
    publicWebBaseUrl,
    mercadoPagoNotificationUrl: appendPath(publicApiBaseUrl, "/webhook/mercadopago"),
    paymentReturnUrl: appendPath(publicWebBaseUrl, "/app.html"),
    paymentPayerEmailDomain: paymentPayerEmailDomain(env.PAYMENT_PAYER_EMAIL_DOMAIN)
  });
}

module.exports = {
  appendPath,
  createPublicUrlConfig,
  requireHttpsOrigin
};
