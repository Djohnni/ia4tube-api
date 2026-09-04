"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SERVER_SOURCE = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const GATE4_JPEG = path.join(
  ROOT,
  "public",
  "social",
  "gate4",
  "4b9224fee69b707f304e11ad25ef7fe9d22f19904ba0b933172861f53b5bd773.jpg"
);
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf
]);

function serverFunctionSource(name, nextName) {
  const start = SERVER_SOURCE.indexOf(`function ${name}(`);
  const end = SERVER_SOURCE.indexOf(`\nfunction ${nextName}(`, start);
  assert.notEqual(start, -1, name);
  assert.notEqual(end, -1, nextName);
  return SERVER_SOURCE.slice(start, end).trim();
}

function loadReviewerJpegDimensions() {
  const source = serverFunctionSource(
    "reviewerJpegDimensions",
    "reviewerDemoText"
  );
  return Function(
    "Buffer",
    "REVIEWER_MEDIA_SOF_MARKERS",
    `"use strict"; ${source}; return realReviewerUploadJpegDimensions;`
  )(Buffer, SOF_MARKERS);
}

function rewriteJpegDimensions(bytes, width, height) {
  const changed = Buffer.from(bytes);
  for (let offset = 0; offset + 8 < changed.length; offset += 1) {
    if (changed[offset] !== 0xff || !SOF_MARKERS.has(changed[offset + 1])) {
      continue;
    }
    changed.writeUInt16BE(height, offset + 5);
    changed.writeUInt16BE(width, offset + 7);
    return changed;
  }
  throw new Error("jpeg_sof_not_found");
}

test("validador real aceita o JPEG 1080x1080 e rejeita envelope adulterado", () => {
  const dimensions = loadReviewerJpegDimensions();
  const approved = fs.readFileSync(GATE4_JPEG);
  assert.deepEqual(dimensions(approved), { width: 1080, height: 1080 });

  const missingEoi = approved.subarray(0, approved.length - 2);
  const trailingBytes = Buffer.concat([approved, Buffer.from([0x00])]);
  const invalidPrecision = Buffer.from(approved);
  const sof = invalidPrecision.findIndex((value, index) => (
    value === 0xff && SOF_MARKERS.has(invalidPrecision[index + 1])
  ));
  assert.notEqual(sof, -1);
  invalidPrecision[sof + 4] = 7;

  assert.equal(dimensions(missingEoi), null);
  assert.equal(dimensions(trailingBytes), null);
  assert.equal(dimensions(invalidPrecision), null);
});

test("validador observa dimensões divergentes e o storage exige 1080x1080", () => {
  const dimensions = loadReviewerJpegDimensions();
  const approved = fs.readFileSync(GATE4_JPEG);
  assert.deepEqual(
    dimensions(rewriteJpegDimensions(approved, 1079, 1080)),
    { width: 1079, height: 1080 }
  );
  assert.deepEqual(
    dimensions(rewriteJpegDimensions(approved, 1080, 1079)),
    { width: 1080, height: 1079 }
  );
  assert.match(SERVER_SOURCE, /dimensions\?\.width !== 1080\s*\|\|/);
  assert.match(SERVER_SOURCE, /dimensions\?\.height !== 1080\s*\|\|/);
});

test("storage dedicado mantém escrita exclusiva, atômica e sem symlink", () => {
  const storageSource = serverFunctionSource(
    "realReviewerDirectoryIsSafe",
    "realReviewerMediaDescriptor"
  );
  assert.match(storageSource, /lstatSync\(directoryPath\)/);
  assert.match(storageSource, /!stat\.isSymbolicLink\(\)/);
  assert.match(storageSource, /fs\.realpathSync\(root\)/);
  assert.match(storageSource, /fs\.openSync\(filePath, "wx", 0o600\)/);
  assert.match(storageSource, /fs\.renameSync\(pendingDirectory, finalDirectory\)/);
  assert.match(storageSource, /fs\.rmSync\(pendingDirectory, \{ recursive: true, force: true \}\)/);
  assert.match(storageSource, /REAL_REVIEWER_MEDIA_MAX_ITEMS/);
});
