"use strict";

// iA4tube: a customer's finished photo joins the existing image-result path.
// Feed adaptation is confined to intake; publication and ownership stay unchanged.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { hash, canonicalJson, admissionOrderId, UUID, fail } = require("./admission-contract");
const { caption, dateTime } = require("../social/calendar/model");
const planning = require("../company-monthly-planning/planning.service");
const orderStorage = require("../orders/order.storage");
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const READY_IMAGE_MODEL_ID = "92edf67f-7c27-471c-b6f4-71b7ab4af228";
const MIME = Object.freeze({ "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" });

async function normalizeReadyImage(file, { prepareFeed = false } = {}) {
  if (!file || typeof file.path !== "string" || !Object.hasOwn(MIME, file.mimetype)) fail("ready_image_invalid", 422);
  const stat = fs.lstatSync(file.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_INPUT_BYTES)
    fail("ready_image_invalid", 422);
  const original = fs.readFileSync(file.path);
  try {
    const sharp = require("sharp");
    const input = sharp(original, { limitInputPixels: 25 * 1000 * 1000, failOn: "error" });
    const metadata = await input.metadata();
    if (metadata.format !== MIME[file.mimetype] || (metadata.pages || 1) !== 1 ||
        !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height)) fail("ready_image_invalid", 422);
    // Contain preserves all edges and proportions. Sharp strips EXIF/GPS by default.
    const bytes = await input.rotate().flatten({ background: "#ffffff" })
      .resize(1152, 1440, { fit: "contain", background: "#ffffff" })
      .toColourspace("srgb").png({ compressionLevel: 9 }).toBuffer();
    if (bytes.length < 1 || bytes.length > 32 * 1024 * 1024) fail("ready_image_invalid", 422);
    const result = { bytes, sourceDigest: hash(original), normalizedDigest: hash(bytes) };
    if (prepareFeed) {
      const rotated = [5, 6, 7, 8].includes(metadata.orientation);
      const width = rotated ? metadata.height : metadata.width, height = rotated ? metadata.width : metadata.height;
      result.needsAdaptation = width * 5 !== height * 4;
      if (result.needsAdaptation) {
        // Send the original composition, never the old white contain-frame.
        result.feedSource = await sharp(original, { limitInputPixels: 25 * 1000 * 1000, failOn: "error" })
          .rotate().flatten({ background: "#ffffff" }).toColourspace("srgb").png({ compressionLevel: 9 }).toBuffer();
        if (result.feedSource.length > 32 * 1024 * 1024) fail("ready_image_invalid", 422);
      }
    }
    return result;
  } catch (error) {
    if (error.code === "edit_calendar_ready_image_invalid") throw error;
    fail("ready_image_invalid", 422);
  }
}

