"use strict";
const { assertWebServiceDatabaseCredentialBoundary } = require("../persistence/postgres/config");
const OFFICIAL_API_ORIGIN = "https://ia4tube-api.onrender.com";
const OFFICIAL_WEB_SERVICE_ID = "srv-d8708kd7vvec73ap1p6g";
const PREPARATION_INCOMPLETE = "social_production_preparation_incomplete";
const CLOSED_FLAGS = Object.freeze([
  "SOCIAL_PERSISTENCE_ENABLED", "SOCIAL_INSTAGRAM_ENABLED",
  "SOCIAL_EXTERNAL_CONNECTION_ENABLED", "SOCIAL_EXTERNAL_PUBLICATION_ENABLED",
  "REAL_REVIEWER_UI_ENABLED", "META_APP_REVIEW_WINDOW_ENABLED",
  "REVIEW_SANDBOX_ENABLED", "SYNTHETIC_PROVIDER_ENABLED"
]);
const PENDING_CONTRACTS = Object.freeze(["production_schema_and_recovery", "production_tenant_provisioning"]);
function refuse(code) {
  const error = new Error("Integracao social de producao indisponivel.");
  error.code = code;
  throw error;
}
function configured(value) { return value !== undefined && value !== ""; }
function assertProductionPreparationBoundary(env = process.env) {
  for (const name of CLOSED_FLAGS) {
    if (env[name] !== undefined && env[name] !== "" && env[name] !== "false" && env[name] !== "true") refuse("social_production_flag_invalid");
  }
  for (const name of ["REVIEW_SANDBOX_ENABLED", "SYNTHETIC_PROVIDER_ENABLED", "META_APP_REVIEW_WINDOW_ENABLED"]) {
    if (env[name] === "true") refuse(PREPARATION_INCOMPLETE);
  }
  const enabled = env.SOCIAL_PERSISTENCE_ENABLED === "true";
  if (configured(env.ENVIRONMENT) && env.ENVIRONMENT !== "production") refuse("social_production_environment_mismatch");
  const legacyTest = !enabled && env.NODE_ENV === "test" && !configured(env.ENVIRONMENT) &&
    !configured(env.RENDER_SERVICE_ID) && ["https://synthetic.invalid", "https://ia4tube.test"].includes(env.PUBLIC_API_BASE_URL);
  if (configured(env.PUBLIC_API_BASE_URL) &&
      String(env.PUBLIC_API_BASE_URL).replace(/\/+$/, "") !== OFFICIAL_API_ORIGIN && !legacyTest) refuse("social_production_origin_mismatch");
  if (configured(env.RENDER_SERVICE_ID) && env.RENDER_SERVICE_ID !== OFFICIAL_WEB_SERVICE_ID) refuse("social_production_service_mismatch");
  if (enabled && (env.ENVIRONMENT !== "production" || env.PUBLIC_API_BASE_URL !== OFFICIAL_API_ORIGIN ||
      (env.RENDER === "true" && env.RENDER_SERVICE_ID !== OFFICIAL_WEB_SERVICE_ID))) refuse(PREPARATION_INCOMPLETE);
  if (!enabled && CLOSED_FLAGS.some(name => name !== "SOCIAL_PERSISTENCE_ENABLED" && env[name] === "true")) refuse(PREPARATION_INCOMPLETE);
  assertWebServiceDatabaseCredentialBoundary(env);
  return true;
}
function noStore(res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Referrer-Policy", "no-referrer");
}
function createProductionSocialIntegration(options = {}) {
  const env = Object.freeze({ ...(options.env || process.env) });
  assertProductionPreparationBoundary(env);
  const enabled = env.SOCIAL_PERSISTENCE_ENABLED === "true";
  let mounted = null, runtime = null, initialization = null, visualReturn = null;
  let tenantProvisioning = null;
  async function afterAuthentication(owner) {
    // The disabled path must not read product records, initialize dependencies,
    // derive an identity or open a pool. Session issuance remains unchanged.
    if (!enabled) return Object.freeze({ available: false, code: "social_persistence_disabled" });
    if (!tenantProvisioning) return Object.freeze({ available: false, code: "social_tenant_provisioning_unavailable" });
    return tenantProvisioning.afterAuthentication(owner);
  }
  function middleware(req, res, next) {
    noStore(res);
    if (!mounted) return res.status(503).json({ ok: false, code: PREPARATION_INCOMPLETE,
      error: "A integracao com o Instagram ainda nao esta disponivel." });
    return mounted(req, res, next);
  }
  async function initialize(dependencies = {}) {
    if (!enabled) return false;
    if (initialization) return initialization;
    initialization = (async () => {
      const express = require("express");
      const { createProductionSession } = require("./production-session");
      const { createProductionMedia } = require("./production-media");
      const { initializeSocialServerRuntime } = require("./server-runtime");
      const { createInstagramOAuthRouter } = require("./oauth/instagram-oauth-router");
      const { createInstagramOAuthVisualReturn } = require("./oauth/instagram-oauth-visual-return");
      const { createInstagramRealReviewerRouter } = require("./reviewer-real/reviewer-real");
      const { createMetaComplianceRouter } = require("./compliance");
      const { createRateLimiter } = require("../security/runtime-security");
      const session = createProductionSession({ secret: dependencies.secret, readClients: dependencies.readClients });
      const mediaSurface = createProductionMedia({ env, dataDir: dependencies.dataDir, readClients: dependencies.readClients });
      // Physical runtime role/schema validation happens before the HTTP listener.
      // No operator credential or migration is permitted in this webservice.
      runtime = await initializeSocialServerRuntime({ env,
        realReviewerEnabled: env.SOCIAL_INSTAGRAM_ENABLED === "true",
        realReviewerMedia: mediaSurface.media, logger: dependencies.logger });
      const { createProductionTenantReadiness } = require("./production-tenant-readiness");
      const { createProductionTenantProvisioning } = require("./production-tenant-provisioning");
      tenantProvisioning = createProductionTenantProvisioning({ enabled: true,
        readClients: dependencies.readClients, logger: dependencies.logger,
        getDependencies: () => ({ authAdapter: runtime?.auth, tenants: runtime?.tenantProvisioning }) });
      const readiness = createProductionTenantReadiness({ authAdapter: runtime.auth, companies: runtime.companies });
      const authenticateSocial = (req, res, next) => session.authenticate(req, res,
        () => readiness.middleware(req, res, next));
      visualReturn = createInstagramOAuthVisualReturn({ publicOrigin: OFFICIAL_API_ORIGIN,
        returnPath: "/reviewer", surfaceMode: "reviewer-real" });
      const router = express.Router();
      router.use(createRateLimiter({ windowMs: 60 * 1000, max: 120,
        code: "social_rate_limited", message: "Aguarde antes de tentar novamente." }));
      router.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && ![OFFICIAL_API_ORIGIN, "https://ia4tube.com", "https://www.ia4tube.com"].includes(origin)) {
          return res.status(403).json({ ok: false, code: "social_origin_forbidden" });
        }
        return next();
      });
      router.get("/reviewer/media-capability/:mediaId/:expiresAt/:nonce/:ownerContext/:signature", mediaSurface.capability);
      router.use("/compliance", express.urlencoded({ extended: false, limit: "32kb", parameterLimit: 1 }),
        createMetaComplianceRouter({ getService: () => runtime.metaCompliance }));
      router.use(express.json({ limit: "16kb", strict: true }));
      router.use(createInstagramOAuthRouter({ authenticate: authenticateSocial, visualReturn,
        getService: () => runtime.instagramOAuth }));
      router.use("/reviewer", createInstagramRealReviewerRouter({ authenticate: authenticateSocial,
        getService: () => runtime.instagramReviewer }));
      router.use((_req, res) => res.status(404).json({ ok: false, code: "social_route_not_found" }));
      router.use((_error, _req, res, _next) => res.status(400).json({ ok: false, code: "social_request_invalid" }));
      mounted = router;
      return true;
    })();
    try { return await initialization; }
    catch (error) { await close(); throw error; }
  }
  function mountWeb(app) {
    if (env.REAL_REVIEWER_UI_ENABLED !== "true") return;
    const path = require("node:path");
    const send = file => (_req, res) => {
      noStore(res);
      if (!mounted) return res.status(503).end();
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      return res.sendFile(path.join(__dirname, "production-web", file));
    };
    app.get("/reviewer", send("reviewer.html"));
    app.get("/reviewer-client.js", send("reviewer.js"));
    app.get("/reviewer-style.css", send("reviewer.css"));
  }
  async function close() {
    mounted = null;
    const provisioning = tenantProvisioning;
    tenantProvisioning = null;
    if (provisioning) await provisioning.close();
    visualReturn?.destroy();
    if (runtime) { const state = runtime; runtime = null; await state.close(); }
  }
  return Object.freeze({ enabled, reason: enabled ? null : PREPARATION_INCOMPLETE,
    pendingContracts: PENDING_CONTRACTS, afterAuthentication, middleware, initialize, mountWeb, close });
}
module.exports = { CLOSED_FLAGS, OFFICIAL_API_ORIGIN, OFFICIAL_WEB_SERVICE_ID,
  PENDING_CONTRACTS, PREPARATION_INCOMPLETE, assertProductionPreparationBoundary, createProductionSocialIntegration };
