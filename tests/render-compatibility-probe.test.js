"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), { pathToFileURL } = require("node:url");
const probe = import(pathToFileURL(path.join(__dirname, "../workflows/render-compatibility-probe.mjs")));
const root = "/sys/fs/cgroup/ia4tube-media-synthetic-probe";
const status = "CapEff:\t00000000002001c1\nCapBnd:\t00000000002001c1\nNoNewPrivs:\t0\nSeccomp:\t2\n";
const mounts = "10 1 0:1 / /sys/fs/cgroup rw,nosuid,nodev,noexec - cgroup2 cgroup rw\n";
function fixture(overrides = {}) {
  const reads = [], metadataReads = [], files = { "/proc/self/status": status, "/proc/self/mountinfo": mounts,
    "/sys/fs/cgroup/cgroup.controllers": "cpuset cpu io memory pids\n", [root + "/cgroup.subtree_control"]: "cpu memory pids\n" };
  const host = { platform: "linux", uid: 1001, gid: 1001, effectiveUid: 1001, effectiveGid: 1001, cgroupRoot: root,
    readText: async p => { reads.push(p); if (!(p in files)) throw Error("private missing filename"); return files[p]; },
    metadata: async p => { metadataReads.push(p); return { isDirectory: true, isSymbolicLink: false, canonical: true, ownerRoot: true, writableByGroupOrOther: false }; }, ...overrides };
  return { host, files, reads, metadataReads };
}
test("probe task is Flex, bounded to60s, no retries and requires zero task input", async () => {
  const { PROBE_TASK_OPTIONS, registerCompatibilityProbe } = await probe;
  assert.deepEqual(PROBE_TASK_OPTIONS, { name: "compatibilityProbe", plan: "flex", timeoutSeconds: 60, retry: { maxRetries: 0 } });
  assert.ok(Object.isFrozen(PROBE_TASK_OPTIONS)); assert.ok(Object.isFrozen(PROBE_TASK_OPTIONS.retry));
  let func, called = 0; registerCompatibilityProbe((opts, fn) => { func = fn; assert.equal(opts, PROBE_TASK_OPTIONS); }, async () => { called++; return { marker: true }; });
  assert.equal(called, 0, "Registration must not collect host evidence or execute work");
  assert.deepEqual(await func({}), { marker: true });
  const rejected = await func({}, { arbitraryPath: "secret", command: "secret" });
  assert.deepEqual(rejected.issues, ["INVALID_INPUT"]); assert.equal(called, 1); assert.ok(!JSON.stringify(rejected).includes("secret"));
});
test("unsupported local platform returns before reading any system files", async () => {
  const { collectCompatibility } = await probe, f = fixture({ platform: "win32" });
  assert.deepEqual((await collectCompatibility(f.host)).issues, ["PLATFORM_UNSUPPORTED"]); assert.equal(f.reads.length, 0);
});
test("all positive read-only evidence still requires native proof and never asserts compatibility", async () => {
  const { collectCompatibility } = await probe, f = fixture(), r = await collectCompatibility(f.host);
  assert.equal(r.state, "NATIVE_PROBE_REQUIRED"); assert.deepEqual(r.issues, []);
  assert.equal(r.checks.effectiveSysAdmin, true); assert.equal(r.checks.delegationControllersEnabled, true);
  for (const value of Object.values(r.checks)) assert.equal(typeof value, "boolean");
  for (const key of ["runtimeCompatibleProved", "physicalNativeProbeExecuted", "launcherVerified", "filesystemChanged", "mediaExecuted", "remoteCallsMade"]) assert.equal(r[key], false);
  assert.equal(f.reads.length, 4); assert.deepEqual(f.metadataReads, [root]);
});
test("root coordinator is not substituted for required privilege separation", async () => {
  const { collectCompatibility } = await probe;
  for (const override of [{ uid: 0 }, { gid: 0 }, { effectiveUid: 0 }, { effectiveGid: 0 }]) {
    const f = fixture(override); assert.ok((await collectCompatibility(f.host)).issues.includes("COORDINATOR_MUST_BE_NONROOT"));
  }
});
test("read-only cgroup mount is distinguished from undelegated configuration", async () => {
  const { collectCompatibility } = await probe, f = fixture({ cgroupRoot: undefined });
  f.files["/proc/self/mountinfo"] = mounts.replace("rw,nosuid", "ro,nosuid");
  f.files["/proc/self/status"] = status.replaceAll("00000000002001c1", "0000000000000000");
  const r = await collectCompatibility(f.host);
  assert.ok(r.issues.includes("CGROUP_MOUNT_READ_ONLY")); assert.ok(r.issues.includes("DELEGATION_NOT_CONFIGURED"));
  assert.equal(r.checks.effectiveSysAdmin, false); assert.equal(f.metadataReads.length, 0);
});
test("superblock read-only also fails observed writable requirement", async () => {
  const { collectCompatibility } = await probe, f = fixture(); f.files["/proc/self/mountinfo"] = mounts.replace("cgroup rw", "cgroup ro");
  assert.ok((await collectCompatibility(f.host)).issues.includes("CGROUP_MOUNT_READ_ONLY"));
});
test("untrusted configuration path is rejected without following it", async () => {
  const { collectCompatibility } = await probe;
  for (const value of ["/sys/fs/cgroup", root + "/../secret", "https://private", "C:/private", { value: "secret" }]) {
    const f = fixture({ cgroupRoot: value }), r = await collectCompatibility(f.host);
    assert.ok(r.issues.includes("DELEGATION_CONFIGURATION_INVALID")); assert.equal(f.metadataReads.length, 0);
    assert.ok(!JSON.stringify(r).includes("private")); assert.ok(!JSON.stringify(r).includes("secret"));
  }
});
test("unsafe symlink, writable or non-root delegation metadata stops further reads", async () => {
  const { collectCompatibility } = await probe;
  for (const change of [{ isSymbolicLink: true }, { canonical: false }, { ownerRoot: false }, { writableByGroupOrOther: true }, { isDirectory: false }]) {
    const f = fixture({ metadata: async () => ({ isDirectory: true, isSymbolicLink: false, canonical: true, ownerRoot: true, writableByGroupOrOther: false, ...change }) });
    const r = await collectCompatibility(f.host); assert.ok(r.issues.includes("DELEGATION_UNSAFE_METADATA")); assert.equal(f.reads.length, 3);
  }
});
test("missing controllers cannot be matched by substring and do not cause writes", async () => {
  const { collectCompatibility } = await probe, f = fixture();
  f.files["/sys/fs/cgroup/cgroup.controllers"] = "cpuset memory pids";
  f.files[root + "/cgroup.subtree_control"] = "cpu memory pids_extra";
  const r = await collectCompatibility(f.host);
  assert.ok(r.issues.includes("CGROUP_CONTROLLERS_UNAVAILABLE")); assert.ok(r.issues.includes("DELEGATION_CONTROLLERS_NOT_ENABLED"));
});
test("unreadable or malformed host evidence emits no raw errors or file contents", async () => {
  const { collectCompatibility } = await probe, f = fixture();
  f.files["/proc/self/status"] = "private-token";
  f.files["/proc/self/mountinfo"] = "private-mount-path";
  f.host.metadata = async () => { throw Error("private-password"); };
  const r = await collectCompatibility(f.host), encoded = JSON.stringify(r);
  assert.ok(r.issues.includes("HOST_EVIDENCE_INCOMPLETE")); assert.ok(r.issues.includes("DELEGATION_NOT_AVAILABLE"));
  assert.ok(!encoded.includes("private")); assert.ok(!encoded.includes(root));
});
test("oversized kernel text and an unexpected collection error fail with closed results", async () => {
  const { collectCompatibility, registerCompatibilityProbe } = await probe, f = fixture({ readText: async () => "s".repeat(131073) });
  assert.ok((await collectCompatibility(f.host)).issues.includes("HOST_EVIDENCE_INCOMPLETE"));
  let func; registerCompatibilityProbe((_, fn) => { func = fn; }, async () => { throw Error("private fault detail"); });
  const r = await func({}); assert.deepEqual(r.issues, ["HOST_EVIDENCE_INCOMPLETE"]); assert.ok(!JSON.stringify(r).includes("private"));
});
