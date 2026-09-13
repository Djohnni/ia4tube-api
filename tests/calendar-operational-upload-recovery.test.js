"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), sharp = require("sharp");
const { Readable } = require("node:stream");
const { createOperationalPrivatePipelineFixture, hash } = require("./helpers/operational-private-pipeline-fixture");
test("physical upload interrupted during a part survives PostgreSQL restart and resumes the same asset without credit/order or duplicate inspection", async t => {
  const f = await createOperationalPrivatePipelineFixture(t);
  const bytes = await sharp(crypto.randomBytes(1500 * 1500 * 3), { raw: { width: 1500, height: 1500, channels: 3 } }).png().toBuffer();
  assert.ok(bytes.length > 5 * 1024 ** 2);
  const idempotencyKey = crypto.randomUUID(), initial = await f.upload.start(f.context,
    { idempotencyKey, kind: "image", mimeType: "image/png", sizeBytes: bytes.length, sha256: hash(bytes) });
  const part = bytes.subarray(0, 5 * 1024 ** 2), grant = await f.upload.authorizePart(f.context,
    { uploadId: initial.uploadId, partNumber: 1, sha256: hash(part), md5Base64: hash(part, "md5", "base64") });
  const upload = (await f.snapshot()).uploads[initial.uploadId];
  await assert.rejects(f.provider.acceptPart({ context: f.context, objectKey: upload.objectKey, uploadId: upload.disk.uploadId,
    partNumber: 1, authorizationId: grant.authorizationId, contentLength: part.length,
    stream: Readable.from((async function* () { yield part.subarray(0, 65536); throw new Error("synthetic-upload-interruption"); })()) }));
  assert.equal(f.counters.inspectionSourceReads, 0);
  await f.reopen({ restartDatabase: true });
  const complete = await f.uploadBytes(bytes, "image", "image/png", { idempotencyKey });
  assert.equal(complete.uploadId, initial.uploadId); assert.equal(complete.assetId, initial.assetId);
  assert.equal(complete.state, "uploaded"); assert.equal(f.counters.inspectionSourceReads, 1);
  const state = await f.snapshot(); assert.equal(Object.keys(state.uploads).length, 1);
  await assert.rejects(f.upload.status({ authenticated: true, companyId: crypto.randomUUID(), userId: crypto.randomUUID() },
    { uploadId: initial.uploadId }));
  assert.equal((await f.upload.status(f.context, { uploadId: initial.uploadId })).state, "uploaded");
  const ready = await f.enqueuePrepared(complete, { kind: "image", targets: ["feed"], audioMode: "none" });
  assert.equal(ready.status.ready, true); assert.equal(f.counters.preparationSourceReads, 1);
  t.diagnostic("SOURCE=LOCAL_SYNTHETIC_PNG; INTERRUPTED_PART=65536_BYTES; PERSISTENCE=REAL_POSTGRES; ORIGINAL_UPLOAD_ID_REUSED=YES");
});
