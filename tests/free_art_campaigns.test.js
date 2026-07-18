const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const service = require("../src/admin-free-art-campaigns/free-art-campaigns.service");
const storage = require("../src/admin-free-art-campaigns/free-art-campaigns.storage");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-free-art-"));
}

function writeOrder(pedidosDir, whatsapp, month, id, pedido) {
  const base = path.join(pedidosDir, whatsapp, month, id);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "pedido.json"), JSON.stringify(pedido, null, 2), "utf8");
  fs.writeFileSync(path.join(base, "status.txt"), pedido.status || "pronto", "utf8");
  return base;
}

function clientesFixture() {
  return {
    c1: {
      nome_time: "Cliente 1",
      ativo: true,
      saldo_mensal: 3,
      saldo_extra: 2,
      usados_no_ciclo: 1,
      arte_gratis_usada: false
    },
    c2: {
      nome_time: "Cliente 2",
      ativo: true,
      saldo_mensal: 10,
      saldo_extra: 0,
      usados_no_ciclo: 0,
      arte_gratis_usada: true
    },
    c3: {
      nome_time: "Sem ramo",
      ativo: true,
      saldo_mensal: 5,
      saldo_extra: 0,
      usados_no_ciclo: 0
    }
  };
}

function selectedClientesFixture() {
  return {
    "5511991111111": {
      nome_time: "Ana Padaria",
      ativo: true,
      saldo_mensal: 4,
      saldo_extra: 1,
      usados_no_ciclo: 2,
      arte_gratis_usada: false
    },
    "5511992222222": {
      nome_time: "Bruno Paes",
      ativo: true,
      saldo_mensal: 7,
      saldo_extra: 0,
      usados_no_ciclo: 1,
      arte_gratis_usada: true
    },
    "5511993333333": {
      nome_time: "Carla Confeitaria",
      ativo: true,
      saldo_mensal: 2,
      saldo_extra: 3,
      usados_no_ciclo: 0,
      arte_gratis_usada: false
    },
    "5511984444444": {
      nome_time: "Davi Hamburgueria",
      ativo: true,
      saldo_mensal: 9,
      saldo_extra: 0,
      usados_no_ciclo: 0,
      arte_gratis_usada: true
    }
  };
}

function selectedFixtureContext() {
  const root = tempRoot();
  const baseDir = path.join(root, "campanhas");
  const pedidosDir = path.join(root, "pedidos");
  const clientes = selectedClientesFixture();
  const branches = {
    "5511991111111": "Padaria",
    "5511992222222": "Padaria",
    "5511993333333": "Padaria",
    "5511984444444": "Hamburgueria"
  };

  Object.entries(branches).forEach(([whatsapp, ramo], index) => {
    writeOrder(pedidosDir, whatsapp, "2026-06", `202606${String(index + 1).padStart(2, "0")}_100000`, {
      origem: "planejamento_mensal",
      planejamento_id: `pm_${index + 1}`,
      planejamento_item_id: "item1",
      ramo,
      criado_em: `2026-06-${String(index + 1).padStart(2, "0")}T10:00:00Z`,
      status: "pronto"
    });
  });

  return { root, baseDir, pedidosDir, clientes };
}

function createFixtureCampaign(context, body = {}) {
  return service.createCampaign({
    baseDir: context.baseDir,
    pedidosDir: context.pedidosDir,
    clientes: context.clientes,
    body: {
      ramo: "Padaria",
      quantidade: 2,
      data_postagem: "2026-07-20",
      horario: "18:00",
      notificacao_titulo: "Titulo de teste",
      notificacao_mensagem: "Mensagem de teste",
      ...body
    },
    adminId: "admin-test",
    maxArts: 20
  });
}

function assertThrowsCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

function createReadyArt(baseDir, campaignId, artId) {
  const uploadPath = path.join(tempRoot(), `${artId}.png`);
  fs.writeFileSync(uploadPath, "fake-image");
  service.saveArtResult({
    baseDir,
    campaignId,
    artId,
    resultFile: { path: uploadPath },
    descricaoInstagram: "Legenda pronta"
  });
  service.approveArt({ baseDir, campaignId, artId, adminId: "admin" });
}

