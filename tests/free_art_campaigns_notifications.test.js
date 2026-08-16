const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const service = require("../src/admin-free-art-campaigns/free-art-campaigns.service");
const scheduler = require("../src/admin-free-art-campaigns/free-art-campaigns.scheduler");

const TEMP_CLEANUP_FAILURE_CODE = "test_temp_cleanup_failed";
const trackedTempDirectories = [];
const REPO_ROOT = path.resolve(__dirname, "..");

function hasPhysicalIdentity(stats) {
  return stats.dev !== 0n || stats.ino !== 0n;
}

function matchesPhysicalIdentity(stats, dev, ino) {
  return hasPhysicalIdentity(stats) && stats.dev === dev && stats.ino === ino;
}

function containsPath(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function overlapsWorktree(directory) {
  const physicalRepoRoot = fs.realpathSync(REPO_ROOT);
  const physicalDirectory = fs.realpathSync(directory);
  return containsPath(physicalRepoRoot, physicalDirectory) ||
    containsPath(physicalDirectory, physicalRepoRoot);
}

function registerTempDirectory(directory) {
  const record = { directory };
  trackedTempDirectories.push(record);

  try {
    const tempStats = fs.lstatSync(os.tmpdir(), { bigint: true });
    const parentStats = fs.lstatSync(path.dirname(directory), { bigint: true });
    const directoryStats = fs.lstatSync(directory, { bigint: true });
    if (
      !tempStats.isDirectory() ||
      tempStats.isSymbolicLink() ||
      !parentStats.isDirectory() ||
      parentStats.isSymbolicLink() ||
      !directoryStats.isDirectory() ||
      directoryStats.isSymbolicLink() ||
      !matchesPhysicalIdentity(parentStats, tempStats.dev, tempStats.ino) ||
      !hasPhysicalIdentity(directoryStats) ||
      overlapsWorktree(directory)
    ) {
      throw new Error(TEMP_CLEANUP_FAILURE_CODE);
    }
    record.tempDev = tempStats.dev;
    record.tempIno = tempStats.ino;
    record.directoryDev = directoryStats.dev;
    record.directoryIno = directoryStats.ino;
  } catch {
    throw new Error(TEMP_CLEANUP_FAILURE_CODE);
  }

  return directory;
}

function assertNoReparseEntries(directory) {
  for (const name of fs.readdirSync(directory)) {
    const child = path.join(directory, name);
    const stats = fs.lstatSync(child, { bigint: true });
    if (stats.isSymbolicLink()) {
      throw new Error(TEMP_CLEANUP_FAILURE_CODE);
    }
    if (stats.isDirectory()) {
      assertNoReparseEntries(child);
    }
  }
}

function removeTrackedTempDirectory(record) {
  const tempStats = fs.lstatSync(os.tmpdir(), { bigint: true });
  const parentStats = fs.lstatSync(path.dirname(record.directory), { bigint: true });
  const directoryStats = fs.lstatSync(record.directory, { bigint: true });
  if (
    !tempStats.isDirectory() ||
    tempStats.isSymbolicLink() ||
    !parentStats.isDirectory() ||
    parentStats.isSymbolicLink() ||
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    !matchesPhysicalIdentity(tempStats, record.tempDev, record.tempIno) ||
    !matchesPhysicalIdentity(parentStats, record.tempDev, record.tempIno) ||
    !matchesPhysicalIdentity(directoryStats, record.directoryDev, record.directoryIno)
  ) {
    throw new Error(TEMP_CLEANUP_FAILURE_CODE);
  }
  assertNoReparseEntries(record.directory);
  if (overlapsWorktree(record.directory)) {
    throw new Error(TEMP_CLEANUP_FAILURE_CODE);
  }
  fs.rmSync(record.directory, { recursive: true, force: false });
  if (fs.existsSync(record.directory)) {
    throw new Error(TEMP_CLEANUP_FAILURE_CODE);
  }
}

function finishTempCleanup(hasPrimaryFailure) {
  let cleanupFailed = false;
  while (trackedTempDirectories.length > 0) {
    const record = trackedTempDirectories.pop();
    try {
      removeTrackedTempDirectory(record);
    } catch {
      cleanupFailed = true;
    }
  }
  if (!cleanupFailed) {
    return;
  }
  if (hasPrimaryFailure) {
    console.error(TEMP_CLEANUP_FAILURE_CODE);
    return;
  }
  throw new Error(TEMP_CLEANUP_FAILURE_CODE);
}

function tempRoot() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-free-art-notifications-"));
  return registerTempDirectory(directory);
}

