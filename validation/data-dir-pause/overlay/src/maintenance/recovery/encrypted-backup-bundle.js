"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Transform, Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const tar = require("tar-stream");
const { SocialPostgresError } = require("./errors");

const BUNDLE_FORMAT = "ia4tube-social-postgresql-encrypted-bundle";
const BUNDLE_FORMAT_VERSION = 2;
const BUNDLE_AAD_VERSION = 2;
const BUNDLE_ALGORITHM = "aes-256-gcm";
const BUNDLE_MAGIC = Buffer.from("IA4TUBE-SOCIAL-BUNDLE\u0000", "ascii");
const HEADER_LENGTH_BYTES = 4;
const MAX_HEADER_BYTES = 4096;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_ARCHIVE_ENTRY_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_BUNDLE_PLAINTEXT_BYTES = 32 * 1024 * 1024 * 1024;
const MIN_EXTRACTION_MARGIN_BYTES = 64 * 1024 * 1024;
const EXTRACTION_MARGIN_PERCENT = 10;
const WORKSPACE_FORMAT = "ia4tube-social-owned-workspace";
const WORKSPACE_FORMAT_VERSION = 1;
const WORKSPACE_ID_BYTES = 16;
const WORKSPACE_MARKER_NAME = ".ia4tube-workspace-owner.json";
const WORKSPACE_PREFIX = ".ia4tube-social-workspace-";
const DEFAULT_STALE_WORKSPACE_AGE_MS = 24 * 60 * 60 * 1000;
const SAFE_ARCHIVE_NAME = /^[a-z0-9][a-z0-9._/-]{0,99}$/;
const SAFE_LABEL = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SAFE_PURPOSE = /^[a-z][a-z0-9-]{0,39}$/;
const WORKSPACE_ID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;

class EncryptedBackupBundleError extends SocialPostgresError {
  constructor(code) {
    super(code, "Bundle criptografado do backup social recusado.");
    this.name = "EncryptedBackupBundleError";
  }
}

function bundleFail(code) {
  throw new EncryptedBackupBundleError(code);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function decodeBundleKey(encoded) {
  if (
    typeof encoded !== "string" ||
    encoded.length !== 44 ||
    !/^[A-Za-z0-9+/]{43}=$/.test(encoded)
  ) {
    bundleFail("backup_bundle_key_invalid");
  }
  const key = Buffer.from(encoded, "base64");
  if (
    key.length !== KEY_BYTES ||
    key.toString("base64") !== encoded
  ) {
    key.fill(0);
    bundleFail("backup_bundle_key_invalid");
  }
  return key;
}

function requireBundleKey(value) {
  if (!Buffer.isBuffer(value) || value.length !== KEY_BYTES) {
    bundleFail("backup_bundle_key_invalid");
  }
  return Buffer.from(value);
}

function requireLabel(value) {
  if (typeof value !== "string" || !SAFE_LABEL.test(value)) {
    bundleFail("backup_bundle_label_invalid");
  }
  return value;
}

function requireFingerprint(value) {
  const fingerprint = String(value || "").toLowerCase();
  if (!SHA256.test(fingerprint)) {
    bundleFail("backup_bundle_source_fingerprint_invalid");
  }
  return fingerprint;
}

function requireArchiveName(value) {
  if (
    typeof value !== "string" ||
    !SAFE_ARCHIVE_NAME.test(value) ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    bundleFail("backup_bundle_archive_name_invalid");
  }
  return value;
}

function requireExpectedNames(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 256) {
    bundleFail("backup_bundle_allowlist_invalid");
  }
  const names = values.map(requireArchiveName);
  if (new Set(names).size !== names.length) {
    bundleFail("backup_bundle_allowlist_invalid");
  }
  return Object.freeze(names);
}

function requireRegularSourcePath(file, fileSystem = fs) {
  const resolved = path.resolve(file);
  let stat;
  try {
    stat = fileSystem.lstatSync(resolved);
  } catch {
    bundleFail("backup_bundle_source_missing");
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !Number.isSafeInteger(stat.size) ||
    stat.size < 1 ||
    stat.size > MAX_ARCHIVE_ENTRY_BYTES
  ) {
    bundleFail("backup_bundle_source_invalid");
  }
  return Object.freeze({ path: resolved, size: stat.size, stat });
}

function sameObjectIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      left.dev === right.dev &&
      left.ino === right.ino
  );
}

function sameFileIdentity(left, right) {
  return sameObjectIdentity(left, right) && left.size === right.size;
}

function sameStableFileIdentity(left, right) {
  return Boolean(
    sameFileIdentity(left, right) &&
      left.mtimeMs === right.mtimeMs &&
      left.ctimeMs === right.ctimeMs
  );
}

function closeDescriptorSafely(descriptor, fileSystem = fs) {
  if (descriptor === undefined) return true;
  try {
    fileSystem.closeSync(descriptor);
    return true;
  } catch (error) {
    return error?.code === "EBADF";
  }
}

function closeDescriptor(descriptor, fileSystem = fs) {
  if (!closeDescriptorSafely(descriptor, fileSystem)) {
    bundleFail("backup_bundle_descriptor_cleanup_failed");
  }
}

function closeSourceEntries(normalized, fileSystem = fs) {
  if (!normalized) return true;
  let failed = false;
  for (const entry of normalized.entries) {
    failed =
      !closeDescriptorSafely(entry.descriptor, fileSystem) || failed;
  }
  return !failed;
}

function openRegularSource(source, fileSystem = fs) {
  let descriptor;
  try {
    descriptor = fileSystem.openSync(
      source.path,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const opened = fileSystem.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      !sameStableFileIdentity(source.stat, opened) ||
      opened.size < 1 ||
      opened.size > MAX_ARCHIVE_ENTRY_BYTES
    ) {
      bundleFail("backup_bundle_source_changed");
    }
    return Object.freeze({
      path: source.path,
      size: opened.size,
      descriptor,
      identity: opened
    });
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        bundleFail("backup_bundle_descriptor_cleanup_failed");
      }
    }
    if (error instanceof EncryptedBackupBundleError) throw error;
    bundleFail("backup_bundle_source_invalid");
  }
}

