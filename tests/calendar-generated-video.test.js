"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { inspectReadyVideo } = require("../src/company-monthly-planning/ready-video");
const planning = require("../src/company-monthly-planning/planning.service");
const { createCalendarMedia } = require("../src/social/calendar/media");
const model = require("../src/social/calendar/model");
const { targets } = require("../src/social/calendar/destinations");
const { createCalendarRouter } = require("../src/social/calendar/router");

const ffmpeg = path.resolve(__dirname, "../../video_audit/pydeps/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe");

test("authenticated generated-video route returns bounded byte ranges and HEAD metadata", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-video-range-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "video.mp4"), bytes = Buffer.from("0123456789");
  fs.writeFileSync(file, bytes);
  const companyId = crypto.randomUUID();
  const app = require("express")();
  app.use("/v1/social/calendar", createCalendarRouter({ authenticate: (req, _res, next) => {
    req.user = { companyId }; next(); }, getService: () => ({ async video() {
    return { file, size: bytes.length, companyId }; } }) }));
  const server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/v1/social/calendar/items/${"a".repeat(40)}/video`;
  const suffix = await fetch(url, { headers: { range: "bytes=-4" } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get("content-range"), "bytes 6-9/10");
  assert.equal(suffix.headers.get("content-type"), "video/mp4");
  assert.equal(await suffix.text(), "6789");
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), "10");
  assert.equal(await head.text(), "");
});

test("closed video clients release both transfer slots after their metadata lookups finish", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-video-abort-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "video.mp4"), bytes = Buffer.from("0123456789");
  fs.writeFileSync(file, bytes);
  const companyId = crypto.randomUUID(), opened = { file, size: bytes.length, companyId };
  const lookups = [];
  let lookupStartedResolve, clientsClosedResolve, closedCount = 0;
  const lookupStarted = new Promise(resolve => { lookupStartedResolve = resolve; });
  const clientsClosed = new Promise(resolve => { clientsClosedResolve = resolve; });
  const app = require("express")();
  app.use("/v1/social/calendar", createCalendarRouter({ authenticate: (req, res, next) => {
    req.user = { companyId };
    res.once("close", () => {
      if (!res.writableFinished && ++closedCount === 2) clientsClosedResolve();
    });
    next();
  }, getService: () => ({ video() {
    if (lookups.length < 2) return new Promise(resolve => {
      lookups.push(resolve);
      if (lookups.length === 2) lookupStartedResolve();
    });
    return opened;
  } }) }));
  const server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/v1/social/calendar/items/${"a".repeat(40)}/video`;
  const controllers = [new AbortController(), new AbortController()];
  const abandoned = controllers.map(({ signal }) => fetch(url, { signal }));
  await lookupStarted;
  controllers.forEach(controller => controller.abort());
  await Promise.allSettled(abandoned);
  await clientsClosed;
  lookups.forEach(resolve => resolve(opened));
  await new Promise(resolve => setImmediate(resolve));
  const next = await fetch(url);
  assert.equal(next.status, 200, "abandoned requests must not occupy the two-transfer limit");
  assert.equal(await next.text(), bytes.toString());
});