function testClassifierUsesOnlyOwnIdentifiers() {
  assert.strictEqual(service.isFreeArtOrder({ origem: "arte_gratis_semanal" }), true);
  assert.strictEqual(service.isFreeArtOrder({ campaign_id: "free_20260717_padaria_ab12cd" }), true);
  assert.strictEqual(service.isFreeArtOrder({ gratuita_administrativa: true }), false);
  assert.strictEqual(service.isFreeArtOrder({ bloquear_cobranca: true }), false);
  assert.strictEqual(service.isFreeArtOrder({ origem: "pedido", campaign_id: "campanha_comercial_1" }), false);
}

function testBranchScanUsesLatestPlanningBeforeCompanyArt() {
  const root = tempRoot();
  const pedidosDir = path.join(root, "pedidos");
  const clientes = clientesFixture();

  writeOrder(pedidosDir, "c1", "2026-01", "20260101_100000", {
    categoria: "arte_empresa",
    product_id: "arte_empresa",
    ramo: "Hamburgueria",
    criado_em: "2026-01-01T10:00:00Z",
    status: "pronto"
  });
  writeOrder(pedidosDir, "c1", "2026-02", "20260201_100000", {
    origem: "planejamento_mensal",
    planejamento_id: "pm1",
    planejamento_item_id: "item1",
    ramo: "Padaria",
    criado_em: "2026-02-01T10:00:00Z",
    status: "pronto"
  });
  writeOrder(pedidosDir, "c2", "2026-03", "20260301_100000", {
    categoria: "arte_empresa",
    product_id: "arte_empresa",
    ramo: "HAMBURGUERIA",
    criado_em: "2026-03-01T10:00:00Z",
    status: "pronto"
  });

  const scan = service.scanClientBranches({ pedidosDir, clientes });
  const branches = Object.fromEntries(scan.ramos.map((item) => [item.ramo_normalizado, item.clientes]));

  assert.strictEqual(branches.padaria, 1);
  assert.strictEqual(branches.hamburgueria, 1);
  assert.strictEqual(scan.clientes_sem_ramo_identificado, 1);
}

