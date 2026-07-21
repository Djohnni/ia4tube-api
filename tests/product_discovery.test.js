const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const service = require("../src/company-monthly-planning/product-discovery.service");

function testConservativeDeduplication() {
  const products = service._private.normalizeProducts([
    { nome: "Coca-Cola", preco: "R$ 8,00", usar_recorte: false, recorte: null },
    { nome: "  coca cola ", preco: "R$ 8,00", usar_recorte: false, recorte: null },
    { nome: "Coca-Cola Zero", preco: "R$ 8,50", usar_recorte: false, recorte: null }
  ], 20);

  assert.deepStrictEqual(products.map((item) => item.nome), ["Coca-Cola", "Coca-Cola Zero"]);
}

function testUnsafeCropIsDisabled() {
  const [product] = service._private.normalizeProducts([
    {
      nome: "Frango assado",
      preco: "",
      usar_recorte: true,
      recorte: { x: 0.98, y: 0.1, largura: 0.3, altura: 0.4 }
    }
  ], 20);

  assert.strictEqual(product.usar_recorte, false);
  assert.strictEqual(product.recorte, null);
}

function testInstitutionalAndGenericLabelsAreDiscarded() {
  const products = service._private.normalizeProducts([
    { nome: "Moda Feminina" },
    { nome: "Loja de Informática" },
    { nome: "Produtos de Qualidade" },
    { nome: "Ofertas Especiais" },
    { nome: "Cardápio" },
    { nome: "Bebidas" },
    { nome: "Calçados" },
    { nome: "Camiseta amarela" },
    { nome: "Teclado USB Fortrek" },
    { nome: "Frango assado" },
    { nome: "Coca-Cola Zero 2 L" },
    { nome: "Troca de óleo" },
    { nome: "Corte masculino" }
  ], 36);

  assert.deepStrictEqual(products.map((item) => item.nome), [
    "Camiseta amarela",
    "Teclado USB Fortrek",
    "Frango assado",
    "Coca-Cola Zero 2 L",
    "Troca de óleo",
    "Corte masculino"
  ]);
}