function createReadyImageService(ports) {
  const { enabled, root, directories, contextFile, read, write, ticketContext, ownerClient,
    acquireAllocationLock, admit, bind, orderRoot, clock, fault, remainingImages, remainingVideos, feedAdapter = null } = ports;
  const directory = path.join(root, "ready-images");
  function inspect(ticket) {
    if (!enabled) fail("admission_disabled", 503);
    const row = ticketContext(ticket);
    ownerClient({ whatsapp: row.owner });
    if (!row.readyImage && (row.admission || row.binding)) fail("order_conflict");
    if (row.expiresAt <= clock() && !row.readyImage) fail("context_expired");
    return row;
  }
  function verifyCapability(ticket) { inspect(ticket); return hash(ticket); }
  async function context(ticket, { mediaKind = 'image' } = {}) {
    if (!['image','video'].includes(mediaKind)) fail('input_invalid',400);
    let row = inspect(ticket);
    if (row.expiresAt <= clock()) fail("context_expired");
    const remaining = await (mediaKind==='video'?remainingVideos:remainingImages)({ owner: row.owner, destination: row.request.destination, verifiedClaims: row.sessionIdentity,
      ipIdentity: row.ipIdentity, freeArtBlocked: row.freeArtBlocked });
    row = inspect(ticket);
    if (row.expiresAt <= clock()) fail("context_expired");
    return { ok: true, requestId: row.id, date: row.request.date, time: row.request.time,
      destination: mediaKind==='video'?row.request.destination:row.request.destination === "reel" ? "feed" : row.request.destination,
      [mediaKind==='video'?'remainingVideos':'remainingImages']: Number.isSafeInteger(remaining) && remaining >= 0 ? remaining : null };
  }
  function canEdit(ticket) {
    try {
      const row = inspect(ticket), current = ownerClient({ whatsapp: row.owner });
      return row.phase === "pending" && !row.readyImage && !row.admission && !row.binding &&
        !current.client.planejamento_mensal_reservas?.[row.planningId];
    } catch { return false; }
  }
  function lock(id) {
    const file = path.join(directory, `${id}.lock`);
    let fd;
    try { fd = fs.openSync(file, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const prior = read(file);
      if (!prior || prior.hostname !== os.hostname() || !Number.isSafeInteger(prior.pid)) fail("allocation_busy", 503);
      let alive = true;
      try { process.kill(prior.pid, 0); } catch (e) { if (e.code === "ESRCH") alive = false; }
      if (alive) fail("allocation_busy", 503);
      fs.unlinkSync(file);
      try { fd = fs.openSync(file, "wx", 0o600); } catch { fail("allocation_busy", 503); }
    }
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname() })); fs.fsyncSync(fd); }
    catch (error) { fs.closeSync(fd); fs.unlinkSync(file); throw error; }
    return () => { fs.closeSync(fd); fs.unlinkSync(file); };
  }
  function response(row) {
    return { ok: true, requestId: row.id, planningId: row.planningId, pedidoId: row.pedidoId,
      status: "ready", automatic: Boolean(row.envelope) };
  }
  async function submit(input, file) {
    if (!input || Object.keys(input).sort().join() !== "caption,requestId,ticket" ||
        !UUID.test(input.requestId || "") || typeof input.caption !== "string") fail("input_invalid", 400);
    let initial = inspect(input.ticket), selectedCaption;
    if (input.requestId.toLowerCase() !== initial.id) fail("order_conflict");
    try { selectedCaption = caption(input.caption); } catch { fail("input_invalid", 400); }
    if (!selectedCaption) fail("ready_image_caption_required", 422);
    if ((!initial.admission || initial.admission.billingRefused) &&
        dateTime(initial.request.date, initial.request.time) <= clock()) fail("time_invalid", 422);
    const normalized = await normalizeReadyImage(file, {
      prepareFeed: Boolean(feedAdapter && (!initial.readyImage || initial.readyImage.feedAdaptation)) });
    // Authentication, account activity and scheduling are checked again after decoding.
    initial = inspect(input.ticket);
    const identity = { purpose: "edit_ready_image_v1", requestId: initial.id, sourceDigest: normalized.sourceDigest,
      caption: selectedCaption, date: initial.request.date, time: initial.request.time };
    const requestHash = hash(canonicalJson(identity)), bindingHash = hash(`edit-ready-image-result-v1\n${requestHash}\n${normalized.normalizedDigest}`);
    directories();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) fail("storage_invalid", 503);
    const release = lock(initial.id);
    try {
      // This marker is committed under the same allocation lock as ordinary admission.
      // It fences a ready image from a different producer using the same ticket.
      const releaseAllocation = acquireAllocationLock();
      let row;
      try {
        row = inspect(input.ticket);
        if (row.readyImage && (row.readyImage.requestHash !== requestHash || row.readyImage.bindingHash !== bindingHash)) fail("order_conflict");
        if (!row.readyImage) {
          if (row.admission || row.binding || row.phase !== "pending") fail("order_conflict");
          if (dateTime(row.request.date, row.request.time) <= clock()) fail("time_invalid", 422);
          const adaptFeed = feedAdapter && normalized.needsAdaptation;
          if (adaptFeed) feedAdapter.assertConfigured();
          row.readyImage = { schema: 1, requestHash, bindingHash, sourceDigest: normalized.sourceDigest,
            normalizedDigest: normalized.normalizedDigest, modelId: READY_IMAGE_MODEL_ID,
            caption: selectedCaption, phase: "validated",
            ...(adaptFeed ? { feedAdaptation: feedAdapter.revision } : {}) };
          write(contextFile(row.id), row);
        }
      } finally { releaseAllocation(); }
      // Preserve the complete validated source before any quota is reserved.
      // A retry after a restart uses the same content-addressed file and intent.
      const staged = path.join(directory, `${row.id}.${normalized.normalizedDigest}.png`);
      if (fs.existsSync(staged)) {
        const stat = fs.lstatSync(staged);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== normalized.bytes.length ||
            hash(fs.readFileSync(staged)) !== normalized.normalizedDigest) fail("storage_invalid", 503);
      } else {
        const temporary = `${staged}.${crypto.randomUUID()}.tmp`;
        const fd = fs.openSync(temporary, "wx", 0o600);
        try {
          try { fs.writeFileSync(fd, normalized.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          fs.renameSync(temporary, staged);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }
      let adaptation = null;
      if (row.readyImage.feedAdaptation) {
        if (row.readyImage.feedAdaptation !== feedAdapter?.revision || !normalized.feedSource)
          fail("ready_image_adaptation_unavailable", 503);
        adaptation = feedAdapter.stage({ directory, id: row.id, sourceDigest: normalized.sourceDigest,
          bytes: normalized.feedSource });
      }
      fault("ready_image_after_staging");
      const admission = { schemaVersion: 1, ticket: input.ticket, editOrderId: admissionOrderId(input.ticket),
        requestHash, mediaKind: "image", title: "Minha imagem", caption: selectedCaption, durationSeconds: null,
        selection: { modelId: READY_IMAGE_MODEL_ID, modelVersion: 1, sourceDigest: normalized.sourceDigest }, quantity: 1 };
      await admit(admission);
      fault("ready_image_after_admission");
      // Quota is reserved first; one edit is reused even after a lost response/restart.
      const output = adaptation ? await feedAdapter.adapt(adaptation) : { path: staged, digest: normalized.normalizedDigest };
      fault("ready_image_after_adaptation");
      const bound = bind({ ticket: input.ticket, editOrderId: admission.editOrderId, title: admission.title,
        caption: selectedCaption, durationSeconds: null, inputHash: bindingHash, mediaKind: "image" });
      fault("ready_image_after_bind");
      const found = planning.findPlanningArtOrder({ pedidosDir: orderRoot, pedidoId: bound.pedidoId });
      if (!found || found.pedido.whatsapp !== row.owner || found.pedido.edit_calendar?.inputHash !== bindingHash)
        fail("allocation_reconciliation_required", 503);
      const finalPath = path.join(found.base, "resultado_final.png");
      if (found.status === "pronto") {
        if (!fs.existsSync(finalPath) || hash(fs.readFileSync(finalPath)) !== output.digest ||
            found.pedido.descricao_instagram !== selectedCaption) fail("order_conflict");
      } else {
        // The result writer consumes its input. Keep the paid response immutable
        // so a lost HTTP receipt can reuse it without another edit.
        const delivery = adaptation ? path.join(directory, `${row.id}.${output.digest}.delivery.png`) : output.path;
        if (adaptation) {
          if (fs.existsSync(delivery)) {
            const stat = fs.lstatSync(delivery);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
                hash(fs.readFileSync(delivery)) !== output.digest) fail("storage_invalid", 503);
          } else {
            fs.copyFileSync(output.path, delivery, fs.constants.COPYFILE_EXCL);
            const fd = fs.openSync(delivery, "r+");
            try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          }
        }
        // The customer's caption is authoritative, including when a native context had text.
        orderStorage.writeOrder(found.base, { ...found.pedido, descricao_instagram: selectedCaption,
          edit_calendar_caption: selectedCaption });
        planning.savePlanningArtResult({ pedidosDir: orderRoot, pedidoId: bound.pedidoId,
          resultadoPath: delivery, resultadoMime: "image/png", descricaoInstagram: selectedCaption });
      }
      fault("ready_image_after_result");
      const releaseFinish = acquireAllocationLock();
      try {
        row = inspect(input.ticket);
        if (row.readyImage?.requestHash !== requestHash) fail("order_conflict");
        row.readyImage.phase = "ready";
        write(contextFile(row.id), row);
      } finally { releaseFinish(); }
      try { if (fs.existsSync(staged)) fs.unlinkSync(staged); } catch { /* accepted result is already durable */ }
      return response(row);
    } finally { release(); }
  }
  return Object.freeze({ verifyCapability, context, canEdit, submit });
}

module.exports = { createReadyImageService, normalizeReadyImage, MAX_INPUT_BYTES, READY_IMAGE_MODEL_ID };