function testCreateAndDistributeDoesNotMutateBilling() {
  const root = tempRoot();
  const baseDir = path.join(root, "campanhas");
  const pedidosDir = path.join(root, "pedidos");
  const clientes = clientesFixture();
  const before = JSON.stringify(clientes);

  writeOrder(pedidosDir, "c1", "2026-02", "20260201_100000", {
    origem: "planejamento_mensal",
    planejamento_id: "pm1",
    planejamento_item_id: "item1",
    ramo: "Padaria",
    criado_em: "2026-02-01T10:00:00Z",
    status: "pronto"
  });
  writeOrder(pedidosDir, "c2", "2026-02", "20260201_110000", {
    origem: "planejamento_mensal",
    planejamento_id: "pm2",
    planejamento_item_id: "item1",
    ramo: "padaria",
    criado_em: "2026-02-01T11:00:00Z",
    status: "pronto"
  });

  const created = service.createCampaign({
    baseDir,
    pedidosDir,
    clientes,
    body: {
      ramo: "PADARIA",
      quantidade: 2,
      data_postagem: "2026-07-20",
      horario: "18:00",
      notificacao_titulo: "Titulo",
      notificacao_mensagem: "Mensagem"
    },
    adminId: "admin",
    maxArts: 20
  });
  const campaignId = created.campaign.id;
  createReadyArt(baseDir, campaignId, "art_01");
  createReadyArt(baseDir, campaignId, "art_02");

  const preview = service.buildDistributionPreview({ baseDir, campaignId });
  assert.strictEqual(preview.clientes, 2);
  assert.strictEqual(preview.artes_aprovadas, 2);

  const distributed = service.distributeCampaign({ baseDir, pedidosDir, campaignId, adminId: "admin" });
  assert.strictEqual(distributed.distribuicao.length, 2);
  assert.strictEqual(JSON.stringify(clientes), before);

  for (const assignment of distributed.distribuicao) {
    const pedidoPath = path.join(pedidosDir, assignment.whatsapp, assignment.mes, assignment.pedido_id, "pedido.json");
    const pedido = storage.readJson(pedidoPath, {});
    assert.strictEqual(pedido.origem, "arte_gratis_semanal");
    assert.strictEqual(pedido.gratuita_administrativa, true);
    assert.strictEqual(pedido.bloquear_cobranca, true);
    assert.strictEqual(pedido.bloquear_edicao, true);
    assert.strictEqual(pedido.pagamento_pendente, false);
    assert.strictEqual(pedido.valor_cobrado, 0);
    assert.strictEqual(fs.existsSync(path.join(path.dirname(pedidoPath), "resultado_final.png")), true);
  }

  assert.throws(() => service.distributeCampaign({ baseDir, pedidosDir, campaignId, adminId: "admin" }), /distribuida/);
  assert.throws(() => service.buildDistributionPreview({ baseDir, campaignId }), /distribuida/);
  assert.throws(() => service.updateCampaignSettings({
    baseDir,
    campaignId,
    body: { data_postagem: "2026-07-21" },
    adminId: "admin"
  }), /distribuida/);
  assert.throws(() => service.approveArt({ baseDir, campaignId, artId: "art_01", adminId: "admin" }), /distribuida/);
  assert.throws(() => service.excludeArt({ baseDir, campaignId, artId: "art_01", adminId: "admin" }), /distribuida/);
  assert.throws(() => service.regenerateArt({ baseDir, campaignId, artId: "art_01", adminId: "admin" }), /distribuida/);

  const duplicated = service.duplicateCampaign({
    baseDir,
    pedidosDir,
    clientes,
    campaignId,
    adminId: "admin",
    maxArts: 20
  });
  assert.notStrictEqual(duplicated.campaign.id, campaignId);
  assert.strictEqual(duplicated.duplicated_from, campaignId);
  assert.strictEqual(duplicated.campaign.status, "gerando");
  assert.strictEqual(duplicated.artes.length, 2);

  const calendar = service.listClientCalendar({ baseDir, pedidosDir, whatsapp: "c1" });
  assert.strictEqual(calendar.length, 1);
  assert.strictEqual(calendar[0].origem, "arte_gratis_semanal");
  assert.strictEqual(calendar[0].titulo, "Arte Gratis da Semana");
}

function testRecoverStuckGeneration() {
  const root = tempRoot();
  const baseDir = path.join(root, "campanhas");
  const pedidosDir = path.join(root, "pedidos");
  const clientes = clientesFixture();

  writeOrder(pedidosDir, "c1", "2026-02", "20260201_100000", {
    origem: "planejamento_mensal",
    planejamento_id: "pm1",
    planejamento_item_id: "item1",
    ramo: "Padaria",
    criado_em: "2026-02-01T10:00:00Z",
    status: "pronto"
  });

  const created = service.createCampaign({
    baseDir,
    pedidosDir,
    clientes,
    body: {
      ramo: "Padaria",
      quantidade: 1,
      data_postagem: "2026-07-20"
    },
    adminId: "admin",
    maxArts: 20
  });
  const campaignId = created.campaign.id;

  service.updateArtStatus({ baseDir, campaignId, artId: "art_01", status: "gerando" });
  let art = storage.readArt(baseDir, campaignId, "art_01");
  art.updated_at = "2026-07-17T10:00:00.000Z";
  storage.writeArt(baseDir, campaignId, art);

  const recoveredPending = service.recoverStuckGeneration({
    baseDir,
    timeoutMs: 60 * 1000,
    action: "pendente",
    now: new Date("2026-07-17T10:03:00.000Z")
  });
  assert.strictEqual(recoveredPending.recovered_count, 1);
  assert.strictEqual(storage.readArt(baseDir, campaignId, "art_01").status, "pendente");
  assert.strictEqual(service.listPendingArts({ baseDir }).artes.length, 1);

  service.updateArtStatus({ baseDir, campaignId, artId: "art_01", status: "gerando" });
  art = storage.readArt(baseDir, campaignId, "art_01");
  art.updated_at = "2026-07-17T10:00:00.000Z";
  storage.writeArt(baseDir, campaignId, art);

  const recoveredError = service.recoverStuckGeneration({
    baseDir,
    timeoutMs: 60 * 1000,
    action: "erro",
    now: new Date("2026-07-17T10:03:00.000Z")
  });
  assert.strictEqual(recoveredError.recovered_count, 1);
  assert.strictEqual(storage.readArt(baseDir, campaignId, "art_01").status, "erro");
}