function normalizeEntries(entries, expectedNames, fileSystem = fs) {
  const allowlist = requireExpectedNames(expectedNames);
  if (!Array.isArray(entries) || entries.length !== allowlist.length) {
    bundleFail("backup_bundle_entries_invalid");
  }
  const inspected = entries.map((entry, index) => {
    const name = requireArchiveName(entry?.name);
    if (name !== allowlist[index]) {
      bundleFail("backup_bundle_entries_invalid");
    }
    return Object.freeze({
      name,
      ...requireRegularSourcePath(entry?.path, fileSystem)
    });
  });
  const tarBytes = inspected.reduce(
    (total, entry) =>
      total + 512 + Math.ceil(entry.size / 512) * 512,
    1024
  );
  if (
    !Number.isSafeInteger(tarBytes) ||
    tarBytes > MAX_BUNDLE_PLAINTEXT_BYTES
  ) {
    bundleFail("backup_bundle_size_limit_exceeded");
  }
  const opened = [];
  try {
    for (const entry of inspected) {
      opened.push(
        Object.freeze({
          name: entry.name,
          ...openRegularSource(entry, fileSystem)
        })
      );
    }
  } catch (error) {
    let cleanupFailed = false;
    for (const entry of opened) {
      cleanupFailed =
        !closeDescriptorSafely(entry.descriptor, fileSystem) ||
        cleanupFailed;
    }
    if (cleanupFailed) {
      bundleFail("backup_bundle_descriptor_cleanup_failed");
    }
    throw error;
  }
  return Object.freeze({
    entries: Object.freeze(opened),
    tarBytes
  });
}

function createHeader({ label, sourceFingerprint, nonce, tarBytes }) {
  if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) {
    bundleFail("backup_bundle_nonce_invalid");
  }
  if (
    !Number.isSafeInteger(tarBytes) ||
    tarBytes < 1024 ||
    tarBytes > MAX_BUNDLE_PLAINTEXT_BYTES
  ) {
    bundleFail("backup_bundle_size_limit_exceeded");
  }
  return Object.freeze({
    aadVersion: BUNDLE_AAD_VERSION,
    algorithm: BUNDLE_ALGORITHM,
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    label: requireLabel(label),
    nonce: nonce.toString("base64"),
    sourceFingerprint: requireFingerprint(sourceFingerprint),
    tarBytes
  });
}

function encodeHeader(header) {
  const bytes = Buffer.from(canonicalJson(header), "utf8");
  if (bytes.length < 2 || bytes.length > MAX_HEADER_BYTES) {
    bundleFail("backup_bundle_header_invalid");
  }
  const length = Buffer.alloc(HEADER_LENGTH_BYTES);
  length.writeUInt32BE(bytes.length);
  const prefix = Buffer.concat([BUNDLE_MAGIC, length, bytes]);
  length.fill(0);
  return Object.freeze({ bytes, prefix });
}

function parseHeaderBytes(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    bundleFail("backup_bundle_header_invalid");
  }
  const expectedKeys = [
    "aadVersion",
    "algorithm",
    "format",
    "formatVersion",
    "label",
    "nonce",
    "sourceFingerprint",
    "tarBytes"
  ];
  if (
    !parsed ||
    Array.isArray(parsed) ||
    typeof parsed !== "object" ||
    Object.keys(parsed).sort().join("\u0000") !==
      expectedKeys.sort().join("\u0000") ||
    parsed.aadVersion !== BUNDLE_AAD_VERSION ||
    parsed.algorithm !== BUNDLE_ALGORITHM ||
    parsed.format !== BUNDLE_FORMAT ||
    parsed.formatVersion !== BUNDLE_FORMAT_VERSION ||
    !Number.isSafeInteger(parsed.tarBytes) ||
    parsed.tarBytes < 1024 ||
    parsed.tarBytes > MAX_BUNDLE_PLAINTEXT_BYTES ||
    Buffer.from(canonicalJson(parsed), "utf8").compare(bytes) !== 0
  ) {
    bundleFail("backup_bundle_header_invalid");
  }
  const nonce = Buffer.from(String(parsed.nonce || ""), "base64");
  if (
    nonce.length !== NONCE_BYTES ||
    nonce.toString("base64") !== parsed.nonce
  ) {
    nonce.fill(0);
    bundleFail("backup_bundle_header_invalid");
  }
  return Object.freeze({
    header: Object.freeze({
      ...parsed,
      label: requireLabel(parsed.label),
      sourceFingerprint: requireFingerprint(parsed.sourceFingerprint)
    }),
    nonce
  });
}

function exactStringEqual(left, right) {
  const leftDigest = crypto.createHash("sha256").update(left).digest();
  const rightDigest = crypto.createHash("sha256").update(right).digest();
  try {
    return crypto.timingSafeEqual(leftDigest, rightDigest);
  } finally {
    leftDigest.fill(0);
    rightDigest.fill(0);
  }
}

function hashPassThrough(hash, byteCounter) {
  return new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      if (byteCounter) byteCounter.size += chunk.length;
      callback(null, chunk);
    }
  });
}

function framingTransform(prefix, cipher) {
  let prefixWritten = false;
  return new Transform({
    transform(chunk, encoding, callback) {
      if (!prefixWritten) {
        prefixWritten = true;
        this.push(prefix);
      }
      this.push(chunk);
      callback();
    },
    flush(callback) {
      try {
        if (!prefixWritten) this.push(prefix);
        this.push(cipher.getAuthTag());
        callback();
      } catch {
        callback(new EncryptedBackupBundleError(
          "backup_bundle_auth_tag_unavailable"
        ));
      }
    }
  });
}

async function appendFileToPack(pack, entry, fileSystem = fs) {
  const target = pack.entry({
    name: entry.name,
    type: "file",
    size: entry.size,
    mode: 0o600,
    uid: 0,
    gid: 0,
    uname: "",
    gname: "",
    mtime: new Date(0)
  });
  const hash = crypto.createHash("sha256");
  const counter = { size: 0 };
  await pipeline(
    fileSystem.createReadStream(entry.path, {
      fd: entry.descriptor,
      autoClose: false,
      start: 0,
      end: entry.size - 1
    }),
    hashPassThrough(hash, counter),
    target
  );
  const after = fileSystem.fstatSync(entry.descriptor);
  if (
    counter.size !== entry.size ||
    !sameStableFileIdentity(entry.identity, after)
  ) {
    bundleFail("backup_bundle_source_changed");
  }
  return Object.freeze({
    name: entry.name,
    size: counter.size,
    sha256: hash.digest("hex")
  });
}

