"use strict";

const express = require("express"), multer = require("multer");
const { createCompanyProfileService } = require("./service");
const { MAX_LOGO_BYTES, MAX_PROFILE_PART_BYTES, ownerHash, fail } = require("./model");

function createCompanyProfileRouter({ baseDir }) {
  const router = express.Router(), service = createCompanyProfileService({ baseDir });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_LOGO_BYTES, files: 1, fields: 2, parts: 3,
    fieldSize: MAX_PROFILE_PART_BYTES, fieldNameSize: 64, headerPairs: 64 } }).single("logo");
  function sendError(res, error) {
    let code = error?.code, status = error?.statusCode;
    if (error instanceof multer.MulterError) {
      status = ["LIMIT_FILE_SIZE", "LIMIT_FIELD_VALUE"].includes(code) ? 413 : 400;
      code = status === 413 ? "company_profile_too_large" : "company_profile_invalid";
    }
    if (![400, 401, 404, 413, 503].includes(status) || !/^company_profile_[a-z_]+$/.test(code || "")) {
      status = 400; code = "company_profile_invalid";
    }
    const message = status === 401 ? "Entre na sua conta para acessar o perfil." : status === 413 ? "O arquivo ou os dados excedem o limite permitido."
      : status === 404 ? "Esta conta ainda nao possui logotipo." : status === 503 ? "Nao foi possivel acessar o perfil agora."
        : "Confira os dados e envie uma imagem PNG, JPEG ou WebP valida.";
    return res.status(status).json({ ok: false, code, error: message });
  }
  // The application mounts its normal auth first. This independent fence still runs before multipart storage.
  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store"); res.vary("Authorization");
    try { ownerHash(req.user?.whatsapp); next(); } catch (error) { sendError(res, error); }
  });
  router.get("/", (req, res) => { try { res.json(service.get(req.user.whatsapp)); } catch (error) { sendError(res, error); } });
  router.get("/logo", (req, res) => {
    try { const bytes = service.logo(req.user.whatsapp); res.set("X-Content-Type-Options", "nosniff").type("png").send(bytes); }
    catch (error) { sendError(res, error); }
  });
  router.put("/", (req, res) => {
    if (!req.is("multipart/form-data")) return sendError(res, { code: "company_profile_invalid", statusCode: 400 });
    upload(req, res, async error => {
      if (error) return sendError(res, error);
      try {
        if (!req.body || Object.keys(req.body).some(key => !["profile", "remove_logo"].includes(key)) ||
            typeof req.body.profile !== "string" || req.body.remove_logo !== undefined && req.body.remove_logo !== "true") fail();
        let profile; try { profile = JSON.parse(req.body.profile); } catch { fail(); }
        res.json(await service.save(req.user.whatsapp, { profile, logo: req.file?.buffer || null, removeLogo: req.body.remove_logo === "true" }));
      } catch (failure) { sendError(res, failure); }
      finally { if (req.file) req.file.buffer = undefined; }
    });
  });
  return router;
}

module.exports = { createCompanyProfileRouter };
