"use strict";

// Fail-closed ZIP central-directory inventory. This module never extracts an
// entry and never includes an archive path or entry name in an error.
const crypto = require("node:crypto");
const fs = require("node:fs");

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const MAX_ENTRIES = 100_000;
const MAX_CENTRAL_DIRECTORY_BYTES = 128 * 1024 * 1024;
const MAX_ENTRY_NAME_BYTES = 4096;
const MAX_EXTRA_BYTES = 64 * 1024 - 1;
const ZIP32_SENTINEL = 0xffffffff;
const ZIP16_SENTINEL = 0xffff;
const DOS_VOLUME_LABEL = 0x0008;
const DOS_DIRECTORY = 0x0010;
const WINDOWS_REPARSE_POINT = 0x0400;
const UNIX_TYPE_MASK = 0xf000;
const UNIX_FIFO = 0x1000;
const UNIX_CHARACTER_DEVICE = 0x2000;
const UNIX_DIRECTORY = 0x4000;
const UNIX_BLOCK_DEVICE = 0x6000;
const UNIX_REGULAR_FILE = 0x8000;
const UNIX_SYMLINK = 0xa000;
const UNIX_SOCKET = 0xc000;
const ALLOWED_CREATORS = new Map([
  [0, "dos_fat"],
  [3, "unix"],
  [10, "ntfs"]
]);
const ALLOWED_EXTRA_FIELDS = new Set([
  0x000a, // NTFS timestamps
  0x5455, // extended timestamps
  0x5855, // Info-ZIP Unix timestamps/uid/gid
  0x7875 // Info-ZIP Unix uid/gid
]);
const REFUSED_LINK_EXTRA_FIELDS = new Set([
  0x000d, // PKWARE Unix metadata may carry a link target
  0x756e // ASi Unix metadata may carry link metadata
]);
const REFUSED_ENCRYPTION_EXTRA_FIELDS = new Set([
  0x0014,
  0x0015,
  0x0017,
  0x9901
]);
const SAFE_ENTRY_CLASSIFICATIONS = Object.freeze([
  "regular_file",
  "directory",
  "symbolic_link",
  "hardlink_metadata",
  "fifo",
  "socket",
  "character_device",
  "block_device",
  "dos_regular_file",
  "dos_directory",
  "unix_regular_file",
  "unix_directory",
  "ambiguous_but_resolvable",
  "unsafe",
  "unknown"
]);

class ZipInventoryFailure extends Error {
  constructor(code, evidence = undefined) {
    super(code);
    this.name = "ZipInventoryFailure";
    this.code = code;
    if (evidence !== undefined) {
      Object.defineProperty(this, "evidence", {
        configurable: false,
        enumerable: true,
        writable: false,
        value: Object.freeze({ ...evidence })
      });
    }
  }
}

function fail(code, evidence) {
  throw new ZipInventoryFailure(code, evidence);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function entryEvidence(index, rawName, metadata = {}) {
  const creatorSystem = ALLOWED_CREATORS.get(metadata.creator) || "unknown";
  const requestedClassification = metadata.diagnosticClass || metadata.classification;
  return {
    entryIndex: Number.isSafeInteger(index) && index >= 0 ? index : null,
    entryPathSha256: Buffer.isBuffer(rawName) ? sha256(rawName) : null,
    creatorSystem,
    unixModePresent: metadata.unixModePresent === true,
    externalAttributeCategory: metadata.externalAttributeCategory || "unknown",
    classification: SAFE_ENTRY_CLASSIFICATIONS.includes(requestedClassification)
      ? requestedClassification
      : "unknown"
  };
}

function checkedAdd(left, right, code) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < left) fail(code);
  return result;
}

function bufferReader(buffer) {
  if (!Buffer.isBuffer(buffer)) fail("zip_inventory_input_invalid");
  return Object.freeze({
    size: buffer.length,
    read(offset, length) {
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 0 ||
        checkedAdd(offset, length, "zip_inventory_offset_invalid") > buffer.length
      ) {
        fail("zip_inventory_truncated");
      }
      return buffer.subarray(offset, offset + length);
    }
  });
}