function requireFreshAtomicTarget(outputPath, fileSystem = fs) {
  if (!path.isAbsolute(outputPath)) {
    bundleFail("backup_bundle_output_invalid");
  }
  const finalPath = path.resolve(outputPath);
  const partialPath = `${finalPath}.partial`;
  const directory = path.dirname(finalPath);
  let directoryStat;
  try {
    directoryStat = fileSystem.lstatSync(directory);
  } catch {
    bundleFail("backup_bundle_output_invalid");
  }
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    fileSystem.existsSync(finalPath) ||
    fileSystem.existsSync(partialPath)
  ) {
    bundleFail("backup_bundle_output_not_fresh");
  }
  return Object.freeze({ finalPath, partialPath, directory });
}

function cleanupOwnedPath(file, ownership, fileSystem = fs) {
  if (!ownership.owned) return true;
  try {
    const current = fileSystem.lstatSync(file);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      !sameObjectIdentity(ownership.identity, current)
    ) {
      return false;
    }
    fileSystem.unlinkSync(file);
    ownership.owned = false;
    return !fileSystem.existsSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      ownership.owned = false;
      return true;
    }
    return false;
  }
}

function cleanupAtomicTarget(target, ownership, fileSystem = fs) {
  let failed = false;
  failed =
    !cleanupOwnedPath(
      target.partialPath,
      ownership.partial,
      fileSystem
    ) || failed;
  failed =
    !cleanupOwnedPath(target.finalPath, ownership.final, fileSystem) ||
    failed;
  if (failed) {
    bundleFail("backup_bundle_cleanup_failed");
  }
}

function fsyncDirectoryWhenSupported(directory, fileSystem = fs) {
  let descriptor;
  try {
    descriptor = fileSystem.openSync(directory, fs.constants.O_RDONLY);
    fileSystem.fsyncSync(descriptor);
    return true;
  } catch (error) {
    if (
      ["EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error?.code)
    ) {
      return false;
    }
    bundleFail("backup_bundle_directory_sync_failed");
  } finally {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        bundleFail("backup_bundle_descriptor_cleanup_failed");
      }
    }
  }
}

function freezeCreatedBundle(properties, identity) {
  const result = { ...properties };
  Object.defineProperty(result, "identity", {
    value: identity,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return Object.freeze(result);
}

function cleanupCreatedBundle(bundle, fileSystem = fs) {
  if (
    !bundle ||
    typeof bundle.path !== "string" ||
    !path.isAbsolute(bundle.path) ||
    !bundle.identity
  ) {
    bundleFail("backup_bundle_cleanup_ownership_invalid");
  }
  const ownership = {
    owned: true,
    identity: bundle.identity
  };
  if (!cleanupOwnedPath(bundle.path, ownership, fileSystem)) {
    bundleFail("backup_bundle_cleanup_failed");
  }
  fsyncDirectoryWhenSupported(path.dirname(bundle.path), fileSystem);
  return true;
}

async function createEncryptedBundle({
  entries,
  expectedNames,
  outputPath,
  label,
  sourceFingerprint,
  bundleKey,
  randomBytes = crypto.randomBytes,
  fileSystem = fs
}) {
  const target = requireFreshAtomicTarget(outputPath, fileSystem);
  const key = requireBundleKey(bundleKey);
  const ownership = {
    partial: { owned: false, identity: null },
    final: { owned: false, identity: null }
  };
  let normalized;
  let sourcesClosed = false;
  let nonce;
  let outputDescriptor;
  let output;
  try {
    normalized = normalizeEntries(entries, expectedNames, fileSystem);
    nonce = randomBytes(NONCE_BYTES);
    if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) {
      bundleFail("backup_bundle_nonce_invalid");
    }
    nonce = Buffer.from(nonce);
    const encoded = encodeHeader(
      createHeader({
        label,
        sourceFingerprint,
        nonce,
        tarBytes: normalized.tarBytes
      })
    );
    const cipher = crypto.createCipheriv(BUNDLE_ALGORITHM, key, nonce, {
      authTagLength: AUTH_TAG_BYTES
    });
    cipher.setAAD(encoded.prefix);
    const tarHash = crypto.createHash("sha256");
    const tarCounter = { size: 0 };
    const containerHash = crypto.createHash("sha256");
    const containerCounter = { size: 0 };
    const pack = tar.pack();
    outputDescriptor = fileSystem.openSync(
      target.partialPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL,
      0o600
    );
    ownership.partial.identity =
      fileSystem.fstatSync(outputDescriptor);
    ownership.partial.owned = true;
    output = fileSystem.createWriteStream(target.partialPath, {
      fd: outputDescriptor,
      autoClose: false
    });
    const stream = pipeline(
      pack,
      hashPassThrough(tarHash, tarCounter),
      cipher,
      framingTransform(encoded.prefix, cipher),
      hashPassThrough(containerHash, containerCounter),
      output
    );
    const entryEvidence = [];
    try {
      for (const entry of normalized.entries) {
        entryEvidence.push(
          await appendFileToPack(pack, entry, fileSystem)
        );
      }
      pack.finalize();
      await stream;
    } catch (error) {
      pack.destroy(error);
      try {
        await stream;
      } catch {
        // The stable bundle error below is authoritative.
      }
      throw error;
    }
    if (tarCounter.size !== normalized.tarBytes) {
      bundleFail("backup_bundle_tar_size_mismatch");
    }
    if (!closeSourceEntries(normalized, fileSystem)) {
      bundleFail("backup_bundle_descriptor_cleanup_failed");
    }
    sourcesClosed = true;
    fileSystem.fchmodSync(outputDescriptor, 0o600);
    fileSystem.fsyncSync(outputDescriptor);
    const completedIdentity = fileSystem.fstatSync(outputDescriptor);
    if (
      !sameObjectIdentity(
        ownership.partial.identity,
        completedIdentity
      ) ||
      completedIdentity.size !== containerCounter.size
    ) {
      bundleFail("backup_bundle_output_identity_changed");
    }
    ownership.partial.identity = completedIdentity;
    fileSystem.closeSync(outputDescriptor);
    outputDescriptor = undefined;
    fileSystem.linkSync(target.partialPath, target.finalPath);
    ownership.final.identity = completedIdentity;
    ownership.final.owned = true;
    if (
      !cleanupOwnedPath(
        target.partialPath,
        ownership.partial,
        fileSystem
      )
    ) {
      bundleFail("backup_bundle_cleanup_failed");
    }
    const bundleDirectoryFsyncConfirmed =
      fsyncDirectoryWhenSupported(target.directory, fileSystem);
    return freezeCreatedBundle({
      path: target.finalPath,
      size: containerCounter.size,
      sha256: containerHash.digest("hex"),
      tarSha256: tarHash.digest("hex"),
      bundleDirectoryFsyncConfirmed,
      entries: Object.freeze(entryEvidence)
    }, completedIdentity);
  } catch (error) {
    let descriptorCleanupFailed = false;
    let outputDescriptorCleanupFailed = false;
    if (normalized && !sourcesClosed) {
      sourcesClosed = true;
      descriptorCleanupFailed =
        !closeSourceEntries(normalized, fileSystem);
    }
    if (outputDescriptor !== undefined) {
      if (
        closeDescriptorSafely(outputDescriptor, fileSystem)
      ) {
        outputDescriptor = undefined;
      } else {
        outputDescriptorCleanupFailed = true;
      }
    }
    try {
      cleanupAtomicTarget(target, ownership, fileSystem);
    } catch {
      throw new EncryptedBackupBundleError(
        "backup_bundle_cleanup_failed"
      );
    }
    if (descriptorCleanupFailed || outputDescriptorCleanupFailed) {
      throw new EncryptedBackupBundleError(
        "backup_bundle_descriptor_cleanup_failed"
      );
    }
    if (error instanceof EncryptedBackupBundleError) throw error;
    bundleFail("backup_bundle_creation_failed");
  } finally {
    if (outputDescriptor !== undefined) {
      closeDescriptorSafely(outputDescriptor, fileSystem);
    }
    if (normalized && !sourcesClosed) {
      closeSourceEntries(normalized, fileSystem);
    }
    key.fill(0);
    if (nonce) nonce.fill(0);
  }
}

function readExactly(fileSystem, descriptor, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const read = fileSystem.readSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
      position + offset
    );
    if (read === 0) bundleFail("backup_bundle_truncated");
    offset += read;
  }
}

