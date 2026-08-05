"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  PHYSICAL_APPROVAL
} = require("../scripts/social-3a0p-local-physical-harness");
const {
  commandLineEntry,
  POSTGRES_PACKAGE_NAME,
  PRODUCT_COMMIT,
  parseCommandLine,
  prepareTrustedWindowsEntry,
  validateTrustedWindowsEntryInput
} = require("../scripts/social-3a0p-local-windows-entry");

const HASH = "a".repeat(64);
const PACKAGE = path.resolve(`C:\\synthetic\\${POSTGRES_PACKAGE_NAME}`);

function validInput(overrides = {}) {
  return {
    approval: PHYSICAL_APPROVAL,
    expectedSha256: HASH,
    packagePath: PACKAGE,
    port: 64995,
    ...overrides
  };
}

test("entrada confiável aceita somente quatro campos não secretos exatos", () => {
  assert.deepEqual(validateTrustedWindowsEntryInput(validInput()), validInput());
  for (const extra of [
    { dependencies: {} },
    { adapterOptions: {} },
    { physicalGates: {} },
    { repositoryRoot: "C:\\other" },
    { powershell: "C:\\other.exe" },
    { timeouts: {} },
    { environment: {} }
  ]) {
    assert.throws(
      () => validateTrustedWindowsEntryInput({ ...validInput(), ...extra }),
      { code: "windows_entry_input_invalid" }
    );
  }
});

test("aprovação, caminho, hash e porta falham fechado antes da preparação", () => {
  assert.throws(
    () => validateTrustedWindowsEntryInput(validInput({ approval: "no" })),
    { code: "windows_entry_approval_missing" }
  );
  for (const packagePath of [
    "postgresql-18.4.zip",
    "\\\\server\\share\\postgresql-18.4.zip",
    "\\\\?\\C:\\postgresql-18.4.zip",
    path.resolve("C:\\synthetic\\postgresql-18.4.zip"),
    `${PACKAGE} `
  ]) {
    assert.throws(
      () => validateTrustedWindowsEntryInput(validInput({ packagePath })),
      { code: "windows_entry_package_path_invalid" }
    );
  }
  assert.throws(
    () => validateTrustedWindowsEntryInput(validInput({ expectedSha256: HASH.toUpperCase() })),
    { code: "windows_entry_package_sha256_invalid" }
  );
  for (const port of [0, 1023, 65536, "64995"]) {
    assert.throws(
      () => validateTrustedWindowsEntryInput(validInput({ port })),
      { code: "windows_entry_port_invalid" }
    );
  }
});

test("parser CLI recusa duplicações, extras e valores ausentes", () => {
  const args = [
    "--approval", PHYSICAL_APPROVAL,
    "--package-path", PACKAGE,
    "--expected-sha256", HASH,
    "--port", "64995"
  ];
  assert.deepEqual(parseCommandLine(args), validInput());
  assert.throws(
    () => parseCommandLine([...args.slice(0, 6), "--approval", PHYSICAL_APPROVAL]),
    { code: "windows_entry_arguments_invalid" }
  );
  assert.throws(
    () => parseCommandLine([...args, "--extra", "value"]),
    { code: "windows_entry_arguments_invalid" }
  );
  assert.throws(
    () => parseCommandLine(args.slice(0, -1)),
    { code: "windows_entry_arguments_invalid" }
  );
});

test("CLI sem aprovação não lê pacote nem inicia o harness", async () => {
  let output = "";
  const code = await commandLineEntry({
    argv: [
      "--approval", "invalid",
      "--package-path", "C:\\does-not-exist\\postgresql.zip",
      "--expected-sha256", HASH,
      "--port", "64995"
    ],
    stdout: { write(value) { output += value; } },
    stderr: { write(value) { output += value; } }
  });
  assert.equal(code, 2);
  assert.match(output, /windows_entry_approval_missing/);
  assert.doesNotMatch(output, /does-not-exist/);
});

test("preparação confiável copia o pacote por hash e cancela sem executar PostgreSQL", {
  skip: process.platform !== "win32"
}, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-entry-source-"));
  const source = path.join(parent, POSTGRES_PACKAGE_NAME);
  const bytes = Buffer.from("synthetic-package-not-executed", "utf8");
  fs.writeFileSync(source, bytes, { flag: "wx" });
  const expectedSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  try {
    const prepared = await prepareTrustedWindowsEntry({
      approval: PHYSICAL_APPROVAL,
      expectedSha256,
      packagePath: source,
      port: 64995
    });
    assert.deepEqual(prepared.summary, {
      packageSha256: expectedSha256,
      packageName: POSTGRES_PACKAGE_NAME,
      packageBuild: "18.4-2",
      sourceOwnedByRun: false,
      workingCopyOwnedByRun: true,
      port: 64995,
      postgresVersion: "18.4",
      targetHost: "127.0.0.1"
    });
    assert.equal(prepared.cancelPreparation(), true);
    assert.throws(
      () => prepared.cancelPreparation(),
      { code: "windows_entry_state_invalid" }
    );
  } finally {
    bytes.fill(0);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("hash incorreto é recusado antes de criar uma execução física", {
  skip: process.platform !== "win32"
}, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-entry-hash-"));
  const source = path.join(parent, POSTGRES_PACKAGE_NAME);
  fs.writeFileSync(source, "synthetic", { flag: "wx" });
  try {
    await assert.rejects(
      prepareTrustedWindowsEntry({
        approval: PHYSICAL_APPROVAL,
        expectedSha256: "f".repeat(64),
        packagePath: source,
        port: 64995
      }),
      { code: "windows_entry_package_sha256_mismatch" }
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("entrada confiável ignora SystemRoot e PATH manipulados pelo chamador", {
  skip: process.platform !== "win32"
}, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-entry-env-"));
  const source = path.join(parent, POSTGRES_PACKAGE_NAME);
  const bytes = Buffer.from("synthetic-package-environment-proof", "utf8");
  fs.writeFileSync(source, bytes, { flag: "wx" });
  const expectedSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const previous = {
    ComSpec: process.env.ComSpec,
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR
  };
  process.env.ComSpec = path.join(parent, "cmd.exe");
  process.env.PATH = parent;
  process.env.SystemRoot = parent;
  process.env.WINDIR = parent;
  try {
    const prepared = await prepareTrustedWindowsEntry({
      approval: PHYSICAL_APPROVAL,
      expectedSha256,
      packagePath: source,
      port: 64994
    });
    assert.equal(prepared.cancelPreparation(), true);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    bytes.fill(0);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("identidade do produto e nome do build futuro permanecem canônicos", () => {
  assert.match(PRODUCT_COMMIT, /^[0-9a-f]{40}$/);
  assert.equal(POSTGRES_PACKAGE_NAME, "postgresql-18.4-2-windows-x64-binaries.zip");
});
