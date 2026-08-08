"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  ZipInventoryFailure,
  inspectZipBuffer,
  inspectZipFile
} = require("../scripts/social-3a0p-local-zip-inventory");

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;

function extraField(identifier, data = Buffer.alloc(0)) {
  const output = Buffer.alloc(4 + data.length);
  output.writeUInt16LE(identifier, 0);
  output.writeUInt16LE(data.length, 2);
  data.copy(output, 4);
  return output;
}

function unixAttributes(mode) {
  return (mode << 16) >>> 0;
}

function buildZip(entryOptions, archiveOptions = {}) {
  const entries = entryOptions.map((entry, index) => {
    const rawName = Buffer.isBuffer(entry.name)
      ? Buffer.from(entry.name)
      : Buffer.from(entry.name || ("entry-" + index + ".txt"), "ascii");
    const data = Buffer.from(entry.data === undefined ? "" : entry.data);
    const method = entry.method === undefined ? 0 : entry.method;
    const flags = entry.flags === undefined ? 0x0800 : entry.flags;
    const crc32 = entry.crc32 === undefined ? (0x10203040 + index) >>> 0 : entry.crc32 >>> 0;
    const compressedSize = entry.compressedSize === undefined ? data.length : entry.compressedSize;
    const uncompressedSize = entry.uncompressedSize === undefined ? data.length : entry.uncompressedSize;
    const localExtra = entry.localExtra || entry.extra || Buffer.alloc(0);
    const centralExtra = entry.centralExtra || entry.extra || Buffer.alloc(0);
    const creator = entry.creator === undefined ? 0 : entry.creator;
    const externalAttributes = entry.externalAttributes === undefined
      ? 0
      : entry.externalAttributes >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(entry.versionNeeded === undefined ? 20 : entry.versionNeeded, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if ((flags & 0x0008) === 0) {
      local.writeUInt32LE(crc32, 14);
      local.writeUInt32LE(compressedSize, 18);
      local.writeUInt32LE(uncompressedSize, 22);
    }
    local.writeUInt16LE(rawName.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    let descriptor = Buffer.alloc(0);
    if ((flags & 0x0008) !== 0) {
      descriptor = Buffer.alloc(entry.descriptorSignature === false ? 12 : 16);
      const offset = descriptor.length === 16 ? 4 : 0;
      if (descriptor.length === 16) descriptor.writeUInt32LE(DESCRIPTOR_SIGNATURE, 0);
      descriptor.writeUInt32LE(crc32, offset);
      descriptor.writeUInt32LE(compressedSize, offset + 4);
      descriptor.writeUInt32LE(uncompressedSize, offset + 8);
    }
    return {
      rawName,
      data,
      method,
      flags,
      crc32,
      compressedSize,
      uncompressedSize,
      localExtra,
      centralExtra,
      creator,
      externalAttributes,
      localRecord: Buffer.concat([local, rawName, localExtra, data, descriptor]),
      localOffset: 0
    };
  });

  let localCursor = archiveOptions.prefixBytes || 0;
  for (const entry of entries) {
    entry.localOffset = localCursor;
    localCursor += entry.localRecord.length;
  }
  const localSection = Buffer.concat([
    Buffer.alloc(archiveOptions.prefixBytes || 0),
    ...entries.map((entry) => entry.localRecord)
  ]);
  const centralRecords = entries.map((entry, index) => {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE((entry.creator << 8) | 20, 4);
    central.writeUInt16LE(entryOptions[index].versionNeeded === undefined ? 20 : entryOptions[index].versionNeeded, 6);
    central.writeUInt16LE(entry.flags, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(entry.crc32, 16);
    central.writeUInt32LE(entry.compressedSize, 20);
    central.writeUInt32LE(entry.uncompressedSize, 24);
    central.writeUInt16LE(entry.rawName.length, 28);
    central.writeUInt16LE(entry.centralExtra.length, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt32LE(entry.externalAttributes, 38);
    const offset = entryOptions[index].localOffsetOverride === undefined
      ? entry.localOffset
      : entryOptions[index].localOffsetOverride;
    central.writeUInt32LE(offset >>> 0, 42);
    return Buffer.concat([central, entry.rawName, entry.centralExtra]);
  });
  const centralSection = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(archiveOptions.diskNumber || 0, 4);
  eocd.writeUInt16LE(archiveOptions.centralDisk || 0, 6);
  eocd.writeUInt16LE(
    archiveOptions.diskEntries === undefined ? entries.length : archiveOptions.diskEntries,
    8
  );
  eocd.writeUInt16LE(
    archiveOptions.totalEntries === undefined ? entries.length : archiveOptions.totalEntries,
    10
  );
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);
  return {
    buffer: Buffer.concat([localSection, centralSection, eocd]),
    localOffsets: entries.map((entry) => entry.localOffset),
    centralOffset: localSection.length,
    centralRecordOffsets: centralRecords.reduce((offsets, record, index) => {
      offsets.push(index === 0 ? localSection.length : offsets[index - 1] + centralRecords[index - 1].length);
      return offsets;
    }, [])
  };
}

function failure(buffer, code, classification) {
  assert.throws(
    () => inspectZipBuffer(buffer),
    (error) => {
      assert.ok(error instanceof ZipInventoryFailure);
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      if (classification !== undefined) assert.equal(error.evidence.classification, classification);
      return true;
    }
  );
}

test("DOS/FAT entries with zero attributes use slash-only directory evidence", () => {
  const result = inspectZipBuffer(buildZip([
    { name: "pgsql/bin/postgres.exe", data: "binary" },
    { name: "pgsql/share/" }
  ]).buffer);
  assert.equal(result.totalEntries, 2);
  assert.equal(result.fileCount, 1);
  assert.equal(result.directoryCount, 1);
  assert.deepEqual(result.normalizedClasses, { regular_file: 1, directory: 1 });
  assert.deepEqual(result.creatorSystems, { dos_fat: 2, unix: 0, ntfs: 0 });
  assert.equal(result.unixModePresentCount, 0);
  assert.deepEqual(result.entries, [
    {
      name: "pgsql/bin/postgres.exe",
      kind: "regular_file",
      diagnosticClass: "ambiguous_but_resolvable"
    },
    {
      name: "pgsql/share",
      kind: "directory",
      diagnosticClass: "ambiguous_but_resolvable"
    }
  ]);
  assert.equal(result.diagnosticClasses.ambiguous_but_resolvable, 2);
});

test("Unix regular files and directories require compatible type metadata", () => {
  const result = inspectZipBuffer(buildZip([
    {
      name: "pgsql/bin/postgres",
      creator: 3,
      externalAttributes: unixAttributes(0o100755),
      data: "x"
    },
    {
      name: "pgsql/share/",
      creator: 3,
      externalAttributes: unixAttributes(0o040755)
    }
  ]).buffer);
  assert.equal(result.fileCount, 1);
  assert.equal(result.directoryCount, 1);
  assert.equal(result.creatorSystems.unix, 2);
  assert.equal(result.unixModePresentCount, 2);
});

test("NTFS creator accepts a coherent DOS directory bit and trailing slash", () => {
  const result = inspectZipBuffer(buildZip([
    { name: "pgsql/", creator: 10, externalAttributes: 0x10 }
  ]).buffer);
  assert.equal(result.directoryCount, 1);
  assert.equal(result.creatorSystems.ntfs, 1);
  assert.equal(result.externalAttributeCategories.dos_directory, 1);
});

test("DOS directory bit without trailing slash is refused as extractor conflict", () => {
  failure(
    buildZip([{ name: "pgsql", creator: 10, externalAttributes: 0x10 }]).buffer,
    "zip_inventory_attribute_conflict",
    "unsafe"
  );
});

test("Unix directory mode without trailing slash is refused as extractor conflict", () => {
  failure(
    buildZip([{
      name: "pgsql",
      creator: 3,
      externalAttributes: unixAttributes(0o040755)
    }]).buffer,
    "zip_inventory_attribute_conflict",
    "unsafe"
  );
});

test("incomplete Unix metadata resolves a directory by trailing slash", () => {
  const result = inspectZipBuffer(buildZip([
    { name: "pgsql/", creator: 3, externalAttributes: 0 }
  ]).buffer);
  assert.equal(result.directoryCount, 1);
  assert.equal(result.externalAttributeCategories.ambiguous_but_resolvable, 1);
});

test("incomplete DOS metadata resolves a regular file by absence of directory signals", () => {
  const result = inspectZipBuffer(buildZip([
    { name: "pgsql/readme.txt", creator: 0, externalAttributes: 0, data: "x" }
  ]).buffer);
  assert.equal(result.fileCount, 1);
  assert.equal(result.externalAttributeCategories.ambiguous_but_resolvable, 1);
});

test("DOS archive attributes classify a regular file without Unix mode", () => {
  const result = inspectZipBuffer(buildZip([{
    name: "pgsql/readme.txt",
    creator: 0,
    externalAttributes: 0x20,
    data: "x"
  }]).buffer);
  assert.equal(result.fileCount, 1);
  assert.equal(result.diagnosticClasses.dos_regular_file, 1);
  assert.equal(result.externalAttributeCategories.dos_regular_file, 1);
});

test("DOS directory attributes classify a slash-marked directory", () => {
  const result = inspectZipBuffer(buildZip([{
    name: "pgsql/share/",
    creator: 0,
    externalAttributes: 0x10
  }]).buffer);
  assert.equal(result.directoryCount, 1);
  assert.equal(result.diagnosticClasses.dos_directory, 1);
  assert.equal(result.externalAttributeCategories.dos_directory, 1);
});

for (const [label, mode, classification] of [
  ["symlink", 0o120777, "symbolic_link"],
  ["fifo", 0o010644, "fifo"],
  ["socket", 0o140644, "socket"],
  ["character device", 0o020644, "character_device"],
  ["block device", 0o060644, "block_device"],
  ["unknown Unix type", 0o030644, "unknown"]
]) {
  test(label + " is refused from Unix mode metadata", () => {
    const archive = buildZip([{
      name: "pgsql/special",
      creator: 3,
      externalAttributes: unixAttributes(mode)
    }]).buffer;
    failure(archive, "zip_inventory_entry_type_refused", classification);
  });
}

test("duplicate local offsets are refused as hardlink-like metadata", () => {
  const archive = buildZip([
    { name: "pgsql/a", data: "a" },
    { name: "pgsql/b", data: "b", localOffsetOverride: 0 }
  ]).buffer;
  failure(archive, "zip_inventory_entry_type_refused", "hardlink_metadata");
});

test("ASi Unix link metadata is refused", () => {
  const archive = buildZip([{
    name: "pgsql/a",
    extra: extraField(0x756e, Buffer.alloc(14))
  }]).buffer;
  failure(archive, "zip_inventory_entry_type_refused", "hardlink_metadata");
});

test("Windows reparse-point metadata is refused", () => {
  const archive = buildZip([{
    name: "pgsql/a",
    creator: 10,
    externalAttributes: 0x0400
  }]).buffer;
  failure(archive, "zip_inventory_entry_type_refused", "unsafe");
});

test("DOS volume-label metadata is refused", () => {
  const archive = buildZip([{
    name: "VOLUME",
    externalAttributes: 0x0008
  }]).buffer;
  failure(archive, "zip_inventory_entry_type_refused", "unsafe");
});

test("unknown creator system is refused", () => {
  const archive = buildZip([{ name: "pgsql/a", creator: 7 }]).buffer;
  failure(archive, "zip_inventory_creator_refused", "unknown");
});

for (const [label, name] of [
  ["parent traversal", "pgsql/../escape"],
  ["absolute path", "/pgsql/a"],
  ["drive path", "C:/pgsql/a"],
  ["alternate data stream", "pgsql/a:stream"],
  ["reserved Windows device", "pgsql/CON.txt"],
  ["backslash", "pgsql\\a"],
  ["trailing dot", "pgsql/a."],
  ["double separator", "pgsql//a"]
]) {
  test(label + " path is refused", () => {
    failure(buildZip([{ name }]).buffer, "zip_inventory_entry_path_refused");
  });
}

test("case-insensitive path collision is refused", () => {
  const archive = buildZip([
    { name: "pgsql/bin/A.dll" },
    { name: "pgsql/bin/a.dll" }
  ]).buffer;
  failure(archive, "zip_inventory_duplicate_entry_refused");
});

test("exact duplicate path is refused", () => {
  const archive = buildZip([
    { name: "pgsql/a" },
    { name: "pgsql/a" }
  ]).buffer;
  failure(archive, "zip_inventory_duplicate_entry_refused");
});

test("encrypted entry is refused", () => {
  failure(
    buildZip([{ name: "pgsql/a", flags: 0x0801 }]).buffer,
    "zip_inventory_encryption_refused"
  );
});

test("unsupported compression is refused", () => {
  failure(
    buildZip([{ name: "pgsql/a", method: 99 }]).buffer,
    "zip_inventory_compression_refused"
  );
});

test("stored entry with inconsistent sizes is refused", () => {
  failure(
    buildZip([{ name: "pgsql/a", data: "x", uncompressedSize: 2 }]).buffer,
    "zip_inventory_size_offset_invalid"
  );
});

test("directory payload is refused", () => {
  failure(
    buildZip([{ name: "pgsql/", data: "x" }]).buffer,
    "zip_inventory_directory_payload_refused"
  );
});

test("Unix regular-file metadata conflicting with a trailing slash is refused", () => {
  failure(
    buildZip([{
      name: "pgsql/a/",
      creator: 3,
      externalAttributes: unixAttributes(0o100644)
    }]).buffer,
    "zip_inventory_attribute_conflict"
  );
});

test("duplicate extra-field identifiers are refused", () => {
  const duplicate = Buffer.concat([extraField(0x5455), extraField(0x5455)]);
  failure(
    buildZip([{ name: "pgsql/a", extra: duplicate }]).buffer,
    "zip_inventory_extra_field_duplicate"
  );
});

test("malformed extra field is refused", () => {
  const malformed = Buffer.from([0x55, 0x54, 0xff, 0xff]);
  failure(
    buildZip([{ name: "pgsql/a", extra: malformed }]).buffer,
    "zip_inventory_extra_field_malformed"
  );
});

test("unknown extra field is refused", () => {
  failure(
    buildZip([{ name: "pgsql/a", extra: extraField(0x4242) }]).buffer,
    "zip_inventory_extra_field_refused"
  );
});

test("ZIP64 metadata is refused", () => {
  const built = buildZip([{ name: "pgsql/a" }]);
  built.buffer.writeUInt32LE(0xffffffff, built.centralRecordOffsets[0] + 20);
  failure(built.buffer, "zip_inventory_zip64_refused");
});

test("multi-disk metadata is refused", () => {
  failure(
    buildZip([{ name: "pgsql/a" }], { diskNumber: 1 }).buffer,
    "zip_inventory_multidisk_refused"
  );
});

test("truncated EOCD is refused", () => {
  const archive = buildZip([{ name: "pgsql/a" }]).buffer;
  failure(archive.subarray(0, archive.length - 1), "zip_inventory_eocd_invalid");
});

test("an extra byte between local data and central directory is refused", () => {
  const built = buildZip([{ name: "pgsql/a", data: "x" }]);
  const extraByte = Buffer.from([0]);
  const central = built.buffer.subarray(built.centralOffset, built.buffer.length - 22);
  const eocd = Buffer.from(built.buffer.subarray(built.buffer.length - 22));
  eocd.writeUInt32LE(built.centralOffset + 1, 16);
  const archive = Buffer.concat([
    built.buffer.subarray(0, built.centralOffset),
    extraByte,
    central,
    eocd
  ]);
  failure(archive, "zip_inventory_size_offset_invalid");
});

test("local and central names must match", () => {
  const built = buildZip([{ name: "pgsql/a" }]);
  built.buffer[built.localOffsets[0] + 30] = "q".charCodeAt(0);
  failure(built.buffer, "zip_inventory_local_header_mismatch");
});

test("local and central sizes must match", () => {
  const built = buildZip([{ name: "pgsql/a", data: "x" }]);
  built.buffer.writeUInt32LE(2, built.localOffsets[0] + 22);
  failure(built.buffer, "zip_inventory_local_header_mismatch");
});

test("valid data descriptor with signature is accepted", () => {
  const result = inspectZipBuffer(buildZip([{
    name: "pgsql/a",
    data: "abc",
    flags: 0x0808
  }]).buffer);
  assert.equal(result.fileCount, 1);
});

test("valid data descriptor without signature is accepted", () => {
  const result = inspectZipBuffer(buildZip([{
    name: "pgsql/a",
    data: "abc",
    flags: 0x0808,
    descriptorSignature: false
  }]).buffer);
  assert.equal(result.fileCount, 1);
});

test("invalid data descriptor is refused", () => {
  const built = buildZip([{
    name: "pgsql/a",
    data: "abc",
    flags: 0x0808
  }]);
  const descriptorOffset = built.centralOffset - 16;
  built.buffer.writeUInt32LE(0, descriptorOffset + 4);
  failure(built.buffer, "zip_inventory_data_descriptor_invalid");
});

test("benign timestamp extra fields are accepted when well formed", () => {
  const result = inspectZipBuffer(buildZip([{
    name: "pgsql/a",
    extra: extraField(0x5455, Buffer.from([0]))
  }]).buffer);
  assert.equal(result.fileCount, 1);
});

test("inspectZipFile reads only through the inventory contract", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-zip-inventory-test-"));
  const archivePath = path.join(root, "fixture.zip");
  try {
    const original = buildZip([{ name: "pgsql/a", data: "x" }]).buffer;
    fs.writeFileSync(archivePath, original);
    const before = fs.statSync(archivePath);
    const result = inspectZipFile(archivePath);
    const after = fs.statSync(archivePath);
    assert.equal(result.totalEntries, 1);
    assert.equal(result.entries[0].name, "pgsql/a");
    assert.deepEqual(fs.readFileSync(archivePath), original);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.birthtimeMs, before.birthtimeMs);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failure evidence is sanitized and contains only the entry path hash", () => {
  const sensitiveName = "pgsql/secret-user/password:token";
  assert.throws(
    () => inspectZipBuffer(buildZip([{ name: sensitiveName }]).buffer),
    (error) => {
      const serialized = JSON.stringify(error);
      assert.equal(error.code, "zip_inventory_entry_path_refused");
      assert.match(error.evidence.entryPathSha256, /^[0-9a-f]{64}$/);
      assert.equal(error.evidence.entryIndex, 0);
      assert.doesNotMatch(serialized, /secret-user|password|token|pgsql/);
      assert.deepEqual(
        Object.keys(error.evidence).sort(),
        [
          "classification",
          "creatorSystem",
          "entryIndex",
          "entryPathSha256",
          "externalAttributeCategory",
          "unixModePresent"
        ]
      );
      return true;
    }
  );
});
