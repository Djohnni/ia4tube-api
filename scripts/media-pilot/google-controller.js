"use strict";
const crypto = require("node:crypto");
const { bounded } = require("../validation/vm-proof-controller");
const { sha256, canonical } = require("../validation/vm-proof-manifest");
const { KINDS, UUID, googleId, resourceName, bindResource } = require("../validation/vm-proof-google-plan");
const { fail, HASH, validateOperationalPlan } = require("./google-plan");
function validateState(s, p) {
  if (!s || s.schema !== 1 || s.kind !== p.kind || !UUID.test(s.missionId || "") || s.planSha256 !== p.approvalSha256 ||
      !Number.isSafeInteger(s.startedAt) || s.deadlineAt !== s.startedAt + p.maxExistenceSeconds * 1000 ||
      s.admitUntil !== s.startedAt + p.admissionSeconds * 1000 ||
      s.workerStopAt !== s.deadlineAt - p.cleanupReserveSeconds * 1000 ||
      s.workerStopAt - s.admitUntil < p.drainReserveSeconds * 1000) fail("journal_invalid");
  for (const k of KINDS) {
    const r = s.resources?.[k];
    if (!r || !Array.isArray(s.preexisting?.[k]) || s.preexisting[k].length > 10000 ||
        !UUID.test(r.createRequestId || "") || !UUID.test(r.deleteRequestId || "") ||
        r.intentAt !== null && (!Number.isSafeInteger(r.intentAt) || r.intentAt < s.startedAt || r.intentAt > s.deadlineAt)) fail("journal_resource_invalid");
    for (const old of s.preexisting[k]) { googleId(old.id); if (typeof old.name !== "string") fail("journal_inventory_invalid"); }
    if (r.id !== null) { googleId(r.id); if (r.intentAt === null || !Number.isFinite(r.createdAt)) fail("journal_resource_invalid"); }
  }
  if (s.hostEvidence !== null && (!HASH.test(s.hostEvidence.runtimeRevision || "") || !UUID.test(s.hostEvidence.bootId || ""))) fail("journal_host_invalid");
  if (s.apiPreparation !== null && s.apiPreparation !== undefined &&
      (!Number.isSafeInteger(s.apiPreparation.intentAt) || s.apiPreparation.intentAt < s.startedAt ||
       s.apiPreparation.waitUntil !== undefined && s.apiPreparation.waitUntil !== s.admitUntil ||
       !UUID.test(s.apiClosure?.requestId || ""))) fail("journal_api_invalid");
  if (s.apiPreparation?.diagnostic != null) {
    const diagnostic = s.apiPreparation.diagnostic;
    if (Object.keys(diagnostic).sort().join() !== "activationState,code,observedAt,phase,sourceCode,statusCode,transportCode" ||
        canonical(diagnostic) !== canonical(apiPreparationDiagnostic(diagnostic, diagnostic.observedAt)) ||
        diagnostic.observedAt < s.apiPreparation.intentAt || diagnostic.observedAt > s.deadlineAt)
      fail("journal_api_diagnostic_invalid");
  }
  if (s.apiClosure !== null && s.apiClosure !== undefined && (!UUID.test(s.apiClosure.requestId || "") ||
      !["pending", "intent", "confirmed", "unconfirmed", "skipped_cleanup_priority"].includes(s.apiClosure.phase))) fail("journal_closure_invalid");
  return s;
}
function validateClosureReceipt(value, context) {
  if (!value || Object.keys(value).sort().join() !== "admissionClosed,closureRequestId,connectionEnabled,launchClosed,metaWindowEnabled,missionId,publicationEnabled,receiptSha256,schema,sentinelSha256" ||
      value.schema !== 1 || value.missionId !== context.missionId || value.closureRequestId !== context.closureRequestId ||
      value.admissionClosed !== true || value.launchClosed !== true || value.connectionEnabled !== false || value.publicationEnabled !== false || value.metaWindowEnabled !== false ||
      !HASH.test(value.sentinelSha256 || "") || !HASH.test(value.receiptSha256 || "")) fail("api_closure_receipt_invalid");
  const { receiptSha256, ...content } = value;
  if (sha256(canonical(content)) !== receiptSha256) fail("api_closure_receipt_invalid");
  return value;
}
function activationWaitBudget(state, at) {
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(state?.admitUntil) || at >= state.admitUntil) fail("activation_deadline");
  return state.admitUntil - at;
}
const TRANSIENT_OBSERVATION_SOURCES = new Set([
  "media_owner_aborted", "media_owner_timeout", "media_owner_response_limit"
]);
const TRANSIENT_OBSERVATION_TRANSPORTS = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EPIPE"
]);
const MAX_CONSECUTIVE_TRANSIENT_OBSERVATIONS = 3;
const API_DIAGNOSTIC_CODES = new Set(("aborted acceptance_invalid activation_confirmation_invalid activation_failed activation_repeat_refused admission_expired callbacks_invalid closure_concurrent " +
  "closure_identity_changed closure_identity_invalid closure_receipt_changed closure_unconfirmed configuration_limit configuration_unconfirmed " +
  "context_invalid deadline host_invalid http_adapter_invalid http_target_invalid http_unavailable material_invalid music_rights_invalid " +
  "owner_capabilities_invalid packet_invalid pilot_not_ready pilot_receipt_invalid prepare_repeat_refused readiness_repeat_refused " +
  "receipt_invalid sentinel_hash_invalid ssh_binding_invalid ssh_request_invalid transfer_unconfirmed operation_failed").split(" ").map(value => "media_api_control_" + value));
