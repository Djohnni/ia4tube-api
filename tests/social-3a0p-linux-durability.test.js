"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  DURABILITY_KEYS,
  NOFOLLOW_KEYS,
  runLinuxDurabilityProof,
  validateProofShape
} = require("../scripts/social-3a0p-linux-durability");

function validResult() {
  return {
    ok: true,
    schemaVersion: 1,
    directoryFsyncProved: true,
    noFollowProved: true,
    symlinkAttackRejected: true,
    cleanupCompleted: true,
    cleanupResiduals: 0,
    filesystem: "ext2-ext3",
    durability: Object.fromEntries(DURABILITY_KEYS.map((key) => [key, true])),
    noFollow: Object.fromEntries(NOFOLLOW_KEYS.map((key) => [key, true]))
  };
}

function fakeSpawn(result, overrides = {}) {
  return (_command, _args, options) => {
    assert.deepEqual(JSON.parse(options.input), {
      runnerTemp: path.resolve("synthetic-runner-temp")
    });
    assert.equal(options.env.LANG, "C");
    assert.equal(options.env.LC_ALL, "C");
    return {
      status: 0,
      signal: null,
      error: null,
      stdout: `${JSON.stringify(result)}\n`,
      stderr: "",
      ...overrides
    };
  };
}

test("wrapper accepts only the complete, sanitized proof contract", () => {
  const expected = validResult();
  const actual = runLinuxDurabilityProof({
    runnerTemp: path.resolve("synthetic-runner-temp"),
    platform: "linux",
    spawnSyncImpl: fakeSpawn(expected)
  });
  assert.deepEqual(actual, expected);
});

test("proof contract fails closed for a missing, false, or additional field", () => {
  for (const mutation of [
    (value) => delete value.durability.fileFsync,
    (value) => {
      value.noFollow.intermediateSymlinkRejected = false;
    },
    (value) => {
      value.untrusted = true;
    },
    (value) => {
      value.noFollow.untrusted = true;
    },
    (value) => {
      value.cleanupResiduals = 1;
    },
    (value) => {
      value.filesystem = "/sensitive/path";
    },
    (value) => {
      value.filesystem = "tmpfs";
    }
  ]) {
    const value = validResult();
    mutation(value);
    assert.throws(() => validateProofShape(value), {
      code: "social_3a0p_linux_durability_evidence_invalid"
    });
  }
});

test("wrapper never forwards process output or exception details", () => {
  const sensitiveMarker = "SENSITIVE_MARKER_DO_NOT_ECHO";
  for (const spawnSyncImpl of [
    fakeSpawn(validResult(), { status: 1, stderr: sensitiveMarker }),
    fakeSpawn(validResult(), { stdout: sensitiveMarker }),
    () => {
      throw new Error(sensitiveMarker);
    }
  ]) {
    assert.throws(
      () =>
        runLinuxDurabilityProof({
          runnerTemp: path.resolve("synthetic-runner-temp"),
          platform: "linux",
          spawnSyncImpl
        }),
      (error) => {
        assert.equal(error.code, "social_3a0p_linux_durability_failed");
        assert.equal(String(error).includes(sensitiveMarker), false);
        return true;
      }
    );
  }
});

test("wrapper refuses unsupported platforms and noncanonical roots before spawn", () => {
  let calls = 0;
  const spawnSyncImpl = () => {
    calls += 1;
  };
  assert.throws(
    () =>
      runLinuxDurabilityProof({
        runnerTemp: path.resolve("synthetic-runner-temp"),
        platform: "win32",
        spawnSyncImpl
      }),
    { code: "social_3a0p_linux_durability_precondition_invalid" }
  );
  assert.throws(
    () =>
      runLinuxDurabilityProof({
        runnerTemp:
          path.resolve("synthetic-runner-temp") +
          path.sep +
          ".." +
          path.sep +
          "x",
        platform: "linux",
        spawnSyncImpl
      }),
    { code: "social_3a0p_linux_durability_precondition_invalid" }
  );
  assert.equal(calls, 0);
});

test("Python proof is syntax-valid and contains the required dir-fd primitives", (t) => {
  const sourcePath = path.join(
    __dirname,
    "..",
    "scripts",
    "social-3a0p-linux-durability.py"
  );
  const source = fs.readFileSync(sourcePath, "utf8");
  for (const required of [
    "os.O_EXCL",
    "os.O_NOFOLLOW",
    "dir_fd=",
    "os.fsync(",
    "os.rename(",
    "src_dir_fd=",
    "dst_dir_fd=",
    "follow_symlinks=False",
    "finalSymlinkRejected",
    "swappedBeforeOpenSymlinkRejected",
    "intermediateSymlinkRejected"
  ]) {
    assert.equal(source.includes(required), true, required);
  }

  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3"];
  let completed;
  for (const candidate of candidates) {
    const args =
      candidate === "py"
        ? ["-3", "-c", "import sys; compile(sys.stdin.read(), '<proof>', 'exec')"]
        : ["-c", "import sys; compile(sys.stdin.read(), '<proof>', 'exec')"];
    const result = spawnSync(candidate, args, {
      input: source,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000
    });
    if (!result.error && Number.isInteger(result.status)) {
      completed = result;
      break;
    }
  }
  if (!completed) {
    t.diagnostic("Python 3 unavailable locally; syntax execution is covered on Linux CI");
    return;
  }
  assert.equal(completed.status, 0, completed.stderr);
});

test(
  "physical Linux proof accepts a regular file, refuses all symlink attacks, and leaves zero residue",
  { skip: process.platform !== "linux" },
  (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-linux-proof-test-"));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const before = fs.readdirSync(parent);
    const result = runLinuxDurabilityProof({ runnerTemp: parent });
    assert.equal(result.directoryFsyncProved, true);
    assert.equal(result.noFollowProved, true);
    assert.equal(result.symlinkAttackRejected, true);
    assert.equal(result.noFollow.regularFileAccepted, true);
    assert.equal(result.noFollow.finalSymlinkRejected, true);
    assert.equal(result.noFollow.swappedBeforeOpenSymlinkRejected, true);
    assert.equal(result.noFollow.intermediateSymlinkRejected, true);
    assert.equal(result.noFollow.neverTraversed, true);
    assert.equal(result.cleanupCompleted, true);
    assert.equal(result.cleanupResiduals, 0);
    assert.deepEqual(fs.readdirSync(parent), before);
  }
);
