"use strict";
const express = require("express");
const { fail } = require("./model");
function createCalendarRouter({ authenticate, getService }) {
  const router = express.Router();
  const call = action => async (req, res) => {
    try {
      const service = getService();
      if (!service) {
        if (req.method === "GET" && req.path === "/") return res.json({ ok: true, enabled: false, items: [], next: null });
        fail("calendar_disabled", 503);
      }
      await action(service, req, res);
    } catch (error) {
      res.status(Number.isInteger(error.statusCode) ? error.statusCode : 503).json({ ok: false,
        code: /^calendar_[a-z_]+$/.test(error.code || "") ? error.code : "calendar_unavailable",
        error: "Não foi possível concluir. Atualize a programação e confira o estado antes de tentar novamente." });
    }
  };
  router.get("/media/:company/:sha/:expires/:signature", call((service, req, res) => {
    const p = req.params; res.type("jpeg").send(service.publicBytes(p.company, p.sha, p.expires, p.signature));
  }));
  router.use(authenticate);
  router.get("/", call(async (service, req, res) => res.json(await service.list(req.user))));
  router.post("/preferences", call(async (service, req, res) => res.json(await service.preferences(req.user, req.body || {}))));
  router.get("/items/:id/image", call(async (service, req, res) => res.type("jpeg").send(await service.image(req.user, req.params.id))));
  router.post("/items/:id", call(async (service, req, res) => res.json(await service.edit(req.user, req.params.id, req.body || {}))));
  return router;
}
module.exports = { createCalendarRouter };
