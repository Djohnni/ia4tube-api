"use strict";
const express = require("express");
const { isRenderDiskTransferService } = require("./transfer-service");
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const PATH = new RegExp(`^/(${UUID})$`);
const ORIGINS = new Set(["https://ia4tube-api.onrender.com", "https://ia4tube.com", "https://www.ia4tube.com"]);
const CHECKSUM = /^[A-Za-z0-9+/]{43}=$/, MD5 = /^[A-Za-z0-9+/]{22}==$/;
function fail(code, statusCode = 400) { throw Object.assign(new Error(code), { code, statusCode }); }
// Use this with the host logger before routing. This module itself logs nothing.
function redactImportTransferUrl(value) {
  return String(value || "").replace(/(\/v1\/social\/calendar\/imports\/bytes)(?:[^\s]*)/gi, "$1/[redacted]");
}

/** Mount at /v1/social/calendar/imports/bytes BEFORE body parsers and access logs.
 * Do not place this under the authenticated metadata router: the short-lived
 * opaque grant is the authorization, and session cookies/JWTs are forbidden.
 */
function createCalendarImportByteRouter({ getService, timeoutMs = 30000 } = {}) {
  if (typeof getService !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError("import_transfer_configuration_invalid");
  const router = express.Router({ strict: true, caseSensitive: true });
  router.use(async (req, res) => {
    const deadline = performance.now() + timeoutMs;
    // Whole-request deadline includes registry/database lookups before the byte
    // receiver starts. Closing the socket does not recycle an unresolved slot.
    const timer = setTimeout(() => { req.destroy(); req.socket?.destroy(); }, timeoutMs);
    timer.unref();
    req.on("error", () => {}); // Abort remains an error to the async byte reader.
    res.set({ "Cache-Control": "private, no-store", Pragma: "no-cache", "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive" });
    try {
      const match = PATH.exec(req.url);
      if (!match) fail("import_transfer_not_found", 404);
      if (req.method !== "PUT") { res.set("Allow", "PUT"); fail("import_transfer_method_invalid", 405); }
      if (req.headers.authorization || req.headers.cookie || req.headers["proxy-authorization"] ||
          req.headers.origin && !ORIGINS.has(req.headers.origin) || req.headers["sec-fetch-site"] === "cross-site") fail("import_transfer_origin_forbidden", 403);
      if (req.body !== undefined || req.readableEncoding || req.headers["content-encoding"] || req.headers["transfer-encoding"] ||
          req.headers["content-range"] || req.headers.expect || req.headers["trailer"]) fail("import_transfer_body_invalid", 400);
      if (req.headers["content-type"] !== "application/octet-stream") fail("import_transfer_type_invalid", 415);
      const raw = req.rawHeaders || [], single = new Set(["content-length", "content-md5", "x-amz-checksum-sha256", "content-type"]), seen = new Set();
      for (let n = 0; n < raw.length; n += 2) {
        const key = raw[n].toLowerCase();
        if (single.has(key) && seen.has(key)) fail("import_transfer_header_invalid");
        seen.add(key);
      }
      const length = req.headers["content-length"], md5Base64 = req.headers["content-md5"], sha256Base64 = req.headers["x-amz-checksum-sha256"];
      if (!/^[1-9][0-9]{0,7}$/.test(length || "") || Number(length) > 5 * 1024 * 1024 ||
          !MD5.test(md5Base64 || "") || !CHECKSUM.test(sha256Base64 || "") ||
          Buffer.from(md5Base64, "base64").toString("base64") !== md5Base64 ||
          Buffer.from(sha256Base64, "base64").toString("base64") !== sha256Base64) fail("import_transfer_header_invalid");
      const service = getService();
      if (!isRenderDiskTransferService(service) || !service.available) fail("import_transfer_unavailable", 503);
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0 || req.aborted) fail("import_transfer_timeout", 408);
      const result = await service.acceptPart({ authorizationId: match[1], contentLength: Number(length),
        md5Base64, sha256Base64, stream: req, timeoutMs: remaining });
      res.json({ ok: true, part: result });
    } catch (error) {
      // Do not drain arbitrary hostile bodies to keep the connection alive.
      if (res.headersSent || res.destroyed) { req.destroy(); return; }
      const known = /^import_transfer_[a-z_]{1,60}$/.test(error?.code || "");
      const status = known && [400, 403, 404, 405, 408, 409, 413, 415, 422, 429, 503].includes(error.statusCode) ? error.statusCode : 503;
      res.set("Connection", "close");
      res.once("finish", () => { if (!req.complete) req.destroy(); });
      res.status(status).json({ ok: false, code: known ? error.code : "import_transfer_unavailable",
        error: "Confira o estado do envio antes de tentar novamente." });
    } finally { clearTimeout(timer); }
  });
  return router;
}
module.exports = { createCalendarImportByteRouter, redactImportTransferUrl };
