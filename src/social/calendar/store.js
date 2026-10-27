"use strict";
const { withTransaction, quoteIdentifier } = require("../../persistence/postgres/pool");
const { freshState, UUID, fail, MAX_ITEMS } = require("./model");
const stores = new WeakSet();
function validate(state) {
  if (!state || state.schema !== 1 || !state.preferences || typeof state.preferences.enabled !== "boolean" ||
      !state.jobs || Array.isArray(state.jobs) || Object.keys(state.jobs).length > MAX_ITEMS || Buffer.byteLength(JSON.stringify(state), "utf8") > 8 * 1024 * 1024) fail("calendar_state_invalid", 503);
  require("./imports/calendar-submissions").validateCalendarSubmissions(state);
  return state;
}
const MEDIA_READ_TIMEOUT_MS = 300000;
const mediaReadAdmissions = new WeakMap();
function mediaReadError(code = "unavailable") {
  return Object.assign(new Error("A leitura da mídia não pôde continuar."), {
    code: `calendar_media_read_${code}`, statusCode: code === "aborted" ? 499 : code === "timeout" ? 408 : 503
  });
}
function reserveMediaReadSlot(pool) {
  let admission = mediaReadAdmissions.get(pool);
  if (!admission) {
    const maximum = pool.options?.max;
    const limit = Number.isSafeInteger(maximum) && maximum > 0 ? Math.min(2, maximum - 1) : 2;
    admission = { limit, active: 0, waiting: [] }; mediaReadAdmissions.set(pool, admission);
  }
  if (admission.limit < 1) throw mediaReadError();
  let done = false, held = false, resolve;
  const promise = new Promise(accept => { resolve = accept; });
  function drain() {
    while (admission.active < admission.limit && admission.waiting.length) admission.waiting.shift()();
  }
  function grant() { if (!done) { held = true; admission.active++; resolve(); } }
  function release() {
    if (done) return; done = true;
    if (held) admission.active--;
    else { const index = admission.waiting.indexOf(grant); if (index >= 0) admission.waiting.splice(index, 1); }
    drain();
  }
  admission.waiting.push(grant); drain();
  return { promise, release };
}
// This server-only reader supplies fresh facts, not authorization. Its callers
// still verify the exact user/job/grant before emitting every 64 KiB block.
async function withMediaReadSession(pool, role, companyId, options, operation) {
  if (!UUID.test(companyId || "") || role !== "ia4tube_social_runtime" ||
      !options || Object.getPrototypeOf(options) !== Object.prototype ||
      Object.keys(options).some(key => !["userId", "connectionId", "signal", "timeoutMs"].includes(key)) ||
      !UUID.test(options.userId || "") ||
      options.connectionId !== undefined && !UUID.test(options.connectionId || "") ||
      options.signal !== undefined && !(options.signal instanceof AbortSignal) || typeof operation !== "function") {
    fail("calendar_owner_invalid", 403);
  }
  const timeoutMs = options.timeoutMs ?? MEDIA_READ_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MEDIA_READ_TIMEOUT_MS) fail("calendar_media_read_invalid", 400);
  const company = companyId.toLowerCase(), connectionId = options.connectionId?.toLowerCase();
  const projection = connectionId ? require("../../persistence/postgres/social-connector-store")
    .currentConnectionReadProjection({ companyId: company, provider: "instagram", statementTime: true }) : null;
  const sql = `SELECT calendar.document AS calendar_document, imports.document->'retention' AS import_retention,
    ${projection ? "to_jsonb(current_connection)" : "NULL::jsonb"} AS connection
    FROM ia4tube_calendar.owner_state calendar
    LEFT JOIN ia4tube_calendar.import_upload_state imports ON imports.company_id=calendar.company_id
    ${projection ? `LEFT JOIN LATERAL (${projection.text}) current_connection ON TRUE` : ""}
    WHERE calendar.company_id=$1`;
  let client = null, admission = null, released = false, started = false, ended = false, busy = false, stopError = null;
  let stop;
  const stopped = new Promise((_, reject) => { stop = reject; });
  stopped.catch(() => {});
  function discard(error) {
    if (client && !released) { released = true; client.release(error); }
  }
  function interrupt(error) {
    if (!stopError) { stopError = error; stop(error); }
    discard(stopError);
    admission?.release();
  }
  const onAbort = () => interrupt(mediaReadError("aborted"));
  const onConnectionError = () => interrupt(mediaReadError());
  function guard() {
    if (stopError) throw stopError;
    if (ended) throw mediaReadError("closed");
    if (options.signal?.aborted) { onAbort(); throw stopError; }
  }
  const timer = setTimeout(() => interrupt(mediaReadError("timeout")), timeoutMs);
  timer.unref?.();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  async function query(text, values) {
    guard();
    try {
      const result = await Promise.race([client.query(text, values), stopped]);
      guard(); return result;
    } catch (error) {
      if (error !== stopError) interrupt(mediaReadError());
      throw stopError;
    }
  }
  async function initialize() {
    if (client) return;
    guard();
    // Do not reserve a client before the file preflight: it may need the same
    // three-client pool. Media readers share at most two slots across stores,
    // keeping a client available for cancellation, revocation and legacy work.
    admission = reserveMediaReadSlot(pool);
    await Promise.race([admission.promise, stopped]); guard();
    // A late acquisition after cancellation is discarded.
    const acquiring = Promise.resolve().then(() => pool.connect()).then(value => {
      if (ended || stopError) { value.release(stopError || mediaReadError("closed")); return; }
      client = value; client.on?.("error", onConnectionError); return value;
    });
    try { await Promise.race([acquiring, stopped]); }
    catch (error) { if (error !== stopError) interrupt(mediaReadError()); throw stopError; }
    guard();
    await query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY"); started = true;
    await query(`SET LOCAL ROLE ${quoteIdentifier(role)}`);
    await query("SELECT set_config('ia4tube.company_id', $1, true), " +
      "set_config('statement_timeout', $2, true), set_config('idle_in_transaction_session_timeout', $2, true)",
    [company, `${timeoutMs}ms`]);
  }
  const session = Object.freeze({ async read() {
    guard(); if (busy) throw mediaReadError("busy"); busy = true;
    try {
      await initialize();
      const result = await query(sql, projection ? projection.values : [company]);
      if (result.rows?.length !== 1) fail("calendar_not_found", 404);
      const row = result.rows[0], state = validate(row.calendar_document);
      require("./imports/retention-policy").assertCalendarRetention(state, { retention: row.import_retention });
      const connection = projection ? projection.map(row.connection) : null;
      if (connection && connection.id !== connectionId) fail("calendar_connection_changed", 409);
      guard(); return structuredClone({ state, connection });
    } finally { busy = false; }
  } });
  try {
    guard();
    const result = await Promise.race([Promise.resolve().then(() => { guard(); return operation(session); }), stopped]);
    guard();
    if (busy) { interrupt(mediaReadError("busy")); throw stopError; }
    if (started) { await query("COMMIT"); started = false; }
    return result;
  } catch (error) {
    if (busy) interrupt(stopError || mediaReadError());
    if (started && !released) {
      try { await query("ROLLBACK"); started = false; }
      catch (_) { discard(stopError || mediaReadError()); }
    }
    throw error;
  } finally {
    ended = true; clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort);
    if (client) {
      if (!released) { released = true; client.release(); }
      client.removeListener?.("error", onConnectionError);
    }
    admission?.release();
  }
}
function createCalendarStore({ pool, role }) {
  const store = Object.freeze({
    capabilities: Object.freeze({ persistence: "postgres", durable: true }),
    withMediaReadSession(companyId, options, operation) {
      return withMediaReadSession(pool, role, companyId, options, operation);
    },
    async read(companyId, operation) {
      if (!UUID.test(companyId) || typeof operation !== "function") fail("calendar_owner_invalid", 403);
      return withTransaction(pool, async client => {
        const rows = await client.query("SELECT document FROM ia4tube_calendar.owner_state WHERE company_id=$1", [companyId]);
        if (!rows.rows[0]) fail("calendar_not_found", 404);
        return structuredClone(await operation(validate(rows.rows[0].document)));
      }, { companyId, role });
    },
    async exists(companyId) {
      if (!UUID.test(companyId)) fail("calendar_owner_invalid", 403);
      return withTransaction(pool, async client => {
        const rows = await client.query("SELECT 1 FROM ia4tube_calendar.owner_state WHERE company_id=$1", [companyId]);
        return rows.rowCount === 1;
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
        has_column_privilege($1,c.oid,'company_id','UPDATE') AS owner_mutable,
        has_table_privilege($1,c.oid,'SELECT') AS readable,
        has_table_privilege($1,c.oid,'TRUNCATE') AS truncatable,
        has_table_privilege($1,c.oid,'DELETE') AS deletable,
        has_schema_privilege($1,n.oid,'CREATE') AS creatable
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='ia4tube_calendar' AND c.relname='owner_state'`, [role]);
      const row = result.rows?.[0];
      const normalize = value => String(value || "").replace(/[\s()]/g, "").replace(/::text/g, "").toLowerCase();
      const scope = normalize("company_id = nullif(current_setting('ia4tube.company_id', true), '')::uuid");
      if (result.rows?.length !== 1 || !row.rls || !row.forced || row.owner !== "ia4tube_social_owner" ||
          Number(row.policies) !== 1 || !row.readable || row.truncatable || row.deletable || row.creatable ||
          row.custom_trigger || row.public_table_access || row.public_schema_access || row.owner_mutable ||
          normalize(row.scope_using) !== scope || normalize(row.scope_check) !== scope) fail("calendar_schema_not_ready", 503);
    },
    async update(companyId, operation) {
      if (!UUID.test(companyId)) fail("calendar_owner_invalid", 403);
      return withTransaction(pool, async client => {
        // Includes the absent-row case; both UI mutations and the worker use this lock.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`calendar:${companyId}`]);
        const rows = await client.query("SELECT document FROM ia4tube_calendar.owner_state WHERE company_id=$1 FOR UPDATE", [companyId]);
        const state = validate(rows.rows[0]?.document || freshState());
        const before = rows.rows[0] ? JSON.stringify(state) : null;
        const result = await operation(state);
        validate(state);
        // Only imported references need the optional 0002 schema. The collector
        // takes these same locks in calendar -> imports order before retiring
        // an asset, closing the snapshot-to-confirm race without changing 0001.
        if (require("./imports/retention-policy").calendarAssetIds(state).length) {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`calendar-import:${companyId}`]);
          const imports = await client.query("SELECT document FROM ia4tube_calendar.import_upload_state WHERE company_id=$1 FOR UPDATE", [companyId]);
          require("./imports/retention-policy").assertCalendarRetention(state, imports.rows[0]?.document);
        }
        if (JSON.stringify(state) !== before) await client.query(`INSERT INTO ia4tube_calendar.owner_state(company_id,document) VALUES($1,$2::jsonb)
          ON CONFLICT(company_id) DO UPDATE SET document=EXCLUDED.document,
          revision=owner_state.revision+1,updated_at=CURRENT_TIMESTAMP`, [companyId, JSON.stringify(state)]);
        return structuredClone(result);
      }, { companyId, role });
    }
  });
  stores.add(store); return store;
}
function isCalendarStore(value) { return stores.has(value); }
module.exports = { createCalendarStore, isCalendarStore, validate };