test("a real ready MP4 enters the existing generated calendar item as Reel and Story", {
  skip: process.platform !== "win32" || !fs.existsSync(ffmpeg)
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-generated-video-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "resultado_final.mp4");
  const command = spawnSync(ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi",
    "-i", "color=c=black:s=1080x1920:r=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "3.2", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart", file], { timeout: 30000, windowsHide: true, shell: false });
  assert.equal(command.status, 0, String(command.stderr));
  const inspected = inspectReadyVideo(file);
  assert.equal(inspected.width, 1080); assert.equal(inspected.height, 1920);
  assert.ok(inspected.durationSeconds >= 3 && inspected.durationSeconds <= 60);
  assert.equal(inspected.hasAudio, true);

  // The motor uploads through the existing order endpoint. The calendar must
  // see that same order as ready, and retries must never replace its media.
  const planningDir = path.join(root, "planning"), ordersDir = path.join(root, "orders");
  fs.mkdirSync(ordersDir);
  const owner = "5511999999901";
  const client = { whatsapp: owner, nome_empresa: "Synthetic", ramo: "Loja", plano_status: "active",
    plano_renova_em: "2099-01-01", plano_ciclo: "2099-01", artes_mensais_total: 20,
    artes_mensais_restantes: 20, artes_avulsas_restantes: 0 };
  const monthly = planning.createRequest({ baseDir: planningDir, cliente: client, whatsapp: owner,
    body: { quantidade_reservada: 1, nome_empresa: "Synthetic", ramo: "Loja",
      orientacoes_fotos: JSON.stringify([{ slot_id: "slot1", ordem: 1, tem_arquivo: false,
        sem_imagem: true, objetivo: "Divulgar", escrita_imagem: "Video sintético" }]) } });
  planning.savePlanResult({ baseDir: planningDir, planningId: monthly.id, pedidosDir: ordersDir,
    cliente: client, payload: { postagens: [{ ordem: 1, tema: "Video sintético", objetivo: "Divulgar",
      data_sugerida: "2099-01-02", horario_sugerido: "12:00" }] } });
  const orderBase = require("../src/orders/order.storage").listPedidoBasesByWhatsapp(ordersDir, owner)[0];
  assert.ok(orderBase);
  const upload = path.join(root, "upload.mp4"); fs.copyFileSync(file, upload);
  planning.savePlanningArtResult({ pedidosDir: ordersDir, pedidoId: orderBase.id,
    resultadoPath: upload, resultadoMime: "video/mp4", descricaoInstagram: "Legenda do vídeo" });
  const saved = planning.findPlanningArtOrder({ pedidosDir: ordersDir, pedidoId: orderBase.id });
  assert.equal(saved.status, "pronto"); assert.equal(saved.pedido.resultado_mime, "video/mp4");
  assert.equal(saved.pedido.descricao_instagram, "Legenda do vídeo");
  assert.equal(saved.pedido.resultado_video.hasAudio, true);
  const retry = path.join(root, "retry.mp4"); fs.copyFileSync(file, retry);
  planning.savePlanningArtResult({ pedidosDir: ordersDir, pedidoId: orderBase.id,
    resultadoPath: retry, resultadoMime: "video/mp4" });
  assert.equal(fs.existsSync(retry), false, "identical replay is consumed without changing the order");
  const changed = path.join(root, "changed.mp4");
  fs.copyFileSync(file, changed);
  fs.appendFileSync(changed, Buffer.from([0, 0, 0, 8, 102, 114, 101, 101]));
  assert.throws(() => planning.savePlanningArtResult({ pedidosDir: ordersDir, pedidoId: orderBase.id,
    resultadoPath: changed, resultadoMime: "video/mp4" }), { code: "monthly_planning_art_already_ready" });
  assert.equal(fs.existsSync(path.join(orderBase.base, "resultado_final.mp4")), true);
  assert.equal(planning.findPlanningArtOrder({ pedidosDir: ordersDir, pedidoId: orderBase.id }).pedido.descricao_instagram,
    "Legenda do vídeo");

  const companyId = crypto.randomUUID(), userId = crypto.randomUUID(), stat = fs.statSync(file);
  const source = { file, size: stat.size, version: `${stat.size}:${stat.mtimeMs}:video`,
    mediaKind: "video", metadata: inspected };
  const media = createCalendarMedia({ dataDir: root, secret: "test-only-video-secret-".repeat(4),
    publicOrigin: "https://synthetic.invalid", loadSource: async () => { throw Error("image path used"); },
    describeSource: () => source });
  t.after(() => media.close());
  const state = model.freshState();
  model.syncSources(state, [{ key: "plan:item", planningId: "plan", orderId: "order", title: "Video",
    date: "2099-01-01", time: "09:00", caption: "Legenda do pedido", imageReady: true,
    mediaKind: "video", videoMetadata: inspected, version: source.version, destination: "feed",
    layout: "safe_master_v1" }], companyId, Date.now());
  const job = Object.values(state.jobs)[0];
  assert.equal(job.id, model.idFor(companyId, "plan:item"));
  assert.deepEqual(targets(job), ["reel"]);
  const prepared = await media.prepare("owner", companyId, job);
  const { variants, ...primary } = prepared;
  job.asset = primary; job.assets = variants; job.phase = "ready";
  const reel = media.videoDescriptor(companyId, userId, { ...job, target: "reel" });
  assert.equal(reel.mimeType, "video/mp4"); assert.equal(reel.shareToFeed, true);
  assert.equal(reel.caption, "Legenda do pedido");
  assert.equal(reel.mediaId, `calendar-prepared-v1:${reel.metadataDigest}`);
  assert.equal(media.videoFile(companyId, job.asset).size, stat.size);
  assert.equal(await media.unchanged("owner", job), true);
  const parts = new URL(reel.publicUrl).pathname.split("/");
  assert.equal(media.publicVideo(parts[6], parts[7], parts[8], parts[9]).sha, primary.sha);
  model.changeJob(state, job.id, { action: "destination", destination: "both", revision: job.revision,
    confirmed: true }, Date.now());
  assert.deepEqual(targets(job), ["reel", "story"]);
  const story = media.videoDescriptor(companyId, userId, { ...job, target: "story" });
  assert.equal(story.shareToFeed, false); assert.notEqual(story.mediaId, reel.mediaId);

  const bad = path.join(root, "truncated.mp4");
  const bytes = fs.readFileSync(file);
  fs.writeFileSync(bad, bytes.subarray(0, bytes.length - 32));
  assert.throws(() => inspectReadyVideo(bad), { code: "monthly_planning_video_invalid" });
});
