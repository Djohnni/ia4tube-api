"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJson } = require("../notifications/fcm-token-store");

const INVALID = "referral_partner_invalid";
const EXISTS = "referral_partner_exists";
const BAD_STORAGE = "referral_partner_storage_invalid";
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function normalizePartner(value, errorCode = INVALID) {
  const { name, handle } = value || {};
  if (typeof name !== "string" || typeof handle !== "string" || UNSAFE_TEXT.test(name) || UNSAFE_TEXT.test(handle)) {
    fail(errorCode);
  }
  const normalizedName = name.normalize("NFC").trim().replace(/\p{Zs}+/gu, " ");
  const username = handle.trim().replace(/^@/, "");
  if (!normalizedName || normalizedName.length > 100 || !/^[a-z0-9._]{1,30}$/i.test(username)) fail(errorCode);
  return { name: normalizedName, handle: "@" + username.toLowerCase() };
}

function normalizeList(values, errorCode) {
  if (!Array.isArray(values)) fail(errorCode);
  const partners = values.map(value => normalizePartner(value, errorCode));
  if (new Set(partners.map(partner => partner.handle)).size !== partners.length) fail(errorCode);
  return partners;
}

function createReferralPartnerDirectory({ root, initialPartners = [] }) {
  const file = path.join(root, "referral-partners.json");
  const defaults = normalizeList(initialPartners, INVALID);

  function list() {
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if (error.code === "ENOENT") return defaults.map(partner => ({ ...partner }));
      throw error;
    }
    if (!stat.isFile()) fail(BAD_STORAGE);
    const raw = fs.readFileSync(file, "utf8");
    let document;
    try {
      document = JSON.parse(raw);
    } catch {
      fail(BAD_STORAGE);
    }
    if (document?.schema !== 1) fail(BAD_STORAGE);
    return normalizeList(document.partners, BAD_STORAGE);
  }

  function add(input) {
    const partner = normalizePartner(input);
    const partners = list();
    if (partners.some(item => item.handle === partner.handle)) fail(EXISTS);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    atomicWriteJson(file, { schema: 1, partners: [...partners, partner] });
    return partner;
  }

  return { list, add };
}

module.exports = { createReferralPartnerDirectory };
