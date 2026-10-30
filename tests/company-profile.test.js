"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const express = require("express"), multer = require("multer"), sharp = require("sharp");
const { createCompanyProfileService } = require("../src/company-profile/service");
const { createCompanyProfileRouter } = require("../src/company-profile/router");
const { ownerHash, MAX_LOGO_BYTES, MAX_RECORD_BYTES, MAX_PROFILE_PART_BYTES } = require("../src/company-profile/model");
const editable = ["nome_empresa", "ramo", "whatsapp", "instagram", "facebook", "outros_links", "historia", "endereco", "cidade", "estado", "cep", "email", "site"];
const ownerA = "synthetic-company-owner-a", ownerB = "synthetic-company-owner-b";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-company-profile-test-")), dataDir = path.join(root, "data"), baseDir = path.join(dataDir, "company_profiles");
  fs.mkdirSync(path.join(dataDir, "pedidos"), { recursive: true });
  const canaries = [path.join(dataDir, "clientes.json"), path.join(dataDir, "pedidos", "synthetic.json"), path.join(dataDir, "social.json")];
  for (const file of canaries) fs.writeFileSync(file, '{"synthetic":"unchanged","artes":10,"videos":4}');
  const canaryBytes = canaries.map(file => fs.readFileSync(file));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  let now = Date.parse("2030-01-15T12:00:00Z");
  const service = createCompanyProfileService({ baseDir, clock: () => now });
  return { root, dataDir, baseDir, service, setNow(value) { now = value; },
    file: owner => path.join(baseDir, ownerHash(owner) + ".json"),
    canariesUnchanged() { canaries.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), canaryBytes[index])); } };
}

async function image(format = "png", width = 20, height = 10, background = { r: 200, g: 30, b: 50, alpha: 0.7 }) {
  return sharp({ create: { width, height, channels: 4, background } })[format]().toBuffer();
}

