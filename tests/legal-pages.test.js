"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const {
  LEGAL_PAGE_DEFINITIONS,
  createLegalPageHandlers,
  createLegalPagesRouter,
  loadLegalTemplates
} = require("../src/legal/legal-pages.routes");

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

function assertDraftPage(response) {
  assert.equal(response.statusCode, 200);
  assert.equal(response.contentType, "html");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-language"), "pt-BR, en");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    response.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive"
  );
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(response.headers.get("content-security-policy"), /form-action 'none'/);
  assert.match(response.body, /RASCUNHO/);
  assert.match(response.body, /PENDENTE DE APROVAÇÃO/);
  assert.match(response.body, /DRAFT/);
  assert.match(response.body, /PENDING APPROVAL/);
  assert.doesNotMatch(response.body, /<script\b/i);
  assert.doesNotMatch(response.body, /<form\b/i);
  assert.doesNotMatch(response.body, /https?:\/\//i);
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
      assertDraftPage(response);
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
    assertDraftPage({
      statusCode: 200,
      contentType: "html",
      headers: new Map([
        ["cache-control", "no-store"],
        ["content-language", "pt-BR, en"],
        ["referrer-policy", "no-referrer"],
        ["x-content-type-options", "nosniff"],
        ["x-robots-tag", "noindex, nofollow, noarchive"],
        [
          "content-security-policy",
          "default-src 'none'; form-action 'none'"
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

  process.stdout.write("legal pages unit tests: OK (12 aliases, 3 drafts)\n");
}

main();
