"use strict";
const express = require("express");
const fs = require("node:fs");
const { fail } = require("./model");
const { readCalendarWithRecovery } = require("./read-recovery");
const { createSingleProcessTransferLimiter } = require("./imports/transfer-service");
const { parsePreviewRange } = require("./imports/preview-service");
function createCalendarRouter({ authenticate, getService, logger }) {
  const router = express.Router();
  const mediaLimiter = createSingleProcessTransferLimiter({ maxConcurrent: 2, maxPerCompany: 2 });
  async function sendVideo(req, res, opened) {
    if (Object.keys(req.query).length || req.headers["transfer-encoding"] || req.headers["content-encoding"] ||
        req.headers["content-length"] && req.headers["content-length"] !== "0") fail("calendar_media_invalid", 404);
    const range = parsePreviewRange(req.headers.range, opened.size);
    res.status(range.partial ? 206 : 200).set({ "Content-Type": "video/mp4", "Content-Length": String(range.length),
      "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive" });
    if (range.partial) res.set("Content-Range", `bytes ${range.start}-${range.end}/${opened.size}`);
    if (req.method === "HEAD") { res.end(); return; }
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(opened.file, { start: range.start, end: range.end, highWaterMark: 65536 });
      const timer = setTimeout(() => { stream.destroy(); res.destroy(); }, 180000);
      const cleanup = () => { clearTimeout(timer); res.off("close", stopped); res.off("finish", finished); stream.off("error", failed); };
      const stopped = () => { stream.destroy(); cleanup(); resolve(); };
      const finished = () => { cleanup(); resolve(); };
      const failed = error => { cleanup(); reject(error); };
      res.once("close", stopped); res.once("finish", finished); stream.once("error", failed);
      stream.pipe(res);
    });
  }
  const call = action => async (req, res) => {
    try {
      const service = getService();
      if (!service) {
        if (req.method === "GET" && req.path === "/") return res.json({ ok: true, enabled: false, items: [], next: null });
        fail("calendar_disabled", 503);
      }
      await action(service, req, res);
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      for (const header of ["Content-Length", "Content-Range", "Accept-Ranges", "Content-Type"]) res.removeHeader(header);
      res.status(Number.isInteger(error.statusCode) ? error.statusCode : 503).json({ ok: false,
        code: /^calendar_[a-z_]+$/.test(error.code || "") ? error.code : "calendar_unavailable",
        error: "Não foi possível concluir. Atualize a programação e confira o estado antes de tentar novamente." });
    }
  };
  router.get("/media/:company/:sha/:expires/:signature", call((service, req, res) => {
    const p = req.params; res.type("jpeg").send(service.publicBytes(p.company, p.sha, p.expires, p.signature));
  }));
  router.get("/media/video/:company/:sha/:expires/:signature", call(async (service, req, res) => {
    await mediaLimiter.run(async () => ({ companyId: req.params.company,
      opened: service.publicVideo(req.params.company, req.params.sha, req.params.expires, req.params.signature) }),
    binding => sendVideo(req, res, binding.opened));
  }));
  router.get("/media/prepared/:company/:id/:target/:publicationId/:metadataDigest/:expires/:signature", call(async (service, req, res) => {
    if (typeof service.publicMedia !== "function" || Object.keys(req.query).length || req.headers["transfer-encoding"] ||
        req.headers["content-encoding"] || req.headers["content-length"] && req.headers["content-length"] !== "0") fail("calendar_media_invalid", 404);
    const abort = new AbortController(), timer = setTimeout(() => { abort.abort(); res.destroy(); }, 60000);
    const close = () => { if (!res.writableFinished) abort.abort(); };
    res.once("close", close); req.once("aborted", close);
    try {
      await mediaLimiter.run(async () => ({ companyId: req.params.company }), async () => {
        const opened = await service.publicMedia(req.params, { rangeHeader: req.headers.range, signal: abort.signal });
        const { descriptor, range } = opened;
        res.status(range.partial ? 206 : 200).set({ "Content-Type": descriptor.mimeType, "Content-Length": String(range.length),
          "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive" });
        if (range.partial) res.set("Content-Range", `bytes ${range.start}-${range.end}/${descriptor.sizeBytes}`);
        if (req.method !== "HEAD") await opened.stream(bytes => {
          if (abort.signal.aborted || res.destroyed) throw new Error("calendar_media_interrupted");
          if (res.write(bytes)) return Promise.resolve();
          return new Promise((resolve, reject) => {
            const clean = () => { res.off("drain", drained); res.off("close", stopped); abort.signal.removeEventListener("abort", stopped); };
            const drained = () => { clean(); resolve(); }, stopped = () => { clean(); reject(new Error("calendar_media_interrupted")); };
            res.once("drain", drained); res.once("close", stopped); abort.signal.addEventListener("abort", stopped, { once: true });
          });
        });
        res.end();
      });
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      for (const header of ["Content-Length", "Content-Range", "Accept-Ranges", "Content-Type"]) res.removeHeader(header);
      throw error;
    }
    finally { clearTimeout(timer); abort.abort(); res.off("close", close); req.off("aborted", close); }
  }));
  router.use(authenticate);
  router.get("/", call(async (service, req, res) => res.json(await readCalendarWithRecovery(() => service.list(req.user), logger))));
  router.post("/preferences", call(async (service, req, res) => res.json(await service.preferences(req.user, req.body || {}))));
  router.get("/items/:id/image", call(async (service, req, res) => res.type("jpeg").send(await service.image(req.user, req.params.id, req.query.destination ?? null))));
  router.get("/items/:id/video", call(async (service, req, res) => {
    await mediaLimiter.run(async () => { const opened = await service.video(req.user, req.params.id);
      return { companyId: opened.companyId, opened }; }, binding => sendVideo(req, res, binding.opened));
  }));
  router.post("/items/:id", call(async (service, req, res) => res.json(await service.edit(req.user, req.params.id, req.body || {}))));
  return router;
}
module.exports = { createCalendarRouter };
