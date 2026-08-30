"use strict";

const { MetaComplianceError } = require("./errors");

const META_COMPLIANCE_PATHS = Object.freeze({
  deauthorization: "/meta/deauthorization",
  dataDeletion: "/meta/data-deletion",
  dataDeletionStatus: "/meta/data-deletion/status/:confirmationCode"
});

function noStore(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return next();
}

function signedRequestFromBody(req) {
  const body = req?.body;
  const prototype = body && typeof body === "object"
    ? Object.getPrototypeOf(body)
    : undefined;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    (prototype !== Object.prototype && prototype !== null) ||
    Object.keys(body).length !== 1 ||
    !Object.hasOwn(body, "signed_request") ||
    typeof body.signed_request !== "string"
  ) {
    const error = new MetaComplianceError("meta_compliance_request_invalid", 400);
    throw error;
  }
  return body.signed_request;
}

function confirmationCodeFromRequest(req) {
  const params = req?.params;
  const query = req?.query || {};
  if (
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    Object.keys(params).length !== 1 ||
    typeof params.confirmationCode !== "string" ||
    !query ||
    typeof query !== "object" ||
    Array.isArray(query) ||
    Object.keys(query).length !== 0
  ) {
    throw new MetaComplianceError("meta_compliance_request_invalid", 400);
  }
  return params.confirmationCode;
}

function sendError(res, error) {
  const known = error instanceof MetaComplianceError;
  const statusCode = known ? error.statusCode : 500;
  const code = known ? error.code : "meta_compliance_unavailable";
  return res.status(statusCode).json({ error: code });
}

function wantsHtml(req) {
  return /(?:^|,)\s*text\/html(?:\s*;|\s*,|\s*$)/i.test(
    String(req?.headers?.accept || "")
  );
}

function completedStatusHtml() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <title>Pedido técnico concluído — IA4Tube</title>
  <style>
    :root{font-family:Inter,Arial,sans-serif;color:#172033;background:#f5f3ff}
    *{box-sizing:border-box}body{margin:0;padding:24px}
    main{max-width:680px;margin:8vh auto;padding:32px;border:1px solid #ded9f3;border-radius:18px;background:#fff;box-shadow:0 12px 30px rgba(42,32,96,.08)}
    .state{display:inline-block;padding:7px 11px;border-radius:999px;color:#116331;background:#dcfce7;font-weight:800}
    h1{font-size:1.7rem;line-height:1.2}p{line-height:1.65;color:#526078}
    nav{display:flex;flex-wrap:wrap;gap:14px;margin-top:24px;padding-top:18px;border-top:1px solid #ded9f3}
    a{color:#38249a;font-weight:700}@media(max-width:640px){body{padding:10px}main{margin:10px auto;padding:22px 18px}}
  </style>
</head>
<body>
  <main>
    <span class="state">Concluído</span>
    <h1>Pedido técnico processado</h1>
    <p>A referência opaca informada na URL corresponde a um pedido técnico concluído. Esta página não exibe identificadores de conta, empresa, token, assinatura ou outros dados pessoais.</p>
    <p>Os textos jurídicos, o canal oficial e os prazos finais da IA4Tube ainda dependem de aprovação do proprietário.</p>
    <nav aria-label="Documentos relacionados">
      <a href="/politica-de-privacidade">Privacidade</a>
      <a href="/termos-de-uso">Termos</a>
      <a href="/exclusao-de-dados">Exclusão de dados</a>
    </nav>
  </main>
</body>
</html>`;
}

function createMetaComplianceRouter(options = {}) {
  const staticService = options.service;
  const getService = typeof options.getService === "function"
    ? options.getService
    : staticService
      ? () => staticService
      : null;
  if (!getService) {
    throw new TypeError("Meta compliance service invalid.");
  }

  function serviceForRequest() {
    let service;
    try {
      service = getService();
    } catch {
      throw new MetaComplianceError("meta_compliance_unavailable", 503);
    }
    if (
      !service ||
      typeof service.handleDeauthorization !== "function" ||
      typeof service.handleDataDeletion !== "function" ||
      typeof service.getStatus !== "function"
    ) {
      throw new MetaComplianceError("meta_compliance_unavailable", 503);
    }
    return service;
  }
  const router = options.router || require("express").Router();
  if (
    !router ||
    typeof router.post !== "function" ||
    typeof router.get !== "function"
  ) {
    throw new TypeError("Meta compliance router invalid.");
  }

  router.post(
    META_COMPLIANCE_PATHS.deauthorization,
    noStore,
    async (req, res) => {
      try {
        await serviceForRequest().handleDeauthorization({
          signedRequest: signedRequestFromBody(req)
        });
        return res.status(200).json({ success: true });
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  router.post(
    META_COMPLIANCE_PATHS.dataDeletion,
    noStore,
    async (req, res) => {
      try {
        const result = await serviceForRequest().handleDataDeletion({
          signedRequest: signedRequestFromBody(req)
        });
        return res.status(200).json({
          url: result.statusUrl,
          confirmation_code: result.confirmationCode
        });
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  router.get(
    META_COMPLIANCE_PATHS.dataDeletionStatus,
    noStore,
    async (req, res) => {
      try {
        const result = await serviceForRequest().getStatus({
          confirmationCode: confirmationCodeFromRequest(req)
        });
        if (wantsHtml(req)) {
          res.setHeader("Content-Language", "pt-BR");
          res.setHeader("Content-Security-Policy", [
            "default-src 'none'",
            "style-src 'unsafe-inline'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'"
          ].join("; "));
          res.setHeader("Referrer-Policy", "no-referrer");
          res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
          return res.status(200).type("html").send(completedStatusHtml());
        }
        return res.status(200).json({ status: result.status });
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  return router;
}

module.exports = {
  META_COMPLIANCE_PATHS,
  completedStatusHtml,
  createMetaComplianceRouter,
  noStore
};