function openInspectedContainer(
  containerPath,
  { expectedLabel, expectedSourceFingerprint } = {},
  fileSystem = fs
) {
  const resolved = path.resolve(containerPath);
  let descriptor;
  let nonce;
  try {
    const before = fileSystem.lstatSync(resolved);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !Number.isSafeInteger(before.size) ||
      before.size <=
        BUNDLE_MAGIC.length + HEADER_LENGTH_BYTES + AUTH_TAG_BYTES
    ) {
      bundleFail("backup_bundle_container_invalid");
    }
    descriptor = fileSystem.openSync(
      resolved,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const stat = fileSystem.fstatSync(descriptor);
    if (!stat.isFile() || !sameStableFileIdentity(before, stat)) {
      bundleFail("backup_bundle_container_changed");
    }
    const leading = Buffer.alloc(
      BUNDLE_MAGIC.length + HEADER_LENGTH_BYTES
    );
    readExactly(fileSystem, descriptor, leading, 0);
    if (
      leading.subarray(0, BUNDLE_MAGIC.length).compare(BUNDLE_MAGIC) !== 0
    ) {
      bundleFail("backup_bundle_magic_invalid");
    }
    const headerLength = leading.readUInt32BE(BUNDLE_MAGIC.length);
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) {
      bundleFail("backup_bundle_header_invalid");
    }
    const headerBytes = Buffer.alloc(headerLength);
    readExactly(
      fileSystem,
      descriptor,
      headerBytes,
      BUNDLE_MAGIC.length + HEADER_LENGTH_BYTES
    );
    const parsed = parseHeaderBytes(headerBytes);
    nonce = parsed.nonce;
    const prefix = Buffer.concat([leading, headerBytes]);
    const ciphertextStart = prefix.length;
    const ciphertextBytes =
      stat.size - ciphertextStart - AUTH_TAG_BYTES;
    if (
      ciphertextBytes < 1 ||
      ciphertextBytes > MAX_BUNDLE_PLAINTEXT_BYTES ||
      ciphertextBytes !== parsed.header.tarBytes
    ) {
      bundleFail("backup_bundle_tar_size_mismatch");
    }
    const authTag = Buffer.alloc(AUTH_TAG_BYTES);
    readExactly(
      fileSystem,
      descriptor,
      authTag,
      stat.size - AUTH_TAG_BYTES
    );
    if (
      expectedLabel !== undefined &&
      !exactStringEqual(parsed.header.label, requireLabel(expectedLabel))
    ) {
      bundleFail("backup_bundle_label_mismatch");
    }
    if (
      expectedSourceFingerprint !== undefined &&
      !exactStringEqual(
        parsed.header.sourceFingerprint,
        requireFingerprint(expectedSourceFingerprint)
      )
    ) {
      bundleFail("backup_bundle_source_fingerprint_mismatch");
    }
    const result = Object.freeze({
      path: resolved,
      size: stat.size,
      header: parsed.header,
      prefix,
      nonce: Buffer.from(nonce),
      authTag,
      descriptor,
      identity: stat,
      ciphertextStart,
      ciphertextEnd: stat.size - AUTH_TAG_BYTES - 1
    });
    nonce.fill(0);
    descriptor = undefined;
    return result;
  } catch (error) {
    if (error instanceof EncryptedBackupBundleError) throw error;
    bundleFail("backup_bundle_container_invalid");
  } finally {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        bundleFail("backup_bundle_descriptor_cleanup_failed");
      }
    }
    if (nonce) nonce.fill(0);
  }
}

function inspectContainer(
  containerPath,
  expectations = {},
  fileSystem = fs
) {
  const container = openInspectedContainer(
    containerPath,
    expectations,
    fileSystem
  );
  try {
    return Object.freeze({
      path: container.path,
      size: container.size,
      header: container.header,
      prefix: Buffer.from(container.prefix),
      nonce: Buffer.from(container.nonce),
      authTag: Buffer.from(container.authTag),
      ciphertextStart: container.ciphertextStart,
      ciphertextEnd: container.ciphertextEnd
    });
  } finally {
    container.prefix.fill(0);
    container.nonce.fill(0);
    container.authTag.fill(0);
    closeDescriptor(container.descriptor, fileSystem);
  }
}