function writeOrder(pedidosDir, whatsapp, id, ramo) {
  const base = path.join(pedidosDir, whatsapp, "2026-02", id);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "pedido.json"), JSON.stringify({
    whatsapp,
    origem: "planejamento_mensal",
    planejamento_id: `pm_${id}`,
    planejamento_item_id: "item1",
    ramo,
    criado_em: "2026-02-01T10:00:00Z",
    status: "pronto"
  }, null, 2), "utf8");
}

function readyArt(baseDir, campaignId, artId) {
  const uploadDir = tempRoot();
  const uploadPath = path.join(uploadDir, `${artId}.png`);
  fs.writeFileSync(uploadPath, "fake-image");
  service.saveArtResult({
    baseDir,
    campaignId,
    artId,
    resultFile: { path: uploadPath },
    descricaoInstagram: "Legenda"
  });
  service.approveArt({ baseDir, campaignId, artId, adminId: "admin" });
}

async function testDueNotificationsAreIdempotent() {
  const root = tempRoot();
  const baseDir = path.join(root, "campanhas");
  const pedidosDir = path.join(root, "pedidos");
  const clientes = {
    c1: { ativo: true, notificacoes: { fcm_tokens: [{ token: "t1", ativo: true }] } },
    c2: { ativo: true, notificacoes: { fcm_tokens: [{ token: "t2", ativo: true }] } }
  };
  writeOrder(pedidosDir, "c1", "20260201_100000", "Padaria");
  writeOrder(pedidosDir, "c2", "20260201_110000", "Padaria");

  const created = service.createCampaign({
    baseDir,
    pedidosDir,
    clientes,
    body: {
      ramo: "Padaria",
      quantidade: 1,
      data_postagem: "2026-01-01",
      horario: "18:00",
      notificacao_titulo: "Arte Gratis",
      notificacao_mensagem: "Toque para ver"
    },
    adminId: "admin",
    maxArts: 20
  });
  readyArt(baseDir, created.campaign.id, "art_01");
  service.distributeCampaign({ baseDir, pedidosDir, campaignId: created.campaign.id, adminId: "admin" });

  const sentPayloads = [];
  const first = await scheduler.processDueNotifications({
    baseDir,
    pedidosDir,
    clientes,
    now: new Date("2026-01-01T22:00:00Z"),
    sendNotification: async ({ cliente, campaign, assignment }) => {
      sentPayloads.push({ cliente, campaignId: campaign.id, pedidoId: assignment.pedido_id });
      return { ok: true, sent: 1, mock: true };
    }
  });

  assert.strictEqual(first.sent, 2);
  assert.strictEqual(first.mock, 2);
  assert.strictEqual(sentPayloads.length, 2);

  const second = await scheduler.processDueNotifications({
    baseDir,
    pedidosDir,
    clientes,
    now: new Date("2026-01-01T22:05:00Z"),
    sendNotification: async () => {
      throw new Error("nao deveria reenviar");
    }
  });

  assert.strictEqual(second.sent, 0);
  assert.strictEqual(second.errors, 0);
}

async function run() {
  let hasPrimaryFailure = false;
  try {
    await testDueNotificationsAreIdempotent();
  } catch (error) {
    hasPrimaryFailure = true;
    throw error;
  } finally {
    finishTempCleanup(hasPrimaryFailure);
  }
}

run()
  .then(() => console.log("free_art_campaigns_notifications.test.js ok"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