async function httpFixture(t) {
  const f = fixture(t), app = express();
  app.use("/company/profile", (req, _res, next) => {
    if (req.headers.authorization === "Bearer synthetic-a") req.user = { whatsapp: ownerA };
    if (req.headers.authorization === "Bearer synthetic-b") req.user = { whatsapp: ownerB };
    next();
  }, createCompanyProfileRouter({ baseDir: f.baseDir }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}/company/profile`;
  async function get(suffix = "", auth = "synthetic-a") { return fetch(origin + suffix, { headers: auth ? { authorization: "Bearer " + auth } : {} }); }
  async function put(profile = {}, options = {}) {
    const form = new FormData();
    form.append("profile", typeof profile === "string" ? profile : JSON.stringify(profile));
    if (options.remove !== undefined) form.append("remove_logo", options.remove);
    if (options.logo) form.append(options.fileField || "logo", new Blob([options.logo], { type: options.mime || "application/octet-stream" }), options.filename || "synthetic.bin");
    if (options.extra) for (const [field, value] of options.extra) form.append(field, value);
    return fetch(origin, { method: "PUT", body: form, headers: options.auth === null ? {} : { authorization: "Bearer " + (options.auth || "synthetic-a") } });
  }
  return { ...f, origin, get, put };
}

test("a missing optional profile is empty, with no storage allocation or account-phone fallback", t => {
  const f = fixture(t), result = f.service.get(ownerA);
  assert.deepEqual(Object.keys(result.profile).sort(), [...editable, "has_logo", "updated_at"].sort());
  for (const field of editable) assert.equal(result.profile[field], "");
  assert.equal(result.profile.has_logo, false); assert.equal(result.profile.updated_at, null);
  assert.equal(fs.existsSync(f.baseDir), false); f.canariesUnchanged();
});

test("all fields can remain optional and blank; absent patches preserve existing text", async t => {
  const f = fixture(t); await f.service.save(ownerA, { profile: {} });
  await f.service.save(ownerA, { profile: { nome_empresa: "  Loja sintetica  ", historia: "Primeira linha\nSegunda linha" } });
  const result = await f.service.save(ownerA, { profile: { ramo: "Comercio", historia: "" } });
  assert.equal(result.profile.nome_empresa, "Loja sintetica"); assert.equal(result.profile.ramo, "Comercio"); assert.equal(result.profile.historia, "");
  assert.equal(result.profile.updated_at, "2030-01-15T12:00:00.000Z"); f.canariesUnchanged();
});

test("the editable contact phone does not select another account or its logo", async t => {
  const f = fixture(t), png = await image();
  await f.service.save(ownerA, { profile: { whatsapp: ownerB, nome_empresa: "Owner A" }, logo: png });
  assert.equal(f.service.get(ownerA).profile.whatsapp, ownerB); assert.equal(f.service.get(ownerB).profile.nome_empresa, "");
  assert.throws(() => f.service.logo(ownerB), { code: "company_profile_logo_not_found" });
  const files = fs.readdirSync(f.baseDir); assert.equal(files.length, 1); assert.match(files[0], /^[a-f0-9]{64}\.json$/);
  assert.equal(files[0].includes(ownerA), false); assert.equal(files[0].includes(ownerB), false); f.canariesUnchanged();
});

for (const format of ["png", "jpeg", "webp"]) test(`a real ${format} logo is normalized into its own private PNG`, async t => {
  const f = fixture(t), bytes = await image(format, 1400, 700);
  const result = await f.service.save(ownerA, { profile: { nome_empresa: "Logo sintetico" }, logo: bytes });
  assert.equal(result.profile.has_logo, true);
  const normalized = f.service.logo(ownerA), metadata = await sharp(normalized).metadata();
  assert.equal(metadata.format, "png"); assert.equal(metadata.width, 1024); assert.equal(metadata.height, 512);
  const record = JSON.parse(fs.readFileSync(f.file(ownerA), "utf8"));
  assert.equal(record.logo.base64, normalized.toString("base64")); assert.equal(record.profile.nome_empresa, "Logo sintetico");
  assert.equal(record.accountHash, ownerHash(ownerA)); assert.equal(JSON.stringify(result).includes("base64"), false);
  assert.equal(JSON.stringify(result).includes(f.baseDir), false); f.canariesUnchanged();
});

test("orientation is applied and image metadata is removed", async t => {
  const f = fixture(t), bytes = await sharp(await image()).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  await f.service.save(ownerA, { profile: {}, logo: bytes }); const metadata = await sharp(f.service.logo(ownerA)).metadata();
  assert.equal(metadata.width, 10); assert.equal(metadata.height, 20); assert.equal(metadata.orientation, undefined); assert.equal(metadata.exif, undefined);
});

test("omitting the logo preserves it; explicit removal atomically keeps the text", async t => {
  const f = fixture(t); await f.service.save(ownerA, { profile: { cidade: "Cidade A" }, logo: await image() });
  const first = f.service.logo(ownerA); await f.service.save(ownerA, { profile: { cidade: "Cidade B" } });
  assert.deepEqual(f.service.logo(ownerA), first);
  const removed = await f.service.save(ownerA, { profile: {}, removeLogo: true });
  assert.equal(removed.profile.cidade, "Cidade B"); assert.equal(removed.profile.has_logo, false);
  assert.throws(() => f.service.logo(ownerA), { code: "company_profile_logo_not_found" });
});

test("a new logo and explicit removal cannot be submitted together", async t => {
  const f = fixture(t); await assert.rejects(f.service.save(ownerA, { profile: {}, logo: await image(), removeLogo: true }), { code: "company_profile_invalid" });
  assert.equal(fs.existsSync(f.baseDir), false);
});

test("same-owner concurrent logo and text saves preserve both updates across service instances", async t => {
  const f = fixture(t), second = createCompanyProfileService({ baseDir: f.baseDir }), png = await image("png", 1300, 900);
  await Promise.all([f.service.save(ownerA, { profile: { nome_empresa: "First request" }, logo: png }),
    second.save(ownerA, { profile: { cidade: "Second request" } })]);
  const result = f.service.get(ownerA).profile;
  assert.equal(result.nome_empresa, "First request"); assert.equal(result.cidade, "Second request"); assert.equal(result.has_logo, true);
  assert.equal((await sharp(f.service.logo(ownerA)).metadata()).width, 1024);
});

test("two concurrent avatar changes commit the second avatar with both text patches", async t => {
  const f = fixture(t), red = await image("png", 20, 10, "red"), blue = await image("png", 20, 10, "blue");
  await Promise.all([f.service.save(ownerA, { profile: { nome_empresa: "First" }, logo: red }),
    f.service.save(ownerA, { profile: { ramo: "Second" }, logo: blue })]);
  const result = f.service.get(ownerA).profile, pixels = await sharp(f.service.logo(ownerA)).removeAlpha().raw().toBuffer();
  assert.equal(result.nome_empresa, "First"); assert.equal(result.ramo, "Second"); assert.deepEqual([...pixels.subarray(0, 3)], [0, 0, 255]);
});

test("a failed atomic rename preserves the old text/avatar and a following save can recover", async t => {
  const f = fixture(t); await f.service.save(ownerA, { profile: { nome_empresa: "Before" }, logo: await image() });
  const before = fs.readFileSync(f.file(ownerA)), rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error("synthetic failure"), { code: "EIO" }); };
  try { await assert.rejects(f.service.save(ownerA, { profile: { nome_empresa: "After" }, removeLogo: true }), { code: "company_profile_unavailable" }); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(f.file(ownerA)), before); assert.equal(fs.readdirSync(f.baseDir).length, 1);
  await f.service.save(ownerA, { profile: { nome_empresa: "Recovered" } }); assert.equal(f.service.get(ownerA).profile.has_logo, true);
});

for (const profile of [null, [], { owner: ownerB }, { has_logo: true }, { updated_at: "2030-01-01" }, { nome_empresa: 1 },
  { historia: "x".repeat(4001) }, { outros_links: "x".repeat(4001) }, { site: "javascript:alert(1)" }, { site: "DATA:text/html,hi" },
  { instagram: "javascript :alert(1)" }, { facebook: "file:///private" }, { outros_links: "Site\njava\nscript:alert(1)" }, { nome_empresa: "bad\u0000name" }])
  test(`invalid optional input is rejected without allocating private files: ${Object.keys(profile || {}).join(",") || "shape"}`, async t => {
    const f = fixture(t); await assert.rejects(f.service.save(ownerA, { profile }), { code: "company_profile_invalid" }); assert.equal(fs.existsSync(f.baseDir), false);
  });

test("plain websites and Instagram handles remain optional text, without any link fetch", async t => {
  const f = fixture(t), original = global.fetch; global.fetch = () => { assert.fail("Profile must never fetch a supplied link"); };
  try { const result = await f.service.save(ownerA, { profile: { site: "www.synthetic.invalid", instagram: "@synthetic_shop",
    facebook: "https://www.synthetic.invalid/page", outros_links: "Catalogo: https://synthetic.invalid/catalogo" } });
    assert.equal(result.profile.site, "www.synthetic.invalid"); assert.equal(result.profile.instagram, "@synthetic_shop"); }
  finally { global.fetch = original; }
});

for (const logo of [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), Buffer.from("%PDF-fake"), Buffer.from([255, 216, 255]), Buffer.alloc(0)])
  test("unsupported or malformed image bytes cannot overwrite a profile", async t => {
    const f = fixture(t); await f.service.save(ownerA, { profile: { nome_empresa: "Keep" }, logo: await image() }); const before = fs.readFileSync(f.file(ownerA));
    await assert.rejects(f.service.save(ownerA, { profile: { nome_empresa: "Discard" }, logo }), { code: "company_profile_unsupported_logo" });
    assert.deepEqual(fs.readFileSync(f.file(ownerA)), before);
  });

test("the service independently rejects a logo larger than 5 MiB", async t => {
  const f = fixture(t); await assert.rejects(f.service.save(ownerA, { profile: {}, logo: Buffer.alloc(MAX_LOGO_BYTES + 1) }), { statusCode: 413 });
  assert.equal(fs.existsSync(f.baseDir), false);
});

test("a compressed PNG declaring more than 25 million pixels is rejected before a save", async t => {
  const f = fixture(t), bytes = Buffer.from(await image());
  bytes.writeUInt32BE(6000, 16); bytes.writeUInt32BE(6000, 20);
  let crc = 0xffffffff;
  for (const value of bytes.subarray(12, 29)) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
  await assert.rejects(f.service.save(ownerA, { profile: {}, logo: bytes }), { code: "company_profile_unsupported_logo" });
  assert.equal(fs.existsSync(f.baseDir), false);
});

test("the private record is not silently reset when its JSON is malformed", async t => {
  const f = fixture(t); await f.service.save(ownerA, { profile: { nome_empresa: "Before" } }); fs.writeFileSync(f.file(ownerA), "{");
  assert.throws(() => f.service.get(ownerA), { code: "company_profile_unavailable" });
  await assert.rejects(f.service.save(ownerA, { profile: {} }), { code: "company_profile_unavailable" }); assert.equal(fs.readFileSync(f.file(ownerA), "utf8"), "{");
});

test("corrupted logo bytes, oversized records and another account's record cannot be read", async t => {
  const f = fixture(t); await f.service.save(ownerA, { profile: {}, logo: await image() }); const original = fs.readFileSync(f.file(ownerA));
  const record = JSON.parse(original); record.logo.sha256 = "0".repeat(64); fs.writeFileSync(f.file(ownerA), JSON.stringify(record));
  assert.throws(() => f.service.logo(ownerA), { code: "company_profile_unavailable" });
  fs.writeFileSync(f.file(ownerA), Buffer.alloc(MAX_RECORD_BYTES + 1)); assert.throws(() => f.service.get(ownerA), { code: "company_profile_unavailable" });
  fs.writeFileSync(f.file(ownerB), original); assert.throws(() => f.service.get(ownerB), { code: "company_profile_unavailable" });
});

test("private profile reads refuse a hard link to a file outside the profile store", async t => {
  const f = fixture(t); await f.service.save(ownerA, { profile: {} }); const outside = path.join(f.root, "outside.json");
  fs.renameSync(f.file(ownerA), outside); fs.linkSync(outside, f.file(ownerA));
  assert.throws(() => f.service.get(ownerA), { code: "company_profile_unavailable" });
});

test("HTTP profile save and fresh authenticated logo reads remain isolated between accounts", async t => {
  const f = await httpFixture(t), before = await f.get(); assert.equal(before.status, 200); assert.equal((await before.json()).profile.updated_at, null);
  let response = await f.put({ nome_empresa: "Owner A", whatsapp: ownerB }, { logo: await image("jpeg"), mime: "image/svg+xml", filename: "misleading.svg" });
  assert.equal(response.status, 200); assert.equal((await response.json()).profile.has_logo, true);
  response = await f.get("/logo"); assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /^image\/png/);
  assert.match(response.headers.get("cache-control"), /private/); assert.match(response.headers.get("cache-control"), /no-store/);
  assert.match(response.headers.get("vary"), /Authorization/); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).format, "png");
  response = await f.get("", "synthetic-b"); assert.equal((await response.json()).profile.nome_empresa, "");
  response = await f.get("/logo", "synthetic-b"); assert.equal(response.status, 404); assert.match(response.headers.get("content-type"), /json/);
  response = await f.put({}, { remove: "true" }); assert.equal(response.status, 200); assert.equal((await response.json()).profile.has_logo, false);
  assert.equal((await f.get("/logo")).status, 404); f.canariesUnchanged();
});

test("unauthorized multipart requests never reach the memory-storage allocator", async t => {
  const f = await httpFixture(t), prototype = Object.getPrototypeOf(multer.memoryStorage()), original = prototype._handleFile;
  let allocations = 0; prototype._handleFile = function (...args) { allocations++; return original.apply(this, args); };
  try { const response = await f.put({}, { logo: await image(), auth: null }); assert.equal(response.status, 401); }
  finally { prototype._handleFile = original; }
  assert.equal(allocations, 0); assert.equal(fs.existsSync(f.baseDir), false); assert.equal((await f.get("/logo", null)).status, 401);
});

test("multipart byte and field-size limits return 413 without saving", async t => {
  const f = await httpFixture(t);
  let response = await f.put({}, { logo: Buffer.alloc(MAX_LOGO_BYTES + 1) }); assert.equal(response.status, 413);
  response = await f.put("x".repeat(MAX_PROFILE_PART_BYTES + 1)); assert.equal(response.status, 413); assert.equal(fs.existsSync(f.baseDir), false);
});

for (const variant of ["bad-json", "unknown-field", "wrong-file", "duplicate-profile", "false-remove", "logo-and-remove"])
  test(`malformed multipart ${variant} returns a bounded 400 response`, async t => {
    const f = await httpFixture(t), options = {}, profile = variant === "bad-json" ? "{" : {};
    if (variant === "unknown-field") options.extra = [["owner", ownerB]];
    if (variant === "wrong-file") { options.logo = await image(); options.fileField = "other-file"; }
    if (variant === "duplicate-profile") options.extra = [["profile", "{}"]];
    if (variant === "false-remove") options.remove = "false";
    if (variant === "logo-and-remove") { options.logo = await image(); options.remove = "true"; }
    const response = await f.put(profile, options); assert.equal(response.status, 400); assert.match((await response.json()).code, /^company_profile_/);
    assert.equal(fs.existsSync(f.baseDir), false);
  });

test("PUT requires multipart and private-storage failures do not expose paths", async t => {
  const f = await httpFixture(t);
  let response = await fetch(f.origin, { method: "PUT", headers: { authorization: "Bearer synthetic-a", "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 400);
  await f.service.save(ownerA, { profile: {} }); fs.writeFileSync(f.file(ownerA), "{");
  response = await f.get(); assert.equal(response.status, 503); const text = await response.text(); assert.equal(text.includes(f.root), false);
  assert.equal(text.includes("SyntaxError"), false); assert.equal(require.cache[path.join(__dirname, "../server.js")], undefined);
});
