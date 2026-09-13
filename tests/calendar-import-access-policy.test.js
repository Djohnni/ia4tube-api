"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createImportAccessPolicy, isImportAccessPolicy } = require("../src/social/calendar/imports/access-policy");
const owner = () => ({ authenticated: true, companyId: crypto.randomUUID(), userId: crypto.randomUUID() });

test("no implicit access, no implicit customer mode and default remains exactly one pilot pair", () => {
  const a = owner(), b = owner(), empty = createImportAccessPolicy();
  assert.equal(empty.executionAvailable, false);
  assert.throws(() => empty.resolve(a), /access_not_allowed/);
  assert.throws(() => createImportAccessPolicy({ allowedOwners: [a, b] }), /configuration_invalid/);
  assert.throws(() => createImportAccessPolicy({ allowedOwners: [{ ...a, audience: "customers" }] }), /configuration_invalid/);
  const pilot = createImportAccessPolicy({ allowedOwners: [a] });
  assert.equal(pilot.executionAvailable, true); assert.equal(pilot.resolve(a).audience, "owner_pilot");
  assert.throws(() => pilot.resolve(b), /access_not_allowed/);
  assert.throws(() => pilot.resolve({ ...a, userId: b.userId }), /access_not_allowed/);
});

test("single customer and multiple companies have trusted eligibility but no unwired remote execution", () => {
  const a = owner(), b = owner();
  for (const allowedOwners of [[{ ...a, audience: "customers" }], [{ ...a, audience: "owner_pilot" }, { ...b, audience: "customers" }]]) {
    const policy = createImportAccessPolicy({ mode: "multi_company", allowedOwners });
    assert.equal(policy.executionAvailable, false);
    assert.equal(policy.resolve({ ...a, audience: "owner_pilot" }).audience, allowedOwners[0].audience);
    assert.ok(isImportAccessPolicy(policy));
  }
  assert.equal(isImportAccessPolicy({ executionAvailable: true, resolve: () => ({ audience: "owner_pilot" }) }), false);
  assert.throws(() => createImportAccessPolicy({ mode: "multi_company", allowedOwners: [a] }), /configuration_invalid/);
});

test("configuration is copied, never takes audience from clients, and rechecks revocation", () => {
  const a = owner(), configured = { ...a, audience: "customers" }; let eligible = true;
  const policy = createImportAccessPolicy({ mode: "multi_company", allowedOwners: [configured], isEligible: identity => {
    assert.ok(Object.isFrozen(identity)); return eligible;
  } });
  configured.audience = "owner_pilot";
  assert.equal(policy.resolve({ ...a, audience: "owner_pilot", endUserSublicensing: true }).audience, "customers");
  eligible = false;
  assert.throws(() => policy.resolve(a), /access_not_allowed/);
  assert.equal(policy.resolve({ authenticated: true, role: "calendar_media_worker", companyId: a.companyId }, { worker: true }).companyId, a.companyId);
  assert.throws(() => policy.resolve({ ...a, role: "customer" }, { worker: true }), /access_not_allowed/);
});

test("invalid, unavailable or asynchronous eligibility fails closed; duplicates and mixed company audiences rejected", () => {
  const a = owner();
  for (const isEligible of [() => { throw new Error("private detail"); }, () => Promise.resolve(true), () => Promise.reject(new Error("private detail")), () => "true"]) {
    const policy = createImportAccessPolicy({ allowedOwners: [a], isEligible });
    assert.throws(() => policy.resolve(a), error => error.code === "calendar_import_access_not_allowed" && !error.message.includes("private"));
  }
  assert.throws(() => createImportAccessPolicy({ mode: "multi_company", allowedOwners: [{ ...a, audience: "customers" }, { ...a, audience: "customers" }] }), /configuration_invalid/);
  assert.throws(() => createImportAccessPolicy({ mode: "multi_company", allowedOwners: [{ ...a, audience: "customers" }, { ...a, userId: crypto.randomUUID(), audience: "owner_pilot" }] }), /configuration_invalid/);
});
