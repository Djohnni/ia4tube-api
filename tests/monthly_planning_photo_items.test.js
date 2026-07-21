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
    instagram: "@pizzaria_teste",
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
  assert.strictEqual(result.assets.fotos[0].arquivo_index, 1);
  assert.strictEqual(result.itens_fotos[1].filename, result.assets.fotos[0].filename);
  assert.strictEqual(result.itens_fotos[1].tipo_referencia, "foto_manual");
  assert.strictEqual(result.profile.instagram, "@pizzaria_teste");
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

function findFilesNamed(root, expectedName) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...findFilesNamed(entryPath, expectedName));
    if (entry.isFile() && entry.name === expectedName) found.push(entryPath);
  }
  return found;
}

function testEditedDiscoveryNameAndReferenceInstructionSurviveWithPhoto() {
  const root = tempRoot();
  const photo = uploadFile(root, "mouse-reference.jpg");
  const editedName = "Mouse optico Philips USB";
  const { result } = createRequestWith({
    body: {
      orientacoes_fotos: JSON.stringify([{
        slot_id: "discovered-edited",
        ordem: 1,
        arquivo: "mouse-reference.jpg",
        arquivo_index: 1,
        tem_arquivo: true,
        produto_identificado: editedName,
        tipo_referencia: "produto_descoberto",
        nivel_edicao: 2
      }])
    },
    files: { fotos: [photo] }
  });

  const item = result.itens_fotos[0];
  assert.strictEqual(item.produto_identificado, editedName);
  assert.match(item.orientacao, new RegExp(`Produto identificado: ${editedName}`, "i"));
  assert.match(item.orientacao, /imagem anexada como referencia do produto principal/i);
  assert.match(item.orientacao, new RegExp(`O foco e ${editedName}`, "i"));
  assert.match(item.orientacao, /Ignore objetos vizinhos, fundo, prateleira, cabos/i);
  assert.strictEqual(item.tipo_referencia, "produto_descoberto");
}

function testStableReferenceMappingSkipsMissingCropWithoutShiftingFollowingProducts() {
  const root = tempRoot();
  const cropA = uploadFile(root, "crop-a.jpg", "crop-a");
  const cropB = uploadFile(root, "crop-b.jpg", "crop-b");
  const { result } = createRequestWith({
    body: {
      orientacoes_fotos: JSON.stringify([
        {
          slot_id: "product-1",
          ordem: 1,
          tem_arquivo: false,
          produto_identificado: "Produto sem recorte",
          tipo_referencia: "produto_descoberto"
        },
        {
          slot_id: "product-2",
          ordem: 2,
          tem_arquivo: true,
          arquivo: "crop-a.jpg",
          arquivo_index: 1,
          produto_identificado: "Produto A",
          tipo_referencia: "produto_descoberto"
        },
        {
          slot_id: "product-3",
          ordem: 3,
          tem_arquivo: true,
          arquivo: "crop-b.jpg",
          arquivo_index: 2,
          produto_identificado: "Produto B",
          tipo_referencia: "produto_descoberto"
        }
      ])
    },
    files: { fotos: [cropA, cropB] }
  });

  const posts = planningService._private.enrichPlanPhotoReferences(result, [
    { ordem: 1, foto_referencia: { ordem: 1, tem_arquivo: false, sem_imagem: true } },
    { ordem: 2, foto_referencia: { ordem: 2, filename: result.assets.fotos[0].filename, tem_arquivo: true } },
    { ordem: 3, foto_referencia: { ordem: 3, filename: result.assets.fotos[1].filename, tem_arquivo: true } }
  ]);

  const selected1 = planningService._private.selectPlanningPhotoAssets(result, posts[0]);
  const selected2 = planningService._private.selectPlanningPhotoAssets(result, posts[1]);
  const selected3 = planningService._private.selectPlanningPhotoAssets(result, posts[2]);

  assert.deepStrictEqual(selected1, []);
  assert.strictEqual(selected2.length, 1);
  assert.strictEqual(selected2[0].asset.slot_id, "product-2");
  assert.strictEqual(selected2[0].asset.original_name, "crop-a.jpg");
  assert.strictEqual(selected3.length, 1);
  assert.strictEqual(selected3[0].asset.slot_id, "product-3");
  assert.strictEqual(selected3[0].asset.original_name, "crop-b.jpg");
}

