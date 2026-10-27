"use strict";
const { assertWebServiceDatabaseCredentialBoundary } = require("../persistence/postgres/config");
const OFFICIAL_API_ORIGIN = "https://ia4tube-api.onrender.com";
const OFFICIAL_WEB_SERVICE_ID = "srv-d8708kd7vvec73ap1p6g";
const PREPARATION_INCOMPLETE = "social_production_preparation_incomplete";
const SAFE_STARTUP_ERROR_CODE = /^[a-z0-9_]{2,96}$/i;
const CLOSED_FLAGS = Object.freeze([
  "SOCIAL_PERSISTENCE_ENABLED", "SOCIAL_INSTAGRAM_ENABLED", "SOCIAL_CALENDAR_ENABLED", "SOCIAL_MEDIA_IMPORTS_ENABLED",
  "SOCIAL_EXTERNAL_CONNECTION_ENABLED", "SOCIAL_EXTERNAL_PUBLICATION_ENABLED",
  "SOCIAL_PRODUCTION_CUSTOMER_ACCESS_ENABLED",
  "REAL_REVIEWER_UI_ENABLED", "META_APP_REVIEW_WINDOW_ENABLED",
  "REVIEW_SANDBOX_ENABLED", "SYNTHETIC_PROVIDER_ENABLED"
]);
const PENDING_CONTRACTS = Object.freeze(["production_schema_and_recovery", "production_tenant_provisioning"]);
function refuse(code) {
  const error = new Error("Integracao social de producao indisponivel.");
  error.code = code;
  throw error;
}
function safeStartupError(error, fallback) {
  if (SAFE_STARTUP_ERROR_CODE.test(String(error?.code || ""))) return error;
  const failure = new Error("Inicializacao social recusada.");
  failure.code = fallback;
  return failure;
}
function configured(value) { return value !== undefined && value !== ""; }
function assertProductionPreparationBoundary(env = process.env) {
  for (const name of CLOSED_FLAGS) {
    if (env[name] !== undefined && env[name] !== "" && env[name] !== "false" && env[name] !== "true") refuse("social_production_flag_invalid");
  }
  if (env.SOCIAL_PRODUCTION_CUSTOMER_ACCESS_ENABLED === "") refuse("social_production_flag_invalid");
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
  if (env.SOCIAL_CALENDAR_ENABLED === "true" && env.SOCIAL_INSTAGRAM_ENABLED !== "true") refuse(PREPARATION_INCOMPLETE);
  if (env.SOCIAL_MEDIA_IMPORTS_ENABLED === "true" && (env.SOCIAL_CALENDAR_ENABLED !== "true" ||
      env.SOCIAL_EXTERNAL_CONNECTION_ENABLED !== "false" || env.SOCIAL_EXTERNAL_PUBLICATION_ENABLED !== "false")) refuse(PREPARATION_INCOMPLETE);
  assertWebServiceDatabaseCredentialBoundary(env);
  return true;
}
function noStore(res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Referrer-Policy", "no-referrer");
}
// Drain dependent resources in order. A failed pilot cleanup must not skip the
// existing tenant/runtime cleanup or leave their database pools alive.
async function closeProductionResources(steps) {
  let failed = false;
  for (const step of steps) {
    try { await step(); } catch { failed = true; }
  }
  if (failed) refuse("social_startup_cleanup_failed");
}
async function initializeProductionReadyVideo({ env, ports, dependencies, rootDirectory = "/var/data/private/calendar-media" }) {
  if (env.SOCIAL_READY_VIDEO_IMPORTS_ENABLED === undefined || env.SOCIAL_READY_VIDEO_IMPORTS_ENABLED === "false") return null;
  let capacityPool, transferPool, video, closePromise, closed = false;
  function report(code) {
    try {
      const pending = dependencies.logger?.warn?.({ component: "calendar_ready_video", code });
      if (pending && typeof pending.then === "function") pending.catch(() => {});
    } catch { /* Diagnostics never disable the existing product paths. */ }
  }
  function close() {
    if (!closePromise) {
      closed = true;
      closePromise = closeProductionResources([
        async () => { const state = video; video = null; await state?.close(); },
        async () => { const pool = capacityPool; capacityPool = null; await pool?.end(); },
        async () => { const pool = transferPool; transferPool = null; await pool?.end(); }
      ]);
    }
    return closePromise;
  }
  async function unavailable() {
    report("calendar_ready_video_unavailable");
    try { await close(); } catch { report("calendar_ready_video_cleanup_failed"); }
  }
  try {
    // This optional flag is intentionally not part of the API's fatal startup
    // boundary. A malformed/unready video setup closes only this feature.
    const { loadReadyVideoConfig, loadReadyVideoPoolConfigs } = require("./calendar/imports/ready-video-config");
    const config = loadReadyVideoConfig(env);
    if (!config.enabled) return null;
    if (env.SOCIAL_MEDIA_IMPORTS_ENABLED === "true" || dependencies.importsRuntimeFactory !== undefined ||
        typeof dependencies.readClients !== "function" || typeof ports.identity !== "function") refuse("ready_video_configuration_invalid");
    const subjects = new Map();
    function active(subject) {
      const clients = dependencies.readClients();
      const client = clients && Object.hasOwn(clients, subject) ? clients[subject] : null;
      return Boolean(client && client.ativo === true && !(client.cadastro_automatico === true && client.conta_finalizada !== true));
    }
    function resolveOwnerForSubject(subject) {
      if (!config.subjects.includes(subject) || !active(subject)) refuse("ready_video_owner_unavailable");
      const owner = ports.identity(subject, subject);
      if (!owner?.companyId || !owner?.userId) refuse("ready_video_owner_unavailable");
      subjects.set(`${owner.companyId}:${owner.userId}`, subject);
      return owner;
    }
    for (const subject of config.subjects) resolveOwnerForSubject(subject);
    const fs = require("node:fs/promises"), path = require("node:path");
    const root = path.resolve(rootDirectory), work = path.join(root, "ready-video");
    const uploads = path.join(root, "uploads"), prepared = path.join(root, "prepared"),
      inspection = path.join(work, "inspection"), preparation = path.join(work, "preparation"), codec = path.join(work, "codec");
    for (const directory of [root, uploads, prepared, work, inspection, preparation, codec]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await require("./calendar/imports/media-process-executor").safePath(directory);
      const stat = await fs.stat(directory);
      if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) refuse("ready_video_storage_permissions_invalid");
    }
    const configs = await loadReadyVideoPoolConfigs({ env });
    const { createPostgresPool } = require("../persistence/postgres/pool");
    capacityPool = createPostgresPool(configs.capacity, { logger: dependencies.logger });
    transferPool = createPostgresPool(configs.transfer, { logger: dependencies.logger });
    const codecExecutor = require("./calendar/imports/ready-video-codec-executor").createReadyVideoCodecExecutor({
      workingRoot: codec, allowedRoots: [uploads, prepared, inspection, preparation] });
    video = await require("./calendar/imports/ready-video-runtime").createReadyVideoRuntime({ env,
      tenantPool: ports.pool, capacityPool, transferPool, codecExecutor, rootDirectory: root,
      resolveOwnerForSubject, isEligibleOwner(owner) {
        const subject = subjects.get(`${owner.companyId}:${owner.userId}`);
        return typeof subject === "string" && active(subject);
      }, clock: dependencies.clock, logger: dependencies.logger });
    if (!video?.factory || typeof video.start !== "function" || typeof video.close !== "function") refuse("ready_video_runtime_invalid");
    const factory = video.factory;
    return Object.freeze({ factory, onImportsUnavailable: unavailable,
      start() { if (!closed) video?.start(); }, close });
  } catch { await unavailable(); return null; }
}
function createProductionSocialIntegration(options = {}) {
  const env = Object.freeze({ ...(options.env || process.env) });
  assertProductionPreparationBoundary(env);
  const enabled = env.SOCIAL_PERSISTENCE_ENABLED === "true";
  let mounted = null, runtime = null, initialization = null, visualReturn = null;
  let tenantProvisioning = null, mediaPilot = null, readyVideo = null, closePromise = null;
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
    let startupStage = "social_startup_session_failed";
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
      startupStage = "social_startup_session_failed";
      const session = createProductionSession({ secret: dependencies.secret, readClients: dependencies.readClients });
      startupStage = "social_startup_media_failed";
      const mediaSurface = createProductionMedia({ env, dataDir: dependencies.dataDir, readClients: dependencies.readClients });
      // Physical runtime role/schema validation happens before the HTTP listener.
      // No operator credential or migration is permitted in this webservice.
      startupStage = "social_startup_server_runtime_failed";
      runtime = await initializeSocialServerRuntime({ env,
        realReviewerEnabled: env.SOCIAL_INSTAGRAM_ENABLED === "true",
        createCalendar: env.SOCIAL_CALENDAR_ENABLED === "true" ? async ports => {
          mediaPilot = await require("./calendar/imports/production-pilot").createProductionMediaPilot({env,tenantPool:ports.pool,logger:dependencies.logger});
          if (mediaPilot && dependencies.importsRuntimeFactory !== undefined) refuse("calendar_media_pilot_factory_conflict");
          readyVideo = await initializeProductionReadyVideo({ env, ports, dependencies });
          if (readyVideo) return require("./calendar").createProductionCalendar({ ...dependencies, reviewerMedia: mediaSurface.media,
            importsRuntimeFactory: readyVideo.factory, onImportsUnavailable: readyVideo.onImportsUnavailable }, ports);
          return require("./calendar").createProductionCalendar(mediaPilot ? {...dependencies,reviewerMedia:mediaSurface.media,importsRuntimeFactory:mediaPilot.factory} :
            {...dependencies,reviewerMedia:mediaSurface.media}, ports);
        } : undefined,
        realReviewerMedia: mediaSurface.media, logger: dependencies.logger });
      startupStage = "social_startup_tenant_binding_failed";
      const { createProductionTenantReadiness } = require("./production-tenant-readiness");
      const { createProductionTenantProvisioning } = require("./production-tenant-provisioning");
      tenantProvisioning = createProductionTenantProvisioning({ enabled: true,
        readClients: dependencies.readClients, logger: dependencies.logger,
        getDependencies: () => ({ authAdapter: runtime?.auth, tenants: runtime?.tenantProvisioning }) });
      const readiness = createProductionTenantReadiness({ authAdapter: runtime.auth, companies: runtime.companies });
      const authenticateSocial = (req, res, next) => session.authenticate(req, res,
        () => readiness.middleware(req, res, next));
      startupStage = "social_startup_http_assembly_failed";
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
      // Grant-scoped bytes precede body parsers; disabled runtime still refuses
      // every transfer. No processing or worker startup occurs in these routes.
      router.use("/calendar/imports/bytes", require("./calendar/imports/transfer-router").createCalendarImportByteRouter({
        getService: () => runtime?.calendar?.imports?.transfer, logger: dependencies.logger }));
      router.use(express.json({ limit: "16kb", strict: true }));
      router.use("/calendar/imports", require("./calendar/imports/preview-router").createPrivateImportPreviewRouter({
        authenticate: authenticateSocial, resolvePrincipal: claims => runtime.auth.fromVerifiedJwt(claims),
        getService: () => runtime?.calendar?.imports?.preview,
        getScheduledService: () => runtime?.calendar?.imports?.scheduling || runtime?.calendar?.storedImportMedia }));
      router.use("/calendar/imports", require("./calendar/imports/router").createCalendarImportRouter({
        authenticate: authenticateSocial, resolvePrincipal: claims => runtime.auth.fromVerifiedJwt(claims),
        getService: () => runtime?.calendar?.imports, logger: dependencies.logger }));
      router.use("/calendar", require("./calendar/router").createCalendarRouter({
        authenticate: authenticateSocial, getService: () => runtime?.calendar, logger: dependencies.logger }));
      router.use(createInstagramOAuthRouter({ authenticate: authenticateSocial, visualReturn,
        getService: () => runtime.instagramOAuth }));
      router.use("/reviewer", createInstagramRealReviewerRouter({ authenticate: authenticateSocial,
        getService: () => runtime.instagramReviewer }));
      router.use((_req, res) => res.status(404).json({ ok: false, code: "social_route_not_found" }));
      router.use((_error, _req, res, _next) => res.status(400).json({ ok: false, code: "social_request_invalid" }));
      mounted = router;
      runtime.calendar?.start();
      mediaPilot?.start();
      readyVideo?.start();
      startupStage = "social_startup_complete";
      return true;
    })();
    try { return await initialization; }
    catch (error) {
      const failure = safeStartupError(error, startupStage);
      try { await close(); }
      catch (cleanupError) {
        throw safeStartupError(cleanupError, "social_startup_cleanup_failed");
      }
      throw failure;
    }
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
  function close() {
    if (closePromise) return closePromise;
    mounted = null;
    closePromise = closeProductionResources([
      ...(readyVideo ? [async () => { const video = readyVideo; readyVideo = null; await video.close(); }] : []),
      async () => { if (mediaPilot) { const pilot = mediaPilot; mediaPilot = null; await pilot.close(); } },
      async () => { const provisioning = tenantProvisioning; tenantProvisioning = null; if (provisioning) await provisioning.close(); },
      () => { const visual = visualReturn; visualReturn = null; visual?.destroy(); },
      async () => { if (runtime) { const state = runtime; runtime = null; await state.close(); } }
    ]);
    return closePromise;
  }
  return Object.freeze({ enabled, reason: enabled ? null : PREPARATION_INCOMPLETE,
    async privateMediaMiddleware(req, res, next) {
      if (!String(req.url || "").startsWith("/internal/calendar-media/")) return next();
      noStore(res);
      try { if (mediaPilot && await mediaPilot.handlePrivateRequest(req,res)) return; }
      catch (_) { if (res.headersSent) return res.destroy(); }
      return res.status(503).json({ok:false,code:"calendar_media_private_unavailable"});
    },
    async prepareCalendarRequest(claims, body) {
      if (body?.calendar_automatic !== true && body?.calendar_automatic !== "true") return null;
      if (!runtime?.calendar) require("./calendar/model").fail("calendar_disabled", 503);
      return runtime.calendar.prepareRequest(claims, body.calendar_automatic, body.calendar_preference_revision);
    },
    async calendarOverlay(claims, payload) { return runtime?.calendar ? runtime.calendar.overlay(claims, payload) : payload; },
    async calendarEdit(claims, key, input) { return runtime?.calendar ? runtime.calendar.legacyEdit(claims, key, input) : false; },
    pendingContracts: PENDING_CONTRACTS, afterAuthentication, middleware, initialize, mountWeb, close });
}
module.exports = { CLOSED_FLAGS, OFFICIAL_API_ORIGIN, OFFICIAL_WEB_SERVICE_ID,
  PENDING_CONTRACTS, PREPARATION_INCOMPLETE, assertProductionPreparationBoundary,
  createProductionSocialIntegration, closeProductionResources, safeStartupError, initializeProductionReadyVideo };
