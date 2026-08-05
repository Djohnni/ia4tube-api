"use strict";

// Trusted Windows entry for the future physical gate. It deliberately exposes
// no dependency/adaptor injection surface and performs no download.
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  HarnessFailure,
  createOwnedTemporaryRoot,
  removeOwnedTree
} = require("./social-3a0p-local-harness-core");
const {
  PHYSICAL_APPROVAL,
  REQUIRED_POSTGRES_VERSION
} = require("./social-3a0p-local-physical-harness");

const INPUT_KEYS = Object.freeze([
  "approval",
  "expectedSha256",
  "packagePath",
  "port"
]);
const SHA256 = /^[0-9a-f]{64}$/;
const FORBIDDEN_LOCAL_PATH = /^(?:\\\\|\/\/|\\\\\?\\|\\\\\.\\)/;
const KERNEL_SYSTEM_ROOT = "\\\\?\\GLOBALROOT\\SystemRoot";
const POSTGRES_PACKAGE_NAME = "postgresql-18.4-2-windows-x64-binaries.zip";
const PRODUCT_COMMIT = "fcfc92419021dae5f77baad731c634b10c275c5b";
const COMMIT = /^[0-9a-f]{40}$/;

function fail(code) {
  throw new HarnessFailure(code);
}

function assertNoReparsePath(target, code) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const segments = path.relative(parsed.root, resolved).split(path.sep);
  let current = parsed.root;
  for (const segment of segments) {
    if (!segment) continue;
    current = path.join(current, segment);
    let item;
    try {
      item = fs.lstatSync(current);
    } catch {
      fail(code);
    }
    if (item.isSymbolicLink()) fail(code);
  }
  return true;
}

function validateTrustedWindowsEntryInput(input) {
  if (
    !input ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    JSON.stringify(Object.keys(input).sort()) !==
      JSON.stringify([...INPUT_KEYS].sort())
  ) {
    fail("windows_entry_input_invalid");
  }
  if (input.approval !== PHYSICAL_APPROVAL) {
    fail("windows_entry_approval_missing");
  }
  if (
    typeof input.packagePath !== "string" ||
    !input.packagePath ||
    input.packagePath !== input.packagePath.trim() ||
    !path.isAbsolute(input.packagePath) ||
    FORBIDDEN_LOCAL_PATH.test(input.packagePath) ||
    path.basename(input.packagePath).toLowerCase() !== POSTGRES_PACKAGE_NAME
  ) {
    fail("windows_entry_package_path_invalid");
  }
  if (!SHA256.test(String(input.expectedSha256 || ""))) {
    fail("windows_entry_package_sha256_invalid");
  }
  if (
    !Number.isSafeInteger(input.port) ||
    input.port < 1024 ||
    input.port > 65535
  ) {
    fail("windows_entry_port_invalid");
  }
  return Object.freeze({
    approval: PHYSICAL_APPROVAL,
    expectedSha256: input.expectedSha256,
    packagePath: path.resolve(input.packagePath),
    port: input.port
  });
}

function readWorktreeHeadCommit(repositoryRoot) {
  let gitDirectory;
  try {
    const dotGit = path.join(repositoryRoot, ".git");
    const item = fs.lstatSync(dotGit);
    if (item.isDirectory()) {
      gitDirectory = dotGit;
    } else if (item.isFile()) {
      const pointer = fs.readFileSync(dotGit, "utf8").trim();
      if (!pointer.startsWith("gitdir: ")) fail("windows_entry_git_identity_invalid");
      gitDirectory = path.resolve(repositoryRoot, pointer.slice(8));
    } else {
      fail("windows_entry_git_identity_invalid");
    }
    const head = fs.readFileSync(path.join(gitDirectory, "HEAD"), "utf8").trim();
    if (COMMIT.test(head)) return head;
    if (!head.startsWith("ref: refs/")) fail("windows_entry_git_identity_invalid");
    const reference = head.slice(5);
    const candidates = [path.join(gitDirectory, reference)];
    const commonFile = path.join(gitDirectory, "commondir");
    if (fs.existsSync(commonFile)) {
      const commonDirectory = path.resolve(
        gitDirectory,
        fs.readFileSync(commonFile, "utf8").trim()
      );
      candidates.push(path.join(commonDirectory, reference));
    }
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const commit = fs.readFileSync(candidate, "utf8").trim();
      if (COMMIT.test(commit)) return commit;
    }
  } catch (error) {
    if (error instanceof HarnessFailure) throw error;
  }
  fail("windows_entry_git_identity_invalid");
}

