"use strict";
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const test = require("node:test");
const { createPostgresConnectorStore } = require("../src/persistence/postgres/social-connector-store");
const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const { createConnectorContext } = require("../src/social/connectors/contract");
const { SESSION_ISSUER, SESSION_AUDIENCE } = require("../src/social/reauth");

function harness(pending = false, pendingRetry = false, activeDisconnect = false) {
  const principal = createSocialAuthAdapter({ namespaceUuid: "51cb8c58-0bf4-4bd9-83b2-3f2f96dfe29f",
    key: Buffer.alloc(32, 81), derivationVersion: "social-id-v1" }).fromVerifiedJwt({
    token_version: 2, iss: SESSION_ISSUER, aud: SESSION_AUDIENCE,
    jti: "review-lock-offline-session", sub: "review-lock", whatsapp: "review-lock", company_id: "review-lock"
  });
  const context = createConnectorContext({ principal, provider: "instagram", environment: "staging",
    correlationId: "57000000-0000-4000-8000-000000000001",
    auditEventId: "57000000-0000-4000-8000-000000000002" });
  const queries = [];
  let releases = 0;
  const pool = { async connect() { return {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes("AND connection_id=$2") &&
          sql.includes("state IN ('ready','publishing','provider_confirming')")) {
        return { rows: activeDisconnect ? [{ id: "active-publication" }] : [] };
      }
      if (sql.includes("AND id<>$3")) return { rows: pending ? [{ id: "other-pending" }] : [] };
      if (sql.includes("AND operation_id<>$3")) return { rows: pendingRetry ? [{ operation_id: "other-retry" }] : [] };
      if (sql.includes("INSERT INTO ia4tube_social.social_idempotency_operations")) {
        return { rows: [{ operation_id: values[1] }] };
      }
      if (sql.includes("INSERT INTO ia4tube_social.social_publications")) {
        return { rows: [{ id: values[1] }] };
      }
      return { rows: [] };
    }, release() { releases += 1; }
  }; } };
  return { scope: createPostgresConnectorStore({
    pool,
    appReviewCompanyId: context.companyId
  }).scope(context), context, queries,
    releases: () => releases };
}

