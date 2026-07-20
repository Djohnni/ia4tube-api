const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const planningService = require("../src/company-monthly-planning/planning.service");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-monthly-planning-"));
}

function fakeCliente() {
  return {
    whatsapp: "5511999999999",
    nome_empresa: "Pizzaria Teste",
    ramo: "Pizzaria",
    plano_status: "active",
    plano_renova_em: "2099-01-01",
    plano_ciclo: "2099-01",
    artes_mensais_total: 20,
    artes_mensais_restantes: 20,
    artes_avulsas_restantes: 0
  };
}

function uploadFile(root, name, content = "image") {
  const filePath = path.join(root, `${Date.now()}-${Math.random()}-${name}`);
  fs.writeFileSync(filePath, content);
  return {
    path: filePath,
    originalname: name,
    mimetype: "image/jpeg",
    size: Buffer.byteLength(content)
  };
}

function createRequestWith({ body, files = {} }) {
  const baseDir = tempRoot();
  const cliente = fakeCliente();
  const result = planningService.createRequest({
    baseDir,
    cliente,
    whatsapp: cliente.whatsapp,
    body: {
      nome_empresa: cliente.nome_empresa,
      ramo: cliente.ramo,
      ...body
    },
    files
  });
  return { baseDir, cliente, result };
}

function testNoImageRequest() {
  const { result, cliente } = createRequestWith({
    body: {
      orientacoes_fotos: JSON.stringify([
        {
          slot_id: "fixed-photo-1",
          ordem: 1,
          tem_arquivo: false,
          objetivo: "Divulgar pizza brotinho",
          escrita_imagem: "Peca hoje",
          nivel_edicao: 2
        }
      ])
    }
  });

  assert.strictEqual(result.quantidade_reservada, 1);
  assert.strictEqual(result.assets.fotos.length, 0);
  assert.strictEqual(result.itens_fotos.length, 1);
  assert.strictEqual(result.itens_fotos[0].sem_imagem, true);
  assert.strictEqual(result.itens_fotos[0].objetivo, "Divulgar pizza brotinho");
  assert.strictEqual(result.itens_fotos[0].escrita_imagem, "Peca hoje");
  assert.strictEqual(cliente.artes_mensais_restantes, 19);
}

function testMixedRequestAssociatesFileToCorrectSlot() {
  const root = tempRoot();
  const foto = uploadFile(root, "produto.jpg");
  const { result } = createRequestWith({
    body: {
      orientacoes_fotos: JSON.stringify([
        {
          slot_id: "fixed-photo-1",
          ordem: 1,
          tem_arquivo: false,
          objetivo: "Criar chamada sem foto"
        },
        {
          slot_id: "fixed-photo-2",
          ordem: 2,
          tem_arquivo: true,
          arquivo: "produto.jpg",
          arquivo_index: 1,
          objetivo: "Usar produto fotografado"
        },
        {
          slot_id: "fixed-photo-3",
          ordem: 3,
          tem_arquivo: false,
          escrita_imagem: "Ultimos dias"
        }
      ])
    },
    files: { fotos: [foto] }
  });

  assert.strictEqual(result.quantidade_reservada, 3);
  assert.strictEqual(result.assets.fotos.length, 1);
  assert.strictEqual(result.itens_fotos.length, 3);
  assert.strictEqual(result.itens_fotos[0].sem_imagem, true);
  assert.strictEqual(result.itens_fotos[1].tem_arquivo, true);
  assert.strictEqual(result.itens_fotos[1].slot_id, "fixed-photo-2");
  assert.strictEqual(result.itens_fotos[2].sem_imagem, true);
  assert.strictEqual(result.assets.fotos[0].slot_id, "fixed-photo-2");
}

function testEmptyStructuredRequestIsRejected() {
  assert.throws(
    () => createRequestWith({ body: { orientacoes_fotos: JSON.stringify([]), quantidade_reservada: "0" } }),
    (error) => error.code === "monthly_planning_quantity_required"
  );
}

function testConfiguredTechnicalArtLimit() {
  const technicalLimit = planningService._private.MAX_MONTHLY_PLANNING_REQUEST_ITEMS;
  const items = Array.from({ length: technicalLimit + 1 }, (_, index) => ({
    slot_id: `slot-${index + 1}`,
    ordem: index + 1,
    tem_arquivo: false,
    objetivo: `Objetivo ${index + 1}`
  }));

  assert.throws(
    () => createRequestWith({ body: { orientacoes_fotos: JSON.stringify(items) } }),
    (error) => error.code === "monthly_planning_items_limit"
  );
}

function testLegacyPayloadKeepsQuantityFromBody() {
  const root = tempRoot();
  const foto = uploadFile(root, "old.jpg");
  const { result } = createRequestWith({
    body: {
      quantidade_reservada: "2",
      orientacoes_fotos: JSON.stringify([
        { arquivo: "old.jpg", orientacao: "Usar foto do produto" }
      ])
    },
    files: { fotos: [foto] }
  });

  assert.strictEqual(result.quantidade_reservada, 2);
  assert.strictEqual(result.assets.fotos.length, 1);
  assert.strictEqual(result.itens_fotos.length, 1);
  assert.strictEqual(result.itens_fotos[0].tem_arquivo, true);
}

function testNoImageChildItemDoesNotCopyPlanningPhotos() {
  const selected = planningService._private.selectPlanningPhotoAssets(
    { assets: { fotos: [{ filename: "foto01.jpg" }] } },
    { foto_referencia: { sem_imagem: true, tem_arquivo: false } }
  );

  assert.deepStrictEqual(selected, []);
}

function testDiscoveryMetadataAndPriceSurviveWithoutPhoto() {
  const { result } = createRequestWith({
    body: {
      orientacoes_fotos: JSON.stringify([
        {
          slot_id: "discovered-1",
          ordem: 1,
          tem_arquivo: false,
          produto_identificado: "Frango assado",
          preco: "R$ 29,90",
          nivel_edicao: 2
        }
      ])
    }
  });

  assert.strictEqual(result.quantidade_reservada, 1);
  assert.strictEqual(result.itens_fotos[0].produto_identificado, "Frango assado");
  assert.strictEqual(result.itens_fotos[0].preco, "R$ 29,90");
  assert.strictEqual(result.itens_fotos[0].sem_imagem, true);
  assert.strictEqual(result.assets.fotos.length, 0);
}

testNoImageRequest();
testMixedRequestAssociatesFileToCorrectSlot();
testEmptyStructuredRequestIsRejected();
testConfiguredTechnicalArtLimit();
testLegacyPayloadKeepsQuantityFromBody();
testNoImageChildItemDoesNotCopyPlanningPhotos();
testDiscoveryMetadataAndPriceSurviveWithoutPhoto();

console.log("monthly_planning_photo_items.test.js: ok");