function fileReader(archivePath) {
  if (typeof archivePath !== "string" || archivePath.length === 0 || archivePath.includes("\0")) {
    fail("zip_inventory_input_invalid");
  }
  let descriptor;
  try {
    descriptor = fs.openSync(archivePath, "r");
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size < 0) {
      fail("zip_inventory_input_invalid");
    }
    return {
      size: stats.size,
      read(offset, length) {
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(length) ||
          offset < 0 ||
          length < 0 ||
          checkedAdd(offset, length, "zip_inventory_offset_invalid") > stats.size
        ) {
          fail("zip_inventory_truncated");
        }
        const output = Buffer.alloc(length);
        let consumed = 0;
        while (consumed < length) {
          const count = fs.readSync(descriptor, output, consumed, length - consumed, offset + consumed);
          if (count <= 0) fail("zip_inventory_truncated");
          consumed += count;
        }
        return output;
      },
      close() {
        if (descriptor !== undefined) {
          fs.closeSync(descriptor);
          descriptor = undefined;
        }
      }
    };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error instanceof ZipInventoryFailure) throw error;
    fail("zip_inventory_read_failed");
  }
}

function canonicalEntryName(rawName, index, metadata) {
  const unsafeMetadata = { ...metadata, diagnosticClass: "unsafe" };
  if (
    !Buffer.isBuffer(rawName) ||
    rawName.length === 0 ||
    rawName.length > MAX_ENTRY_NAME_BYTES ||
    rawName.includes(0)
  ) {
    fail("zip_inventory_entry_path_refused", entryEvidence(index, rawName, unsafeMetadata));
  }
  for (const octet of rawName) {
    if (octet < 32 || octet > 126) {
      fail("zip_inventory_entry_path_refused", entryEvidence(index, rawName, unsafeMetadata));
    }
  }
  const original = rawName.toString("ascii");
  if (/[\r\n\\]/.test(original) || original.startsWith("/") || /^[a-z]:/i.test(original)) {
    fail("zip_inventory_entry_path_refused", entryEvidence(index, rawName, unsafeMetadata));
  }
  const trailingSlash = original.endsWith("/");
  const normalized = trailingSlash ? original.slice(0, -1) : original;
  if (!normalized || normalized.endsWith("/") || normalized.length > MAX_ENTRY_NAME_BYTES) {
    fail("zip_inventory_entry_path_refused", entryEvidence(index, rawName, unsafeMetadata));
  }
  const components = normalized.split("/");
  if (components.some((part) => {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      part.length > 255 ||
      /[ .]$/.test(part) ||
      /[<>:"|?*]/.test(part)
    ) {
      return true;
    }
    const deviceStem = part.split(".", 1)[0].toUpperCase();
    return /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/.test(deviceStem);
  })) {
    fail("zip_inventory_entry_path_refused", entryEvidence(index, rawName, unsafeMetadata));
  }
  return { normalized, trailingSlash };
}

function parseExtraFields(extra, index, rawName, metadata) {
  if (!Buffer.isBuffer(extra) || extra.length > MAX_EXTRA_BYTES) {
    fail("zip_inventory_extra_field_refused", entryEvidence(index, rawName, metadata));
  }
  const identifiers = new Set();
  let cursor = 0;
  while (cursor < extra.length) {
    if (cursor + 4 > extra.length) {
      fail("zip_inventory_extra_field_malformed", entryEvidence(index, rawName, metadata));
    }
    const identifier = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + size > extra.length) {
      fail("zip_inventory_extra_field_malformed", entryEvidence(index, rawName, metadata));
    }
    if (identifiers.has(identifier)) {
      fail("zip_inventory_extra_field_duplicate", entryEvidence(index, rawName, metadata));
    }
    identifiers.add(identifier);
    if (identifier === 0x0001) {
      fail("zip_inventory_zip64_refused", entryEvidence(index, rawName, metadata));
    }
    if (REFUSED_LINK_EXTRA_FIELDS.has(identifier)) {
      fail("zip_inventory_entry_type_refused", entryEvidence(index, rawName, {
        ...metadata,
        diagnosticClass: "hardlink_metadata"
      }));
    }
    if (REFUSED_ENCRYPTION_EXTRA_FIELDS.has(identifier)) {
      fail("zip_inventory_encryption_refused", entryEvidence(index, rawName, metadata));
    }
    if (!ALLOWED_EXTRA_FIELDS.has(identifier)) {
      fail("zip_inventory_extra_field_refused", entryEvidence(index, rawName, metadata));
    }
    cursor += size;
  }
}