function testMissingSpecificReferenceNeverFallsBackToAllPlanningPhotos() {
  const selected = planningService._private.selectPlanningPhotoAssets(
    {
      assets: {
        fotos: [
          { slot_id: "slot-a", arquivo_index: 1, filename: "a.jpg" },
          { slot_id: "slot-b", arquivo_index: 2, filename: "b.jpg" }
        ]
      }
    },
    {
      ordem: 3,
      foto_referencia: {
        slot_id: "missing-slot",
        arquivo_index: 3,
        filename: "missing.jpg",
        tem_arquivo: true
      }
    }
  );

  assert.deepStrictEqual(selected, []);
}

function testStructuredWritingIsTheOnlyRequiredVisibleText() {
  const planning = {
    itens_fotos: [{
      slot_id: "product-1",
      ordem: 1,
      tem_arquivo: false,
      produto_identificado: "Mouse optico Philips USB",
      preco: "R$ 19,00",
      tipo_referencia: "produto_descoberto",
      escrita_imagem: "",
      nivel_edicao: 2,
      contrato_foto_estruturado: true,
      orientacao: "Produto identificado: Mouse optico Philips USB\nUse a imagem anexada como referencia.\nPreco informado: R$ 19,00\nNivel de edicao: 2"
    }]
  };
  const [post] = planningService._private.enrichPlanPhotoReferences(planning, [{
    ordem: 1,
    texto_obrigatorio_imagem: "Produto identificado: Mouse optico Philips USB e instrucoes internas",
    foto_referencia: { ordem: 1, tem_arquivo: false, sem_imagem: true }
  }]);
  const routing = planningService._private.mergeOrientationRouting(post);
  const child = planningService._private.buildChildOrder({
    planning: {
      ...planning,
      planejamento_id: "planning-1",
      whatsapp: "5511999999999",
      profile: { nome_empresa: "Info Teste", ramo: "Loja de informatica", whatsapp: "5511999999999" }
    },
    item: post,
    itemId: "item-1",
    pedidoId: "pedido-1",
    mesAtual: "2099-01",
    copiedAssets: { fotos: [], logo: "" }
  });

  assert.strictEqual(routing.texto_obrigatorio_imagem, "");
  assert.strictEqual(child.texto_obrigatorio_imagem, "");
  assert.strictEqual(child.produto_identificado, "Mouse optico Philips USB");
  assert.strictEqual(child.preco, "R$ 19,00");
  assert.strictEqual(child.tipo_referencia, "produto_descoberto");
  assert.strictEqual(child.fields.campos_dinamicos.produto_identificado, "Mouse optico Philips USB");
  assert.strictEqual(child.fields.campos_dinamicos.preco, "R$ 19,00");
  assert.strictEqual(child.ramo, "Loja de informatica");
}

function testExplicitWritingSurvivesExactlyAndLegacyRoutingStillWorks() {
  const [structuredPost] = planningService._private.enrichPlanPhotoReferences({
    itens_fotos: [{
      slot_id: "manual-1",
      ordem: 1,
      tem_arquivo: false,
      objetivo: "Divulgar atendimento",
      escrita_imagem: "Aproveite hoje",
      contrato_foto_estruturado: true
    }]
  }, [{
    ordem: 1,
    texto_obrigatorio_imagem: "texto incorreto do plano",
    orientacao_visual: "Direcao visual manual",
    foto_referencia: { ordem: 1, tem_arquivo: false, sem_imagem: true }
  }]);
  const structuredRouting = planningService._private.mergeOrientationRouting(structuredPost);
  assert.strictEqual(structuredRouting.texto_obrigatorio_imagem, "Aproveite hoje");
  assert.strictEqual(structuredPost.tipo_referencia, "foto_manual");

  const legacyRouting = planningService._private.mergeOrientationRouting({
    orientacao_cliente: "Escreva Oferta especial"
  });
  assert.strictEqual(legacyRouting.texto_obrigatorio_imagem, "Oferta especial");
}

