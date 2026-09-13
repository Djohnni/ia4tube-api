"use strict";
// Complete composition candidate; nothing is instantiated from process.env or
// enabled at API startup. Existing schema verification and owner admission stay
// mandatory. Heavy output decode takes place only in the Workflow native tree.
const { createWorkflowPrivateJournal, fail } = require("./workflow-private-journal");
const { createWorkflowPrivateBridge } = require("./workflow-private-transfer");
const { createWorkflowProcessWorker } = require("./workflow-process-worker");
const { createPreparedDiskResultStore } = require("./prepared-disk-store");
const { createPreparedDiskOutputInspector } = require("./prepared-disk-output-inspector");
const { createOperationalPreparationRunner } = require("./operational-preparation-runner");
const { createOperationalInspectionRunner } = require("./operational-inspection-runner");
const { createDurableInspectionDispatcher } = require("./inspection-dispatcher");
const { createRenderDiskPrivateUploadProvider } = require("./render-disk-provider");
const { createCalendarImportUploadService } = require("./upload-service");
const { createPreparationQueue } = require("./preparation-queue");
async function createWorkflowOperationalComponents({ enabled = false, store, owner, capacity, sourceAdmission, preparedAdmission, accessPolicy, diskSpaceGuard,
  privateRoot, preparationRoot, publicApiOrigin, musicRoot, resolveMusicTrack, catalog, bridgeKey, adapter,
  remoteRuntimeVerified = false, allowControlledForTests = false, clock = Date.now } = {}) {
  if (!enabled) return Object.freeze({ available: false, reason: "workflow_disabled" });
  if (await store?.verify?.() !== true || capacity?.capabilities?.persistence !== "durable") fail("schema_not_ready");
  let resultStore, provider, preparationRunner, inspectionRunner;
  const journal = createWorkflowPrivateJournal({ store, owner, clock });
  const bridge = createWorkflowPrivateBridge({ journal, key: bridgeKey, privateRoot, preparationRoot, musicRoot, resolveMusicTrack, clock,
    allowSyntheticForTests: allowControlledForTests, provider: { streamSealedObject: args => provider.streamSealedObject(args) }, getResultStore: () => resultStore,
    assertHeld: (task, kind, resultRef) => kind === "inspect" ? inspectionRunner.assertExecutionHeld({ task, snapshotBytes: task.sizeBytes, maxRuntimeMs: task.maxRuntimeMs }) :
      preparedAdmission.assertHeld({ task, resultRef, requiredBytes: 65536, intent: "write" }) });
  const worker = createWorkflowProcessWorker({ bridge, adapter, allowControlledForTests, remoteRuntimeVerified });
  resultStore = createPreparedDiskResultStore({ rootDirectory: privateRoot, preparationRoot, tenantStore: store, admission: preparedAdmission, accessPolicy,
    outputInspector: createPreparedDiskOutputInspector({ workflowBridge: bridge }), enabled: true, clock });
  preparationRunner = createOperationalPreparationRunner({ store, owner, capacity, admission: preparedAdmission, accessPolicy, getWorker: () => worker,
    enabled: true, syntheticMediaForLocalTests: allowControlledForTests, clock });
  inspectionRunner = createOperationalInspectionRunner({ store, owner, capacity, accessPolicy, diskSpaceGuard, getWorker: () => worker, enabled: true, clock });
  const inspector = createDurableInspectionDispatcher({ store, runner: inspectionRunner, accessPolicy, enabled: true, clock });
  provider = createRenderDiskPrivateUploadProvider({ rootDirectory: privateRoot, store, admission: sourceAdmission, inspector, transferOrigin: publicApiOrigin, enabled: true, clock });
  const upload = createCalendarImportUploadService({ store, provider, enabled: true, clock });
  const preparation = createPreparationQueue({ store, dispatcher: preparationRunner, resultStore, accessPolicy, enabled: true, catalog,
    allowSyntheticForTests: allowControlledForTests, clock });
  return Object.freeze({ available: true, bridge, journal, worker, preparationRunner, inspectionRunner, inspector, provider, upload, preparation, resultStore,
    handlePrivateRequest: (req, res) => bridge.handle(req, res) });
}
module.exports = { createWorkflowOperationalComponents };
