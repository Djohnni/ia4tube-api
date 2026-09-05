"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  CUSTOM_TRUST_ENVIRONMENT_NAMES,
  loadSystemPostgresTls
} = require("../src/persistence/postgres/tls");
const {
  attemptLocalTlsHandshake,
  createLocalTlsFixture
} = require("./helpers/local-tls-handshake");

const HOST = "db.synthetic.example";

function assertRefused(env, hostname, code) {
  assert.throws(
    () => loadSystemPostgresTls(env, hostname),
    (error) => error?.code === code
  );
}

test("system trust compiles strict TLS options without custom material", () => {
  const tls = loadSystemPostgresTls({}, HOST);
  assert.equal(tls.rejectUnauthorized, true);
  assert.equal(tls.minVersion, "TLSv1.2");
  assert.equal(tls.servername, HOST);
  assert.equal(typeof tls.checkServerIdentity, "function");
  for (const name of ["ca", "cert", "key", "pfx", "secureContext"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(tls, name), false);
  }
  assert.equal(Object.isFrozen(tls), true);
});

test("exact hostname and SAN are validated by the Node verifier", (context) => {
  const fixture = createLocalTlsFixture(
    context,
    HOST,
    "other.synthetic.example"
  );
  const options = loadSystemPostgresTls({}, HOST);
  const validCertificate = new crypto.X509Certificate(
    fixture.correctLeaf.certificate
  ).toLegacyObject();
  assert.equal(
    options.checkServerIdentity(HOST, validCertificate),
    undefined
  );

  const wrongHostnameCertificate = new crypto.X509Certificate(
    fixture.wrongHostnameLeaf.certificate
  ).toLegacyObject();
  assert.equal(
    options.checkServerIdentity(HOST, wrongHostnameCertificate)?.code,
    "ERR_TLS_CERT_ALTNAME_INVALID"
  );
  assert.equal(
    options.checkServerIdentity(
      "other.synthetic.example",
      validCertificate
    )?.code,
    "ERR_TLS_CERT_ALTNAME_INVALID"
  );

  const missingSanCertificate = new crypto.X509Certificate(
    fixture.missingSanLeaf.certificate
  ).toLegacyObject();
  assert.equal(
    options.checkServerIdentity(HOST, missingSanCertificate)?.code,
    "ERR_TLS_CERT_ALTNAME_INVALID"
  );
  assert.equal(
    options.checkServerIdentity(HOST, { raw: Buffer.from("invalid") })
      ?.code,
    "ERR_TLS_CERT_ALTNAME_INVALID"
  );
});

test("default trust rejects untrusted and tampered certificate chains", async (context) => {
  const fixture = createLocalTlsFixture(
    context,
    HOST,
    "other.synthetic.example"
  );
  const options = loadSystemPostgresTls({}, HOST);

  const untrusted = await attemptLocalTlsHandshake(
    fixture.correctLeaf,
    options
  );
  assert.equal(untrusted.authorized, false);
  assert.equal(
    new Set([
      "CERT_UNTRUSTED",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_GET_ISSUER_CERT",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
    ]).has(untrusted.errorCode),
    true
  );

  const tampered = await attemptLocalTlsHandshake(
    fixture.tamperedLeaf,
    options
  );
  assert.equal(tampered.authorized, false);
  assert.equal(typeof tampered.errorCode, "string");
});

test("a trusted synthetic chain completes only for the exact SAN", async (context) => {
  const fixture = createLocalTlsFixture(
    context,
    HOST,
    "other.synthetic.example"
  );
  const productionOptions = loadSystemPostgresTls({}, HOST);

  // The synthetic CA is injected only into this local TLS harness. The
  // production loader above continues to reject every custom trust input.
  const accepted = await attemptLocalTlsHandshake(
    fixture.correctLeaf,
    { ...productionOptions, ca: fixture.trustedCa }
  );
  assert.deepEqual(accepted, {
    authorizationError: null,
    authorized: true,
    errorCode: null
  });

  const wrongHostname = await attemptLocalTlsHandshake(
    fixture.wrongHostnameLeaf,
    { ...productionOptions, ca: fixture.trustedCa }
  );
  assert.equal(wrongHostname.authorized, false);
  assert.equal(wrongHostname.errorCode, "ERR_TLS_CERT_ALTNAME_INVALID");
});

test("custom trust and certificate pinning inputs are refused", () => {
  for (const name of CUSTOM_TRUST_ENVIRONMENT_NAMES) {
    assertRefused(
      { [name]: "synthetic-custom-trust" },
      HOST,
      "social_database_custom_trust_forbidden"
    );
  }
});

test("only canonical external DNS hostnames are accepted", () => {
  for (const hostname of [
    "DB.synthetic.example",
    "db.synthetic.example.",
    "127.0.0.1",
    "db..synthetic.example",
    "render-internal-host"
  ]) {
    assertRefused({}, hostname, "social_database_tls_hostname_invalid");
  }
});

test("global TLS verification bypass is always refused", () => {
  assertRefused(
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    HOST,
    "node_tls_verification_disabled"
  );
  assertRefused(
    { NODE_TLS_REJECT_UNAUTHORIZED: " 0 " },
    HOST,
    "node_tls_verification_disabled"
  );
});
