"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { createProductionSession } = require("../src/social/production-session");
const { createProductionMedia, realReviewerUploadJpegDimensions } = require("../src/social/production-media");
const { loadInstagramOAuthConfig } = require("../src/social/oauth/instagram-config");
const secret = crypto.randomBytes(40).toString("base64");
const owner = "synthetic-owner";
const clients = { [owner]: { ativo: true } };
const session = createProductionSession({ secret, readClients: () => clients });
function check(token) {
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  let next = false;
  session.authenticate(req, res, () => { next = true; });
  return { req, res, next };
}
test("fresh owner session is v2 and cannot choose another company", () => {
  const result = check(session.sign(owner));
  assert.equal(result.next, true);
  assert.equal(result.req.user.company_id, owner);
  assert.equal(result.req.user.token_version, 2);
  assert.equal(Object.isFrozen(result.req.user), true);
});
for (const alteration of [{company_id:"another"}, {sub:"another"}, {token_version:1}, {iss:"wrong"}, {aud:"wrong"}, {jti:"short"}]) {
  test(`reject mismatched social session ${Object.keys(alteration)[0]}`, () => {
    const claims = jwt.decode(session.sign(owner));
    const token = jwt.sign({ ...claims, ...alteration }, secret, { algorithm:"HS256" });
    assert.equal(check(token).next, false);
  });
}
test("legacy token still requires fresh login for social, never silent conversion", () => {
  assert.equal(check(jwt.sign({whatsapp:owner},secret,{algorithm:"HS256"})).res.code,401);
});
test("removed or inactive product owner cannot enter social", () => {
  const token = session.sign(owner);
  clients[owner].ativo = false;
  assert.equal(check(token).next,false);
  clients[owner].ativo = true;
  assert.equal(check(session.sign("unknown-owner")).next,false);
});
for (const active of [undefined, null, 0, false, "true"]) test(`social session requires explicitly active owner (${String(active)})`, () => {
  const local = { [owner]: { ativo: active } };
  const verifier = createProductionSession({ secret, readClients: () => local });
  let next = false;
  const res = { status(value) { this.code = value; return this; }, json() {} };
  verifier.authenticate({ headers: { authorization: `Bearer ${verifier.sign(owner)}` } }, res, () => { next = true; });
  assert.equal(next, false); assert.equal(res.code, 401);
});
test("temporary auto account cannot enter social until legitimately finalized", () => {
  const local = { [owner]: { ativo: true, cadastro_automatico: true } };
  const verifier = createProductionSession({ secret, readClients: () => local });
  const req = { headers: { authorization: `Bearer ${verifier.sign(owner)}` } };
  let next = false;
  const res = { status() { return this; }, json() {} };
  verifier.authenticate(req, res, () => { next = true; }); assert.equal(next, false);
  local[owner].conta_finalizada = true;
  verifier.authenticate(req, res, () => { next = true; }); assert.equal(next, true);
});
const env = { ENVIRONMENT:"production", PUBLIC_API_BASE_URL:"https://ia4tube-api.onrender.com",
  SOCIAL_INSTAGRAM_ENABLED:"true", SOCIAL_EXTERNAL_CONNECTION_ENABLED:"false", SOCIAL_EXTERNAL_PUBLICATION_ENABLED:"false",
  INSTAGRAM_APP_ID:"12345678901234", INSTAGRAM_APP_SECRET:crypto.randomBytes(32).toString("hex"),
  INSTAGRAM_GRAPH_API_VERSION:"v25.0", INSTAGRAM_OAUTH_REDIRECT_URI:"https://ia4tube-api.onrender.com/v1/social/oauth/callback" };
test("production config has its own callback, true environment and mandatory binding with external gates closed", () => {
  const config = loadInstagramOAuthConfig(env);
  assert.equal(config.environment,"production");
  assert.equal(config.publicationBindingRequired,true);
  assert.equal(config.externalConnectionEnabled,false);
  assert.equal(config.externalPublicationEnabled,false);
  assert.equal(config.redirectUri,env.INSTAGRAM_OAUTH_REDIRECT_URI);
});
for (const extra of [
  {PUBLIC_API_BASE_URL:"https://ia4tube-api-staging-checkpoint-a.onrender.com"},
  {RENDER_SERVICE_ID:"srv-wrong"}, {REVIEW_SANDBOX_ENABLED:"true"},
  {INSTAGRAM_OAUTH_REDIRECT_URI:"https://ia4tube-api-staging-checkpoint-a.onrender.com/v1/social/oauth/callback"}
]) test(`production configuration rejects mismatched ${Object.keys(extra)[0]}`, () => {
  assert.throws(() => loadInstagramOAuthConfig({...env,...extra}));
});
// Structural fixture only: this tests parser/storage contracts, not a JPEG decoder.
const jpeg = Buffer.from([0xff,0xd8,0xff,0xdb,0,3,0,0xff,0xc4,0,3,0,
  0xff,0xc0,0,11,8,4,56,4,56,1,1,0x11,0,
  0xff,0xda,0,8,1,1,0,0,63,0,1,0xff,0xd9]);
test("direct JPEG module validates structure and refuses arbitrary bytes", () => {
  assert.deepEqual(realReviewerUploadJpegDimensions(jpeg),{width:1080,height:1080});
  assert.equal(realReviewerUploadJpegDimensions(Buffer.alloc(40)),null);
});
test("direct JPEG is persisted in isolated DATA_DIR and cannot cross company/owner", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),"ia4tube-media-contract-"));
  t.after(() => {
    assert.equal(path.dirname(directory),os.tmpdir());
    assert.ok(path.basename(directory).startsWith("ia4tube-media-contract-"));
    fs.rmSync(directory,{recursive:true,force:true});
  });
  const mediaEnv = { ...env, SOCIAL_TENANT_NAMESPACE_UUID:crypto.randomUUID(),
    SOCIAL_IDENTITY_DERIVATION_VERSION:"1", SOCIAL_IDENTITY_DERIVATION_KEY:crypto.randomBytes(32).toString("base64") };
  const surface = createProductionMedia({env:mediaEnv,dataDir:directory,readClients:()=>clients});
  const context = {companyId:crypto.randomUUID()};
  const stored = await surface.media.storeOwnedJpeg({context,owner,bytes:jpeg,caption:"Teste tecnico local"});
  assert.match(stored.metadataDigest,/^[a-f0-9]{64}$/);
  assert.equal((await surface.media.listOwnedJpegs({context,owner})).length,1);
  assert.equal((await surface.media.resolveOwnedJpeg({context,owner,mediaId:stored.mediaId})).metadataDigest,stored.metadataDigest);
  assert.equal(await surface.media.resolveOwnedJpeg({context:{companyId:crypto.randomUUID()},owner,mediaId:stored.mediaId}),null);
  assert.equal(await surface.media.resolveOwnedJpeg({context,owner:"another-owner",mediaId:stored.mediaId}),null);
  const restored = createProductionMedia({env:mediaEnv,dataDir:directory,readClients:()=>clients});
  assert.equal((await restored.media.listOwnedJpegs({context,owner}))[0].mediaId,stored.mediaId);
  assert.deepEqual(fs.readdirSync(directory),["reviewer_media"]);
});
