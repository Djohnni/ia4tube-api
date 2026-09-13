"use strict";
const crypto = require("node:crypto");
const { freshState, UUID } = require("../model");
const { validate } = require("../store");
const stores = new WeakMap(), scopes = new WeakMap();

/** Genuine volatile transactions, not HTTP flags or a PostgreSQL wrapper.
 * A proof exists only inside this store's transaction. No network connector.
 */
function createLocalCalendarSimulationStore({ enabled = false } = {}) {
  if (enabled !== true) throw new TypeError("calendar_local_simulation_disabled");
  const rows = new Map(), scope = Object.freeze({}), outcomes = new Map(), sends = [];
  let tail = Promise.resolve();
  const store = Object.freeze({
    capabilities: Object.freeze({ persistence: "volatile-test", testOnly: true, localOnly: true, readyForProduction: false }),
    async exists(companyId) { return rows.has(companyId); },
    update(companyId, operation) {
      if (!UUID.test(companyId || "") || typeof operation !== "function") return Promise.reject(new TypeError("calendar_local_owner_invalid"));
      const pending = tail.then(() => {
        const state = structuredClone(rows.get(companyId) || freshState()); scopes.set(state, scope);
        try {
          const result = operation(state);
          if (typeof result?.then === "function") { result.catch(() => {}); throw new TypeError("calendar_local_transaction_async"); }
          validate(state); rows.set(companyId, state); return structuredClone(result);
        } finally { scopes.delete(state); }
      });
      tail = pending.catch(() => {}); return pending;
    },
    snapshotForTest(companyId) { return structuredClone(rows.get(companyId) || freshState()); }
  });
  const simulation = Object.freeze({
    store,
    capabilities: Object.freeze({ localOnly: true, testOnly: true, networkDelivery: false, readyForProduction: false }),
    setOutcomeForTest(target, result) { outcomes.set(target, structuredClone(result)); },
    sentForTest() { return structuredClone(sends); },
    async send(job, target, intent) {
      if (sends.some(item => item.intent === intent)) throw new Error("calendar_local_duplicate_send");
      sends.push({ jobId: job.id, target, intent, sha256: job.assets[target].sha256, mimeType: job.assets[target].mimeType });
      return outcomes.has(target) ? structuredClone(outcomes.get(target)) : { published: true, mediaId: `local-${crypto.randomUUID()}`, simulated: true };
    },
    async status(target) { return outcomes.has(target) ? structuredClone(outcomes.get(target)) : null; }
  });
  stores.set(store, { scope, simulation }); return simulation;
}
function isLocalCalendarSimulation(value, store = value?.store) { return Boolean(value && stores.get(store)?.simulation === value); }
function isLocalCalendarState(state, simulation) { return isLocalCalendarSimulation(simulation) && scopes.get(state) === stores.get(simulation.store).scope; }
module.exports = { createLocalCalendarSimulationStore, isLocalCalendarSimulation, isLocalCalendarState };
