"use strict";

const { LEGACY_STORY_PACKAGE, STORY_PACKAGE } = require("./story-quota");

function createPromoRollout(env = process.env) {
  const accounts = new Set(String(env.IA4TUBE_PROMO_INTERNAL_ACCOUNTS || "").split(",").map(account => account.trim()).filter(Boolean));
  const publicEnabled = env.IA4TUBE_PROMO_PUBLIC_ENABLED === "true";
  const applies = owner => typeof owner === "string" && owner.length > 0 && (publicEnabled || accounts.has(owner));
  const welcomeArtEnabled = env.IA4TUBE_WELCOME_ART_ENABLED === "true";
  return Object.freeze({
    startWelcomeArt: welcomeArtEnabled && (publicEnabled || accounts.size > 0),
    welcomeArtFor: owner => welcomeArtEnabled && applies(owner),
    storyPackageFor: owner => applies(owner) ? STORY_PACKAGE : LEGACY_STORY_PACKAGE
  });
}

module.exports = { createPromoRollout };