function classifyExternalAttributes({ creator, externalAttributes, trailingSlash, index, rawName }) {
  const unixMode = (externalAttributes >>> 16) & 0xffff;
  const unixType = unixMode & UNIX_TYPE_MASK;
  const dosAttributes = externalAttributes & 0xffff;
  const unixModePresent = unixMode !== 0;
  const baseMetadata = { creator, unixModePresent };

  if (!ALLOWED_CREATORS.has(creator)) {
    fail("zip_inventory_creator_refused", entryEvidence(index, rawName, {
      ...baseMetadata,
      diagnosticClass: "unknown"
    }));
  }
  if ((dosAttributes & WINDOWS_REPARSE_POINT) !== 0) {
    fail("zip_inventory_entry_type_refused", entryEvidence(index, rawName, {
      ...baseMetadata,
      externalAttributeCategory: "unsafe",
      diagnosticClass: "unsafe"
    }));
  }
  if ((dosAttributes & DOS_VOLUME_LABEL) !== 0) {
    fail("zip_inventory_entry_type_refused", entryEvidence(index, rawName, {
      ...baseMetadata,
      externalAttributeCategory: "unsafe",
      diagnosticClass: "unsafe"
    }));
  }

  let explicitUnixKind = null;
  let explicitUnixDiagnosticClass = null;
  if (creator === 3 && unixType !== 0) {
    const unixClassification = new Map([
      [UNIX_REGULAR_FILE, ["regular_file", "unix_regular_file"]],
      [UNIX_DIRECTORY, ["directory", "unix_directory"]],
      [UNIX_SYMLINK, [null, "symbolic_link"]],
      [UNIX_FIFO, [null, "fifo"]],
      [UNIX_SOCKET, [null, "socket"]],
      [UNIX_CHARACTER_DEVICE, [null, "character_device"]],
      [UNIX_BLOCK_DEVICE, [null, "block_device"]]
    ]).get(unixType) || [null, "unknown"];
    [explicitUnixKind, explicitUnixDiagnosticClass] = unixClassification;
    if (!explicitUnixKind) {
      fail("zip_inventory_entry_type_refused", entryEvidence(index, rawName, {
        ...baseMetadata,
        externalAttributeCategory: explicitUnixDiagnosticClass,
        diagnosticClass: explicitUnixDiagnosticClass
      }));
    }
  } else if (creator !== 3 && unixType !== 0) {
    fail("zip_inventory_attribute_conflict", entryEvidence(index, rawName, {
      ...baseMetadata,
      diagnosticClass: "unsafe"
    }));
  }

  const dosDirectory = (dosAttributes & DOS_DIRECTORY) !== 0;
  if (
    (explicitUnixKind === "regular_file" && (dosDirectory || trailingSlash)) ||
    (explicitUnixKind === "directory" && !trailingSlash) ||
    (dosDirectory && !trailingSlash)
  ) {
    fail("zip_inventory_attribute_conflict", entryEvidence(index, rawName, {
      ...baseMetadata,
      externalAttributeCategory: "unsafe",
      diagnosticClass: "unsafe"
    }));
  }

  // The separately audited extractor recognizes directories by the trailing
  // slash. Refuse metadata that would make inventory and extraction disagree.
  const classification = trailingSlash ? "directory" : "regular_file";
  const diagnosticClass = explicitUnixDiagnosticClass ||
    (creator === 3 || externalAttributes === 0 || (trailingSlash && !dosDirectory)
      ? "ambiguous_but_resolvable"
      : dosDirectory
        ? "dos_directory"
        : "dos_regular_file");
  const externalAttributeCategory = diagnosticClass;

  return Object.freeze({
    classification,
    diagnosticClass,
    creatorSystem: ALLOWED_CREATORS.get(creator),
    unixModePresent,
    unixMode,
    externalAttributeCategory
  });
}