function requireWorkspacePurpose(value) {
  if (typeof value !== "string" || !SAFE_PURPOSE.test(value)) {
    bundleFail("backup_bundle_workspace_purpose_invalid");
  }
  return value;
}

function requireWorkspaceRoot(root, fileSystem = fs) {
  const resolved = path.resolve(root);
  let stat;
  let real;
  try {
    stat = fileSystem.lstatSync(resolved);
    real = fileSystem.realpathSync(resolved);
  } catch {
    bundleFail("backup_bundle_work_directory_invalid");
  }
  const normalizedResolved =
    process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const normalizedReal =
    process.platform === "win32"
      ? path.resolve(real).toLowerCase()
      : path.resolve(real);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    normalizedResolved !== normalizedReal
  ) {
    bundleFail("backup_bundle_work_directory_invalid");
  }
  return Object.freeze({ path: resolved, identity: stat });
}

function workspaceMarker({ id, purpose, ownerPid, ownerUid, createdAt }) {
  if (!WORKSPACE_ID.test(id)) {
    bundleFail("backup_bundle_workspace_id_invalid");
  }
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) {
    bundleFail("backup_bundle_workspace_marker_invalid");
  }
  if (
    ownerUid !== null &&
    (!Number.isSafeInteger(ownerUid) || ownerUid < 0)
  ) {
    bundleFail("backup_bundle_workspace_marker_invalid");
  }
  if (
    typeof createdAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  ) {
    bundleFail("backup_bundle_workspace_marker_invalid");
  }
  return Object.freeze({
    createdAt,
    format: WORKSPACE_FORMAT,
    formatVersion: WORKSPACE_FORMAT_VERSION,
    id,
    ownerPid,
    ownerUid,
    purpose: requireWorkspacePurpose(purpose)
  });
}

function markerText(marker) {
  return `${canonicalJson(marker)}\n`;
}

function workspacePrefix(purpose) {
  return `${WORKSPACE_PREFIX}${requireWorkspacePurpose(purpose)}-`;
}

function validateWorkspaceTree(directory, fileSystem = fs) {
  let entries;
  try {
    entries = fileSystem.readdirSync(directory, {
      withFileTypes: true
    });
  } catch {
    bundleFail("backup_bundle_workspace_tree_invalid");
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const relative = path.relative(directory, target);
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      bundleFail("backup_bundle_workspace_tree_invalid");
    }
    let stat;
    try {
      stat = fileSystem.lstatSync(target);
    } catch {
      bundleFail("backup_bundle_workspace_tree_invalid");
    }
    if (stat.isSymbolicLink()) {
      bundleFail("backup_bundle_workspace_tree_invalid");
    }
    if (stat.isDirectory()) {
      validateWorkspaceTree(target, fileSystem);
    } else if (!stat.isFile()) {
      bundleFail("backup_bundle_workspace_tree_invalid");
    }
  }
  return true;
}