function requireLocalRegularFile(file, code) {
  let item;
  let real;
  try {
    assertNoReparsePath(file, code);
    item = fs.lstatSync(file);
    real = fs.realpathSync.native(file);
  } catch {
    fail(code);
  }
  if (
    !item.isFile() ||
    item.isSymbolicLink() ||
    FORBIDDEN_LOCAL_PATH.test(real)
  ) {
    fail(code);
  }
  return real;
}

function trustedRuntimePaths() {
  if (process.platform !== "win32") fail("windows_entry_platform_refused");
  const repositoryRoot = requireLocalDirectory(
    path.resolve(__dirname, ".."),
    "windows_entry_repository_invalid"
  );
  let systemRootValue;
  try {
    systemRootValue = fs.realpathSync.native(KERNEL_SYSTEM_ROOT);
  } catch {
    fail("windows_entry_system_root_invalid");
  }
  const systemRoot = requireLocalDirectory(
    systemRootValue,
    "windows_entry_system_root_invalid"
  );
  if (path.basename(systemRoot).toLowerCase() !== "windows") {
    fail("windows_entry_system_root_invalid");
  }
  const system32 = requireLocalDirectory(
    path.join(systemRoot, "System32"),
    "windows_entry_system32_invalid"
  );
  const powershell = requireLocalRegularFile(
    path.join(
      system32,
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    ),
    "windows_entry_powershell_invalid"
  );
  const tar = requireLocalRegularFile(
    path.join(system32, "tar.exe"),
    "windows_entry_tar_invalid"
  );
  const taskkill = requireLocalRegularFile(
    path.join(system32, "taskkill.exe"),
    "windows_entry_taskkill_invalid"
  );
  const commandProcessor = requireLocalRegularFile(
    path.join(system32, "cmd.exe"),
    "windows_entry_command_processor_invalid"
  );
  for (const executable of [commandProcessor, powershell, tar, taskkill]) {
    const relative = path.relative(systemRoot, executable);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      fail("windows_entry_system_executable_refused");
    }
  }
  const systemDrive = path.parse(systemRoot).root.replace(/[\\\/]$/, "");
  const systemEnvironment = Object.freeze({
    ComSpec: commandProcessor,
    PATH: [system32, path.dirname(powershell)].join(path.delimiter),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemDrive: systemDrive,
    SystemRoot: systemRoot,
    WINDIR: systemRoot
  });
  return Object.freeze({
    powershell,
    repositoryRoot,
    systemEnvironment,
    systemRoot,
    tar,
    taskkill
  });
}

function requireLocalDirectory(directory, code) {
  let item;
  let real;
  try {
    assertNoReparsePath(directory, code);
    item = fs.lstatSync(directory);
    real = fs.realpathSync.native(directory);
  } catch {
    fail(code);
  }
  if (
    !item.isDirectory() ||
    item.isSymbolicLink() ||
    FORBIDDEN_LOCAL_PATH.test(real)
  ) {
    fail(code);
  }
  return real;
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(file, { flags: "r" });
  try {
    for await (const chunk of stream) hash.update(chunk);
  } catch {
    fail("windows_entry_package_read_failed");
  }
  return hash.digest("hex");
}

