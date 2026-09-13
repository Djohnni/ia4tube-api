"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { runProof } = require("../scripts/validation/vm-proof-controller");
const { MANIFEST, createPlan, validatePlan } = require("../scripts/validation/vm-proof-manifest");
const { createDigitalOceanProvider, createTransport } = require("../scripts/validation/vm-proof-digitalocean");
const { makeCloudConfig, publicIPv4 } = require("../scripts/validation/vm-proof-ssh");
function fixture() {
  const plan = createPlan("a".repeat(64), { id: 777, fingerprint: Array(16).fill("aa").join(":") }); let state = null, vm = null, time = 2000000000000;
  const calls = [], snapshots = [];
  const store = { async exclusive(fn) { return fn(); }, async read() { return state && structuredClone(state); },
    async write(s) { state = structuredClone(s); snapshots.push(structuredClone(s)); } };
  const f = { plan, store, now: () => time, sleep: async ms => { time += ms; },
    state: () => state, setState: value => { state = structuredClone(value); }, calls, snapshots,
    advance: ms => { time += ms; }, vm: () => vm, setVm: value => { vm = value; } };
  f.provider = {
    async verifySshKey() { calls.push("ssh-key-verified"); return { verified: true }; },
    async inventory() { calls.push("inventory"); return [{ id: 1 }, { id: 2 }]; },
    async create({ name, tag }) { calls.push("create"); assert.equal(state.phase, "create_intent");
      vm = { id: 41, name, tags: [tag], created_at: new Date(time).toISOString(), status: "active",
        region: { slug: "sfo3" }, size_slug: "s-1vcpu-2gb", memory: 2048, vcpus: 1, disk: 50,
        image: { slug: "ubuntu-24-04-x64" } }; return vm; },
    async findByTag() { calls.push("find"); return vm ? [vm] : []; },
    async get(v) { assert.equal(v, 41); calls.push("get"); return vm; },
    async destroy(v) { assert.equal(v, 41); assert.equal(state.phase, "destroy_intent"); assert.equal(state.resourceId, 41); calls.push("destroy"); vm = null; }
  };
  f.guest = {
    async prepareLocalIdentity() { calls.push("identity"); }, createIdentityPayload() { return { synthetic: true }; },
    async bindHost() { calls.push("bind"); },
    async preflight() { calls.push("preflight"); return { passed: true, convertersStarted: 0 }; },
    async install() { calls.push("install"); return { passed: true, convertersStarted: 0 }; },
    async runSequence() { calls.push("sequence"); assert.equal(state.cases.at(-1).phase, "intent");
      return { cases: MANIFEST.cases.map(c => ({ id: c.id, passed: true, terminationProved: true, nativeLaunches: c.attempts.length })), launches: 8, attemptIds: MANIFEST.cases.flatMap(c => c.attempts), allTerminated: true }; },
    async collect() { calls.push("collect"); return { sanitized: true, sha256: "b".repeat(64) }; }
  };
  f.run = overrides => runProof({ ...f, approvalSha256: plan.approvalSha256, ...overrides });
  return f;
}
test("VM proof manifest is fixed, offline by default, <=10 supervised attempts, bounded at two hours", () => {
  assert.equal(MANIFEST.paidExecutionDefault, false); assert.equal(MANIFEST.maxExistenceSeconds, 7200);
  assert.equal(MANIFEST.cases.reduce((n,c) => n+c.attempts.length,0), 8);
  assert.equal(new Set(MANIFEST.cases.flatMap(c => c.attempts)).size, 8);
  assert.ok(MANIFEST.cases.every(c => c.maxAttemptSeconds <= 180 && c.retries === 0));
  assert.ok(MANIFEST.cases.reduce((n, c) => n + c.caseBudgetSeconds, 0) <= MANIFEST.sequenceSeconds);
  assert.equal(MANIFEST.finance.computeTwoHoursUsd, 0.01786 * 2);
  assert.equal(MANIFEST.finance.guaranteedInvoiceCap, false);
  const plan = structuredClone(createPlan("a".repeat(64))); plan.manifest.resource.size = "large";
  assert.throws(() => validatePlan(plan), /plan_changed/);
});
test("explicit plan confirmation is required before any provider or guest call", async () => {
  const f = fixture(); await assert.rejects(f.run({ approvalSha256: "wrong" }), /specific_paid_confirmation/); assert.deepEqual(f.calls, []);
});
test("successful offline lifecycle journals intent then creates once and destroys exact new ID after collection", async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.destructionConfirmed, true); assert.equal(result.launches, 8); assert.equal(result.failure, null);
  assert.equal(f.calls.filter(c => c === "create").length, 1); assert.equal(f.calls.filter(c => c === "destroy").length, 1);
  assert.ok(f.calls.indexOf("collect") < f.calls.indexOf("destroy"));
  assert.equal(result.deadlineAt - result.createdAt, 7200000);
  const before = f.calls.length; const again = await f.run(); assert.equal(again.destructionConfirmed, true); assert.equal(f.calls.length, before);
});
test("host preflight failure prevents install and ALL converter attempts but still destroys", async () => {
  const f = fixture(); f.guest.preflight = async () => ({ passed: false, convertersStarted: 0 }); const result = await f.run();
  assert.equal(result.failure, "vm_proof_host_preflight_failed"); assert.equal(result.launches, 0);
  assert.equal(f.calls.includes("install"), false); assert.equal(result.destructionConfirmed, true);
});
test("local identity protection failure happens before Create and consumes no VM", async () => {
  const f = fixture(); f.guest.prepareLocalIdentity = async () => { throw new Error("secret should not escape"); };
  const result = await f.run(); assert.equal(f.calls.includes("create"), false); assert.equal(result.billingMayContinue, false);
  assert.equal(JSON.stringify(f.state()).includes("secret should not escape"), false);
});
test("lost Create response reconciles unique intent without a second POST", async () => {
  const f = fixture(), original = f.provider.create;
  f.provider.create = async a => { await original(a); throw new Error("uncertain"); };
  const result = await f.run(); assert.equal(result.destructionConfirmed, true); assert.equal(f.state().creationRecovered, true);
  assert.equal(f.calls.filter(v => v === "create").length, 1); assert.equal(result.failure, null);
});
test("Create visibility lag is observed within original deadline without repeating POST", async () => {
  const f = fixture(), original = f.provider.create; let reads = 0;
  f.provider.create = async a => { await original(a); throw new Error("lost"); };
  f.provider.findByTag = async () => { reads++; if (reads < 3) return []; return [f.vm()]; };
  const r = await f.run(); assert.equal(reads, 3); assert.equal(r.destructionConfirmed, true);
  assert.equal(f.calls.filter(v => v === "create").length, 1); assert.equal(r.deadlineAt - r.createdAt, 7200000);
});
test("late observation after original work budget destroys without running install or cases", async () => {
  const f = fixture(), original = f.provider.create; let reads = 0;
  f.provider.create = async a => { await original(a); throw new Error("lost"); };
  f.provider.findByTag = async () => { reads++; if (reads === 1) { f.advance(109 * 60000); return []; } return [f.vm()]; };
  const r = await f.run(); assert.equal(r.destructionConfirmed, true); assert.equal(f.calls.includes("install"), false);
  assert.equal(f.calls.filter(v => v === "create").length, 1);
});
test("journal write failure after created ID does not prevent provider-side cleanup", async () => {
  const f = fixture(), save = f.store.write;
  f.store.write = async s => { if (s.phase === "host_preflight_intent" || s.phase === "collecting" || s.phase === "destroyed") throw new Error("disk full"); await save(s); };
  const r = await f.run(); assert.equal(r.destructionConfirmed, true); assert.equal(r.journalPersistenceFailed, true);
  assert.equal(f.calls.includes("preflight"), false); assert.equal(f.calls.filter(v => v === "destroy").length, 1);
});
test("unbound or unverified existing account SSH key blocks creation", async () => {
  const f = fixture(), plan = createPlan("a".repeat(64));
  await assert.rejects(f.run({ plan, approvalSha256: plan.approvalSha256 }), /existing_account_ssh_key/);
  assert.equal(f.calls.length, 0);
  f.provider.verifySshKey = async () => { throw new Error("mismatch"); };
  const r = await f.run(); assert.equal(r.billingMayContinue, false); assert.equal(f.calls.includes("create"), false);
});
test("unknown Create with zero matches remains visible; resume only reads and never creates again", async () => {
  const f = fixture(); f.provider.create = async () => { f.calls.push("create"); throw new Error("network"); };
  const first = await f.run(); assert.equal(first.billingMayContinue, true); assert.equal(first.resourceId, null);
  const second = await f.run(); assert.equal(second.billingMayContinue, true); assert.equal(f.calls.filter(v => v === "create").length, 1);
  assert.equal(f.calls.includes("destroy"), false);
});
test("pre-existing or ambiguous tagged resources can never be adopted or destroyed", async () => {
  for (const mode of ["old", "ambiguous"]) {
    const f = fixture(), create = f.provider.create;
    f.provider.create = async a => { const d = await create(a); if (mode === "old") d.id = 1; throw new Error("lost"); };
    if (mode === "ambiguous") f.provider.findByTag = async () => [f.vm(), { ...f.vm(), id: 42 }];
    const r = await f.run(); assert.equal(r.resourceId, null); assert.equal(r.billingMayContinue, true); assert.equal(f.calls.includes("destroy"), false);
  }
});
test("restart after an attempted case does not relaunch it or later cases; cleanup still runs", async () => {
  const f = fixture(); await f.run({ stopAfterCreate: true });
  const s = f.state(); s.phase = "case_intent"; s.hostPreflight = "passed"; s.install = "passed";
  s.cases = [{ id: MANIFEST.cases[0].id, phase: "intent", startedAt: f.now() }]; f.setState(s);
  const r = await f.run(); assert.equal(r.destructionConfirmed, true); assert.equal(r.cases[0].phase, "unknown");
  assert.ok(MANIFEST.cases.every(c => !f.calls.includes(c.id))); assert.equal(f.calls.filter(v => v === "create").length, 1);
});
test("lost sequence or receipt launch-count mismatch cannot repeat", async () => {
  for (const mode of ["throw", "count"]) {
    const f = fixture(); f.guest.runSequence = async () => { f.calls.push("sequence"); if (mode === "throw") throw new Error("secret error");
      return { cases: [], allTerminated: true, launches: 11 }; };
    const r = await f.run(); assert.equal(r.cases.length, 5); assert.equal(r.destructionConfirmed, true);
    assert.equal(r.cases[0].phase, "unknown"); assert.equal(JSON.stringify(f.state()).includes("secret error"), false);
    assert.equal(f.calls.filter(c => c === "sequence").length, 1);
  }
});
test("two-hour clock is provider createdAt and reserves collection/deletion before new install", async () => {
  const f = fixture(); f.guest.preflight = async () => { f.advance(70 * 60000); return { passed: true, convertersStarted: 0 }; };
  const r = await f.run(); assert.equal(r.failure, "vm_proof_insufficient_time_for_install");
  assert.equal(f.calls.includes("install"), false); assert.equal(r.destructionConfirmed, true);
});
test("collection failure still destroys; uncertain DELETE observes same ID without poweroff", async () => {
  const f = fixture(); f.guest.collect = async () => { throw new Error("unavailable"); };
  const destroy = f.provider.destroy; f.provider.destroy = async id => { await destroy(id); throw new Error("lost"); };
  const r = await f.run(); assert.equal(r.destructionConfirmed, true); assert.equal(r.evidenceCollected, false);
});
test("unconfirmed destruction explicitly reports continuing billing and exact target", async () => {
  const f = fixture(); f.provider.destroy = async () => { f.calls.push("destroy"); f.provider.get = async () => { throw new Error("offline"); }; throw new Error("offline"); };
  const r = await f.run(); assert.equal(r.phase, "cleanup_required"); assert.equal(r.billingMayContinue, true); assert.equal(r.resourceId, 41);
});
test("provider adapter only produces one named Droplet, no extra resources and literal ID deletion", async () => {
  const calls = [], transport = async r => { calls.push(r); if (r.method === "POST") return { status: 202, json: { droplet: { id: 41 } } };
    if (r.method === "DELETE") return { status: 204 }; if (r.pathname.includes("per_page")) return { status: 200, json: { droplets: [] } }; return { status: 404 }; };
  const p = createDigitalOceanProvider({ transport }), tag = "ia4tube-proof-00000000-0000-4000-8000-000000000000";
  await p.inventory(); await p.create({ name: tag, tag, resource: MANIFEST.resource, sshKey: { id: 777 }, identity: { adminPublicKey: "ssh-ed25519 AAAA", cloudConfig: "synthetic" } });
  await p.destroy(41); assert.equal(await p.get(41), null); assert.equal(calls[1].body.names, undefined);
  assert.equal(calls[1].body.backups, false); assert.equal(calls[1].body.monitoring, false); assert.equal(calls[2].pathname, "/v2/droplets/41");
  await assert.rejects(p.destroy("41;delete all"), /id_invalid/);
  assert.throws(() => createTransport("short"), /credential_invalid/);
});
test("host pin provisioning uses only ephemeral host/admin identities; unsafe IPs and unknown input are rejected", () => {
  const cfg = makeCloudConfig("-----BEGIN OPENSSH PRIVATE KEY-----\nQUFBQQ==\n-----END OPENSSH PRIVATE KEY-----\n", "ssh-ed25519 AAAA", "ssh-ed25519 BBBB");
  assert.match(cfg, /ssh_pwauth: false/); assert.match(cfg, /disable_root: true/); assert.match(cfg, /name: ia4proof/);
  assert.doesNotMatch(cfg, /dop_|DATABASE|INSTAGRAM|ffmpeg|node /);
  for (const ip of ["127.0.0.1", "169.254.169.254", "10.0.0.1", "not-an-ip"]) assert.throws(() => publicIPv4(ip), /public_ip_invalid/);
  assert.equal(publicIPv4("203.0.113.1"), "203.0.113.1");
});