for (const value of ["media_pilot_activation_deadline", "media_pilot_api_not_bound", "media_pilot_admission_window_elapsed",
  "media_pilot_operator_interrupted", "media_pilot_unclassified_failure"]) API_DIAGNOSTIC_CODES.add(value);
const API_DIAGNOSTIC_SOURCES = new Set(("media_owner_route_refused media_owner_aborted media_owner_response_limit media_owner_response_unconfirmed " +
  "media_owner_response_refused media_owner_response_invalid media_owner_timeout media_owner_transport_failed media_owner_credential_refused " +
  "media_owner_login_unconfirmed media_private_state_configuration_invalid media_private_state_acl_unproved media_private_state_directory_invalid " +
  "media_private_state_directory_unsafe media_private_state_directory_unbound media_private_state_directory_changed media_private_state_metadata_unsafe " +
  "media_private_state_key_invalid media_private_state_record_limit media_private_state_record_invalid media_private_state_file_unsafe " +
  "media_private_state_file_changed media_private_state_manifest_changed media_private_state_temporary_changed " +
  "media_private_state_publication_unconfirmed media_private_state_temporary_cleanup_unconfirmed media_private_state_operation_failed " +
  "media_private_state_initialization_failed").split(" "));
const API_DIAGNOSTIC_STATUSES = new Set([400, 401, 403, 404, 405, 408, 409, 413, 415, 422, 429, 500, 502, 503, 504]);
const API_DIAGNOSTIC_TRANSPORTS = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "EPIPE",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"]);
const API_DIAGNOSTIC_ACTIVATIONS = new Set(["configuration_installed", "manual_apply_required", "human_confirmation_pending", "human_confirmed", "authenticated_ready",
  "deploy_failed", "http_temporarily_unavailable", "transport_temporarily_unavailable", "response_temporarily_unavailable", "live_flag_disabled"]);
