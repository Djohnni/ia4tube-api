"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Readable } = require("node:stream");
const { once } = require("node:events");
const test = require("node:test");
const tar = require("tar-stream");
const { SocialPostgresError } = require(
  "../src/persistence/postgres/errors"
);
const {
  BUNDLE_AAD_VERSION,
  BUNDLE_FORMAT_VERSION,
  cleanupCreatedBundle,
  compareEntryEvidence,
  createOwnedWorkspace,
  createEncryptedBundle,
  decodeBundleKey,
  extractTarStream,
  inspectContainer,
  MAX_ARCHIVE_ENTRY_BYTES,
  recoverOwnedWorkspaces,
  withExtractedEncryptedBundle
} = require("../src/persistence/postgres/encrypted-backup-bundle");

const SOURCE_FINGERPRINT = "a".repeat(64);
const LABEL = "synthetic-2b0";
const NAMES = Object.freeze(["00-manifest.json", "01-schema.dump"]);

function temporaryDirectory(t, prefix = "ia4tube-encrypted-bundle-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function syntheticKey(fill = 7) {
  return Buffer.alloc(32, fill);
}

async function createFixture(t) {
  const root = temporaryDirectory(t);
  const sourceDirectory = path.join(root, "source");
  const workDirectory = path.join(root, "work");
  fs.mkdirSync(sourceDirectory);
  fs.mkdirSync(workDirectory);
  const entries = NAMES.map((name, index) => {
    const file = path.join(sourceDirectory, `source-${index}.bin`);
    fs.writeFileSync(
      file,
      index === 0
        ? "{\"kind\":\"synthetic-manifest\"}\n"
        : Buffer.from("synthetic schema archive\n", "utf8")
    );
    return { name, path: file };
  });
  const outputPath = path.join(root, "synthetic.ia4sb");
  const key = syntheticKey();
  const created = await createEncryptedBundle({
    entries,
    expectedNames: NAMES,
    outputPath,
    label: LABEL,
    sourceFingerprint: SOURCE_FINGERPRINT,
    bundleKey: key
  });
  return {
    root,
    workDirectory,
    entries,
    outputPath,
    key,
    created
  };
}

async function tarBuffer(entries) {
  const pack = tar.pack();
  const chunks = [];
  pack.on("data", (chunk) => chunks.push(chunk));
  const ended = once(pack, "end");
  for (const entry of entries) {
    pack.entry(
      {
        name: entry.name,
        type: entry.type || "file",
        linkname: entry.linkname,
        size:
          entry.type && entry.type !== "file"
            ? 0
            : Buffer.byteLength(entry.content || "")
      },
      entry.type && entry.type !== "file"
        ? undefined
        : Buffer.from(entry.content || "")
    );
  }
  pack.finalize();
  await ended;
  return Buffer.concat(chunks);
}

function temporaryExtractionDirectories(workDirectory) {
  return fs
    .readdirSync(workDirectory)
    .filter((name) =>
      name.startsWith(".ia4tube-social-workspace-restore-")
    );
}

test("bundle key requires one canonical base64 value of exactly 32 bytes", () => {
  const encoded = syntheticKey(3).toString("base64");
  const decoded = decodeBundleKey(encoded);
  assert.equal(decoded.length, 32);
  assert.equal(decoded.toString("base64"), encoded);
  decoded.fill(0);
  for (const invalid of [
    "",
    "not-base64",
    Buffer.alloc(31).toString("base64"),
    Buffer.alloc(33).toString("base64"),
    `${encoded}\n`
  ]) {
    assert.throws(
      () => decodeBundleKey(invalid),
      { code: "backup_bundle_key_invalid" }
    );
  }
});

test("tar-stream is pinned as the direct audited runtime dependency", () => {
  const project = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")
  );
  const lock = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "..", "package-lock.json"),
      "utf8"
    )
  );
  assert.equal(project.dependencies["tar-stream"], "3.2.0");
  assert.equal(lock.packages[""].dependencies["tar-stream"], "3.2.0");
  assert.equal(lock.packages["node_modules/tar-stream"].version, "3.2.0");
});

