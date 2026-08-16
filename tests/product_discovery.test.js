const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const service = require("../src/company-monthly-planning/product-discovery.service");

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

function tempRoot(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return registerTempDirectory(directory);
}

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
  const dir = tempRoot("ia4tube-discovery-institutional-");
  const filePath = path.join(dir, "institutional.png");
  fs.writeFileSync(filePath, "fake-image");

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
}

function testPromptRejectsInstitutionalTextAndPrefersZeroItems() {
  const prompt = service._private.discoveryPrompt(36);
  assert.match(prompt, /nome da empresa/i);
  assert.match(prompt, /Moda Feminina/i);
  assert.match(prompt, /produtos=\[\]/i);
  assert.match(prompt, /melhor retornar zero produtos/i);
}

async function testOneImageStructuredRequest() {
  const dir = tempRoot("ia4tube-discovery-");
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
  let hasPrimaryFailure = false;
  try {
    testConservativeDeduplication();
    testUnsafeCropIsDisabled();
    testInstitutionalAndGenericLabelsAreDiscarded();
    testPromptRejectsInstitutionalTextAndPrefersZeroItems();
    await testInstitutionalOnlyResponseReturnsNoItems();
    await testOneImageStructuredRequest();
  } catch (error) {
    hasPrimaryFailure = true;
    throw error;
  } finally {
    finishTempCleanup(hasPrimaryFailure);
  }
  console.log("product_discovery.test.js: ok");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
