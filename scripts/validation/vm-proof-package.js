"use strict";
// Reproducible source-only archive. Provider controller/credentials are not part
// of the guest bundle. No .git, outputs, media, user data, niches or node_modules.
const fs = require("node:fs/promises"), path = require("node:path"), tar = require("tar-stream");
const { MANIFEST, sha256, canonical } = require("./vm-proof-manifest");
const ROOTS = ["src/social", "src/persistence", "db/calendar-migrations", "db/migrations", "tests/helpers", "tests/fixtures", "scripts/media-vm"];
// Explicit additional text dependencies, not an unrestricted extension policy.
// The Windows supervisor remains source only; the Linux installer never builds it.
const EXTRA_TEXT = new Set(["tests/helpers/create-local-tls-fixture.py", "src/social/production-web/reviewer.html",
  "src/social/production-web/reviewer.css", "src/social/calendar/imports/media-process-supervisor.cs"]);
const FIXED = ["package.json", "package-lock.json", MANIFEST.testFile, "scripts/validation/vm-proof-manifest.js", "scripts/validation/vm-proof-guest.js",
  "workflows/calendar-media-vm.cjs", "workflows/calendar-media.mjs", "tests/calendar-vm-private-physical.test.js"];
function fail(code) { throw new Error("vm_proof_package_" + code); }
async function collectFiles(root) {
  const result = [];
  async function visit(relative) {
    if (relative.split("/").some(n => n.startsWith(".") || /^(outputs|node_modules|data|nichos)$/.test(n))) fail("source_scope_invalid");
    const file = path.join(root, ...relative.split("/")), st = await fs.lstat(file);
    if (st.isSymbolicLink()) fail("source_link_forbidden");
    if (st.isDirectory()) { for (const name of (await fs.readdir(file)).sort()) await visit(relative + "/" + name); }
    else if (st.isFile()) {
      if ((!/\.(?:js|mjs|cjs|c|h|json|sql|sh|md)$/.test(relative) && !EXTRA_TEXT.has(relative)) || st.size > 2 * 1024 * 1024) fail("source_type_invalid");
      const original = await fs.readFile(file), text = original.toString("utf8");
      if (text.includes("\u0000") || !Buffer.from(text, "utf8").equals(original)) fail("source_not_utf8_text");
      // Source-only package: normalize CRLF to LF for equal Linux/Windows
      // bytes. Hashes describe the normalized files actually extracted.
      const data = Buffer.from(text.replaceAll("\r\n", "\n")); result.push({ relative, data });
    } else fail("source_type_invalid");
  }
  for (const relative of [...ROOTS, ...FIXED]) await visit(relative);
  result.sort((a, b) => a.relative.localeCompare(b.relative, "en"));
  if (new Set(result.map(r => r.relative)).size !== result.length || result.length > 1000) fail("source_list_invalid");
  return result;
}
async function buildPackage(root) {
  const rows = await collectFiles(root), pack = tar.pack(), chunks = [];
  let bytes = 0;
  const done = new Promise((resolve, reject) => { pack.on("data", b => { bytes += b.length; if (bytes > 64 * 1024 * 1024) { pack.destroy(new Error("vm_proof_package_too_large")); return; } chunks.push(b); });
    pack.on("error", reject); pack.on("end", () => resolve(Buffer.concat(chunks))); });
  const index = { schema: 1, syntheticOnly: true, containsProviderController: false,
    files: rows.map(r => ({ path: r.relative, bytes: r.data.length, sha256: sha256(r.data) })) };
  const add = (name, data) => new Promise((resolve, reject) => pack.entry({ name, size: data.length, type: "file", uid: 0, gid: 0,
    uname: "root", gname: "root", mtime: new Date(0), mode: name.endsWith(".sh") ? 0o755 : 0o644 }, data, e => e ? reject(e) : resolve()));
  await add("BUNDLE-MANIFEST.json", Buffer.from(canonical(index)));
  for (const r of rows) await add(r.relative, r.data);
  pack.finalize();
  return { bytes: await done, index };
}
module.exports = { buildPackage, collectFiles };