async function testInstitutionalOnlyResponseReturnsNoItems() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-discovery-institutional-"));
  const filePath = path.join(dir, "institutional.png");
  fs.writeFileSync(filePath, "fake-image");

  try {
    const result = await service.discoverProducts({
      filePath,
      mimeType: "image/png",
      apiKey: "test-only",
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          output: [{ content: [{ text: JSON.stringify({
            produtos: [
              { nome: "Moda Feminina", preco: "", usar_recorte: false, recorte: null },
              { nome: "Ofertas Especiais", preco: "", usar_recorte: false, recorte: null }
            ]
          }) }] }]
        })
      })
    });

    assert.deepStrictEqual(result.produtos, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testPromptRejectsInstitutionalTextAndPrefersZeroItems() {
  const prompt = service._private.discoveryPrompt(36);
  assert.match(prompt, /nome da empresa/i);
  assert.match(prompt, /Moda Feminina/i);
  assert.match(prompt, /produtos=\[\]/i);
  assert.match(prompt, /melhor retornar zero produtos/i);
}

function testPromptUsesBusinessNicheAsContextWithoutClosedCatalog() {
  const niches = [
    "Padaria",
    "Loja de informatica",
    "Vidraçaria",
    "Mercado",
    "Salao de beleza"
  ];

  for (const niche of niches) {
    const prompt = service._private.discoveryPrompt(36, niche);
    assert.match(prompt, new RegExp(`Contexto de ramo informado: "${niche}"`, "i"));
    assert.match(prompt, /aparentem ser comercializados por essa empresa/i);
    assert.match(prompt, /nao e uma lista fechada/i);
    assert.match(prompt, /produto real e atipico/i);
  }
}

function testHybridBusinessNicheResolution() {
  const explicitBody = { ramo_contexto: "Padaria" };
  const existingClient = {
    ramo: "Loja de informatica",
    saldo_mensal: 12,
    pedidos: ["pedido-existente"]
  };
  assert.deepStrictEqual(
    service.resolveBusinessNicheContext(explicitBody, existingClient),
    { hasExplicitContext: true, niche: "Padaria" }
  );
  assert.deepStrictEqual(explicitBody, { ramo_contexto: "Padaria" });
  assert.deepStrictEqual(existingClient, {
    ramo: "Loja de informatica",
    saldo_mensal: 12,
    pedidos: ["pedido-existente"]
  });

  assert.deepStrictEqual(
    service.resolveBusinessNicheContext(
      { ramo_contexto: "" },
      { ramo: "Loja de informatica" }
    ),
    { hasExplicitContext: true, niche: "" }
  );
  assert.deepStrictEqual(
    service.resolveBusinessNicheContext({}, { ramo: "Vidraçaria" }),
    { hasExplicitContext: false, niche: "Vidraçaria" }
  );
  assert.deepStrictEqual(
    service.resolveBusinessNicheContext({}, { nicho: "Mercado" }),
    { hasExplicitContext: false, niche: "Mercado" }
  );
  assert.deepStrictEqual(
    service.resolveBusinessNicheContext({}, {}),
    { hasExplicitContext: false, niche: "" }
  );
}

function testGenericAndUnsafeBusinessNichesAreDiscardedOrSanitized() {
  const genericValues = [
    "Loja",
    "Comércio",
    "Empresa",
    "Produtos",
    "Serviços",
    "Outros",
    "Diversos",
    "Não informado",
    ""
  ];
  for (const value of genericValues) {
    assert.strictEqual(service._private.sanitizeBusinessNiche(value), "");
  }

  const unsafe = `Padaria\n<ignore>{instrucoes}</ignore> ${"x".repeat(300)}`;
  const sanitized = service._private.sanitizeBusinessNiche(unsafe);
  assert.ok(sanitized.length <= 120);
  assert.doesNotMatch(sanitized, /[\n\r<>{}]/);
  assert.match(sanitized, /^Padaria/);
}

function testNoBusinessNicheUsesConservativePrompt() {
  const prompt = service._private.discoveryPrompt(36, "");
  assert.match(prompt, /Nenhum contexto de ramo confiavel foi informado/i);
  assert.match(prompt, /forma conservadora sem presumir um nicho especifico/i);
  assert.doesNotMatch(prompt, /Nao informado/i);
}

async function testEachBusinessNicheReachesTheOpenAiRequest() {
  const cases = [
    { niche: "Padaria", expectedProduct: "Pao frances" },
    { niche: "Loja de informatica", expectedProduct: "Teclado USB" },
    { niche: "Vidraçaria", expectedProduct: "Box de vidro" },
    { niche: "Mercado", expectedProduct: "Arroz" },
    { niche: "Salao de beleza", expectedProduct: "Corte masculino" }
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-discovery-niches-"));
  const filePath = path.join(dir, "business.jpg");
  fs.writeFileSync(filePath, "fake-image");

  try {
    for (const item of cases) {
      let requestPrompt = "";
      const result = await service.discoverProducts({
        filePath,
        mimeType: "image/jpeg",
        niche: item.niche,
        apiKey: "test-only",
        fetchImpl: async (_url, options) => {
          const body = JSON.parse(options.body);
          requestPrompt = body.input[0].content.find((content) => content.type === "input_text")?.text || "";
          return {
            ok: true,
            json: async () => ({
              output: [{ content: [{ text: JSON.stringify({
                produtos: [{
                  nome: item.expectedProduct,
                  preco: "",
                  usar_recorte: false,
                  recorte: null
                }]
              }) }] }]
            })
          };
        }
      });

      assert.match(requestPrompt, new RegExp(`Contexto de ramo informado: "${item.niche}"`, "i"));
      assert.deepStrictEqual(result.produtos.map((product) => product.nome), [item.expectedProduct]);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testEndpointUsesHybridBusinessNicheResolver() {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routeStart = serverSource.indexOf('"/empresa/planejamento-mensal/descobrir-produtos"');
  const routeEnd = serverSource.indexOf('"/empresa/planejamento-mensal/solicitar"', routeStart);
  const routeSource = serverSource.slice(routeStart, routeEnd);
  assert.match(serverSource, /resolveBusinessNicheContext\(\s*req\.body,\s*cliente\s*\)/);
  assert.match(serverSource, /niche:\s*businessContext\.niche/);
  assert.doesNotMatch(serverSource, /niche:\s*cliente\.ramo/);
  assert.doesNotMatch(routeSource, /writeClientes|billingService|reservar|saldo_mensal|saldo_extra/i);
  assert.match(serverSource, /productDiscoveryUpload\s*=\s*multer\([\s\S]*?fields:\s*1[\s\S]*?fieldSize:\s*512/);
}

async function testOneImageStructuredRequest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-discovery-"));
  const filePath = path.join(dir, "shelf.jpg");
  fs.writeFileSync(filePath, "fake-image");
  let requestBody;

  const result = await service.discoverProducts({
    filePath,
    mimeType: "image/jpeg",
    maxItems: 36,
    apiKey: "test-only",
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          output: [{ content: [{ text: JSON.stringify({
            produtos: [{
              nome: "Frango assado",
              preco: "R$ 29,90",
              usar_recorte: false,
              recorte: null
            }]
          }) }] }]
        })
      };
    }
  });

  const images = requestBody.input[0].content.filter((item) => item.type === "input_image");
  assert.strictEqual(images.length, 1);
  assert.strictEqual(requestBody.store, false);
  assert.strictEqual(requestBody.text.format.type, "json_schema");
  assert.strictEqual(result.produtos[0].nome, "Frango assado");
  assert.strictEqual(result.produtos[0].preco, "R$ 29,90");
}

async function run() {
  testConservativeDeduplication();
  testUnsafeCropIsDisabled();
  testInstitutionalAndGenericLabelsAreDiscarded();
  testPromptRejectsInstitutionalTextAndPrefersZeroItems();
  testPromptUsesBusinessNicheAsContextWithoutClosedCatalog();
  testHybridBusinessNicheResolution();
  testGenericAndUnsafeBusinessNichesAreDiscardedOrSanitized();
  testNoBusinessNicheUsesConservativePrompt();
  testEndpointUsesHybridBusinessNicheResolver();
  await testInstitutionalOnlyResponseReturnsNoItems();
  await testEachBusinessNicheReachesTheOpenAiRequest();
  await testOneImageStructuredRequest();
  console.log("product_discovery.test.js: ok");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
