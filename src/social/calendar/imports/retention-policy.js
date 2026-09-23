"use strict";

// No age alone makes a media file disposable. The pilot retains everything by
// default; only already-aborted multipart identity tombstones have a candidate
// cleanup route. Successful originals/derivatives keep their edit/history refs.
const { isDeepStrictEqual } = require("node:util");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
function fail(code) { throw Object.assign(new Error(`media_retention_${code}`), { code: `media_retention_${code}`, statusCode: 409 }); }
const plain = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
function validateRetentionState(value, companyId, uploads) {
  if (value === undefined) return;
  if (!plain(value) || value.schema !== 1 || !plain(value.records) || Object.keys(value.records).length > 1000) fail("state_invalid");
  for (const [assetId, row] of Object.entries(value.records)) {
    const upload = uploads[row?.uploadId];
    if (!UUID.test(assetId) || !plain(row) || row.assetId !== assetId || row.companyId !== companyId ||
        !upload || upload.assetId !== assetId || upload.userId !== row.userId || upload.companyId !== companyId ||
        upload.state !== "cancelled" || upload.disk?.phase !== "aborted" || upload.disk.cleanupVerified !== true ||
        row.objectKey !== upload.objectKey || row.objectVersion !== upload.disk.objectVersion ||
        !["intent", "files_removed"].includes(row.phase) || !UUID.test(row.cleanupId || "") ||
        !HASH.test(row.manifestSha256 || "") || !Number.isSafeInteger(row.createdAt) || row.createdAt < 1 ||
        !Number.isSafeInteger(row.identityBytes) || row.identityBytes < 1 || row.identityBytes > 65536 ||
        row.phase === "files_removed" && (!HASH.test(row.cleanupProof || "") || !Number.isSafeInteger(row.removedAt) || row.removedAt < row.createdAt)) fail("state_invalid");
  }
}
function references(state, calendar, assetId) {
  const prep = Object.values(state.preparation?.jobs || {}).filter(row => row.assetId === assetId);
  const schedules = Object.values(calendar.jobs || {}).filter(row => row.import?.assetId === assetId)
    .concat(Object.values(calendar.importSubmissions || {}).filter(row => row.request?.assetId === assetId));
  const executions = [state.preparationExecutions, state.inspectionExecutions]
    .flatMap(value => Object.values(value?.records || {})).filter(row => row.task?.assetId === assetId);
  for (const row of Object.values(state.workflowExecutions?.records || {})) {
    // Persisted Workflow records do not duplicate task/asset fields: resolve the
    // authoritative predecessor as the real Workflow journal does.
    const predecessor = state[row.kind === "inspect" ? "inspectionExecutions" : "preparationExecutions"]?.records?.[row.dispatchKey];
    if (predecessor?.task?.assetId === assetId) executions.push({ ...row, phase: row.delivered?.state || "unknown" });
  }
  return { prep, schedules, executions,
    outbox: Object.values(state.prepareOutbox || {}).filter(row => row.assetId === assetId),
    origins: [ ...Object.entries(calendar.importedSources?.origins || {}).filter(([key, row]) => key === assetId || row.assetId === assetId),
      ...Object.values(calendar.importedSources?.requests || {}).filter(row => row.receipt?.upload?.assetId === assetId) ],
    asset: state.preparation?.assets?.[assetId] || null };
}
function classifyRetention(state, calendar, uploadId, now) {
  const upload = state.uploads[uploadId];
  if (!upload) fail("not_found");
  const refs = references(state, calendar, upload.assetId);
  const uncertain = refs.executions.some(row => !["failed", "succeeded", "settled"].includes(row.phase)) ||
    refs.prep.some(row => row.state === "reconciliation") || refs.schedules.some(row =>
      ["dispatching", "confirming"].includes(row.phase) || Object.values(row.deliveries || {}).some(target =>
        ["dispatching", "confirming"].includes(target.phase)));
  const processing = refs.prep.some(row => ["queued", "dispatching", "processing"].includes(row.state));
  let category = uncertain ? "uncertain_result" : refs.schedules.length ? "scheduled_or_history" : processing ? "preparing" :
    upload.state === "uploaded" || refs.asset || refs.prep.length || refs.outbox.length || refs.origins.length || refs.executions.length ? "original_needed" :
    ["created", "uploading", "verifying", "cancel_pending"].includes(upload.state) ? "incomplete_upload" : "unreferenced";
  const noReferences = !refs.prep.length && !refs.schedules.length && !refs.executions.length && !refs.outbox.length && !refs.asset && !refs.origins.length;
  const terminalTombstone = category === "unreferenced" && noReferences && upload.state === "cancelled" && upload.lease === null &&
    upload.disk?.phase === "aborted" && upload.disk.cleanupVerified === true && Object.keys(upload.disk.parts || {}).length === 0;
  return { category, referenceCount: refs.prep.length + refs.schedules.length + refs.executions.length + refs.outbox.length + refs.origins.length + Number(Boolean(refs.asset)),
    terminalTombstone, ageMs: Math.max(0, now - upload.updatedAt), existingIntent: Boolean(state.retention?.records?.[upload.assetId]) };
}
function frozenAsset(state, assetId) {
  const pick = value => Object.fromEntries(Object.entries(value || {}).filter(([, row]) =>
    row.assetId === assetId || row.task?.assetId === assetId || row.binding?.assetId === assetId));
  return { uploads: pick(state.uploads), outbox: pick(state.prepareOutbox), asset: state.preparation?.assets?.[assetId] || null,
    jobs: pick(state.preparation?.jobs), preparation: pick(state.preparationExecutions?.records),
    inspection: pick(state.inspectionExecutions?.records), workflows: Object.fromEntries(Object.entries(state.workflowExecutions?.records || {})
      .filter(([, row]) => state[row.kind === "inspect" ? "inspectionExecutions" : "preparationExecutions"]?.records?.[row.dispatchKey]?.task?.assetId === assetId)) };
}
function assertRetentionMutation(before, after) {
  if (!isDeepStrictEqual(before.retention, after.retention)) fail("collector_only");
  for (const assetId of Object.keys(before.retention?.records || {})) {
    if (!isDeepStrictEqual(frozenAsset(before, assetId), frozenAsset(after, assetId))) fail("asset_retired");
  }
}
function calendarAssetIds(state) { return [...new Set([
  ...Object.values(state.jobs || {}).map(row => row.import?.assetId),
  ...Object.values(state.importSubmissions || {}).map(row => row.request?.assetId),
  ...Object.keys(state.importedSources?.origins || {}),
  ...Object.values(state.importedSources?.requests || {}).map(row => row.receipt?.upload?.assetId)
].filter(value => UUID.test(value || "")))]; }
function assertCalendarRetention(state, imports) {
  for (const assetId of calendarAssetIds(state)) if (imports?.retention?.records?.[assetId]) fail("asset_retired");
}
module.exports = { validateRetentionState, classifyRetention, assertRetentionMutation, calendarAssetIds, assertCalendarRetention };
