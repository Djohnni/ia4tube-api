"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  INSTAGRAM_OAUTH_SCOPES
} = require("../src/social/oauth/instagram-config");
const {
  createInstagramScopeEvidence,
  emitInstagramScopeEvidence,
  sanitizeInstagramScopeEvidence
} = require("../src/social/oauth/instagram-scope-evidence");

test("scope evidence contains only canonical redacted metadata", () => {
  const evidence = createInstagramScopeEvidence({
    responseFormat: "data_envelope",
    permissionsPresent: true,
    permissions: [
      INSTAGRAM_OAUTH_SCOPES[1],
      "unknown_remote_scope",
      INSTAGRAM_OAUTH_SCOPES[0]
    ],
    access_token: "must-not-appear",
    code: "must-not-appear",
    state: "must-not-appear"
  });

  assert.deepEqual(evidence, {
    component: "social_instagram_oauth",
    event: "provider_scope_evidence",
    responseFormat: "data_envelope",
    permissionsFormat: "array",
    grantedScopeNames: INSTAGRAM_OAUTH_SCOPES
  });
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes("unknown_remote_scope"), false);
  assert.equal(serialized.includes("must-not-appear"), false);

  const absent = sanitizeInstagramScopeEvidence({
    component: "social_instagram_oauth",
    event: "provider_scope_evidence",
    responseFormat: "flat_object",
    permissionsFormat: "absent",
    grantedScopeNames: INSTAGRAM_OAUTH_SCOPES
  });
  assert.deepEqual(absent.grantedScopeNames, []);
});

test("absent permissions do not claim that the user denied scopes", () => {
  const evidence = createInstagramScopeEvidence({
    responseFormat: "flat_object",
    permissionsPresent: false
  });
  assert.deepEqual(evidence.grantedScopeNames, []);
  assert.equal(evidence.permissionsFormat, "absent");
});

test("partial comma-delimited evidence records only the canonical granted scope", () => {
  const evidence = createInstagramScopeEvidence({
    responseFormat: "data_envelope",
    permissionsPresent: true,
    permissions: INSTAGRAM_OAUTH_SCOPES[0]
  });
  assert.deepEqual(evidence.grantedScopeNames, [INSTAGRAM_OAUTH_SCOPES[0]]);
  assert.equal(evidence.permissionsFormat, "csv_string");
});

test("scope evidence sanitizer rejects malformed events and strips extra fields", () => {
  assert.equal(sanitizeInstagramScopeEvidence({ response: "raw" }), null);
  const safe = sanitizeInstagramScopeEvidence({
    component: "social_instagram_oauth",
    event: "provider_scope_evidence",
    responseFormat: "flat_object",
    permissionsFormat: "csv_string",
    grantedScopeNames: [
      INSTAGRAM_OAUTH_SCOPES[0],
      "unknown_remote_scope"
    ],
    access_token: "must-not-appear",
    code: "must-not-appear",
    state: "must-not-appear"
  });
  assert.deepEqual(Object.keys(safe), [
    "component",
    "event",
    "responseFormat",
    "permissionsFormat",
    "grantedScopeNames"
  ]);
  assert.deepEqual(safe.grantedScopeNames, [INSTAGRAM_OAUTH_SCOPES[0]]);
  const serialized = JSON.stringify(safe);
  assert.equal(serialized.includes("unknown_remote_scope"), false);
  assert.equal(serialized.includes("must-not-appear"), false);
});

test("diagnostic logger failures never alter the caller", async () => {
  const evidence = createInstagramScopeEvidence({
    responseFormat: "flat_object",
    permissionsPresent: false
  });
  assert.doesNotThrow(() => emitInstagramScopeEvidence({
    info() {
      throw new Error("synthetic logger failure");
    }
  }, evidence));
  assert.doesNotThrow(() => emitInstagramScopeEvidence({
    info() {
      return Promise.reject(new Error("synthetic async logger failure"));
    }
  }, evidence));
  const throwingGetter = {};
  Object.defineProperty(throwingGetter, "info", {
    get() {
      throw new Error("synthetic logger getter failure");
    }
  });
  assert.doesNotThrow(() => emitInstagramScopeEvidence(
    throwingGetter,
    evidence
  ));
  await new Promise((resolve) => setImmediate(resolve));
});
