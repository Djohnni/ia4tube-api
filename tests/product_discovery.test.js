const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const multer = require("multer");

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

function testReferenceCropAcceptsUsefulContextAndClipsSmallOverflow() {
  const decision = service._private.evaluateCrop({
    x: -0.01,
    y: 0.12,
    largura: 0.42,
    altura: 0.55
  });
  assert.strictEqual(decision.rejectionReason, null);
  assert.deepStrictEqual(decision.crop, {
    x: 0,
    y: 0.12,
    largura: 0.41,
    altura: 0.55
  });

  const [product] = service._private.normalizeProducts([{
    nome: "Mouse USB Philips",
    preco: "",
    usar_recorte: true,
    recorte: { x: 0.72, y: 0.18, largura: 0.31, altura: 0.44 }
  }], 20);
  assert.strictEqual(product.usar_recorte, true);
  assert.deepStrictEqual(product.recorte, {
    x: 0.72,
    y: 0.18,
    largura: 0.28,
    altura: 0.44
  });
}

function testReferenceCropRejectsOnlyInvalidOrTrulyTinyRegions() {
  assert.strictEqual(
    service._private.evaluateCrop({ x: 1.2, y: 0.2, largura: 0.2, altura: 0.2 }).rejectionReason,
    "region_outside_image"
  );
  assert.strictEqual(
    service._private.evaluateCrop({ x: 0.2, y: 0.2, largura: 0.02, altura: 0.02 }).rejectionReason,
    "product_region_too_small"
  );
  assert.strictEqual(
    service._private.evaluateCrop({ x: 0.2, y: 0.2, largura: -0.2, altura: 0.2 }).rejectionReason,
    "non_positive_region"
  );
}

function testInstitutionalAndOperationalLabelsAreDiscardedWithoutRemovingConcreteProducts() {
  const rejected = [
    "Delivery",
    "Entrega",
    "Entregamos",
    "Retirada no balcão",
    "Retirada na loja",
    "Retirada no local",
    "Retire aqui",
    "Drive-thru",
    "Faça seu pedido",
    "Peça agora",
    "Atendimento",
    "Atendimento por agendamento",
    "Agende seu horário",
    "Avaliação gratuita",
    "Promoção",
    "Oferta",
    "Novidade",
    "Bem-vindo",
    "Aberto",
    "Fechado",
    "Pix",
    "WhatsApp",
    "Instagram",
    "Facebook",
    "Telefone",
    "Endereço",
    "Cardápio",
    "Catálogo",
    "Tabela de preços",
    "Frete grátis",
    "Aceitamos cartões"
  ];
  const accepted = [
    "Salgado assado com gergelim",
    "Itubaína Retrô",
    "Mouse USB Philips",
    "Kit Delivery para motoboy",
    "Bolsa térmica para delivery",
    "Caixa térmica para entrega",
    "Serviço de entrega expressa",
    "Drive-thru infantil",
    "Telefone sem fio"
  ];

  const products = service._private.normalizeProducts([
    ...rejected.map((nome) => ({ nome })),
    ...accepted.map((nome) => ({ nome }))
  ], 60);

  assert.deepStrictEqual(products.map((item) => item.nome), accepted);
  for (const label of rejected) {
    assert.strictEqual(service._private.isInstitutionalOrOperationalLabel(label), true, label);
  }
  for (const label of accepted) {
    assert.strictEqual(service._private.isInstitutionalOrOperationalLabel(label), false, label);
  }
}

function testEquivalentOperationalPhrasesAreNormalizedAndDiscarded() {
  const rejected = [
    "  ENTREGA GRÁTIS!!! ",
    "Fazemos delivery",
    "Retire em nosso local",
    "Envie o seu pedido pelo WhatsApp",
    "Atendimento com hora marcada",
    "Marque uma avaliação agora",
    "Ofertas imperdíveis",
    "Fale conosco via WhatsApp",
    "Siga nossa loja no Instagram",
    "Pagamento via Pix",
    "Aceitamos todos os cartões"
  ];

  for (const label of rejected) {
    assert.strictEqual(service._private.isInstitutionalOrOperationalLabel(label), true, label);
  }
}

