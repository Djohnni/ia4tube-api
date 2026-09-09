"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { withTransaction } = require("../src/persistence/postgres/pool");
function fixture() {
  const client = new EventEmitter(), queries = [], releases = [];
  client.query = async sql => { queries.push(sql); return { rows: [] }; };
  client.release = error => releases.push(error);
  return { client, queries, releases, pool: { connect: async () => client } };
}
test("checked-out connection error is handled, rolled back, discarded once and detached", async () => {
  const f = fixture(), error = Object.assign(new Error("private driver detail"), { code: "25P03" });
  await assert.rejects(withTransaction(f.pool, async () => { f.client.emit("error", error); return "must not commit"; }), e => e === error);
  assert.deepEqual(f.queries, ["BEGIN", "ROLLBACK"]); assert.deepEqual(f.releases, [error]);
  assert.equal(f.client.listenerCount("error"), 0);
});
test("successful transactions keep healthy clients and remove the temporary listener", async () => {
  const f = fixture(); assert.equal(await withTransaction(f.pool, async () => "ok"), "ok");
  assert.deepEqual(f.queries, ["BEGIN", "COMMIT"]); assert.deepEqual(f.releases, [undefined]);
  assert.equal(f.client.listenerCount("error"), 0);
});
test("an ordinary business error rolls back without discarding a healthy connection", async () => {
  const f = fixture(), error = Object.assign(new Error("private"), { code: "23505" });
  await assert.rejects(withTransaction(f.pool, async () => { throw error; }), e => e === error);
  assert.deepEqual(f.queries, ["BEGIN", "ROLLBACK"]); assert.deepEqual(f.releases, [undefined]);
  assert.equal(f.client.listenerCount("error"), 0);
});
test("failed rollback discards once and keeps the original cause for read-only recovery", async () => {
  const f = fixture(), original = Object.assign(new Error("private"), { code: "57P01" });
  const rollback = new Error("Connection terminated unexpectedly");
  f.client.query = async sql => { f.queries.push(sql); if (sql === "ROLLBACK") throw rollback; return { rows: [] }; };
  await assert.rejects(withTransaction(f.pool, async () => { throw original; }), error => error.code === "postgres_rollback_failed" && error.cause === original);
  assert.deepEqual(f.releases, [rollback]); assert.equal(f.client.listenerCount("error"), 0);
});