test("the total plaintext limit is enforced before any output stream opens", async (t) => {
  const root = temporaryDirectory(t);
  const fakeSources = ["one", "two", "three"].map((name) =>
    path.join(root, `${name}.sql`)
  );
  const fakeSet = new Set(fakeSources.map((file) => path.resolve(file)));
  const fakeFileSystem = {
    ...fs,
    lstatSync(file) {
      if (fakeSet.has(path.resolve(file))) {
        return {
          size: MAX_ARCHIVE_ENTRY_BYTES,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false
        };
      }
      return fs.lstatSync(file);
    },
    createReadStream() {
      assert.fail("oversized bundle must fail before opening plaintext");
    },
    createWriteStream() {
      assert.fail("oversized bundle must fail before opening output");
    }
  };
  const output = path.join(root, "oversized.ia4sb");
  await assert.rejects(
    createEncryptedBundle({
      entries: fakeSources.map((file, index) => ({
        name: `0${index}-synthetic.sql`,
        path: file
      })),
      expectedNames: [
        "00-synthetic.sql",
        "01-synthetic.sql",
        "02-synthetic.sql"
      ],
      outputPath: output,
      label: LABEL,
      sourceFingerprint: SOURCE_FINGERPRINT,
      bundleKey: syntheticKey(),
      fileSystem: fakeFileSystem
    }),
    { code: "backup_bundle_size_limit_exceeded" }
  );
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(`${output}.partial`), false);
});

test("sources are opened once and a pathname swap between lstat and open is refused", async (t) => {
  const root = temporaryDirectory(t);
  const source = path.join(root, "source.txt");
  const replacement = path.join(root, "replacement.txt");
  const output = path.join(root, "bundle.ia4sb");
  fs.writeFileSync(source, "first-content");
  fs.writeFileSync(replacement, "other-content");
  const realOpen = fs.openSync.bind(fs);
  let sourceOpens = 0;
  const swappingFileSystem = {
    ...fs,
    openSync(file, flags, mode) {
      if (path.resolve(file) === path.resolve(source)) {
        sourceOpens += 1;
        fs.renameSync(source, `${source}.original`);
        fs.renameSync(replacement, source);
      }
      return realOpen(file, flags, mode);
    }
  };
  await assert.rejects(
    createEncryptedBundle({
      entries: [{ name: "safe.txt", path: source }],
      expectedNames: ["safe.txt"],
      outputPath: output,
      label: LABEL,
      sourceFingerprint: SOURCE_FINGERPRINT,
      bundleKey: syntheticKey(),
      fileSystem: swappingFileSystem
    }),
    { code: "backup_bundle_source_changed" }
  );
  assert.equal(sourceOpens, 1);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(`${output}.partial`), false);
});

test("source mutation during the held-descriptor stream is refused and cleaned", async (t) => {
  const root = temporaryDirectory(t);
  const source = path.join(root, "source.txt");
  const output = path.join(root, "bundle.ia4sb");
  fs.writeFileSync(source, "stable-before-stream");
  const changingFileSystem = {
    ...fs,
    createReadStream(file, options) {
      const stream = fs.createReadStream(file, options);
      if (path.resolve(file) === path.resolve(source)) {
        stream.once("end", () => {
          fs.appendFileSync(source, "-changed");
        });
      }
      return stream;
    }
  };
  await assert.rejects(
    createEncryptedBundle({
      entries: [{ name: "safe.txt", path: source }],
      expectedNames: ["safe.txt"],
      outputPath: output,
      label: LABEL,
      sourceFingerprint: SOURCE_FINGERPRINT,
      bundleKey: syntheticKey(),
      fileSystem: changingFileSystem
    }),
    { code: "backup_bundle_source_changed" }
  );
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(`${output}.partial`), false);
});