function validateFlags(flags, method, index, rawName, metadata) {
  if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || (flags & 0x2000) !== 0) {
    fail("zip_inventory_encryption_refused", entryEvidence(index, rawName, metadata));
  }
  const allowed = 0x0008 | 0x0800 | (method === 8 ? 0x0006 : 0);
  if ((flags & ~allowed) !== 0 || (method !== 8 && (flags & 0x0006) !== 0)) {
    fail("zip_inventory_flags_refused", entryEvidence(index, rawName, metadata));
  }
}

function parseCentralDirectory(reader) {
  if (reader.size < 22 || reader.size > ZIP32_SENTINEL) {
    fail(reader.size > ZIP32_SENTINEL ? "zip_inventory_zip64_refused" : "zip_inventory_eocd_invalid");
  }
  const eocdOffset = reader.size - 22;
  const eocd = reader.read(eocdOffset, 22);
  if (eocd.readUInt32LE(0) !== EOCD_SIGNATURE || eocd.readUInt16LE(20) !== 0) {
    fail("zip_inventory_eocd_invalid");
  }
  const diskNumber = eocd.readUInt16LE(4);
  const centralDisk = eocd.readUInt16LE(6);
  const diskEntries = eocd.readUInt16LE(8);
  const totalEntries = eocd.readUInt16LE(10);
  const centralSize = eocd.readUInt32LE(12);
  const centralOffset = eocd.readUInt32LE(16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    fail("zip_inventory_multidisk_refused");
  }
  if (
    totalEntries === ZIP16_SENTINEL ||
    centralSize === ZIP32_SENTINEL ||
    centralOffset === ZIP32_SENTINEL
  ) {
    fail("zip_inventory_zip64_refused");
  }
  if (totalEntries === 0 || totalEntries > MAX_ENTRIES || centralSize > MAX_CENTRAL_DIRECTORY_BYTES) {
    fail("zip_inventory_limit_refused");
  }
  if (checkedAdd(centralOffset, centralSize, "zip_inventory_offset_invalid") !== eocdOffset) {
    fail("zip_inventory_central_directory_invalid");
  }
  const central = reader.read(centralOffset, centralSize);
  const records = [];
  const normalizedNames = new Set();
  const foldedNames = new Set();
  const localOffsets = new Set();
  let cursor = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      fail("zip_inventory_central_directory_invalid");
    }
    const versionMadeBy = central.readUInt16LE(cursor + 4);
    const creator = versionMadeBy >>> 8;
    const versionNeeded = central.readUInt16LE(cursor + 6);
    const flags = central.readUInt16LE(cursor + 8);
    const method = central.readUInt16LE(cursor + 10);
    const crc32 = central.readUInt32LE(cursor + 16);
    const compressedSize = central.readUInt32LE(cursor + 20);
    const uncompressedSize = central.readUInt32LE(cursor + 24);
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentLength = central.readUInt16LE(cursor + 32);
    const diskStart = central.readUInt16LE(cursor + 34);
    const externalAttributes = central.readUInt32LE(cursor + 38) >>> 0;
    const localOffset = central.readUInt32LE(cursor + 42);
    const variableLength = nameLength + extraLength + commentLength;
    const recordEnd = cursor + 46 + variableLength;
    if (recordEnd > central.length || commentLength !== 0 || diskStart !== 0) {
      fail("zip_inventory_central_entry_invalid");
    }
    const rawName = central.subarray(cursor + 46, cursor + 46 + nameLength);
    const extra = central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
    const preliminary = { creator, unixModePresent: ((externalAttributes >>> 16) & 0xffff) !== 0 };
    if (
      compressedSize === ZIP32_SENTINEL ||
      uncompressedSize === ZIP32_SENTINEL ||
      localOffset === ZIP32_SENTINEL ||
      versionNeeded >= 45
    ) {
      fail("zip_inventory_zip64_refused", entryEvidence(index, rawName, preliminary));
    }
    if (![0, 8].includes(method)) {
      fail("zip_inventory_compression_refused", entryEvidence(index, rawName, preliminary));
    }
    validateFlags(flags, method, index, rawName, preliminary);
    const canonical = canonicalEntryName(rawName, index, preliminary);
    const attributes = classifyExternalAttributes({
      creator,
      externalAttributes,
      trailingSlash: canonical.trailingSlash,
      index,
      rawName
    });
    const metadata = { creator, ...attributes };
    parseExtraFields(extra, index, rawName, metadata);
    if (attributes.classification === "directory" && (compressedSize !== 0 || uncompressedSize !== 0)) {
      fail("zip_inventory_directory_payload_refused", entryEvidence(index, rawName, metadata));
    }
    if (method === 0 && compressedSize !== uncompressedSize) {
      fail("zip_inventory_size_offset_invalid", entryEvidence(index, rawName, metadata));
    }
    const folded = canonical.normalized.toLowerCase();
    if (normalizedNames.has(canonical.normalized) || foldedNames.has(folded)) {
      fail("zip_inventory_duplicate_entry_refused", entryEvidence(index, rawName, metadata));
    }
    if (localOffsets.has(localOffset)) {
      fail("zip_inventory_entry_type_refused", entryEvidence(index, rawName, {
        ...metadata,
        diagnosticClass: "hardlink_metadata"
      }));
    }
    normalizedNames.add(canonical.normalized);
    foldedNames.add(folded);
    localOffsets.add(localOffset);
    records.push({
      index,
      rawName: Buffer.from(rawName),
      normalizedName: canonical.normalized,
      classification: attributes.classification,
      diagnosticClass: attributes.diagnosticClass,
      creator,
      creatorSystem: attributes.creatorSystem,
      unixModePresent: attributes.unixModePresent,
      externalAttributeCategory: attributes.externalAttributeCategory,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localOffset
    });
    cursor = recordEnd;
  }
  if (cursor !== central.length) fail("zip_inventory_central_directory_invalid");
  return { records, centralOffset };
}

