"use strict";

const FIELD_LIMITS = Object.freeze({ nome_empresa: 160, ramo: 160, whatsapp: 64, instagram: 512, facebook: 1024,
  outros_links: 4000, historia: 4000, endereco: 500, cidade: 160, estado: 80, cep: 32, email: 254, site: 2048 });
const FIELDS = Object.freeze(Object.keys(FIELD_LIMITS));
const MAX_LOGO_BYTES = 5 * 1024 * 1024, MAX_LOGO_PIXELS = 25 * 1000 * 1000, MAX_LOGO_SIDE = 1024;
const MAX_PROFILE_PART_BYTES = 64 * 1024, MAX_RECORD_BYTES = 8 * 1024 * 1024;
const URL_FIELDS = new Set(["instagram", "facebook", "outros_links", "site"]);
function fail(code = "company_profile_invalid", statusCode = 400) {
  throw Object.assign(new Error(code), { code, statusCode });
}
function ownerHash(owner) {
  if (typeof owner !== "string" || !owner.trim() || owner.length > 200 || /[\u0000-\u001f\u007f]/.test(owner))
    fail("company_profile_session_required", 401);
  return require("node:crypto").createHash("sha256").update("ia4tube-company-profile-v1\0" + owner).digest("hex");
}
function emptyProfile() { return Object.fromEntries(FIELDS.map(field => [field, ""])); }
function profilePatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(field => !Object.hasOwn(FIELD_LIMITS, field))) fail();
  const result = {};
  for (const [field, text] of Object.entries(value)) {
    if (typeof text !== "string" || text.length > FIELD_LIMITS[field] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) fail();
    if (!["historia", "outros_links"].includes(field) && /[\r\n\t]/.test(text)) fail();
    const normalized = text.trim();
    if (URL_FIELDS.has(field)) {
      const compact = normalized.replace(/\s/g, "");
      if (/(?:^|[^a-z0-9+.-])(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|d\s*a\s*t\s*a|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t|f\s*i\s*l\s*e|b\s*l\s*o\s*b)\s*:/i.test(normalized)) fail();
      if (field !== "outros_links" && /^[a-z][a-z0-9+.-]*:/i.test(compact) && !/^https?:\/\//i.test(compact)) fail();
    }
    result[field] = normalized;
  }
  return result;
}
module.exports = { FIELDS, FIELD_LIMITS, MAX_LOGO_BYTES, MAX_LOGO_PIXELS, MAX_LOGO_SIDE,
  MAX_PROFILE_PART_BYTES, MAX_RECORD_BYTES, ownerHash, emptyProfile, profilePatch, fail };