test("archive names are capped at the deterministic ustar boundary", async (t) => {
  const root = temporaryDirectory(t);
  const source = path.join(root, "source.txt");
  fs.writeFileSync(source, "synthetic");
  const accepted = `a${"b".repeat(99)}`;
  const rejected = `${accepted}c`;
  const acceptedOutput = path.join(root, "accepted.ia4sb");
  await createEncryptedBundle({
    entries: [{ name: accepted, path: source }],
    expectedNames: [accepted],
    outputPath: acceptedOutput,
    label: LABEL,
    sourceFingerprint: SOURCE_FINGERPRINT,
    bundleKey: syntheticKey()
  });
  assert.equal(fs.existsSync(acceptedOutput), true);
  await assert.rejects(
    createEncryptedBundle({
      entries: [{ name: rejected, path: source }],
      expectedNames: [rejected],
      outputPath: path.join(root, "rejected.ia4sb"),
      label: LABEL,
      sourceFingerprint: SOURCE_FINGERPRINT,
      bundleKey: syntheticKey()
    }),
    { code: "backup_bundle_archive_name_invalid" }
  );
});

test("encrypted bundle round-trips the exact allowlist and always removes extraction plaintext", async (t) => {
  const fixture = await createFixture(t);
  let extractedDirectory;
  const result = await withExtractedEncryptedBundle({
    containerPath: fixture.outputPath,
    expectedNames: NAMES,
    expectedLabel: LABEL,
    expectedSourceFingerprint: SOURCE_FINGERPRINT,
    workDirectory: fixture.workDirectory,
    bundleKey: fixture.key,
    async operation(extracted) {
      extractedDirectory = extracted.directory;
      compareEntryEvidence(fixture.created.entries, extracted.files);
      assert.deepEqual(
        extracted.files.map((entry) => entry.name),
        NAMES
      );
      for (let index = 0; index < NAMES.length; index += 1) {
        assert.deepEqual(
          fs.readFileSync(extracted.files[index].path),
          fs.readFileSync(fixture.entries[index].path)
        );
      }
      return "verified";
    }
  });
  assert.equal(result, "verified");
  assert.equal(fs.existsSync(fixture.outputPath), true);
  assert.equal(fs.existsSync(`${fixture.outputPath}.partial`), false);
  const containerBytes = fs.readFileSync(fixture.outputPath);
  const inspected = inspectContainer(fixture.outputPath);
  assert.equal(inspected.header.formatVersion, BUNDLE_FORMAT_VERSION);
  assert.equal(inspected.header.aadVersion, BUNDLE_AAD_VERSION);
  assert.equal(
    inspected.ciphertextEnd - inspected.ciphertextStart + 1,
    inspected.header.tarBytes
  );
  inspected.nonce.fill(0);
  inspected.authTag.fill(0);
  inspected.prefix.fill(0);
  for (const entry of fixture.entries) {
    assert.equal(
      containerBytes.includes(fs.readFileSync(entry.path)),
      false
    );
  }
  assert.equal(fs.existsSync(extractedDirectory), false);
  assert.deepEqual(
    temporaryExtractionDirectories(fixture.workDirectory),
    []
  );
});

test("wrong key, tampering and truncation fail authentication and clean temporary plaintext", async (t) => {
  const fixture = await createFixture(t);
  const inspected = inspectContainer(fixture.outputPath, {
    expectedLabel: LABEL,
    expectedSourceFingerprint: SOURCE_FINGERPRINT
  });
  const original = fs.readFileSync(fixture.outputPath);
  const cases = [
    {
      name: "wrong-key",
      key: syntheticKey(8),
      content: original
    },
    {
      name: "ciphertext-tampered",
      key: fixture.key,
      content: Buffer.from(original),
      offset: inspected.ciphertextStart + 1
    },
    {
      name: "tag-tampered",
      key: fixture.key,
      content: Buffer.from(original),
      offset: original.length - 1
    },
    {
      name: "truncated",
      key: fixture.key,
      content: original.subarray(0, original.length - 8)
    }
  ];
  inspected.nonce.fill(0);
  inspected.authTag.fill(0);
  inspected.prefix.fill(0);

  for (const entry of cases) {
    if (entry.offset !== undefined) entry.content[entry.offset] ^= 0x01;
    const candidate = path.join(fixture.root, `${entry.name}.ia4sb`);
    fs.writeFileSync(candidate, entry.content);
    await assert.rejects(
      withExtractedEncryptedBundle({
        containerPath: candidate,
        expectedNames: NAMES,
        expectedLabel: LABEL,
        expectedSourceFingerprint: SOURCE_FINGERPRINT,
        workDirectory: fixture.workDirectory,
        bundleKey: entry.key,
        async operation() {
          assert.fail("tampered plaintext must never reach the operation");
        }
      }),
      (error) =>
        typeof error?.code === "string" &&
        error.code.startsWith("backup_bundle_")
    );
    assert.deepEqual(
      temporaryExtractionDirectories(fixture.workDirectory),
      []
    );
  }
});