function inspectOwnedWorkspace(
  directory,
  { root, purpose, expectedIdentity } = {},
  fileSystem = fs
) {
  const workspaceRoot = requireWorkspaceRoot(root, fileSystem);
  const checkedPurpose = requireWorkspacePurpose(purpose);
  const resolved = path.resolve(directory);
  const relative = path.relative(workspaceRoot.path, resolved);
  const prefix = workspacePrefix(checkedPurpose);
  const name = path.basename(resolved);
  const id = name.startsWith(prefix) ? name.slice(prefix.length) : "";
  if (
    !relative ||
    relative.includes(path.sep) ||
    path.isAbsolute(relative) ||
    !WORKSPACE_ID.test(id)
  ) {
    bundleFail("backup_bundle_workspace_invalid");
  }
  let stat;
  try {
    stat = fileSystem.lstatSync(resolved);
  } catch {
    bundleFail("backup_bundle_workspace_invalid");
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (expectedIdentity &&
      !sameObjectIdentity(expectedIdentity, stat))
  ) {
    bundleFail("backup_bundle_workspace_invalid");
  }
  const markerPath = path.join(resolved, WORKSPACE_MARKER_NAME);
  let markerStat;
  let markerDescriptor;
  let text;
  try {
    markerStat = fileSystem.lstatSync(markerPath);
    if (
      !markerStat.isFile() ||
      markerStat.isSymbolicLink() ||
      markerStat.size < 2 ||
      markerStat.size > 512
    ) {
      bundleFail("backup_bundle_workspace_marker_invalid");
    }
    markerDescriptor = fileSystem.openSync(
      markerPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const openedMarker = fileSystem.fstatSync(markerDescriptor);
    if (!sameStableFileIdentity(markerStat, openedMarker)) {
      bundleFail("backup_bundle_workspace_marker_invalid");
    }
    const markerBytes = Buffer.alloc(openedMarker.size);
    readExactly(fileSystem, markerDescriptor, markerBytes, 0);
    const afterRead = fileSystem.fstatSync(markerDescriptor);
    if (!sameStableFileIdentity(openedMarker, afterRead)) {
      markerBytes.fill(0);
      bundleFail("backup_bundle_workspace_marker_invalid");
    }
    text = markerBytes.toString("utf8");
    markerBytes.fill(0);
  } catch (error) {
    if (error instanceof EncryptedBackupBundleError) throw error;
    bundleFail("backup_bundle_workspace_marker_invalid");
  } finally {
    if (markerDescriptor !== undefined) {
      if (!closeDescriptorSafely(markerDescriptor, fileSystem)) {
        bundleFail("backup_bundle_descriptor_cleanup_failed");
      }
    }
  }
  let marker;
  try {
    marker = JSON.parse(text);
  } catch {
    bundleFail("backup_bundle_workspace_marker_invalid");
  }
  const expectedKeys = [
    "createdAt",
    "format",
    "formatVersion",
    "id",
    "ownerPid",
    "ownerUid",
    "purpose"
  ];
  if (
    !marker ||
    Array.isArray(marker) ||
    typeof marker !== "object" ||
    Object.keys(marker).sort().join("\u0000") !==
      expectedKeys.sort().join("\u0000")
  ) {
    bundleFail("backup_bundle_workspace_marker_invalid");
  }
  const expected = workspaceMarker({
    id,
    purpose: checkedPurpose,
    ownerPid: marker.ownerPid,
    ownerUid: marker.ownerUid,
    createdAt: marker.createdAt
  });
  if (
    markerText(expected) !== text ||
    canonicalJson(marker) !== canonicalJson(expected)
  ) {
    bundleFail("backup_bundle_workspace_marker_invalid");
  }
  const currentUid =
    typeof process.getuid === "function" ? process.getuid() : null;
  if (
    expected.ownerUid !== currentUid ||
    (process.platform !== "win32" &&
      ((stat.mode & 0o077) !== 0 ||
        (markerStat.mode & 0o077) !== 0))
  ) {
    bundleFail("backup_bundle_workspace_permissions_invalid");
  }
  validateWorkspaceTree(resolved, fileSystem);
  return Object.freeze({
    path: resolved,
    root: workspaceRoot.path,
    purpose: checkedPurpose,
    id,
    markerPath,
    identity: stat,
    createdAt: expected.createdAt,
    ownerPid: expected.ownerPid,
    ownerUid: expected.ownerUid
  });
}

function createOwnedWorkspace({
  root,
  purpose,
  id: requestedId,
  randomBytes = crypto.randomBytes,
  now = () => new Date(),
  fileSystem = fs
}) {
  const workspaceRoot = requireWorkspaceRoot(root, fileSystem);
  const checkedPurpose = requireWorkspacePurpose(purpose);
  let workspace;
  let createdPath;
  let createdIdentity;
  let markerDescriptor;
  try {
    let id = requestedId;
    if (id === undefined) {
      const generated = randomBytes(WORKSPACE_ID_BYTES);
      if (
        !Buffer.isBuffer(generated) ||
        generated.length !== WORKSPACE_ID_BYTES
      ) {
        bundleFail("backup_bundle_workspace_id_invalid");
      }
      const idBytes = Buffer.from(generated);
      id = idBytes.toString("hex");
      idBytes.fill(0);
    }
    if (!WORKSPACE_ID.test(id)) {
      bundleFail("backup_bundle_workspace_id_invalid");
    }
    const timestamp = now();
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
      bundleFail("backup_bundle_workspace_marker_invalid");
    }
    const directory = path.join(
      workspaceRoot.path,
      `${workspacePrefix(checkedPurpose)}${id}`
    );
    fileSystem.mkdirSync(directory, {
      recursive: false,
      mode: 0o700
    });
    createdPath = directory;
    const identity = fileSystem.lstatSync(directory);
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
      bundleFail("backup_bundle_workspace_invalid");
    }
    createdIdentity = identity;
    const markerPath = path.join(directory, WORKSPACE_MARKER_NAME);
    markerDescriptor = fileSystem.openSync(
      markerPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL,
      0o600
    );
    fileSystem.writeFileSync(
      markerDescriptor,
      markerText(workspaceMarker({
        id,
        purpose: checkedPurpose,
        ownerPid: process.pid,
        ownerUid:
          typeof process.getuid === "function" ? process.getuid() : null,
        createdAt: timestamp.toISOString()
      })),
      "utf8"
    );
    fileSystem.fchmodSync(markerDescriptor, 0o600);
    fileSystem.fsyncSync(markerDescriptor);
    fileSystem.closeSync(markerDescriptor);
    markerDescriptor = undefined;
    fileSystem.chmodSync(directory, 0o700);
    fsyncDirectoryWhenSupported(directory, fileSystem);
    fsyncDirectoryWhenSupported(workspaceRoot.path, fileSystem);
    workspace = inspectOwnedWorkspace(
      directory,
      {
        root: workspaceRoot.path,
        purpose: checkedPurpose,
        expectedIdentity: identity
      },
      fileSystem
    );
    return workspace;
  } catch (error) {
    let descriptorCleanupFailed = false;
    let workspaceCleanupFailed = false;
    if (markerDescriptor !== undefined) {
      if (!closeDescriptorSafely(markerDescriptor, fileSystem)) {
        descriptorCleanupFailed = true;
      }
    }
    if (createdPath && createdIdentity) {
      try {
        const current = fileSystem.lstatSync(createdPath);
        if (
          !current.isSymbolicLink() &&
          current.isDirectory() &&
          sameObjectIdentity(createdIdentity, current)
        ) {
          validateWorkspaceTree(createdPath, fileSystem);
          fileSystem.rmSync(createdPath, {
            recursive: true,
            force: false
          });
        }
      } catch {
        workspaceCleanupFailed = true;
      }
    }
    if (workspaceCleanupFailed) {
      bundleFail("backup_bundle_cleanup_failed");
    }
    if (descriptorCleanupFailed) {
      bundleFail("backup_bundle_descriptor_cleanup_failed");
    }
    if (error instanceof EncryptedBackupBundleError) throw error;
    bundleFail("backup_bundle_workspace_creation_failed");
  }
}

function cleanupOwnedWorkspace(workspace, fileSystem = fs) {
  const inspected = inspectOwnedWorkspace(
    workspace?.path,
    {
      root: workspace?.root,
      purpose: workspace?.purpose,
      expectedIdentity: workspace?.identity
    },
    fileSystem
  );
  try {
    fileSystem.rmSync(inspected.path, {
      recursive: true,
      force: false
    });
    if (fileSystem.existsSync(inspected.path)) {
      bundleFail("backup_bundle_cleanup_failed");
    }
    fsyncDirectoryWhenSupported(inspected.root, fileSystem);
    return true;
  } catch (error) {
    if (error instanceof EncryptedBackupBundleError) throw error;
    bundleFail("backup_bundle_cleanup_failed");
  }
}

