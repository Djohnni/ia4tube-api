"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto");
const { targets, started, record } = require("../../src/social/calendar/destinations");
const { LOCKED } = require("../../src/social/calendar/model");
const { isLocalCalendarSimulation } = require("../../src/social/calendar/imports/local-calendar-simulation");
/** Protocol harness, NOT a publisher to deploy. Exercises the existing target
 * state machine with immutable local bytes and simulated outcomes. There is no
 * HTTP control, network adapter or production runner integration here.
 */
function createLocalCalendarDeliverySimulator({ scheduling, simulation, accessPolicy, resolveConnection, clock }) {
  assert.ok(isLocalCalendarSimulation(simulation)); assert.equal(scheduling.store, simulation.store);
  const store = simulation.store; let ticking = false;
  function owned(state, context, id) {
    accessPolicy.resolve(context); const job = state.jobs[id];
    assert.ok(job?.sourceKind === "upload" && job.import?.userId === context.userId && job.import.localSimulation);
    return job;
  }
  function status(job, prefs, connection) { return scheduling.status(job, prefs, connection); }
  return { async tick(context) {
    accessPolicy.resolve(context); if (ticking) return false; ticking = true;
    try {
      const connection = await resolveConnection(context); accessPolicy.resolve(context);
      const jobs = await store.update(context.companyId, state => Object.values(state.jobs)
        .filter(job => job.sourceKind === "upload" && job.import?.userId === context.userId && job.import.localSimulation &&
          !["cancelled", "published", "failed", "partial"].includes(job.phase)).sort((a, b) => a.scheduledAt - b.scheduledAt));
      for (const job of jobs) for (const target of targets(job)) {
        const part = job.deliveries?.[target];
        if (part?.phase === "published") continue;
        if (part?.intent) {
          const result = await simulation.status(target);
          if (result?.published || result?.state === "failed_permanent") await store.update(context.companyId, state => {
            const current = owned(state, context, job.id); assert.equal(current.deliveries?.[target]?.intent, part.intent);
            record(current, target, { phase: result.published ? "published" : "failed", publication: result.published ? result : null }); return null;
          });
          return true;
        }
        const eligible = await store.update(context.companyId, state => {
          const current = owned(state, context, job.id);
          return current.scheduledAt <= clock() && status({ ...current, phase: "ready", error: null }, state.preferences, connection) === "scheduled";
        });
        if (!eligible) continue;
        const opened = await scheduling.open(context, { id: job.id, target }); await opened.stream(() => {});
        const intent = crypto.randomUUID();
        const claimed = await store.update(context.companyId, state => {
          const current = owned(state, context, job.id), active = status(current, state.preferences, connection);
          const previousConfirmed = started(current) && Object.values(current.deliveries || {}).every(item => item.phase === "published") &&
            status({ ...current, phase: "ready", error: null }, state.preferences, connection) === "scheduled";
          if (current.revision !== job.revision || current.scheduledAt > clock() ||
              active !== "scheduled" && !previousConfirmed || LOCKED.has(current.phase) && !previousConfirmed) return false;
          record(current, target, { intent, phase: "dispatching", publication: null }); return true;
        });
        if (!claimed) continue;
        accessPolicy.resolve(context); const result = await simulation.send(job, target, intent);
        await store.update(context.companyId, state => {
          const current = owned(state, context, job.id); assert.equal(current.deliveries?.[target]?.intent, intent);
          record(current, target, { phase: result?.published ? "published" : result?.state === "failed_permanent" ? "failed" : "confirming",
            publication: result?.published ? result : null }); return null;
        });
        return true;
      }
      return false;
    } finally { ticking = false; }
  } };
}
module.exports = { createLocalCalendarDeliverySimulator };
