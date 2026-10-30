"use strict";
const express = require("express");
const { ADMIT_PATH, hash, fail } = require("./admission-contract");
function isAdmissionRequest(req) {
  return req.method === "POST" && String(req.path || "").toLowerCase().replace(/\/+$/, "") === ADMIT_PATH;
}
const jsonParser = express.json({ limit: "16kb", strict: true });
function admissionJsonParser(req, res, next) {
  if (!req.is("application/json")) return res.status(415).set("Cache-Control", "no-store")
    .json({ ok: false, code: "edit_calendar_input_invalid" });
  return jsonParser(req, res, next);
}
function admissionJsonError(error, req, res, next) {
  if (!isAdmissionRequest(req) || !["entity.parse.failed", "entity.too.large", "charset.unsupported", "encoding.unsupported"].includes(error?.type)) return next(error);
  const status = error.type === "entity.too.large" ? 413 : ["charset.unsupported", "encoding.unsupported"].includes(error.type) ? 415 : 400;
  return res.status(status).set("Cache-Control", "no-store")
    .json({ ok: false, code: "edit_calendar_input_invalid" });
}
function createCapabilityRateGuard({ verifyCapability, clock = Date.now, capacity = 60, maximumKeys = 4096, ttlMs = 10 * 60000 } = {}) {
  const invalidIps = new Map(), tickets = new Map();
  function consume(buckets, key) {
    const now = clock();
    for (const [storedKey, value] of buckets) if (now - value.lastSeen >= ttlMs) buckets.delete(storedKey);
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= maximumKeys) buckets.delete(buckets.keys().next().value);
      bucket = { tokens: capacity, updatedAt: now, lastSeen: now }; buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.updatedAt) * capacity / 60000);
    bucket.updatedAt = now; bucket.lastSeen = now;
    if (bucket.tokens < 1) {
      const error = Object.assign(new Error("Aguarde antes de tentar novamente."),
        { code: "edit_calendar_admission_rate_limited", statusCode: 429,
          retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) * 60 / capacity)) });
      throw error;
    }
    bucket.tokens--;
  }
  function authorize(req) {
    let ticketKey;
    try {
      if (typeof verifyCapability !== "function") fail("admission_disabled", 503);
      ticketKey = verifyCapability(req.body);
      if (typeof ticketKey !== "string" || !/^[0-9a-f]{64}$/.test(ticketKey)) fail("admission_unavailable", 503);
    } catch (error) {
      if (error.code !== "edit_calendar_admission_disabled")
        consume(invalidIps, hash(String(req.ip || req.socket?.remoteAddress || "unknown")));
      throw error;
    }
    // Cloud Run/NAT egress is shared. Invalid traffic never exhausts another owner's valid capability.
    consume(tickets, ticketKey);
  }
  return Object.freeze({ authorize, sizes() { return { invalidIps: invalidIps.size, tickets: tickets.size }; } });
}
module.exports = { isAdmissionRequest, admissionJsonParser, admissionJsonError, createCapabilityRateGuard };
