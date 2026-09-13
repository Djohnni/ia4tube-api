"use strict";
// No inbound converter API. SSH is administrative installation/proof only,
// strictly pinned to this proof's pre-provisioned host key and exact provider IP.
const fs = require("node:fs/promises"), path = require("node:path"), net = require("node:net");
const { spawn } = require("node:child_process");
const { atomicWrite, protectedPath } = require("./vm-proof-local-state");
const { sha256, MANIFEST } = require("./vm-proof-manifest");
const { validateMetrics, validateFailure } = require("./vm-proof-guest");
function fail(code) { throw Object.assign(new Error("vm_proof_ssh_" + code), { code: "vm_proof_ssh_" + code }); }
function processRun(command, args, { signal, timeoutMs = 20000, maxBytes = 65536, stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: "C.UTF-8" }, signal });
    let size = 0, output = "", invalid = false;
    const timer = setTimeout(() => { invalid = true; child.kill("SIGKILL"); }, timeoutMs);
    const onOutput = data => { size += data.length; if (size > maxBytes) { invalid = true; child.kill("SIGKILL"); } else output += data.toString("utf8"); };
    child.stdout.on("data", onOutput); child.stderr.on("data", onOutput);
    child.once("error", () => { invalid = true; });
    child.once("close", code => { clearTimeout(timer); if (invalid || code !== 0) { reject(Object.assign(new Error("vm_proof_ssh_command_failed"), { code: "vm_proof_ssh_command_failed" })); return; }
      resolve(output); });
    child.stdin.on("error", () => {}); child.stdin.end(stdin);
  });
}
function publicIPv4(value) {
  if (net.isIP(value) !== 4 || /^(0|10|127)\./.test(value) || /^169\.254\./.test(value) || /^192\.168\./.test(value) || /^172\.(1[6-9]|2\d|3[01])\./.test(value)) fail("public_ip_invalid");
  return value;
}
async function protectNewFile(file) {
  if (process.platform !== "win32") await fs.chmod(file, 0o600);
  else {
    // Newly generated proof material only, not an existing credential. No
    // inherited wider ACL is retained, and the script prints no key or path.
    const script = '$ErrorActionPreference="Stop"; $p=[Console]::In.ReadToEnd(); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object System.Security.AccessControl.FileSecurity; $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); foreach($s in @($sid.Value,"S-1-5-18")) { $r=New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($s)),"FullControl","Allow"); $a.AddAccessRule($r) }; Set-Acl -LiteralPath $p -AclObject $a';
    await processRun("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdin: file });
  }
  await protectedPath(file);
}
function makeCloudConfig(hostPrivate, hostPublic, adminPublic) {
  if (!/^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END OPENSSH PRIVATE KEY-----\n?$/.test(hostPrivate) ||
      !/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(hostPublic) ||
      !/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(adminPublic)) fail("generated_identity_invalid");
  return "#cloud-config\nssh_deletekeys: true\nssh_pwauth: false\ndisable_root: true\nssh_keys:\n  ed25519_private: |\n" +
    hostPrivate.trimEnd().split("\n").map(s => "    " + s).join("\n") + "\n  ed25519_public: " + JSON.stringify(hostPublic) +
    "\nusers:\n  - name: ia4proof\n    lock_passwd: true\n    shell: /bin/bash\n    sudo: ['ALL=(ALL) NOPASSWD:ALL']\n    ssh_authorized_keys:\n      - " + JSON.stringify(adminPublic) + "\n";
}
async function createSshGuest({ stateRoot, packagePath, plan, run = processRun }) {
  const files = { host: path.join(stateRoot, "proof-host-ed25519"), admin: path.join(stateRoot, "proof-admin-ed25519"),
    known: path.join(stateRoot, "proof-known-hosts"), identity: path.join(stateRoot, "proof-identity.json") };
  let identity = null, address = null;
  const executable = process.platform === "win32" ? { ssh: "ssh.exe", scp: "scp.exe", keygen: "ssh-keygen.exe" } : { ssh: "/usr/bin/ssh", scp: "/usr/bin/scp", keygen: "/usr/bin/ssh-keygen" };
  const options = () => ["-F", process.platform === "win32" ? "NUL" : "/dev/null", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + files.known,
    "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "ProxyCommand=none",
    "-o", "GlobalKnownHostsFile=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
    "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
    "-o", "LogLevel=ERROR", "-i", files.admin];
  async function remote(command, cfg = {}) {
    if (!address) fail("host_not_bound");
    return run(executable.ssh, [...options(), "ia4proof@" + address, command], cfg);
  }
  async function initialize({ missionId }) {
    // No private key is generated when the package changed or permissions are
    // not acceptable. Both checks precede any provider creation request.
    const bytes = await fs.readFile(packagePath); if (bytes.length > 64 * 1024 * 1024 || sha256(bytes) !== plan.packageSha256) fail("package_changed");
    try {
      const prior = JSON.parse(await fs.readFile(files.identity, "utf8"));
      if (prior.missionId !== missionId || prior.planSha256 !== plan.approvalSha256) fail("identity_wrong_mission");
      identity = prior;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      for (const privateFile of [files.host, files.admin]) {
        try { await fs.lstat(privateFile); fail("unowned_key_present"); } catch (e) { if (e.code !== "ENOENT") throw e; }
        await run(executable.keygen, ["-q", "-t", "ed25519", "-N", "", "-C", "ia4tube-ephemeral-proof", "-f", privateFile]);
        await protectNewFile(privateFile); await protectNewFile(privateFile + ".pub");
      }
      const hostPublic = (await fs.readFile(files.host + ".pub", "utf8")).trim(), adminPublic = (await fs.readFile(files.admin + ".pub", "utf8")).trim();
      identity = { missionId, planSha256: plan.approvalSha256, hostPublic, adminPublic };
      await atomicWrite(files.identity, identity); await protectNewFile(files.identity);
    }
    for (const privateFile of [files.host, files.admin]) await protectedPath(privateFile);
    const hostPrivate = await fs.readFile(files.host, "utf8");
    identity.cloudConfig = makeCloudConfig(hostPrivate.replaceAll("\r\n", "\n"), identity.hostPublic, identity.adminPublic);
  }
  return {
    prepareLocalIdentity: initialize,
    createIdentityPayload() { if (!identity) fail("identity_not_prepared"); return { cloudConfig: identity.cloudConfig, adminPublicKey: identity.adminPublic }; },
    async bindHost(droplet, { missionId }) {
      if (!identity) await initialize({ missionId });
      const ips = droplet.networks?.v4?.filter(n => n.type === "public").map(n => n.ip_address) || [];
      if (ips.length !== 1) fail("public_ip_ambiguous"); address = publicIPv4(ips[0]);
      await fs.writeFile(files.known, address + " " + identity.hostPublic + "\n", { mode: 0o600, flag: "w" });
      await protectNewFile(files.known);
    },
    async preflight({ signal, timeoutMs }) {
      // Provider 'active' can precede sshd. Only retry this inert admission
      // check, retaining the pinned key; no installer/converter is retried.
      const deadline = Date.now() + timeoutMs;
      while (true) {
        if (signal?.aborted || Date.now() >= deadline) fail("host_not_ready");
        try { await remote("true", { signal, timeoutMs: Math.min(10000, deadline - Date.now()) }); break; }
        catch { if (signal?.aborted || Date.now() >= deadline) fail("host_not_ready"); }
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
      }
      // Wait for cloud-init completion without skipping pinned host verification.
      await remote("sudo -n cloud-init status --wait", { signal, timeoutMs });
      const bytes = await fs.readFile(packagePath); if (sha256(bytes) !== plan.packageSha256) fail("package_changed");
      await run(executable.scp, [...options(), "--", packagePath, "ia4proof@" + address + ":/var/tmp/ia4tube-proof-bundle.tar"], { signal, timeoutMs });
      // Archive is produced by our fixed builder and hash-checked both sides.
      // Extraction is unprivileged; installer is not yet invoked.
      await remote("mkdir -m 700 /var/tmp/ia4tube-proof-bundle && cd /var/tmp/ia4tube-proof-bundle && " +
        "printf '%s  %s\\n' '" + plan.packageSha256 + "' /var/tmp/ia4tube-proof-bundle.tar | sha256sum -c - >/dev/null && " +
        "tar --no-same-owner --no-same-permissions -xf /var/tmp/ia4tube-proof-bundle.tar", { signal, timeoutMs });
      const out = await remote("sudo -n bash /var/tmp/ia4tube-proof-bundle/" + MANIFEST.hostPreflight, { signal, timeoutMs });
      if (!/^VM_HOST_PREFLIGHT=PASS$/m.test(out)) fail("preflight_failed");
      return { passed: true, convertersStarted: 0 };
    },
    async install({ signal, timeoutMs }) {
      const boot = await remote("sudo -n bash /var/tmp/ia4tube-proof-bundle/scripts/media-vm/bootstrap-ubuntu24.sh", { signal, timeoutMs });
      if (!/^VM_BOOTSTRAP=PASS$/m.test(boot)) fail("bootstrap_failed");
      const out = await remote("sudo -n bash /var/tmp/ia4tube-proof-bundle/" + MANIFEST.installer + " --synthetic-proof", { signal, timeoutMs });
      if (!/^VM_INSTALLATION=PASS$/m.test(out)) fail("installation_failed");
      return { passed: true, convertersStarted: 0 };
    },
    async runSequence({ signal, timeoutMs }) {
      const out = await remote("sudo -n -u ia4tube-coordinator /opt/ia4tube-media/runtime/usr/bin/node /opt/ia4tube-media/proof/" + MANIFEST.guestDispatcher + " --run", { signal, timeoutMs });
      const marker = out.split("\n").find(v => v.startsWith("VM_PROOF_SEQUENCE="));
      if (!marker) fail("sequence_receipt_missing");
      return JSON.parse(marker.slice("VM_PROOF_SEQUENCE=".length));
    },
    async collect({ missionId, signal, timeoutMs }) {
      const out = await remote("sudo -n -u ia4tube-coordinator /opt/ia4tube-media/runtime/usr/bin/node /opt/ia4tube-media/proof/" + MANIFEST.guestDispatcher + " --collect", { signal, timeoutMs });
      const marker = out.split("\n").find(v => v.startsWith("VM_PROOF_EVIDENCE="));
      if (!marker) fail("evidence_missing");
      const evidence = JSON.parse(marker.slice("VM_PROOF_EVIDENCE=".length));
      // Closed schema: never export raw stdout/stderr, environment, paths, media
      // or provider payloads. All artifact content is synthetic status evidence.
      if (Object.keys(evidence).some(k => !["schema", "cases", "launches", "attemptIds", "allTerminated", "syntheticOnly", "metrics", "failure"].includes(k)) ||
        evidence.schema !== 1 || evidence.syntheticOnly !== true || !Array.isArray(evidence.cases) || evidence.cases.length > 10 ||
        !validateMetrics(evidence.metrics) || !validateFailure(evidence.failure) || typeof evidence.allTerminated !== "boolean" ||
        !Array.isArray(evidence.attemptIds) || (evidence.launches === null ? evidence.attemptIds.length !== 0 || evidence.allTerminated !== false || evidence.cases.length !== 0 :
          !Number.isSafeInteger(evidence.launches) || evidence.launches < 0 || evidence.launches > MANIFEST.maxLaunches || evidence.attemptIds.length !== evidence.launches) ||
        evidence.attemptIds.some((id, i) => id !== MANIFEST.cases.flatMap(c => c.attempts)[i]) ||
        evidence.cases.some((r, i) => Object.keys(r).sort().join(",") !== "failure,id,nativeLaunches,passed,terminationProved" || r.id !== MANIFEST.cases[i]?.id ||
          !validateFailure(r.failure) || (r.passed ? r.failure !== null : r.failure === null) ||
          typeof r.passed !== "boolean" || typeof r.terminationProved !== "boolean" || !Number.isSafeInteger(r.nativeLaunches) || r.nativeLaunches < 0 || r.nativeLaunches > MANIFEST.cases[i].attempts.length)) fail("evidence_schema_invalid");
      const safe = { ...evidence, missionId, planSha256: plan.approvalSha256 };
      await atomicWrite(path.join(stateRoot, "synthetic-evidence.json"), safe);
      return { sanitized: true, sha256: sha256(JSON.stringify(safe)) };
    }
  };
}
module.exports = { createSshGuest, makeCloudConfig, publicIPv4, processRun };
