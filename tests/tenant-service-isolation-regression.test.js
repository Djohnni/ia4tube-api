"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const materialsService = require("../src/company-graphic-materials/materials.service");
const planningService = require("../src/company-monthly-planning/planning.service");
const orderStorage = require("../src/orders/order.storage");

function temporaryDirectory(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function writeOrder(root, ownerDirectory, month, orderId, metadata) {
  const base = path.join(root, ownerDirectory, month, orderId);
  fs.mkdirSync(base, { recursive: true });
  writeJson(path.join(base, "pedido.json"), metadata);
  fs.writeFileSync(path.join(base, "status.txt"), `${metadata.status || "novo"}\n`, "utf8");
  return base;
}

function syntheticActiveClient(cycle) {
  return {
    plano: "profissional",
    plano_atual: "profissional",
    plano_status: "active",
    plano_nome: "Profissional sintético",
    plano_ciclo: cycle,
    plano_renova_em: "2099-12-31T23:59:59.000Z",
    materiais_graficos_ciclo: cycle,
    materiais_graficos_criados: {}
  };
}

function writeMaterialRequest({
  baseDir,
  ownerDirectory,
  owner,
  cycle,
  documentId,
  materialId
}) {
  const requestDir = path.join(baseDir, ownerDirectory, cycle, documentId);
  fs.mkdirSync(requestDir, { recursive: true });
  writeJson(path.join(requestDir, "solicitacao.json"), {
    id: documentId,
    document_id: documentId,
    tipo: "material_grafico_empresa",
    material_id: materialId,
    title: materialId,
    status: "novo",
    whatsapp: owner,
    ciclo: cycle,
    criado_em: "2099-08-01T12:00:00.000Z"
  });
  fs.writeFileSync(path.join(requestDir, "status.txt"), "novo\n", "utf8");
}

function materialStatus(payload, materialId) {
  return payload.materiais.find((material) => material.id === materialId)?.status;
}

function directoryDigest(root) {
  const entries = [];

  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(root, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        entries.push({ type: "directory", path: relativePath });
        walk(fullPath);
        continue;
      }

      const content = fs.readFileSync(fullPath);
      entries.push({
        type: "file",
        path: relativePath,
        size: content.length,
        sha256: crypto.createHash("sha256").update(content).digest("hex")
      });
    }
  }

  walk(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

test("pedido com metadata de outra empresa é recusado em todas as buscas", (t) => {
  const ordersRoot = temporaryDirectory(t, "ia4tube-order-owner-mismatch-");
  const orderId = "pedido-com-owner-divergente";

  writeOrder(ordersRoot, "empresa-a", "2026-07", orderId, {
    id: orderId,
    whatsapp: "empresa-b",
    status: "novo"
  });

  assert.equal(orderStorage.getPedidoBase(ordersRoot, "empresa-a", orderId), null);
  assert.deepEqual(orderStorage.listPedidoBasesByWhatsapp(ordersRoot, "empresa-a"), []);
  assert.deepEqual(orderStorage.findPedidoBasesGlobal(ordersRoot, orderId), []);
  assert.equal(orderStorage.getPedidoBaseGlobal(ordersRoot, orderId), null);
});

test("tenant.one e tenant_one mantêm materiais gráficos isolados", (t) => {
  const materialsRoot = temporaryDirectory(t, "ia4tube-material-tenant-collision-");
  const cycle = "2099-08";

  writeMaterialRequest({
    baseDir: materialsRoot,
    ownerDirectory: "tenant.one",
    owner: "tenant.one",
    cycle,
    documentId: "documento-tenant-dot",
    materialId: "planejamento_semanal"
  });
  writeMaterialRequest({
    baseDir: materialsRoot,
    ownerDirectory: "tenant_one",
    owner: "tenant_one",
    cycle,
    documentId: "documento-tenant-underscore",
    materialId: "planejamento_mensal"
  });

  const dotPayload = materialsService.publicListPayload({
    cliente: syntheticActiveClient(cycle),
    ramo: "Pizzaria",
    baseDir: materialsRoot,
    whatsapp: "tenant.one"
  });
  const underscorePayload = materialsService.publicListPayload({
    cliente: syntheticActiveClient(cycle),
    ramo: "Pizzaria",
    baseDir: materialsRoot,
    whatsapp: "tenant_one"
  });

  assert.equal(materialStatus(dotPayload, "planejamento_semanal"), "processing");
  assert.equal(materialStatus(dotPayload, "planejamento_mensal"), "available");
  assert.equal(materialStatus(underscorePayload, "planejamento_semanal"), "available");
  assert.equal(materialStatus(underscorePayload, "planejamento_mensal"), "processing");
});

test("logins longos com o mesmo prefixo não compartilham planejamentos", (t) => {
  const planningRoot = temporaryDirectory(t, "ia4tube-planning-long-tenant-");
  const sharedPrefix = "tenant".repeat(17).slice(0, 100);
  const ownerA = `${sharedPrefix}a`;
  const ownerB = `${sharedPrefix}b`;
  const planningId = "planning-only-b";
  const legacyCollisionDir = path.join(
    planningRoot,
    sharedPrefix,
    "2099-08",
    planningId
  );

  writeJson(path.join(legacyCollisionDir, "solicitacao.json"), {
    id: planningId,
    planejamento_id: planningId,
    tipo: "planejamento_mensal",
    whatsapp: ownerB,
    ciclo: "2099-08",
    status: "pronto",
    criado_em: "2099-08-01T12:00:00.000Z"
  });
  writeJson(path.join(legacyCollisionDir, "plano_mensal.json"), {
    planejamento_id: planningId,
    postagens: []
  });
  fs.writeFileSync(path.join(legacyCollisionDir, "status.txt"), "pronto\n", "utf8");

  assert.deepEqual(
    planningService.listClientPlannings({
      baseDir: planningRoot,
      whatsapp: ownerA
    }).planejamentos,
    []
  );
  assert.equal(
    planningService.listClientPlannings({
      baseDir: planningRoot,
      whatsapp: ownerB
    }).planejamentos.length,
    1
  );
});

test("filas privilegiadas ignoram material e planejamento sob pasta de outro owner", (t) => {
  const root = temporaryDirectory(t, "ia4tube-privileged-misplaced-");
  const materialsRoot = path.join(root, "materials");
  const planningRoot = path.join(root, "planning");
  const cycle = "2099-08";

  writeMaterialRequest({
    baseDir: materialsRoot,
    ownerDirectory: "empresa-a",
    owner: "empresa-b",
    cycle,
    documentId: "documento-misplaced",
    materialId: "planejamento_semanal"
  });
  assert.equal(materialsService.findRequestByDocument({
    baseDir: materialsRoot,
    documentId: "documento-misplaced"
  }), null);
  assert.deepEqual(materialsService.listBotPending({ baseDir: materialsRoot }), []);

  const planningDir = path.join(
    planningRoot,
    "empresa-a",
    cycle,
    "planning-misplaced"
  );
  writeJson(path.join(planningDir, "solicitacao.json"), {
    id: "planning-misplaced",
    planejamento_id: "planning-misplaced",
    tipo: "planejamento_mensal",
    whatsapp: "empresa-b",
    ciclo: cycle,
    status: "em_analise",
    criado_em: "2099-08-01T12:00:00.000Z",
    runner_contract: { pronto_para_runner: true }
  });
  fs.writeFileSync(path.join(planningDir, "status.txt"), "em_analise\n", "utf8");

  assert.equal(planningService.findPlanningByIdAny({
    baseDir: planningRoot,
    planningId: "planning-misplaced"
  }), null);
  assert.deepEqual(
    planningService.listBotPending({
      baseDir: planningRoot,
      claim: false
    }).planejamentos,
    []
  );
});

test("planejamento de A não lê nem altera pedido referenciado de B", (t) => {
  const root = temporaryDirectory(t, "ia4tube-planning-cross-tenant-");
  const planningRoot = path.join(root, "planning");
  const ordersRoot = path.join(root, "orders");
  const planningId = "planning-a";
  const planningItemId = "planning-a-item-001";
  const orderId = "pedido-b";
  const planningDir = path.join(planningRoot, "empresa-a", "2099-08", planningId);
  const orderBDir = writeOrder(ordersRoot, "empresa-b", "2099-08", orderId, {
    id: orderId,
    whatsapp: "empresa-b",
    status: "processando",
    planejamento_id: planningId,
    planejamento_item_id: planningItemId,
    descricao_instagram: "conteúdo privado da empresa B",
    data_sugerida: "2099-08-10",
    horario_sugerido: "09:00"
  });

  fs.writeFileSync(path.join(orderBDir, "resultado_final.png"), "imagem sintética B", "utf8");
  fs.mkdirSync(planningDir, { recursive: true });
  writeJson(path.join(planningDir, "solicitacao.json"), {
    id: planningId,
    planejamento_id: planningId,
    tipo: "planejamento_mensal",
    whatsapp: "empresa-a",
    ciclo: "2099-08",
    status: "pronto",
    quantidade_reservada: 1,
    criado_em: "2099-08-01T12:00:00.000Z"
  });
  writeJson(path.join(planningDir, "plano_mensal.json"), {
    planejamento_id: planningId,
    postagens: [{
      ordem: 1,
      planejamento_item_id: planningItemId,
      pedido_id: orderId,
      tema: "Tema sintético A",
      data_sugerida: "2099-08-10",
      horario_sugerido: "09:00"
    }]
  });
  writeJson(path.join(planningDir, "pedidos_criados.json"), {
    planejamento_id: planningId,
    pedidos: [{
      pedido_id: orderId,
      planejamento_item_id: planningItemId,
      ordem: 1
    }]
  });
  fs.writeFileSync(path.join(planningDir, "status.txt"), "pronto\n", "utf8");
  fs.writeFileSync(path.join(planningDir, "runner_log.txt"), "", "utf8");

  const before = directoryDigest(orderBDir);
  const detail = planningService.publicDetailPayload({
    baseDir: planningRoot,
    whatsapp: "empresa-a",
    planningId,
    pedidosDir: ordersRoot
  });
  const post = detail.planejamento.plano_mensal.postagens[0];

  assert.equal(post.pedido_id, orderId);
  assert.equal(post.status, "planejada");
  assert.equal(post.status_label, "Planejada");
  assert.equal(post.imagem_pronta, false);
  assert.equal(post.descricao_instagram, "");

  const rescheduled = planningService.rescheduleClientPlanningCalendarItem({
    baseDir: planningRoot,
    whatsapp: "empresa-a",
    pedidosDir: ordersRoot,
    planningId,
    planejamentoItemId: planningItemId,
    pedidoId: orderId,
    date: "2099-08-11",
    time: "10:00"
  });

  assert.equal(rescheduled.ok, true);
  assert.equal(rescheduled.pedido_atualizado, false);
  assert.deepEqual(directoryDigest(orderBDir), before);

  const detailAfter = planningService.publicDetailPayload({
    baseDir: planningRoot,
    whatsapp: "empresa-a",
    planningId,
    pedidosDir: ordersRoot
  });
  const postAfter = detailAfter.planejamento.plano_mensal.postagens[0];
  assert.equal(postAfter.status, "planejada");
  assert.equal(postAfter.imagem_pronta, false);
  assert.equal(postAfter.descricao_instagram, "");
});
