"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { connectorFail } = require("../connectors/errors");

const CONTROLLED_GATE4_JPEG_SHA256 =
  "4b9224fee69b707f304e11ad25ef7fe9d22f19904ba0b933172861f53b5bd773";
const CONTROLLED_GATE4_JPEG_SIZE = 114530;
const CONTROLLED_GATE4_MEDIA_PREFIX =
  `gate4_${CONTROLLED_GATE4_JPEG_SHA256}`;
const CONTROLLED_GATE4_PUBLIC_PATH =
  `/social/gate4/${CONTROLLED_GATE4_JPEG_SHA256}.jpg`;
const CONTROLLED_GATE4_STAGING_ORIGIN =
  "https://ia4tube-api-staging-checkpoint-a.onrender.com";
const CONTROLLED_GATE4_COMPANY_ID =
  "ca1ca409-6b6e-59b0-a2c0-2b67f818a5e0";
const CONTROLLED_GATE4_USER_ID =
  "ba143adc-f2f4-56f1-afdb-5cbded87504a";

function mediaFail() {
  connectorFail("resource_unavailable");
}

function requireAbsoluteDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) mediaFail();
  return value;
}

function controlledFilePath(publicDirectory) {
  return path.join(
    requireAbsoluteDirectory(publicDirectory),
    "social",
    "gate4",
    `${CONTROLLED_GATE4_JPEG_SHA256}.jpg`
  );
}

function controlledGate4MediaReference(account) {
  if (
    !account ||
    typeof account !== "object" ||
    !/^[0-9]{5,64}$/.test(String(account.externalId || "")) ||
    account.username !== "ia4tube_empresas" ||
    account.accountType !== "business"
  ) {
    mediaFail();
  }
  return `${CONTROLLED_GATE4_MEDIA_PREFIX}:instagram:` +
    `${account.externalId}:ia4tube_empresas:business`;
}

function isControlledGate4MediaReference(value) {
  return typeof value === "string" && new RegExp(
    `^${CONTROLLED_GATE4_MEDIA_PREFIX}:instagram:[0-9]{5,64}:` +
      "ia4tube_empresas:business$"
  ).test(value);
}

function isControlledGate4StagingOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.origin === CONTROLLED_GATE4_STAGING_ORIGIN &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    ["", "/"].includes(parsed.pathname)
  );
}

function normalizeControlledGate4RequestPath(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  let candidate = value.split("?", 1)[0];
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) break;
      candidate = decoded;
    }
  } catch {
    return null;
  }
  candidate = candidate.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  const segments = [];
  for (const segment of candidate.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return `/${segments.join("/")}`;
}

function isControlledGate4RequestPath(value) {
  const normalized = normalizeControlledGate4RequestPath(value);
  return normalized !== null &&
    normalized.toLowerCase().startsWith("/social/gate4/");
}

function readVerifiedJpeg(publicDirectory) {
  const filePath = controlledFilePath(publicDirectory);
  let stat;
  let bytes;
  try {
    stat = fs.lstatSync(filePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== CONTROLLED_GATE4_JPEG_SIZE
    ) {
      mediaFail();
    }
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    if (error?.code === "resource_unavailable") throw error;
    mediaFail();
  }
  if (
    bytes.length !== CONTROLLED_GATE4_JPEG_SIZE ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9 ||
    crypto.createHash("sha256").update(bytes).digest("hex") !==
      CONTROLLED_GATE4_JPEG_SHA256
  ) {
    bytes.fill(0);
    mediaFail();
  }
  return bytes;
}

function createControlledGate4JpegMedia(options = {}) {
  const publicDirectory = requireAbsoluteDirectory(options.publicDirectory);
  const publicOrigin = options.publicOrigin;
  const expectedCompanyId = options.expectedCompanyId ||
    CONTROLLED_GATE4_COMPANY_ID;
  if (
    publicOrigin !== CONTROLLED_GATE4_STAGING_ORIGIN ||
    expectedCompanyId !== CONTROLLED_GATE4_COMPANY_ID
  ) {
    mediaFail();
  }
  const initial = readVerifiedJpeg(publicDirectory);
  initial.fill(0);

  return Object.freeze({
    async resolveOwnedJpeg(context, mediaId) {
      if (
        !context ||
        context.companyId !== expectedCompanyId ||
        !isControlledGate4MediaReference(mediaId)
      ) {
        mediaFail();
      }
      const verified = readVerifiedJpeg(publicDirectory);
      verified.fill(0);
      return Object.freeze({
        companyId: expectedCompanyId,
        mediaId,
        mimeType: "image/jpeg",
        sha256: CONTROLLED_GATE4_JPEG_SHA256,
        size: CONTROLLED_GATE4_JPEG_SIZE,
        publicUrl: `${CONTROLLED_GATE4_STAGING_ORIGIN}` +
          CONTROLLED_GATE4_PUBLIC_PATH
      });
    }
  });
}

function createControlledGate4JpegPublicHandler(options = {}) {
  const publicDirectory = requireAbsoluteDirectory(options.publicDirectory);
  const initial = readVerifiedJpeg(publicDirectory);
  initial.fill(0);
  return function controlledGate4JpegPublicHandler(_req, res, next) {
    let bytes;
    try {
      bytes = readVerifiedJpeg(publicDirectory);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Length", String(bytes.length));
      res.setHeader("Cache-Control", "public, max-age=60, immutable");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.status(200).send(bytes);
    } catch (error) {
      if (bytes) bytes.fill(0);
      return typeof next === "function" ? next(error) : undefined;
    }
  };
}

module.exports = {
  CONTROLLED_GATE4_COMPANY_ID,
  CONTROLLED_GATE4_JPEG_SHA256,
  CONTROLLED_GATE4_JPEG_SIZE,
  CONTROLLED_GATE4_MEDIA_PREFIX,
  CONTROLLED_GATE4_PUBLIC_PATH,
  CONTROLLED_GATE4_STAGING_ORIGIN,
  CONTROLLED_GATE4_USER_ID,
  controlledGate4MediaReference,
  createControlledGate4JpegMedia,
  createControlledGate4JpegPublicHandler,
  isControlledGate4MediaReference,
  isControlledGate4RequestPath,
  isControlledGate4StagingOrigin,
  normalizeControlledGate4RequestPath,
  readVerifiedJpeg
};
