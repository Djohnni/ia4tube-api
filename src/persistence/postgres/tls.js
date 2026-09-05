"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const nodeTls = require("node:tls");
const { postgresFail } = require("./errors");

const CUSTOM_TRUST_ENVIRONMENT_NAMES = Object.freeze([
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SOCIAL_DATABASE_CA_BASE64",
  "SOCIAL_DATABASE_CA_FILE",
  "SOCIAL_DATABASE_EXPECTED_CA_SHA256"
]);
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function fail(code) {
  postgresFail(code, "Configuracao TLS PostgreSQL recusada.");
}

function configured(value) {
  return (
    value !== undefined &&
    value !== null &&
    String(value).trim().length > 0
  );
}

function assertSystemTrustOnly(env = process.env) {
  if (
    String(env?.NODE_TLS_REJECT_UNAUTHORIZED || "").trim() === "0"
  ) {
    fail("node_tls_verification_disabled");
  }
  for (const name of CUSTOM_TRUST_ENVIRONMENT_NAMES) {
    if (configured(env?.[name])) {
      fail("social_database_custom_trust_forbidden");
    }
  }
  return true;
}

function exactServername(hostname) {
  if (
    typeof hostname !== "string" ||
    hostname !== hostname.trim() ||
    hostname !== hostname.toLowerCase() ||
    net.isIP(hostname) !== 0 ||
    !HOSTNAME_PATTERN.test(hostname)
  ) {
    fail("social_database_tls_hostname_invalid");
  }
  return hostname;
}

function hostnameError(message) {
  const error = new Error(message);
  error.code = "ERR_TLS_CERT_ALTNAME_INVALID";
  return error;
}

function exactCheckServerIdentity(expectedHostname) {
  return function checkServerIdentity(hostname, peerCertificate) {
    if (hostname !== expectedHostname) {
      return hostnameError(
        "Hostname TLS PostgreSQL diverge do destino esperado."
      );
    }
    let certificate;
    try {
      certificate = new crypto.X509Certificate(peerCertificate.raw);
    } catch {
      return hostnameError("Certificado TLS PostgreSQL invalido.");
    }
    if (
      typeof certificate.subjectAltName !== "string" ||
      certificate.subjectAltName.trim().length === 0
    ) {
      return hostnameError(
        "Certificado TLS PostgreSQL sem Subject Alternative Name."
      );
    }
    return nodeTls.checkServerIdentity(
      expectedHostname,
      peerCertificate
    );
  };
}

function loadSystemPostgresTls(env = process.env, hostname) {
  assertSystemTrustOnly(env);
  const servername = exactServername(hostname);
  return Object.freeze({
    checkServerIdentity: exactCheckServerIdentity(servername),
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
    servername
  });
}

module.exports = {
  CUSTOM_TRUST_ENVIRONMENT_NAMES,
  assertSystemTrustOnly,
  loadSystemPostgresTls
};