function recoverOwnedWorkspaces({
  root,
  purpose,
  minimumAgeMs = DEFAULT_STALE_WORKSPACE_AGE_MS,
  now = () => Date.now(),
  isProcessAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      return true;
    }
  },
  fileSystem = fs
}) {
  const workspaceRoot = requireWorkspaceRoot(root, fileSystem);
  const checkedPurpose = requireWorkspacePurpose(purpose);
  const prefix = workspacePrefix(checkedPurpose);
  if (
    !Number.isSafeInteger(minimumAgeMs) ||
    minimumAgeMs < 0 ||
    typeof now !== "function" ||
    typeof isProcessAlive !== "function"
  ) {
    bundleFail("backup_bundle_workspace_recovery_invalid");
  }
  const currentTime = now();
  if (!Number.isSafeInteger(currentTime) || currentTime < 0) {
    bundleFail("backup_bundle_workspace_recovery_invalid");
  }
  let names;
  try {
    names = fileSystem
      .readdirSync(workspaceRoot.path)
      .filter((name) => name.startsWith(prefix))
      .sort();
  } catch {
    bundleFail("backup_bundle_workspace_recovery_failed");
  }
  for (const name of names) {
    const id = name.slice(prefix.length);
    if (!WORKSPACE_ID.test(id)) {
      bundleFail("backup_bundle_workspace_recovery_blocked");
    }
    const inspected = inspectOwnedWorkspace(
      path.join(workspaceRoot.path, name),
      { root: workspaceRoot.path, purpose: checkedPurpose },
      fileSystem
    );
    const createdAt = Date.parse(inspected.createdAt);
    if (
      !Number.isFinite(createdAt) ||
      currentTime - createdAt < minimumAgeMs ||
      isProcessAlive(inspected.ownerPid)
    ) {
      bundleFail("backup_bundle_workspace_recovery_deferred");
    }
    cleanupOwnedWorkspace(inspected, fileSystem);
  }
  return Object.freeze({ recovered: names.length });
}

function validateTarHeader(header, allowlist, seen) {
  const name = requireArchiveName(header?.name);
  if (
    !allowlist.has(name) ||
    seen.has(name) ||
    header.type !== "file" ||
    Boolean(header.linkname) ||
    !Number.isSafeInteger(header.size) ||
    header.size < 1 ||
    header.size > MAX_ARCHIVE_ENTRY_BYTES
  ) {
    bundleFail("backup_bundle_tar_entry_invalid");
  }
  return name;
}

function assertContainerIdentity(container, fileSystem = fs) {
  let current;
  try {
    current = fileSystem.fstatSync(container.descriptor);
  } catch {
    bundleFail("backup_bundle_container_changed");
  }
  if (
    !current.isFile() ||
    !sameStableFileIdentity(container.identity, current)
  ) {
    bundleFail("backup_bundle_container_changed");
  }
  return true;
}

function createContainerReadStream(container, fileSystem = fs) {
  return fileSystem.createReadStream(container.path, {
    fd: container.descriptor,
    autoClose: false,
    start: container.ciphertextStart,
    end: container.ciphertextEnd
  });
}

function createBundleDecipher(container, key) {
  const decipher = crypto.createDecipheriv(
    BUNDLE_ALGORITHM,
    key,
    container.nonce,
    { authTagLength: AUTH_TAG_BYTES }
  );
  decipher.setAAD(container.prefix);
  decipher.setAuthTag(container.authTag);
  return decipher;
}

async function authenticateContainer(container, key, fileSystem = fs) {
  const hash = crypto.createHash("sha256");
  const counter = { size: 0 };
  const discard = new Writable({
    write(chunk, encoding, callback) {
      callback();
    }
  });
  try {
    await pipeline(
      createContainerReadStream(container, fileSystem),
      createBundleDecipher(container, key),
      hashPassThrough(hash, counter),
      discard
    );
  } catch {
    bundleFail("backup_bundle_authentication_failed");
  }
  if (counter.size !== container.header.tarBytes) {
    bundleFail("backup_bundle_tar_size_mismatch");
  }
  assertContainerIdentity(container, fileSystem);
  return Object.freeze({
    size: counter.size,
    sha256: hash.digest("hex")
  });
}

function requireExtractionCapacity(
  directory,
  tarBytes,
  fileSystem = fs
) {
  if (
    !Number.isSafeInteger(tarBytes) ||
    tarBytes < 1024 ||
    tarBytes > MAX_BUNDLE_PLAINTEXT_BYTES ||
    typeof fileSystem.statfsSync !== "function"
  ) {
    bundleFail("backup_bundle_capacity_check_failed");
  }
  let stat;
  try {
    stat = fileSystem.statfsSync(directory);
  } catch {
    bundleFail("backup_bundle_capacity_check_failed");
  }
  let available;
  try {
    const blocks = BigInt(stat.bavail);
    const blockSize = BigInt(stat.bsize);
    if (blocks < 0n || blockSize < 1n) {
      bundleFail("backup_bundle_capacity_check_failed");
    }
    available = blocks * blockSize;
  } catch (error) {
    if (error instanceof EncryptedBackupBundleError) throw error;
    bundleFail("backup_bundle_capacity_check_failed");
  }
  const required = BigInt(tarBytes);
  const percentage =
    (required * BigInt(EXTRACTION_MARGIN_PERCENT) + 99n) / 100n;
  const margin =
    percentage > BigInt(MIN_EXTRACTION_MARGIN_BYTES)
      ? percentage
      : BigInt(MIN_EXTRACTION_MARGIN_BYTES);
  if (available < required + margin) {
    bundleFail("backup_bundle_space_insufficient");
  }
  return true;
}

async function extractTarStream({
  readable,
  transforms = [],
  expectedNames,
  destinationDirectory,
  fileSystem = fs
}) {
  if (!Array.isArray(transforms)) {
    bundleFail("backup_bundle_extraction_transform_invalid");
  }
  const names = requireExpectedNames(expectedNames);
  const allowlist = new Set(names);
  const seen = new Set();
  const files = new Map();
  const extract = tar.extract();
  const ingestion = pipeline(readable, ...transforms, extract);
  let entryFailure;
  let declaredTarBytes = 1024;
  try {
    for await (const stream of extract) {
      const header = stream.header;
      const name = validateTarHeader(header, allowlist, seen);
      declaredTarBytes +=
        512 + Math.ceil(header.size / 512) * 512;
      if (
        !Number.isSafeInteger(declaredTarBytes) ||
        declaredTarBytes > MAX_BUNDLE_PLAINTEXT_BYTES
      ) {
        bundleFail("backup_bundle_size_limit_exceeded");
      }
      const destination = path.join(
        destinationDirectory,
        ...name.split("/")
      );
      const relative = path.relative(destinationDirectory, destination);
      if (
        !relative ||
        relative.startsWith("..") ||
        path.isAbsolute(relative)
      ) {
        bundleFail("backup_bundle_tar_entry_invalid");
      }
      fileSystem.mkdirSync(path.dirname(destination), {
        recursive: true,
        mode: 0o700
      });
      const hash = crypto.createHash("sha256");
      const byteCounter = { size: 0 };
      try {
        await pipeline(
          stream,
          hashPassThrough(hash, byteCounter),
          fileSystem.createWriteStream(destination, {
            flags: "wx",
            mode: 0o600
          })
        );
      } catch {
        bundleFail("backup_bundle_extraction_failed");
      }
      if (byteCounter.size !== header.size) {
        bundleFail("backup_bundle_tar_entry_invalid");
      }
      fileSystem.chmodSync(destination, 0o600);
      seen.add(name);
      files.set(
        name,
        Object.freeze({
          name,
          path: destination,
          size: byteCounter.size,
          sha256: hash.digest("hex")
        })
      );
    }
    await ingestion;
  } catch (error) {
    entryFailure =
      error instanceof EncryptedBackupBundleError
        ? error
        : new EncryptedBackupBundleError(
            transforms.length > 0
              ? "backup_bundle_authentication_failed"
              : "backup_bundle_extraction_failed"
          );
    extract.destroy();
    try {
      await ingestion;
    } catch {
      // The stable entry/authentication error below is authoritative.
    }
    throw entryFailure;
  }
  if (
    seen.size !== names.length ||
    names.some((name) => !seen.has(name))
  ) {
    bundleFail("backup_bundle_allowlist_incomplete");
  }
  return Object.freeze({
    files: Object.freeze(names.map((name) => files.get(name))),
    tarBytes: declaredTarBytes
  });
}

