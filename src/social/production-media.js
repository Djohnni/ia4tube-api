"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const orderStorage = Object.freeze({ isSafePathSegment(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    value !== "." && value !== ".." && !/[\/\\?#\u0000-\u0020\u007f]/.test(value);
} });
const { reviewerMediaIdentity } = require("./reviewer-real/reviewer-real");
const { createOrderMediaAccess } = require("../security/order-media-access");
const { parseIdentityConfig } = require("./identity");

const REVIEWER_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
const REVIEWER_MEDIA_SOF_MARKERS = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
const REAL_REVIEWER_MEDIA_SCHEMA_VERSION = 1;
const REAL_REVIEWER_MEDIA_MAX_ITEMS = 20;
const REAL_REVIEWER_MEDIA_ID_PATTERN = /^reviewer-jpeg:[0-9a-f]{64}$/;
const REAL_REVIEWER_MEDIA_DIRECTORY_PATTERN = /^[0-9a-f]{64}$/;
const REAL_REVIEWER_SOURCE_ID_PATTERN = /^upload-[0-9a-f]{32}$/;
const REAL_REVIEWER_COMPANY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REAL_REVIEWER_MEDIA_CAPABILITY_PREFIX = "/v1/social/reviewer/media-capability";
const ORDER_MEDIA_URL_TTL_SECONDS = 15 * 60;

function reviewerJpegDimensions(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 16 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    return null;
  }

  let offset = 2;
  let dimensions = null;
  let hasQuantizationTable = false;
  let hasHuffmanTable = false;
  let hasScan = false;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) break;
    if (marker === 0xda) {
      hasScan = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (marker === 0xdb) hasQuantizationTable = true;
    if (marker === 0xc4) hasHuffmanTable = true;
    if (REVIEWER_MEDIA_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width < 1 || height < 1) return null;
      dimensions = { width, height };
    }
    offset += segmentLength;
  }
  return dimensions && hasQuantizationTable && hasHuffmanTable && hasScan
    ? dimensions
    : null;
}

function realReviewerUploadJpegDimensions(bytes) {
  const dimensions = reviewerJpegDimensions(bytes);
  if (!dimensions) return null;

  let offset = 2;
  let validFrame = false;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) return null;
    if (marker === 0xda) {
      if (!validFrame || offset + 2 >= bytes.length) return null;
      const scanLength = bytes.readUInt16BE(offset);
      const scanComponents = bytes[offset + 2];
      return scanComponents >= 1 &&
        scanComponents <= 4 &&
        scanLength === 6 + (2 * scanComponents) &&
        offset + scanLength < bytes.length - 2
        ? dimensions
        : null;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (REVIEWER_MEDIA_SOF_MARKERS.has(marker)) {
      if (segmentLength < 11) return null;
      const frameComponents = bytes[offset + 7];
      if (
        bytes[offset + 2] !== 8 ||
        frameComponents < 1 ||
        frameComponents > 4 ||
        segmentLength !== 8 + (3 * frameComponents)
      ) {
        return null;
      }
      validFrame = true;
    }
    offset += segmentLength;
  }
  return null;
}