test("header AAD binds the label and source fingerprint", async (t) => {
  const fixture = await createFixture(t);
  for (const [field, value, code] of [
    ["expectedLabel", "another-label", "backup_bundle_label_mismatch"],
    [
      "expectedSourceFingerprint",
      "b".repeat(64),
      "backup_bundle_source_fingerprint_mismatch"
    ]
  ]) {
    await assert.rejects(
      withExtractedEncryptedBundle({
        containerPath: fixture.outputPath,
        expectedNames: NAMES,
        expectedLabel: LABEL,
        expectedSourceFingerprint: SOURCE_FINGERPRINT,
        [field]: value,
        workDirectory: fixture.workDirectory,
        bundleKey: fixture.key,
        async operation() {
          assert.fail("mismatched AAD must not be extracted");
        }
      }),
      { code }
    );
    assert.deepEqual(
      temporaryExtractionDirectories(fixture.workDirectory),
      []
    );
  }
});

test("same-length canonical header tampering reaches GCM and fails authentication", async (t) => {
  const fixture = await createFixture(t);
  const original = fs.readFileSync(fixture.outputPath);
  const from = Buffer.from(LABEL, "utf8");
  const changedLabel = "synthetic-2b1";
  const to = Buffer.from(changedLabel, "utf8");
  assert.equal(from.length, to.length);
  const offset = original.indexOf(from);
  assert.ok(offset > 0);
  const tampered = Buffer.from(original);
  to.copy(tampered, offset);
  const candidate = path.join(fixture.root, "header-aad-tampered.ia4sb");
  fs.writeFileSync(candidate, tampered);
  let called = false;
  await assert.rejects(
    withExtractedEncryptedBundle({
      containerPath: candidate,
      expectedNames: NAMES,
      expectedLabel: changedLabel,
      expectedSourceFingerprint: SOURCE_FINGERPRINT,
      workDirectory: fixture.workDirectory,
      bundleKey: fixture.key,
      async operation() {
        called = true;
      }
    }),
    { code: "backup_bundle_authentication_failed" }
  );
  assert.equal(called, false);
  assert.deepEqual(
    temporaryExtractionDirectories(fixture.workDirectory),
    []
  );
});

test("authentication is a diskless first pass and both passes reuse one container descriptor", async (t) => {
  const fixture = await createFixture(t);
  const container = path.resolve(fixture.outputPath);
  const realOpen = fs.openSync.bind(fs);
  const realReadStream = fs.createReadStream.bind(fs);
  let opens = 0;
  const readDescriptors = [];
  const inspectedFileSystem = {
    ...fs,
    openSync(file, flags, mode) {
      const descriptor = realOpen(file, flags, mode);
      if (path.resolve(file) === container) opens += 1;
      return descriptor;
    },
    createReadStream(file, options) {
      if (path.resolve(file) === container) {
        readDescriptors.push(options?.fd);
      }
      return realReadStream(file, options);
    }
  };
  await withExtractedEncryptedBundle({
    containerPath: fixture.outputPath,
    expectedNames: NAMES,
    expectedLabel: LABEL,
    expectedSourceFingerprint: SOURCE_FINGERPRINT,
    workDirectory: fixture.workDirectory,
    bundleKey: fixture.key,
    fileSystem: inspectedFileSystem,
    async operation() {
      return true;
    }
  });
  assert.equal(opens, 1);
  assert.equal(readDescriptors.length, 2);
  assert.ok(Number.isSafeInteger(readDescriptors[0]));
  assert.equal(readDescriptors[0], readDescriptors[1]);

  let plaintextWrites = 0;
  const rejectingFileSystem = {
    ...fs,
    createWriteStream(file, options) {
      if (
        path.resolve(file).startsWith(
          `${path.resolve(fixture.workDirectory)}${path.sep}`
        )
      ) {
        plaintextWrites += 1;
      }
      return fs.createWriteStream(file, options);
    }
  };
  await assert.rejects(
    withExtractedEncryptedBundle({
      containerPath: fixture.outputPath,
      expectedNames: NAMES,
      expectedLabel: LABEL,
      expectedSourceFingerprint: SOURCE_FINGERPRINT,
      workDirectory: fixture.workDirectory,
      bundleKey: syntheticKey(99),
      fileSystem: rejectingFileSystem,
      async operation() {
        assert.fail("wrong key must not reach the callback");
      }
    }),
    { code: "backup_bundle_authentication_failed" }
  );
  assert.equal(plaintextWrites, 0);
  assert.deepEqual(
    temporaryExtractionDirectories(fixture.workDirectory),
    []
  );
});

