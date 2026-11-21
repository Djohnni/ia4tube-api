"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { LEGACY_STORY_PACKAGE, STORY_PACKAGE } = require("./story-quota");

function createPromoRollout(env = process.env, { internalWelcomeRoot = null } = {}) {
  const accounts = new Set(String(env.IA4TUBE_PROMO_INTERNAL_ACCOUNTS || "").split(",").map(account => account.trim()).filter(Boolean));
  const publicEnabled = env.IA4TUBE_PROMO_PUBLIC_ENABLED === "true";
  const validOwner = owner => typeof owner === "string" && owner.length > 0;
  const applies = owner => validOwner(owner) && (publicEnabled || accounts.has(owner));
  const welcomeArtEnabled = env.IA4TUBE_WELCOME_ART_ENABLED === "true";
  const testVersions = new Set(internalWelcomeRoot
    ? String(env.IA4TUBE_WELCOME_ART_TEST_VERSION || "").split(",").map(version => version.trim()).filter(version => /^[1-9]\d{0,9}$/.test(version))
    : []);

  const markerFor = owner => path.join(internalWelcomeRoot,
    crypto.createHash("sha256").update("welcome-art-enrollment\0" + owner).digest("hex"));
  function isEnrolled(owner) {
    if (!testVersions.size || !validOwner(owner)) return false;
    try { return fs.lstatSync(markerFor(owner)).isFile(); }
    catch { return false; }
  }
  function enrollWelcomeArtFor(owner, androidVersion) {
    // The version only selects the rollout; it does not attest the device or Play track.
    if (!welcomeArtEnabled || !testVersions.has(androidVersion) || !validOwner(owner) || isEnrolled(owner)) return;
    fs.mkdirSync(internalWelcomeRoot, { recursive: true, mode: 0o700 });
    try {
      fs.closeSync(fs.openSync(markerFor(owner), "wx", 0o600));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  return Object.freeze({
    startWelcomeArt: welcomeArtEnabled && (publicEnabled || accounts.size > 0 || testVersions.size > 0),
    welcomeArtFor: owner => welcomeArtEnabled && (applies(owner) || isEnrolled(owner)),
    enrollWelcomeArtFor,
    storyPackageFor: owner => applies(owner) ? STORY_PACKAGE : LEGACY_STORY_PACKAGE
  });
}

module.exports = { createPromoRollout };
