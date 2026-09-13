"use strict";

// Declarative candidate only: constructing or inspecting it never reads env,
// opens a pool, starts a worker, runs SQL, mutates Instagram gates or bills.
const { DEFAULT_LIMITS: CAPACITY } = require("./global-capacity");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SCHEMA = Object.freeze([
  Object.freeze({ version: 2, file: "0002_import_upload_state.up.sql", relation: "import_upload_state", runtimeRole: "ia4tube_social_runtime" }),
  Object.freeze({ version: 3, file: "0003_global_media_capacity.up.sql", relation: "global_media_capacity", runtimeRole: "ia4tube_media_capacity_runtime" }),
  Object.freeze({ version: 4, file: "0004_transfer_authorization_registry.up.sql", relation: "transfer_authorization_registry", runtimeRole: "ia4tube_media_transfer_runtime" })
]);
function fail(code) { throw Object.assign(new Error(`media_pilot_${code}`), { code: `media_pilot_${code}`, statusCode: 503 }); }
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function createMediaPilotCandidate({ owner = null, region = null, workflowTaskSlug = null } = {}) {
  if (owner !== null && (!owner || Object.keys(owner).length !== 2 || !UUID.test(owner.companyId || "") || !UUID.test(owner.userId || ""))) fail("owner_invalid");
  if (region !== null && !["oregon", "ohio", "virginia", "frankfurt", "singapore"].includes(region)) fail("region_invalid");
  if (workflowTaskSlug !== null && !/^[a-z0-9][a-z0-9-]{1,79}\/prepareCalendarMedia$/.test(workflowTaskSlug)) fail("task_invalid");
  return freeze({ candidateVersion: 1, kind: "render_media_owner_pilot_candidate", enabled: false,
    destinations: { apiServiceId: "srv-d8708kd7vvec73ap1p6g", apiOrigin: "https://ia4tube-api.onrender.com",
      databaseName: "ia4tube-social-production", diskMount: "/var/data", diskCapacityBytesObserved: 10000000000,
      diskId: null, region, workflowTaskSlug, workflowInstance: "flex" },
    proposedPrivateRoots: { uploads: "/var/data/private/calendar-media/uploads", prepared: "/var/data/private/calendar-media/prepared",
      music: "/var/data/private/calendar-media/music" },
    access: { mode: "owner_pilot", allowedOwners: owner ? [{ ...owner, audience: "owner_pilot" }] : [] },
    processing: { ...CAPACITY, concurrentJobs: 1, maxRuntimeMs: 180000, windowsMaxProcesses: 4, linuxMaxTasksIncludingThreads: 64,
      linuxCpuQuotaCores: 1, processMemoryBytes: 512 * 1024 ** 2,
      workflowRetries: 0, workflowArgumentsMediaAllowed: false, workflowArgumentsCredentialsAllowed: false,
      receivesInstagramSecret: false, receivesDatabaseCredential: false },
    transfer: { chunkBytes: 5 * 1024 ** 2, transferTimeoutMs: 60000, simultaneousTransfers: 2, arbitraryUrlsAllowed: false },
    retention: { mode: "retain_all", scheduledDeletion: false, blockAdmissionAtCapacity: true, expiryApproved: false },
    gatesRequiredDuringPreparation: { SOCIAL_EXTERNAL_CONNECTION_ENABLED: "false", SOCIAL_EXTERNAL_PUBLICATION_ENABLED: "false" },
    schema: { prerequisiteCalendarVersion: 1, candidates: SCHEMA, socialVersionsToApply: [], startupMigrations: false },
    finance: { additionalAbsoluteCeilingUsd: 5, variableBillingAccepted: false, providerEnforcedCeilingProved: false,
      applicationCountersAreInvoiceCap: false, activationAuthorized: false },
    activationAllowed: false });
}
function inspectMediaPilotReadiness(candidate) {
  // Do not accept a forged `{ enabled:true }` as an executable runtime. This
  // report intentionally has no activation capability; live proof is separate.
  if (candidate?.kind !== "render_media_owner_pilot_candidate" || candidate.enabled !== false || candidate.activationAllowed !== false ||
      candidate.schema?.startupMigrations !== false || candidate.finance?.activationAuthorized !== false ||
      candidate.retention?.mode !== "retain_all" || candidate.processing?.workflowRetries !== 0 ||
      candidate.gatesRequiredDuringPreparation?.SOCIAL_EXTERNAL_CONNECTION_ENABLED !== "false" ||
      candidate.gatesRequiredDuringPreparation?.SOCIAL_EXTERNAL_PUBLICATION_ENABLED !== "false") fail("candidate_changed");
  return freeze({ activationAllowed: false, migrationExecuted: false, gatesMutated: false, chargesActivated: false,
    requiredObservations: ["exact_service_database_disk_and_same_region", "remote_additive_schema_and_restricted_roles",
      "free_disk_and_reserved_margin", "linux_render_controls_and_task_termination", "private_delivery_and_proxy_log_redaction",
      "workflow_actual_runtime_resource_and_egress_measurement", "flow_file_origin_and_rights", "owner_pilot_deadline",
      ...(candidate.access.allowedOwners.length ? [] : ["existing_owner_user_company_pair"]),
      "financial_condition_compatible_with_absolute_usd5_or_explicit_owner_change"] });
}
module.exports = { createMediaPilotCandidate, inspectMediaPilotReadiness, CALENDAR_PILOT_SCHEMA: SCHEMA };