function validateLocalRecords(reader, records, centralOffset) {
  const ordered = [...records].sort((left, right) => left.localOffset - right.localOffset);
  if (ordered[0].localOffset !== 0) fail("zip_inventory_size_offset_invalid");

  for (let position = 0; position < ordered.length; position += 1) {
    const record = ordered[position];
    const metadata = {
      creator: record.creator,
      unixModePresent: record.unixModePresent,
      externalAttributeCategory: record.externalAttributeCategory,
      classification: record.classification,
      diagnosticClass: record.diagnosticClass
    };
    const header = reader.read(record.localOffset, 30);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      fail("zip_inventory_local_header_invalid", entryEvidence(record.index, record.rawName, metadata));
    }
    const localFlags = header.readUInt16LE(6);
    const localMethod = header.readUInt16LE(8);
    const localCrc32 = header.readUInt32LE(14);
    const localCompressedSize = header.readUInt32LE(18);
    const localUncompressedSize = header.readUInt32LE(22);
    const localNameLength = header.readUInt16LE(26);
    const localExtraLength = header.readUInt16LE(28);
    const headerEnd = checkedAdd(record.localOffset, 30 + localNameLength + localExtraLength, "zip_inventory_offset_invalid");
    if (headerEnd > centralOffset) {
      fail("zip_inventory_size_offset_invalid", entryEvidence(record.index, record.rawName, metadata));
    }
    const localVariable = reader.read(record.localOffset + 30, localNameLength + localExtraLength);
    const localName = localVariable.subarray(0, localNameLength);
    const localExtra = localVariable.subarray(localNameLength);
    if (
      !localName.equals(record.rawName) ||
      localFlags !== record.flags ||
      localMethod !== record.method
    ) {
      fail("zip_inventory_local_header_mismatch", entryEvidence(record.index, record.rawName, metadata));
    }
    parseExtraFields(localExtra, record.index, record.rawName, metadata);
    const usesDescriptor = (record.flags & 0x0008) !== 0;
    if (!usesDescriptor && (
      localCrc32 !== record.crc32 ||
      localCompressedSize !== record.compressedSize ||
      localUncompressedSize !== record.uncompressedSize
    )) {
      fail("zip_inventory_local_header_mismatch", entryEvidence(record.index, record.rawName, metadata));
    }
    if (usesDescriptor && !(
      (localCrc32 === 0 || localCrc32 === record.crc32) &&
      (localCompressedSize === 0 || localCompressedSize === record.compressedSize) &&
      (localUncompressedSize === 0 || localUncompressedSize === record.uncompressedSize)
    )) {
      fail("zip_inventory_local_header_mismatch", entryEvidence(record.index, record.rawName, metadata));
    }
    const dataEnd = checkedAdd(headerEnd, record.compressedSize, "zip_inventory_offset_invalid");
    const nextOffset = position + 1 < ordered.length
      ? ordered[position + 1].localOffset
      : centralOffset;
    if (dataEnd > nextOffset) {
      fail("zip_inventory_size_offset_invalid", entryEvidence(record.index, record.rawName, metadata));
    }
    if (!usesDescriptor) {
      if (dataEnd !== nextOffset) {
        fail("zip_inventory_size_offset_invalid", entryEvidence(record.index, record.rawName, metadata));
      }
      continue;
    }
    const descriptorLength = nextOffset - dataEnd;
    if (![12, 16].includes(descriptorLength)) {
      fail("zip_inventory_data_descriptor_invalid", entryEvidence(record.index, record.rawName, metadata));
    }
    const descriptor = reader.read(dataEnd, descriptorLength);
    const valueOffset = descriptorLength === 16 ? 4 : 0;
    if (
      (descriptorLength === 16 && descriptor.readUInt32LE(0) !== DATA_DESCRIPTOR_SIGNATURE) ||
      descriptor.readUInt32LE(valueOffset) !== record.crc32 ||
      descriptor.readUInt32LE(valueOffset + 4) !== record.compressedSize ||
      descriptor.readUInt32LE(valueOffset + 8) !== record.uncompressedSize
    ) {
      fail("zip_inventory_data_descriptor_invalid", entryEvidence(record.index, record.rawName, metadata));
    }
  }
}

