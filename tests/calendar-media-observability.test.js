"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createImportHttpObserver } = require("../src/social/calendar/imports/router");
const { createWorkflowStageObserver } = require("../src/social/calendar/imports/workflow-coordinator-tick");

test("HTTP observer emits only fixed metadata and preserves operation behavior", async () => {
  let now = 0; const events = [];
  const observe = createImportHttpObserver({ logger: { error: value => events.push(value) }, monotonicClock: () => now, slowMs: 250 });
  assert.equal(await observe("capability_read", async () => { now = 249; return "ok"; }), "ok");
  assert.equal(events.length, 0);
  assert.equal(await observe("prepare_transaction", async () => { now = 600; return "prepared"; }), "prepared");
  assert.deepEqual(events, [{ component: "calendar_media_http", code: "calendar_media_http_slow", stage: "prepare_transaction", elapsedMs: 351 }]);
  await assert.rejects(observe("principal_resolution", async () => { now = 610; throw new Error("sentinel-secret-path-id"); }), /sentinel/);
  assert.deepEqual(events.at(-1), { component: "calendar_media_http", code: "calendar_media_http_failed", stage: "principal_resolution", elapsedMs: 10 });
  assert.doesNotMatch(JSON.stringify(events), /sentinel|secret|path|id/);
});

test("tick stage observer identifies one slow in-flight stage without changing or duplicating work", async () => {
  let now = 0, scheduled = null, cleared = 0, release; const events = [];
  const timers = { setTimeout(fn, ms) { scheduled = { fn, ms, unref() {} }; return scheduled; }, clearTimeout(value) { if (value === scheduled) cleared++; } };
  const observe = createWorkflowStageObserver({ diagnostic: value => events.push(value), monotonicClock: () => now, timers, slowAfterMs: 10000 });
  const active = observe("preparation_reconcile", () => new Promise(resolve => { release = resolve; }));
  assert.equal(scheduled.ms, 10000); now = 12000; scheduled.fn(); release("done");
  assert.equal(await active, "done"); assert.equal(cleared, 1);
  assert.deepEqual(events, [
    { component: "workflow_coordinator_tick", code: "workflow_tick_stage_slow", stage: "preparation_reconcile", elapsedMs: 12000 },
    { component: "workflow_coordinator_tick", code: "workflow_tick_stage_recovered", stage: "preparation_reconcile", elapsedMs: 12000 }
  ]);
});

test("tick stage failure is closed metadata and a broken diagnostic sink cannot break progress", async () => {
  let now = 5, timer; const events = [];
  const timers = { setTimeout(fn) { timer = { fn, unref() {} }; return timer; }, clearTimeout() {} };
  const observe = createWorkflowStageObserver({ diagnostic: value => events.push(value), monotonicClock: () => now, timers, slowAfterMs: 10000 });
  await assert.rejects(observe("upload_complete", async () => { now = 12; throw new Error("sentinel-private-upload-id"); }), /sentinel/);
  assert.deepEqual(events, [{ component: "workflow_coordinator_tick", code: "workflow_tick_stage_failed", stage: "upload_complete", elapsedMs: 7 }]);
  assert.doesNotMatch(JSON.stringify(events), /sentinel|private|id/);
  const safe = createWorkflowStageObserver({ diagnostic() { throw new Error("logger-failed"); }, monotonicClock: () => 0, timers, slowAfterMs: 10000 });
  assert.equal(await safe("pending_scan", async () => "unchanged"), "unchanged");
});

test("asynchronous sinks and broken diagnostic clocks or timers remain fail-open", async () => {
  const http = createImportHttpObserver({ logger: { error: () => Promise.reject(new Error("unused-async-logger-failed")) },
    monotonicClock() { throw new Error("clock-failed"); }, slowMs: 1 });
  assert.equal(await http("capability_read", async () => "http-ok"), "http-ok");
  let httpNow = 0;
  const asyncHttp = createImportHttpObserver({ logger: { error: () => Promise.reject(new Error("async-logger-failed")) },
    monotonicClock: () => httpNow, slowMs: 1 });
  assert.equal(await asyncHttp("prepare_transaction", async () => { httpNow = 2; return "http-observed"; }), "http-observed");

  let now = 0;
  const tick = createWorkflowStageObserver({ diagnostic: () => Promise.reject(new Error("async-diagnostic-failed")),
    monotonicClock: () => now, timers: { setTimeout() { throw new Error("timer-failed"); }, clearTimeout() { throw new Error("clear-failed"); } }, slowAfterMs: 1 });
  assert.equal(await tick("pending_scan", async () => { now = 5; return "tick-ok"; }), "tick-ok");

  const asyncEvents = [];
  const asyncTick = createWorkflowStageObserver({ diagnostic(value) { asyncEvents.push(value); return Promise.reject(new Error("async-diagnostic-failed")); },
    monotonicClock: () => now, timers: { setTimeout(fn) { return { fn, unref() {} }; }, clearTimeout() {} }, slowAfterMs: 1 });
  await assert.rejects(asyncTick("upload_complete", async () => { now += 2; throw new Error("operation-failed"); }), /operation-failed/);
  assert.equal(asyncEvents.length, 1);
  await new Promise(resolve => setImmediate(resolve));
});
