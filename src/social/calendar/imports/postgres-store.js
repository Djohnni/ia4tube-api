"use strict";
const { withTransaction } = require("../../../persistence/postgres/pool");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_UPLOADS = 1000;
const instances = new WeakSet();
function fail(code) {
  const error = new Error("O armazenamento da importação não está disponível.");
  error.code = `calendar_import_${code}`; error.statusCode = 503; throw error;
}
function object(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function validateImportUploadState(state, companyId) {
  if (!object(state) || state.schema !== 1 || !Number.isSafeInteger(state.reservedBytes) || state.reservedBytes < 0 ||
      !object(state.uploads) || !object(state.idempotency) || !object(state.prepareOutbox) ||
      Object.keys(state.uploads).length > MAX_UPLOADS || Object.keys(state.idempotency).length > MAX_UPLOADS ||
      Object.keys(state.prepareOutbox).length > MAX_UPLOADS || Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_DOCUMENT_BYTES) fail("state_invalid");
  for (const [id, upload] of Object.entries(state.uploads)) {
    if (!UUID.test(id) || !object(upload) || upload.uploadId !== id || upload.companyId !== companyId ||
        !UUID.test(upload.userId || "") || !UUID.test(upload.assetId || "")) fail("state_invalid");
    if (upload.disk !== undefined) {
      try { require("./render-disk-provider").validateDiskUploadRecord(upload); }
      catch (_) { fail("state_invalid"); }
    }
  }
  for (const [key, id] of Object.entries(state.idempotency)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !Object.hasOwn(state.uploads, id)) fail("state_invalid");
  }
  for (const job of Object.values(state.prepareOutbox)) {
    if (!object(job) || job.companyId !== companyId || !Object.hasOwn(state.uploads, job.uploadId) ||
        state.uploads[job.uploadId].assetId !== job.assetId || state.uploads[job.uploadId].userId !== job.userId) fail("state_invalid");
  }
  if (state.preparation !== undefined) {
    require("./preparation-queue").validatePreparationState(state.preparation, companyId, state.uploads);
  }
  if (state.preparationExecutions !== undefined) {
    require("./preparation-execution-journal").validatePreparationExecutionState(
      state.preparationExecutions, companyId, state.uploads, state.preparation);
  }
  if (state.inspectionExecutions !== undefined) {
    require("./preparation-execution-journal").validateInspectionExecutionState(state.inspectionExecutions, companyId, state.uploads);
  }
  require("./inspection-dispatcher").validateInspectionDispatchState(state, companyId);
  if (state.workflowExecutions !== undefined) require("./workflow-private-journal").validateWorkflowPrivateState(state.workflowExecutions, companyId, state);
  require("./retention-policy").validateRetentionState(state.retention, companyId, state.uploads);
  return state;
}
function createImportUploadPostgresStore({ pool, role = "ia4tube_social_runtime" }) {
  if (!pool || typeof pool.connect !== "function" || role !== "ia4tube_social_runtime") fail("store_configuration_invalid");
  const store = Object.freeze({
    capabilities: Object.freeze({ persistence: "durable", atomicCompanyUpdates: true }),
    async read(companyId, operation) {
      if (!UUID.test(companyId || "") || typeof operation !== "function") fail("owner_invalid");
      return withTransaction(pool, async client => {
        const result = await client.query("SELECT document FROM ia4tube_calendar.import_upload_state WHERE company_id=$1", [companyId]);
        if (!result.rows[0]) fail("not_found");
        return structuredClone(await operation(validateImportUploadState(result.rows[0].document, companyId)));
      }, { companyId, role });
    },
    async verify() {
      const result = await pool.query(`SELECT c.relrowsecurity AS rls,c.relforcerowsecurity AS forced,
        pg_get_userbyid(c.relowner) AS owner,
        (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid) AS policies,
        (SELECT pg_get_expr(p.polqual,p.polrelid) FROM pg_policy p WHERE p.polrelid=c.oid LIMIT 1) AS scope_using,
        (SELECT pg_get_expr(p.polwithcheck,p.polrelid) FROM pg_policy p WHERE p.polrelid=c.oid LIMIT 1) AS scope_check,
        EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS custom_trigger,
        EXISTS(SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee=0) AS public_table_access,
        EXISTS(SELECT 1 FROM aclexplode(n.nspacl) a WHERE a.grantee=0) AS public_schema_access,
        EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN ($1,current_user,session_user)
          AND (r.rolsuper OR r.rolbypassrls)) AS unsafe_principal,
        pg_get_userbyid(c.relowner) IN (current_user,session_user) AS session_owns_table,
        has_column_privilege($1,c.oid,'company_id','UPDATE') AS owner_mutable,
        has_table_privilege($1,c.oid,'SELECT') AS readable,
        has_table_privilege($1,c.oid,'INSERT') AS insertable,
        has_column_privilege($1,c.oid,'document','UPDATE') AS document_mutable,
        has_table_privilege($1,c.oid,'TRUNCATE') AS truncatable,
        has_table_privilege($1,c.oid,'DELETE') AS deletable,
        has_schema_privilege($1,n.oid,'CREATE') AS creatable
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='ia4tube_calendar' AND c.relname='import_upload_state'`, [role]);
      const row = result.rows?.[0];
      const normalize = value => String(value || "").replace(/[\s()]/g, "").replace(/::text/g, "").toLowerCase();
      const scope = normalize("company_id = nullif(current_setting('ia4tube.company_id', true), '')::uuid");
      if (result.rows?.length !== 1 || !row.rls || !row.forced || row.owner !== "ia4tube_social_owner" ||
          Number(row.policies) !== 1 || !row.readable || !row.insertable || !row.document_mutable ||
          row.truncatable || row.deletable || row.creatable || row.custom_trigger || row.public_table_access ||
          row.public_schema_access || row.unsafe_principal || row.session_owns_table || row.owner_mutable || normalize(row.scope_using) !== scope ||
          normalize(row.scope_check) !== scope) fail("schema_not_ready");
      return true;
    },
    async update(companyId, operation) {
      if (!UUID.test(companyId || "") || typeof operation !== "function") fail("owner_invalid");
      if (operation.constructor?.name === "AsyncFunction") fail("async_transaction_forbidden");
      return withTransaction(pool, async client => {
        // Serialize quota, idempotency, record and outbox changes even before the owner's first row exists.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`calendar-import:${companyId}`]);
        const found = await client.query("SELECT document FROM ia4tube_calendar.import_upload_state WHERE company_id=$1 FOR UPDATE", [companyId]);
        const fresh = () => require("./upload-service").freshImportUploadState();
        const state = validateImportUploadState(found.rows[0]?.document || fresh(), companyId);
        const retainedBefore = structuredClone(state);
        const before = found.rows[0] ? JSON.stringify(state) : null;
        const result = operation(state);
        if (result && typeof result.then === "function") {
          Promise.resolve(result).catch(() => {});
          fail("async_transaction_forbidden");
        }
        validateImportUploadState(state, companyId);
        require("./retention-policy").assertRetentionMutation(retainedBefore, state);
        const after = JSON.stringify(state);
        if (after !== before) await client.query(`INSERT INTO ia4tube_calendar.import_upload_state(company_id,document)
          VALUES($1,$2::jsonb) ON CONFLICT(company_id) DO UPDATE SET document=EXCLUDED.document,
          revision=import_upload_state.revision+1,updated_at=CURRENT_TIMESTAMP`, [companyId, after]);
        // withTransaction commits before resolving. It never replays an uncertain commit.
        return structuredClone(result);
      }, { companyId, role });
    }
  });
  instances.add(store); return store;
}
function isImportUploadPostgresStore(value) { return instances.has(value); }
module.exports = { createImportUploadPostgresStore, isImportUploadPostgresStore, validateImportUploadState };
