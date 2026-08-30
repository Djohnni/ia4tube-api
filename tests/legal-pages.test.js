"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const {
  LEGAL_PAGE_DEFINITIONS,
  REQUIRED_DRAFT_MARKERS,
  createLegalPageHandlers,
  createLegalPagesRouter,
  loadLegalTemplates
} = require("../src/legal/legal-pages.routes");

const CANONICAL_LEGAL_ROUTES = Object.freeze([
  "/politica-de-privacidade",
  "/termos-de-uso",
  "/exclusao-de-dados"
]);

function createFakeRouter() {
  const routes = new Map();
  return {
    routes,
    get(routePath, handler) {
      assert.equal(routes.has(routePath), false, `Alias duplicado: ${routePath}`);
      routes.set(routePath, handler);
      return this;
    }
  };
}

function invoke(handler) {
  const response = {
    statusCode: null,
    contentType: null,
    headers: new Map(),
    body: null,
    setHeader(name, value) {
      this.headers.set(String(name).toLowerCase(), String(value));
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(value) {
      this.contentType = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    }
  };

  const returned = handler({}, response);
  assert.equal(returned, response);
  return response;
}

function assertPublicTechnicalDraftPage(response) {
  assert.equal(response.statusCode, 200);
  assert.equal(response.contentType, "html");
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.equal(response.headers.get("content-language"), "pt-BR, en");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-robots-tag"), "index, follow");
  assert.doesNotMatch(response.headers.get("x-robots-tag"), /noindex|nofollow/i);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(response.headers.get("content-security-policy"), /style-src 'unsafe-inline'/);
  assert.match(response.headers.get("content-security-policy"), /form-action 'none'/);

  for (const marker of REQUIRED_DRAFT_MARKERS) {
    assert.equal(response.body.includes(marker), true, `Marcador ausente: ${marker}`);
  }

  assert.match(response.body, /<meta name="robots" content="index, follow">/i);
  assert.match(response.body, /<meta name="viewport"/i);
  assert.match(response.body, /@media\s*\(max-width:\s*640px\)/i);
  assert.match(response.body, /ainda não aprovad[oa]s?/i);
  assert.doesNotMatch(response.body, /<script\b/i);
  assert.doesNotMatch(response.body, /<form\b/i);
  assert.doesNotMatch(response.body, /https?:\/\//i);
  assert.doesNotMatch(response.body, /facebook\.com/i);
  assert.doesNotMatch(response.body, /reserva o endereço/i);
  assert.doesNotMatch(response.body, /DRAFT\s*—\s*PENDING APPROVAL/i);

  for (const route of CANONICAL_LEGAL_ROUTES) {
    assert.match(
      response.body,
      new RegExp(`href=["']${route}["']`, "i"),
      `Link legal ausente: ${route}`
    );
  }
}

function main() {
  const expectedAliases = {
    privacy: [
      "/privacidade",
      "/politica-de-privacidade",
      "/privacy",
      "/privacy-policy"
    ],
    terms: [
      "/termos",
      "/termos-de-uso",
      "/terms",
      "/terms-of-service"
    ],
    dataDeletion: [
      "/exclusao-de-dados",
      "/exclusao-dados",
      "/data-deletion",
      "/data-deletion-instructions"
    ]
  };

  const templates = loadLegalTemplates();
  assert.deepEqual(Object.keys(templates).sort(), [
    "dataDeletion",
    "privacy",
    "terms"
  ]);

  const handlers = createLegalPageHandlers();
  const fakeRouter = createFakeRouter();
  const router = createLegalPagesRouter({ router: fakeRouter });
  assert.equal(router, fakeRouter);

  const allAliases = [];
  for (const definition of LEGAL_PAGE_DEFINITIONS) {
    assert.deepEqual(definition.aliases, expectedAliases[definition.id]);
    const canonicalBody = templates[definition.id];

    for (const alias of definition.aliases) {
      allAliases.push(alias);
      assert.equal(fakeRouter.routes.has(alias), true);
      const response = invoke(fakeRouter.routes.get(alias));
      assertPublicTechnicalDraftPage(response);
      assert.equal(response.body, canonicalBody);
    }
  }

  assert.equal(new Set(allAliases).size, allAliases.length);
  assert.equal(fakeRouter.routes.size, 12);

  const templatesDir = path.resolve(__dirname, "../src/legal/templates");
  const templateFiles = fs.readdirSync(templatesDir).sort();
  assert.deepEqual(templateFiles, [
    "data-deletion.html",
    "privacy.html",
    "terms.html"
  ]);

  for (const templateFile of templateFiles) {
    const html = fs.readFileSync(path.join(templatesDir, templateFile), "utf8");
    assertPublicTechnicalDraftPage({
      statusCode: 200,
      contentType: "html",
      headers: new Map([
        ["cache-control", "public, max-age=300"],
        ["content-language", "pt-BR, en"],
        ["referrer-policy", "no-referrer"],
        ["x-content-type-options", "nosniff"],
        ["x-robots-tag", "index, follow"],
        [
          "content-security-policy",
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'"
        ]
      ]),
      body: html
    });
    assert.doesNotMatch(html, /ia4tube-api(?:-staging[^.]*)?\.onrender\.com/i);
    assert.doesNotMatch(html, /access[_-]?token|client[_-]?secret|private[_-]?key/i);
  }

  assert.throws(
    () => loadLegalTemplates(path.resolve(__dirname, "missing-legal-templates")),
    /ENOENT/
  );
  assert.throws(
    () => createLegalPagesRouter({ router: {} }),
    /Router legal invalido/
  );

  process.stdout.write(
    "legal pages unit tests: OK (12 aliases, 3 public technical drafts)\n"
  );
}

main();