test("authenticated tar size is capacity-checked before extraction workspace creation", async (t) => {
  const fixture = await createFixture(t);
  let writeStreams = 0;
  const constrainedFileSystem = {
    ...fs,
    statfsSync() {
      return { bavail: 1, bsize: 4096 };
    },
    createWriteStream(file, options) {
      if (
        path.resolve(file).startsWith(
          `${path.resolve(fixture.workDirectory)}${path.sep}`
        )
      ) {
        writeStreams += 1;
      }
      return fs.createWriteStream(file, options);
    }
  };
  await assert.rejects(
    withExtractedEncryptedBundle({
      containerPath: fixture.outputPath,
      expectedNames: NAMES,
      expectedLabel: LABEL,
      expectedSourceFingerprint: SOURCE_FINGERPRINT,
      workDirectory: fixture.workDirectory,
      bundleKey: fixture.key,
      fileSystem: constrainedFileSystem,
      async operation() {
        assert.fail("insufficient capacity must block extraction");
      }
    }),
    { code: "backup_bundle_space_insufficient" }
  );
  assert.equal(writeStreams, 0);
  assert.deepEqual(
    temporaryExtractionDirectories(fixture.workDirectory),
    []
  );
});

test("a ciphertext change visible only to the second pass fails and removes extracted plaintext", async (t) => {
  const fixture = await createFixture(t);
  const inspected = inspectContainer(fixture.outputPath);
  let reads = 0;
  let called = false;
  const changingFileSystem = {
    ...fs,
    createReadStream(file, options) {
      if (path.resolve(file) === path.resolve(fixture.outputPath)) {
        reads += 1;
        if (reads === 2) {
          const bytes = fs
            .readFileSync(file)
            .subarray(options.start, options.end + 1);
          const changed = Buffer.from(bytes);
          changed[Math.min(32, changed.length - 1)] ^= 0x01;
          return Readable.from(changed);
        }
      }
      return fs.createReadStream(file, options);
    }
  };
  inspected.nonce.fill(0);
  inspected.authTag.fill(0);
  inspected.prefix.fill(0);
  await assert.rejects(
    withExtractedEncryptedBundle({
      containerPath: fixture.outputPath,
      expectedNames: NAMES,
      expectedLabel: LABEL,
      expectedSourceFingerprint: SOURCE_FINGERPRINT,
      workDirectory: fixture.workDirectory,
      bundleKey: fixture.key,
      fileSystem: changingFileSystem,
      async operation() {
        called = true;
      }
    }),
    { code: "backup_bundle_authentication_failed" }
  );
  assert.equal(reads, 2);
  assert.equal(called, false);
  assert.deepEqual(
    temporaryExtractionDirectories(fixture.workDirectory),
    []
  );
});

test("tar extraction rejects traversal, links, unexpected and duplicate entries", async (t) => {
  const root = temporaryDirectory(t, "ia4tube-tar-safety-");
  const outside = path.join(path.dirname(root), "ia4tube-escape.txt");
  const cases = [
    {
      name: "traversal",
      entries: [{ name: "../ia4tube-escape.txt", content: "blocked" }]
    },
    {
      name: "symlink",
      entries: [
        { name: "safe.txt", type: "symlink", linkname: outside }
      ]
    },
    {
      name: "unexpected",
      entries: [{ name: "other.txt", content: "blocked" }]
    },
    {
      name: "duplicate",
      entries: [
        { name: "safe.txt", content: "first" },
        { name: "safe.txt", content: "second" }
      ]
    }
  ];
  for (const entry of cases) {
    const destination = path.join(root, entry.name);
    fs.mkdirSync(destination);
    const archive = await tarBuffer(entry.entries);
    await assert.rejects(
      extractTarStream({
        readable: Readable.from(archive),
        expectedNames: ["safe.txt"],
        destinationDirectory: destination
      }),
      (error) =>
        typeof error?.code === "string" &&
        error.code.startsWith("backup_bundle_")
    );
  }
  assert.equal(fs.existsSync(outside), false);
});

