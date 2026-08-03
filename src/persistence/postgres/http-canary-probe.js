"use strict";

const {
  SET_COMPANY_SCOPE_SQL,
  quoteIdentifier
} = require("./pool");
const {
  SocialPostgresError,
  postgresFail
} = require("./errors");
const { requireUuid } = require("./validation");
const { SOCIAL_RUNTIME_ROLE } = require("./config");

const SYNTHETIC_COMPANY_NAME_PREFIX = "Synthetic Company ";
const CANARY_ACTION = "social.runtime_canary";
const CANARY_OUTCOME = "succeeded";
const CANARY_DETAILS_CODE = "ia4tube_canary_http";
const RLS_DENIED_SQLSTATE = "42501";
const CANARY_LOCK_CLASS_ID = 1229001804;
const CANARY_LOCK_OBJECT_ID = 843203406;
const SAVEPOINTS = new Set([
  "canary_missing_context",
  "canary_cross_a_to_b",
  "canary_cross_b_to_a",
  "canary_tampered_context"
]);

function fail(code) {
  postgresFail(code, "Canario HTTP social recusado.");
}

function requirePool(pool) {
  if (!pool || typeof pool.connect !== "function") {
    fail("social_http_canary_pool_required");
  }
  return pool;
}

function requireRuntimeRole(role) {
  if (role !== SOCIAL_RUNTIME_ROLE) {
    fail("social_http_canary_runtime_role_invalid");
  }
  return role;
}

function numericCount(result, code) {
  const count = Number(result?.rows?.[0]?.record_count);
  if (!Number.isSafeInteger(count) || count < 0) fail(code);
  return count;
}

async function withRollbackOnlyClient(
  client,
  runtimeRole,
  operation,
  options = {}
) {
  if (!client || typeof client.query !== "function") {
    fail("social_http_canary_client_invalid");
  }
  let beginAttempted = false;
  let started = false;
  try {
    beginAttempted = true;
    await client.query(options.readOnly ? "BEGIN READ ONLY" : "BEGIN");
    started = true;
    await client.query(
      `SET LOCAL ROLE ${quoteIdentifier(requireRuntimeRole(runtimeRole))}`
    );
    const result = await operation(client);
    await client.query("ROLLBACK");
    started = false;
    return result;
  } catch (error) {
    if (started) {
      try {
        await client.query("ROLLBACK");
        started = false;
      } catch {
        throw new SocialPostgresError(
          "social_http_canary_rollback_failed",
          "Rollback do canario HTTP social nao foi confirmado.",
          error
        );
      }
    } else if (beginAttempted) {
      throw new SocialPostgresError(
        "social_http_canary_transaction_state_uncertain",
        "Estado transacional do canario HTTP social nao confirmado.",
        error
      );
    }
    throw error;
  }
}

