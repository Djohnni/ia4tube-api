"use strict";

const crypto = require("node:crypto");
const { ProductionTenantBindingError } = require("./production-tenant-binding");
const { SESSION_AUDIENCE, SESSION_ISSUER } = require("./reauth");

const PROVISIONING_TIMEOUT_MS = 2000;
const MAX_IN_FLIGHT = 3;
const DISABLED = Object.freeze({ available: false, code: "social_persistence_disabled" });
const READY = Object.freeze({ available: true, code: "social_tenant_ready" });
const UNAVAILABLE = Object.freeze({ available: false, code: "social_tenant_provisioning_unavailable" });
const SAFE_FAILURE_CODES = new Set([
  "social_tenant_owner_unavailable", "social_tenant_owner_temporary",
  "social_tenant_binding_conflict", "social_tenant_provisioning_unavailable",
  "social_tenant_provisioning_busy", "social_tenant_provisioning_timeout",
  "social_tenant_provisioning_shutdown_pending"
]);

// Internal callback for the five official POST session issuances. This does
// NOT authenticate a caller by merely accepting an owner string: the login
// handler MUST already have validated credentials/Google identity or committed
// the authorized registration/finalization. Never mount this as an endpoint.
function createProductionTenantProvisioning(options = {}) {
  if (options.enabled !== true) return Object.freeze({
    async afterAuthentication() { return DISABLED; },
    async close() { return Object.freeze({ settled: true, inFlightCount: 0 }); },
    status() { return Object.freeze({ closed: false, inFlightCount: 0 }); }
  });
  const { readClients, getDependencies, logger } = options;
  if (typeof readClients !== "function" || typeof getDependencies !== "function") {
    throw new TypeError("Configuracao de vinculo da empresa invalida.");
  }
  const schedule = options.setTimeout || setTimeout;
  const unschedule = options.clearTimeout || clearTimeout;
  const inFlight = new Map();
  let closed = false;
  function unavailable(code = UNAVAILABLE.code) {
    const safeCode = SAFE_FAILURE_CODES.has(code) ? code : UNAVAILABLE.code;
    try {
      if (typeof logger?.warn === "function") logger.warn(Object.freeze({
        component: "social_tenant_provisioning", code: safeCode
      }));
    } catch { /* A logger must never break the legitimate product login. */ }
    return safeCode === UNAVAILABLE.code ? UNAVAILABLE : Object.freeze({ available: false, code: safeCode });
  }

  async function afterAuthentication(owner) {
    let timer;
    try {
      if (closed) return unavailable();
      if (typeof owner !== "string" || owner.length < 1 || owner.length > 200 ||
          owner === "." || owner === ".." || /[\/\\?#\u0000-\u0020\u007f]/.test(owner)) {
        return unavailable("social_tenant_owner_unavailable");
      }
      const clients = readClients();
      const client = clients && Object.hasOwn(clients, owner) ? clients[owner] : null;
      if (!client || client.ativo !== true) return unavailable("social_tenant_owner_unavailable");
      // A temporary automatic login can be renamed exactly once. Do not create
      // a social tenant that would later have to be guessed/moved by username.
      if (client.cadastro_automatico === true && client.conta_finalizada !== true) {
        return unavailable("social_tenant_owner_temporary");
      }
      const dependencies = getDependencies();
      if (typeof dependencies?.authAdapter?.fromVerifiedJwt !== "function" ||
          typeof dependencies?.tenants?.ensureOfficialOwner !== "function") return unavailable();
      // Internal claims represent authentication just completed by the official
      // handler, before its JWT is issued. No unsigned HTTP claims are consumed.
      const principal = dependencies.authAdapter.fromVerifiedJwt(Object.freeze({
        token_version: 2, iss: SESSION_ISSUER, aud: SESSION_AUDIENCE,
        sub: owner, whatsapp: owner, company_id: owner, jti: crypto.randomUUID()
      }));
      const key = `${principal.companyId}/${principal.userId}/${principal.derivationVersion}`;
      let operation = inFlight.get(key);
      if (!operation) {
        if (inFlight.size >= MAX_IN_FLIGHT) return unavailable("social_tenant_provisioning_busy");
        operation = Promise.resolve().then(async () => {
          const result = await dependencies.tenants.ensureOfficialOwner(principal);
          if (result?.companyId !== principal.companyId || result?.userId !== principal.userId ||
              result?.identityDerivationVersion !== principal.derivationVersion || result?.role !== "owner") {
            throw new Error();
          }
          return READY;
        }).finally(() => {
          if (inFlight.get(key) === operation) inFlight.delete(key);
        });
        inFlight.set(key, operation);
        // Keep every started writer accounted for until it settles, even when
        // all login deadlines expired. This handler never retries a writer.
        operation.catch(() => {});
      }
      // This bounds login latency, not ownership of the transaction. A timed-out
      // transaction may finish later; its idempotent identity is unchanged and
      // no provider operation is started or automatically retried here.
      const deadline = new Promise((_, reject) => {
        timer = schedule(() => reject(new ProductionTenantBindingError("social_tenant_provisioning_timeout")), PROVISIONING_TIMEOUT_MS);
      });
      return await Promise.race([operation, deadline]);
    } catch (error) {
      return unavailable(error instanceof ProductionTenantBindingError ? error.code : UNAVAILABLE.code);
    } finally {
      if (timer !== undefined) unschedule(timer);
    }
  }
  async function close() {
    closed = true;
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([...inFlight.values()]),
        new Promise(resolve => { timer = schedule(resolve, PROVISIONING_TIMEOUT_MS); })
      ]);
      if (inFlight.size) unavailable("social_tenant_provisioning_shutdown_pending");
      return Object.freeze({ settled: inFlight.size === 0, inFlightCount: inFlight.size });
    } finally {
      if (timer !== undefined) unschedule(timer);
    }
  }
  function status() { return Object.freeze({ closed, inFlightCount: inFlight.size }); }
  return Object.freeze({ afterAuthentication, close, status });
}

module.exports = { DISABLED, READY, UNAVAILABLE, MAX_IN_FLIGHT, PROVISIONING_TIMEOUT_MS, createProductionTenantProvisioning };