async function withExtractedEncryptedBundle({
  containerPath,
  expectedNames,
  expectedLabel,
  expectedSourceFingerprint,
  workDirectory,
  bundleKey,
  operation,
  workspacePurpose = "restore",
  fileSystem = fs
}) {
  if (typeof operation !== "function") {
    bundleFail("backup_bundle_operation_required");
  }
  const names = requireExpectedNames(expectedNames);
  const root = requireWorkspaceRoot(workDirectory, fileSystem).path;
  const purpose = requireWorkspacePurpose(workspacePurpose);
  const key = requireBundleKey(bundleKey);
  let workspace;
  let container;
  try {
    recoverOwnedWorkspaces({
      root,
      purpose,
      fileSystem
    });
    let extracted;
    try {
      container = openInspectedContainer(
        containerPath,
        { expectedLabel, expectedSourceFingerprint },
        fileSystem
      );
      const authenticated = await authenticateContainer(
        container,
        key,
        fileSystem
      );
      requireExtractionCapacity(
        root,
        container.header.tarBytes,
        fileSystem
      );
      workspace = createOwnedWorkspace({
        root,
        purpose,
        fileSystem
      });
      const decipher = crypto.createDecipheriv(
        BUNDLE_ALGORITHM,
        key,
        container.nonce,
        { authTagLength: AUTH_TAG_BYTES }
      );
      decipher.setAAD(container.prefix);
      decipher.setAuthTag(container.authTag);
      const secondHash = crypto.createHash("sha256");
      const secondCounter = { size: 0 };
      extracted = await extractTarStream({
        readable: createContainerReadStream(container, fileSystem),
        transforms: [
          decipher,
          hashPassThrough(secondHash, secondCounter)
        ],
        expectedNames: names,
        destinationDirectory: workspace.path,
        fileSystem
      });
      const secondSha256 = secondHash.digest("hex");
      if (
        secondCounter.size !== authenticated.size ||
        secondCounter.size !== container.header.tarBytes ||
        extracted.tarBytes !== container.header.tarBytes ||
        !exactStringEqual(secondSha256, authenticated.sha256)
      ) {
        bundleFail("backup_bundle_second_pass_mismatch");
      }
      assertContainerIdentity(container, fileSystem);
    } catch (error) {
      if (error instanceof EncryptedBackupBundleError) throw error;
      bundleFail("backup_bundle_authentication_failed");
    }
    return await operation(
      Object.freeze({
        directory: workspace.path,
        header: container.header,
        files: extracted.files
      })
    );
  } finally {
    key.fill(0);
    let descriptorCleanupFailed = false;
    let workspaceCleanupError;
    if (container) {
      container.nonce.fill(0);
      container.authTag.fill(0);
      container.prefix.fill(0);
      if (
        !closeDescriptorSafely(container.descriptor, fileSystem)
      ) {
        descriptorCleanupFailed = true;
      }
    }
    if (workspace) {
      try {
        cleanupOwnedWorkspace(workspace, fileSystem);
      } catch (error) {
        workspaceCleanupError = error;
      }
    }
    if (workspaceCleanupError) {
      throw workspaceCleanupError;
    }
    if (descriptorCleanupFailed) {
      bundleFail("backup_bundle_descriptor_cleanup_failed");
    }
  }
}

function compareEntryEvidence(expected, actual) {
  if (
    !Array.isArray(expected) ||
    !Array.isArray(actual) ||
    expected.length !== actual.length
  ) {
    bundleFail("backup_bundle_verification_failed");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (
      left?.name !== right?.name ||
      left?.size !== right?.size ||
      !SHA256.test(String(left?.sha256 || "")) ||
      !SHA256.test(String(right?.sha256 || "")) ||
      !crypto.timingSafeEqual(
        Buffer.from(left.sha256, "hex"),
        Buffer.from(right.sha256, "hex")
      )
    ) {
      bundleFail("backup_bundle_verification_failed");
    }
  }
  return true;
}

module.exports = {
  AUTH_TAG_BYTES,
  BUNDLE_AAD_VERSION,
  BUNDLE_ALGORITHM,
  BUNDLE_FORMAT,
  BUNDLE_FORMAT_VERSION,
  BUNDLE_MAGIC,
  EncryptedBackupBundleError,
  HEADER_LENGTH_BYTES,
  KEY_BYTES,
  MAX_ARCHIVE_ENTRY_BYTES,
  MAX_BUNDLE_PLAINTEXT_BYTES,
  MIN_EXTRACTION_MARGIN_BYTES,
  NONCE_BYTES,
  canonicalJson,
  cleanupCreatedBundle,
  cleanupOwnedWorkspace,
  compareEntryEvidence,
  createEncryptedBundle,
  createOwnedWorkspace,
  decodeBundleKey,
  extractTarStream,
  inspectContainer,
  recoverOwnedWorkspaces,
  requireArchiveName,
  requireExtractionCapacity,
  withExtractedEncryptedBundle
};