function buildResult(records) {
  const creatorSystems = { dos_fat: 0, unix: 0, ntfs: 0 };
  const externalAttributeCategories = Object.create(null);
  let fileCount = 0;
  let directoryCount = 0;
  let unixModePresentCount = 0;
  const diagnosticClasses = Object.fromEntries(
    SAFE_ENTRY_CLASSIFICATIONS.map((classification) => [classification, 0])
  );
  const entries = records.map((record) => {
    creatorSystems[record.creatorSystem] += 1;
    externalAttributeCategories[record.externalAttributeCategory] =
      (externalAttributeCategories[record.externalAttributeCategory] || 0) + 1;
    if (record.unixModePresent) unixModePresentCount += 1;
    if (record.classification === "directory") directoryCount += 1;
    else fileCount += 1;
    diagnosticClasses[record.diagnosticClass] += 1;
    return Object.freeze({
      name: record.normalizedName,
      kind: record.classification,
      diagnosticClass: record.diagnosticClass
    });
  });
  return Object.freeze({
    totalEntries: records.length,
    fileCount,
    directoryCount,
    normalizedClasses: Object.freeze({
      regular_file: fileCount,
      directory: directoryCount
    }),
    creatorSystems: Object.freeze({ ...creatorSystems }),
    unixModePresentCount,
    diagnosticClasses: Object.freeze({ ...diagnosticClasses }),
    externalAttributeCategories: Object.freeze({ ...externalAttributeCategories }),
    entries: Object.freeze(entries)
  });
}

function inspectReader(reader) {
  const { records, centralOffset } = parseCentralDirectory(reader);
  validateLocalRecords(reader, records, centralOffset);
  return buildResult(records);
}

function inspectZipBuffer(buffer) {
  return inspectReader(bufferReader(buffer));
}

function inspectZipFile(archivePath) {
  const reader = fileReader(archivePath);
  try {
    return inspectReader(reader);
  } finally {
    reader.close();
  }
}

module.exports = {
  SAFE_ENTRY_CLASSIFICATIONS,
  ZipInventoryFailure,
  inspectZipBuffer,
  inspectZipFile
};
