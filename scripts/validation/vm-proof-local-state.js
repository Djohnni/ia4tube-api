"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), net = require("node:net"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
function fail(code) { throw Object.assign(new Error("vm_proof_" + code), { code: "vm_proof_" + code }); }
async function protectedPath(file, { directory = false } = {}) {
  const st = await fs.lstat(file);
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile())) fail("protected_path_invalid");
  if (process.platform === "win32") {
    // No content is read by PowerShell and no path or ACL is printed. ACLs are
    // checked, never weakened. Caller must prepare a protected external folder.
    const script = '$ErrorActionPreference="Stop"; try { $a=Get-Acl -LiteralPath $env:IA4TUBE_VM_PROTECTED_PATH; $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if (-not $a.AreAccessRulesProtected) { exit 2 }; if ($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin @($me,"S-1-5-18","S-1-5-32-544")) { exit 5 }; foreach($r in $a.Access) { if($r.AccessControlType -eq "Allow") { $sid=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if($sid -notin @($me,"S-1-5-18","S-1-5-32-544")) { exit 3 } } }; exit 0 } catch { exit 4 }';
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { shell: false, windowsHide: true, stdio: "ignore", timeout: 10000, env: { SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH, IA4TUBE_VM_PROTECTED_PATH: path.resolve(file) } });
    if (r.status !== 0) fail("protected_acl_required");
  } else if (st.uid !== process.getuid() || (st.mode & 0o077)) fail("protected_mode_required");
  return st;
}
async function protectCreatedFile(file) {
  // Only call for a file this operation has just created inside the already
  // protected external directory. Never change an existing provider credential.
  if (process.platform !== "win32") await fs.chmod(file, 0o600);
  else {
    // Persist only the DACL of our newly created file. Set-Acl with a fresh
    // security descriptor can request SACL/owner privileges unavailable to a
    // normal Windows user. Do not request elevation or weaken the validator.
    // The owner remains unchanged and is independently checked below.
    const script = '$ErrorActionPreference="Stop"; try { $p=$env:IA4TUBE_VM_PROTECTED_PATH; $f=Get-Item -LiteralPath $p -Force; if($f.PSIsContainer -or ($f.Attributes -band [IO.FileAttributes]::ReparsePoint)) { exit 5 }; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $a=New-Object System.Security.AccessControl.FileSecurity; $a.SetSecurityDescriptorSddlForm(("D:P(A;;FA;;;"+$sid+")(A;;FA;;;SY)"),[System.Security.AccessControl.AccessControlSections]::Access); $f.SetAccessControl($a); exit 0 } catch { exit 4 }';
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { shell: false, windowsHide: true,
      stdio: "ignore", timeout: 10000, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, IA4TUBE_VM_PROTECTED_PATH: path.resolve(file) } });
    if (r.status !== 0) fail("new_file_protection_failed");
  }
  await protectedPath(file);
}
async function externalRoot(directory) {
  const absolute = path.resolve(directory), actual = await fs.realpath(absolute);
  const repo = path.resolve(__dirname, "../..");
  const rel = path.relative(repo, actual);
  if (!rel || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))) fail("state_must_be_external");
  // Outputs/Git are never an acceptable credential or lifecycle location,
  // including a second workspace's output directory.
  if (actual.split(/[\\/]/).some(v => ["outputs", ".git"].includes(v.toLowerCase()))) fail("state_must_be_external");
  await protectedPath(actual, { directory: true });
  return actual;
}
async function syncDirectory(directory) {
  if (process.platform === "win32") return; // FileHandle.sync flushes file bytes; no directory-fsync assertion on Windows.
  const dir = await fs.open(directory, "r"); try { await dir.sync(); } finally { await dir.close(); }
}
async function atomicWrite(file, value) {
  const temporary = file + ".new-" + crypto.randomUUID();
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await protectCreatedFile(temporary);
  await fs.rename(temporary, file); await syncDirectory(path.dirname(file));
}
async function createLocalStore(directory) {
  const root = await externalRoot(directory), file = path.join(root, "lifecycle.jsonl");
  let locked = false;
  let previous = "0".repeat(64), revision = 0;
  async function readFrames() {
    try {
      const st = await fs.lstat(file); if (!st.isFile() || st.isSymbolicLink() || st.size > 8 * 1024 * 1024) fail("journal_file_invalid");
      await protectedPath(file);
      const bytes = await fs.readFile(file, "utf8");
      // Never fall back to an older 'prepared' snapshot after a damaged intent.
      // Incomplete/modified tails block creation and require explicit recovery.
      if (!bytes.endsWith("\n")) fail("journal_incomplete_no_repeat");
      let last = null; previous = "0".repeat(64); revision = 0;
      for (const line of bytes.trimEnd().split("\n")) {
        const r = JSON.parse(line), payload = JSON.stringify({ revision: r.revision, previous: r.previous, state: r.state });
        if (r.revision !== revision + 1 || r.previous !== previous || r.hash !== crypto.createHash("sha256").update(payload).digest("hex")) fail("journal_chain_invalid");
        revision = r.revision; previous = r.hash; last = r.state;
      }
      let marker;
      try { const markerFile = path.join(root, "session-marker.json"), markerStat = await protectedPath(markerFile);
        if (markerStat.size > 4096) fail("session_marker_invalid");
        marker = JSON.parse(await fs.readFile(markerFile, "utf8")); }
      catch { fail("session_marker_missing_or_invalid"); }
      if (marker.missionId !== last.missionId || marker.planSha256 !== last.planSha256) fail("session_marker_mismatch");
      return last;
    } catch (e) {
      if (e.code === "ENOENT") {
        // Missing lifecycle after a session existed is NOT a new operation.
        try { await fs.lstat(path.join(root, "session-marker.json")); fail("journal_missing_no_repeat"); }
        catch (missing) { if (missing.code !== "ENOENT") throw missing; }
        previous = "0".repeat(64); revision = 0; return null;
      }
      throw e;
    }
  }
  // The OS releases this exclusive loopback listener after process death. It
  // avoids deleting a stale PID lock (PID reuse) or blindly stealing a lock.
  // A collision only blocks a second controller; it can never grant ownership.
  const port = 30000 + crypto.createHash("sha256").update(root.toLowerCase()).digest().readUInt32BE(0) % 25000;
  return {
    root,
    async read() {
      if (!locked) fail("exclusive_controller_required");
      return readFrames();
    },
    async write(value) {
      if (!locked) fail("exclusive_controller_required");
      await readFrames();
      if (revision === 0) {
        const marker = await fs.open(path.join(root, "session-marker.json"), "wx", 0o600);
        try { await marker.writeFile(JSON.stringify({ schema: 1, missionId: value.missionId, planSha256: value.planSha256 })); await marker.sync(); }
        finally { await marker.close(); }
        await protectCreatedFile(path.join(root, "session-marker.json"));
        await syncDirectory(root);
      }
      const payload = { revision: revision + 1, previous, state: value };
      const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      const handle = await fs.open(file, revision === 0 ? "wx" : "a", 0o600);
      try { await handle.writeFile(JSON.stringify({ ...payload, hash }) + "\n"); await handle.sync(); } finally { await handle.close(); }
      if (revision === 0) await protectCreatedFile(file);
      await syncDirectory(root); previous = hash; revision++;
    },
    async exclusive(fn) {
      if (locked) fail("controller_already_running");
      const server = net.createServer(socket => socket.destroy());
      await new Promise((resolve, reject) => { server.once("error", () => reject(Object.assign(new Error("vm_proof_controller_already_running"), { code: "vm_proof_controller_already_running" })));
        server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve); });
      locked = true;
      try { return await fn(); } finally { locked = false; await new Promise(resolve => server.close(resolve)); }
    }
  };
}
async function readProviderCredential(file, stateRoot) {
  const absolute = path.resolve(file), parent = await externalRoot(path.dirname(absolute));
  if (parent !== stateRoot) fail("credential_wrong_directory");
  const st = await protectedPath(absolute);
  if (st.size < 32 || st.size > 1024) fail("credential_file_invalid");
  const token = (await fs.readFile(absolute, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(token)) fail("credential_file_invalid");
  return token;
}
module.exports = { protectedPath, protectCreatedFile, externalRoot, atomicWrite, createLocalStore, readProviderCredential };
