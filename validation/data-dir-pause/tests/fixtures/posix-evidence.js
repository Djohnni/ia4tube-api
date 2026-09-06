"use strict";

// Synthetic Linux laboratory only. No restore, shell, network, credential or
// deletion operations. Missing tools/filesystem support is a failure, not proof.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { TextDecoder } = require("node:util");
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const RESTORE = new RegExp(`^/tmp/ia4tube-linux-proof-(?:${UUID}|[a-f0-9]{32})/restored$`);
const IGNORE = new RegExp(`^\\.ia4tube-recovery-c/${UUID}$`);
const FORMAT = "ia4tube-linux-posix-evidence-v1";
const STAMP = "1700000000.123456789";
const STAMP_NS = "1700000000123456789";
const TOOLS = Object.freeze({ getfacl: "/usr/bin/getfacl", setfacl: "/usr/bin/setfacl",
  getfattr: "/usr/bin/getfattr", setfattr: "/usr/bin/setfattr", touch: "/usr/bin/touch" });
const SHA = /^[a-f0-9]{64}$/;
const MAX_ENTRIES = 256, MAX_BYTES = 16777216;
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function need(value, code) { if (!value) fail(code); }
function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function sorted(values) { return [...values].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))); }
function exact(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|"); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function regularRelative(value) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 1024 &&
    !/[\x00-\x1f\x7f\\]/.test(value) && (value === "." || (!value.startsWith("/") && value.split("/").every(part => part && part !== "." && part !== "..")));
}
async function allowedRoot(root, seed = false) {
  need(process.platform === "linux" && typeof process.getuid === "function", "posix_linux_required");
  need(typeof root === "string" && (root === "/var/data" || (!seed && RESTORE.test(root))), "posix_root_refused");
  need(await fsp.realpath(root) === root, "posix_root_redirected");
  const info = await fsp.lstat(root);
  need(info.isDirectory() && !info.isSymbolicLink(), "posix_root_invalid");
  return root;
}
function tool(name, args) {
  need(Object.hasOwn(TOOLS, name) && Array.isArray(args), "posix_tool_refused");
  return new Promise((resolve, reject) => {
    execFile(TOOLS[name], args, { shell: false, timeout: 10000, killSignal: "SIGKILL", maxBuffer: 131072,
      encoding: "utf8", env: { LANG: "C", LC_ALL: "C", TZ: "UTC" } }, (error, stdout, stderr) => {
      if (error || stderr.length) {
        const refusal = new Error(`posix_${name}_${error?.code === "ENOENT" ? "unavailable" : "failed"}`);
        refusal.code = refusal.message; reject(refusal);
      } else resolve(stdout);
    });
  });
}
function parseAcl(text) {
  need(typeof text === "string" && Buffer.byteLength(text) <= 65536, "posix_acl_invalid");
  const entries = text.split("\n").filter(Boolean);
  const pattern = /^(?:default:)?(?:(?:user|group):(?:[0-9]+)?:|(?:mask|other)::)[r-][w-][x-]$/;
  need(entries.length >= 3 && entries.length <= 64 && entries.every(line => pattern.test(line)) && new Set(entries).size === entries.length, "posix_acl_invalid");
  for (const basic of ["user::", "group::", "other::"]) need(entries.some(line => line.startsWith(basic)), "posix_acl_invalid");
  return sorted(entries);
}
function parseXattrs(text) {
  need(typeof text === "string" && Buffer.byteLength(text) <= 65536, "posix_xattrs_invalid");
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("# file: ")) continue;
    const match = /^([A-Za-z0-9_.-]+)=0x([a-fA-F0-9]*)$/.exec(line);
    need(match && match[2].length % 2 === 0 && rows.length < 64 && !rows.some(row => row.name === match[1]), "posix_xattrs_invalid");
    const bytes = Buffer.from(match[2], "hex");
    try { rows.push({ name: match[1], bytes: bytes.length, sha256: sha(bytes) }); }
    finally { bytes.fill(0); }
  }
  return rows.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
}
function witness(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), atimeNs: String(stat.atimeNs), ctimeNs: String(stat.ctimeNs) };
}
function stable(stat) { return { dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode), uid: String(stat.uid),
  gid: String(stat.gid), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) }; }