test("atomic publication never overwrites or removes a competing final path", async (t) => {
  const root = temporaryDirectory(t);
  const source = path.join(root, "source.txt");
  const output = path.join(root, "failed.ia4sb");
  fs.writeFileSync(source, "synthetic source");
  const realLink = fs.linkSync.bind(fs);
  const failingFileSystem = {
    ...fs,
    linkSync(sourcePath, destinationPath) {
      fs.writeFileSync(destinationPath, "competing owner", {
        flag: "wx"
      });
      return realLink(sourcePath, destinationPath);
    }
  };
  await assert.rejects(
    createEncryptedBundle({
      entries: [{ name: "safe.txt", path: source }],
      expectedNames: ["safe.txt"],
      outputPath: output,
      label: LABEL,
      sourceFingerprint: SOURCE_FINGERPRINT,
      bundleKey: syntheticKey(),
      fileSystem: failingFileSystem
    }),
    { code: "backup_bundle_creation_failed" }
  );
  assert.equal(fs.readFileSync(output, "utf8"), "competing owner");
  assert.equal(fs.existsSync(`${output}.partial`), false);
  assert.equal(fs.readFileSync(source, "utf8"), "synthetic source");
});

test("a post-link durability failure removes only the bundle owned by this run", async (t) => {
  const root = temporaryDirectory(t);
  const source = path.join(root, "source.txt");
  const output = path.join(root, "failed.ia4sb");
  fs.writeFileSync(source, "synthetic source");
  const realOpen = fs.openSync.bind(fs);
  const failingFileSystem = {
    ...fs,
    openSync(file, flags, mode) {
      if (
        path.resolve(file) === path.resolve(root) &&
        fs.existsSync(output)
      ) {
        const error = new Error("synthetic directory sync failure");
        error.code = "EIO";
        throw error;
      }
      return realOpen(file, flags, mode);
    }
  };
  await assert.rejects(
    createEncryptedBundle({
      entries: [{ name: "safe.txt", path: source }],
      expectedNames: ["safe.txt"],
      outputPath: output,
      label: LABEL,
      sourceFingerprint: SOURCE_FINGERPRINT,
      bundleKey: syntheticKey(),
      fileSystem: failingFileSystem
    }),
    { code: "backup_bundle_directory_sync_failed" }
  );
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(`${output}.partial`), false);
  assert.equal(fs.readFileSync(source, "utf8"), "synthetic source");
});

test("unsupported directory fsync is reported without weakening file durability", async (t) => {
  const root = temporaryDirectory(t);
  const source = path.join(root, "source.txt");
  const output = path.join(root, "bundle.ia4sb");
  fs.writeFileSync(source, "synthetic source");
  const realOpen = fs.openSync.bind(fs);
  const unsupportedDirectoryFileSystem = {
    ...fs,
    openSync(file, flags, mode) {
      if (
        path.resolve(file) === path.resolve(root) &&
        fs.existsSync(output)
      ) {
        const error = new Error("synthetic unsupported directory sync");
        error.code = "EPERM";
        throw error;
      }
      return realOpen(file, flags, mode);
    }
  };
  const created = await createEncryptedBundle({
    entries: [{ name: "safe.txt", path: source }],
    expectedNames: ["safe.txt"],
    outputPath: output,
    label: LABEL,
    sourceFingerprint: SOURCE_FINGERPRINT,
    bundleKey: syntheticKey(),
    fileSystem: unsupportedDirectoryFileSystem
  });
  assert.equal(created.bundleDirectoryFsyncConfirmed, false);
  assert.equal(fs.existsSync(output), true);
  assert.equal(fs.existsSync(`${output}.partial`), false);
});

