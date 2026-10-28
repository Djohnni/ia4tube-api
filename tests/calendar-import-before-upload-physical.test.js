"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs/promises"), path = require("node:path");
const { createOperationalCalendarPipelineFixture, PREFIX, hash } = require("./helpers/operational-calendar-pipeline-fixture");
const { configureGooglePipeline } = require("./helpers/gcs-operational-pipeline");
const { createOfflineGcsFixture } = require("./helpers/gcs-offline-storage-fixture");
const { FFMPEG } = require("./helpers/operational-private-pipeline-fixture");
const { runBoundedProcess } = require("../src/social/calendar/imports/preparation");
const NEGOTIATED = { "X-IA4Tube-Media-Transport": "gcs-parts-v1" };
test("before-PUT calendar intent survives PostgreSQL restart and finishes with no phone complete/submission call", { timeout: 300000 }, async t => {
  let f; const cloud = createOfflineGcsFixture({ clock: () => f?.clock() || Date.now() }); t.after(() => cloud.close());
  f = await createOperationalCalendarPipelineFixture(t, { beforeUploadSubmission: true,
    configurePrivatePipeline: (t, pipeline, options) => configureGooglePipeline(t, pipeline, { ...options, gcsCloud: cloud }) });
  f.setFixtureGate(false);
  const source = path.join(f.root, "before-upload-synthetic.mp4");
  const process = await runBoundedProcess(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
    "testsrc2=size=96x160:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3", "-threads", "2",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-n", source],
    { cwd: f.root, timeoutMs: 10000 });
  assert.equal(process.code, 0);
  const free = Buffer.alloc(6 * 1024 * 1024); free.writeUInt32BE(free.length); free.write("free", 4, "ascii");
  const bytes = Buffer.concat([await fs.readFile(source), free]);
  const context = () => ({ ...f.context, mediaTransport: "gcs-parts-v1" });
  const post = async (route, input) => {
    const response = await f.request(route, { method: "POST", headers: { ...NEGOTIATED, "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const json = await response.json(); assert.equal(response.status, 200, JSON.stringify(json)); return json;
  };
  const capability = await (await f.request(`${PREFIX}/capabilities`, { headers: NEGOTIATED })).json();
  assert.equal(capability.scheduling.beforeUploadSubmission, true);
  assert.equal((await (await f.request(`${PREFIX}/capabilities`)).json()).scheduling.beforeUploadSubmission, undefined);
  const startBody = { idempotencyKey: crypto.randomUUID(), kind: "video", mimeType: "video/mp4", sizeBytes: bytes.length, sha256: hash(bytes), uploadMode: "single" };
  const started = (await post(`${PREFIX}/uploads`, startBody)).upload;
  const route = `${PREFIX}/assets/${started.assetId}/calendar-submissions`;
  const body = { uploadId: started.uploadId, idempotencyKey: crypto.randomUUID(), expectedMediaRevision: 0,
    selection: { kind: "video", targets: ["reel"], audioMode: "original" }, caption: "Vídeo sintético preservado", awaitUpload: true };
  const accepted = (await post(route, body)).submission;
  assert.equal(accepted.state, "accepted"); assert.equal(accepted.uploadPending, true); assert.equal(accepted.calendarItemId, null);
  let card = (await f.current().calendar.list(f.claims)).items.find(item => item.id === accepted.id);
  assert.equal(card.status, "waiting_media"); assert.equal(card.automatic, false); assert.equal(card.formatsReady, false);
  assert.match(card.statusLabel, /Recebendo/);
  await f.current().imports.submissions.progress(f.context.companyId);
  assert.equal((await f.snapshot()).uploads[started.uploadId].state, "uploading");
  const calls = cloud.calls.length;
  await f.reopen({ restartDatabase: true });
  await Promise.all([f.current().imports.submissions.progress(f.context.companyId), f.current().imports.submissions.progress(f.context.companyId)]);
  assert.equal(cloud.calls.length, calls, "Missing-object backoff survives service/database restart");
  const recovered = await f.current().imports.submissions.byKey(f.context, started.assetId, body.idempotencyKey);
  assert.equal(recovered.id, accepted.id); assert.equal((await post(route, body)).submission.id, accepted.id);
  const authorization = await f.upload.authorizePart(context(), { uploadId: started.uploadId, partNumber: 1,
    sha256: hash(bytes), md5Base64: crypto.createHash("md5").update(bytes).digest("base64") });
  const grant = await f.upload.resolvePart(context(), { uploadId: started.uploadId, partNumber: 1, authorizationId: authorization.authorizationId });
  const puts = cloud.calls.filter(call => call.operation === "signed_put").length;
  cloud.failNext("signed_put", { afterCommit: true }); await assert.rejects(cloud.putSigned(grant, bytes));
  // Phone is gone after an uncertain Google PUT. No /complete or second
  // calendar submission is sent: only the existing server worker progresses.
  await f.reopen({ restartDatabase: true }); f.advance(10000);
  await f.current().imports.submissions.progress(f.context.companyId);
  assert.equal((await f.snapshot()).uploads[started.uploadId].state, "uploaded");
  await f.preparation.dispatchNext(f.context);
  await f.current().imports.submissions.progress(f.context.companyId);
  const final = await f.current().imports.submissions.byKey(f.context, started.assetId, body.idempotencyKey);
  assert.equal(final.state, "scheduled"); assert.equal(final.calendarItemId, accepted.id); assert.equal(final.uploadPending, false);
  const state = await f.current().calendarStore.update(f.context.companyId, state => state);
  assert.equal(Object.values(state.jobs).filter(job => job.import?.submissionId === accepted.id).length, 1);
  assert.equal(state.jobs[accepted.id].caption, body.caption);
  const stored = (await f.snapshot()).uploads[started.uploadId];
  assert.equal(stored.verified.sha256, hash(bytes)); assert.equal(stored.verified.hasAudio, true);
  assert.equal(hash(cloud.objects.get(stored.objectKey + "/source").bytes), hash(bytes));
  assert.equal(cloud.calls.filter(call => call.operation === "signed_put").length, puts + 1);
  assert.equal(f.providerCalls.length, 0, "No Meta/publication action occurs in this test");
  assert.notEqual((await f.request(`${route}/by-key/${body.idempotencyKey}`, { headers: { Authorization: `Bearer ${f.otherToken}` } })).status, 200);
  assert.equal((await post(route, body)).submission.id, accepted.id);
  const reservedBefore = (await f.snapshot()).reservedBytes;
  const pendingUpload = (await post(`${PREFIX}/uploads`, { ...startBody, idempotencyKey: crypto.randomUUID() })).upload;
  const pendingBody = { ...body, uploadId: pendingUpload.uploadId, idempotencyKey: crypto.randomUUID() };
  const pendingRoute = `${PREFIX}/assets/${pendingUpload.assetId}/calendar-submissions`;
  const pending = (await post(pendingRoute, pendingBody)).submission;
  const pendingAuthorization = await f.upload.authorizePart(context(), { uploadId: pendingUpload.uploadId, partNumber: 1,
    sha256: hash(bytes), md5Base64: crypto.createHash("md5").update(bytes).digest("base64") });
  const pendingGrant = await f.upload.resolvePart(context(), { uploadId: pendingUpload.uploadId, partNumber: 1, authorizationId: pendingAuthorization.authorizationId });
  const pendingCard = (await f.current().calendar.list(f.claims)).items.find(item => item.id === pending.id);
  await f.current().calendar.edit(f.claims, pending.id, { action: "cancel", revision: pendingCard.revision });
  await f.current().imports.submissions.progress(f.context.companyId);
  let cancelledState = await f.snapshot();
  assert.equal(cancelledState.uploads[pendingUpload.uploadId].state, "cancelled");
  assert.equal(cancelledState.reservedBytes, reservedBefore, "Cancelling the pending calendar card releases only its own transfer reservation");
  await assert.rejects(cloud.putSigned(pendingGrant, bytes), error => error.code === 412);
  f.advance(60000); await f.current().imports.submissions.progress(f.context.companyId);
  assert.equal((await f.current().imports.submissions.byKey(f.context, pendingUpload.assetId, pendingBody.idempotencyKey)).state, "cancelled");
  assert.equal(hash(cloud.objects.get(stored.objectKey + "/source").bytes), hash(bytes), "Previously completed source stays intact");
  assert.equal(f.providerCalls.length, 0);
});