function coverage(rows) {
  return {
    aclRead: rows.length > 0 && rows.every(row => Array.isArray(row.acl) && row.acl.length >= 3),
    xattrsRead: rows.length > 0 && rows.every(row => Array.isArray(row.xattrs)),
    namedAclObserved: rows.some(row => row.acl?.includes("user:1003:r--")),
    userXattrObserved: rows.some(row => row.xattrs?.some(attr => attr.name === "user.ia4tube_fixture")),
    nanosecondMtimeObserved: rows.some(row => row.mtimeNs === STAMP_NS),
    emptyDirectoryObserved: rows.some(row => row.type === "directory" && row.path !== "." && !rows.some(other => other.path.startsWith(row.path + "/"))),
    mixedOwnershipObserved: rows.some(row => row.type === "file" && row.uid === 1001 && row.gid === 1002 && row.mode === "0640")
  };
}
async function snapshotEvidence(root, { ignore = [] } = {}) {
  await allowedRoot(root);
  need(Array.isArray(ignore) && ignore.length <= 1 && ignore.every(item => typeof item === "string" && IGNORE.test(item)), "posix_ignore_refused");
  const rows = [], observed = [], decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  async function visit(current, relative) {
    if (ignore.includes(relative)) return;
    need(rows.length < MAX_ENTRIES && regularRelative(relative), "posix_entry_refused");
    const before = await fsp.lstat(current, { bigint: true });
    need((before.isDirectory() || before.isFile()) && !before.isSymbolicLink(), "posix_special_refused");
    const row = { path: relative, type: before.isFile() ? "file" : "directory", mode: Number(before.mode & 0o7777n).toString(8).padStart(4, "0"),
      uid: Number(before.uid), gid: Number(before.gid), mtimeNs: String(before.mtimeNs),
      acl: parseAcl(await tool("getfacl", ["--omit-header", "--numeric", "--absolute-names", "--no-effective", "--", current])),
      xattrs: parseXattrs(await tool("getfattr", ["--dump", "--match=-", "--encoding=hex", "--absolute-names", "--", current])) };
    if (before.isFile()) {
      need(before.nlink === 1n && before.size <= BigInt(MAX_BYTES - totalBytes), "posix_file_limit");
      const handle = await fsp.open(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const buffer = Buffer.alloc(65536), hash = crypto.createHash("sha256");
      try {
        need(same(stable(before), stable(await handle.stat({ bigint: true }))), "posix_source_changed");
        let count = 0;
        while (true) { const read = await handle.read(buffer, 0, buffer.length, count); if (!read.bytesRead) break; hash.update(buffer.subarray(0, read.bytesRead)); count += read.bytesRead; need(count <= MAX_BYTES - totalBytes, "posix_file_limit"); }
        need(BigInt(count) === before.size && same(stable(before), stable(await handle.stat({ bigint: true }))), "posix_source_changed");
        row.bytes = count; row.sha256 = hash.digest("hex"); totalBytes += count;
      } finally { buffer.fill(0); await handle.close(); }
    }
    rows.push(row); observed.push({ path: relative, ...witness(before) });
    if (before.isDirectory()) {
      const names = (await fsp.readdir(current, { encoding: "buffer" })).sort(Buffer.compare);
      for (const name of names) {
        let decoded; try { decoded = decoder.decode(name); } catch (_) { fail("posix_name_encoding_refused"); }
        need(Buffer.from(decoded).equals(name), "posix_name_encoding_refused");
        await visit(path.join(current, decoded), relative === "." ? decoded : relative + "/" + decoded);
      }
    }
    need(same(stable(before), stable(await fsp.lstat(current, { bigint: true }))), "posix_source_changed");
  }
  await visit(root, ".");
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  observed.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { format: FORMAT, precision: "stat-mtime-nanoseconds-exact", rows, observationsOnly: observed,
    observationLimit: "dev/ino/atime/ctime are observed, not compared as restorable properties", excludedSubtrees: [...ignore],
    totals: { files: rows.filter(row => row.type === "file").length, directories: rows.filter(row => row.type === "directory").length, bytes: totalBytes }, coverage: coverage(rows) };
}
function validateEvidence(evidence) {
  need(evidence?.format === FORMAT && evidence.precision === "stat-mtime-nanoseconds-exact" && Array.isArray(evidence.rows) && evidence.rows.length > 0 && evidence.rows.length <= MAX_ENTRIES, "posix_evidence_invalid");
  need(Array.isArray(evidence.excludedSubtrees) && evidence.excludedSubtrees.length <= 1 && evidence.excludedSubtrees.every(item => typeof item === "string" && IGNORE.test(item)), "posix_evidence_invalid");
  const names = new Set(); let bytes = 0;
  for (const row of evidence.rows) {
    need(row && ["file", "directory"].includes(row.type), "posix_evidence_invalid");
    need(exact(row, ["path", "type", "mode", "uid", "gid", "mtimeNs", "acl", "xattrs", ...(row.type === "file" ? ["bytes", "sha256"] : [])]), "posix_evidence_invalid");
    need(regularRelative(row.path) && !names.has(row.path) && typeof row.mode === "string" && /^[0-7]{4}$/.test(row.mode) &&
      Number.isSafeInteger(row.uid) && row.uid >= 0 && Number.isSafeInteger(row.gid) && row.gid >= 0 && typeof row.mtimeNs === "string" && /^[0-9]+$/.test(row.mtimeNs), "posix_evidence_invalid");
    need(Array.isArray(row.acl) && same(parseAcl(row.acl.join("\n")), row.acl) && Array.isArray(row.xattrs) && row.xattrs.length <= 64, "posix_evidence_invalid");
    const attrNames = [];
    for (const attr of row.xattrs) {
      need(exact(attr, ["name", "bytes", "sha256"]) && typeof attr.name === "string" && /^[A-Za-z0-9_.-]+$/.test(attr.name) &&
        Number.isSafeInteger(attr.bytes) && attr.bytes >= 0 && typeof attr.sha256 === "string" && SHA.test(attr.sha256), "posix_evidence_invalid");
      attrNames.push(attr.name);
    }
    need(new Set(attrNames).size === attrNames.length && same(sorted(attrNames), attrNames), "posix_evidence_invalid");
    if (row.type === "file") { need(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && typeof row.sha256 === "string" && SHA.test(row.sha256), "posix_evidence_invalid"); bytes += row.bytes; }
    names.add(row.path);
  }
  need(evidence.rows[0].path === "." && evidence.rows[0].type === "directory" && same(sorted(names), evidence.rows.map(row => row.path)) && bytes <= MAX_BYTES, "posix_evidence_invalid");
  for (const row of evidence.rows) if (row.path !== ".") need(evidence.rows.some(parent => parent.path === path.posix.dirname(row.path) && parent.type === "directory"), "posix_evidence_invalid");
  need(same(evidence.coverage, coverage(evidence.rows)) && same(evidence.totals, { files: evidence.rows.filter(row => row.type === "file").length,
    directories: evidence.rows.filter(row => row.type === "directory").length, bytes }), "posix_evidence_invalid");
  return true;
}
function compareEvidence(before, restored) {
  validateEvidence(before); validateEvidence(restored);
  const differences = [];
  const beforeMap = new Map(before.rows.map(row => [row.path, row])), afterMap = new Map(restored.rows.map(row => [row.path, row]));
  for (const relative of sorted(new Set([...beforeMap.keys(), ...afterMap.keys()]))) {
    const a = beforeMap.get(relative), b = afterMap.get(relative);
    if (!a || !b) { differences.push({ path: relative, fields: [!a ? "unexpected" : "missing"] }); continue; }
    const fields = sorted(new Set([...Object.keys(a), ...Object.keys(b)])).filter(field => !same(a[field], b[field]));
    if (fields.length) differences.push({ path: relative, fields });
  }
  const coverageComplete = Object.values(before.coverage).every(value => value === true) && Object.values(restored.coverage).every(value => value === true);
  return { passed: differences.length === 0 && coverageComplete, differences, coverageComplete, beforeTotals: before.totals, restoredTotals: restored.totals,
    compared: ["relative path", "type", "file bytes/SHA256", "mode", "numeric UID/GID", "mtime nanoseconds", "numeric POSIX ACL", "xattr name/bytes/SHA256"],
    excludedFromRestoreEquality: ["dev", "ino", "atime", "ctime"] };
}
async function seedData(root = "/var/data") {
  await allowedRoot(root, true);
  need(process.getuid() === 0 && (await fsp.readdir(root)).length === 0, "posix_seed_requires_empty_root_uid0");
  const directories = ["pedidos", "planejamentos_mensais", "materiais_graficos", "carrosseis", "empty directory", "nested", "nested/empty child"];
  for (const relative of directories) await fsp.mkdir(path.join(root, relative), { mode: relative === "nested" ? 0o750 : 0o700 });
  const files = [["owned file.txt", Buffer.from("IA4Tube POSIX synthetic fixture v1\n")], ["nested/binary fixture.bin", Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256))],
    ["zero bytes.txt", Buffer.alloc(0)], ["synthetic-ongoing.txt", Buffer.from("synthetic writer has not run\n")]];
  for (const [relative, bytes] of files) {
    const handle = await fsp.open(path.join(root, relative), "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { bytes.fill(0); await handle.close(); }
  }
  const owned = path.join(root, "owned file.txt"), nested = path.join(root, "nested");
  // Set the user xattr while root still owns the writable inode. Later the
  // explicit read ACL allows UID0 capture without CAP_DAC_OVERRIDE.
  await tool("setfattr", ["--name=user.ia4tube_fixture", "--value=synthetic-metadata-v1", "--", owned]);
  await fsp.chown(owned, 1001, 1002); await fsp.chmod(owned, 0o640);
  await tool("setfacl", ["--modify=user:0:r--,user:1003:r--", "--", owned]);
  await tool("setfacl", ["--modify=default:user::rwx,default:user:1003:r-x,default:group::r-x,default:mask::r-x,default:other::---", "--", nested]);
  await tool("setfattr", ["--name=user.ia4tube_fixture", "--value=synthetic-directory-v1", "--", nested]);
  for (const relative of [...files.map(([name]) => name), ...[...directories].reverse(), "."]) {
    await tool("touch", ["--no-dereference", `--date=@${STAMP}`, "--", relative === "." ? root : path.join(root, relative)]);
  }
  const evidence = await snapshotEvidence(root);
  need(Object.values(evidence.coverage).every(value => value === true), "posix_seed_metadata_not_observed");
  return { format: "ia4tube-linux-posix-seed-v1", seededPaths: sorted([...directories, ...files.map(([name]) => name)]), totals: evidence.totals,
    requestedMtimeNs: STAMP_NS, observedCoverage: evidence.coverage, evidence };
}
function mountToken(value) {
  return value.replace(/\\(040|011|012|134)/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
}
function parseMountInfo(text, root) {
  need(typeof text === "string" && typeof root === "string" && root.startsWith("/") && Buffer.byteLength(text) <= 4194304, "posix_mountinfo_invalid");
  const matches = [];
  for (const line of text.trim().split("\n")) {
    const separator = line.indexOf(" - "); need(separator > 0, "posix_mountinfo_invalid");
    const fields = line.slice(0, separator).split(" "), tail = line.slice(separator + 3).split(" ");
    need(fields.length >= 6 && tail.length === 3, "posix_mountinfo_invalid");
    const mountPoint = mountToken(fields[4]);
    if (mountPoint === "/" || root === mountPoint || root.startsWith(mountPoint + "/")) matches.push({ mountPoint, filesystemType: tail[0], mountOptions: sorted(fields[5].split(",")), superOptions: sorted(tail[2].split(",")) });
  }
  need(matches.length > 0, "posix_mountinfo_unresolved");
  matches.sort((a, b) => b.mountPoint.length - a.mountPoint.length);
  need(matches.length === 1 || matches[0].mountPoint.length !== matches[1].mountPoint.length, "posix_mountinfo_ambiguous");
  return matches[0];
}
async function filesystemEvidence(root) {
  await allowedRoot(root);
  const stat = await fsp.statfs(root, { bigint: true });
  const mount = parseMountInfo(await fsp.readFile("/proc/self/mountinfo", "utf8"), root);
  return { format: "ia4tube-linux-filesystem-observation-v1", ...mount,
    statfs: { typeHex: "0x" + stat.type.toString(16), blockSize: String(stat.bsize), blocks: String(stat.blocks), blocksFree: String(stat.bfree), blocksAvailable: String(stat.bavail), files: String(stat.files), filesFree: String(stat.ffree) },
    volatileTmpfs: mount.filesystemType === "tmpfs", durableAcrossContainerRemoval: false, renderDiskEquivalenceProven: false,
    limitation: "This describes the synthetic executor mount only; successful fsync/restore is not proof of power-loss durability or equivalence to the Render disk." };
}

module.exports = { seedData, snapshotEvidence, compareEvidence, filesystemEvidence, parseAcl, parseXattrs, parseMountInfo, validateEvidence };
