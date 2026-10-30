"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"),
  os = require("node:os"), crypto = require("node:crypto"), express = require("express");
const { createEditCalendarService } = require("../src/company-edit-calendar/service");
const { createEditCalendarRouter } = require("../src/company-edit-calendar/router");
const { createProductionSession } = require("../src/social/production-session");
const { atomicWriteJson } = require("../src/notifications/fcm-token-store");
const secret = "synthetic-availability-only-key-not-a-real-credential";
const owner = "synthetic-owner", other = "synthetic-other", externalId = "123456789012345";
const freeClient = { ativo: true, plano_status: "none", artes_mensais_restantes: 0, artes_avulsas_restantes: 0,
  arte_gratis_disponivel: false, arte_gratis_usada: false };
const healthy = { provider: "instagram", state: "connected", health: "healthy", accountType: "business", externalId };
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const ledgerKey = crypto.createHmac("sha256", secret).update("edit-free-image-ledger-v1").digest();
const fingerprint = (kind, value) => crypto.createHmac("sha256", ledgerKey).update(`${kind}\n${value}`).digest("hex");
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-availability-")), clientsFile = path.join(root, "clients.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  atomicWriteJson(clientsFile, { [owner]: { ...freeClient, ...options.client }, [other]: { ...freeClient, ...options.otherClient } });
  const now = Date.now(), calls = { writes: 0, prepare: 0, receipts: 0, observe: 0 };
  let connection = healthy, currentClients = () => JSON.parse(fs.readFileSync(clientsFile, "utf8"));
  const dependencies = { dataDir: root, planningDir: path.join(root, "planning"), ordersDir: path.join(root, "orders"), secret,
    admissionEnabled: true, clock: () => now, readClients: () => currentClients(),
    writeClients: () => { calls.writes++; throw new Error("observation attempted financial write"); },
    prepareCalendarRequest: () => { calls.prepare++; throw new Error("observation attempted context creation"); },
    recordFreeArtUse: () => { calls.receipts++; throw new Error("observation attempted a free-use receipt"); },
    observeConnection: async () => { calls.observe++; return connection; }, ...options };
  const service = createEditCalendarService(dependencies); t.after(() => service.close());
  const claims = { whatsapp: owner, sub: owner, company_id: owner, token_version: 2, iss: "ia4tube-api", aud: "ia4tube-client", jti: crypto.randomUUID() };
  const ledgerFile = path.join(root, "private/edit-calendar/free-image-ledger.json");
  function setLedger(owners = {}, instagram = {}) {
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    atomicWriteJson(ledgerFile, { schema: 1, keyId: sha(ledgerKey), owners, instagram });
  }
  return { root, clientsFile, ledgerFile, service, claims, calls, now, dependencies, setLedger,
    setConnection: value => { connection = value; }, setReader: value => { currentClients = value; } };
}
function financialDigest(client) {
  const fields = Object.keys(client).filter(key => /^(plano|artes_|arte_gratis|planejamento_mensal|ciclo_|usados_no_ciclo|saldo|ultimo_pagamento)/.test(key)).sort();
  return sha(JSON.stringify(fields.map(key => [key, client[key]])));
}
function tree(directory, relative = "") {
  return fs.readdirSync(directory).sort().flatMap(name => {
    const full = path.join(directory, name), item = path.join(relative, name), stat = fs.lstatSync(full);
    return stat.isDirectory() ? [{ path: item, directory: true, mtimeMs: stat.mtimeMs }, ...tree(full, item)]
      : [{ path: item, size: stat.size, mtimeMs: stat.mtimeMs, hash: sha(fs.readFileSync(full)) }];
  });
}
async function readOnly(f, action) {
  const before = tree(f.root), originalClient = JSON.parse(fs.readFileSync(f.clientsFile, "utf8")), digest = financialDigest(originalClient[owner]);
  const attempted = [], originals = new Map();
  for (const method of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync", "truncateSync", "chmodSync", "chownSync", "fsyncSync"]) {
    originals.set(method, fs[method]);
    fs[method] = (...args) => { attempted.push(method); throw new Error(`GET attempted ${method}`); };
  }
  const originalOpen = fs.openSync;
  fs.openSync = (file, flags, ...args) => {
    if (typeof flags === "string" ? /[wa+]/.test(flags) : (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0) {
      attempted.push("open-for-write"); throw new Error("GET attempted a writable file");
    }
    return originalOpen(file, flags, ...args);
  };
  let result;
  try { result = await action(); }
  finally { for (const [method, original] of originals) fs[method] = original; fs.openSync = originalOpen; }
  assert.deepEqual(attempted, [], "GET must not even attempt a filesystem mutation");
  assert.deepEqual(tree(f.root), before, "GET preserves file bytes, names, directories and timestamps");
  const actualClient = JSON.parse(fs.readFileSync(f.clientsFile, "utf8"));
  assert.deepEqual(actualClient, originalClient);
  assert.equal(financialDigest(actualClient[owner]), digest);
  assert.equal(f.calls.writes, 0); assert.equal(f.calls.prepare, 0); assert.equal(f.calls.receipts, 0);
  return result;
}
function expectHint(f, value, canImage, canVideo) {
  assert.deepEqual(value, { ok: true, availability: { schemaVersion: 1, canImage, canVideo, observedAt: f.now, validUntil: f.now + 30000 } });
  const text = JSON.stringify(value); for (const sensitive of [owner, externalId, "ticket", "token", "saldo", "remaining"])
    assert.equal(text.includes(sensitive), false, "only type hints and freshness reach the browser");
}
test("fresh zero-balance account sees the confirmed Instagram image without granting or creating a ledger", async t => {
  const f = fixture(t), before = fs.readFileSync(f.clientsFile, "utf8");
  expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), true, false);
  assert.equal(fs.existsSync(path.dirname(f.ledgerFile)), false); assert.equal(fs.readFileSync(f.clientsFile, "utf8"), before);
});
for (const client of [
  { plano_status: "active", plano_renova_em: "2099-01-01", artes_mensais_restantes: 1 },
  { artes_avulsas_restantes: 1 },
  { plano_status: "active", plano_renova_em: "2099-01-01", artes_mensais_restantes: 2, artes_avulsas_restantes: 3 }
]) test(`paid unit enables both types without reading Instagram ${JSON.stringify(client)}`, async t => {
  const f = fixture(t, { client }); expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), true, true);
  assert.equal(f.calls.observe, 0);
});
test("expired monthly units are not paid quota, and observing expiry never writes the cycle", async t => {
  const f = fixture(t, { client: { plano_status: "active", plano_renova_em: "2020-01-01", artes_mensais_restantes: 20, arte_gratis_usada: true } });
  expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), false, false);
});
test("a pending paid renewal is calculated on an ephemeral clone without activating it on disk", async t => {
  const f = fixture(t, { client: { plano_status: "past_due", plano_proximo_ciclo_pago: true, plano_proximo_ciclo_id: "i4_essencial",
    plano_proximo_ciclo_inicio_em: "2020-01-01", plano_proximo_ciclo_renova_em: "2099-01-01" } });
  expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), true, true); assert.equal(f.calls.observe, 0);
});
for (const client of [{ arte_gratis_usada: true }, { arte_gratis_pedido_id: "historical" }, { arte_gratis_usos: [{ pedido_id: "historical" }] }])
  test(`legacy consumed history is definitive without IG I/O ${Object.keys(client)[0]}`, async t => {
    const f = fixture(t, { client }); expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), false, false);
    assert.equal(f.calls.observe, 0);
  });
