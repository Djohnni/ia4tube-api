"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const SCRIPT = path.resolve(
  __dirname,
  "..",
  "scripts",
  "social-3a0p-local-safe-zip-extract.ps1"
);
const POWERSHELL = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe"
);

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content || "", "utf8");
    const compressedSize = entry.declaredCompressedSize ?? content.length;
    const uncompressedSize = entry.declaredUncompressedSize ?? content.length;
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode || 0o100644) * 0x10000) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function runExtractor(root, entries, options = {}) {
  const archive = path.join(root, "package.zip");
  const destination = path.join(root, "destination");
  fs.mkdirSync(destination);
  const bytes = storedZip(entries);
  fs.writeFileSync(archive, bytes, { flag: "wx" });
  const expectedSha256 = options.expectedSha256 ||
    crypto.createHash("sha256").update(bytes).digest("hex");
  return {
    destination,
    result: spawnSync(POWERSHELL, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      SCRIPT,
      "-ArchivePath",
      archive,
      "-Destination",
      destination,
      "-ExpectedSha256",
      expectedSha256,
      "-LayoutRoot",
      "pgsql"
    ], {
      encoding: "utf8",
      shell: false,
      timeout: 20_000,
      windowsHide: true
    })
  };
}

function withOwnedTemporaryRoot(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-safe-zip-"));
  try {
    return callback(root);
  } finally {
    const resolved = path.resolve(root);
    const temp = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), temp);
    assert.match(path.basename(resolved), /^ia4tube-safe-zip-[A-Za-z0-9]{6}$/);
    fs.rmSync(resolved, { recursive: true, force: false });
  }
}

test("locked ZIP extractor accepts regular files and directories", () => {
  withOwnedTemporaryRoot((root) => {
    const { destination, result } = runExtractor(root, [
      { name: "pgsql/", mode: 0o040755 },
      { name: "pgsql/bin/", mode: 0o040755 },
      { name: "pgsql/bin/postgres.exe", mode: 0o100755, content: "synthetic" }
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(path.join(destination, "pgsql", "bin", "postgres.exe"), "utf8"),
      "synthetic"
    );
  });
});

test("locked ZIP extractor rejects links and Windows path hazards before writes", () => {
  for (const unsafe of [
    { name: "pgsql/bin/link", mode: 0o120777, content: "../../outside" },
    { name: "pgsql/../outside.exe", mode: 0o100644, content: "outside" },
    { name: "pgsql/bin/postgres.exe::$DATA", mode: 0o100644, content: "ads" },
    { name: "pgsql/CON/file.exe", mode: 0o100644, content: "device" },
    { name: "pgsql/COM¹/file.exe", mode: 0o100644, content: "ambiguous-device" }
  ]) {
    withOwnedTemporaryRoot((root) => {
      const { destination, result } = runExtractor(root, [unsafe]);
      assert.notEqual(result.status, 0);
      assert.deepEqual(fs.readdirSync(destination), []);
      assert.equal(fs.existsSync(path.join(root, "outside.exe")), false);
    });
  }
});

test("locked ZIP extractor refuses oversized and extreme-ratio entries before writes", () => {
  for (const unsafe of [
    {
      name: "pgsql/bin/oversized.exe",
      mode: 0o100644,
      content: "x",
      declaredCompressedSize: 1,
      declaredUncompressedSize: 0x80000001
    },
    {
      name: "pgsql/bin/bomb.exe",
      mode: 0o100644,
      content: "x",
      declaredCompressedSize: 1,
      declaredUncompressedSize: (64 * 1024 * 1024) + 1
    }
  ]) {
    withOwnedTemporaryRoot((root) => {
      const { destination, result } = runExtractor(root, [unsafe]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /windows_harness_archive_size_refused/);
      assert.deepEqual(fs.readdirSync(destination), []);
    });
  }
});

test("locked ZIP extractor counts actual output and removes size-mismatch partials", () => {
  for (const unsafe of [
    {
      name: "pgsql/bin/declared-too-small.exe",
      mode: 0o100644,
      content: "ten-bytes!",
      declaredCompressedSize: 10,
      declaredUncompressedSize: 1
    },
    {
      name: "pgsql/bin/declared-too-large.exe",
      mode: 0o100644,
      content: "x",
      declaredCompressedSize: 1,
      declaredUncompressedSize: 2
    }
  ]) {
    withOwnedTemporaryRoot((root) => {
      const { destination, result } = runExtractor(root, [unsafe]);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /windows_harness_archive_(?:size_refused|size_mismatch)/
      );
      assert.equal(
        fs.existsSync(path.join(destination, ...unsafe.name.split("/"))),
        false
      );
    });
  }
});

test("locked ZIP extractor rejects bytes outside the approved SHA-256", () => {
  withOwnedTemporaryRoot((root) => {
    const { destination, result } = runExtractor(root, [
      { name: "pgsql/bin/postgres.exe", mode: 0o100755, content: "synthetic" }
    ], { expectedSha256: "f".repeat(64) });
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readdirSync(destination), []);
  });
});
