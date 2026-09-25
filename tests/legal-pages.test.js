"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");

const {
  LEGAL_PAGE_DEFINITIONS,
  REQUIRED_FINAL_MARKERS,
  createLegalPageHandlers,
  createLegalPagesRouter,
  loadLegalTemplates
} = require("../src/legal/legal-pages.routes");

const CANONICAL_LEGAL_ROUTES = Object.freeze([
  "/politica-de-privacidade",
  "/termos-de-uso",
  "/exclusao-de-dados"
]);
const REQUIRED_IDENTITY = Object.freeze([
  "26.108.034 DJOHNNI DALFOVO",
  "IA4Tube",
  "26.108.034/0001-98",
  "detalhecamiseteria@gmail.com",
  "ASCURRA/SC"
]);
const OFFICIAL_ADDRESS =
  "ALDO VALDIR PINTARELLI, 502, TAMANDUA, CEP 89138000, ASCURRA/SC";
const EFFECTIVE_DATE = "2 de setembro de 2026";
const FORBIDDEN_DRAFT_LABELS = Object.freeze([
  "RASCUNHO TÉCNICO PÚBLICO",
  "NÃO APROVADO JURIDICAMENTE",
  "PUBLIC TECHNICAL DRAFT",
  "NOT LEGALLY APPROVED",
  "DRAFT — PENDING APPROVAL",
  "VERSÃO PREPARADA PARA APROVAÇÃO FINAL DO PROPRIETÁRIO",
  "AINDA NÃO VIGENTE",
  "Versão candidata local",
  "Aprovação final do conteúdo: pendente",
  "Revisão externa por advogado: não realizada.",
  "Este texto não afirma conformidade jurídica absoluta.",
  "depende da aprovação final do proprietário",
  "não possui data de vigência definitiva",
  "versão para aprovação",
  "versão completa preparada localmente"
]);
const FORBIDDEN_PUBLIC_PATTERNS = Object.freeze([
  /NOTA DE AUDITORIA/i,
  /\bOWNER_APPROVAL\b/i,
  /\b(?:migration|migrations|schema|ledger|staging)\b/i,
  /\bmigraç(?:ão|ões)(?:\s+\d+)?\b/i,
  /\bWAL\b/,
  /páginas? de banco/i,
  /(?:[A-Za-z]:\\|\/(?:Users|home|tmp)\/)/i,
  /\b(?:SHA-?256|hash(?:es)?)\b/i,
  /\bGate\s*5A\b/i,
  /dados?\s+sintétic[oa]s?|teste\s+sintétic[oa]/i,
  /\bO Mascote\b/i
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

function assertFinalPage(response) {
  assert.equal(response.statusCode, 200);
  assert.match(response.contentType, /^(?:text\/)?html(?:;|$)/i);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-language"), "pt-BR");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    response.headers.get("x-robots-tag"),
    "index,follow"
  );
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(response.headers.get("content-security-policy"), /style-src 'unsafe-inline'/);
  assert.match(response.headers.get("content-security-policy"), /form-action 'none'/);

  for (const marker of REQUIRED_FINAL_MARKERS) {
    assert.equal(response.body.includes(marker), true, `Marcador ausente: ${marker}`);
  }
  assert.equal(
    response.body.includes(`<strong>Vigente desde:</strong> ${EFFECTIVE_DATE}`),
    true,
    "Data de vigencia ausente"
  );
  assert.equal(
    response.body.includes(`<strong>Última atualização:</strong> ${EFFECTIVE_DATE}`),
    true,
    "Data de atualizacao ausente"
  );
  for (const value of REQUIRED_IDENTITY) {
    assert.equal(response.body.includes(value), true, "Identidade empresarial incompleta");
  }
  assert.equal(
    response.body.includes(OFFICIAL_ADDRESS),
    true,
    "Endereco oficial ausente"
  );
  for (const draftLabel of FORBIDDEN_DRAFT_LABELS) {
    assert.equal(response.body.includes(draftLabel), false, `Rotulo de rascunho: ${draftLabel}`);
  }
  for (const pattern of FORBIDDEN_PUBLIC_PATTERNS) {
    assert.doesNotMatch(response.body, pattern, `Detalhe publico proibido: ${pattern}`);
  }

  assert.match(
    response.body,
    /<meta name="robots" content="index,follow">/i
  );
  assert.match(response.body, /<meta name="viewport"/i);
  assert.match(response.body, /@media\s*\(max-width:\s*640px\)/i);
  assert.doesNotMatch(response.body, /<script\b/i);
  assert.doesNotMatch(response.body, /<form\b/i);
  assert.doesNotMatch(response.body, /https?:\/\//i);
  assert.doesNotMatch(response.body, /Tun[aá]polis/i);
  assert.doesNotMatch(response.body, /revisad[oa]s? por advogad[oa]/i);
  assert.doesNotMatch(response.body, /100\s*%\s*(?:adequad|conforme)/i);
  assert.doesNotMatch(response.body, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
  assert.doesNotMatch(response.body, /\bsk-[A-Za-z0-9_-]{20,}\b/);
  assert.doesNotMatch(response.body, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/);
  assert.doesNotMatch(response.body, /(?:client_secret|private_key)\s*[:=]\s*["'][^"']+/i);

  for (const route of CANONICAL_LEGAL_ROUTES) {
    assert.match(
      response.body,
      new RegExp(`href=["']${route}["']`, "i"),
      `Link juridico ausente: ${route}`
    );
  }
}

async function assertRealHttpRoutes() {
  const app = express();
  app.disable("x-powered-by");
  app.use(createLegalPagesRouter());
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.once("error", reject);
  });

  try {
    const address = server.address();
    for (const route of CANONICAL_LEGAL_ROUTES) {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`);
      const body = await response.text();
      assertFinalPage({
        statusCode: response.status,
        contentType: response.headers.get("content-type") || "",
        headers: new Map([
          ["cache-control", response.headers.get("cache-control")],
          ["content-language", response.headers.get("content-language")],
          ["referrer-policy", response.headers.get("referrer-policy")],
          ["x-content-type-options", response.headers.get("x-content-type-options")],
          ["x-robots-tag", response.headers.get("x-robots-tag")],
          ["content-security-policy", response.headers.get("content-security-policy")]
        ]),
        body
      });
    }
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function main() {
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
  assert.deepEqual(Object.keys(handlers).sort(), ["dataDeletion", "privacy", "terms"]);
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
      assertFinalPage(response);
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
    assertFinalPage({
      statusCode: 200,
      contentType: "html",
      headers: new Map([
        ["cache-control", "no-store"],
        ["content-language", "pt-BR"],
        ["referrer-policy", "no-referrer"],
        ["x-content-type-options", "nosniff"],
        ["x-robots-tag", "index,follow"],
        [
          "content-security-policy",
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'"
        ]
      ]),
      body: html
    });
  }

  assert.match(templates.privacy, /todo o produto IA4Tube/i);
  assert.match(templates.privacy, /Render/);
  assert.match(templates.privacy, /Google Analytics/);
  assert.match(templates.privacy, /OpenAI/);
  assert.match(templates.privacy, /cópias técnicas de segurança/i);
  assert.match(templates.privacy, /não promete a eliminação instantânea de todas as cópias/i);
  assert.match(templates.privacy, /pedidos de exclusão registrados serão verificados e reaplicados/i);
  assert.match(templates.privacy, /atendimento das solicitações de privacidade será gratuito/i);
  assert.match(templates.privacy, /Autoridade Nacional de Proteção de Dados — ANPD/i);
  assert.match(templates.privacy, /órgãos de defesa do consumidor/i);
  assert.doesNotMatch(
    templates.privacy,
    /15 pedidos|500 registros|50\.000 eventos|10 minutos de inatividade|enquanto a base correspondente existir/i
  );
  const retentionSection = templates.privacy.match(
    /<h2>11\. Retenção<\/h2>([\s\S]*?)<h2>12\. Backups e restauração<\/h2>/i
  )?.[1];
  assert.ok(retentionSection, "Seção pública de retenção ausente");
  assert.deepEqual(retentionSection.match(/\b\d+(?:[.,]\d+)?\b/g), ["7", "12", "10", "5", "6"]);
  assert.match(templates.terms, /pelo menos 18 anos/i);
  assert.match(templates.terms, /Publicação automática nunca começa selecionada/i);
  assert.match(templates.terms, /permalink/i);
  assert.doesNotMatch(templates.dataDeletion, /migração necessária não foi aplicada/i);
  assert.doesNotMatch(
    templates.dataDeletion,
    /\b(?:migration|schema|ledger|staging)\b|migração\s*0006|perfil de banco/i
  );
  assert.match(templates.dataDeletion, /Se você utilizar a integração da IA4Tube com Instagram\/Meta/i);
  assert.match(
    templates.dataDeletion,
    /protocolo opaco, usado como código de confirmação, e um link de acompanhamento/i
  );
  assert.match(
    templates.dataDeletion,
    /Quando concluída, a credencial social elegível é eliminada e a conexão permanece revogada/i
  );
  assert.match(templates.dataDeletion, /não promete a eliminação instantânea de todas as cópias/i);
  assert.match(templates.dataDeletion, /pedidos de exclusão registrados serão verificados e reaplicados/i);

  const publicBackupContent = `${templates.privacy}\n${templates.dataDeletion}`;
  assert.doesNotMatch(
    publicBackupContent,
    /páginas? de banco|\bWAL\b|\bréplicas?\b|ferramenta candidata|restauração.*não reaplic/i
  );

  const allLegalContent = Object.values(templates).join("\n");
  const requiredSocialContract = [
    /cada empresa pode conectar uma conta profissional Instagram Business ou Creator/i,
    /conectar (?:uma conta )?não publica/i,
    /não ativa a Publicação automática/i,
    /Publicação automática nunca começa selecionada/i,
    /geração automática e publicação são controles independentes/i,
    /senha do Instagram é digitada somente no ambiente oficial da Meta/i,
    /IA4Tube não recebe (?:essa|a) senha/i,
    /token social protegido não (?:é entregue|chega) ao navegador/i,
    /desconexão bloqueia novas publicações/i,
    /Desconectar e excluir dados são operações diferentes/i,
    /credencial social elegível (?:será eliminada|é eliminada|elimina)/i,
    /conexão e a conta técnica (?:poderão|podem) permanecer (?:com estado )?revogadas?/i,
    /não apaga o usuário nem a empresa/i,
    /Artes, imagens, legendas, pedidos.*histórico.*permanecem/i,
    /protocolo opaco, usado como código de confirmação, e um link de acompanhamento/i,
    /conteúdo atrasado nunca é publicado automaticamente depois de uma reconexão/i,
    /“Enviando” e “Confirmando” não significam “Publicado”/i,
    /confirmação com referência do provedor e permalink/i
  ];
  for (const contractRule of requiredSocialContract) {
    assert.match(allLegalContent, contractRule, `Regra social ausente: ${contractRule}`);
  }

  assert.throws(
    () => loadLegalTemplates(path.resolve(__dirname, "missing-legal-templates")),
    /ENOENT/
  );
  assert.throws(
    () => createLegalPagesRouter({ router: {} }),
    /Router legal invalido/
  );

  await assertRealHttpRoutes();
  process.stdout.write(
    "legal pages final validation: OK (3 HTTP routes, 12 aliases, identity, dates, links, robots and content)\n"
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