for (const connection of [null, { ...healthy, state: "disconnected" }, { ...healthy, health: "reconnect_required" },
  { ...healthy, accountType: "personal" }, { ...healthy, provider: "other" }, { ...healthy, externalId: "invalid" }])
  test(`unconfirmed Instagram cannot expose a gift ${JSON.stringify(connection)}`, async t => {
    const f = fixture(t); f.setConnection(connection); expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), false, false);
  });
test("Instagram read failure is unknown for image and exhausted for unpaid video", async t => {
  const f = fixture(t, { observeConnection: async () => { throw new Error("synthetic unavailable"); } });
  expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), null, false);
});
test("unavailable observation port is unknown, never fabricated exhaustion", async t => {
  const f = fixture(t, { observeConnection: null }); expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), null, false);
});
test("corrupt ledger returns unknown without repairing or replacing it", async t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.ledgerFile), { recursive: true }); fs.writeFileSync(f.ledgerFile, "{broken");
  expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), null, false);
});
test("ledger key mismatch is unknown without migrating the file", async t => {
  const f = fixture(t); f.setLedger(); const value = JSON.parse(fs.readFileSync(f.ledgerFile, "utf8")); value.keyId = "f".repeat(64); atomicWriteJson(f.ledgerFile, value);
  expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), null, false);
});
test("paid units remain available even when the gift ledger is corrupt and IG is unavailable", async t => {
  const f = fixture(t, { client: { artes_avulsas_restantes: 1 }, observeConnection: async () => { throw new Error("unexpected IG read"); } });
  fs.mkdirSync(path.dirname(f.ledgerFile), { recursive: true }); fs.writeFileSync(f.ledgerFile, "{broken");
  expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), true, true);
});
for (const state of ["reserved", "consumed", "legacy_consumed"]) test(`ledger ${state} does not expose a second image`, async t => {
  const f = fixture(t), ownerKey = fingerprint("owner", owner), instagramKey = fingerprint("instagram", externalId);
  f.setLedger({ [ownerKey]: { state, instagramKey, admissionId: crypto.randomUUID(), planningId: "existing" } }, { [instagramKey]: ownerKey });
  expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), false, false);
});
test("same Instagram bound to another product owner is not another available image", async t => {
  const f = fixture(t), instagramKey = fingerprint("instagram", externalId); f.setLedger({}, { [instagramKey]: fingerprint("owner", other) });
  expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), false, false);
});
test("an available restored right still cannot switch its confirmed Instagram identity", async t => {
  const f = fixture(t), ownerKey = fingerprint("owner", owner); f.setLedger({ [ownerKey]: { state: "available", instagramKey: fingerprint("instagram", "99999999999999") } });
  expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), false, false);
});
test("IP block denies a gift without touching its expiry or cleaning old locks", async t => {
  const f = fixture(t, { currentFreeArtBlocked: () => true });
  expectHint(f, await readOnly(f, () => f.service.availability(f.claims, { freeArtBlocked: true,
    ipIdentity: { ipHash: "a".repeat(64), ipMasked: "192.0.2.0" } })), false, false);
});
test("an owner's cancelled-IP exception is observed read-only and not granted to another receipt", async t => {
  const ipIdentity = { ipHash: "a".repeat(64), ipMasked: "192.0.2.0" }, planningId = "cancelled-reserve";
  const f = fixture(t, { currentFreeArtBlocked: () => true,
    canReuseCancelledFreeArt: value => value.owner === owner && value.planningId === planningId && value.ipIdentity.ipHash === ipIdentity.ipHash });
  const ownerKey = fingerprint("owner", owner), instagramKey = fingerprint("instagram", externalId);
  f.setLedger({ [ownerKey]: { state: "available", instagramKey, reusableIpHash: ipIdentity.ipHash, reusablePlanningId: planningId } }, { [instagramKey]: ownerKey });
  expectHint(f, await readOnly(f, () => f.service.availability(f.claims, { freeArtBlocked: true, ipIdentity })), true, false);
  expectHint(f, await readOnly(f, () => f.service.availability(f.claims, { freeArtBlocked: true,
    ipIdentity: { ...ipIdentity, ipHash: "b".repeat(64) } })), false, false);
});
test("observing another historical consumed account never lazily migrates a ledger", async t => {
  const f = fixture(t, { otherClient: { arte_gratis_usada: true, arte_gratis_usos: [{ pedido_id: "historical" }] } });
  expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), true, false); assert.equal(fs.existsSync(f.ledgerFile), false);
});
test("disabled admission is unknown and has no quota/gift side effects", async t => {
  const f = fixture(t, { admissionEnabled: false }); expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), null, null);
  assert.equal(f.calls.observe, 0);
});
test("global free-art feature off produces no gift or IG observation", async t => {
  const old = process.env.IA4TUBE_FREE_ART_ENABLED; process.env.IA4TUBE_FREE_ART_ENABLED = "false";
  try {
    const f = fixture(t); expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), false, false); assert.equal(f.calls.observe, 0);
  } finally { if (old === undefined) delete process.env.IA4TUBE_FREE_ART_ENABLED; else process.env.IA4TUBE_FREE_ART_ENABLED = old; }
});
test("invalid billing counts are unknown rather than a fabricated zero", async t => {
  const f = fixture(t, { client: { artes_avulsas_restantes: 0.5 } });
  expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), null, null);
});
test("credit changes during the IG read are observed before returning a hint", async t => {
  const f = fixture(t); let reads = 0;
  const baseline = JSON.parse(fs.readFileSync(f.clientsFile, "utf8"));
  f.setReader(() => { reads++; return reads === 1 ? structuredClone(baseline) : { ...structuredClone(baseline), [owner]: { ...baseline[owner], artes_avulsas_restantes: 1 } }; });
  expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), true, true);
});
test("a gift consumed during the IG read is not offered again by a stale client snapshot", async t => {
  const f = fixture(t); let reads = 0;
  const baseline = JSON.parse(fs.readFileSync(f.clientsFile, "utf8"));
  f.setReader(() => { reads++; return reads === 1 ? structuredClone(baseline)
    : { ...structuredClone(baseline), [owner]: { ...baseline[owner], arte_gratis_usada: true, arte_gratis_pedido_id: "just-reserved" } }; });
  expectHint(f, await readOnly(f, () => f.service.availability(f.claims)), false, false);
});
test("GET requires the owner's JWT and returns only no-store hints without a context", async t => {
  const f = fixture(t), session = createProductionSession({ secret, readClients: f.dependencies.readClients });
  const app = express(); app.use(createEditCalendarRouter({ authenticate: session.authenticate, availabilityAuthenticate: session.authenticate,
    botAuthenticate: (_req, res) => res.sendStatus(401), isBotAdmin: () => false, service: f.service }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/empresa/edit/availability`;
  assert.equal((await fetch(url)).status, 401);
  const token = session.sign(owner), response = await readOnly(f, () => fetch(url, { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  expectHint(f, await response.json(), true, false); assert.equal(fs.existsSync(path.dirname(f.ledgerFile)), false);
});
