"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), jwt = require("jsonwebtoken");
const { createOwnerDefaultCaption } = require("../src/social/calendar/imports/default-caption");
const { createSocialAuthAdapter } = require("../src/social/auth-adapter");
const { createProductionSession } = require("../src/social/production-session");
const { createCalendarGrants } = require("../src/social/calendar/grants");
function fixture() {
  const clients = { "synthetic-caption-a": { ativo: true, nome_empresa: "Empresa A", ramo: "nucleo_editorial_01" },
    "synthetic-caption-b": { ativo: true, nome_empresa: "Empresa B", ramo: "comercio" } };
  const session = createProductionSession({ secret: crypto.randomBytes(48).toString("hex"), readClients: () => clients });
  const auth = createSocialAuthAdapter({ namespaceUuid: crypto.randomUUID(), key: crypto.randomBytes(32), derivationVersion: "synthetic-v1" });
  return { clients, auth, resolve: createOwnerDefaultCaption(() => clients),
    principal: owner => auth.fromVerifiedJwt(jwt.decode(session.sign(owner))) };
}
test("default caption uses only the authenticated owner's known niche or public company name without inventing media contents", () => {
  const f = fixture(), a = f.principal("synthetic-caption-a"), b = f.principal("synthetic-caption-b");
  assert.equal(f.resolve(a), "Conheça a iA4tube e veja como organizar o conteúdo da sua empresa.\n#ia4tube");
  assert.equal(f.resolve(b), "Conheça Empresa B e acompanhe nosso conteúdo.");
  f.clients["synthetic-caption-b"].nome_empresa = "IA4TUBE";
  assert.equal(f.resolve(b), "Conheça iA4tube e acompanhe nosso conteúdo.");
  delete f.clients["synthetic-caption-b"].nome_empresa;
  assert.equal(f.resolve(b), "Conheça nosso trabalho e acompanhe nosso conteúdo.");
  f.clients["synthetic-caption-b"].nome_empresa = "Nome\ncom controle";
  assert.equal(f.resolve(b), "Conheça nosso trabalho e acompanhe nosso conteúdo.");
});
test("copied identity, absent owner, inactive owner, unfinished registration and delegated worker identity cannot read another profile", () => {
  const f = fixture(), a = f.principal("synthetic-caption-a");
  assert.throws(() => f.resolve({ ...a, subject: "synthetic-caption-b" }), { code: "calendar_import_submission_caption_owner_unavailable" });
  f.clients["synthetic-caption-a"].ativo = false;
  assert.throws(() => f.resolve(a), { code: "calendar_import_submission_caption_owner_unavailable" });
  f.clients["synthetic-caption-a"] = { ativo: true, cadastro_automatico: true, conta_finalizada: false };
  assert.throws(() => f.resolve(a), { code: "calendar_import_submission_caption_owner_unavailable" });
  delete f.clients["synthetic-caption-a"];
  assert.throws(() => f.resolve(a), { code: "calendar_import_submission_caption_owner_unavailable" });
  const grants = createCalendarGrants(crypto.randomBytes(32), () => 1000000);
  const envelope = grants.issueSubmission({ companyId: a.companyId, userId: a.userId, submissionId: "a".repeat(40), requestHash: "b".repeat(64) });
  const delegated = f.auth.fromVerifiedCalendarSubmission(grants.verifySubmission(envelope, a.companyId, a.userId));
  assert.throws(() => f.resolve(delegated), { code: "calendar_import_submission_caption_owner_unavailable" });
});
