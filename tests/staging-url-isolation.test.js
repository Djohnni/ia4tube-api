"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const {
  createPublicUrlConfig,
  requireHttpsOrigin
} = require("../src/config/public-urls");
const { renderNichePage } = require("../src/seo/niche-page-renderer");

const repoDir = path.resolve(__dirname, "..");
const stagingOrigin = "https://ia4tube-api-staging-checkpoint-a.onrender.com";

assert.throws(
  () => createPublicUrlConfig({}),
  /PUBLIC_API_BASE_URL/
);
assert.throws(
  () => createPublicUrlConfig({ PUBLIC_API_BASE_URL: "http://staging.invalid" }),
  /origem HTTPS/
);
assert.throws(
  () => requireHttpsOrigin("PUBLIC_API_BASE_URL", `${stagingOrigin}/caminho`),
  /origem HTTPS/
);

const config = createPublicUrlConfig({
  PUBLIC_API_BASE_URL: stagingOrigin
});
assert.equal(config.publicApiBaseUrl, stagingOrigin);
assert.equal(config.publicWebBaseUrl, stagingOrigin);
assert.equal(
  config.mercadoPagoNotificationUrl,
  `${stagingOrigin}/webhook/mercadopago`
);
assert.equal(config.paymentReturnUrl, `${stagingOrigin}/app.html`);
assert.equal(config.paymentPayerEmailDomain, "ia4tube.invalid");

const rendered = renderNichePage({
  slug: "teste-sintetico",
  nome_nicho: "Teste Sintetico",
  titulo_seo: "Teste Sintetico",
  descricao_seo: "Pagina sintetica para validar isolamento.",
  h1: "Teste Sintetico",
  introducao: "Conteudo sintetico.",
  beneficios: [],
  como_funciona: [],
  ideias_posts: [],
  campanhas_sazonais: [],
  exemplos_dia_a_dia: [],
  faq: [],
  palavras_chave: [],
  ctas: {}
}, { baseUrl: stagingOrigin });
assert.ok(rendered.includes(`${stagingOrigin}/teste-sintetico`));

const executableSources = [
  path.join(repoDir, "server.js"),
  path.join(repoDir, "src", "config", "public-urls.js"),
  path.join(repoDir, "src", "seo", "niche-page-renderer.js")
].map((filePath) => fs.readFileSync(filePath, "utf8")).join("\n");

for (const forbidden of [
  "ia4tube-api.onrender.com",
  "https://ia4tube.com",
  "https://www.ia4tube.com"
]) {
  assert.ok(!executableSources.includes(forbidden), `Referencia proibida encontrada: ${forbidden}`);
}

const serverSource = fs.readFileSync(path.join(repoDir, "server.js"), "utf8");
const notificationAssignments = serverSource.match(/notification_url:\s*MP_NOTIFICATION_URL/g) || [];
assert.equal(notificationAssignments.length, 4);

process.stdout.write("Staging URL isolation tests: OK\n");