test("file fsync failure remains fail-closed and removes owned output", async (t) => {
  const root = temporaryDirectory(t);
  const source = path.join(root, "source.txt");
  const output = path.join(root, "bundle.ia4sb");
  fs.writeFileSync(source, "synthetic source");
  let fsyncCalls = 0;
  const failingFileSystem = {
    ...fs,
    fsyncSync(descriptor) {
      fsyncCalls += 1;
      if (fsyncCalls === 1) {
        const error = new Error("synthetic file sync failure");
        error.code = "EPERM";
        throw error;
      }
      return fs.fsyncSync(descriptor);
    }
  };
  await assert.rejects(
    createEncryptedBundle({
      entries: [{ name: "safe.txt", path: source }],
      expectedNames: ["safe.txt"],
      outputPath: output,
      label: LABEL,
      sourceFingerprint: SOURCE_FINGERPRINT,
      bundleKey: syntheticKey(),
      fileSystem: failingFileSystem
    }),
    { code: "backup_bundle_creation_failed" }
  );
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(`${output}.partial`), false);
});

test("post-publication cleanup refuses a swapped final and preserves both owners", async (t) => {
  const root = temporaryDirectory(t);
  const source = path.join(root, "source.txt");
  const output = path.join(root, "bundle.ia4sb");
  const ownedCopy = path.join(root, "owned-moved.ia4sb");
  fs.writeFileSync(source, "synthetic source");
  const created = await createEncryptedBundle({
    entries: [{ name: "safe.txt", path: source }],
    expectedNames: ["safe.txt"],
    outputPath: output,
    label: LABEL,
    sourceFingerprint: SOURCE_FINGERPRINT,
    bundleKey: syntheticKey()
  });
  fs.renameSync(output, ownedCopy);
  fs.writeFileSync(output, "third-party final", { flag: "wx" });
  assert.throws(
    () => cleanupCreatedBundle(created),
    { code: "backup_bundle_cleanup_failed" }
  );
  assert.equal(fs.readFileSync(output, "utf8"), "third-party final");
  assert.equal(fs.existsSync(ownedCopy), true);
});

test("operation failures remain authoritative while extraction plaintext is removed", async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(
    withExtractedEncryptedBundle({
      containerPath: fixture.outputPath,
      expectedNames: NAMES,
      expectedLabel: LABEL,
      expectedSourceFingerprint: SOURCE_FINGERPRINT,
      workDirectory: fixture.workDirectory,
      bundleKey: fixture.key,
      async operation() {
        throw new SocialPostgresError(
          "synthetic_operation_refused",
          "synthetic safe message"
        );
      }
    }),
    { code: "synthetic_operation_refused" }
  );
  assert.deepEqual(
    temporaryExtractionDirectories(fixture.workDirectory),
    []
  );
});

test("an invalid in-memory key is refused before creating extraction plaintext", async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(
    withExtractedEncryptedBundle({
      containerPath: fixture.outputPath,
      expectedNames: NAMES,
      expectedLabel: LABEL,
      expectedSourceFingerprint: SOURCE_FINGERPRINT,
      workDirectory: fixture.workDirectory,
      bundleKey: Buffer.alloc(31),
      async operation() {
        assert.fail("invalid key must not reach the callback");
      }
    }),
    { code: "backup_bundle_key_invalid" }
  );
  assert.deepEqual(
    temporaryExtractionDirectories(fixture.workDirectory),
    []
  );
});

test("failure while protecting the temporary directory still removes it", async (t) => {
  const fixture = await createFixture(t);
  const realChmod = fs.chmodSync.bind(fs);
  const failingFileSystem = {
    ...fs,
    chmodSync(file, mode) {
      if (
        path.dirname(file) === fixture.workDirectory &&
        path.basename(file).startsWith(
          ".ia4tube-social-workspace-restore-"
        )
      ) {
        throw new Error("synthetic chmod refusal");
      }
      return realChmod(file, mode);
    }
  };
  await assert.rejects(
    withExtractedEncryptedBundle({
      containerPath: fixture.outputPath,
      expectedNames: NAMES,
      expectedLabel: LABEL,
      expectedSourceFingerprint: SOURCE_FINGERPRINT,
      workDirectory: fixture.workDirectory,
      bundleKey: fixture.key,
      fileSystem: failingFileSystem,
      async operation() {
        assert.fail("unprotected temp directory must not be used");
      }
    })
  );
  assert.deepEqual(
    temporaryExtractionDirectories(fixture.workDirectory),
    []
  );
});

