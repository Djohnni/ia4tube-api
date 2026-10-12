"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const web = path.join(__dirname, "..", "src", "social", "production-web");
const source = fs.readFileSync(path.join(web, "reviewer.js"), "utf8");
const html = fs.readFileSync(path.join(web, "reviewer.html"), "utf8");
const origin = "https://ia4tube-api.onrender.com";
const reference = "A".repeat(32);
const appUri = "ia4tube://instagram/oauth-return";
const appIntent = "intent://instagram/oauth-return#Intent;scheme=ia4tube;package=com.ia4tube.app;end";
const androidChrome = "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/143.0.0.0 Mobile Safari/537.36";

function run({ url = `${origin}/reviewer?return_ref=${reference}`, agent = androidChrome } = {}) {
  const nodes = new Map();
  const fetches = [], navigations = [], storageWrites = [];
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: ["oauthAppReturn", "oauthAppReturnAlternative", "product", "preview"].includes(id),
      href: id === "oauthOpenApp" ? appUri : "",
      textContent: id === "status" ? "Entre com sua conta IA4Tube." : "",
      addEventListener() {},
      replaceChildren() {},
      removeAttribute() {},
      append() {}
    });
    return nodes.get(id);
  }
  const location = Object.freeze({ href: url, assign: value => navigations.push(value), replace: value => navigations.push(value) });
  vm.runInNewContext(source, {
    document: { getElementById: node },
    navigator: { userAgent: agent },
    location,
    URL,
    sessionStorage: { getItem: () => null, setItem: (...args) => storageWrites.push(args), removeItem: key => storageWrites.push(key) },
    fetch: (...args) => { fetches.push(args); throw new Error("Network forbidden in return UI test"); }
  });
  assert.deepEqual(fetches, [], "the return UI never authorizes or queries an account");
  assert.deepEqual(navigations, [], "the return UI never navigates without a user action");
  assert.deepEqual(storageWrites, [], "the return UI never modifies web credentials or publication state");
  assert.equal(node("login").hidden, false, "web login remains available");
  assert.equal(node("product").hidden, true, "a return URL must not authenticate the web client");
  return { node };
}

test("Android OAuth return offers only a fixed package-bound intent and leaves web login available", () => {
  const { node } = run();
  assert.equal(node("oauthAppReturn").hidden, false);
  assert.equal(node("oauthAppReturnAlternative").hidden, false);
  assert.equal(node("oauthOpenApp").href, appIntent);
  assert.equal(node("oauthOpenApp").href.includes(reference), false);
  assert.equal(node("status").textContent, "Continue no aplicativo ou entre abaixo para usar o painel web.");
});

test("Android browsers without Chrome receive a fixed explicit app link", () => {
  const { node } = run({ agent: "Mozilla/5.0 (Android 16; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0" });
  assert.equal(node("oauthAppReturn").hidden, false);
  assert.equal(node("oauthAppReturnAlternative").hidden, true);
  assert.equal(node("oauthOpenApp").href, appUri);
});

for (const fragment of ["", "#_", "#_=_"]) test(`inert OAuth fragment ${JSON.stringify(fragment)} is accepted but never forwarded`, () => {
  const { node } = run({ url: `${origin}/reviewer?return_ref=${reference}${fragment}` });
  assert.equal(node("oauthAppReturn").hidden, false);
  assert.equal(node("oauthOpenApp").href, appIntent);
  assert.equal(node("oauthAppReturnAlternative").hidden, false);
});

for (const [label, input] of [
  ["ordinary web visit", { url: `${origin}/reviewer` }],
  ["desktop callback", { agent: "Mozilla/5.0 (Windows NT 10.0) Chrome/143.0.0.0" }],
  ["iPhone callback", { agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile Safari/604.1" }],
  ["missing browser identification", { agent: "" }],
  ["different host", { url: `https://foreign.invalid/reviewer?return_ref=${reference}` }],
  ["host suffix attack", { url: `https://ia4tube-api.onrender.com.foreign.invalid/reviewer?return_ref=${reference}` }],
  ["wrong path", { url: `${origin}/reviewer/other?return_ref=${reference}` }],
  ["HTTP scheme", { url: `http://ia4tube-api.onrender.com/reviewer?return_ref=${reference}` }],
  ["credentials in URL", { url: `https://user:pass@ia4tube-api.onrender.com/reviewer?return_ref=${reference}` }],
  ["URL fragment", { url: `${origin}/reviewer?return_ref=${reference}#success` }],
  ["near-match OAuth fragment", { url: `${origin}/reviewer?return_ref=${reference}#_=_extra` }],
  ["fragment token", { url: `${origin}/reviewer?return_ref=${reference}#_&access_token=private` }],
  ["encoded OAuth fragment", { url: `${origin}/reviewer?return_ref=${reference}#%5F` }],
  ["duplicate reference", { url: `${origin}/reviewer?return_ref=${reference}&return_ref=${reference}` }],
  ["missing reference", { url: `${origin}/reviewer?return_ref=` }],
  ["short reference", { url: `${origin}/reviewer?return_ref=abc` }],
  ["long reference", { url: `${origin}/reviewer?return_ref=${"A".repeat(33)}` }],
  ["script reference", { url: `${origin}/reviewer?return_ref=${encodeURIComponent("<script>alert(1)</script>")}` }],
  ["encoded separator", { url: `${origin}/reviewer?return_ref=${"A".repeat(31)}%2F` }],
  ["redirect injection", { url: `${origin}/reviewer?return_ref=${reference}&returnTo=https://foreign.invalid` }],
  ["status injection", { url: `${origin}/reviewer?return_ref=${reference}&status=success` }],
  ["code injection", { url: `${origin}/reviewer?return_ref=${reference}&code=private` }],
  ["invalid URL", { url: "not a URL" }]
]) test(`${label} preserves the existing web flow without app handoff`, () => {
  const { node } = run(input);
  assert.equal(node("oauthAppReturn").hidden, true);
  assert.equal(node("oauthAppReturnAlternative").hidden, true);
  assert.equal(node("status").textContent, "Entre com sua conta IA4Tube.");
});

test("the opaque reference can only enable UI and never becomes a deep-link value", () => {
  for (const opaque of ["B".repeat(32), "abc_-123".repeat(4)]) {
    const { node } = run({ url: `${origin}/reviewer?return_ref=${opaque}` });
    assert.equal(node("oauthAppReturn").hidden, false);
    assert.equal(node("oauthOpenApp").href, appIntent);
  }
});

test("return markup is hidden by default, does not assert success, and suppresses referrers", () => {
  const panel = html.match(/<section id="oauthAppReturn"[^>]*>[\s\S]*?<\/section>/)?.[0];
  assert.ok(panel);
  assert.match(panel, /hidden aria-labelledby="oauthAppReturnTitle"/);
  assert.match(panel, /conferir o resultado da autorização/);
  assert.doesNotMatch(panel, /autorização concluída|conectado com sucesso|authorization_completed|return_ref|access_token|<script/i);
  assert.equal((panel.match(/href="ia4tube:\/\/instagram\/oauth-return"/g) || []).length, 2);
  assert.equal((panel.match(/rel="noreferrer" referrerpolicy="no-referrer"/g) || []).length, 2);
  assert.match(panel, /Voltar ao iA4tube/);
});
