const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const carouselService = require("../src/company-carousels/carousels.service");

function writeCarousel(baseDir, {
  owner,
  directoryOwner = owner,
  cycle = "2099-01",
  id,
  theme,
  ready = true
}) {
  const dirPath = path.join(baseDir, directoryOwner, cycle, id);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, "solicitacao.json"), JSON.stringify({
    id,
    carrossel_id: id,
    tipo: "carrossel_ia4tube",
    status: ready ? "pronto" : "pendente",
    whatsapp: owner,
    ciclo: cycle,
    criado_em: "2099-01-01T00:00:00.000Z",
    briefing: {
      tema: theme,
      quantidade_telas: 5,
      nivel_conteudo: 2
    }
  }, null, 2));
  fs.writeFileSync(path.join(dirPath, "status.txt"), `${ready ? "pronto" : "pendente"}\n`);
  if (ready) {
    fs.writeFileSync(path.join(dirPath, "resultado.zip"), `zip:${owner}:${theme}`);
  }
  return dirPath;
}

test("client lookups stay owner-scoped when two companies have the same carousel id", (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-carousel-tenants-"));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  const id = "car_20990101000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  writeCarousel(baseDir, {
    owner: "company-a",
    id,
    theme: "Tema exclusivo A"
  });
  writeCarousel(baseDir, {
    owner: "company-b",
    id,
    theme: "Tema exclusivo B"
  });

  const requestA = carouselService.findClientRequestById({
    baseDir,
    whatsapp: "company-a",
    carrosselId: id
  });
  const requestB = carouselService.findClientRequestById({
    baseDir,
    whatsapp: "company-b",
    carrosselId: id
  });

  assert.equal(requestA.briefing.tema, "Tema exclusivo A");
  assert.equal(requestB.briefing.tema, "Tema exclusivo B");
  assert.equal(
    carouselService.publicStatusPayload({
      baseDir,
      whatsapp: "company-a",
      carrosselId: id
    }).carrossel.tema,
    "Tema exclusivo A"
  );
  assert.equal(
    carouselService.publicStatusPayload({
      baseDir,
      whatsapp: "company-b",
      carrosselId: id
    }).carrossel.tema,
    "Tema exclusivo B"
  );

  const downloadA = carouselService.downloadForCarousel({
    baseDir,
    whatsapp: "company-a",
    carrosselId: id
  });
  const downloadB = carouselService.downloadForCarousel({
    baseDir,
    whatsapp: "company-b",
    carrosselId: id
  });
  assert.equal(fs.readFileSync(downloadA.filePath, "utf8"), "zip:company-a:Tema exclusivo A");
  assert.equal(fs.readFileSync(downloadB.filePath, "utf8"), "zip:company-b:Tema exclusivo B");

  assert.equal(
    carouselService.findRequestById({ baseDir, carrosselId: id }),
    null,
    "privileged global lookup must fail closed when a legacy id is ambiguous"
  );
  assert.throws(
    () => carouselService.publicStatusPayload({
      baseDir,
      whatsapp: "company-c",
      carrosselId: id
    }),
    (error) => error?.statusCode === 404
  );
});

test("owner metadata must match the owner directory before a request is returned", (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-carousel-owner-"));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  const id = "car_20990101000000_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  writeCarousel(baseDir, {
    owner: "company-b",
    directoryOwner: "company-a",
    id,
    theme: "Metadado adulterado"
  });

  assert.equal(carouselService.findClientRequestById({
    baseDir,
    whatsapp: "company-a",
    carrosselId: id
  }), null);
  assert.equal(carouselService.findClientRequestById({
    baseDir,
    whatsapp: "company-b",
    carrosselId: id
  }), null);
  assert.equal(carouselService.findRequestById({ baseDir, carrosselId: id }), null);
  assert.deepEqual(carouselService.listClientRequests({
    baseDir,
    whatsapp: "company-a"
  }), []);
  assert.deepEqual(
    carouselService.listBotPending({ baseDir }),
    [],
    "privileged queues must also reject metadata stored under another owner"
  );
});

test("long tenant identifiers with the same legacy prefix remain isolated", (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-carousel-long-owner-"));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  const sharedPrefix = "owner".repeat(20);
  const ownerA = `${sharedPrefix}a`;
  const ownerB = `${sharedPrefix}b`;
  const id = "car_20990101000000_cccccccccccccccccccccccccccccccc";
  writeCarousel(baseDir, {
    owner: ownerB,
    directoryOwner: sharedPrefix,
    id,
    theme: "Somente B"
  });

  assert.equal(carouselService.findClientRequestById({
    baseDir,
    whatsapp: ownerA,
    carrosselId: id
  }), null);
  assert.equal(
    carouselService.findClientRequestById({
      baseDir,
      whatsapp: ownerB,
      carrosselId: id
    }).briefing.tema,
    "Somente B"
  );
  assert.deepEqual(carouselService.listClientRequests({
    baseDir,
    whatsapp: ownerA
  }), []);
});

test("new carousel ids carry 128 bits of random entropy", (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-carousel-id-"));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  const client = {
    plano: "profissional",
    plano_atual: "profissional",
    plano_status: "active",
    plano_ciclo: "2099-01",
    plano_renova_em: "2099-02-01T00:00:00.000Z",
    carrosseis_ciclo: "2099-01",
    carrosseis_criados: {}
  };
  const created = carouselService.createRequest({
    baseDir,
    cliente: client,
    whatsapp: "company-a",
    body: { tema: "Entropia" }
  });

  assert.match(
    created.carrossel_id,
    /^car_\d{14}_[0-9a-f]{32}$/,
    "the random suffix must contain 16 bytes (32 hex characters)"
  );
});

test("privileged lookup fails closed when carousel storage does not exist", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-carousel-missing-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  assert.equal(
    carouselService.findRequestById({
      baseDir: path.join(tempRoot, "carrosseis"),
      carrosselId: "carrossel_missing"
    }),
    null
  );
});
