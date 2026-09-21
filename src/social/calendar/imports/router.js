"use strict";
const express = require("express");
const { isAuthenticatedSocialPrincipal } = require("../../auth-adapter");
const { isCalendarImportService } = require("./local-calendar-service");
const { isOperationalCalendarImportsRuntime } = require("./operational-runtime");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_CODE = /^(?:import|calendar_import)_[a-z_]{1,90}$/;
const ORIGINS = new Set(["https://ia4tube-api.onrender.com", "https://ia4tube.com", "https://www.ia4tube.com"]);
const HTTP_DIAGNOSTIC_STAGES = new Set(["principal_resolution", "capability_read", "prepare_transaction"]);
const HTTP_SLOW_MS = 250;
function fail(code, statusCode = 400) { throw Object.assign(new Error(code), { code, statusCode }); }
function body(req, permitted = []) {
  const value = req.body || {};
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !permitted.includes(key))) fail("import_request_invalid");
  return value;
}
function uploadId(req) {
  if (!UUID.test(req.params.id || "")) fail("import_not_found", 404);
  return req.params.id.toLowerCase();
}
function partNumber(req) {
  if (!/^[1-9][0-9]{0,2}$/.test(req.params.partNumber || "")) fail("import_part_invalid");
  return Number(req.params.partNumber);
}

/** Metadata-only routes. Never receive a media body, log a grant, or run FFmpeg.
 * authenticate must verify the official JWT + active tenant before resolvePrincipal.
 * getService supplies a startup-verified facade; availability cannot come from HTTP.
 */