async function testOpenAiOperationalFalsePositivesArePostFiltered() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-discovery-operational-"));
  const filePath = path.join(dir, "padaria.png");
  fs.writeFileSync(filePath, "fake-image");

  try {
    const result = await service.discoverProducts({
      filePath,
      mimeType: "image/png",
      niche: "Padaria",
      apiKey: "test-only",
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          output: [{ content: [{ text: JSON.stringify({
            produtos: [
              { nome: "Salgado assado com gergelim", preco: "", usar_recorte: false, recorte: null },
              { nome: "Itubaína Retrô", preco: "", usar_recorte: false, recorte: null },
              { nome: "Retirada no balcão", preco: "", usar_recorte: false, recorte: null },
              { nome: "Delivery", preco: "", usar_recorte: false, recorte: null },
              { nome: "Drive-thru", preco: "", usar_recorte: false, recorte: null }
            ]
          }) }] }]
        })
      })
    });

    assert.deepStrictEqual(result.produtos.map((item) => item.nome), [
      "Salgado assado com gergelim",
      "Itubaína Retrô"
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  assert.match(prompt, /Retirada no balcao/i);
  assert.match(prompt, /Drive-thru/i);
  assert.match(prompt, /Agende seu horario/i);
  assert.match(prompt, /Frete gratis/i);
  assert.match(prompt, /Kit Delivery para motoboy/i);
  assert.match(prompt, /Servico de entrega expressa/i);
  assert.match(prompt, /produtos=\[\]/i);
  assert.match(prompt, /somente texto institucional e nenhum produto concreto/i);
  assert.match(prompt, /omita somente esse objeto e preserve os demais produtos concretos/i);
  assert.match(prompt, /melhor descartar o objeto duvidoso/i);
}

function testPromptTreatsCropAsProductReferenceInsteadOfFinishedAdvertising() {
  const prompt = service._private.discoveryPrompt(36, "Loja de informatica");
  const schema = service._private.responseSchema(36);
  const cropDescription = schema.properties.produtos.items.properties.usar_recorte.description;

  assert.match(prompt, /referencia por outra IA/i);
  assert.match(prompt, /fundo imperfeito/i);
  assert.match(prompt, /objetos vizinhos/i);
  assert.match(prompt, /caixa um pouco mais ampla/i);
  assert.match(prompt, /nao esta pronto para anuncio/i);
  assert.match(prompt, /produto correspondente ao item continue distinguivel/i);
  assert.doesNotMatch(prompt, /recorte puder servir para divulgacao/i);
  assert.match(cropDescription, /nao exige qualidade pronta para anuncio/i);
}

function testPromptAndSchemaRequireAllIndependentProducts() {
  const prompt = service._private.discoveryPrompt(40, "Mercado");
  const schema = service._private.responseSchema(40);
  const schemaText = JSON.stringify(schema);

  assert.strictEqual(schema.properties.produtos.maxItems, 40);
  assert.match(schema.properties.produtos.description, /cada produto separado deve ser um item independente/i);
  assert.match(prompt, /Analise toda a imagem/i);
  assert.match(prompt, /identifique TODOS os produtos ou servicos concretos e visualmente distinguiveis/i);
  assert.match(prompt, /Nao selecione apenas o item mais evidente/i);
  assert.match(prompt, /cada produto visualmente separado como um item independente/i);
  assert.match(prompt, /Nao retorne produtos=\[\] apenas porque existem varios objetos/i);
  assert.match(prompt, /Nao agrupe produtos independentes em um nome composto/i);
  assert.match(prompt, /kit ou combo comercializado como uma unidade/i);
  assert.match(prompt, /caixa propria referente ao produto daquele item/i);
  assert.match(prompt, /pequena sobreposicao/i);
  assert.match(prompt, /Ignore moveis, equipamentos, ferramentas, decoracao e objetos internos usados pela empresa/i);
  assert.match(prompt, /inclua-os somente se a imagem sustentar claramente que sao produtos comercializados/i);
  assert.match(prompt, /Nao trate como produto: nome da empresa, slogan, categoria do estabelecimento, ramo de atividade, texto institucional/i);
  assert.match(prompt, /o ramo nao e uma lista fechada/i);
  assert.doesNotMatch(schemaText, /produto principal/i);
}

function testTwoSideBySideProductsKeepIndependentCrops() {
  const products = service._private.normalizeProducts([
    {
      nome: "Mouse Philips",
      preco: "",
      usar_recorte: true,
      recorte: { x: 0.04, y: 0.2, largura: 0.48, altura: 0.55 }
    },
    {
      nome: "Teclado Fortrek",
      preco: "",
      usar_recorte: true,
      recorte: { x: 0.48, y: 0.18, largura: 0.48, altura: 0.58 }
    }
  ], 40);

  assert.deepStrictEqual(products.map((item) => item.nome), ["Mouse Philips", "Teclado Fortrek"]);
  assert.strictEqual(products.length, 2);
  assert.notDeepStrictEqual(products[0].recorte, products[1].recorte);
}

function testThreeSeparatedProductsRemainThreeItems() {
  const products = service._private.normalizeProducts([
    { nome: "Livro infantil", usar_recorte: true, recorte: { x: 0.02, y: 0.2, largura: 0.28, altura: 0.5 } },
    { nome: "Lampada LED", usar_recorte: true, recorte: { x: 0.36, y: 0.22, largura: 0.24, altura: 0.42 } },
    { nome: "Teclado USB", usar_recorte: true, recorte: { x: 0.66, y: 0.18, largura: 0.31, altura: 0.48 } }
  ], 40);

  assert.deepStrictEqual(products.map((item) => item.nome), ["Livro infantil", "Lampada LED", "Teclado USB"]);
  assert.ok(products.every((item) => item.usar_recorte && item.recorte));
}

function testPartiallyOverlappingProductsRemainIndependent() {
  const products = service._private.normalizeProducts([
    { nome: "Mouse USB", usar_recorte: true, recorte: { x: 0.1, y: 0.2, largura: 0.5, altura: 0.5 } },
    { nome: "Teclado USB", usar_recorte: true, recorte: { x: 0.45, y: 0.15, largura: 0.5, altura: 0.55 } }
  ], 40);

  assert.strictEqual(products.length, 2);
  assert.ok(products[0].recorte.x + products[0].recorte.largura > products[1].recorte.x);
}

function testSimilarVariantsAreNotMerged() {
  const products = service._private.normalizeProducts([
    { nome: "Coca-Cola 2 L" },
    { nome: "Coca-Cola Zero 2 L" }
  ], 40);

  assert.deepStrictEqual(products.map((item) => item.nome), ["Coca-Cola 2 L", "Coca-Cola Zero 2 L"]);
}

function testTruePackagedKitRemainsOneItem() {
  const products = service._private.normalizeProducts([
    {
      nome: "Kit teclado e mouse Fortrek",
      usar_recorte: true,
      recorte: { x: 0.12, y: 0.14, largura: 0.76, altura: 0.68 }
    }
  ], 40);

  assert.strictEqual(products.length, 1);
  assert.strictEqual(products[0].nome, "Kit teclado e mouse Fortrek");
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
  assert.match(serverSource, /productDiscoveryUpload\s*=\s*multer\([\s\S]*?files:\s*1[\s\S]*?fields:\s*1[\s\S]*?parts:\s*3[\s\S]*?fieldSize:\s*512[\s\S]*?fileSize:\s*3\s*\*\s*1024\s*\*\s*1024/);
  assert.doesNotMatch(serverSource, /productDiscoveryUpload\s*=\s*multer\([\s\S]*?parts:\s*2/);
  assert.match(serverSource, /const permitidos = \["image\/png", "image\/jpeg", "image\/jpg", "image\/webp"\]/);
  assert.match(serverSource, /product_discovery_image_too_large/);
  assert.match(serverSource, /product_discovery_invalid_image/);
  assert.match(serverSource, /product_discovery_in_progress/);
  assert.match(serverSource, /product_discovery_error/);
  assert.match(routeSource, /finally\s*\{[\s\S]*?cleanupUploadedFiles\(\{ imagem: \[req\.file\] \}\)/);
}

function multipartForm({ context, mimeType = "image/jpeg", bytes = Buffer.from("valid-image") }) {
  const form = new FormData();
  form.append("imagem", new Blob([bytes], { type: mimeType }), "produto.jpg");
  if (context !== undefined) form.append("ramo_contexto", context);
  return form;
}

async function testProductDiscoveryMultipartLimitsAndCleanup() {
  const uploadDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-discovery-upload-"));
  const storage = multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDirectory),
    filename: (_req, file, callback) => callback(null, `test_${file.originalname}`)
  });
  const upload = multer({
    storage,
    limits: {
      files: 1,
      fields: 1,
      parts: 3,
      fieldSize: 512,
      fileSize: 3 * 1024 * 1024
    },
    fileFilter: (_req, file, callback) => {
      const allowed = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
      if (!allowed.includes(String(file.mimetype || "").toLowerCase())) {
        return callback(new Error("Apenas imagens PNG, JPG e WEBP sao permitidas."));
      }
      return callback(null, true);
    }
  });
  const app = express();
  app.post("/test", upload.single("imagem"), (req, res) => {
    const hasContext = Object.prototype.hasOwnProperty.call(req.body || {}, "ramo_contexto");
    const context = hasContext ? req.body.ramo_contexto : null;
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.json({ ok: true, hasContext, context, fileCount: req.file ? 1 : 0 });
  });
  app.use((error, _req, res, _next) => {
    const tooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
    return res.status(tooLarge ? 413 : 400).json({
      ok: false,
      code: tooLarge
        ? "product_discovery_image_too_large"
        : "product_discovery_invalid_image",
      multerCode: error instanceof multer.MulterError ? error.code : ""
    });
  });

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const url = `http://127.0.0.1:${server.address().port}/test`;

  try {
    const contexts = [
      { label: "absent", value: undefined, expectedPresent: false, expectedValue: null },
      { label: "empty", value: "", expectedPresent: true, expectedValue: "" },
      { label: "filled", value: "Padaria", expectedPresent: true, expectedValue: "Padaria" }
    ];
    for (const item of contexts) {
      const response = await fetch(url, {
        method: "POST",
        body: multipartForm({ context: item.value })
      });
      const body = await response.json();
      assert.strictEqual(response.status, 200, `${item.label} context must be accepted`);
      assert.strictEqual(body.fileCount, 1);
      assert.strictEqual(body.hasContext, item.expectedPresent);
      assert.strictEqual(body.context, item.expectedValue);
      assert.notStrictEqual(body.multerCode, "LIMIT_PART_COUNT");
      assert.deepStrictEqual(fs.readdirSync(uploadDirectory), []);
    }

    const invalidResponse = await fetch(url, {
      method: "POST",
      body: multipartForm({ context: "Padaria", mimeType: "text/plain" })
    });
    assert.strictEqual(invalidResponse.status, 400);
    assert.strictEqual((await invalidResponse.json()).code, "product_discovery_invalid_image");
    assert.deepStrictEqual(fs.readdirSync(uploadDirectory), []);

    const largeResponse = await fetch(url, {
      method: "POST",
      body: multipartForm({
        context: "Padaria",
        bytes: Buffer.alloc(3 * 1024 * 1024 + 1)
      })
    });
    const largeBody = await largeResponse.json();
    assert.strictEqual(largeResponse.status, 413);
    assert.strictEqual(largeBody.code, "product_discovery_image_too_large");
    assert.notStrictEqual(largeBody.multerCode, "LIMIT_PART_COUNT");
    assert.deepStrictEqual(fs.readdirSync(uploadDirectory), []);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    fs.rmSync(uploadDirectory, { recursive: true, force: true });
  }
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

async function testStructuredResponseKeepsMultipleProducts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-discovery-multiple-"));
  const filePath = path.join(dir, "three-products.jpg");
  fs.writeFileSync(filePath, "fake-image");
  let requestBody;

  try {
    const result = await service.discoverProducts({
      filePath,
      mimeType: "image/jpeg",
      niche: "Loja de variedades",
      maxItems: 40,
      apiKey: "test-only",
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            output: [{ content: [{ text: JSON.stringify({
              produtos: [
                { nome: "Livro infantil", preco: "", usar_recorte: true, recorte: { x: 0.02, y: 0.2, largura: 0.28, altura: 0.5 } },
                { nome: "Lampada LED", preco: "", usar_recorte: true, recorte: { x: 0.36, y: 0.22, largura: 0.24, altura: 0.42 } },
                { nome: "Teclado USB", preco: "", usar_recorte: true, recorte: { x: 0.66, y: 0.18, largura: 0.31, altura: 0.48 } }
              ]
            }) }] }]
          })
        };
      }
    });

    assert.strictEqual(requestBody.text.format.schema.properties.produtos.maxItems, 40);
    assert.deepStrictEqual(result.produtos.map((item) => item.nome), [
      "Livro infantil",
      "Lampada LED",
      "Teclado USB"
    ]);
    assert.strictEqual(new Set(result.produtos.map((item) => JSON.stringify(item.recorte))).size, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function run() {
  testConservativeDeduplication();
  testUnsafeCropIsDisabled();
  testReferenceCropAcceptsUsefulContextAndClipsSmallOverflow();
  testReferenceCropRejectsOnlyInvalidOrTrulyTinyRegions();
  testInstitutionalAndGenericLabelsAreDiscarded();
  testInstitutionalAndOperationalLabelsAreDiscardedWithoutRemovingConcreteProducts();
  testEquivalentOperationalPhrasesAreNormalizedAndDiscarded();
  testPromptRejectsInstitutionalTextAndPrefersZeroItems();
  testPromptTreatsCropAsProductReferenceInsteadOfFinishedAdvertising();
  testPromptAndSchemaRequireAllIndependentProducts();
  testTwoSideBySideProductsKeepIndependentCrops();
  testThreeSeparatedProductsRemainThreeItems();
  testPartiallyOverlappingProductsRemainIndependent();
  testSimilarVariantsAreNotMerged();
  testTruePackagedKitRemainsOneItem();
  testPromptUsesBusinessNicheAsContextWithoutClosedCatalog();
  testHybridBusinessNicheResolution();
  testGenericAndUnsafeBusinessNichesAreDiscardedOrSanitized();
  testNoBusinessNicheUsesConservativePrompt();
  testEndpointUsesHybridBusinessNicheResolver();
  await testProductDiscoveryMultipartLimitsAndCleanup();
  await testInstitutionalOnlyResponseReturnsNoItems();
  await testOpenAiOperationalFalsePositivesArePostFiltered();
  await testEachBusinessNicheReachesTheOpenAiRequest();
  await testOneImageStructuredRequest();
  await testStructuredResponseKeepsMultipleProducts();
  console.log("product_discovery.test.js: ok");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
