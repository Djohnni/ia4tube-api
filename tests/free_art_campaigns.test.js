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

testClassifierUsesOnlyOwnIdentifiers();
testBranchScanUsesLatestPlanningBeforeCompanyArt();
testCreateAndDistributeDoesNotMutateBilling();
testRecoverStuckGeneration();
testInvalidQuantityAndRequiredDate();
console.log("free_art_campaigns.test.js ok");
