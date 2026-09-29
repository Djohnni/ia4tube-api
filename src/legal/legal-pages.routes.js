"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_TEMPLATES_DIR = path.join(__dirname, "templates");
const REQUIRED_FINAL_MARKERS = Object.freeze([
  "Vigente desde:",
  "Última atualização:"
]);

const LEGAL_PAGE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "privacy",
    template: "privacy.html",
    aliases: Object.freeze([
      "/privacidade",
      "/politica-de-privacidade",
      "/privacy",
      "/privacy-policy"
    ])
  }),
  Object.freeze({
    id: "terms",
    template: "terms.html",
    aliases: Object.freeze([
      "/termos",
      "/termos-de-uso",
      "/terms",
      "/terms-of-service"
    ])
  }),
  Object.freeze({
    id: "dataDeletion",
    template: "data-deletion.html",
    aliases: Object.freeze([
      "/exclusao-de-dados",
      "/exclusao-dados",
      "/data-deletion",
      "/data-deletion-instructions"
    ])
  })
]);

function loadLegalTemplates(templatesDir = DEFAULT_TEMPLATES_DIR) {
  const resolvedTemplatesDir = path.resolve(templatesDir);
  const templates = {};

  for (const definition of LEGAL_PAGE_DEFINITIONS) {
    const templatePath = path.resolve(resolvedTemplatesDir, definition.template);
    const expectedPrefix = `${resolvedTemplatesDir}${path.sep}`;

    if (!templatePath.startsWith(expectedPrefix)) {
      throw new Error(`Template legal fora do diretorio permitido: ${definition.id}`);
    }

    const html = fs.readFileSync(templatePath, "utf8");
    if (REQUIRED_FINAL_MARKERS.some((marker) => !html.includes(marker))) {
      throw new Error(
        `Template legal sem marcadores de vigencia: ${definition.id}`
      );
    }
    templates[definition.id] = html;
  }

  return Object.freeze(templates);
}

function applyLegalPageHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Language", "pt-BR");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Robots-Tag", "index,follow");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
}

function createLegalPageHandlers(options = {}) {
  const templates = loadLegalTemplates(options.templatesDir);
  const handlers = {};

  for (const definition of LEGAL_PAGE_DEFINITIONS) {
    handlers[definition.id] = function legalPageHandler(_req, res) {
      applyLegalPageHeaders(res);
      res.status(200);
      res.type("html");
      return res.send(templates[definition.id]);
    };
  }

  return Object.freeze(handlers);
}

function createLegalPagesRouter(options = {}) {
  const router = options.router || require("express").Router();
  if (!router || typeof router.get !== "function") {
    throw new TypeError("Router legal invalido.");
  }

  const handlers = createLegalPageHandlers(options);
  for (const definition of LEGAL_PAGE_DEFINITIONS) {
    for (const alias of definition.aliases) {
      router.get(alias, handlers[definition.id]);
    }
  }

  return router;
}

module.exports = {
  DEFAULT_TEMPLATES_DIR,
  LEGAL_PAGE_DEFINITIONS,
  REQUIRED_FINAL_MARKERS,
  applyLegalPageHeaders,
  createLegalPageHandlers,
  createLegalPagesRouter,
  loadLegalTemplates
};
