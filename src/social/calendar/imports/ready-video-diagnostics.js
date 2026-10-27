"use strict";

// Server-created, owner-scoped diagnostics. No error/request object
// reaches the sink; exact taxonomy also excludes secrets disguised as codes.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/;
const CODE = "calendar_ready_video_operation_failed", MAX_ELAPSED_MS = 300000;
const COMPLETED_CODE = "calendar_ready_video_operation_completed";
const METADATA_STAGES = new Set(["upload_start", "upload_resume", "upload_authorize_part", "upload_resolve_part", "upload_complete"]);
const STAGES = new Set([
  "upload_start", "upload_resume", "upload_authorize_part", "upload_resolve_part", "upload_complete",
  "provider_begin_multipart", "provider_authorize_part", "provider_resolve_authorization", "provider_accept_part",
  "provider_list_parts", "provider_finalize_multipart", "provider_inspect_object", "provider_stream_sealed", "provider_abort_multipart",
  "admission_reserve", "admission_assert_held", "admission_seal_storage", "admission_release_after_abort", "transfer_resolve_part", "transfer_accept_part"
]);
const REASONS = new Set(["unclassified", "ENOENT", "EACCES", "ENOSPC", "EIO", "EMFILE", "ENFILE", "EPERM", "ELOOP"]);
for (const [prefix, suffixes] of [
  ["disk_", "operation_unavailable provider_disabled owner_invalid record_invalid request_conflict state_conflict reservation_missing root_unsafe path_invalid receipt_conflict file_unsafe file_size_invalid receipt_invalid identity_conflict initialization_recovery_required seal_conflict operation_busy_or_recovery_required body_invalid transfer_timeout part_conflict authorization_invalid write_not_eligible write_binding_invalid part_invalid body_size_invalid body_checksum_invalid object_conflict manifest_conflict inspection_invalid inspection_pending read_invalid abort_conflict abort_recovery_required admission_unavailable reservation_binding_invalid reservation_owner_invalid cleanup_evidence_invalid seal_evidence_invalid global_capacity_refused"],
  ["disk_space_", "clock_invalid configuration_invalid evidence_invalid evidence_stale guard_disabled root_changed root_unsafe stats_invalid unavailable"],
  ["media_capacity_", "storage_unavailable schema_not_ready store_configuration_invalid async_transaction_forbidden disk_space_guard_invalid disk_space_evidence_invalid disk_space_insufficient reservation_conflict request_invalid paused ledger_full storage_exceeded job_not_found storage_not_held writes_not_allowed coordinator_required unavailable state_invalid clock_invalid configuration_invalid budget_exceeded queue_full"],
  ["media_transfer_", "storage_unavailable schema_not_ready state_invalid authorization_invalid authorization_expiry_invalid authorization_conflict authorization_revoked binding_invalid registry_disabled registry_full clock_invalid configuration_invalid store_configuration_invalid async_transaction_forbidden"],
  ["import_", "cancellation_pending clock_invalid configuration_invalid idempotency_conflict media_limits_exceeded media_verification_failed not_found operation_superseded operation_unavailable owner_invalid part_invalid provider_response_invalid provider_unavailable quota_exceeded remote_manifest_changed remote_parts_invalid request_invalid store_invalid transfer_unavailable upload_incomplete upload_not_cancellable upload_not_completable upload_not_writable upload_unavailable verification_pending transfer_busy transfer_not_found transfer_timeout transfer_bytes_invalid transfer_header_mismatch transfer_origin_forbidden transfer_body_invalid transfer_type_invalid transfer_header_invalid"],
  ["calendar_import_", "state_invalid not_found owner_invalid schema_not_ready store_configuration_invalid async_transaction_forbidden ready_video_original_required"]
]) for (const suffix of suffixes.split(" ")) REASONS.add(prefix + suffix);
const instances = new WeakMap();
function own(value, key) {
  try { const entry = value && Object.getOwnPropertyDescriptor(value, key); return entry && Object.hasOwn(entry, "value") ? entry.value : undefined; }
  catch { return undefined; }
}
function validReadyVideoFailure(stage, reasonCode) { return STAGES.has(stage) && REASONS.has(reasonCode); }
function validReadyVideoDiagnostic(code, stage, reasonCode) {
  return code === CODE ? validReadyVideoFailure(stage, reasonCode) :
    code === COMPLETED_CODE && METADATA_STAGES.has(stage) && reasonCode === "completed";
}
function createReadyVideoDiagnostics({ logger, owner, isEligibleOwner = () => true } = {}) {
  if (!UUID.test(owner?.companyId || "") || !UUID.test(owner?.userId || "") || typeof isEligibleOwner !== "function") return null;
  const instance = Object.freeze({});
  instances.set(instance, { logger, owner: Object.freeze({ companyId: owner.companyId, userId: owner.userId }), isEligibleOwner });
  return instance;
}
function emit(diagnostics, stage, context, error, started, completed = false) {
  try {
    const value = instances.get(diagnostics);
    if (!value || !STAGES.has(stage) || own(context, "companyId") !== value.owner.companyId ||
        own(context, "userId") !== value.owner.userId || value.isEligibleOwner(value.owner) !== true) return;
    if (completed && !METADATA_STAGES.has(stage)) return;
    const originalCode = own(error, "code"), reasonCode = completed ? "completed" : REASONS.has(originalCode) ? originalCode : "unclassified";
    const duration = Math.floor(performance.now() - started), elapsedMs = Number.isSafeInteger(duration) && duration >= 0 ? Math.min(duration, MAX_ELAPSED_MS) : 0;
    const event = Object.freeze({ component: "calendar_ready_video", code: completed ? COMPLETED_CODE : CODE, stage, reasonCode, elapsedMs });
    const pending = value.logger?.error?.(event);
    if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => {});
  } catch { /* Diagnostics cannot replace, suppress or retry the operation. */ }
}
async function observeReadyVideoOperation(diagnostics, stage, context, operation) {
  if (!instances.has(diagnostics)) return operation();
  const started = performance.now();
  try {
    const result = await operation();
    if (METADATA_STAGES.has(stage)) emit(diagnostics, stage, context, null, started, true);
    return result;
  }
  catch (error) { emit(diagnostics, stage, context, error, started); throw error; }
}
function wrapReadyVideoUploadDiagnostics(upload, diagnostics) {
  if (!instances.has(diagnostics)) return upload;
  const wrapper = { ...upload };
  for (const [method, stage] of Object.entries({ start: "upload_start", resume: "upload_resume", authorizePart: "upload_authorize_part",
    resolvePart: "upload_resolve_part", complete: "upload_complete" })) {
    if (typeof upload[method] === "function") wrapper[method] = (context, input) =>
      observeReadyVideoOperation(diagnostics, stage, context, () => upload[method](context, input));
  }
  return Object.freeze(wrapper);
}
module.exports = { CODE, COMPLETED_CODE, validReadyVideoFailure, validReadyVideoDiagnostic,
  createReadyVideoDiagnostics, observeReadyVideoOperation, wrapReadyVideoUploadDiagnostics };
