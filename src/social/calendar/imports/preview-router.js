"use strict";
const express = require("express");
const { isAuthenticatedSocialPrincipal } = require("../../auth-adapter");
const { isPrivateImportPreviewService } = require("./preview-service");
const { isCalendarImportService } = require("./local-calendar-service");
const { isStoredCalendarMediaReader } = require("./stored-calendar-media");
const { createSingleProcessTransferLimiter } = require("./transfer-service");
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const PATH = new RegExp(`^/assets/(${UUID})/revisions/([1-9][0-9]{0,5})/preview(?:/(feed|story|reel|thumbnail))?$`);
const SCHEDULE_PATH = /^\/schedules\/([a-f0-9]{40})\/preview(?:\/(feed|story|reel|thumbnail))?$/;
const ORIGINS = new Set(["https://ia4tube-api.onrender.com", "https://ia4tube.com", "https://www.ia4tube.com"]);
function fail(code = "import_preview_unavailable", statusCode = 503) { throw Object.assign(new Error(code), { code, statusCode }); }
function writeBounded(res, bytes, signal) {
  if (signal.aborted || res.destroyed) return Promise.reject(new Error("preview_interrupted"));
  if (res.write(bytes)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const clean = () => { res.off("drain", drained); res.off("close", closed); res.off("error", closed); signal.removeEventListener("abort", closed); };
    const drained = () => { clean(); resolve(); };
    const closed = () => { clean(); reject(new Error("preview_interrupted")); };
    res.once("drain", drained); res.once("close", closed); res.once("error", closed); signal.addEventListener("abort", closed, { once: true });
    if (signal.aborted || res.destroyed) closed();
  });
}
/** Independent authenticated read router, not mounted in production. Put before
 * the metadata router's final 404. It has no write, preparation or publish action.
 */
function createPrivateImportPreviewRouter({ authenticate, resolvePrincipal, getService, getScheduledService, timeoutMs = 60000 } = {}) {
  if ([authenticate, resolvePrincipal, getService].some(x => typeof x !== "function") || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError("preview_router_configuration_invalid");
  const router = express.Router({ caseSensitive: true, strict: true });
  const limiter = createSingleProcessTransferLimiter({ maxConcurrent: 2, maxPerCompany: 2 });
  router.use((req, res, next) => {
    // Unrelated metadata routes remain available in the subsequent existing router.
    if (!/\/preview(?:\/|\?|$)/.test(req.url)) return next("router");
    res.set({ "Cache-Control": "private, no-store", Pragma: "no-cache", "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive", "Cross-Origin-Resource-Policy": "same-origin" });
    next();
  });
  router.use(authenticate);
  router.use(async (req, res) => {
    const abort = new AbortController();
    const timer = setTimeout(() => { abort.abort(); res.destroy(); }, timeoutMs); timer.unref();
    const close = () => { if (!res.writableFinished) abort.abort(); };
    req.once("aborted", close); res.once("close", close); res.on("error", close);
    try {
      const scheduled = SCHEDULE_PATH.exec(req.url), match = scheduled || PATH.exec(req.url);
      if (!match) fail("import_preview_not_found", 404);
      if (!["GET", "HEAD"].includes(req.method)) { res.set("Allow", "GET, HEAD"); fail("import_preview_method_invalid", 405); }
      if (req.headers.origin && !ORIGINS.has(req.headers.origin) || req.headers["sec-fetch-site"] === "cross-site") fail("import_preview_origin_forbidden", 403);
      if (req.headers["transfer-encoding"] || req.headers["content-encoding"] || req.headers["content-length"] && req.headers["content-length"] !== "0") fail("import_preview_request_invalid", 400);
      const duplicate = new Set();
      for (let n = 0; n < req.rawHeaders.length; n += 2) {
        const name = req.rawHeaders[n].toLowerCase();
        if (["range", "authorization", "origin"].includes(name) && duplicate.has(name)) fail("import_preview_request_invalid", 400);
        duplicate.add(name);
      }
      await limiter.run(async () => {
        if (abort.signal.aborted) fail();
        const principal = await resolvePrincipal(req.user);
        if (!isAuthenticatedSocialPrincipal(principal)) fail("import_preview_session_required", 401);
        return Object.freeze({ authenticated: true, companyId: principal.companyId, userId: principal.userId });
      }, async context => {
        if (abort.signal.aborted) fail();
        const service = scheduled ? getScheduledService?.() : getService();
        if (!(scheduled ? isCalendarImportService(service) || isStoredCalendarMediaReader(service) : isPrivateImportPreviewService(service)) || !service.available) fail();
        const input = scheduled ? { id: match[1] } : { assetId: match[1], mediaRevision: Number(match[2]) };
        const target = scheduled ? match[2] : match[3];
        if (!target) {
          if (req.headers.range) fail("import_preview_range_invalid", 416);
          const preview = await service.metadata(context, input);
          if (abort.signal.aborted) fail();
          res.json({ ok: true, preview }); return;
        }
        // If-Range is not used to serve a cached result; authentication and actual
        // immutable bytes are checked for every request. No ETag/304 fast path.
        const opened = await service.open(context, { ...input, target }, { rangeHeader: req.headers.range, signal: abort.signal });
        if (abort.signal.aborted) fail();
        const { descriptor, range } = opened;
        res.status(range.partial ? 206 : 200);
        res.set({ "Content-Type": descriptor.mimeType, "Content-Length": String(range.length), "Accept-Ranges": "bytes",
          "Content-Disposition": `inline; filename="preview.${descriptor.mimeType === "image/jpeg" ? "jpg" : "mp4"}"` });
        if (range.partial) res.set("Content-Range", `bytes ${range.start}-${range.end}/${descriptor.sizeBytes}`);
        if (req.method !== "HEAD") await opened.stream(bytes => writeBounded(res, bytes, abort.signal));
        res.end();
      });
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      // A failure after preflight must not keep a binary length/content-type.
      for (const name of ["Content-Length", "Content-Range", "Content-Disposition", "Accept-Ranges"]) res.removeHeader(name);
      res.type("application/json");
      const code = /^import_preview_[a-z_]{1,70}$/.test(error?.code || "") ? error.code : error?.code === "import_transfer_busy" ? "import_preview_busy" :
        error?.code === "calendar_import_not_found" ? "import_preview_not_found" : error?.code === "calendar_import_preview_changed" ? "import_preview_changed" : "import_preview_unavailable";
      const status = [400, 401, 403, 404, 405, 409, 416, 429, 503].includes(error?.statusCode) ? error.statusCode : 503;
      res.status(status).json({ ok: false, code, error: "Não foi possível abrir esta prévia. Confira o arquivo e a sessão." });
    } finally { clearTimeout(timer); abort.abort(); req.off("aborted", close); res.off("close", close); res.off("error", close); }
  });
  return router;
}
module.exports = { createPrivateImportPreviewRouter };
