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
  await testInstitutionalOnlyResponseReturnsNoItems();
  await testOneImageStructuredRequest();
  console.log("product_discovery.test.js: ok");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