function apiPreparationDiagnostic(error, observedAt) {
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) fail("api_diagnostic_invalid");
  return Object.freeze({
    phase: "prepare_api",
    code: API_DIAGNOSTIC_CODES.has(error?.code) ? error.code : "media_pilot_unclassified_failure",
    sourceCode: API_DIAGNOSTIC_SOURCES.has(error?.sourceCode) ? error.sourceCode : null,
    statusCode: API_DIAGNOSTIC_STATUSES.has(error?.statusCode) ? error.statusCode : null,
    transportCode: API_DIAGNOSTIC_TRANSPORTS.has(error?.transportCode) ? error.transportCode : null,
    activationState: API_DIAGNOSTIC_ACTIVATIONS.has(error?.activationState) ? error.activationState : null,
    observedAt
  });
}
function transientObservationFailure(error) {
  if (error?.code === "vm_proof_operation_timeout" || error?.code === "media_api_control_deadline") return true;
  if (error?.code !== "media_api_control_http_unavailable") return false;
  if (TRANSIENT_OBSERVATION_SOURCES.has(error.sourceCode)) return true;
  if (error.sourceCode === "media_owner_response_unconfirmed")
    return error.transportCode == null || TRANSIENT_OBSERVATION_TRANSPORTS.has(error.transportCode);
  if (error.sourceCode === "media_owner_transport_failed") return TRANSIENT_OBSERVATION_TRANSPORTS.has(error.transportCode);
  if (error.sourceCode != null) return false;
  return [502, 503, 504].includes(error.statusCode);
}
async function boundedWithSignal(operation, milliseconds, parentSignal) {
  if (parentSignal?.aborted) fail("operator_interrupted");
  return bounded(timeoutSignal => {
    const combined = new AbortController(); let rejectParent;
    const interrupted = new Promise((_, reject) => { rejectParent = reject; });
    const abortTimeout = () => combined.abort();
    const abortParent = () => {
      combined.abort();
      rejectParent(Object.assign(new Error("media_pilot_operator_interrupted"), { code: "media_pilot_operator_interrupted" }));
    };
    timeoutSignal.addEventListener("abort", abortTimeout, { once: true });
    parentSignal?.addEventListener("abort", abortParent, { once: true });
    if (parentSignal?.aborted) abortParent();
    return Promise.race([Promise.resolve().then(() => operation(combined.signal)), interrupted]).finally(() => {
      timeoutSignal.removeEventListener("abort", abortTimeout);
      parentSignal?.removeEventListener("abort", abortParent);
      combined.abort();
    });
  }, milliseconds);
}
function summary(s, plan) {
  const finishedAt = Number.isSafeInteger(s.finishedAt) ? s.finishedAt : null;
  const completedWithinDeadline = finishedAt === null ? null : finishedAt <= s.deadlineAt;
  return { missionId: s.missionId, phase: s.phase, startedAt: s.startedAt, admitUntil: s.admitUntil, workerStopAt: s.workerStopAt, deadlineAt: s.deadlineAt,
    resources: Object.fromEntries(KINDS.map(k => [k, { id: s.resources[k].id, createdAt: s.resources[k].createdAt, absentConfirmedAt: s.resources[k].absentConfirmedAt }])),
    hostEvidence: s.hostEvidence, installation: s.installation, workerStart: s.workerStart, workerStop: s.workerStop,
    collection: s.collection, failure: s.failure, apiClosure: s.apiClosure || null,
    apiAdmissionClosed: s.apiPreparation == null ? null : s.apiClosure?.phase === "confirmed",
    apiClosurePending: s.apiPreparation != null && s.apiClosure?.phase !== "confirmed", preexistingPreserved: s.preexistingPreserved || null,
    destructionConfirmed: s.phase === "destroyed", billingMayContinue: s.phase !== "destroyed" && s.resources.instances.intentAt !== null,
    journalPersistenceFailed: s.journalPersistenceFailed === true, syntheticCases: 0, externalPublication: false,
    finishedAt, completedWithinDeadline, deadlineOverrunMs: finishedAt === null ? null : Math.max(0, finishedAt - s.deadlineAt),
    estimateUsd: plan.finance.estimatedMaximumUsd, newWindowEstimateUsd: plan.finance.estimatedMaximumUsd,
    priorBudgetBasisUsd: plan.finance.priorBudgetBasisUsd ?? plan.finance.alreadyIncurredUsd,
    priorBudgetBasisKind: plan.finance.priorBudgetBasisKind ?? "legacy_already_incurred",
    planningTotalUsd: plan.finance.estimatedPlanningTotalUsd ?? plan.finance.estimatedMaximumUsd + plan.finance.alreadyIncurredUsd,
    invoiceUsd: null };
}
// All API deployment/database preparation is a caller-owned prerequisite. This
// module receives only a closed-schema readiness receipt, never DB credentials.
// A restart of an existing journal is cleanup-only, never another paid launch.
async function runOperationalPilot({ plan, approvalSha256, store, provider, guest, prepareApi, observeApi, closeApi,
  now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), signal = null, onState = () => {}, cleanupOnly = false }) {
  validateOperationalPlan(plan);
  if (approvalSha256 !== plan.approvalSha256) fail("bound_authorization_required");
  if (typeof cleanupOnly !== "boolean") fail("cleanup_mode_invalid");
  if (typeof prepareApi !== "function" || typeof observeApi !== "function" || typeof closeApi !== "function") fail("api_control_required");
  const p = plan.infrastructure;
  return store.exclusive(async () => {
    let s = await store.read(), fresh = s === null;
    // The independent recovery entry point must never turn an absent journal
    // into a new billable mission, even if all ordinary prerequisites exist.
    if (cleanupOnly && fresh) fail("cleanup_journal_required");
    // Foreground work is interruptible by the operator. Cleanup deliberately
    // keeps using `call`: an already-aborted foreground signal must never stop
    // API fencing or provider deletion.
    const call = fn => bounded(fn, 20000);
    const foregroundCall = (fn, milliseconds = 20000) => boundedWithSignal(fn, milliseconds, signal);
    const foregroundSleep = milliseconds => boundedWithSignal(sig => sleep(milliseconds, sig), Math.max(1, milliseconds + 1000), signal);
    if (fresh) {
      // Schema 1 remains readable for cleanup/reconciliation of historical
      // journals, but must never authorize another billable launch.
      if (plan.schema !== 2) fail("legacy_plan_new_launch_refused");
      validateOperationalPlan(plan, { now: now() });
      const preexisting = {};
      for (const k of KINDS) preexisting[k] = await foregroundCall(sig => provider.inventory(k, { signal: sig }));
      const startedAt = now();
      s = { schema: 1, kind: plan.kind, missionId: crypto.randomUUID(), planSha256: plan.approvalSha256, startedAt,
        deadlineAt: startedAt + plan.maxExistenceSeconds * 1000,
        admitUntil: startedAt + plan.admissionSeconds * 1000,
        workerStopAt: startedAt + (plan.maxExistenceSeconds - plan.cleanupReserveSeconds) * 1000,
        resources: Object.fromEntries(KINDS.map(k => [k, { intentAt: null, id: null, createdAt: null, createRequestId: crypto.randomUUID(), deleteRequestId: crypto.randomUUID(),
          createOp: null, deleteOp: null, deleteIntentAt: null, absentConfirmedAt: null }])), preexisting,
        phase: "prepared", hostEvidence: null, installation: null, workerStart: null, workerStop: null, collection: null, failure: null,
        apiPreparation: null, apiClosure: null };
      validateState(s, plan); await store.write(s);
    } else validateState(s, plan);
    const save = async () => { validateState(s, plan); await store.write(s); try { onState(summary(s, plan)); } catch {} };
    const safeSave = async () => { try { await save(); } catch { s.journalPersistenceFailed = true; } };
    // A successful provider deletion does not hide a pending API admission
    // fence. Re-entry can reconcile that same idempotent closure, never deploy
    // or start a worker again. No billing-time window is extended.
    const previouslyDestroyed = s.phase === "destroyed";
    if (previouslyDestroyed && (s.apiPreparation == null || s.apiClosure?.phase === "confirmed")) return summary(s, plan);
    const budget = seconds => { if (signal?.aborted || now() + seconds * 1000 > s.workerStopAt) fail("work_deadline"); };
    async function bind(k, resource, strict = false) { Object.assign(s.resources[k], bindResource(p, s, k, resource, { strict })); await save(); return resource; }
    async function waitOperation(op, until, { invoke = call, pause = sleep } = {}) {
      const targetId = op.targetId;
      while (op.status !== "DONE") {
        if (now() >= until) fail("operation_deadline");
        await pause(Math.min(1000, until - now())); op = await invoke(sig => provider.pollOperation(op, s.missionId, { signal: sig }));
        if (targetId && op.targetId !== targetId) fail("operation_identity_changed");
      }
      if (op.failed) fail("operation_failed"); return op;
    }
    async function reconcile(k, until, strict = true, { invoke = call, pause = sleep } = {}) {
      while (true) {
        const r = await invoke(sig => provider.get(k, s.missionId, { signal: sig }));
        if (r) return bind(k, r, strict);
        if (now() >= until) fail("creation_unresolved_no_repeat");
        await pause(Math.min(1000, until - now()));
      }
    }
    async function create(k, script) {
      const r = s.resources[k]; budget(3600);
      if (r.intentAt !== null || s.preexisting[k].some(v => v.name === resourceName(s.missionId, k))) fail("creation_repeat_refused");
      r.intentAt = now(); s.phase = "creating_" + k;
      if (k === "instances") { s.resources.disks.intentAt = r.intentAt; r.bootstrapSha256 = sha256(script); }
      await save();
      try { r.createOp = await foregroundCall(sig => provider.create(k, s, script, { signal: sig })); await save(); }
      catch { r.createResponseUnknown = true; await save(); }
      if (r.createOp) r.createOp = await waitOperation(r.createOp, Math.min(s.workerStopAt, now() + 120000), { invoke: foregroundCall, pause: foregroundSleep });
      const resource = await reconcile(k, Math.min(s.workerStopAt, now() + 120000), true, { invoke: foregroundCall, pause: foregroundSleep });
      if (r.createOp?.targetId && r.createOp.targetId !== r.id) fail("create_target_changed");
      if (k === "instances") await reconcile("disks", Math.min(s.workerStopAt, now() + 120000), true, { invoke: foregroundCall, pause: foregroundSleep });
      return resource;
    }
    try {
      if (!fresh) fail("resume_cleanup_only");
      const ready = await foregroundCall(sig => provider.preflight({ signal: sig })); if (ready?.verified !== true) fail("provider_preflight_failed");
      await guest.prepareLocalIdentity({ missionId: s.missionId, plan: p });
      for (const k of ["networks", "subnetworks", "firewalls"]) await create(k);
      await create("instances", guest.createIdentityPayload().startupScript);
      let instance;
      while (true) { budget(3000); instance = await reconcile("instances", now(), true, { invoke: foregroundCall, pause: foregroundSleep }); if (instance.status === "RUNNING") break; await foregroundSleep(1000); }
      await guest.bindHost(instance, { missionId: s.missionId, plan: p });
      s.phase = "host_preflight_intent"; await save();
      const preflight = await foregroundCall(sig => guest.preflight({ signal: sig, timeoutMs: 180000 }), 180000);
      if (!preflight?.passed || preflight.convertersStarted !== 0) fail("host_preflight_failed");
      budget(2700); s.phase = "installation_intent"; await save();
      const install = await foregroundCall(sig => guest.install({ signal: sig, timeoutMs: 2400000, attempt: 1 }), 2400000);
      if (!install?.passed || install.convertersStarted !== 0 || install.diagnostic?.installationPassed !== true) fail("installation_failed");
      s.installation = "passed"; s.phase = "installed_host_probe"; await save(); budget(240);
      const host = await foregroundCall(sig => guest.probeInstalled({ signal: sig, timeoutMs: 180000 }), 180000);
      if (host?.controlsProved !== true || host.convertersStarted !== 0 || !UUID.test(host.bootId || "") || !HASH.test(host.runtimeRevision || "") || !HASH.test(host.receiptSha256 || "")) fail("installed_host_unproved");
      // Exact API contract, not the probe's raw envelope: no extra fields and
      // the API names the enforced provider action "deletionAction".
      s.hostEvidence = { project: p.project, zone: p.zone, instanceId: s.resources.instances.id,
        bootId: host.bootId, runtimeRevision: host.runtimeRevision, receiptSha256: host.receiptSha256,
        verifiedAt: now(), deletionAction: "DELETE", terminationTime: s.deadlineAt };
      s.phase = "api_readiness";
      s.apiPreparation = { intentAt: now(), waitUntil: s.admitUntil };
      s.apiClosure = { requestId: crypto.randomUUID(), phase: "pending" };
      await save();
      const context = { missionId: s.missionId, plan, createdAt: s.startedAt, admitUntil: s.admitUntil, finishBy: s.deadlineAt, stopAt: s.workerStopAt, destroyBy: s.deadlineAt, hostEvidence: s.hostEvidence };
      // Deployment/readiness owns the remaining admission window. The former
      // ten-minute cap was unrelated to both Render deployment time and the
      // mission's absolute worker/cleanup reserves, so a safe late deployment
      // could be mistaken for a definitive failure. Per-file processing limits
      // remain enforced by the worker; this wait cannot cross admitUntil.
      const activationBudgetMs=activationWaitBudget(s,now());
      let api;
      try{api=await boundedWithSignal(sig => prepareApi({ ...context, signal: sig }),activationBudgetMs,signal);}
      catch(error){if(error?.code==='vm_proof_operation_timeout')fail("activation_deadline");throw error;}
      if (api?.ready !== true || api.ownerCompanyId !== plan.ownerCompanyId || api.ownerUserId !== plan.ownerUserId || api.workerId !== plan.workerId ||
          api.runtimeRevision !== host.runtimeRevision || api.connectionEnabled !== false || api.publicationEnabled !== false || api.metaWindowEnabled !== false ||
          api.admitUntil !== s.admitUntil || api.finishBy !== s.deadlineAt || !HASH.test(api.receiptSha256 || "")) fail("api_not_bound");
      s.apiReceiptSha256 = api.receiptSha256; budget(300); if (now() >= s.admitUntil) fail("admission_window_elapsed");
      s.phase = "worker_start_intent"; s.workerStart = { phase: "intent", at: now() }; await save();
      const start = await foregroundCall(sig => guest.startWorker({ ...context, signal: sig, timeoutMs: 60000 }), 60000);
      if (start?.active !== true || start.recurring !== false || start.workerId !== plan.workerId || start.stopAt !== s.workerStopAt) fail("worker_start_unconfirmed_no_repeat");
      s.workerStart = { phase: "observed_active", at: now(), stopAt: s.workerStopAt }; s.phase = "operational"; await save();
      let consecutiveTransientObservations = 0;
      while (now() < s.workerStopAt) {
        if (signal?.aborted) fail("operator_interrupted");
        let result;
        try {
          // This is a read-only reconciliation. A short Render/transport gap
          // after the single durable worker start must not be mistaken for a
          // failed launch. Retry only the enumerated transient failures and
          // never cross the existing worker/cleanup boundary.
          result = await foregroundCall(sig => observeApi({ ...context, signal: sig }),
            Math.min(20000, Math.max(1, s.workerStopAt - now())));
        } catch (error) {
          if (signal?.aborted) fail("operator_interrupted");
          if (!transientObservationFailure(error)) throw error;
          consecutiveTransientObservations++;
          if (consecutiveTransientObservations >= MAX_CONSECUTIVE_TRANSIENT_OBSERVATIONS || now() >= s.workerStopAt)
            fail("observation_unavailable");
          await foregroundSleep(Math.min(15000, Math.max(0, s.workerStopAt - now())));
          continue;
        }
        if (!result || typeof result.finished !== "boolean" || result.gatesClosed !== true || !HASH.test(result.receiptSha256 || "")) fail("pilot_observation_invalid");
        consecutiveTransientObservations = 0;
        s.lastObservation = { at: now(), finished: result.finished, receiptSha256: result.receiptSha256 }; await save();
        if (result.finished) break;
        await foregroundSleep(Math.min(15000, Math.max(0, s.workerStopAt - now())));
      }
    } catch (error) {
      if (s.phase === "api_readiness" && s.apiPreparation != null && s.apiPreparation.diagnostic == null)
        s.apiPreparation.diagnostic = apiPreparationDiagnostic(error, now());
      s.failure ??= /^media_pilot_[a-z_]+$/.test(error?.code || "") ? error.code : "media_pilot_operation_failed";
      await safeSave();
    }
    finally {
      if (s.apiPreparation != null && s.apiClosure?.phase !== "confirmed") {
        // Never inherit the aborted operation signal: cleanup has its own small
        // deadline. A failed close cannot postpone external provider deletion.
        // The immutable per-mission sentinel also fences a late prepareApi.
        const closeBudget = previouslyDestroyed ? 20000 : Math.min(20000, s.deadlineAt - now() - 180000);
        if (closeBudget > 0) {
          s.apiClosure.phase = "intent"; s.apiClosure.lastIntentAt = now(); await safeSave();
          try {
            const context = { missionId: s.missionId, plan, hostEvidence: s.hostEvidence,
              createdAt: s.startedAt, admitUntil: s.admitUntil, finishBy: s.deadlineAt, stopAt: s.workerStopAt,
              destroyBy: s.deadlineAt, closureRequestId: s.apiClosure.requestId };
            const receipt = validateClosureReceipt(await bounded(sig => closeApi({ ...context, signal: sig }), closeBudget), context);
            s.apiClosure = { ...s.apiClosure, phase: "confirmed", confirmedAt: now(), sentinelSha256: receipt.sentinelSha256, receiptSha256: receipt.receiptSha256 };
          } catch { s.apiClosure.phase = "unconfirmed"; s.apiClosure.failure = "media_pilot_api_closure_unconfirmed"; }
        } else {
          s.apiClosure.phase = "skipped_cleanup_priority";
          s.apiClosure.failure = "media_pilot_api_closure_unconfirmed";
        }
        if (s.apiClosure.phase !== "confirmed" && s.failure === null) s.failure = "media_pilot_api_closure_unconfirmed";
        await safeSave();
      }
      if (!previouslyDestroyed && s.resources.instances.id !== null) {
        // Stop/collect may reconcile the SAME worker; no start/install replay.
        // Cleanup is independent of API availability, and never needs its key.
        const stopBudget = Math.min(250000, s.deadlineAt - now() - 180000);
        if (s.workerStart !== null && stopBudget > 0) try {
          const stop = await bounded(sig => guest.stopWorker({ signal: sig, timeoutMs: stopBudget }), stopBudget);
          s.workerStop = { stopped: stop?.stopped === true, nativeTerminationProved: stop?.nativeTerminationProved === true };
        } catch { s.workerStop = { stopped: false, nativeTerminationProved: false }; }
        else if (s.workerStart !== null) s.workerStop = { stopped: false, nativeTerminationProved: false, skippedForExternalCleanup: true };
        if (s.workerStart !== null && s.workerStop?.nativeTerminationProved !== true && s.failure === null) s.failure = "media_pilot_native_stop_unconfirmed";
        const collectBudget = Math.min(30000, s.deadlineAt - now() - 180000);
        if (collectBudget > 0) try { const c = await bounded(sig => guest.collectOperational({ signal: sig, timeoutMs: collectBudget }), collectBudget);
          if (c?.sanitized !== true || !HASH.test(c.sha256 || "") || !Number.isSafeInteger(c.executionsObserved) || c.executionsObserved < 0) fail("collection_invalid");
          s.collection = c;
        } catch { s.collection = { sanitized: false, failed: true }; }
        else s.collection = { sanitized: false, skippedForExternalCleanup: true };
        if (s.collection?.sanitized !== true && s.failure === null) s.failure = "media_pilot_collection_unconfirmed";
      }
      s.phase = "cleanup"; await safeSave(); let uncertain = false;
      for (const k of ["instances", "disks", "firewalls", "subnetworks", "networks"]) {
        const r = s.resources[k]; if (r.intentAt === null) continue;
        if (k !== "instances" && s.resources.instances.intentAt !== null && s.resources.instances.absentConfirmedAt === null) { uncertain = true; continue; }
        try {
          let resource = await call(sig => provider.get(k, s.missionId, { signal: sig }));
          if (resource) Object.assign(r, bindResource(p, s, k, resource));
          else if (r.id === null && !(r.createOp?.status === "DONE" && r.createOp.failed)) {
            if (k === "disks" && s.resources.instances.absentConfirmedAt !== null && s.resources.instances.id !== null) { r.absentConfirmedAt = now(); await safeSave(); continue; }
            uncertain = true; continue;
          }
          if (resource) {
            if (r.deleteIntentAt === null) { r.deleteIntentAt = now(); await safeSave(); }
            // Reconcile after the durable intent. If the previous DELETE never
            // reached Google, a cleanup-only re-entry may send the SAME
            // idempotency request id again. If it did reach Google, absence (or
            // the same operation) is observed and no distinct action is made.
            resource = await call(sig => provider.get(k, s.missionId, { signal: sig }));
            if (resource && r.deleteOp === null) {
              bindResource(p, s, k, resource);
              try { r.deleteOp = await call(sig => provider.destroy(k, s, { signal: sig })); r.deleteResponseUnknown = false; }
              catch { r.deleteResponseUnknown = true; }
              await safeSave();
            }
          }
          const until = Math.max(now(), Math.min(s.deadlineAt, now() + 300000));
          if (r.deleteOp) r.deleteOp = await waitOperation(r.deleteOp, until);
          while (true) {
            resource = await call(sig => provider.get(k, s.missionId, { signal: sig }));
            if (!resource) { r.absentConfirmedAt = now(); await safeSave(); break; }
            bindResource(p, s, k, resource); if (now() >= until) fail("destruction_unconfirmed"); await sleep(Math.min(1000, until - now()));
          }
        } catch { r.cleanupUnconfirmed = true; uncertain = true; await safeSave(); }
      }
      s.preexistingPreserved = {};
      for (const k of KINDS) try {
        const rows = await call(sig => provider.inventory(k, { signal: sig }));
        s.preexistingPreserved[k] = s.preexisting[k].every(old => rows.some(v => v.id === old.id && v.name === old.name));
        if (!s.preexistingPreserved[k] || rows.some(v => v.name === resourceName(s.missionId, k))) uncertain = true;
      } catch { s.preexistingPreserved[k] = null; uncertain = true; }
      s.finishedAt = now();
      s.completedWithinDeadline = s.finishedAt <= s.deadlineAt;
      s.deadlineOverrunMs = Math.max(0, s.finishedAt - s.deadlineAt);
      if (!s.completedWithinDeadline && s.failure === null) s.failure = "media_pilot_cleanup_deadline_overrun";
      s.phase = uncertain ? "cleanup_required" : "destroyed"; await safeSave();
    }
    return summary(s, plan);
  });
}
module.exports = { runOperationalPilot, validateState, validateClosureReceipt, activationWaitBudget, boundedWithSignal,
  apiPreparationDiagnostic, transientObservationFailure, summary };
