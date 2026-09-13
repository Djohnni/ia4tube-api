"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { classifyRetention, assertRetentionMutation } = require("../src/social/calendar/imports/retention-policy");
const { createMediaPilotCandidate, inspectMediaPilotReadiness, CALENDAR_PILOT_SCHEMA } = require("../src/social/calendar/imports/pilot-configuration");
function state() {
  const uploadId = crypto.randomUUID(), assetId = crypto.randomUUID();
  const upload = { uploadId, assetId, state: "cancelled", lease: null, updatedAt: 1,
    disk: { phase: "aborted", cleanupVerified: true, parts: {} } };
  return { uploadId, assetId, input: { uploads: { [uploadId]: upload }, prepareOutbox: {} }, calendar: { jobs: {} } };
}
test("retention classifies all six states and never makes current sources/results disposable by age", () => {
  const values = [
    ["incomplete_upload", f => { f.input.uploads[f.uploadId].state = "uploading"; }],
    ["original_needed", f => { f.input.uploads[f.uploadId].state = "uploaded"; }],
    ["preparing", f => { f.input.preparation = { jobs: { a: { assetId: f.assetId, state: "processing" } } }; }],
    ["scheduled_or_history", f => { f.calendar.jobs.a = { phase: "cancelled", import: { assetId: f.assetId } }; }],
    ["uncertain_result", f => { f.input.inspectionExecutions = { records: { a: { phase: "unknown", task: { assetId: f.assetId } } } }; }],
    ["unreferenced", () => {}]
  ];
  for (const [expected, arrange] of values) {
    const f = state(); arrange(f); const result = classifyRetention(f.input, f.calendar, f.uploadId, 10 ** 12);
    assert.equal(result.category, expected); assert.equal(result.terminalTombstone, expected === "unreferenced");
  }
});
test("retention resolves actual persisted Workflow shape and per-target delivery uncertainty", () => {
  const f = state(), key = "a".repeat(64), id = crypto.randomUUID();
  f.input.preparationExecutions = { schema: 1, records: { [key]: { executionId: id, phase: "succeeded", task: { assetId: f.assetId } } } };
  f.input.workflowExecutions = { schema: 1, records: { [id]: { executionId: id, kind: "prepare", dispatchKey: key,
    dispatchAttempted: true, runId: null, agentId: null, delivered: null } } };
  assert.equal(classifyRetention(f.input, f.calendar, f.uploadId, 10 ** 12).category, "uncertain_result");
  f.input.workflowExecutions.records[id].delivered = { state: "succeeded" };
  assert.equal(classifyRetention(f.input, f.calendar, f.uploadId, 10 ** 12).category, "original_needed");
  f.calendar.jobs.a = { phase: "partial", import: { assetId: f.assetId }, deliveries: { feed: { phase: "published" }, story: { phase: "confirming" } } };
  assert.equal(classifyRetention(f.input, f.calendar, f.uploadId, 10 ** 12).category, "uncertain_result");
});
test("completed execution, source copy reference and live lease also preserve tombstones", () => {
  for (const arrange of [f => { f.input.inspectionExecutions = { records: { a: { phase: "succeeded", task: { assetId: f.assetId } } } }; },
    f => { f.input.prepareOutbox.a = { assetId: f.assetId }; }, f => { f.input.uploads[f.uploadId].lease = { deadlineAt: 0 }; }]) {
    const f = state(); arrange(f); assert.equal(classifyRetention(f.input, f.calendar, f.uploadId, 10 ** 12).terminalTombstone, false);
  }
});
test("ordinary tenant update cannot add, remove or revise a retention fence", () => {
  const f = state(), next = structuredClone(f.input); next.retention = { records: {} };
  assert.throws(() => assertRetentionMutation(f.input, next), { code: "media_retention_collector_only" });
});
test("pilot configuration is deeply frozen, defaults disabled, exact candidate schemas only and no invoice-cap claim", () => {
  const flags = ["SOCIAL_EXTERNAL_CONNECTION_ENABLED", "SOCIAL_EXTERNAL_PUBLICATION_ENABLED", "SOCIAL_CALENDAR_ENABLED"];
  const prior = flags.map(key => process.env[key]), config = createMediaPilotCandidate();
  assert.equal(config.enabled, false); assert.equal(config.activationAllowed, false);
  assert.deepEqual(config.schema.socialVersionsToApply, []); assert.equal(config.schema.startupMigrations, false);
  assert.deepEqual(CALENDAR_PILOT_SCHEMA.map(row => row.version), [2, 3, 4]);
  assert.equal(config.retention.mode, "retain_all"); assert.equal(config.retention.expiryApproved, false);
  assert.equal(config.finance.providerEnforcedCeilingProved, false); assert.equal(config.finance.additionalAbsoluteCeilingUsd, 5);
  assert.equal(config.processing.workflowRetries, 0); assert.equal(config.processing.concurrentJobs, 1);
  assert.equal(config.processing.receivesInstagramSecret, false); assert.equal(config.processing.receivesDatabaseCredential, false);
  assert.deepEqual(config.gatesRequiredDuringPreparation, { SOCIAL_EXTERNAL_CONNECTION_ENABLED: "false", SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false" });
  assert.throws(() => { config.retention.mode = "delete_all"; }, TypeError);
  assert.equal(flags.every((key, i) => process.env[key] === prior[i]), true, "candidate must not mutate existing flags");
  const report = inspectMediaPilotReadiness(config);
  assert.equal(report.activationAllowed, false); assert.equal(report.migrationExecuted, false); assert.equal(report.gatesMutated, false);
  assert.throws(() => inspectMediaPilotReadiness({ ...config, enabled: true }), { code: "media_pilot_candidate_changed" });
});
test("pilot config rejects arbitrary origins/owner/task inputs and missing music is an explicit observation", () => {
  assert.throws(() => createMediaPilotCandidate({ owner: { companyId: "other", userId: "other" } }), { code: "media_pilot_owner_invalid" });
  assert.throws(() => createMediaPilotCandidate({ workflowTaskSlug: "https://other.invalid" }), { code: "media_pilot_task_invalid" });
  const config = createMediaPilotCandidate({ owner: { companyId: crypto.randomUUID(), userId: crypto.randomUUID() } });
  assert.equal(config.access.allowedOwners.length, 1);
  assert.ok(inspectMediaPilotReadiness(config).requiredObservations.includes("flow_file_origin_and_rights"));
});
