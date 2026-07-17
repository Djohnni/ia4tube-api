const fs = require("fs");
const path = require("path");

function createFreeArtCampaignRoutes({
  service,
  storage,
  uploadResultado,
  config,
  paths,
  auth,
  botRunnerAuth,
  isBotAdmin,
  readClientes,
  cleanupUploadedFiles,
  composeLogo
}) {
  const router = require("express").Router();

  function featureEnabled() {
    return config.enabled();
  }

  function requireEnabled(req, res, next) {
    if (!featureEnabled()) {
      return res.status(404).json({
        ok: false,
        code: "admin_free_arts_disabled",
        error: "Funcionalidade desativada."
      });
    }
    return next();
  }

  function requireAdmin(req, res, next) {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }
    return next();
  }

  function sendError(res, error) {
    return res.status(error?.statusCode || 500).json({
      ok: false,
      code: error?.code || "free_art_campaign_error",
      error: error?.message || "Erro na campanha de arte gratis."
    });
  }

  router.get("/panel", auth, requireEnabled, requireAdmin, (_req, res) => {
    if (!fs.existsSync(paths.panelFile)) {
      return res.status(404).send("Painel de artes gratis nao encontrado");
    }
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(paths.panelFile);
  });

  router.get("/config", auth, requireEnabled, requireAdmin, (_req, res) => {
    return res.json({
      ok: true,
      enabled: true,
      max_artes_por_campanha: config.maxArts(),
      timeout_geracao_ms: config.stuckTimeoutMs?.() || 30 * 60 * 1000,
      recuperacao_geracao: config.stuckAction?.() || "pendente",
      horario_padrao: service.DEFAULT_TIME || "18:00",
      timezone: "America/Sao_Paulo"
    });
  });

  router.get("/ramos", auth, requireEnabled, requireAdmin, (_req, res) => {
    try {
      return res.json(service.scanClientBranches({
        pedidosDir: paths.pedidosDir,
        clientes: readClientes()
      }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/", auth, requireEnabled, requireAdmin, (_req, res) => {
    try {
      return res.json(service.listCampaigns({ baseDir: paths.baseDir }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/", auth, requireEnabled, requireAdmin, (req, res) => {
    try {
      return res.json(service.createCampaign({
        baseDir: paths.baseDir,
        pedidosDir: paths.pedidosDir,
        clientes: readClientes(),
        body: req.body || {},
        adminId: req.user?.whatsapp || "",
        maxArts: config.maxArts()
      }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/artes/novas", botRunnerAuth, requireEnabled, requireAdmin, (req, res) => {
    try {
      service.recoverStuckGeneration({
        baseDir: paths.baseDir,
        timeoutMs: config.stuckTimeoutMs?.() || 30 * 60 * 1000,
        action: config.stuckAction?.() || "pendente"
      });
      return res.json(service.listPendingArts({
        baseDir: paths.baseDir,
        limit: Number(req.query?.limit || 10)
      }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/:campaignId", auth, requireEnabled, requireAdmin, (req, res) => {
    try {
      return res.json(service.detailCampaign({
        baseDir: paths.baseDir,
        campaignId: req.params.campaignId
      }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.patch("/:campaignId", auth, requireEnabled, requireAdmin, (req, res) => {
    try {
      return res.json(service.updateCampaignSettings({
        baseDir: paths.baseDir,
        campaignId: req.params.campaignId,
        body: req.body || {},
        adminId: req.user?.whatsapp || ""
      }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/:campaignId/duplicate", auth, requireEnabled, requireAdmin, (req, res) => {
    try {
      return res.json(service.duplicateCampaign({
        baseDir: paths.baseDir,
        pedidosDir: paths.pedidosDir,
        clientes: readClientes(),
        campaignId: req.params.campaignId,
        adminId: req.user?.whatsapp || "",
        maxArts: config.maxArts()
      }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/:campaignId/artes/:artId/image", auth, requireEnabled, requireAdmin, (req, res) => {
    try {
      const art = storage.readArt(paths.baseDir, req.params.campaignId, req.params.artId);
      const filePath = String(art?.arquivo_preview || art?.arquivo_original || "");
      if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ ok: false, error: "Imagem nao encontrada" });
      }
      res.setHeader("Cache-Control", "no-store");
      res.type(filePath.endsWith(".jpg") || filePath.endsWith(".jpeg") ? "image/jpeg" : "image/png");
      return res.sendFile(path.resolve(filePath));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/:campaignId/artes/:artId/status", botRunnerAuth, requireEnabled, requireAdmin, (req, res) => {
    try {
      return res.json(service.updateArtStatus({
        baseDir: paths.baseDir,
        campaignId: req.params.campaignId,
        artId: req.params.artId,
        status: String(req.body?.status || ""),
        message: String(req.body?.message || req.body?.erro || "")
      }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post(
    "/:campaignId/artes/:artId/upload-resultado",
    botRunnerAuth,
    requireEnabled,
    requireAdmin,
    uploadResultado.fields([
      { name: "resultado", maxCount: 1 },
      { name: "preview", maxCount: 1 }
    ]),
    (req, res) => {
      try {
        const resultFile = req.files?.resultado?.[0] || null;
        const previewFile = req.files?.preview?.[0] || null;
        const result = service.saveArtResult({
          baseDir: paths.baseDir,
          campaignId: req.params.campaignId,
          artId: req.params.artId,
          resultFile,
          previewFile,
          descricaoInstagram: req.body?.descricao_instagram || ""
        });
        return res.json(result);
      } catch (error) {
        cleanupUploadedFiles(req.files);
        return sendError(res, error);
      }
    }
  );

  router.post("/:campaignId/artes/:artId/approve", auth, requireEnabled, requireAdmin, (req, res) => {
    try {
      return res.json(service.approveArt({
        baseDir: paths.baseDir,
        campaignId: req.params.campaignId,
        artId: req.params.artId,
        adminId: req.user?.whatsapp || ""
      }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/:campaignId/artes/:artId/delete", auth, requireEnabled, requireAdmin, (req, res) => {
    try {
      return res.json(service.excludeArt({
        baseDir: paths.baseDir,
        campaignId: req.params.campaignId,
        artId: req.params.artId,
        adminId: req.user?.whatsapp || ""
      }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/:campaignId/artes/:artId/regenerate", auth, requireEnabled, requireAdmin, (req, res) => {
    try {
      return res.json(service.regenerateArt({
        baseDir: paths.baseDir,
        campaignId: req.params.campaignId,
        artId: req.params.artId,
        adminId: req.user?.whatsapp || ""
      }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/:campaignId/distribute/preview", auth, requireEnabled, requireAdmin, (req, res) => {
    try {
      return res.json(service.buildDistributionPreview({
        baseDir: paths.baseDir,
        campaignId: req.params.campaignId
      }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/:campaignId/distribute", auth, requireEnabled, requireAdmin, (req, res) => {
    try {
      return res.json(service.distributeCampaign({
        baseDir: paths.baseDir,
        pedidosDir: paths.pedidosDir,
        campaignId: req.params.campaignId,
        adminId: req.user?.whatsapp || "",
        composeLogo
      }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

module.exports = {
  createFreeArtCampaignRoutes
};
