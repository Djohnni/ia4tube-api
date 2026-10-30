"use strict";

const crypto = require("node:crypto");
const { caption } = require("../social/calendar/model");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const TICKET = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;
const ADMIT_PATH = "/empresa/edit/orders/admit";
const CANCEL_PATH = "/empresa/edit/orders/admission/cancel";
function fail(code, statusCode = 409) {
  throw Object.assign(new Error("Autorizacao do pedido indisponivel."), { code: `edit_calendar_${code}`, statusCode });
}
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) fail("input_invalid", 400);
}
function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  fail("input_invalid", 400);
}
function admissionOrderId(ticket) {
  if (typeof ticket !== "string" || ticket.length !== 80 || !TICKET.test(ticket)) fail("input_invalid", 400);
  const bytes = crypto.createHash("sha256").update(`edit-app-order-v1\n${ticket}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function admissionInput(value) {
  exact(value, ["schemaVersion", "ticket", "editOrderId", "requestHash", "mediaKind", "title", "caption", "durationSeconds", "selection", "quantity"]);
  exact(value.selection, ["modelId", "modelVersion", "sourceDigest"]);
  if (value.schemaVersion !== 1 || typeof value.ticket !== "string" || value.ticket.length !== 80 || !TICKET.test(value.ticket) ||
      typeof value.editOrderId !== "string" || !UUID.test(value.editOrderId) || typeof value.requestHash !== "string" ||
      !HASH.test(value.requestHash) || !["image", "video"].includes(value.mediaKind) || value.quantity !== 1 ||
      typeof value.selection.modelId !== "string" || !UUID.test(value.selection.modelId) ||
      !Number.isSafeInteger(value.selection.modelVersion) || value.selection.modelVersion < 1 ||
      typeof value.selection.sourceDigest !== "string" || !HASH.test(value.selection.sourceDigest) || typeof value.title !== "string" || !value.title.trim() || value.title.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(value.title) || typeof value.caption !== "string" ||
      (value.mediaKind === "image" ? value.durationSeconds !== null :
        !Number.isFinite(value.durationSeconds) || value.durationSeconds < 3 || value.durationSeconds > 60)) fail("input_invalid", 400);
  let normalizedCaption;
  try { normalizedCaption = caption(value.caption); } catch { fail("input_invalid", 400); }
  if (normalizedCaption !== value.caption.trim()) fail("input_invalid", 400);
  if (Buffer.byteLength(canonicalJson(value)) > 16384) fail("input_invalid", 413);
  return { schemaVersion: 1, ticket: value.ticket, editOrderId: value.editOrderId.toLowerCase(), requestHash: value.requestHash,
    mediaKind: value.mediaKind, title: value.title.trim(), caption: normalizedCaption, durationSeconds: value.durationSeconds,
    selection: { modelId: value.selection.modelId.toLowerCase(), modelVersion: value.selection.modelVersion, sourceDigest: value.selection.sourceDigest }, quantity: 1 };
}
function statusInput(editOrderId, value) {
  exact(value, ["requestHash", "contextHash", "mediaKind"]);
  if (!UUID.test(editOrderId || "") || !HASH.test(value.requestHash || "") || !HASH.test(value.contextHash || "") ||
      !["image", "video"].includes(value.mediaKind)) fail("input_invalid", 400);
  return { editOrderId: editOrderId.toLowerCase(), ...value };
}
function cancelInput(value) {
  exact(value, ["schemaVersion", "ticket", "editOrderId", "requestHash", "reason"]);
  if (value.schemaVersion !== 1 || !TICKET.test(value.ticket || "") || !UUID.test(value.editOrderId || "") ||
      !HASH.test(value.requestHash || "") || !["upload_unavailable", "submission_aborted"].includes(value.reason)) fail("input_invalid", 400);
  return { ...value, editOrderId: value.editOrderId.toLowerCase() };
}
function createAdmissionAuthentication({ enabled = false, secret = "", clock = Date.now } = {}) {
  const configured = enabled === true && typeof secret === "string" && /^[\x21-\x7e]{32,256}$/.test(secret);
  function authenticate(path, headers, body) {
    if (!configured) fail("admission_disabled", 503);
    // HMAC remains an optional private cancellation scope. Admission itself uses the existing ticket capability.
    if (path !== CANCEL_PATH) fail("admission_unauthorized", 403);
    const timestamp = headers?.["x-ia4tube-edit-timestamp"], signature = headers?.["x-ia4tube-edit-signature"];
    if (typeof timestamp !== "string" || !/^[1-9][0-9]{9,10}$/.test(timestamp) ||
        Math.abs(Math.floor(clock() / 1000) - Number(timestamp)) > 300 ||
        typeof signature !== "string" || !/^v1=[a-f0-9]{64}$/.test(signature)) fail("admission_unauthorized", 403);
    const canonical = canonicalJson(body);
    if (Buffer.byteLength(canonical) > 16384) fail("input_invalid", 400);
    const expected = crypto.createHmac("sha256", secret).update(`v1\nPOST\n${path}\n${timestamp}\n${hash(canonical)}`).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature.slice(3), "hex"))) fail("admission_unauthorized", 403);
  }
  return Object.freeze({ authenticate, configured });
}
module.exports = { ADMIT_PATH, CANCEL_PATH, HASH, UUID, TICKET, fail, exact, hash, canonicalJson, admissionOrderId, admissionInput, statusInput, cancelInput, createAdmissionAuthentication };