function testDiscoveryContractReachesStoredPlanAndChildOrderEndToEnd() {
  const root = tempRoot();
  const pedidosDir = tempRoot();
  const photo = uploadFile(root, "mouse-reference.jpg", "mouse-reference");
  const { baseDir, cliente, result } = createRequestWith({
    body: {
      nome_empresa: "Info Teste",
      ramo: "Loja de informatica",
      instagram: "@info_teste",
      orientacoes_fotos: JSON.stringify([{
        slot_id: "discovered-mouse",
        ordem: 1,
        arquivo: "mouse-reference.jpg",
        arquivo_index: 1,
        tem_arquivo: true,
        produto_identificado: "Mouse optico Philips USB",
        preco: "R$ 19,00",
        escrita_imagem: "Oferta de hoje",
        tipo_referencia: "produto_descoberto",
        nivel_edicao: 2
      }])
    },
    files: { fotos: [photo] }
  });

  planningService.savePlanResult({
    baseDir,
    planningId: result.planejamento_id,
    pedidosDir,
    cliente,
    payload: {
      postagens: [{
        ordem: 1,
        tema: "Produto em destaque",
        objetivo: "Divulgar produto",
        texto_obrigatorio_imagem: "instrucao interna incorreta",
        foto_referencia: {
          ordem: 1,
          filename: result.assets.fotos[0].filename,
          tem_arquivo: true,
          sem_imagem: false
        }
      }]
    }
  });

  const storedPlans = findFilesNamed(baseDir, "plano_mensal.json");
  const childOrders = findFilesNamed(pedidosDir, "pedido.json");
  assert.strictEqual(storedPlans.length, 1);
  assert.strictEqual(childOrders.length, 1);

  const storedPlan = JSON.parse(fs.readFileSync(storedPlans[0], "utf8"));
  const storedPost = storedPlan.postagens[0];
  const child = JSON.parse(fs.readFileSync(childOrders[0], "utf8"));

  assert.strictEqual(storedPost.foto_referencia.slot_id, "discovered-mouse");
  assert.strictEqual(storedPost.foto_referencia.arquivo_index, 1);
  assert.strictEqual(storedPost.foto_referencia.produto_identificado, "Mouse optico Philips USB");
  assert.strictEqual(storedPost.foto_referencia.preco, "R$ 19,00");
  assert.strictEqual(storedPost.foto_referencia.tipo_referencia, "produto_descoberto");
  assert.strictEqual(storedPost.texto_obrigatorio_imagem, "Oferta de hoje");
  assert.strictEqual(child.produto_identificado, "Mouse optico Philips USB");
  assert.strictEqual(child.preco, "R$ 19,00");
  assert.strictEqual(child.tipo_referencia, "produto_descoberto");
  assert.strictEqual(child.texto_obrigatorio_imagem, "Oferta de hoje");
  assert.strictEqual(child.fields.campos_dinamicos.produto_identificado, "Mouse optico Philips USB");
  assert.strictEqual(child.fields.campos_dinamicos.preco, "R$ 19,00");
  assert.strictEqual(child.assets.fotos.length, 1);
  assert.strictEqual(child.ramo, "Loja de informatica");
  assert.strictEqual(child.instagram, "@info_teste");
}

testNoImageRequest();
testMixedRequestAssociatesFileToCorrectSlot();
testEmptyStructuredRequestIsRejected();
testConfiguredTechnicalArtLimit();
testLegacyPayloadKeepsQuantityFromBody();
testNoImageChildItemDoesNotCopyPlanningPhotos();
testDiscoveryMetadataAndPriceSurviveWithoutPhoto();
testEditedDiscoveryNameAndReferenceInstructionSurviveWithPhoto();
testStableReferenceMappingSkipsMissingCropWithoutShiftingFollowingProducts();
testMissingSpecificReferenceNeverFallsBackToAllPlanningPhotos();
testStructuredWritingIsTheOnlyRequiredVisibleText();
testExplicitWritingSurvivesExactlyAndLegacyRoutingStillWorks();
testDiscoveryContractReachesStoredPlanAndChildOrderEndToEnd();

console.log("monthly_planning_photo_items.test.js: ok");
