"use strict";
const express = require("express"), multer = require("multer");
function createAssistantRouter({ authenticate, service }) {
  const router = express.Router();
  router.use(authenticate, (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
  const call = fn => async (req, res) => { try { res.json(await fn(req)); } catch (e) {
    const status = [400,401,402,403,404,409,413,422,429,503].includes(e.statusCode) ? e.statusCode : 503;
    res.status(status).json({ ok: false, code: /^assistant_[a-z_]+$/.test(e.code || "") ? e.code : "assistant_unavailable" });
  } };
  router.get("/", call(req => service.state(req.user)));
  router.post("/messages", call(req => service.message(req.user, req.body)));
  router.post("/confirm", call(req => service.confirm(req.user, req.body)));
  router.post("/report", call(req => service.report(req.user, req.body)));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5*1024*1024, files:1, fields:2, parts:3, fieldSize:200 } }).single("image");
  router.post("/photos", (req,res,next) => upload(req,res,e => e ? res.status(400).json({ok:false,code:"assistant_photo_invalid"}) : next()),
    call(async req => { try { return await service.upload(req.user, req.body.id, req.file?.buffer, req.file?.originalname); } finally { if(req.file)req.file.buffer=undefined; } }));
  router.get("/photos/:id", async (req,res) => { try { res.set("X-Content-Type-Options","nosniff").type("png").send(service.photo(req.user,req.params.id)); }
    catch { res.status(404).json({ok:false,code:"assistant_photo_not_found"}); } });
  return router;
}
module.exports = { createAssistantRouter };
