"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const express = require("express");
const { companyAccountIdentity } = require("../src/company-profile/account");
const { createCompanyProfileRouter } = require("../src/company-profile/router");

test("the read-only account projection exposes only the registration provider and login", () => {
  const google = Object.freeze({ ativo: true, login_tipo: "google", email: "owner@example.invalid", senha: "private", token: "private", saldo_extra: 100 });
  assert.deepEqual(companyAccountIdentity("google_synthetic", google), { provider: "google", login: "owner@example.invalid" });
  assert.deepEqual(companyAccountIdentity("47900112233", { ativo: true }), { provider: "whatsapp", login: "47900112233" });
  assert.deepEqual(companyAccountIdentity("synthetic_reviewer", { ativo: true, login_tipo: "whatsapp" }), { provider: "whatsapp", login: "synthetic_reviewer" });
  for (const [owner, client] of [["google_synthetic", { ...google, email: "" }], ["google_synthetic", { ...google, email: "bad\u0000@example.invalid" }],
    ["google_synthetic", { ...google, email: "x".repeat(255) }], ["google_synthetic", { ...google, ativo: false }],
    ["apple_synthetic", { ativo: true }], ["facebook_synthetic", { ativo: true, login_tipo: "facebook" }],
    ["", google], ["other owner", google], ["47900112233", null]]) assert.equal(companyAccountIdentity(owner, client), null);
});

test("authenticated profile reads use only their session account and never write balances or credentials", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "i4-account-view-"));
  const clients = { "google_synthetic": { ativo: true, login_tipo: "google", email: "google@example.invalid", senha: "private-a", saldo_extra: 15 },
    "47900112233": { ativo: true, login_tipo: "whatsapp", senha: "private-b", saldo_extra: 20 } };
  const original = JSON.stringify(clients), lookups = [], app = express();
  let unavailable = false;
  app.use("/company/profile", (req, _res, next) => {
    const owner = { "Bearer synthetic-google": "google_synthetic", "Bearer synthetic-phone": "47900112233" }[req.headers.authorization];
    if (owner) req.user = { whatsapp: owner };
    next();
  }, createCompanyProfileRouter({ baseDir: path.join(root, "profiles"), readClient: owner => {
    lookups.push(owner); if (unavailable) throw Error("private storage error"); return clients[owner];
  } }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}/company/profile`;
  const get = (token, suffix = "") => fetch(origin + suffix, { headers: token ? { Authorization: "Bearer " + token } : {} });
  const denied = await get(null); assert.equal(denied.status, 401); assert.equal(lookups.length, 0);
  const response = await get("synthetic-google", "?owner=47900112233&whatsapp=47900112233");
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /private, no-store/);
  const data = await response.json();
  assert.deepEqual(data.account, { provider: "google", login: "google@example.invalid" });
  assert.equal(JSON.stringify(data).includes("private-a"), false); assert.equal(JSON.stringify(data).includes("saldo_extra"), false);
  assert.equal(fs.existsSync(path.join(root, "profiles")), false);
  const form = new FormData(); form.append("profile", JSON.stringify({ email: "business@example.invalid", whatsapp: "other-contact" }));
  const saved = await fetch(origin, { method: "PUT", headers: { Authorization: "Bearer synthetic-google" }, body: form });
  assert.equal(saved.status, 200);
  const after = await (await get("synthetic-google")).json();
  assert.equal(after.profile.email, "business@example.invalid"); assert.equal(after.profile.whatsapp, "other-contact");
  assert.deepEqual(after.account, data.account);
  assert.deepEqual((await (await get("synthetic-phone")).json()).account, { provider: "whatsapp", login: "47900112233" });
  assert.equal(JSON.stringify(clients), original);
  unavailable = true;
  const partial = await (await get("synthetic-google")).json();
  assert.equal(partial.profile.email, "business@example.invalid"); assert.equal(partial.account, null);
  assert.equal(JSON.stringify(partial).includes("private storage error"), false);
});