test("a crashed process leaves only a marked workspace that stale recovery removes", (t) => {
  const root = temporaryDirectory(t, "ia4tube-workspace-crash-");
  const modulePath = path.resolve(
    __dirname,
    "..",
    "src",
    "persistence",
    "postgres",
    "encrypted-backup-bundle.js"
  );
  const script = [
    `"use strict";`,
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    `const bundle = require(${JSON.stringify(modulePath)});`,
    `const workspace = bundle.createOwnedWorkspace({`,
    `  root: ${JSON.stringify(root)},`,
    `  purpose: "restore"`,
    `});`,
    `fs.writeFileSync(path.join(workspace.path, "synthetic.dump"),`,
    `  "synthetic plaintext", { mode: 0o600 });`,
    `process.exit(23);`
  ].join("\n");
  const child = spawnSync(process.execPath, ["-e", script], {
    timeout: 10_000,
    encoding: "utf8"
  });
  assert.equal(child.status, 23);
  assert.equal(child.signal, null);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
  assert.equal(temporaryExtractionDirectories(root).length, 1);
  const recovered = recoverOwnedWorkspaces({
    root,
    purpose: "restore",
    minimumAgeMs: 0,
    now: () => Date.now() + 1_000,
    isProcessAlive: () => false
  });
  assert.equal(recovered.recovered, 1);
  assert.deepEqual(temporaryExtractionDirectories(root), []);
});

test("stale recovery refuses malformed ownership markers and preserves unrelated paths", (t) => {
  const root = temporaryDirectory(t, "ia4tube-workspace-refusal-");
  const unrelated = path.join(root, "unrelated.txt");
  const malformed = path.join(
    root,
    `.ia4tube-social-workspace-restore-${"a".repeat(32)}`
  );
  fs.writeFileSync(unrelated, "preserve");
  fs.mkdirSync(malformed);
  fs.writeFileSync(
    path.join(malformed, ".ia4tube-workspace-owner.json"),
    "{\"format\":\"untrusted\"}\n"
  );
  assert.throws(
    () =>
      recoverOwnedWorkspaces({
        root,
        purpose: "restore",
        minimumAgeMs: 0,
        now: () => Date.now() + 1_000,
        isProcessAlive: () => false
      }),
    { code: "backup_bundle_workspace_marker_invalid" }
  );
  assert.equal(fs.existsSync(malformed), true);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "preserve");
});

test("normal owned workspace cleanup validates identity and leaves no plaintext", (t) => {
  const root = temporaryDirectory(t, "ia4tube-workspace-normal-");
  const workspace = createOwnedWorkspace({
    root,
    purpose: "restore"
  });
  fs.writeFileSync(
    path.join(workspace.path, "synthetic.dump"),
    "synthetic plaintext",
    { mode: 0o600 }
  );
  const recovered = recoverOwnedWorkspaces({
    root,
    purpose: "restore",
    minimumAgeMs: 0,
    now: () => Date.now() + 1_000,
    isProcessAlive: () => false
  });
  assert.equal(recovered.recovered, 1);
  assert.equal(fs.existsSync(workspace.path), false);
});

test("bundle errors and serialized results never contain key material", async (t) => {
  const fixture = await createFixture(t);
  const encoded = fixture.key.toString("base64");
  let caught;
  try {
    await withExtractedEncryptedBundle({
      containerPath: fixture.outputPath,
      expectedNames: NAMES,
      expectedLabel: LABEL,
      expectedSourceFingerprint: SOURCE_FINGERPRINT,
      workDirectory: fixture.workDirectory,
      bundleKey: syntheticKey(9),
      async operation() {
        assert.fail("wrong key must not reach the callback");
      }
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  const rendered = `${String(caught)}\n${JSON.stringify(caught)}`;
  assert.equal(rendered.includes(encoded), false);
  assert.equal(rendered.includes(fixture.key.toString("hex")), false);
});