function testInvalidQuantityAndRequiredDate() {
  const root = tempRoot();
  const baseDir = path.join(root, "campanhas");
  const pedidosDir = path.join(root, "pedidos");
  const clientes = clientesFixture();
  writeOrder(pedidosDir, "c1", "2026-02", "20260201_100000", {
    origem: "planejamento_mensal",
    planejamento_id: "pm1",
    planejamento_item_id: "item1",
    ramo: "Padaria",
    criado_em: "2026-02-01T10:00:00Z",
    status: "pronto"
  });

  assert.throws(() => service.createCampaign({
    baseDir,
    pedidosDir,
    clientes,
    body: { ramo: "Padaria", quantidade: 21, data_postagem: "2026-07-20" },
    maxArts: 20
  }), /Quantidade/);

  assert.throws(() => service.createCampaign({
    baseDir,
    pedidosDir,
    clientes,
    body: { ramo: "Padaria", quantidade: 1 },
    maxArts: 20
  }), /Data da postagem/);
}

function testDistributionModeTodosKeepsAllClients() {
  const context = selectedFixtureContext();
  const created = createFixtureCampaign(context, {
    distribution_mode: "todos",
    selected_whatsapps: ["5511991111111"]
  });

  assert.strictEqual(created.campaign.distribution_mode, "todos");
  assert.deepStrictEqual(created.campaign.selected_whatsapps, []);
  assert.deepStrictEqual(
    created.campaign.eligible_clients_snapshot.map((client) => client.whatsapp),
    ["5511991111111", "5511992222222", "5511993333333"]
  );
}

function testDistributionModeSelectedValidation() {
  const selectedContext = selectedFixtureContext();
  const created = createFixtureCampaign(selectedContext, {
    distribution_mode: "selecionados",
    selected_whatsapps: ["+55 (11) 99111-1111", "5511991111111"]
  });

  assert.strictEqual(created.campaign.distribution_mode, "selecionados");
  assert.deepStrictEqual(created.campaign.selected_whatsapps, ["5511991111111"]);
  assert.deepStrictEqual(
    created.campaign.eligible_clients_snapshot.map((client) => client.whatsapp),
    ["5511991111111"]
  );

  const validationContext = selectedFixtureContext();
  assertThrowsCode(() => createFixtureCampaign(validationContext, {
    distribution_mode: "selecionados",
    selected_whatsapps: []
  }), "selected_clients_required");
  assertThrowsCode(() => createFixtureCampaign(validationContext, {
    distribution_mode: "selecionados",
    selected_whatsapps: ["5511984444444"]
  }), "selected_client_not_eligible");
  assertThrowsCode(() => createFixtureCampaign(validationContext, {
    distribution_mode: "selecionados",
    selected_whatsapps: ["5511975555555"]
  }), "selected_client_not_eligible");
  assertThrowsCode(() => createFixtureCampaign(validationContext, {
    distribution_mode: "selecionados",
    selected_whatsapps: ["numero-invalido"]
  }), "invalid_selected_whatsapp");
  assertThrowsCode(() => createFixtureCampaign(validationContext, {
    distribution_mode: "percentual",
    selected_whatsapps: []
  }), "invalid_distribution_mode");
  assertThrowsCode(() => createFixtureCampaign(validationContext, {
    distribution_mode: "selecionados",
    selected_whatsapps: "5511991111111"
  }), "invalid_selected_whatsapps");
}