function createImportHttpObserver({ logger, monotonicClock = () => performance.now(), slowMs = HTTP_SLOW_MS } = {}) {
  if (typeof monotonicClock !== "function" || !Number.isSafeInteger(slowMs) || slowMs < 1 || slowMs > 60000) {
    throw new TypeError("calendar_import_router_configuration_invalid");
  }
  const now = () => {
    try { const value = monotonicClock(); return Number.isFinite(value) ? value : null; }
    catch { return null; }
  };
  const elapsed = started => {
    const finished = now(); if (started === null || finished === null) return null;
    const value = Math.floor(finished - started);
    return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 60000) : null;
  };
  const emit = (code, stage, elapsedMs) => {
    try {
      const pending = logger?.error?.(Object.freeze({ component: "calendar_media_http", code, stage, elapsedMs }));
      if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => {});
    }
    catch { /* Diagnostics cannot change the request result. */ }
  };
  return async (stage, operation) => {
    if (!HTTP_DIAGNOSTIC_STAGES.has(stage) || typeof operation !== "function") {
      throw new TypeError("calendar_import_router_configuration_invalid");
    }
    const started = now();
    try {
      const result = await operation(), elapsedMs = elapsed(started);
      if (elapsedMs !== null && elapsedMs >= slowMs) emit("calendar_media_http_slow", stage, elapsedMs);
      return result;
    } catch (error) {
      const elapsedMs = elapsed(started); if (elapsedMs !== null) emit("calendar_media_http_failed", stage, elapsedMs);
      throw error;
    }
  };
}
function createCalendarImportRouter({ authenticate, resolvePrincipal, getService, logger, monotonicClock, diagnosticSlowMs } = {}) {
  if ([authenticate, resolvePrincipal, getService].some(value => typeof value !== "function")) {
    throw new TypeError("calendar_import_router_configuration_invalid");
  }
  const observe = createImportHttpObserver({ logger, monotonicClock, slowMs: diagnosticSlowMs ?? HTTP_SLOW_MS });
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    next();
  });
  router.use(authenticate);
  router.use((req, _res, next) => {
    if (req.headers.origin && !ORIGINS.has(req.headers.origin)) return next(Object.assign(new Error(), { code: "import_origin_forbidden", statusCode: 403 }));
    if (req.headers["sec-fetch-site"] === "cross-site") return next(Object.assign(new Error(), { code: "import_origin_forbidden", statusCode: 403 }));
    if (Object.keys(req.query).length) return next(Object.assign(new Error(), { code: "import_request_invalid", statusCode: 400 }));
    if (req.method === "POST" && !req.is("application/json")) return next(Object.assign(new Error(), { code: "import_json_required", statusCode: 415 }));
    next();
  });
  router.use(express.json({ limit: "16kb", strict: true }));
  const call = (key, operation, { capabilities = false, admission = false, diagnosticStage = null } = {}) => async (req, res, next) => {
    try {
      const principal = diagnosticStage ? await observe("principal_resolution", () => resolvePrincipal(req.user)) : await resolvePrincipal(req.user);
      if (!isAuthenticatedSocialPrincipal(principal)) fail("import_session_required", 401);
      const service = getService();
      const context = isOperationalCalendarImportsRuntime(service) ? service.contextForPrincipal(principal)
        : Object.freeze({ authenticated: true, companyId: principal.companyId, userId: principal.userId });
      if (!service || service.ready !== true || typeof service.allowed !== "function" || !service.allowed(context)) {
        if (capabilities) return res.json({ ok: true, enabled: false });
        fail("import_unavailable", 503);
      }
      if (admission && typeof service.canAdmit === "function" && service.canAdmit(context) !== true) fail("import_pilot_admission_closed", 503);
      let result = diagnosticStage ? await observe(diagnosticStage, () => operation(service, context, req)) : await operation(service, context, req);
      if (capabilities && result.enabled === true) result = { ...result, identity: { companyId: context.companyId, userId: context.userId } };
      // A grant is intentionally returned only to the authenticated original owner.
      // No retry wrapper: a failed POST may already have committed.
      res.json(key ? { ok: true, [key]: result } : { ok: true, ...result });
    } catch (error) { next(error); }
  };
  router.get("/capabilities", call(null, (service, context) => service.capabilities(context), { capabilities: true, diagnosticStage: "capability_read" }));
  router.post("/uploads", call("upload", (service, context, req) => service.upload.start(context,
    body(req, ["idempotencyKey", "kind", "mimeType", "sizeBytes", "sha256"])), { admission: true }));
  router.get("/uploads/:id", call("upload", (service, context, req) => service.upload.status(context, { uploadId: uploadId(req) })));
  for (const action of ["resume", "complete", "cancel"]) {
    router.post(`/uploads/:id/${action}`, call("upload", (service, context, req) => {
      body(req); return service.upload[action](context, { uploadId: uploadId(req) });
    }));
  }
  router.post("/uploads/:id/parts/:partNumber/authorize", call("part", (service, context, req) => {
    const input = body(req, ["sha256", "md5Base64"]);
    if (!/^[a-f0-9]{64}$/.test(input.sha256 || "") || typeof input.md5Base64 !== "string" ||
        !/^[A-Za-z0-9+/]{22}==$/.test(input.md5Base64) || Buffer.from(input.md5Base64, "base64").toString("base64") !== input.md5Base64) fail("import_checksum_invalid");
    return service.upload.authorizePart(context, { ...input, uploadId: uploadId(req), partNumber: partNumber(req) });
  }));
  router.post("/uploads/:id/parts/:partNumber/resolve", call("grant", (service, context, req) => {
    const input = body(req, ["authorizationId"]);
    if (!UUID.test(input.authorizationId || "")) fail("import_grant_invalid");
    return service.upload.resolvePart(context, { ...input, uploadId: uploadId(req), partNumber: partNumber(req) });
  }));
  router.post("/assets/:assetId/prepare", call("asset", (service, context, req) => {
    if (!UUID.test(req.params.assetId || "")) fail("import_not_found", 404);
    if (!service.preparation) fail("import_preparation_unavailable", 503);
    return service.preparation.request(context, { ...body(req, ["uploadId", "idempotencyKey", "expectedMediaRevision", "selection"]), assetId: req.params.assetId.toLowerCase() });
  }, { admission: true, diagnosticStage: "prepare_transaction" }));
  router.get("/assets/:assetId", call("asset", (service, context, req) => {
    if (!UUID.test(req.params.assetId || "")) fail("import_not_found", 404);
    if (!service.preparation) fail("import_preparation_unavailable", 503);
    return service.preparation.status(context, { assetId: req.params.assetId.toLowerCase() });
  }));
  function scheduling(service) {
    if (!isCalendarImportService(service.scheduling)) fail("calendar_import_unavailable", 503);
    return service.scheduling;
  }
  router.get("/assets/:assetId/schedule-availability", call("availability", (service, context, req) =>
    scheduling(service).availability(context, req.params.assetId)));
  router.post("/assets/:assetId/schedule", call("schedule", (service, context, req) =>
    scheduling(service).schedule(context, { ...body(req, ["mediaRevision", "previewDigest", "idempotencyKey", "date", "time", "caption", "automatic", "confirmed"]),
      assetId: req.params.assetId })));
  router.get("/assets/:assetId/schedules/by-key/:key", call("schedule", (service, context, req) =>
    scheduling(service).byKey(context, req.params.assetId, req.params.key)));
  router.get("/schedules/:id", call("schedule", (service, context, req) => scheduling(service).get(context, req.params.id)));
  router.post("/sources/generated/:id", call(null, (service, context, req) =>
    scheduling(service).importGenerated(context, { ...body(req, ["revision", "idempotencyKey"]), calendarItemId: req.params.id }), { admission: true }));
  router.use((_req, res) => res.status(404).json({ ok: false, code: "import_route_not_found" }));
  router.use((error, _req, res, _next) => {
    const known = SAFE_CODE.test(error?.code || "");
    const parse = ["entity.too.large", "entity.parse.failed"].includes(error?.type);
    const status = parse ? (error.type === "entity.too.large" ? 413 : 400) :
      known && [400, 401, 403, 404, 409, 413, 415, 422, 429, 503].includes(error.statusCode) ? error.statusCode : 503;
    res.status(status).json({ ok: false, code: parse ? "import_request_invalid" : known ? error.code : "import_unavailable",
      error: "Não foi possível concluir. Confira o estado do envio antes de tentar novamente." });
  });
  return router;
}
module.exports = { HTTP_DIAGNOSTIC_STAGES, createCalendarImportRouter, createImportHttpObserver };