async function withSessionAdvisoryLock(
  pool,
  runtimeRole,
  operation
) {
  const client = await requirePool(pool).connect();
  let roleSetAttempted = false;
  let roleSetConfirmed = false;
  let roleSet = false;
  let acquisitionAttempted = false;
  let acquisitionConfirmed = false;
  let lockAcquired = false;
  let discarded = false;
  let result;
  let operationError;
  try {
    if (
      !client ||
      typeof client.query !== "function" ||
      typeof client.release !== "function"
    ) {
      fail("social_http_canary_client_invalid");
    }
    roleSetAttempted = true;
    await client.query(
      `SET ROLE ${quoteIdentifier(requireRuntimeRole(runtimeRole))}`
    );
    roleSetConfirmed = true;
    roleSet = true;
    acquisitionAttempted = true;
    const lockResult = await client.query(
      [
        "SELECT pg_try_advisory_lock(",
        "  $1::integer, $2::integer",
        ") AS acquired"
      ].join("\n"),
      [CANARY_LOCK_CLASS_ID, CANARY_LOCK_OBJECT_ID]
    );
    if (
      lockResult?.rowCount !== 1 ||
      typeof lockResult?.rows?.[0]?.acquired !== "boolean"
    ) {
      fail("social_http_canary_exclusive_lock_invalid");
    }
    acquisitionConfirmed = true;
    lockAcquired = lockResult.rows[0].acquired;
    if (!lockAcquired) fail("social_http_canary_in_progress");
    result = await operation(client);
  } catch (error) {
    operationError = error;
  }

  let cleanupError;
  const sessionStateUncertain = [
    "social_http_canary_rollback_failed",
    "social_http_canary_transaction_state_uncertain"
  ].includes(operationError?.code);
  if (sessionStateUncertain) {
    client.release(operationError);
    discarded = true;
    lockAcquired = false;
    roleSet = false;
  }
  if (lockAcquired && !discarded) {
    try {
      const unlockResult = await client.query(
        [
          "SELECT pg_advisory_unlock(",
          "  $1::integer, $2::integer",
          ") AS released"
        ].join("\n"),
        [CANARY_LOCK_CLASS_ID, CANARY_LOCK_OBJECT_ID]
      );
      if (
        unlockResult?.rowCount !== 1 ||
        unlockResult?.rows?.[0]?.released !== true
      ) {
        throw new Error("Advisory lock release was not confirmed.");
      }
      lockAcquired = false;
    } catch (error) {
      cleanupError = error;
    }
  }
  if (roleSet && !cleanupError && !discarded) {
    try {
      await client.query("RESET ROLE");
      roleSet = false;
    } catch (error) {
      cleanupError = error;
    }
  }

  // An acquisition error can occur after PostgreSQL took the lock but before
  // the response reached Node. A failed unlock/reset also leaves session state
  // uncertain. Destroy that pooled connection instead of returning it.
  if (
    !discarded &&
    (
    cleanupError ||
    (roleSetAttempted && !roleSetConfirmed) ||
    (acquisitionAttempted && !acquisitionConfirmed)
    )
  ) {
    client.release(cleanupError || operationError);
    discarded = true;
  }
  if (!discarded && client && typeof client.release === "function") {
    client.release();
  }
  if (cleanupError) {
    throw new SocialPostgresError(
      "social_http_canary_lock_cleanup_failed",
      "Limpeza da trava do canario HTTP social nao confirmada.",
      cleanupError
    );
  }
  if (operationError) throw operationError;
  return result;
}

async function setCompanyScope(client, companyId) {
  await client.query(SET_COMPANY_SCOPE_SQL, [
    requireUuid(companyId, "canary_company_scope")
  ]);
}

async function clearCompanyScope(client) {
  await client.query(
    "SELECT set_config('ia4tube.company_id', $1, true)",
    [""]
  );
}

async function fixtureVisible(client, companyId) {
  const result = await client.query(
    [
      "SELECT id",
      "FROM ia4tube_social.companies",
      "WHERE id = $1",
      "  AND status = 'active'",
      "  AND left(name, $2) = $3"
    ].join("\n"),
    [
      requireUuid(companyId, "canary_fixture_company"),
      SYNTHETIC_COMPANY_NAME_PREFIX.length,
      SYNTHETIC_COMPANY_NAME_PREFIX
    ]
  );
  return result.rowCount === 1;
}

async function fixtureCount(client, companyIds) {
  const result = await client.query(
    [
      "SELECT COUNT(*)::integer AS record_count",
      "FROM ia4tube_social.companies",
      "WHERE id = ANY($1::uuid[])"
    ].join("\n"),
    [companyIds.map((id) => requireUuid(id, "canary_fixture_company"))]
  );
  return numericCount(result, "social_http_canary_fixture_count_invalid");
}

async function insertEvent(client, companyId, event, options = {}) {
  const conflictClause = options.idempotent
    ? "ON CONFLICT (company_id, event_id) DO NOTHING"
    : "";
  return client.query(
    [
      "INSERT INTO ia4tube_social.social_audit_events (",
      "  company_id, id, event_id, actor_user_id, connection_id,",
      "  action, outcome, details_code",
      ") VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6)",
      conflictClause,
      "RETURNING id"
    ].filter(Boolean).join("\n"),
    [
      requireUuid(companyId, "canary_event_company"),
      requireUuid(event.id, "canary_event_id"),
      requireUuid(event.eventId, "canary_event_identity"),
      CANARY_ACTION,
      CANARY_OUTCOME,
      CANARY_DETAILS_CODE
    ]
  );
}

