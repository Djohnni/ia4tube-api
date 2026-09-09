"use strict";
const { fail } = require("./model");
const TARGETS = Object.freeze({ feed: ["feed"], story: ["story"], both: ["feed", "story"] });
function destination(value = "feed") {
  if (!Object.hasOwn(TARGETS, value)) fail("calendar_destination_invalid", 400);
  return value;
}
function targets(job) { return TARGETS[destination(job.destination || "feed")]; }
function started(job) { return Boolean(job.intent || Object.values(job.deliveries || {}).some(item => item.intent)); }
function delivery(job, target) {
  const saved = job.deliveries?.[target];
  return { ...job, target, asset: job.assets?.[target] || (target === "feed" ? job.asset : null),
    phase: saved?.phase || (job.intent ? job.phase : "ready"),
    intent: saved?.intent || (target === "feed" ? job.intent : null),
    publication: saved?.publication || null, error: saved?.error || (!started(job) ? job.error : null) };
}
function record(job, target, update) {
  job.deliveries ||= {};
  job.deliveries[target] = { ...job.deliveries[target], ...update };
  const parts = targets(job).map(key => job.deliveries[key]);
  const published = parts.filter(item => item?.phase === "published").length;
  const failed = parts.some(item => item?.phase === "failed");
  job.phase = published === parts.length ? "published" : failed ? (published ? "partial" : "failed") : "confirming";
  job.publication = targets(job).length === 1 ? parts[0]?.publication || null : null;
  job.error = published === parts.length ? null : failed ? "calendar_provider_failed" : "calendar_result_unconfirmed";
  job.revision++;
}
module.exports = { destination, targets, started, delivery, record };