function createProductionMedia({ env, dataDir, readClients }) {
  const DATA_DIR = path.resolve(dataDir);
  const REAL_REVIEWER_MEDIA_DIR = path.join(DATA_DIR, "reviewer_media");
  const PUBLIC_API_BASE_URL = env.PUBLIC_API_BASE_URL;
  const readClientes = readClients;
  if (!realReviewerDirectoryIsSafe(DATA_DIR)) throw realReviewerMediaError("reviewer_media_storage_unavailable");
  let identity;
  let derived;
  let orderMediaAccess;
  try {
    identity = parseIdentityConfig(env);
    derived = crypto.createHmac("sha256", identity.key)
      .update("ia4tube-production-media-signing-v1").digest();
    orderMediaAccess = createOrderMediaAccess({ secret: derived.toString("base64") });
  } finally {
    identity?.key.fill(0);
    derived?.fill(0);
  }
  try { fs.mkdirSync(REAL_REVIEWER_MEDIA_DIR, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw realReviewerMediaError("reviewer_media_storage_unavailable"); }
  if (!realReviewerDirectoryIsSafe(REAL_REVIEWER_MEDIA_DIR) ||
      !realReviewerDirectoryIsContained(DATA_DIR, REAL_REVIEWER_MEDIA_DIR, "reviewer_media")) {
    throw realReviewerMediaError("reviewer_media_storage_unavailable");
  }

function realReviewerMediaError(code) {
  const error = new Error("Midia do revisor recusada.");
  error.code = code;
  return error;
}

function realReviewerDirectoryIsSafe(directoryPath) {
  try {
    const stat = fs.lstatSync(directoryPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function realReviewerDirectoryIsContained(root, directory, expectedRelative) {
  try {
    const realRoot = fs.realpathSync(root);
    const realDirectory = fs.realpathSync(directory);
    return path.relative(realRoot, realDirectory) === expectedRelative;
  } catch {
    return false;
  }
}

function realReviewerOwnerBinding(owner) {
  if (!orderStorage.isSafePathSegment(owner)) return null;
  return crypto.createHash("sha256")
    .update("ia4tube-real-reviewer-owner-v1\0", "utf8")
    .update(owner, "utf8")
    .digest("hex");
}

function realReviewerOwnerMediaDirectory(owner, { create = false } = {}) {
  const binding = realReviewerOwnerBinding(owner);
  const root = path.resolve(REAL_REVIEWER_MEDIA_DIR);
  if (!binding || !realReviewerDirectoryIsSafe(root)) return null;
  const directory = path.resolve(root, binding);
  const relative = path.relative(root, directory);
  if (
    relative !== binding ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  if (create) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") return null;
    }
  }
  return realReviewerDirectoryIsSafe(directory) &&
    realReviewerDirectoryIsContained(root, directory, binding)
    ? Object.freeze({ binding, directory })
    : null;
}

function realReviewerMediaPath(ownerDirectory, mediaId) {
  if (!REAL_REVIEWER_MEDIA_ID_PATTERN.test(String(mediaId || ""))) {
    return null;
  }
  const directoryName = mediaId.slice("reviewer-jpeg:".length);
  if (!REAL_REVIEWER_MEDIA_DIRECTORY_PATTERN.test(directoryName)) return null;
  const mediaDirectory = path.resolve(ownerDirectory, directoryName);
  const relative = path.relative(ownerDirectory, mediaDirectory);
  if (
    relative !== directoryName ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return mediaDirectory;
}

function realReviewerMetadataIsValid(metadata, expected = {}) {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.getPrototypeOf(metadata) !== Object.prototype
  ) {
    return false;
  }
  const keys = [
    "schemaVersion",
    "status",
    "mediaId",
    "sourceId",
    "companyId",
    "ownerBinding",
    "sha256",
    "width",
    "height",
    "size",
    "caption",
    "createdAt"
  ];
  if (
    Object.keys(metadata).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(metadata, key)) ||
    metadata.schemaVersion !== REAL_REVIEWER_MEDIA_SCHEMA_VERSION ||
    metadata.status !== "ready" ||
    metadata.mediaId !== expected.mediaId ||
    metadata.ownerBinding !== expected.ownerBinding ||
    !REAL_REVIEWER_MEDIA_ID_PATTERN.test(metadata.mediaId) ||
    !REAL_REVIEWER_SOURCE_ID_PATTERN.test(metadata.sourceId) ||
    !REAL_REVIEWER_COMPANY_ID_PATTERN.test(metadata.companyId) ||
    (expected.companyId && metadata.companyId !== expected.companyId) ||
    !/^[0-9a-f]{64}$/.test(metadata.sha256) ||
    metadata.width !== 1080 ||
    metadata.height !== 1080 ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 16 ||
    metadata.size > REVIEWER_MEDIA_MAX_BYTES ||
    typeof metadata.caption !== "string" ||
    metadata.caption !== metadata.caption.trim() ||
    metadata.caption.length < 1 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(metadata.caption) ||
    typeof metadata.createdAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(metadata.createdAt) ||
    !Number.isFinite(Date.parse(metadata.createdAt))
  ) {
    return false;
  }
  const descriptor = reviewerMediaIdentity({
    orderId: metadata.sourceId,
    jpegSha256: metadata.sha256,
    caption: metadata.caption
  });
  return descriptor?.mediaId === metadata.mediaId;
}

function readDirectRealReviewerMedia(
  owner,
  mediaId,
  { companyId = null, includeBytes = false } = {}
) {
  if (
    companyId !== null &&
    !REAL_REVIEWER_COMPANY_ID_PATTERN.test(String(companyId || ""))
  ) {
    return null;
  }
  const ownerDirectory = realReviewerOwnerMediaDirectory(owner);
  if (!ownerDirectory) return null;
  const mediaDirectory = realReviewerMediaPath(
    ownerDirectory.directory,
    mediaId
  );
  if (
    !mediaDirectory ||
    !realReviewerDirectoryIsSafe(mediaDirectory) ||
    !realReviewerDirectoryIsContained(
      ownerDirectory.directory,
      mediaDirectory,
      mediaId.slice("reviewer-jpeg:".length)
    )
  ) {
    return null;
  }
  const metadataPath = path.join(mediaDirectory, "metadata.json");
  const jpegPath = path.join(mediaDirectory, "media.jpg");
  let bytes = null;
  try {
    const metadataStat = fs.lstatSync(metadataPath);
    const jpegStat = fs.lstatSync(jpegPath);
    if (
      !metadataStat.isFile() ||
      metadataStat.isSymbolicLink() ||
      metadataStat.size < 2 ||
      metadataStat.size > 32 * 1024 ||
      !jpegStat.isFile() ||
      jpegStat.isSymbolicLink()
    ) {
      return null;
    }
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    if (!realReviewerMetadataIsValid(metadata, {
      mediaId,
      ownerBinding: ownerDirectory.binding,
      companyId
    }) || jpegStat.size !== metadata.size) {
      return null;
    }
    if (includeBytes) {
      bytes = fs.readFileSync(jpegPath);
      const dimensions = realReviewerUploadJpegDimensions(bytes);
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      if (
        bytes.length !== metadata.size ||
        sha256 !== metadata.sha256 ||
        dimensions?.width !== metadata.width ||
        dimensions?.height !== metadata.height
      ) {
        bytes.fill(0);
        return null;
      }
    }
    const relativeStorageKey = path.relative(DATA_DIR, jpegPath);
    if (
      !relativeStorageKey ||
      relativeStorageKey.startsWith("..") ||
      path.isAbsolute(relativeStorageKey)
    ) {
      if (bytes) bytes.fill(0);
      return null;
    }
    return {
      owner,
      orderId: metadata.sourceId,
      previewPath: jpegPath,
      storageKey: relativeStorageKey.split(path.sep).join("/"),
      sha256: metadata.sha256,
      width: metadata.width,
      height: metadata.height,
      caption: metadata.caption,
      createdAt: metadata.createdAt,
      ...(bytes ? { bytes } : {})
    };
  } catch {
    if (bytes) bytes.fill(0);
    return null;
  }
}

function listDirectRealReviewerMedia({ context, owner }) {
  if (
    !context ||
    !REAL_REVIEWER_COMPANY_ID_PATTERN.test(String(context.companyId || ""))
  ) {
    return [];
  }
  const ownerDirectory = realReviewerOwnerMediaDirectory(owner);
  if (!ownerDirectory) return [];
  let entries;
  try {
    entries = fs.readdirSync(ownerDirectory.directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => (
      entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      REAL_REVIEWER_MEDIA_DIRECTORY_PATTERN.test(entry.name)
    ))
    .map((entry) => readDirectRealReviewerMedia(
      owner,
      `reviewer-jpeg:${entry.name}`,
      { companyId: context.companyId }
    ))
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function writeExclusiveReviewerFile(filePath, contents) {
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function realReviewerOwnedUploadCount(ownerDirectory) {
  try {
    return fs.readdirSync(ownerDirectory, { withFileTypes: true })
      .filter((entry) => (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        REAL_REVIEWER_MEDIA_DIRECTORY_PATTERN.test(entry.name)
      ))
      .length;
  } catch {
    return null;
  }
}

function storeDirectRealReviewerMedia({ context, owner, bytes, caption }) {
  if (
    !context ||
    !REAL_REVIEWER_COMPANY_ID_PATTERN.test(String(context.companyId || "")) ||
    !orderStorage.isSafePathSegment(owner) ||
    !Buffer.isBuffer(bytes) ||
    bytes.length < 16
  ) {
    throw realReviewerMediaError("reviewer_media_invalid");
  }
  if (bytes.length > REVIEWER_MEDIA_MAX_BYTES) {
    throw realReviewerMediaError("reviewer_media_too_large");
  }
  const client = readClientes()[owner];
  const dimensions = realReviewerUploadJpegDimensions(bytes);
  if (
    !client ||
    client.ativo === false ||
    dimensions?.width !== 1080 ||
    dimensions?.height !== 1080 ||
    typeof caption !== "string" ||
    caption !== caption.trim() ||
    caption.length < 1
  ) {
    throw realReviewerMediaError("reviewer_media_invalid");
  }
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const ownerDirectory = realReviewerOwnerMediaDirectory(owner, { create: true });
  if (!ownerDirectory) {
    throw realReviewerMediaError("reviewer_media_storage_unavailable");
  }
  const currentUploadCount = realReviewerOwnedUploadCount(
    ownerDirectory.directory
  );
  if (currentUploadCount === null) {
    throw realReviewerMediaError("reviewer_media_storage_unavailable");
  }
  if (currentUploadCount >= REAL_REVIEWER_MEDIA_MAX_ITEMS) {
    throw realReviewerMediaError("reviewer_media_limit_reached");
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const sourceId = `upload-${crypto.randomBytes(16).toString("hex")}`;
    const selected = reviewerMediaIdentity({
      orderId: sourceId,
      jpegSha256: sha256,
      caption
    });
    if (!selected) throw realReviewerMediaError("reviewer_media_invalid");
    const finalDirectory = realReviewerMediaPath(
      ownerDirectory.directory,
      selected.mediaId
    );
    const pendingName = `.pending-${crypto.randomBytes(18).toString("hex")}`;
    const pendingDirectory = path.resolve(ownerDirectory.directory, pendingName);
    const pendingRelative = path.relative(
      ownerDirectory.directory,
      pendingDirectory
    );
    if (
      !finalDirectory ||
      pendingRelative !== pendingName ||
      path.isAbsolute(pendingRelative)
    ) {
      throw realReviewerMediaError("reviewer_media_storage_unavailable");
    }
    if (fs.existsSync(finalDirectory)) continue;
    let pendingCreated = false;
    try {
      fs.mkdirSync(pendingDirectory, { mode: 0o700 });
      pendingCreated = true;
      if (
        !realReviewerDirectoryIsSafe(pendingDirectory) ||
        !realReviewerDirectoryIsContained(
          ownerDirectory.directory,
          pendingDirectory,
          pendingName
        )
      ) {
        throw realReviewerMediaError("reviewer_media_storage_unavailable");
      }
      const metadata = Object.freeze({
        schemaVersion: REAL_REVIEWER_MEDIA_SCHEMA_VERSION,
        status: "ready",
        mediaId: selected.mediaId,
        sourceId,
        companyId: context.companyId,
        ownerBinding: ownerDirectory.binding,
        sha256,
        width: dimensions.width,
        height: dimensions.height,
        size: bytes.length,
        caption,
        createdAt: new Date().toISOString()
      });
      writeExclusiveReviewerFile(path.join(pendingDirectory, "media.jpg"), bytes);
      writeExclusiveReviewerFile(
        path.join(pendingDirectory, "metadata.json"),
        `${JSON.stringify(metadata, null, 2)}\n`
      );
      fs.renameSync(pendingDirectory, finalDirectory);
      pendingCreated = false;
      const source = readDirectRealReviewerMedia(owner, selected.mediaId, {
        companyId: context.companyId
      });
      if (!source) {
        fs.rmSync(finalDirectory, { recursive: true, force: true });
        throw realReviewerMediaError("reviewer_media_storage_unavailable");
      }
      return source;
    } catch (error) {
      if (pendingCreated) {
        try {
          fs.rmSync(pendingDirectory, { recursive: true, force: true });
        } catch {}
      }
      if (error?.code === "EEXIST") continue;
      if (/^reviewer_media_/.test(String(error?.code || ""))) throw error;
      throw realReviewerMediaError("reviewer_media_storage_unavailable");
    }
  }
  throw realReviewerMediaError("reviewer_media_storage_unavailable");
}

function realReviewerMediaDescriptor(source) {
  return reviewerMediaIdentity({
    orderId: source?.orderId,
    jpegSha256: source?.sha256,
    caption: source?.caption
  });
}

function realReviewerMediaCapabilityUrl(owner, source, mediaId) {
  const expiresAt = Math.floor(Date.now() / 1000) + ORDER_MEDIA_URL_TTL_SECONDS;
  const nonce = crypto.randomBytes(18).toString("base64url");
  const ownerContext = orderMediaAccess.sealOwnerContext(owner);
  const signature = orderMediaAccess.sign({
    owner,
    orderId: `${mediaId}:${source.sha256}`,
    variant: "thumbnail",
    nonce,
    expiresAt
  });
  return `${PUBLIC_API_BASE_URL}${REAL_REVIEWER_MEDIA_CAPABILITY_PREFIX}/` +
    `${encodeURIComponent(mediaId)}/${expiresAt}/${encodeURIComponent(nonce)}/` +
    `${encodeURIComponent(ownerContext)}/${encodeURIComponent(signature)}`;
}

function realReviewerMediaRecord(context, owner, source, descriptor) {
  const selected = descriptor || realReviewerMediaDescriptor(source);
  if (!selected) return null;
  const url = realReviewerMediaCapabilityUrl(owner, source, selected.mediaId);
  return Object.freeze({
    companyId: context.companyId,
    mediaId: selected.mediaId,
    mimeType: "image/jpeg",
    width: source.width,
    height: source.height,
    caption: selected.caption,
    publicUrl: url,
    thumbnailUrl: url
  });
}



  function record(context, owner, source) {
    const result = realReviewerMediaRecord(context, owner, source);
    if (!result) throw realReviewerMediaError("reviewer_media_invalid");
    const metadataDigest = crypto.createHash("sha256").update(JSON.stringify([
      "ia4tube-production-jpeg-v1", context.companyId, result.mediaId,
      source.sha256, source.width, source.height, source.caption
    ])).digest("hex");
    return Object.freeze({ ...result, metadataDigest });
  }
  const media = Object.freeze({
    async listOwnedJpegs({ context, owner }) {
      const client = readClients()[owner];
      if (!client || client.ativo === false) return [];
      return listDirectRealReviewerMedia({ context, owner }).slice(0, 20)
        .map(source => record(context, owner, source));
    },
    async storeOwnedJpeg({ context, owner, bytes, caption }) {
      if (typeof caption !== "string" || caption.length > 2150 ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(caption)) {
        throw realReviewerMediaError("reviewer_media_invalid");
      }
      return record(context, owner, storeDirectRealReviewerMedia({ context, owner, bytes, caption }));
    },
    async resolveOwnedJpeg({ context, owner, mediaId }) {
      const client = readClients()[owner];
      if (!client || client.ativo === false || !context?.companyId) return null;
      const source = readDirectRealReviewerMedia(owner, mediaId, { companyId: context.companyId, includeBytes: true });
      if (!source) return null;
      try { return record(context, owner, source); }
      finally { source.bytes.fill(0); }
    }
  });
  function capability(req, res) {
    let bytes;
    try {
      const { mediaId, nonce, ownerContext, signature } = req.params;
      const expiresAt = Number(req.params.expiresAt);
      if (Object.keys(req.query || {}).length || !REAL_REVIEWER_MEDIA_ID_PATTERN.test(mediaId) ||
          !Number.isSafeInteger(expiresAt) || expiresAt > Math.floor(Date.now() / 1000) + ORDER_MEDIA_URL_TTL_SECONDS ||
          !/^[A-Za-z0-9_-]{24}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return res.status(404).end();
      const owner = orderMediaAccess.openOwnerContext(ownerContext);
      const client = owner && Object.hasOwn(readClients(), owner) ? readClients()[owner] : null;
      if (!client || client.ativo === false) return res.status(404).end();
      const source = readDirectRealReviewerMedia(owner, mediaId, { includeBytes: true });
      if (!source) return res.status(404).end();
      bytes = source.bytes;
      if (!orderMediaAccess.verify({ owner, orderId: `${mediaId}:${source.sha256}`,
          variant: "thumbnail", nonce, expiresAt, signature })) return res.status(404).end();
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Length", String(bytes.length));
      res.setHeader("Cache-Control", "private, no-store, no-transform");
      const sent = bytes;
      res.once("finish", () => sent.fill(0));
      res.once("close", () => sent.fill(0));
      res.status(200).send(sent);
      bytes = null;
    } catch { if (!res.headersSent) res.status(404).end(); }
    finally { bytes?.fill(0); }
  }
  return Object.freeze({ media, capability });
}
module.exports = { createProductionMedia, realReviewerUploadJpegDimensions };
