"use strict";
// Controller lives on the operator's machine, NOT in the Droplet. Every write
// intent precedes its side effect. A lost create/case response is never retried.
const crypto = require("node:crypto");
const { MANIFEST, validatePlan } = require("./vm-proof-manifest");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fail(code) { throw Object.assign(new Error("vm_proof_" + code), { code: "vm_proof_" + code }); }
function id(value) { if (!Number.isSafeInteger(value) || value <= 0) fail("resource_id_invalid"); return value; }
function validateState(s, plan) {
  if (!s || s.schema !== 1 || !UUID.test(s.missionId) || s.planSha256 !== plan.approvalSha256 ||
      s.tag !== "ia4tube-proof-" + s.missionId || s.name !== "ia4tube-proof-" + s.missionId ||
      !Array.isArray(s.preexistingIds) || s.preexistingIds.some(v => !Number.isSafeInteger(v) || v <= 0) ||
      !Array.isArray(s.cases) || s.cases.length > MANIFEST.maxLaunches ||
      s.cases.some((r, i) => r.id !== MANIFEST.cases[i]?.id || !["intent", "passed", "failed", "unknown"].includes(r.phase))) fail("journal_invalid");
  if (s.resourceId !== null) {
    id(s.resourceId);
    if (s.preexistingIds.includes(s.resourceId) || !Number.isFinite(s.createdAt) ||
      s.deadlineAt !== s.createdAt + MANIFEST.maxExistenceSeconds * 1000) fail("journal_binding_invalid");
  }
  return s;
}
function boundDroplet(d, state) {
  if (!d || state.preexistingIds.includes(id(d.id)) || d.name !== state.name || !d.tags?.includes(state.tag) ||
      d.region?.slug !== MANIFEST.resource.region || d.size_slug !== MANIFEST.resource.size ||
      d.memory !== MANIFEST.resource.memoryMiB || d.vcpus !== MANIFEST.resource.vcpus || d.disk !== MANIFEST.resource.diskGiB ||
      d.image?.slug !== MANIFEST.resource.image || !Number.isFinite(Date.parse(d.created_at)) ||
      Date.parse(d.created_at) < Math.floor(state.createIntentAt / 1000) * 1000 - 30000 ||
      (state.resourceId !== null && d.id !== state.resourceId) || (state.createdAt !== null && Date.parse(d.created_at) !== state.createdAt)) fail("resource_binding_mismatch");
  return { id: d.id, createdAt: Date.parse(d.created_at), status: d.status };
}
async function bounded(fn, milliseconds) {
  if (!(milliseconds > 0)) fail("deadline_exhausted");
  const abort = new AbortController(); let timer;
  try { return await Promise.race([fn(abort.signal), new Promise((_, reject) => {
    timer = setTimeout(() => { abort.abort(); reject(Object.assign(new Error("vm_proof_operation_timeout"), { code: "vm_proof_operation_timeout" })); }, milliseconds);
  })]); } finally { clearTimeout(timer); }
}
async function runProof({ plan, approvalSha256, store, provider, guest, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), stopAfterCreate = false }) {
  validatePlan(plan);
  if (approvalSha256 !== plan.approvalSha256) fail("specific_paid_confirmation_required");
  if (plan.providerSshKey === null) fail("existing_account_ssh_key_required");
  return store.exclusive(async () => {
    let s = await store.read();
    const save = async () => { validateState(s, plan); await store.write(s); };
    const saveDuringCleanup = async () => { try { await save(); } catch { s.journalPersistenceFailed = true; } };
    const providerCall = fn => bounded(fn, MANIFEST.maxProviderRequestSeconds * 1000);
    if (!s) {
      // Inventory/read access is before the create intent. No existing resource
      // can become owned just by being given our name or tag later.
      const missionId = crypto.randomUUID();
      const inventory = await providerCall(signal => provider.inventory({ signal }));
      if (!Array.isArray(inventory) || inventory.length > 10000) fail("inventory_invalid");
      s = { schema: 1, missionId, tag: "ia4tube-proof-" + missionId, name: "ia4tube-proof-" + missionId,
        planSha256: plan.approvalSha256, preexistingIds: inventory.map(d => id(d.id)), phase: "prepared",
        createIntentAt: null, resourceId: null, createdAt: null, deadlineAt: null, hostPreflight: null,
        install: null, cases: [], collection: null, destruction: null, failure: null };
      await save();
    } else validateState(s, plan);
    if (s.phase === "destroyed") return summary(s);
    try {
      if (s.phase === "prepared") {
        // Includes locally protected keys and pinned SSH configuration. Must
        // finish safely BEFORE a VM can be billed. Never journals credentials.
        await guest.prepareLocalIdentity({ missionId: s.missionId, plan });
        await providerCall(signal => provider.verifySshKey(plan.providerSshKey, { signal }));
        s.createIntentAt = now(); s.phase = "create_intent"; await save();
        let created;
        try { created = await providerCall(signal => provider.create({ name: s.name, tag: s.tag, resource: MANIFEST.resource,
          identity: guest.createIdentityPayload(), sshKey: plan.providerSshKey, signal })); } catch { s.failure = "create_response_unknown"; await save(); }
        if (created) {
          const d = boundDroplet(created, s); s.resourceId = d.id; s.createdAt = d.createdAt;
          s.deadlineAt = d.createdAt + MANIFEST.maxExistenceSeconds * 1000; s.phase = "created"; await save();
        }
      }
      if (s.resourceId === null) {
        // Read-only reconciliation is safe after lost response. Never call POST
        // again. Ambiguity preserves all resources for explicit investigation.
        // Visibility can lag a lost Create response. Keep observing the unique
        // intent within the original clock, reserving destruction time. An
        // invocation after this deadline still makes ONE read for late cleanup.
        const reconcileUntil = s.createIntentAt + (MANIFEST.maxExistenceSeconds - MANIFEST.destroyReserveSeconds) * 1000;
        let found;
        while (true) {
          let matches;
          try { matches = await providerCall(signal => provider.findByTag(s.tag, { signal })); }
          catch { matches = null; }
          if (matches !== null && (!Array.isArray(matches) || matches.length > 1)) fail("creation_ambiguous_no_repeat");
          if (matches?.length === 1) { found = matches[0]; break; }
          if (now() >= reconcileUntil) fail("creation_unresolved_no_repeat");
          await sleep(Math.min(10000, reconcileUntil - now()));
        }
        const d = boundDroplet(found, s); s.resourceId = d.id; s.createdAt = d.createdAt;
        s.deadlineAt = d.createdAt + MANIFEST.maxExistenceSeconds * 1000; s.phase = "created"; await save();
        s.creationRecovered = true; s.failure = null; await save();
      }
      if (stopAfterCreate) return summary(s); // test seam; CLI never offers this option.
      const canStart = seconds => now() + seconds * 1000 <= s.deadlineAt - (MANIFEST.collectReserveSeconds + MANIFEST.destroyReserveSeconds) * 1000;
      // An interrupted installed/case intent must never be repeated on resume.
      if (["host_preflight_intent", "install_intent", "case_intent", "collecting", "destroy_intent", "cleanup_required"].includes(s.phase)) fail("interrupted_phase_no_repeat");
      while (true) {
        if (!canStart(MANIFEST.hostPreflightSeconds)) fail("insufficient_time_for_work");
        const current = await providerCall(signal => provider.get(s.resourceId, { signal }));
        boundDroplet(current, s);
        if (current.status === "active") { await guest.bindHost(current, { missionId: s.missionId, plan }); break; }
        await sleep(1000);
      }
      if (s.hostPreflight !== "passed") {
        if (!canStart(MANIFEST.hostPreflightSeconds)) fail("insufficient_time_for_preflight");
        s.phase = "host_preflight_intent"; await save();
        const r = await bounded(signal => guest.preflight({ plan, signal, timeoutMs: MANIFEST.hostPreflightSeconds * 1000 }), MANIFEST.hostPreflightSeconds * 1000);
        if (r?.passed !== true || r.convertersStarted !== 0) fail("host_preflight_failed");
        s.hostPreflight = "passed"; s.phase = "host_preflight_passed"; await save();
      }
      if (s.install !== "passed") {
        if (!canStart(MANIFEST.installSeconds)) fail("insufficient_time_for_install");
        s.phase = "install_intent"; await save();
        const r = await bounded(signal => guest.install({ plan, signal, timeoutMs: MANIFEST.installSeconds * 1000 }), MANIFEST.installSeconds * 1000);
        if (r?.passed !== true || r.convertersStarted !== 0) fail("installation_failed");
        s.install = "passed"; s.phase = "installed"; await save();
      }
      if (s.cases.length) fail("sequence_not_repeatable");
      if (!canStart(MANIFEST.sequenceSeconds)) fail("insufficient_time_for_case");
      const attempts = MANIFEST.cases.flatMap(c => c.attempts);
      if (attempts.length > MANIFEST.maxLaunches || new Set(attempts).size !== attempts.length) fail("launch_budget_exhausted");
      // One shared native executor: repeating a Node process per case would
      // repeat probes and silently increase the supervised-attempt count.
      s.cases = MANIFEST.cases.map(c => ({ id: c.id, phase: "intent", startedAt: now() }));
      s.phase = "case_intent"; await save();
      let result;
      try { result = await bounded(signal => guest.runSequence({ plan, signal, timeoutMs: MANIFEST.sequenceSeconds * 1000 }), MANIFEST.sequenceSeconds * 1000); }
      catch { fail("case_result_unknown"); }
      if (!result || !Array.isArray(result.cases) || result.cases.length !== MANIFEST.cases.length ||
          result.launches !== attempts.length || result.allTerminated !== true ||
          !Array.isArray(result.attemptIds) || result.attemptIds.join(",") !== attempts.join(",")) fail("sequence_receipt_invalid");
      for (let i = 0; i < MANIFEST.cases.length; i++) {
        const c = MANIFEST.cases[i], r = result.cases[i], record = s.cases[i];
        if (r?.id !== c.id || r.passed !== true || r.terminationProved !== true || r.nativeLaunches !== c.attempts.length) {
          record.phase = "failed"; await save(); fail("case_failed");
        }
        record.phase = "passed"; record.completedAt = now(); record.nativeLaunches = r.nativeLaunches;
      }
      s.phase = "case_complete"; await save();
      s.phase = "proof_complete"; await save();
    } catch (error) {
      s.failure = /^vm_proof_[a-z_]+$/.test(error?.code || "") ? error.code : "vm_proof_operation_failed";
      // Mark indeterminate run before cleanup. No provider/SSH response is
      // logged, and a JS exception cannot accidentally declare the job passed.
      for (const c of s.cases) if (c.phase === "intent") c.phase = "unknown";
      await saveDuringCleanup();
    } finally {
      if (s.resourceId !== null && !stopAfterCreate) {
        s.phase = "collecting"; await saveDuringCleanup();
        const collectMs = Math.min(MANIFEST.collectReserveSeconds * 1000,
          s.deadlineAt - now() - MANIFEST.destroyReserveSeconds * 1000);
        if (collectMs > 0) {
          try { s.collection = await bounded(signal => guest.collect({ missionId: s.missionId, plan, signal, timeoutMs: collectMs }), collectMs);
            if (!s.collection || s.collection.sanitized !== true || !/^[a-f0-9]{64}$/.test(s.collection.sha256 || "")) s.collection = { status: "unproved" };
            else s.collection = { status: "collected", sha256: s.collection.sha256, sanitized: true };
          } catch { s.collection = { status: "failed" }; }
        } else s.collection = { status: "skipped_deadline" };
        await saveDuringCleanup();
        // Deletion is provider-side, from this controller. No poweroff command.
        // Exact current identity is rechecked before DELETE, including inventory.
        s.phase = "destroy_intent"; s.destruction = { id: s.resourceId, requestedAt: now(), confirmedAt: null }; await saveDuringCleanup();
        try {
          const current = await providerCall(signal => provider.get(s.resourceId, { signal }));
          if (current !== null) {
            boundDroplet(current, s);
            try { await providerCall(signal => provider.destroy(s.resourceId, { signal })); } catch { /* Observe the same ID after lost DELETE response. */ }
          }
          const end = Math.max(now(), Math.min(s.deadlineAt, now() + MANIFEST.destroyReserveSeconds * 1000));
          while (true) {
            const current = await providerCall(signal => provider.get(s.resourceId, { signal }));
            if (current === null) { s.phase = "destroyed"; s.destruction.confirmedAt = now(); break; }
            boundDroplet(current, s);
            if (now() >= end) fail("destruction_unconfirmed");
            await sleep(1000);
          }
        } catch { s.phase = "cleanup_required"; s.destruction.status = "unconfirmed_billing_may_continue"; }
        await saveDuringCleanup();
      }
    }
    return summary(s);
  });
}
function summary(s) {
  return { missionId: s.missionId, phase: s.phase, resourceId: s.resourceId, createdAt: s.createdAt,
    deadlineAt: s.deadlineAt, hostPreflight: s.hostPreflight, install: s.install,
    launches: s.cases.some(c => ["intent", "unknown"].includes(c.phase)) ? null : s.cases.reduce((n, c) => n + (c.nativeLaunches || 0), 0), reservedLaunches: s.cases.reduce((n, r) => n + MANIFEST.cases.find(v => v.id === r.id).attempts.length, 0),
    cases: s.cases.map(c => ({ id: c.id, phase: c.phase })),
    failure: s.failure, journalPersistenceFailed: s.journalPersistenceFailed === true, evidenceCollected: s.collection?.status === "collected",
    destructionConfirmed: s.phase === "destroyed", billingMayContinue: s.phase !== "destroyed" && s.phase !== "prepared",
    realMedia: false, apiChanged: false, instagramOperations: 0 };
}
module.exports = { runProof, validateState, boundDroplet, bounded, summary };
