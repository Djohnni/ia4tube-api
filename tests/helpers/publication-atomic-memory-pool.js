"use strict";

// Deterministic SQL protocol double, not a PostgreSQL/RLS proof. Transactions
// serialize and roll back; unknown statements fail rather than silently pass.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createSocialAuthAdapter } = require("../../src/social/auth-adapter");
const { createConnectorContext } = require("../../src/social/connectors/contract");

function fixtureContext(owner = "synthetic-atomic-owner") {
  const adapter = createSocialAuthAdapter({ namespaceUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    derivationVersion: "v1", key: Buffer.alloc(32, 17) });
  const claims = { token_version: 2, iss: "ia4tube-api", aud: "ia4tube-client",
    sub: owner, whatsapp: owner, company_id: owner, jti: "synthetic-session-000001" };
  return { adapter, claims, context: createConnectorContext({ principal: adapter.fromVerifiedJwt(claims),
    environment: "production", provider: "instagram", correlationId: crypto.randomUUID(), auditEventId: crypto.randomUUID() }) };
}

function createMemoryPool(context) {
  const date = new Date("2026-09-05T00:00:00Z");
  let state = { publications: new Map(), operations: new Map(), attempts: new Map(), connection: {
    company_id: context.companyId, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", provider: "instagram",
    status: "connected", revision: 7, external_account_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    external_id: "17840000000000001", username: "synthetic_account", display_name: "Synthetic", account_type: "business",
    external_account_status: "active", active_credential_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    granted_scopes: ["instagram_business_basic", "instagram_business_content_publish"],
    created_at: date, updated_at: date, connected_at: date, observed_at: date,
    expires_at: null, credential_expires_at: null, disconnected_at: null
  } };
  let queue = Promise.resolve();
  let transactions = 0;
  const statements = [];
  const rows = (values) => ({ rows: structuredClone(values), rowCount: values.length });
  return {
    statements,
    get state() { return state; },
    get transactions() { return transactions; },
    async connect() {
      let releaseTurn, snapshot, company;
      return {
        release() {},
        async query(text, p = []) {
          const q = text.replace(/\s+/g, " ").trim();
          statements.push(q);
          if (q === "BEGIN") {
            const prior = queue;
            queue = new Promise((resolve) => { releaseTurn = resolve; });
            await prior;
            snapshot = structuredClone(state); transactions += 1;
            return rows([]);
          }
          if (q === "COMMIT" || q === "ROLLBACK") {
            if (q === "ROLLBACK") state = snapshot;
            transactions -= 1; releaseTurn(); return rows([]);
          }
          if (q.startsWith("SET LOCAL ROLE")) return rows([]);
          if (q.includes("set_config('ia4tube.company_id'")) { company = p[0]; return rows([]); }
          if (q.includes("pg_advisory_xact_lock")) {
            assert.equal(p[0], `${company}:instagram`); return rows([]);
          }
          if (p.length && /ia4tube_social\./.test(q)) assert.equal(p[0], company, "tenant parameter must match transaction scope");
          if (q.startsWith("INSERT INTO ia4tube_social.social_audit_events")) return rows([]);
          if (q.startsWith("SELECT") && q.includes("FROM ia4tube_social.social_connections connection")) {
            return rows(state.connection.company_id === company &&
              (q.includes("connection.id = $2") || q.includes("connection.id=$2") ? state.connection.id === p[1] : true)
              ? [state.connection] : []);
          }
          if (q.startsWith("SELECT") && q.includes("FROM ia4tube_social.social_publications")) {
            let values = [...state.publications.values()].filter((v) => v.company_id === company);
            if (q.startsWith("SELECT id FROM")) {
              if (q.includes("AND state IN")) values = values.filter((v) => ["ready","publishing","provider_confirming"].includes(v.state));
              if (q.includes("id<>$3")) values = values.filter((v) => v.id !== p[2]);
              return rows(values);
            }
            return rows(values.filter((v) => v.id === p[1]));
          }
          if (q.startsWith("INSERT INTO ia4tube_social.social_idempotency_operations")) {
            if (state.operations.has(p[1])) return rows([]);
            state.operations.set(p[1], { company_id: company, operation_id: p[1], provider: p[2], capability: p[3],
              request_hash: p[4], status: "pending", result_payload: null, error_code: null });
            return rows([{ operation_id: p[1] }]);
          }
          if (q.startsWith("SELECT") && q.includes("FROM ia4tube_social.social_idempotency_operations")) {
            const op = state.operations.get(p[1]); return rows(op?.company_id === company ? [op] : []);
          }
          if (q.startsWith("UPDATE ia4tube_social.social_idempotency_operations")) {
            const op = state.operations.get(p[1]);
            if (!op || op.status !== "pending") return rows([]);
            assert.equal(op.request_hash, p[4]);
            Object.assign(op, { status: "completed", result_payload: p[5] ? JSON.parse(p[5]) : null, error_code: p[6] });
            return rows([op]);
          }
          if (q.startsWith("INSERT INTO ia4tube_social.social_publications")) {
            assert.equal(p.length, 11, "new bound publications require both additive fields");
            assert.equal(p[9], state.connection.external_account_id);
            state.publications.set(p[1], { company_id: company, id: p[1], connection_id: p[2], provider: p[3],
              media_reference: p[4], media_metadata_digest: p[5], caption: p[6], idempotency_key: p[7], request_hash: p[8],
              bound_external_account_id: p[9], expected_connection_revision: p[10], bound_external_id: state.connection.external_id,
              state: "ready", revision: 1, confirmed_provider_reference: null, reconciliation_reference: null, error_code: null,
              created_at: date, updated_at: date, published_at: null });
            return rows([{ id: p[1] }]);
          }
          if (q.startsWith("UPDATE ia4tube_social.social_publications")) {
            const pub = state.publications.get(p[1]);
            const stage = q.includes("SET state='provider_confirming'");
            if (!pub || pub.company_id !== company || pub.revision !== p[stage ? 4 : 8]) return rows([]);
            if (stage) Object.assign(pub, {state:"provider_confirming", reconciliation_reference:p[3], error_code:null, revision:pub.revision+1});
            else Object.assign(pub, {state:p[3],confirmed_provider_reference:p[4],reconciliation_reference:p[5],error_code:p[6],revision:p[7]});
            if (pub.state === "published") pub.published_at = date;
            return rows([{ id: pub.id }]);
          }
          if (q.startsWith("SELECT") && q.includes("FROM ia4tube_social.social_publication_attempts")) {
            if (q.startsWith("SELECT COALESCE")) return rows([{next_attempt:1}]);
            return rows(state.attempts.has(p[1]) ? [state.attempts.get(p[1])] : []);
          }
          if (q.startsWith("INSERT INTO ia4tube_social.social_publication_attempts")) {
            state.attempts.set(p[1], {attempt_number:1,state:"started",error_code:null,provider_reference:null,
              started_at:date,finished_at:null,duration_ms:null}); return rows([{attempt_number:1}]);
          }
          if (q.startsWith("UPDATE ia4tube_social.social_publication_attempts")) {
            const attempt = state.attempts.get(p[1]);
            if (!attempt) return rows([]);
            if (q.includes("SET state='provider_confirming'")) Object.assign(attempt,{state:"provider_confirming",provider_reference:p[3]});
            else Object.assign(attempt,{state:p[3],error_code:p[4],provider_reference:p[5]});
            Object.assign(attempt,{finished_at:date,duration_ms:0});
            return rows([{attempt_number:1}]);
          }
          throw new Error("Unimplemented synthetic SQL protocol statement");
        }
      };
    }
  };
}

module.exports = { fixtureContext, createMemoryPool };
