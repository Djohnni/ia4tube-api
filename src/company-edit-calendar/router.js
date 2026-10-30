"use strict";
const express = require("express");
function createEditCalendarRouter({ authenticate, botAuthenticate, isBotAdmin, service, freeArtPolicy = () => ({}), admissionAuthenticate = null }) {
  const router = express.Router();
  const call = action => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json(await action(req)); }
    catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 503;
      const code = /^(edit_calendar_|calendar_|monthly_planning_)[a-z_]+$/.test(error.code || "") || error.code === "billing_required"
        ? error.code : "edit_calendar_unavailable";
      res.status(status).json({ ok: false, code, error: error.code === "billing_required" ? "Você não tem saldo suficiente para continuar."
        : "Não foi possível vincular este pedido ao calendário. Confira a conta e a programação." });
    }
  };
  router.post("/empresa/edit/context", authenticate, call(req => {
    const policy = freeArtPolicy(req) || {};
    return service.createContext(req.user, req.body, { freeArtBlocked: policy.blocked === true,
      ipIdentity: { ipHash: policy.ipHash, ipMasked: policy.ipMasked } });
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
  router.post("/empresa/edit/orders/admit", scopedAdmission, call(req => service.admit(req.body)));
  router.post("/empresa/edit/orders/admission/cancel", scopedAdmission, call(req => service.cancelAdmission(req.body)));
  router.get("/bot/empresa/edit/orders/:editOrderId/admission", botAuthenticate, call(req => {
    if (!isBotAdmin(req)) throw Object.assign(new Error("Acesso negado"), { statusCode: 403, code: "edit_calendar_operator_required" });
    return service.admissionStatus(req.params.editOrderId, req.query);
  }));
  return router;
}
module.exports = { createEditCalendarRouter };