function testDetailedPreviewMatchesRealDistribution() {
  const context = selectedFixtureContext();
  const billingBefore = JSON.stringify(context.clientes);
  const created = createFixtureCampaign(context, {
    distribution_mode: "selecionados",
    selected_whatsapps: ["5511991111111", "5511993333333"]
  });
  const campaignId = created.campaign.id;
  createReadyArt(context.baseDir, campaignId, "art_01");
  createReadyArt(context.baseDir, campaignId, "art_02");

  const preview = service.buildDistributionPreview({ baseDir: context.baseDir, campaignId });
  const previewAssignments = preview.distribuicao_detalhada
    .flatMap((group) => group.clientes)
    .map((client) => [client.whatsapp, client.art_id])
    .sort((a, b) => a[0].localeCompare(b[0]));

  assert.strictEqual(preview.clientes, 2);
  assert.strictEqual(Object.values(preview.distribuicao_por_arte).reduce((sum, total) => sum + total, 0), 2);
  assert.strictEqual(previewAssignments.length, 2);
  assert(preview.distribuicao_detalhada.every((group) => group.clientes.every((client) => (
    client.nome && client.whatsapp && client.art_id === group.art_id
  ))));

  const distributed = service.distributeCampaign({
    baseDir: context.baseDir,
    pedidosDir: context.pedidosDir,
    campaignId,
    adminId: "admin-test"
  });
  const realAssignments = distributed.distribuicao
    .map((assignment) => [assignment.whatsapp, assignment.art_id])
    .sort((a, b) => a[0].localeCompare(b[0]));

  assert.deepStrictEqual(realAssignments, previewAssignments);
  assert.strictEqual(distributed.distribuicao.length, created.campaign.eligible_clients_snapshot.length);
  assert.strictEqual(distributed.distribuicao.some((assignment) => assignment.whatsapp === "5511992222222"), false);
  assert.strictEqual(JSON.stringify(context.clientes), billingBefore);
  distributed.distribuicao.forEach((assignment) => {
    assert.strictEqual(assignment.notificacao_status, "pendente");
    assert.strictEqual(assignment.notificacao_tentativas, 0);
    assert.strictEqual(Boolean(assignment.notificacao_enviada_em), false);
  });
}

function testLegacyCampaignWithoutDistributionFieldsStillWorks() {
  const context = selectedFixtureContext();
  const created = createFixtureCampaign(context, { quantidade: 1 });
  const campaignId = created.campaign.id;
  const legacyCampaign = storage.readCampaign(context.baseDir, campaignId);
  delete legacyCampaign.distribution_mode;
  delete legacyCampaign.selected_whatsapps;
  storage.writeCampaign(context.baseDir, legacyCampaign);
  createReadyArt(context.baseDir, campaignId, "art_01");

  const preview = service.buildDistributionPreview({ baseDir: context.baseDir, campaignId });
  assert.strictEqual(preview.clientes, 3);
  assert.strictEqual(preview.distribuicao_detalhada[0].clientes.length, 3);

  const distributed = service.distributeCampaign({
    baseDir: context.baseDir,
    pedidosDir: context.pedidosDir,
    campaignId,
    adminId: "admin-test"
  });
  assert.strictEqual(distributed.distribuicao.length, 3);
}

testClassifierUsesOnlyOwnIdentifiers();
testBranchScanUsesLatestPlanningBeforeCompanyArt();
testCreateAndDistributeDoesNotMutateBilling();
testRecoverStuckGeneration();
testInvalidQuantityAndRequiredDate();
testDistributionModeTodosKeepsAllClients();
testDistributionModeSelectedValidation();
testDetailedPreviewMatchesRealDistribution();
testLegacyCampaignWithoutDistributionFieldsStillWorks();
console.log("free_art_campaigns.test.js ok");
