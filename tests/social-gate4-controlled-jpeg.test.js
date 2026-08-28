"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CONTROLLED_GATE4_COMPANY_ID,
  CONTROLLED_GATE4_JPEG_SHA256,
  CONTROLLED_GATE4_JPEG_SIZE,
  CONTROLLED_GATE4_PUBLIC_PATH,
  CONTROLLED_GATE4_STAGING_ORIGIN,
  controlledGate4MediaReference,
  createControlledGate4JpegMedia,
  createControlledGate4JpegPublicHandler,
  isControlledGate4MediaReference,
  readVerifiedJpeg
} = require("../src/social/publication/controlled-gate4-jpeg");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIRECTORY = path.join(ROOT, "public");
const APPROVED_ASSET = path.join(
  PUBLIC_DIRECTORY,
  "social",
  "gate4",
  `${CONTROLLED_GATE4_JPEG_SHA256}.jpg`
);
const FOREIGN_COMPANY_ID = "00000000-0000-4000-8000-000000000099";
const CONTROLLED_ACCOUNT = Object.freeze({
  externalId: "17841498765432109",
  username: "ia4tube_empresas",
  accountType: "business"
});
const CONTROLLED_MEDIA_REFERENCE = controlledGate4MediaReference(
  CONTROLLED_ACCOUNT
);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assertApprovedJpeg(bytes) {
  assert.equal(Buffer.isBuffer(bytes), true);
  assert.equal(bytes.length, CONTROLLED_GATE4_JPEG_SIZE);
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  assert.equal(bytes[2], 0xff);
  assert.equal(bytes.at(-2), 0xff);
  assert.equal(bytes.at(-1), 0xd9);
  assert.equal(sha256(bytes), CONTROLLED_GATE4_JPEG_SHA256);
}

function temporaryPublicDirectory(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ia4tube-gate4-controlled-jpeg-")
  );
  const gate4Directory = path.join(directory, "social", "gate4");
  fs.mkdirSync(gate4Directory, { recursive: true });
  const asset = path.join(
    gate4Directory,
    `${CONTROLLED_GATE4_JPEG_SHA256}.jpg`
  );
  fs.copyFileSync(APPROVED_ASSET, asset);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { asset, directory };
}

function fakeResponse() {
  return {
    body: null,
    headers: {},
    statusCode: null,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    }
  };
}

test("the approved Gate 4 asset has the certified SHA-256, size and JPEG envelope", () => {
  const diskBytes = fs.readFileSync(APPROVED_ASSET);
  assertApprovedJpeg(diskBytes);

  const verified = readVerifiedJpeg(PUBLIC_DIRECTORY);
  try {
    assertApprovedJpeg(verified);
  } finally {
    verified.fill(0);
  }
});

test("the controlled media exposes only the certified immutable metadata", async () => {
  const media = createControlledGate4JpegMedia({
    publicDirectory: PUBLIC_DIRECTORY,
    publicOrigin: CONTROLLED_GATE4_STAGING_ORIGIN,
    expectedCompanyId: CONTROLLED_GATE4_COMPANY_ID
  });
  const result = await media.resolveOwnedJpeg(
    { companyId: CONTROLLED_GATE4_COMPANY_ID },
    CONTROLLED_MEDIA_REFERENCE
  );

  assert.deepEqual(result, {
    companyId: CONTROLLED_GATE4_COMPANY_ID,
    mediaId: CONTROLLED_MEDIA_REFERENCE,
    mimeType: "image/jpeg",
    sha256: CONTROLLED_GATE4_JPEG_SHA256,
    size: CONTROLLED_GATE4_JPEG_SIZE,
    publicUrl: `${CONTROLLED_GATE4_STAGING_ORIGIN}${CONTROLLED_GATE4_PUBLIC_PATH}`
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(isControlledGate4MediaReference(result.mediaId), true);
  assert.match(result.mediaId, /:17841498765432109:ia4tube_empresas:business$/);
});

test("tenant B cannot resolve the controlled Gate 4 media", async () => {
  const media = createControlledGate4JpegMedia({
    publicDirectory: PUBLIC_DIRECTORY,
    publicOrigin: CONTROLLED_GATE4_STAGING_ORIGIN
  });

  await assert.rejects(
    media.resolveOwnedJpeg(
      { companyId: FOREIGN_COMPANY_ID },
      CONTROLLED_MEDIA_REFERENCE
    ),
    { code: "resource_unavailable" }
  );
  assert.throws(
    () => createControlledGate4JpegMedia({
      publicDirectory: PUBLIC_DIRECTORY,
      publicOrigin: CONTROLLED_GATE4_STAGING_ORIGIN,
      expectedCompanyId: FOREIGN_COMPANY_ID
    }),
    { code: "resource_unavailable" }
  );
});

test("a non-staging public origin is rejected before media exposure", () => {
  assert.throws(
    () => createControlledGate4JpegMedia({
      publicDirectory: PUBLIC_DIRECTORY,
      publicOrigin: "https://example.invalid"
    }),
    { code: "resource_unavailable" }
  );
});

test("post-construction asset replacement is detected before resolution", async (t) => {
  const temporary = temporaryPublicDirectory(t);
  const media = createControlledGate4JpegMedia({
    publicDirectory: temporary.directory,
    publicOrigin: CONTROLLED_GATE4_STAGING_ORIGIN
  });
  const tampered = fs.readFileSync(temporary.asset);
  tampered[128] ^= 0x01;
  fs.writeFileSync(temporary.asset, tampered);

  await assert.rejects(
    media.resolveOwnedJpeg(
      { companyId: CONTROLLED_GATE4_COMPANY_ID },
      CONTROLLED_MEDIA_REFERENCE
    ),
    { code: "resource_unavailable" }
  );
});

test("the public handler returns exactly the verified JPEG with restrictive headers", () => {
  const handler = createControlledGate4JpegPublicHandler({
    publicDirectory: PUBLIC_DIRECTORY
  });
  const response = fakeResponse();
  let nextError = null;

  const returned = handler({}, response, (error) => {
    nextError = error;
  });

  assert.equal(nextError, null);
  assert.equal(returned, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.headers, {
    "cache-control": "public, max-age=60, immutable",
    "content-length": String(CONTROLLED_GATE4_JPEG_SIZE),
    "content-type": "image/jpeg",
    "x-content-type-options": "nosniff"
  });
  assertApprovedJpeg(response.body);
});

test("the public handler revalidates its file and fails closed after tampering", (t) => {
  const temporary = temporaryPublicDirectory(t);
  const handler = createControlledGate4JpegPublicHandler({
    publicDirectory: temporary.directory
  });
  const tampered = fs.readFileSync(temporary.asset);
  tampered[256] ^= 0x01;
  fs.writeFileSync(temporary.asset, tampered);
  const response = fakeResponse();
  let nextError = null;

  const returned = handler({}, response, (error) => {
    nextError = error;
  });

  assert.equal(returned, undefined);
  assert.equal(nextError?.code, "resource_unavailable");
  assert.equal(response.statusCode, null);
  assert.equal(response.body, null);
  assert.deepEqual(response.headers, {});
});