function recoveryHarness(state) {
  const base = harness();
  const context = base.context;
  const queries = [];
  const publicationId = request().payload.publicationId;
  const connectionId = request().payload.connectionId;
  const row = {
    id: publicationId,
    connection_id: connectionId,
    state,
    revision: state === "ready" ? 1 : 2,
    idempotency_key: request().operationId,
    request_hash: "a".repeat(64),
    confirmed_provider_reference: null,
    reconciliation_reference: null,
    error_code: null
  };
  let candidateReturned = false;
  const pool = { async connect() { return {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.startsWith("SELECT id,connection_id,state,revision")) {
        if (!["ready", "publishing"].includes(state)) return { rows: [] };
        if (candidateReturned) return { rows: [] };
        candidateReturned = true;
        return { rows: [{ ...row }] };
      }
      if (sql.includes("SET state='publishing',error_code=NULL")) {
        return { rows: [{ revision: Number(values.at(-1)) + 1 }] };
      }
      if (sql.includes("AS next_attempt")) {
        return { rows: [{ next_attempt: 1 }] };
      }
      if (sql.includes("SET state='failed_permanent'")) {
        return { rows: [{
          revision: Number(values.at(-1)) + 1,
          request_hash: row.request_hash
        }] };
      }
      if (sql.includes("SET state='provider_confirming',error_code=NULL")) {
        return { rows: [{ revision: 3, request_hash: row.request_hash }] };
      }
      if (sql.startsWith("UPDATE ia4tube_social.social_publication_attempts")) {
        return { rows: [{ attempt_number: 1 }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE ia4tube_social.social_idempotency_operations")) {
        return { rows: [{ operation_id: request().operationId }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT publication.id,publication.connection_id")) {
        return ["provider_confirming", "published", "failed_temporary", "failed_permanent"]
          .includes(state)
          ? { rows: [{ ...row }] }
          : { rows: [] };
      }
      if (sql.startsWith("SELECT id FROM ia4tube_social.social_publications")) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {}
  }; } };
  return {
    context,
    queries,
    scope: createPostgresConnectorStore({
      pool,
      appReviewCompanyId: context.companyId
    }).scope(context)
  };
}

function armedRecoveryHarness() {
  const base = harness();
  const context = base.context;
  const queries = [];
  const publicationId = request().payload.publicationId;
  const armedReference = "igc:armed:17900000000000001";
  const requestHash = crypto.createHash("sha256").update(JSON.stringify({
    providerReference: armedReference,
    publicationId
  }), "utf8").digest("hex");
  const row = {
    id: publicationId,
    connection_id: request().payload.connectionId,
    state: "provider_confirming",
    revision: 3,
    reconciliation_reference: armedReference,
    confirmed_provider_reference: null,
    error_code: null,
    request_hash: "a".repeat(64)
  };
  const pool = { async connect() { return {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.startsWith("SELECT id,connection_id,state,revision,reconciliation_reference")) {
        return { rows: [{ ...row }] };
      }
      if (sql.startsWith("SELECT id,connection_id,state,revision")) {
        return { rows: [] };
      }
      if (sql.startsWith("SELECT publication.id,publication.connection_id")) {
        return { rows: [] };
      }
      if (sql.startsWith("SELECT operation_id,request_hash")) {
        return { rows: [{
          operation_id: "57000000-0000-4000-8000-000000000030",
          request_hash: requestHash
        }] };
      }
      if (sql.startsWith("UPDATE ia4tube_social.social_publications") &&
          sql.includes("SET reconciliation_reference=$5")) {
        return { rows: [{ revision: 4 }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE ia4tube_social.social_publication_attempts")) {
        return { rows: [{ attempt_number: 1 }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE ia4tube_social.social_idempotency_operations") &&
          sql.includes("capability='getPublicationStatus'")) {
        return { rows: [{
          operation_id: "57000000-0000-4000-8000-000000000030"
        }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT id FROM ia4tube_social.social_publications")) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {}
  }; } };
  return {
    armedReference,
    context,
    queries,
    requestHash,
    scope: createPostgresConnectorStore({
      pool,
      appReviewCompanyId: context.companyId
    }).scope(context)
  };
}

function pausedRetryHarness() {
  const context = harness().context;
  const old = request();
  const state = {
    attemptCount: 1,
    errorCode: "provider_temporary_failure",
    oldPending: true,
    publicationState: "failed_temporary",
    revision: 2
  };
  const queries = [];
  const publicationRow = () => ({
    company_id: context.companyId,
    id: old.payload.publicationId,
    connection_id: old.payload.connectionId,
    provider: "instagram",
    state: state.publicationState,
    revision: state.revision,
    idempotency_key: old.operationId,
    request_hash: old.digest,
    confirmed_provider_reference: null,
    reconciliation_reference: null,
    error_code: state.errorCode
  });
  const pool = { async connect() { return {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.startsWith("SELECT id,connection_id,state,revision,") &&
          sql.includes("state IN ('ready','publishing')")) {
        return { rows: [] };
      }
      if (sql.startsWith("SELECT publication.id,publication.connection_id")) {
        return state.oldPending && state.publicationState === "failed_temporary"
          ? { rows: [publicationRow()] }
          : { rows: [] };
      }
      if (sql.startsWith("SELECT id,connection_id,state,revision,reconciliation_reference")) {
        return { rows: [] };
      }
      if (sql.includes("SET state='publishing',error_code=NULL")) {
        if (state.publicationState !== values[3] || state.revision !== values[4]) {
          return { rows: [] };
        }
        state.publicationState = "publishing";
        state.errorCode = null;
        state.revision += 1;
        return { rows: [{ revision: state.revision }] };
      }
      if (sql.includes("AS next_attempt")) {
        return { rows: [{ next_attempt: state.attemptCount + 1 }] };
      }
      if (sql.includes("INSERT INTO ia4tube_social.social_publication_attempts")) {
        state.attemptCount += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SET state='failed_permanent'")) {
        if (state.publicationState !== "publishing" ||
            state.revision !== values[3]) {
          return { rows: [] };
        }
        state.publicationState = "failed_permanent";
        state.errorCode = "provider_permanent_failure";
        state.revision += 1;
        return { rows: [{
          revision: state.revision,
          request_hash: old.digest
        }] };
      }
      if (sql.startsWith("UPDATE ia4tube_social.social_publication_attempts")) {
        return { rows: [{ attempt_number: state.attemptCount }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE ia4tube_social.social_idempotency_operations") &&
          sql.includes("capability='publishImage'")) {
        state.oldPending = false;
        return { rows: [{ operation_id: old.operationId }], rowCount: 1 };
      }
      if (sql.includes("AND state IN ('ready','publishing','provider_confirming') LIMIT 1")) {
        return { rows: [] };
      }
      if (sql.includes("AND operation_id<>$3")) return { rows: [] };
      if (sql.includes("INSERT INTO ia4tube_social.social_idempotency_operations")) {
        return { rows: [{ operation_id: values[1] }] };
      }
      if (sql.startsWith("SELECT connection_id,provider,media_reference")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO ia4tube_social.social_publications")) {
        return { rows: [{ id: values[1] }] };
      }
      if (sql.startsWith("SELECT company_id, id, connection_id, provider, state,")) {
        return { rows: [publicationRow()] };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {}
  }; } };
  return {
    context,
    old,
    queries,
    scope: createPostgresConnectorStore({
      pool,
      appReviewCompanyId: context.companyId
    }).scope(context),
    state
  };
}

function request() {
  const operationId = "57000000-0000-4000-8000-000000000010";
  return { capability: "publishImage", operationId, digest: "a".repeat(64), payload: {
    operationId, publicationId: "57000000-0000-4000-8000-000000000011",
    connectionId: "57000000-0000-4000-8000-000000000012",
    image: { mediaId: `reviewer-jpeg:${"a".repeat(64)}`, mimeType: "image/jpeg" }, caption: "Offline caption"
  } };
}

test("review atomic reservation uses existing tenant lock and releases before provider work", async () => {
  const h = harness();
  assert.deepEqual(await h.scope.beginAppReviewIdempotency(request()), { status: "acquired" });
  const lockIndex = h.queries.findIndex((item) => item.sql.includes("pg_advisory_xact_lock"));
  const guardIndex = h.queries.findIndex((item) => item.sql.includes("AND id<>$3"));
  const reservationIndex = h.queries.findIndex((item) => item.sql.includes("INSERT INTO ia4tube_social.social_publications"));
  assert.ok(lockIndex < guardIndex && guardIndex < reservationIndex);
  assert.deepEqual(h.queries[lockIndex].values, [`${h.context.companyId}:instagram`]);
  assert.deepEqual(h.queries[guardIndex].values,
    [h.context.companyId, "instagram", request().payload.publicationId]);
  assert.equal(h.queries.at(-1).sql, "COMMIT");
  assert.equal(h.releases(), 1);
  // Reservation returns with its only pool client released, including max=1.
  assert.equal(typeof h.scope.withPublicationSubmissionLock, "undefined");
});

test("competing active intent is rejected before insertion and transaction releases", async () => {
  const denied = harness(true);
  await assert.rejects(denied.scope.beginAppReviewIdempotency(request()),
    { code: "state_transition_invalid" });
  assert.equal(denied.queries.at(-1).sql, "ROLLBACK");
  assert.equal(denied.releases(), 1);
  assert.equal(denied.queries.some((item) => item.sql.includes("INSERT INTO")), false);
  const legacy = harness(true);
  assert.deepEqual(await legacy.scope.beginIdempotency(request()), { status: "acquired" });
  assert.equal(legacy.queries.some((item) => item.sql.includes("AND id<>$3")), false);
});

test("canonical list queries only trusted company/provider and prioritizes active attempts", async () => {
  const h = harness();
  assert.deepEqual(await h.scope.listPublicationDetails(), []);
  const query = h.queries.find((item) => item.sql.includes("SELECT id FROM ia4tube_social.social_publications"));
  assert.deepEqual(query.values, [h.context.companyId, "instagram"]);
  assert.match(query.sql, /WHERE company_id=\$1 AND provider=\$2/);
  assert.match(query.sql, /'ready','publishing','provider_confirming'/);
  assert.match(query.sql, /LIMIT 100/);
  assert.equal(h.releases(), 1);
});

test("retry reservation blocks another worker before failed_temporary becomes publishing", async () => {
  const h = harness(false, true);
  await assert.rejects(h.scope.beginAppReviewIdempotency(request()), { code: "state_transition_invalid" });
  assert.equal(h.queries.some((item) => item.sql.includes("INSERT INTO")), false);
  const query = h.queries.find((item) => item.sql.includes("AND operation_id<>$3"));
  assert.deepEqual(query.values, [h.context.companyId, "instagram", request().operationId]);
  assert.match(query.sql, /capability='publishImage' AND status='pending'/);
  assert.equal(h.queries.at(-1).sql, "ROLLBACK");
  assert.equal(h.releases(), 1);
});

test("stale ready is CAS-fenced before permanent terminalization", async () => {
  const h = recoveryHarness("ready");
  assert.deepEqual(await h.scope.listAppReviewPublicationDetails(), []);
  const candidate = h.queries.find((item) =>
    item.sql.startsWith("SELECT id,connection_id,state,revision"));
  assert.deepEqual(candidate.values, [h.context.companyId, "instagram"]);
  assert.match(candidate.sql, /INTERVAL '10 minutes'/);
  assert.match(candidate.sql, /FOR UPDATE/);
  const publishing = h.queries.find((item) =>
    item.sql.includes("SET state='publishing',error_code=NULL"));
  const failed = h.queries.find((item) =>
    item.sql.includes("SET state='failed_permanent'"));
  assert.match(publishing.sql, /state=\$4 AND revision=\$5/);
  assert.match(failed.sql, /state='publishing' AND revision=\$4/);
  assert.equal(publishing.values[3], "ready");
  assert.equal(publishing.values[4], 1);
  assert.equal(failed.values[3], 2);
  const completion = h.queries.find((item) =>
    item.sql.startsWith("UPDATE ia4tube_social.social_idempotency_operations"));
  assert.equal(completion.values[3], null);
  assert.equal(completion.values[4], "provider_permanent_failure");
  assert.ok(h.queries.findIndex((item) => item === publishing) <
    h.queries.findIndex((item) => item === failed));
});

test("stale publishing becomes confirming with opaque igo and completed replay", async () => {
  const h = recoveryHarness("publishing");
  assert.deepEqual(await h.scope.listAppReviewPublicationDetails(), []);
  const confirming = h.queries.find((item) =>
    item.sql.includes("SET state='provider_confirming',error_code=NULL"));
  const expectedReference = `igo:${request().payload.publicationId.replaceAll("-", "")}`;
  assert.equal(confirming.values[4], expectedReference);
  assert.match(confirming.sql, /state='publishing' AND revision=\$4/);
  const attempt = h.queries.find((item) =>
    item.sql.startsWith("UPDATE ia4tube_social.social_publication_attempts"));
  assert.deepEqual(attempt.values.slice(3), [
    "provider_confirming",
    null,
    expectedReference
  ]);
  const completion = h.queries.find((item) =>
    item.sql.startsWith("UPDATE ia4tube_social.social_idempotency_operations"));
  const result = JSON.parse(completion.values[3]);
  assert.equal(result.state, "provider_confirming");
  assert.equal(result.reconciliationReference, expectedReference);
  assert.equal(completion.values[4], null);
});

test("stale armed reconciliation is downgraded to submitted before replay completes", async () => {
  const h = armedRecoveryHarness();
  assert.deepEqual(await h.scope.listAppReviewPublicationDetails(), []);
  const pending = h.queries.find((item) =>
    item.sql.startsWith("SELECT operation_id,request_hash"));
  const armed = h.queries.find((item) =>
    item.sql.startsWith("SELECT id,connection_id,state,revision,reconciliation_reference"));
  const progressed = h.queries.find((item) =>
    item.sql.startsWith("UPDATE ia4tube_social.social_publications") &&
      item.sql.includes("SET reconciliation_reference=$5"));
  const attempt = h.queries.find((item) =>
    item.sql.startsWith("UPDATE ia4tube_social.social_publication_attempts"));
  const completed = h.queries.find((item) =>
    item.sql.startsWith("UPDATE ia4tube_social.social_idempotency_operations") &&
      item.sql.includes("capability='getPublicationStatus'"));
  assert.match(pending.sql, /INTERVAL '10 minutes'/);
  assert.match(pending.sql, /FOR UPDATE/);
  assert.deepEqual(pending.values, [
    h.context.companyId,
    "instagram",
    h.requestHash
  ]);
  assert.match(armed.sql, /reconciliation_reference ~ '\^igc:armed:/);
  assert.match(armed.sql, /FOR UPDATE/);
  assert.equal(progressed.values[4], "igc:submitted:17900000000000001");
  assert.equal(progressed.values[5], h.armedReference);
  assert.equal(attempt.values[3], "igc:submitted:17900000000000001");
  assert.equal(attempt.values[4], h.armedReference);
  const result = JSON.parse(completed.values[3]);
  assert.equal(result.state, "provider_confirming");
  assert.equal(
    result.reconciliationReference,
    "igc:submitted:17900000000000001"
  );
  assert.ok(h.queries.indexOf(progressed) < h.queries.indexOf(completed));
});

test("App Review reconciliation reservation runs recovery under the tenant lock", async () => {
  const h = harness();
  const record = {
    capability: "getPublicationStatus",
    operationId: "57000000-0000-4000-8000-000000000031",
    digest: "b".repeat(64)
  };
  assert.deepEqual(
    await h.scope.beginAppReviewIdempotency(record),
    { status: "acquired" }
  );
  const lock = h.queries.findIndex((item) =>
    item.sql.includes("pg_advisory_xact_lock"));
  const recovery = h.queries.findIndex((item) =>
    item.sql.includes("reconciliation_reference ~ '^igc:armed:"));
  const insert = h.queries.findIndex((item) =>
    item.sql.includes("INSERT INTO ia4tube_social.social_idempotency_operations"));
  assert.ok(lock >= 0 && lock < recovery && recovery < insert);
  assert.equal(h.queries.some((item) => item.sql.includes("AND id<>$3")), false);
});

test("old pending operation on terminal publication is completed and cannot block a new intent", async () => {
  const h = recoveryHarness("failed_permanent");
  assert.deepEqual(await h.scope.listAppReviewPublicationDetails(), []);
  const sweep = h.queries.find((item) =>
    item.sql.startsWith("SELECT publication.id,publication.connection_id"));
  assert.match(sweep.sql, /status='pending'/);
  assert.match(sweep.sql, /updated_at <= CURRENT_TIMESTAMP - INTERVAL '10 minutes'/);
  const completion = h.queries.find((item) =>
    item.sql.startsWith("UPDATE ia4tube_social.social_idempotency_operations"));
  assert.match(completion.sql, /updated_at <= CURRENT_TIMESTAMP - INTERVAL '10 minutes'/);
  assert.equal(completion.values[3], null);
  assert.equal(completion.values[4], "provider_permanent_failure");

  const guard = harness(false, true);
  await assert.rejects(guard.scope.beginAppReviewIdempotency(request()),
    { code: "state_transition_invalid" });
  const recentOnly = guard.queries.find((item) =>
    item.sql.includes("AND operation_id<>$3"));
  assert.match(recentOnly.sql,
    /updated_at > CURRENT_TIMESTAMP - INTERVAL '10 minutes'/);
});

test("stale reserved retry is permanently fenced before another intent is admitted", async () => {
  const h = recoveryHarness("failed_temporary");
  assert.deepEqual(await h.scope.listAppReviewPublicationDetails(), []);
  const sweep = h.queries.find((item) =>
    item.sql.startsWith("SELECT publication.id,publication.connection_id"));
  const publishing = h.queries.find((item) =>
    item.sql.includes("SET state='publishing',error_code=NULL"));
  const failed = h.queries.find((item) =>
    item.sql.includes("SET state='failed_permanent'"));
  const completed = h.queries.find((item) =>
    item.sql.startsWith("UPDATE ia4tube_social.social_idempotency_operations"));
  assert.ok(h.queries.indexOf(sweep) < h.queries.indexOf(publishing));
  assert.ok(h.queries.indexOf(publishing) < h.queries.indexOf(failed));
  assert.ok(h.queries.indexOf(failed) < h.queries.indexOf(completed));
  assert.deepEqual(publishing.values.slice(3), ["failed_temporary", 2]);
  assert.equal(failed.values[3], 3);
  assert.equal(completed.values[4], "provider_permanent_failure");
  assert.match(completed.sql,
    /updated_at <= CURRENT_TIMESTAMP - INTERVAL '10 minutes'/);
  assert.equal(h.queries.filter((item) =>
    item.sql.includes("INSERT INTO ia4tube_social.social_publication_attempts")).length, 1);
});

test("paused stale worker cannot publish after recovery and a new intent can reserve", async () => {
  const h = pausedRetryHarness();
  let resumeWorker;
  let providerPosts = 0;
  const paused = new Promise((resolve) => { resumeWorker = resolve; });
  const oldWorker = (async () => {
    await paused;
    try {
      await h.scope.savePublication({
        companyId: h.context.companyId,
        id: h.old.payload.publicationId,
        connectionId: h.old.payload.connectionId,
        provider: "instagram",
        state: "publishing",
        confirmedProviderReference: null,
        reconciliationReference: null,
        errorCode: null,
        revision: 3
      }, 2);
      providerPosts += 1;
      return null;
    } catch (error) {
      return error.code;
    }
  })();

  const next = {
    ...request(),
    operationId: "57000000-0000-4000-8000-000000000040",
    digest: "c".repeat(64),
    payload: {
      ...request().payload,
      operationId: "57000000-0000-4000-8000-000000000040",
      publicationId: "57000000-0000-4000-8000-000000000041"
    }
  };
  assert.deepEqual(
    await h.scope.beginAppReviewIdempotency(next),
    { status: "acquired" }
  );
  assert.equal(h.state.publicationState, "failed_permanent");
  assert.equal(h.state.oldPending, false);
  resumeWorker();
  assert.equal(await oldWorker, "state_transition_invalid");
  assert.equal(providerPosts, 0);
});

test("App Review disconnect is atomically refused while its connection is active", async () => {
  const h = harness(false, false, true);
  await assert.rejects(
    h.scope.disconnectAppReviewConnectionLocally(request().payload.connectionId),
    { code: "state_transition_invalid" }
  );
  const lock = h.queries.findIndex((item) =>
    item.sql.includes("pg_advisory_xact_lock"));
  const guard = h.queries.findIndex((item) =>
    item.sql.includes("AND connection_id=$2") &&
      item.sql.includes("provider_confirming"));
  assert.ok(lock >= 0 && lock < guard);
  assert.equal(h.queries.some((item) =>
    item.sql.includes("UPDATE ia4tube_social.social_connections")), false);
  assert.equal(h.queries.at(-1).sql, "ROLLBACK");
});

test("App Review recovery authority is exact company and staging provider scope", async () => {
  const h = harness();
  const auth = createSocialAuthAdapter({ namespaceUuid: "51cb8c58-0bf4-4bd9-83b2-3f2f96dfe29f",
    key: Buffer.alloc(32, 81), derivationVersion: "social-id-v1" });
  function contextFor(company, provider = "instagram", environment = "staging") {
    return createConnectorContext({ principal: auth.fromVerifiedJwt({
      token_version: 2, iss: SESSION_ISSUER, aud: SESSION_AUDIENCE,
      jti: `review-lock-${company}`, sub: company, whatsapp: company, company_id: company
    }), provider, environment,
    correlationId: "57000000-0000-4000-8000-000000000020",
    auditEventId: "57000000-0000-4000-8000-000000000021" });
  }
  const pool = { async connect() { assert.fail("out-of-scope recovery reached DB"); } };
  const store = createPostgresConnectorStore({
    pool,
    appReviewCompanyId: h.context.companyId
  });
  for (const context of [
    contextFor("another-company"),
    contextFor("review-lock", "instagram", "production")
  ]) {
    await assert.rejects(
      store.scope(context).listAppReviewPublicationDetails(),
      { code: "resource_unavailable" }
    );
  }
});
