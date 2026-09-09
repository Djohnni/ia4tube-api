"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { SocialPostgresError } = require("../src/persistence/postgres/errors");
const { connectionFailure, readCalendarWithRecovery } = require("../src/social/calendar/read-recovery");

test("gallery recovers one closed transaction with a fresh read and only safe diagnostics", async () => {
  let calls = 0; const logs = [], snapshot = { ok: true, items: [{ id: "synthetic", caption: "same", revision: 2 }], next: null };
  const result = await readCalendarWithRecovery(async () => {
    if (++calls === 1) throw new SocialPostgresError("postgres_rollback_failed", "sentinel secret", Object.assign(new Error("sentinel SQL"), { code: "25P03" }));
    return snapshot;
  }, { warn: item => logs.push(item) });
  assert.equal(calls, 2); assert.equal(result, snapshot);
  assert.deepEqual(logs, [{ component: "social_calendar", code: "calendar_read_connection_retry" }]);
  assert.doesNotMatch(JSON.stringify(logs), /sentinel|SQL|secret/);
});
test("persistent connection failure stops after one retry, with no empty-success fallback", async () => {
  let calls = 0; const failure = Object.assign(new Error("private"), { code: "ECONNRESET" });
  await assert.rejects(readCalendarWithRecovery(async () => { calls++; throw failure; }), error => error === failure);
  assert.equal(calls, 2);
});
test("authorization, SQL constraints, lock timeout, cancellation and unknown faults are never retried", async () => {
  for (const code of ["calendar_not_found", "calendar_consent_required", "42501", "23503", "55P03", "57014", "unexpected"]) {
    let calls = 0; const error = Object.assign(new Error("private"), { code });
    await assert.rejects(readCalendarWithRecovery(async () => { calls++; throw error; }), candidate => candidate === error);
    assert.equal(calls, 1, code);
  }
});
test("recognized closed driver clients recover, but arbitrary messages cannot select recovery", () => {
  assert.equal(connectionFailure(new Error("Client has encountered a connection error and is not queryable")), true);
  assert.equal(connectionFailure(new Error("customer text mentioning ECONNRESET or 25P03")), false);
  const cycle = new Error("private"); cycle.cause = cycle;
  assert.equal(connectionFailure(cycle), false);
});
test("diagnostic logger failure cannot replace the successful recovered result", async () => {
  let calls = 0;
  assert.equal(await readCalendarWithRecovery(async () => {
    if (++calls === 1) throw Object.assign(new Error("private"), { code: "25P03" });
    return "same calendar";
  }, { warn() { throw new Error("logger failed"); } }), "same calendar");
});