async function eventCount(client, companyId, event) {
  const result = await client.query(
    [
      "SELECT COUNT(*)::integer AS record_count",
      "FROM ia4tube_social.social_audit_events",
      "WHERE company_id = $1 AND id = $2 AND event_id = $3"
    ].join("\n"),
    [
      requireUuid(companyId, "canary_event_company"),
      requireUuid(event.id, "canary_event_id"),
      requireUuid(event.eventId, "canary_event_identity")
    ]
  );
  return numericCount(result, "social_http_canary_event_count_invalid");
}

async function expectRlsDeniedInsert(
  client,
  savepoint,
  companyId,
  event
) {
  if (!SAVEPOINTS.has(savepoint)) {
    fail("social_http_canary_savepoint_invalid");
  }
  await client.query(`SAVEPOINT ${savepoint}`);
  let failure;
  try {
    await insertEvent(client, companyId, event);
    failure = new SocialPostgresError(
      "social_http_canary_rls_write_allowed",
      "RLS do canario HTTP social recusada."
    );
  } catch (error) {
    if (error?.code !== RLS_DENIED_SQLSTATE) failure = error;
  }

  try {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (savepointError) {
    throw new SocialPostgresError(
      "social_http_canary_savepoint_cleanup_failed",
      "Savepoint do canario HTTP social nao foi confirmado.",
      savepointError
    );
  }
  if (failure) throw failure;
  return true;
}

function residualTargets(data, companyId) {
  const events = [];
  if (companyId === data.companyA) {
    events.push(
      data.eventA,
      data.missingContext,
      data.crossBToA,
      data.tampered
    );
  } else if (companyId === data.companyB) {
    events.push(data.eventB, data.crossAToB);
  } else {
    fail("social_http_canary_residual_scope_invalid");
  }
  return Object.freeze({
    ids: events.map((event) => requireUuid(event.id, "canary_event_id")),
    eventIds: events.map((event) =>
      requireUuid(event.eventId, "canary_event_identity")
    )
  });
}

async function residualCount(client, companyId, targets) {
  const result = await client.query(
    [
      "SELECT COUNT(*)::integer AS record_count",
      "FROM ia4tube_social.social_audit_events",
      "WHERE company_id = $1",
      "  AND (id = ANY($2::uuid[]) OR event_id = ANY($3::uuid[]))"
    ].join("\n"),
    [companyId, targets.ids, targets.eventIds]
  );
  return numericCount(result, "social_http_canary_residual_count_invalid");
}

function createSocialHttpCanaryProbe(options = {}) {
  const pool = requirePool(options.pool);
  const runtimeRole = requireRuntimeRole(options.runtimeRole);
  if (options.operationalPoolMax !== 3) {
    fail("social_http_canary_pool_must_be_three");
  }

  async function runExclusive(operation) {
    if (typeof operation !== "function") {
      fail("social_http_canary_exclusive_lock_invalid");
    }
    return withSessionAdvisoryLock(pool, runtimeRole, (client) =>
      operation(Object.freeze({
        runMutation(data) {
          return runMutation(client, data);
        },
        verifyResiduals(data) {
          return verifyResiduals(client, data);
        }
      }))
    );
  }

  async function runMutation(client, data) {
    return withRollbackOnlyClient(client, runtimeRole, async (client) => {
      await clearCompanyScope(client);
      const unscopedFixtures = await fixtureCount(client, [
        data.companyA,
        data.companyB
      ]);
      const missingWriteDenied = await expectRlsDeniedInsert(
        client,
        "canary_missing_context",
        data.missingContext.companyId,
        data.missingContext
      );

      await setCompanyScope(client, data.companyA);
      if (!(await fixtureVisible(client, data.companyA))) {
        fail("social_http_canary_fixture_a_missing");
      }
      const insertedA = await insertEvent(
        client,
        data.companyA,
        data.eventA,
        { idempotent: true }
      );
      const duplicateA = await insertEvent(
        client,
        data.companyA,
        data.eventA,
        { idempotent: true }
      );
      const ownA = await eventCount(client, data.companyA, data.eventA);
      const aToBWriteDenied = await expectRlsDeniedInsert(
        client,
        "canary_cross_a_to_b",
        data.crossAToB.companyId,
        data.crossAToB
      );

      await setCompanyScope(client, data.companyB);
      if (!(await fixtureVisible(client, data.companyB))) {
        fail("social_http_canary_fixture_b_missing");
      }
      const insertedB = await insertEvent(
        client,
        data.companyB,
        data.eventB,
        { idempotent: true }
      );
      const duplicateB = await insertEvent(
        client,
        data.companyB,
        data.eventB,
        { idempotent: true }
      );
      const ownB = await eventCount(client, data.companyB, data.eventB);
      const aHiddenFromB = await eventCount(
        client,
        data.companyA,
        data.eventA
      );
      const bToAWriteDenied = await expectRlsDeniedInsert(
        client,
        "canary_cross_b_to_a",
        data.crossBToA.companyId,
        data.crossBToA
      );

      await setCompanyScope(client, data.companyA);
      const bHiddenFromA = await eventCount(
        client,
        data.companyB,
        data.eventB
      );

      await clearCompanyScope(client);
      const aHiddenWithoutContext = await eventCount(
        client,
        data.companyA,
        data.eventA
      );
      const bHiddenWithoutContext = await eventCount(
        client,
        data.companyB,
        data.eventB
      );

      await setCompanyScope(client, data.tampered.scopeCompanyId);
      const aHiddenFromTampered = await eventCount(
        client,
        data.companyA,
        data.eventA
      );
      const bHiddenFromTampered = await eventCount(
        client,
        data.companyB,
        data.eventB
      );
      const tamperedWriteDenied = await expectRlsDeniedInsert(
        client,
        "canary_tampered_context",
        data.tampered.companyId,
        data.tampered
      );

      const passed =
        unscopedFixtures === 0 &&
        missingWriteDenied &&
        insertedA.rowCount === 1 &&
        duplicateA.rowCount === 0 &&
        ownA === 1 &&
        insertedB.rowCount === 1 &&
        duplicateB.rowCount === 0 &&
        ownB === 1 &&
        aHiddenFromB === 0 &&
        bHiddenFromA === 0 &&
        aToBWriteDenied &&
        bToAWriteDenied &&
        aHiddenWithoutContext === 0 &&
        bHiddenWithoutContext === 0 &&
        aHiddenFromTampered === 0 &&
        bHiddenFromTampered === 0 &&
        tamperedWriteDenied;
      if (!passed) fail("social_http_canary_database_gate_failed");

      return Object.freeze({
        ownReadA: true,
        ownReadB: true,
        crossTenantDeniedA: true,
        crossTenantDeniedB: true,
        missingContextDenied: true,
        tamperedContextDenied: true,
        idempotentWrites: true,
        mutationRolledBack: true
      });
    });
  }

  async function verifyResiduals(client, data) {
    return withRollbackOnlyClient(
      client,
      runtimeRole,
      async (client) => {
        await setCompanyScope(client, data.companyA);
        const countA = await residualCount(
          client,
          data.companyA,
          residualTargets(data, data.companyA)
        );
        await setCompanyScope(client, data.companyB);
        const countB = await residualCount(
          client,
          data.companyB,
          residualTargets(data, data.companyB)
        );
        return countA + countB;
      },
      { readOnly: true }
    );
  }

  return Object.freeze({ runExclusive });
}

module.exports = {
  CANARY_LOCK_CLASS_ID,
  CANARY_LOCK_OBJECT_ID,
  CANARY_ACTION,
  CANARY_DETAILS_CODE,
  CANARY_OUTCOME,
  RLS_DENIED_SQLSTATE,
  SYNTHETIC_COMPANY_NAME_PREFIX,
  createSocialHttpCanaryProbe
};
