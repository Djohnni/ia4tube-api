"use strict";

// Pure parser/comparison tests only: no GNU tools, filesystem fixtures, Linux
// process, server, network, real DATA_DIR or restoration is executed here.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAcl, parseXattrs, parseMountInfo, validateEvidence, compareEvidence } = require("./fixtures/posix-evidence");
function sample() {
  const base = { type: "directory", mode: "0700", uid: 0, gid: 0, mtimeNs: "1700000000123456789",
    acl: parseAcl("user::rwx\ngroup::---\nother::---\n"), xattrs: [] };
  const rows = [{ path: ".", ...structuredClone(base) }, { path: "empty directory", ...structuredClone(base) },
    { path: "owned file.txt", type: "file", mode: "0640", uid: 1001, gid: 1002, mtimeNs: "1700000000123456789",
      acl: parseAcl("user::rw-\nuser:0:r--\nuser:1003:r--\ngroup::r--\nmask::r--\nother::---\n"),
      xattrs: [{ name: "user.ia4tube_fixture", bytes: 3, sha256: "b".repeat(64) }], bytes: 3, sha256: "a".repeat(64) }];
  return { format: "ia4tube-linux-posix-evidence-v1", precision: "stat-mtime-nanoseconds-exact", rows,
    excludedSubtrees: [], observationsOnly: [{ path: ".", dev: "11", ino: "42", atimeNs: "1", ctimeNs: "2" }],
    totals: { files: 1, directories: 2, bytes: 3 }, coverage: { aclRead: true, xattrsRead: true,
      namedAclObserved: true, userXattrObserved: true, nanosecondMtimeObserved: true, emptyDirectoryObserved: true, mixedOwnershipObserved: true } };
}

test("numeric ACL parser preserves named/default entries without path or effective comments", () => {
  assert.deepEqual(parseAcl("user::rwx\ngroup::r-x\nother::---\nuser:1003:r--\ndefault:user::rwx\n"),
    ["default:user::rwx", "group::r-x", "other::---", "user:1003:r--", "user::rwx"]);
  for (const text of ["", "# file: /var/data\n", "user::rwx\ngroup::r-x\nother::---\nuser:bob:r--\n",
    "user::rwx\ngroup::r-x\nother::---\nuser::rwx\n", "user::rwx\ngroup::r-x\nother::---\nuser:1003:r-- #effective:---\n"]) assert.throws(() => parseAcl(text));
});

test("xattrs report names, lengths and hashes, never the synthetic value bytes", () => {
  const result = parseXattrs("# file: /var/data/owned file.txt\nuser.ia4tube_fixture=0x616263\n\n");
  assert.deepEqual(result, [{ name: "user.ia4tube_fixture", bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" }]);
  assert.ok(!JSON.stringify(result).includes("616263"));
  assert.deepEqual(parseXattrs(""), []);
  for (const text of ["user.x=0x1", "user.x=hello", "user.x=0x00\nuser.x=0x00", "user.x=0xgg"]) assert.throws(() => parseXattrs(text));
});

test("mount evidence selects the actual deepest mount and preserves flags", () => {
  const source = "25 0 0:1 / / rw,relatime - overlay overlay rw\n30 25 0:2 / /var/data rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=3145728k\n";
  assert.deepEqual(parseMountInfo(source, "/var/data"), { mountPoint: "/var/data", filesystemType: "tmpfs",
    mountOptions: ["nodev", "noexec", "nosuid", "relatime", "rw"], superOptions: ["rw", "size=3145728k"] });
  assert.equal(parseMountInfo(source, "/var/data-other").filesystemType, "overlay");
  assert.equal(parseMountInfo("31 25 0:3 / /tmp/with\\040space rw - tmpfs tmpfs rw\n", "/tmp/with space").mountPoint, "/tmp/with space");
  assert.throws(() => parseMountInfo(source + "31 25 0:3 / /var/data rw - tmpfs tmpfs rw\n", "/var/data"), /ambiguous/);
  assert.throws(() => parseMountInfo("malformed", "/var/data"));
});

test("restore equality includes all restorable evidence but excludes inode and access/change times", () => {
  const before = sample(), after = structuredClone(before);
  after.observationsOnly = [{ path: ".", dev: "99", ino: "999", atimeNs: "999", ctimeNs: "999" }];
  assert.equal(validateEvidence(before), true);
  assert.equal(compareEvidence(before, after).passed, true);
  before.excludedSubtrees = [".ia4tube-recovery-c/11111111-1111-4111-8111-111111111111"];
  assert.equal(compareEvidence(before, after).passed, true);
});

test("single-byte hash, xattr hash, ACL and nanosecond mtime changes cannot pass", () => {
  for (const [field, update] of [
    ["sha256", row => { row.sha256 = "c".repeat(64); }],
    ["xattrs", row => { row.xattrs[0].sha256 = "c".repeat(64); }],
    ["acl", row => { row.acl = parseAcl("user::rw-\nuser:0:r--\nuser:1003:r--\ngroup::---\nmask::r--\nother::---\n"); }],
    ["mtimeNs", row => { row.mtimeNs = "1700000000123456790"; }]
  ]) {
    const before = sample(), after = structuredClone(before); update(after.rows[2]);
    const result = compareEvidence(before, after); assert.equal(result.passed, false);
    assert.deepEqual(result.differences, [{ path: "owned file.txt", fields: [field] }]);
  }
});

test("missing mixed ownership/ACL/xattr coverage cannot be forged as true", () => {
  for (const change of [value => { value.rows[2].uid = 0; }, value => { value.rows[2].mode = "0600"; },
    value => { value.rows[2].xattrs = []; }, value => { value.rows[2].acl = parseAcl("user::rw-\ngroup::r--\nother::---\n"); }]) {
    const value = sample(); change(value); assert.throws(() => validateEvidence(value));
  }
  const emptyCoverage = sample(); emptyCoverage.rows[2].xattrs = []; emptyCoverage.coverage.userXattrObserved = false;
  assert.equal(compareEvidence(emptyCoverage, structuredClone(emptyCoverage)).passed, false);
});

test("pure validator refuses malformed rows, counts, paths, exclusions and weak precision", () => {
  for (const change of [value => { value.precision = "seconds"; }, value => { value.rows[2].mode = ["0640"]; },
    value => { value.rows[2].path = "../escape"; }, value => { value.rows[2].path = "missing/file"; },
    value => { value.rows[2].sha256 = ["a".repeat(64)]; }, value => { value.totals.bytes++; },
    value => { value.rows[2].gid = "1002"; }, value => { value.rows.push(structuredClone(value.rows[2])); },
    value => { value.excludedSubtrees = ["."]; }, value => { value.rows[2].dev = "999"; },
    value => { value.rows[2].xattrs.push(structuredClone(value.rows[2].xattrs[0])); }]) {
    const value = sample(); change(value); assert.throws(() => validateEvidence(value));
  }
});
