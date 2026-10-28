"use strict";
const express = require("express");
function createEditCalendarRouter({ authenticate, botAuthenticate, isBotAdmin, service, freeArtPolicy = () => ({}) }) {
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
  return router;
}
module.exports = { createEditCalendarRouter };
