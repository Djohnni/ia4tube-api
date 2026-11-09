"use strict";
const express = require("express");
const { createCapabilityRateGuard } = require("./admission-http");
function createEditCalendarRouter({ authenticate, botAuthenticate, isBotAdmin, service, freeArtPolicy = () => ({}),
  admissionAuthenticate = null, availabilityAuthenticate = authenticate, freeArtReadPolicy = () => ({}), capabilityRateGuard = null,
  readyImageUpload = null, readyImageCleanup = () => {} }) {
  const router = express.Router();
  const call = action => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json(await action(req)); }
    catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 503;
      const code = /^(edit_calendar_|calendar_|monthly_planning_)[a-z_]+$/.test(error.code || "") || error.code === "billing_required"
        ? error.code : "edit_calendar_unavailable";
      res.status(status).json({ ok: false, code, error: error.code === "billing_required" ? "Você não tem saldo suficiente para continuar."
        : code === "edit_calendar_ready_image_caption_required" ? "Escreva a legenda desta imagem."
        : code === "edit_calendar_ready_image_invalid" ? "Confira a imagem e tente novamente."
        : code === "edit_calendar_ready_image_adaptation_preserved" ? "A adaptação precisa de atenção. Seu envio foi preservado; não envie outro pedido."
        : code === "edit_calendar_ready_image_adaptation_unavailable" ? "A adaptação está indisponível no momento. Seu envio foi preservado."
        : code === "edit_calendar_image_caption_preserved" ? "A legenda precisa de atenção. A tentativa foi preservada; não envie outra imagem."
        : code === "edit_calendar_image_caption_unavailable" ? "Não foi possível criar a legenda neste momento."
        : code === "edit_calendar_story_business_required" ? "Story exige uma conta Instagram profissional (Empresa ou Criador)."
        : "Não foi possível vincular este pedido ao calendário. Confira a conta e a programação.",
        ...([400, 413, 415, 422].includes(status) && (req.readyImageTicket &&
          service.readyImageCanEdit(req.readyImageTicket) === true || req.imageCaptionTicket &&
          service.imageCaptionCanEdit(req.imageCaptionTicket) === true) ? { safeToEdit: true } : {}) });
    }
  };
  const captionGuard = createCapabilityRateGuard({ capacity: 20,
    verifyCapability: body => service.verifyImageCaptionCapability(body.ticket) });
  const captionHeader = (req, res, next) => {
    try {
      const match = req.get("Authorization")?.match(/^EditTicket ([A-Za-z0-9_.-]{80})$/);
      if (!match) throw Object.assign(new Error("Sessão necessária"), { statusCode: 401, code: "edit_calendar_session_required" });
      captionGuard.authorize({ body: { ticket: match[1] }, ip: req.ip, socket: req.socket });
      req.imageCaptionTicket = match[1]; next();
    } catch (error) {
      if (error.statusCode === 429) res.set("Retry-After", String(error.retryAfter || 1));
      res.status(error.statusCode || 403).set("Cache-Control", "no-store")
        .json({ ok: false, code: error.code || "edit_calendar_context_unavailable" });
    }
  };
  router.post("/empresa/edit/ready-images/caption", captionHeader, (req, res, next) => {
    if (typeof readyImageUpload !== "function") return res.status(503).json({ ok: false, code: "edit_calendar_admission_disabled" });
    readyImageUpload(req, res, error => {
      if (!error) return next();
      readyImageCleanup(req.file);
      res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).set("Cache-Control", "no-store")
        .json({ ok: false, code: "edit_calendar_ready_image_invalid", error: "Confira a imagem e tente novamente.",
          ...(service.imageCaptionCanEdit(req.imageCaptionTicket) ? { safeToEdit: true } : {}) });
    });
  }, call(async req => {
    try {
      if (req.body?.ticket !== req.imageCaptionTicket) throw Object.assign(new Error("Sessão divergente"),
        { statusCode: 403, code: "edit_calendar_context_unavailable" });
      return await service.generateImageCaption(req.body, req.file);
    } finally { readyImageCleanup(req.file); }
  }));
  router.get("/empresa/edit/availability", availabilityAuthenticate, call(req => {
    const policy = freeArtReadPolicy(req) || {};
    return service.availability(req.user, { freeArtBlocked: policy.blocked === true,
      ipIdentity: { ipHash: policy.ipHash, ipMasked: policy.ipMasked } });
  }));
  router.post("/empresa/edit/context", authenticate, call(req => {
    const policy = freeArtPolicy(req) || {};
    return service.createContext(req.user, req.body, { freeArtBlocked: policy.blocked === true,
      ipIdentity: { ipHash: policy.ipHash, ipMasked: policy.ipMasked } });
  }));
  const readyGuard = createCapabilityRateGuard({ capacity: 20,
    verifyCapability: body => service.verifyReadyImageCapability(body.ticket) });
  const readyImageHeader = (req, res, next) => {
    try {
      const header = req.get("Authorization"), match = typeof header === "string" && header.match(/^EditTicket ([A-Za-z0-9_.-]{80})$/);
      if (!match) throw Object.assign(new Error("Sessão necessária"), { statusCode: 401, code: "edit_calendar_session_required" });
      readyGuard.authorize({ body: { ticket: match[1] }, ip: req.ip, socket: req.socket });
      req.readyImageTicket = match[1];
      next();
    } catch (error) {
      if (error.statusCode === 429) res.set("Retry-After", String(error.retryAfter || 1));
      res.status(error.statusCode || 403).set("Cache-Control", "no-store")
        .json({ ok: false, code: error.code || "edit_calendar_context_unavailable" });
    }
  };
  router.get("/empresa/edit/ready-images/context", readyImageHeader, call(req => {
    if (Object.keys(req.query).length) throw Object.assign(new Error("Consulta inválida"),
      { statusCode: 400, code: "edit_calendar_input_invalid" });
    return service.readReadyImageContext(req.readyImageTicket);
  }));
  router.post("/empresa/edit/ready-images", readyImageHeader, (req, res, next) => {
    if (typeof readyImageUpload !== "function") return res.status(503).set("Cache-Control", "no-store")
      .json({ ok: false, code: "edit_calendar_admission_disabled" });
    return readyImageUpload(req, res, error => {
    if (!error) return next();
    readyImageCleanup(req.file);
    return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).set("Cache-Control", "no-store")
      .json({ ok: false, code: "edit_calendar_ready_image_invalid", error: "Confira a imagem e tente novamente.",
        ...(service.readyImageCanEdit(req.readyImageTicket) === true ? { safeToEdit: true } : {}) });
    });
  }, call(async req => {
    try {
      if (req.body?.ticket !== req.readyImageTicket) throw Object.assign(new Error("Sessão divergente"),
        { statusCode: 403, code: "edit_calendar_context_unavailable" });
      return await service.submitReadyImage(req.body, req.file);
    } finally { readyImageCleanup(req.file); }
  }));
  router.post("/bot/empresa/edit/orders/bind", botAuthenticate, call(req => {
    if (!isBotAdmin(req)) throw Object.assign(new Error("Acesso negado"), { statusCode: 403, code: "edit_calendar_operator_required" });
    return service.bind(req.body);
  }));
  const scopedAdmission = (req, res, next) => {
    try {
      if (typeof admissionAuthenticate !== "function") throw Object.assign(new Error("Indisponivel"),
        { statusCode: 503, code: "edit_calendar_admission_disabled" });
      admissionAuthenticate(req.path, req.headers, req.body); return next();
    } catch (error) {
      return res.status(error.statusCode === 503 ? 503 : error.statusCode === 400 ? 400 : 403)
        .set("Cache-Control", "no-store").json({ ok: false, code: error.statusCode === 503
          ? "edit_calendar_admission_disabled" : error.statusCode === 400 ? "edit_calendar_input_invalid" : "edit_calendar_admission_unauthorized" });
    }
  };
  const capabilityGuard = capabilityRateGuard || createCapabilityRateGuard({ verifyCapability: body => service.verifyAdmissionCapability(body) });
  const scopedCapability = (req, res, next) => {
    try { capabilityGuard.authorize(req); return next(); }
    catch (error) {
      if (error.statusCode === 429) res.set("Retry-After", String(error.retryAfter || 1));
      return res.status(Number.isInteger(error.statusCode) ? error.statusCode : 503).set("Cache-Control", "no-store")
        .json({ ok: false, code: /^edit_calendar_[a-z_]+$/.test(error.code || "") ? error.code : "edit_calendar_admission_unavailable" });
    }
  };
  router.post("/empresa/edit/orders/admit", scopedCapability, call(req => service.admit(req.body)));
  router.post("/empresa/edit/orders/admission/cancel", scopedAdmission, call(req => service.cancelAdmission(req.body)));
  router.get("/bot/empresa/edit/orders/:editOrderId/admission", botAuthenticate, call(req => {
    if (!isBotAdmin(req)) throw Object.assign(new Error("Acesso negado"), { statusCode: 403, code: "edit_calendar_operator_required" });
    return service.admissionStatus(req.params.editOrderId, req.query);
  }));
  return router;
}
module.exports = { createEditCalendarRouter };