async function prepareTrustedWindowsEntry(input) {
  const validated = validateTrustedWindowsEntryInput(input);
  const sourcePackage = requireLocalRegularFile(
    validated.packagePath,
    "windows_entry_package_invalid"
  );
  if ((await sha256File(sourcePackage)) !== validated.expectedSha256) {
    fail("windows_entry_package_sha256_mismatch");
  }
  const runtime = trustedRuntimePaths();
  const harnessCommit = readWorktreeHeadCommit(runtime.repositoryRoot);
  const ownedParent = requireLocalDirectory(
    os.tmpdir(),
    "windows_entry_temporary_parent_invalid"
  );
  const ownershipProof = createOwnedTemporaryRoot({ parent: ownedParent });
  const ownedRoot = ownershipProof.root;
  const ownedPackage = path.join(ownedRoot, POSTGRES_PACKAGE_NAME);
  let prepared = false;
  try {
    await fsp.copyFile(sourcePackage, ownedPackage, fs.constants.COPYFILE_EXCL);
    requireLocalRegularFile(ownedPackage, "windows_entry_owned_package_invalid");
    if ((await sha256File(ownedPackage)) !== validated.expectedSha256) {
      fail("windows_entry_owned_package_sha256_mismatch");
    }
    const {
      createWindowsHarnessInvocation
    } = require("./social-3a0p-local-windows-adapters");
    const invocation = createWindowsHarnessInvocation({
      approval: PHYSICAL_APPROVAL,
      adapterOptions: {
        ownedRoot,
        ownedParent,
        ownershipProof,
        repositoryRoot: runtime.repositoryRoot,
        harnessCommit,
        productCommit: PRODUCT_COMMIT,
        sourcePackageVerifier: async () => {
          const preservedSource = requireLocalRegularFile(
            sourcePackage,
            "windows_entry_external_package_missing"
          );
          if ((await sha256File(preservedSource)) !== validated.expectedSha256) {
            fail("windows_entry_external_package_changed");
          }
          return {
            externalPackagePreserved: true,
            sourceHashUnchanged: true
          };
        },
        platform: "win32",
        systemEnvironment: runtime.systemEnvironment,
        executables: {
          powershell: runtime.powershell,
          tar: runtime.tar,
          taskkill: runtime.taskkill
        }
      },
      packageDescriptor: {
        archivePath: ownedPackage,
        expectedSha256: validated.expectedSha256,
        version: REQUIRED_POSTGRES_VERSION,
        sourceOwnedByRun: false,
        workingCopyOwnedByRun: true
      },
      target: { host: "127.0.0.1", port: validated.port },
      heartbeat(event) {
        process.stderr.write(`${JSON.stringify(event)}\n`);
      }
    });
    let state = "prepared";
    prepared = true;
    return Object.freeze({
      async run() {
        if (state !== "prepared") fail("windows_entry_state_invalid");
        state = "running";
        const { runLocalPhysicalHarness } = require(
          "./social-3a0p-local-physical-harness"
        );
        let report;
        let executionFailure = null;
        try {
          report = await runLocalPhysicalHarness(invocation);
        } catch (error) {
          executionFailure = error;
        } finally {
          state = "closed";
        }
        if (executionFailure) throw executionFailure;
        return report;
      },
      cancelPreparation() {
        if (state !== "prepared") fail("windows_entry_state_invalid");
        state = "closed";
        return removeOwnedTree(ownedRoot, ownedParent);
      },
      summary: Object.freeze({
        packageSha256: validated.expectedSha256,
        packageName: POSTGRES_PACKAGE_NAME,
        packageBuild: "18.4-2",
        sourceOwnedByRun: false,
        workingCopyOwnedByRun: true,
        port: validated.port,
        postgresVersion: REQUIRED_POSTGRES_VERSION,
        targetHost: "127.0.0.1"
      })
    });
  } catch (error) {
    if (!prepared) {
      try {
        removeOwnedTree(ownedRoot, ownedParent);
      } catch {
        const primaryCode = error instanceof HarnessFailure
          ? error.code
          : "windows_entry_preparation_failed";
        throw new HarnessFailure(primaryCode, {
          cleanupFailureCode: "windows_entry_preparation_cleanup_failed"
        });
      }
    }
    throw error;
  }
}

function parseCommandLine(argv) {
  if (!Array.isArray(argv) || argv.length !== 8) {
    fail("windows_entry_arguments_invalid");
  }
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !["--approval", "--package-path", "--expected-sha256", "--port"].includes(name) ||
      Object.hasOwn(values, name) ||
      typeof value !== "string"
    ) {
      fail("windows_entry_arguments_invalid");
    }
    values[name] = value;
  }
  if (Object.keys(values).length !== 4 || !/^\d+$/.test(values["--port"] || "")) {
    fail("windows_entry_arguments_invalid");
  }
  return {
    approval: values["--approval"],
    packagePath: values["--package-path"],
    expectedSha256: values["--expected-sha256"],
    port: Number(values["--port"])
  };
}

async function commandLineEntry({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  try {
    const prepared = await prepareTrustedWindowsEntry(parseCommandLine(argv));
    const report = await prepared.run();
    stdout.write(`${JSON.stringify({
      ok: report.ok,
      lastCompletedPhase: report.lastCompletedPhase,
      phaseCount: report.phases.length
    })}\n`);
    return report.ok ? 0 : 2;
  } catch (error) {
    const code = error instanceof HarnessFailure
      ? error.code
      : "windows_entry_failed";
    stderr.write(`${JSON.stringify({
      ok: false,
      code,
      cleanupFailureCode: error?.cleanupFailureCode || null
    })}\n`);
    return 2;
  }
}

if (require.main === module) {
  commandLineEntry().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  INPUT_KEYS,
  POSTGRES_PACKAGE_NAME,
  PRODUCT_COMMIT,
  commandLineEntry,
  parseCommandLine,
  prepareTrustedWindowsEntry,
  validateTrustedWindowsEntryInput
};
