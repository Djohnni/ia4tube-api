"use strict";

// Windows-only physical adapter bundle for the Social 3A-0P harness. Merely
// importing this module performs no I/O, opens no socket and starts no process.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  HarnessFailure,
  assertClosedEvidenceReport,
  consumeOwnedTemporaryRootProof,
  establishDpapiCustody,
  removeOwnedTree,
  safeSystemEnvironment
} = require("./social-3a0p-local-harness-core");
const {
  createProcessRunner,
  terminateProcessTree: terminateWindowsProcessTree
} = require("./social-3a0p-local-process");
const {
  createSanitizedEvidenceLedger
} = require("./social-3a0p-local-evidence-ledger");
const {
  createWindowsEvidenceLedgerAdapters
} = require("./social-3a0p-local-windows-evidence-ledger-adapters");
const {
  validateBootstrapDiagnostic
} = require("./social-3a0p-local-evidence-bootstrap-diagnostic");
const {
  assertNoResidualProcesses,
  assertSessionMetricsSafe,
  collectResidualProcessMetrics,
  collectSessionMetrics,
  createPoolMetricsRegistry
} = require("./social-3a0p-local-runtime-evidence-metrics");
const {
  assertBundleMetricsSafe,
  assertDataChecksumsEnabled,
  collectMeasuredBundleMetrics,
  collectDataChecksumsMetric
} = require("./social-3a0p-local-bundle-cluster-metrics");
const firewallNonmutation = require(
  "./social-3a0p-local-firewall-nonmutation"
);
const {
  inspectZipFile
} = require("./social-3a0p-local-zip-inventory");

const POSTGRES_VERSION = "18.4";
const LOOPBACK_HOST = "127.0.0.1";
const LOCAL_DATABASE = "ia4tube_social_local";
const ADMIN_LOGIN = "ia4tube_social_local_admin";
const PROVISIONER_LOGIN = "ia4tube_social_local_provisioner";
const MIGRATION_LOGIN = "ia4tube_social_local_migration";
const RUNTIME_LOGIN = "ia4tube_social_local_runtime";
// fs.mkdtempSync appends exactly six ASCII alphanumeric characters. Keep this
// contract aligned with createOwnedTemporaryRoot instead of normalizing the
// path (the original spelling is part of the one-use ownership proof).
const OWNED_ROOT = /^ia4tube-social-3a0p-[A-Za-z0-9]{6}$/;
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MINIMUM_FREE_BYTES = 7 * 1024 * 1024 * 1024;
const TRACKED_POOL_RELEASE = Symbol("ia4tubeTrackedPoolRelease");
const REQUIRED_ARCHIVE_FILES = Object.freeze([
  "bin/initdb.exe",
  "bin/pg_ctl.exe",
  "bin/pg_isready.exe",
  "bin/postgres.exe",
  "bin/pg_dump.exe",
  "bin/pg_restore.exe",
  "bin/psql.exe"
]);
const PHYSICAL_GATES = Object.freeze([
  "migration",
  "rls",
  "concurrency",
  "vault",
  "backupRestore"
]);
const PHYSICAL_PROOFS = Object.freeze([
  "postgres-18-4-readiness",
  "role-bootstrap-idempotency",
  "migration-0001-0004",
  "rls-company-a-b",
  "connector-concurrency",
  "oauth-synthetic-lifecycle",
  "idempotency-race",
  "vault-round-trip-rotation",
  "backup-restore-profile-0003",
  "backup-restore-profile-0004",
  "forward-only-rollback"
]);

class WindowsPhysicalAdapterFailure extends HarnessFailure {
  constructor(code) {
    super(code);
    this.name = "WindowsPhysicalAdapterFailure";
  }
}

function fail(code) {
  throw new WindowsPhysicalAdapterFailure(code);
}

function plainObject(value, code) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  return value;
}

function absolute(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    fail(code);
  }
  return path.resolve(value);
}

function canonicalIdentifier(value, code) {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) fail(code);
  return value;
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function requireWithin(candidate, root, code) {
  const resolved = absolute(candidate, code);
  if (!isWithin(resolved, root)) fail(code);
  return resolved;
}

function canonicalArchiveEntry(value) {
  if (
    typeof value !== "string" ||
    !value ||
    /[\0\r\n\\]/.test(value)
  ) {
    fail("windows_harness_archive_entry_invalid");
  }
  const normalized = value.replace(/\/$/, "");
  const components = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-z]:/i.test(normalized) ||
    components.some((part) => {
      if (
        !part ||
        part === "." ||
        part === ".." ||
        /[ .]$/.test(part) ||
        /[<>:"|?*]/.test(part) ||
        [...part].some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint < 32 || codePoint > 126;
        })
      ) {
        return true;
      }
      const deviceStem = part.split(".", 1)[0].toUpperCase();
      return /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/.test(deviceStem);
    })
  ) {
    fail("windows_harness_archive_entry_invalid");
  }
  return normalized;
}

function stripLayout(entry, layoutRoot) {
  const normalized = canonicalArchiveEntry(entry);
  const prefix = `${layoutRoot}/`;
  if (!normalized.startsWith(prefix)) fail("windows_harness_archive_layout_invalid");
  return normalized.slice(prefix.length);
}

function quoteIdentifier(value) {
  return `"${canonicalIdentifier(value, "windows_harness_identifier_invalid")}"`;
}

function fixedPassword(randomBytes) {
  const random = randomBytes(36).toString("base64url");
  return Buffer.from(`Aa1!${random}`, "utf8");
}

function memoryText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) {
    fail("windows_harness_material_invalid");
  }
  return buffer.toString("utf8");
}

function hidden(object, key, value) {
  Object.defineProperty(object, key, {
    configurable: false,
    enumerable: false,
    writable: false,
    value
  });
  return object;
}

function sanitizedFailure(error, fallback) {
  const code = String(error?.code || "");
  const failure = new WindowsPhysicalAdapterFailure(
    /^[a-z][a-z0-9_]{2,95}$/.test(code) ? code : fallback
  );
  if (error?.bootstrapDiagnostic) {
    validateBootstrapDiagnostic(error.bootstrapDiagnostic);
    hidden(failure, "bootstrapDiagnostic", error.bootstrapDiagnostic);
  }
  return failure;
}

function defaultStorage() {
  const promises = fs.promises;
  return Object.freeze({
    access: (target) => promises.access(target),
    appendFile: (target, value) => promises.appendFile(target, value, "utf8"),
    hashFile(target) {
      return new Promise((resolve, reject) => {
        const digest = crypto.createHash("sha256");
        const stream = fs.createReadStream(target);
        stream.once("error", reject);
        stream.on("data", (chunk) => digest.update(chunk));
        stream.once("end", () => resolve(digest.digest("hex")));
      });
    },
    async exists(target) {
      try {
        await promises.access(target);
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    },
    lstat: (target) => promises.lstat(target),
    mkdir: (target, options) => promises.mkdir(target, options),
    readFile: (target, encoding) => promises.readFile(target, encoding),
    readdir: (target, options) => promises.readdir(target, options),
    rename: (source, destination) => promises.rename(source, destination),
    rm: (target, options) => promises.rm(target, options),
    stat: (target) => promises.stat(target),
    statfs: (target) => promises.statfs(target),
    unlink: (target) => promises.unlink(target),
    writeFile: (target, value, options) => promises.writeFile(target, value, options),
    existsSync: (target) => fs.existsSync(target),
    readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
    renameSync: (source, destination) => fs.renameSync(source, destination),
    unlinkSync: (target) => fs.unlinkSync(target),
    writeFileSync: (target, value, options) => fs.writeFileSync(target, value, options),
    async assertTreeSafe(root) {
      const queue = [root];
      while (queue.length > 0) {
        const current = queue.pop();
        const item = await promises.lstat(current);
        if (item.isSymbolicLink()) fail("windows_harness_reparse_point_refused");
        if (!item.isDirectory()) continue;
        for (const child of await promises.readdir(current)) {
          queue.push(path.join(current, child));
        }
      }
      return true;
    },
    removeOwnedTree(root, parent) {
      return removeOwnedTree(root, parent, fs);
    }
  });
}

function parseJsonLine(value, code) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || "").trim());
  } catch {
    fail(code);
  }
  return plainObject(parsed, code);
}

function requireExecutableMap(options, paths) {
  const source = plainObject(options.executables, "windows_harness_executables_missing");
  const system = Object.freeze({
    powershell: absolute(source.powershell, "windows_harness_powershell_invalid"),
    tar: absolute(source.tar, "windows_harness_tar_invalid"),
    taskkill: absolute(source.taskkill, "windows_harness_taskkill_invalid")
  });
  const bin = path.join(paths.binaryRoot, "bin");
  return Object.freeze({
    ...system,
    initdb: path.join(bin, "initdb.exe"),
    pgDump: path.join(bin, "pg_dump.exe"),
    pgCtl: path.join(bin, "pg_ctl.exe"),
    pgIsReady: path.join(bin, "pg_isready.exe"),
    pgRestore: path.join(bin, "pg_restore.exe"),
    psql: path.join(bin, "psql.exe"),
    postgres: path.join(bin, "postgres.exe")
  });
}

function validateGateResult(name, result, requiredChecks) {
  plainObject(result, `windows_harness_${name}_result_invalid`);
  if (result.physicalExecution !== true || result.syntheticOnly !== true) {
    fail(`windows_harness_${name}_proof_invalid`);
  }
  for (const check of requiredChecks) {
    if (result[check] !== true) fail(`windows_harness_${name}_proof_invalid`);
  }
  return result;
}

function defaultArchive({
  processRunner,
  executables,
  environment,
  paths,
  inspectCentralDirectory = inspectZipFile
}) {
  async function inspect(archivePath) {
    const inventory = await Promise.resolve(inspectCentralDirectory(archivePath));
    if (
      !inventory ||
      !Number.isSafeInteger(inventory.totalEntries) ||
      inventory.totalEntries < 1 ||
      !Array.isArray(inventory.entries) ||
      inventory.entries.length !== inventory.totalEntries
    ) {
      fail("windows_harness_archive_type_inventory_invalid");
    }
    return inventory.entries.map((entry) => {
      if (
        !entry ||
        (entry.kind !== "regular_file" && entry.kind !== "directory")
      ) {
        fail("windows_harness_archive_entry_type_refused");
      }
      return canonicalArchiveEntry(entry.name);
    });
  }
  return Object.freeze({
    list: inspect,
    async extract(archivePath, destination, expectedEntries, expectedSha256) {
      if (!Array.isArray(expectedEntries) || expectedEntries.length === 0) {
        fail("windows_harness_archive_inventory_changed");
      }
      await processRunner.run({
        executable: executables.powershell,
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(paths.repositoryRoot, "scripts", "social-3a0p-local-safe-zip-extract.ps1"),
          "-ArchivePath",
          archivePath,
          "-Destination",
          destination,
          "-ExpectedSha256",
          expectedSha256,
          "-LayoutRoot",
          path.basename(paths.binaryRoot)
        ],
        cwd: paths.ownedRoot,
        environment,
        timeoutMs: 10 * 60_000,
        label: "archive_extract"
      });
      return true;
    }
  });
}

function firewallExecutableSources(repositoryRoot) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail("windows_harness_executable_source_reparse_refused");
      }
      if (entry.isDirectory()) {
        visit(candidate);
      } else if (entry.isFile() && /\.(?:js|ps1)$/i.test(entry.name)) {
        files.push(candidate);
      }
    }
  };
  for (const directory of ["scripts", "src"].map((name) =>
    path.join(repositoryRoot, name))) {
    if (!fs.existsSync(directory)) {
      fail("windows_harness_executable_sources_missing");
    }
    visit(directory);
  }
  const serverEntry = path.join(repositoryRoot, "server.js");
  if (!fs.existsSync(serverEntry)) {
    fail("windows_harness_executable_sources_missing");
  }
  files.push(serverEntry);
  files.sort((left, right) => left.localeCompare(
    right,
    "en",
    { sensitivity: "variant", usage: "sort" }
  ));
  if (files.length < 1) fail("windows_harness_executable_sources_missing");
  return files.map((file) => Object.freeze({
    sourceId: `runtime:${path.relative(repositoryRoot, file)
      .replaceAll("\\", "/").toLowerCase()}`,
    executable: true,
    source: fs.readFileSync(file, "utf8")
  }));
}

function validatedListenerScope(port, ownerPid) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    fail("windows_harness_listener_port_invalid");
  }
  if (
    ownerPid !== null &&
    (!Number.isSafeInteger(ownerPid) || ownerPid < 1)
  ) {
    fail("windows_harness_listener_pid_invalid");
  }
  return Object.freeze({
    port,
    ownerPidValue: ownerPid === null ? 0 : ownerPid
  });
}

function netstatListenerParserPowerShell(port, ownerPid = null) {
  const scope = validatedListenerScope(port, ownerPid);
  return [
    "$rows=@();foreach($line in $lines){$text=[string]$line;if($text-notmatch'^\\s*TCP\\s+'){continue};if($text-notmatch'^\\s*TCP\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s+(\\d+)\\s*$'){throw 'listener_netstat_row_invalid'};",
    "$local=[string]$matches[1];$remote=[string]$matches[2];$pidText=[string]$matches[4];if($remote-ne'0.0.0.0:0'-and$remote-ne'[::]:0'){continue};$separator=$local.LastIndexOf(':');if($separator-lt1){throw 'listener_endpoint_invalid'};$portText=$local.Substring($separator+1);if($portText-notmatch'^\\d+$'-or$pidText-notmatch'^\\d+$'){throw 'listener_endpoint_invalid'};$localPort=[int]$portText;$rowPid=[int]$pidText;if($rowPid-lt1){throw 'listener_endpoint_invalid'};if($localPort-ne",
    `${scope.port}-and(${scope.ownerPidValue}-eq0-or$rowPid-ne${scope.ownerPidValue})){continue};$address=$local.Substring(0,$separator);if($address.StartsWith('[')-and$address.EndsWith(']')){$address=$address.Substring(1,$address.Length-2)};if([string]::IsNullOrWhiteSpace($address)){throw 'listener_endpoint_invalid'};$rows+=@{address=$address;port=$localPort;pid=$rowPid}};`,
    `@{rows=$rows;source='netstat_tcp_and_tcpv6';parserSucceeded=$true;listenersEnumeratedAllPidsByTargetPort=$true;ownerProcessListenersIncluded=$${scope.ownerPidValue > 0 ? "true" : "false"}}|ConvertTo-Json -Compress -Depth 3`
  ].join("");
}

function netstatTargetListenersPowerShell(port, ownerPid = null) {
  validatedListenerScope(port, ownerPid);
  return [
    "$ErrorActionPreference='Stop';",
    "$netstat=Join-Path $env:SystemRoot 'System32\\netstat.exe';if(-not(Test-Path -LiteralPath $netstat -PathType Leaf)){throw 'listener_netstat_missing'};",
    "$lines=@(& $netstat -ano -p TCP);if($LASTEXITCODE-ne0){throw 'listener_netstat_failed'};$lines+=@(& $netstat -ano -p TCPv6);if($LASTEXITCODE-ne0){throw 'listener_netstat_failed'};",
    netstatListenerParserPowerShell(port, ownerPid)
  ].join("");
}

function postgresServiceClassificationPowerShell() {
  return [
    "$s=@($allServices|Where-Object{",
    "([string]$_.Name)-match'(?i)postgres'-or",
    "([string]$_.DisplayName)-match'(?i)postgres'-or",
    "([string]$_.PathName)-match'(?i)(?:postgres|pg_ctl)(?:\\.exe)?'",
    "}).Count;",
    "@{services=$s;servicesIncludeStopped=$true;serviceExecutablePathsInspected=$true}|ConvertTo-Json -Compress"
  ].join("");
}

function defaultSystemProbe({ processRunner, executables, environment, paths }) {
  const probeEnvironment = Object.freeze({
    ...environment,
    TEMP: paths.ownedParent,
    TMP: paths.ownedParent,
    TMPDIR: paths.ownedParent
  });
  async function powershell(script, label, target = null, signal = null) {
    const result = await processRunner.run({
      executable: executables.powershell,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      cwd: paths.ownedParent,
      environment: target === null ? probeEnvironment : {
        ...probeEnvironment,
        IA4TUBE_HARNESS_TARGET: target
      },
      allowedEnvironmentNames: target === null ? [] : ["IA4TUBE_HARNESS_TARGET"],
      timeoutMs: 15_000,
      signal,
      label
    });
    return parseJsonLine(result.stdoutSanitized, `${label}_output_invalid`);
  }
  async function targetListeners(target, label, ownerPid = null) {
    const result = await powershell(
      netstatTargetListenersPowerShell(Number(target.port), ownerPid),
      label
    );
    if (
      result.source !== "netstat_tcp_and_tcpv6" ||
      result.parserSucceeded !== true ||
      result.listenersEnumeratedAllPidsByTargetPort !== true ||
      result.ownerProcessListenersIncluded !== (ownerPid !== null)
    ) {
      fail("windows_harness_listener_probe_invalid");
    }
    const rows = Array.isArray(result.rows)
      ? result.rows
      : result.rows ? [result.rows] : [];
    return Object.freeze(rows.map((row) => {
      const address = String(row?.address || "");
      const port = Number(row?.port);
      const pid = Number(row?.pid);
      if (
        !address || /[\0\r\n]/.test(address) ||
        (
          port !== Number(target.port) &&
          !(ownerPid !== null && pid === ownerPid)
        ) ||
        !Number.isSafeInteger(pid) || pid < 1
      ) {
        fail("windows_harness_listener_probe_invalid");
      }
      return Object.freeze({ address, port, pid });
    }));
  }
  return Object.freeze({
    async assertClean(target) {
      const result = await powershell(
        [
          "$p=@(Get-Process postgres -ErrorAction SilentlyContinue).Count;",
          "$allServices=@(Get-CimInstance -ClassName Win32_Service -ErrorAction Stop);",
          postgresServiceClassificationPowerShell().replace(
            "@{services=$s;",
            "@{processes=$p;services=$s;"
          )
        ].join(""),
        "postgres_preflight"
      );
      const listenerRows = await targetListeners(target, "postgres_port_probe");
      const processes = result.processes;
      const services = result.services;
      const listeners = listenerRows.length;
      if ([processes, services].some(
        (value) => !Number.isSafeInteger(value) || value < 0
      ) ||
      result.servicesIncludeStopped !== true ||
      result.serviceExecutablePathsInspected !== true) {
        fail("windows_harness_system_clean_probe_invalid");
      }
      return Object.freeze({
        clean: processes === 0 && services === 0 && listeners === 0,
        processes,
        services,
        listeners,
        servicesIncludeStopped: true,
        serviceExecutablePathsInspected: true,
        listenersEnumeratedAllPidsByTargetPort: true
      });
    },
    async processAlive(pid) {
      const result = await powershell(
        `$p=Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue;@{alive=[bool]$p}|ConvertTo-Json -Compress`,
        "postgres_process_probe"
      );
      return result.alive === true;
    },
    async processIdentity(pid) {
      const result = await powershell(
        [
          `$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${Number(pid)}\" -ErrorAction SilentlyContinue;`,
          "if($null -eq $p){@{found=$false}|ConvertTo-Json -Compress}else{",
          "@{found=$true;pid=[int]$p.ProcessId;executablePath=[string]$p.ExecutablePath;creationDate=[string]$p.CreationDate}|ConvertTo-Json -Compress}"
        ].join(""),
        "postgres_process_identity_probe"
      );
      return result.found === true ? Object.freeze({
        pid: Number(result.pid),
        executablePath: String(result.executablePath || ""),
        creationDate: String(result.creationDate || "")
      }) : null;
    },
    async listeners(pid, target) {
      return targetListeners(target, "postgres_listener_probe", Number(pid));
    },
    async protectAndAuditRoot(target) {
      const result = await powershell(
        [
          "$ErrorActionPreference='Stop';$p=[IO.Path]::GetFullPath($env:IA4TUBE_HARNESS_TARGET);",
          "$i=Get-Item -LiteralPath $p -Force;if(-not$i.PSIsContainer-or($i.Attributes-band[IO.FileAttributes]::ReparsePoint)){throw 'root_invalid'};",
          "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User;",
          "$s=New-Object Security.AccessControl.DirectorySecurity;$s.SetAccessRuleProtection($true,$false);$s.SetOwner($me);",
          "$f=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit';",
          "foreach($v in @($me.Value,'S-1-5-18','S-1-5-32-544')){$sid=New-Object Security.Principal.SecurityIdentifier($v);$r=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,$f,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);[void]$s.AddAccessRule($r)};",
          "$i.SetAccessControl($s);$a=Get-Acl -LiteralPath $p;$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));",
          "$owner=([Security.Principal.NTAccount]$a.Owner).Translate([Security.Principal.SecurityIdentifier]).Value;$allowed=@($me.Value,'S-1-5-18','S-1-5-32-544');",
          "@{ownerCurrentUser=($owner-eq$me.Value);inheritanceProtected=[bool]$a.AreAccessRulesProtected;explicitRuleCount=@($rules|Where-Object{-not$_.IsInherited}).Count;inheritedRuleCount=@($rules|Where-Object{$_.IsInherited}).Count;denyRuleCount=@($rules|Where-Object{$_.AccessControlType-eq'Deny'}).Count;unexpectedAllowRuleCount=@($rules|Where-Object{$_.AccessControlType-eq'Allow'-and$_.IdentityReference.Value-notin$allowed}).Count}|ConvertTo-Json -Compress"
        ].join(""),
        "harness_root_acl",
        target
      );
      return Object.freeze({
        ownerCurrentUser: result.ownerCurrentUser === true,
        inheritanceProtected: result.inheritanceProtected === true,
        explicitRuleCount: Number(result.explicitRuleCount),
        inheritedRuleCount: Number(result.inheritedRuleCount),
        denyRuleCount: Number(result.denyRuleCount),
        unexpectedAllowRuleCount: Number(result.unexpectedAllowRuleCount)
      });
    },
    async firewallLightEvidence({ signal = null } = {}) {
      const result = await powershell(
        firewallNonmutation.firewallLightEvidencePowerShell(),
        "firewall_light_evidence",
        null,
        signal
      );
      return firewallNonmutation.validateFirewallLightEvidence(result);
    },
    async residualProcesses(target) {
      const result = await powershell(
        [
          "$p=[IO.Path]::GetFullPath($env:IA4TUBE_HARNESS_TARGET).TrimEnd('\\')+'\\';",
          "$rows=@(Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" -ErrorAction SilentlyContinue|Where-Object{([string]$_.ExecutablePath).StartsWith($p,[StringComparison]::OrdinalIgnoreCase)}|ForEach-Object{@{pid=[int]$_.ProcessId}});",
          "@{rows=$rows}|ConvertTo-Json -Compress -Depth 3"
        ].join(""),
        "postgres_residual_processes",
        target
      );
      return (Array.isArray(result.rows) ? result.rows : result.rows ? [result.rows] : [])
        .map((row) => ({ pid: Number(row.pid) }));
    }
  });
}

function poolOptions(state, login, password, max, applicationName, database = LOCAL_DATABASE) {
  return {
    host: LOOPBACK_HOST,
    port: state.target.port,
    database,
    user: login,
    password: memoryText(password),
    ssl: false,
    max,
    min: 0,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    query_timeout: 15_000,
    application_name: applicationName,
    options: "-c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=5000",
    allowExitOnIdle: false
  };
}

async function closePool(pool) {
  if (pool && typeof pool.end === "function") await pool.end();
}

function createDefaultRoleBootstrap({
  state,
  storage,
  PoolClass,
  product,
  instrumentRuntimePool = (pool) => pool
}) {
  if (
    typeof PoolClass !== "function" ||
    typeof product.bootstrapDatabaseLogins !== "function" ||
    typeof product.verifyProvisionedLoginCredentials !== "function" ||
    typeof product.targetFingerprint !== "function"
  ) {
    return null;
  }
  return async function bootstrapRoles() {
    const adminPool = new PoolClass(poolOptions(
      state,
      ADMIN_LOGIN,
      state.materials.admin,
      1,
      "ia4tube-social-local-admin",
      "postgres"
    ));
    let provisionerPool;
    try {
      const admin = await adminPool.connect();
      try {
        const existing = await admin.query(
          "SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=$1",
          [PROVISIONER_LOGIN]
        );
        if (existing.rowCount === 0) {
          let transactionStarted = false;
          try {
            await admin.query("BEGIN");
            transactionStarted = true;
            await admin.query("SET LOCAL password_encryption = 'scram-sha-256'");
            await admin.query(
              [
                "SELECT",
                "  pg_catalog.set_config('ia4tube.local.provisioner_login',$1,true),",
                "  pg_catalog.set_config('ia4tube.local.provisioner_password',$2,true)"
              ].join("\n"),
              [PROVISIONER_LOGIN, memoryText(state.materials.provisioner)]
            );
            await admin.query(
              [
                "DO $ia4tube_local_provisioner$",
                "DECLARE",
                "  provisioner_login text := current_setting('ia4tube.local.provisioner_login');",
                "  provisioner_password text := current_setting('ia4tube.local.provisioner_password');",
                "BEGIN",
                "  EXECUTE format(",
                "    'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',",
                "    provisioner_login, provisioner_password",
                "  );",
                "END",
                "$ia4tube_local_provisioner$;"
              ].join("\n")
            );
            await admin.query("COMMIT");
            transactionStarted = false;
          } catch (error) {
            if (transactionStarted) await admin.query("ROLLBACK").catch(() => {});
            throw error;
          }
        } else {
          const row = existing.rows[0];
          if (!row.rolcanlogin || row.rolsuper || row.rolcreatedb || !row.rolcreaterole || row.rolreplication || row.rolbypassrls) {
            fail("windows_harness_provisioner_drift");
          }
        }
        const database = await admin.query(
          [
            "SELECT owner.rolname AS owner",
            "FROM pg_catalog.pg_database database",
            "JOIN pg_catalog.pg_roles owner ON owner.oid=database.datdba",
            "WHERE database.datname=$1"
          ].join("\n"),
          [LOCAL_DATABASE]
        );
        if (database.rowCount === 0) {
          await admin.query(
            `CREATE DATABASE ${quoteIdentifier(LOCAL_DATABASE)} OWNER ${quoteIdentifier(PROVISIONER_LOGIN)}`
          );
        } else if (database.rows[0].owner !== PROVISIONER_LOGIN) {
          fail("windows_harness_database_owner_drift");
        }
      } finally {
        admin.release();
      }

      provisionerPool = new PoolClass(poolOptions(
        state,
        PROVISIONER_LOGIN,
        state.materials.provisioner,
        1,
        "ia4tube-social-local-provisioner"
      ));
      const rolesSql = await storage.readFile(
        path.join(state.repositoryRoot, "db", "postgres", "roles.sql"),
        "utf8"
      );
      const provisioner = await provisionerPool.connect();
      try {
        await provisioner.query(rolesSql);
        await provisioner.query("BEGIN");
        try {
          await provisioner.query([
            "GRANT ia4tube_social_owner TO CURRENT_USER",
            "  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
            "  GRANTED BY CURRENT_USER"
          ].join("\n"));
          await provisioner.query("SET LOCAL ROLE ia4tube_social_owner");
          await provisioner.query(
            [
              "INSERT INTO ia4tube_migrations.environment_identity (",
              "  singleton,environment_id,environment_name",
              ") VALUES (TRUE,$1,'local')",
              "ON CONFLICT (singleton) DO NOTHING"
            ].join("\n"),
            [state.environmentId]
          );
          const marker = await provisioner.query(
            [
              "SELECT environment_id::text,environment_name",
              "FROM ia4tube_migrations.environment_identity",
              "WHERE singleton=TRUE"
            ].join("\n")
          );
          if (
            marker.rowCount !== 1 ||
            marker.rows?.[0]?.environment_id !== state.environmentId.toLowerCase() ||
            marker.rows?.[0]?.environment_name !== "local"
          ) {
            fail("windows_harness_environment_marker_mismatch");
          }
          await provisioner.query("RESET ROLE");
          await provisioner.query([
            "REVOKE ia4tube_social_owner FROM CURRENT_USER",
            "  GRANTED BY CURRENT_USER RESTRICT"
          ].join("\n"));
          await provisioner.query("COMMIT");
        } catch (error) {
          await provisioner.query("ROLLBACK").catch(() => {});
          throw error;
        }
      } finally {
        provisioner.release();
      }

      const url = new URL(`postgresql://${LOOPBACK_HOST}:${state.target.port}/${LOCAL_DATABASE}`);
      url.username = PROVISIONER_LOGIN;
      url.password = memoryText(state.materials.provisioner);
      const configuration = {
        target: {
          host: LOOPBACK_HOST,
          port: String(state.target.port),
          database: LOCAL_DATABASE,
          provisionerLogin: PROVISIONER_LOGIN,
          migrationLogin: MIGRATION_LOGIN,
          runtimeLogin: RUNTIME_LOGIN
        },
        targetFingerprint: product.targetFingerprint({
          host: LOOPBACK_HOST,
          port: String(state.target.port),
          database: LOCAL_DATABASE,
          provisionerLogin: PROVISIONER_LOGIN,
          migrationLogin: MIGRATION_LOGIN,
          runtimeLogin: RUNTIME_LOGIN
        }),
        provisionerPool: {
          ...poolOptions(state, PROVISIONER_LOGIN, state.materials.provisioner, 1, "ia4tube-social-local-provisioner"),
          connectionString: url.toString()
        },
        migration: hidden({ login: MIGRATION_LOGIN, role: product.MIGRATOR_ROLE, connectionLimit: product.MIGRATION_CONNECTION_LIMIT }, "password", memoryText(state.materials.migration)),
        runtime: hidden({ login: RUNTIME_LOGIN, role: product.RUNTIME_ROLE, connectionLimit: product.RUNTIME_CONNECTION_LIMIT }, "password", memoryText(state.materials.runtime))
      };
      const first = await product.bootstrapDatabaseLogins(provisionerPool, configuration);
      const second = await product.bootstrapDatabaseLogins(provisionerPool, configuration);
      const verified = await product.verifyProvisionedLoginCredentials(PoolClass, configuration);
      if (
        first.safe !== true ||
        second.safe !== true ||
        second.created?.migration !== false ||
        second.created?.runtime !== false ||
        verified.verified !== 2
      ) {
        fail("windows_harness_role_bootstrap_unconfirmed");
      }

      state.pools.migration = new PoolClass(poolOptions(state, MIGRATION_LOGIN, state.materials.migration, 2, "ia4tube-social-local-migration"));
      state.pools.runtime = instrumentRuntimePool(
        new PoolClass(poolOptions(
          state,
          RUNTIME_LOGIN,
          state.materials.runtime,
          3,
          "ia4tube-social-local-runtime"
        ))
      );
      return {
        physicalExecution: true,
        syntheticOnly: true,
        idempotent: true,
        runtimeSafe: true,
        migrationSafe: true,
        scramVerified: true,
        createdCount: Number(first.created?.migration) + Number(first.created?.runtime)
      };
    } finally {
      await closePool(provisionerPool);
      await closePool(adminPool);
    }
  };
}

function productDependencies(candidate = {}) {
  if (candidate && Object.keys(candidate).length > 0) return candidate;
  const login = require("../src/persistence/postgres/login-bootstrap");
  return Object.freeze({
    ...login
  });
}

function createWindowsPhysicalAdapters(options = {}) {
  plainObject(options, "windows_harness_options_invalid");
  const ownedRoot = absolute(options.ownedRoot, "windows_harness_root_invalid");
  const ownedParent = absolute(options.ownedParent, "windows_harness_parent_invalid");
  const repositoryRoot = absolute(options.repositoryRoot, "windows_harness_repository_invalid");
  if (
    path.dirname(ownedRoot).toLowerCase() !== ownedParent.toLowerCase() ||
    !OWNED_ROOT.test(path.basename(ownedRoot))
  ) {
    fail("windows_harness_root_refused");
  }
  const layoutRoot = typeof options.layoutRoot === "string" && /^[a-z0-9._-]+$/.test(options.layoutRoot)
    ? options.layoutRoot
    : "pgsql";
  const paths = Object.freeze({
    ownedRoot,
    ownedParent,
    repositoryRoot,
    binaryRoot: path.join(ownedRoot, layoutRoot),
    clusterRoot: path.join(ownedRoot, "cluster"),
    logsRoot: path.join(ownedRoot, "logs"),
    custodyPath: path.join(ownedRoot, "dpapi-physical-gate.bin"),
    incrementalEvidenceRoot: path.join(
      ownedParent,
      `${path.basename(ownedRoot)}-incremental-evidence`
    ),
    evidencePath: path.join(
      ownedParent,
      `${path.basename(ownedRoot)}-incremental-evidence`,
      "canonical-evidence.json"
    ),
    evidencePendingPath: path.join(
      ownedParent,
      `${path.basename(ownedRoot)}-incremental-evidence`,
      "canonical-evidence.json.pending"
    ),
    evidenceFinalizingPath: path.join(
      ownedParent,
      `${path.basename(ownedRoot)}-incremental-evidence`,
      "canonical-evidence.json.finalizing"
    )
  });
  const executables = requireExecutableMap(options, paths);
  const storage = options.dependencies?.storage || defaultStorage();
  const systemEnvironment = Object.freeze({
    ...safeSystemEnvironment(options.systemEnvironment || process.env),
    TEMP: paths.ownedRoot,
    TMP: paths.ownedRoot,
    TMPDIR: paths.ownedRoot
  });
  const activeChildPids = new Set();
  const activeChildOwnership = new Map();
  const allowedChildExecutables = new Set(
    Object.values(executables).map((value) => path.resolve(value).toLowerCase())
  );
  const childProcessJournal = Object.freeze({
    registerProcess(pid, proof) {
      const executablePath = path.resolve(String(proof?.executablePath || ""));
      if (
        !Number.isSafeInteger(pid) ||
        pid < 1 ||
        activeChildPids.has(pid) ||
        Number(proof?.pid) !== pid ||
        !allowedChildExecutables.has(executablePath.toLowerCase()) ||
        typeof proof?.isOriginalProcessActive !== "function"
      ) {
        fail("windows_harness_child_pid_invalid");
      }
      activeChildPids.add(pid);
      activeChildOwnership.set(pid, Object.freeze({
        pid,
        executablePath,
        isOriginalProcessActive: proof.isOriginalProcessActive
      }));
    },
    unregisterProcess(pid) {
      activeChildPids.delete(pid);
      activeChildOwnership.delete(pid);
    }
  });
  const processRunnerFactory = options.dependencies?.createProcessRunner ||
    createProcessRunner;
  const processRunner = options.dependencies?.processRunner || processRunnerFactory({
    allowedExecutables: Object.values(executables),
    terminateTree: (pid) => terminateWindowsProcessTree(pid, {
      taskkillPath: executables.taskkill
    }),
    resourceJournal: childProcessJournal
  });
  const archive = options.dependencies?.archive || defaultArchive({
    processRunner,
    executables,
    environment: systemEnvironment,
    paths,
    inspectCentralDirectory:
      options.dependencies?.inspectZipFile || inspectZipFile
  });
  const systemProbe = options.dependencies?.systemProbe || defaultSystemProbe({ processRunner, executables, environment: systemEnvironment, paths });
  let BasePoolClass = options.dependencies?.PoolClass || null;
  function loadBasePoolClass() {
    if (!BasePoolClass) BasePoolClass = require("pg").Pool;
    if (typeof BasePoolClass !== "function") {
      fail("windows_harness_pool_class_invalid");
    }
    return BasePoolClass;
  }
  const product = productDependencies(options.dependencies?.product || {});
  const randomBytes = options.dependencies?.randomBytes || crypto.randomBytes;
  const randomUUID = options.dependencies?.randomUUID || crypto.randomUUID;
  const state = {
    repositoryRoot,
    target: null,
    packageDescriptor: null,
    packageEvidence: null,
    rootAclEvidence: null,
    observedPackageSha256: null,
    archiveEntries: [],
    pid: null,
    postmasterIdentity: null,
    initialized: false,
    productDatabasePrepared: false,
    backupRestoreCompleted: false,
    started: false,
    startAmbiguous: false,
    materials: Object.create(null),
    pools: Object.create(null),
    phaseResults: Object.create(null),
    pendingEvidence: null,
    environmentId: randomUUID(),
    diskSpace: {
      initialFreeBytes: null,
      minimumFreeBytes: null,
      beforeExtractionFreeBytes: null,
      afterExtractionFreeBytes: null,
      afterPackageRemovalFreeBytes: null,
      finalFreeBytes: null
    },
    firewallBefore: null,
    firewallAfter: null,
    firewallComparison: null,
    firewallExecutableProof: null,
    firewallContext: null,
    preflightSystemSnapshot: null,
    loopbackOnlyListenerProved: false,
    externalListenerAbsent: false,
    effectiveListenAddressesLoopback: false,
    processTreesTerminated: 0,
    workingPackageRemoved: false,
    cleaned: false
  };
  const runMarker = typeof options.runMarker === "string"
    ? options.runMarker
    : `ia4tube-social-3a0p-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const poolMetrics = createPoolMetricsRegistry();
  const sessionOwnership = new Map();
  const sessionRoleCategory = new Map([
    [RUNTIME_LOGIN, "runtime"],
    [MIGRATION_LOGIN, "migration"],
    [PROVISIONER_LOGIN, "provisioning"],
    [ADMIN_LOGIN, "provisioning"]
  ]);
  const poolRoleCategory = new Map([
    [RUNTIME_LOGIN, "runtime"],
    [MIGRATION_LOGIN, "migration"],
    [PROVISIONER_LOGIN, "provisioning"],
    [ADMIN_LOGIN, "administration"]
  ]);

  function poolLogin(configuration) {
    if (typeof configuration?.user === "string") return configuration.user;
    if (typeof configuration?.connectionString !== "string") return "";
    try {
      return decodeURIComponent(new URL(configuration.connectionString).username);
    } catch {
      return "";
    }
  }

  let TrackedPoolClass = null;
  function loadTrackedPoolClass() {
    if (TrackedPoolClass) return TrackedPoolClass;
    const LoadedBasePoolClass = loadBasePoolClass();
    TrackedPoolClass = class HarnessTrackedPool extends LoadedBasePoolClass {
    constructor(configuration) {
      const configuredMax = Number(configuration?.max);
      if (!Number.isSafeInteger(configuredMax) || configuredMax < 1) {
        fail("windows_harness_pool_max_invalid");
      }
      super(configuration);
      const role = poolLogin(configuration);
      const category = poolRoleCategory.get(role);
      if (!category) fail("windows_harness_pool_role_invalid");
      this.harnessPoolConfiguration = Object.freeze({
        role,
        category,
        configuredMax,
        applicationName: String(configuration?.application_name || "")
      });
      this.harnessOwnedPids = new Set();
      this.harnessPoolRegistered = true;
      poolMetrics.register(this, { category, configuredMax });
      poolMetrics.observe(this, metricView(this));
      if (typeof this.on === "function") {
        this.on("remove", (client) => {
          const pid = Number(client?.processID);
          if (Number.isSafeInteger(pid) && pid > 0) {
            this.harnessOwnedPids.delete(pid);
            sessionOwnership.delete(pid);
          }
          if (this.harnessPoolRegistered) {
            poolMetrics.observe(this, metricView(this));
          }
        });
      }
    }

    harnessRecordClient(client) {
      const originalRelease = client?.release;
      if (typeof originalRelease !== "function") {
        fail("windows_harness_pool_release_invalid");
      }
      if (originalRelease[TRACKED_POOL_RELEASE] !== true) {
        const pool = this;
        const trackedRelease = function trackedHarnessPoolRelease(...args) {
          try {
            return originalRelease.apply(client, args);
          } finally {
            if (pool.harnessPoolRegistered) {
              poolMetrics.observe(pool, metricView(pool));
            }
          }
        };
        Object.defineProperty(trackedRelease, TRACKED_POOL_RELEASE, {
          value: true
        });
        client.release = trackedRelease;
      }
      poolMetrics.recordAcquisition(this, metricView(this));
      const pid = Number(client?.processID);
      const category = sessionRoleCategory.get(this.harnessPoolConfiguration.role);
      const applicationName = this.harnessPoolConfiguration.applicationName;
      if (
        Number.isSafeInteger(pid) &&
        pid > 0 &&
        category &&
        /^ia4tube-social-(?:local|3a0p)-[a-z0-9_-]+$/.test(applicationName)
      ) {
        const current = sessionOwnership.get(pid);
        if (
          current &&
          (current.category !== category || current.applicationName !== applicationName)
        ) {
          fail("windows_harness_session_ownership_conflict");
        }
        sessionOwnership.set(pid, Object.freeze({
          pid,
          category,
          applicationName
        }));
        this.harnessOwnedPids.add(pid);
      }
      return client;
    }

    connect(...args) {
      poolMetrics.observe(this, metricView(this));
      const callback = typeof args.at(-1) === "function" ? args.pop() : null;
      if (callback) {
        let returned;
        try {
          returned = super.connect(...args, (error, client, release) => {
            poolMetrics.observe(this, metricView(this));
            if (error) return callback(error);
            let trackedClient;
            try {
              trackedClient = this.harnessRecordClient(client);
            } catch (trackingError) {
              try { client?.release?.(); } catch {}
              return callback(trackingError);
            }
            return callback(null, trackedClient, trackedClient.release);
          });
          poolMetrics.observe(this, metricView(this));
          return returned;
        } catch (error) {
          poolMetrics.observe(this, metricView(this));
          throw error;
        }
      }
      let pending;
      try {
        pending = super.connect(...args);
        poolMetrics.observe(this, metricView(this));
      } catch (error) {
        poolMetrics.observe(this, metricView(this));
        throw error;
      }
      return Promise.resolve(pending).then(
        (client) => {
          try {
            return this.harnessRecordClient(client);
          } catch (trackingError) {
            try { client?.release?.(); } catch {}
            throw trackingError;
          }
        },
        (error) => {
          poolMetrics.observe(this, metricView(this));
          throw error;
        }
      );
    }

    harnessUnregister() {
      if (this.harnessPoolRegistered) {
        for (const pid of this.harnessOwnedPids) sessionOwnership.delete(pid);
        this.harnessOwnedPids.clear();
        poolMetrics.observe(this, metricView(this));
        poolMetrics.unregister(this);
        this.harnessPoolRegistered = false;
      }
    }

    end(...args) {
      const callback = typeof args.at(-1) === "function" ? args.pop() : null;
      if (callback) {
        return super.end(...args, (error) => {
          this.harnessUnregister();
          callback(error);
        });
      }
      let pending;
      try {
        pending = super.end(...args);
      } catch (error) {
        this.harnessUnregister();
        throw error;
      }
      return Promise.resolve(pending).finally(() => this.harnessUnregister());
    }
    };
    return TrackedPoolClass;
  }

  function PoolClass(configuration) {
    const LoadedTrackedPoolClass = loadTrackedPoolClass();
    return new LoadedTrackedPoolClass(configuration);
  }
  const ledgerAdapters = options.dependencies?.evidenceLedgerAdapters ||
    createWindowsEvidenceLedgerAdapters({
      controlledRoot: paths.ownedParent,
      evidenceRoot: paths.incrementalEvidenceRoot,
      cleanupRoot: paths.ownedRoot,
      powershell: executables.powershell,
      processRunner,
      environment: systemEnvironment
    });
  const evidenceLedger = options.dependencies?.evidenceLedger ||
    createSanitizedEvidenceLedger({
      runId: state.environmentId,
      harnessCommit: options.harnessCommit,
      productCommit: options.productCommit,
      controlledRoot: paths.ownedParent,
      evidenceRoot: paths.incrementalEvidenceRoot,
      cleanupRoot: paths.ownedRoot,
      adapters: ledgerAdapters
    });
  const sourcePackageVerifier = options.sourcePackageVerifier;
  const connectorGateFactory = options.dependencies?.connectorGateFactory ||
    ((settings) => require("./social-3a0p-local-connector-physical-gates")
      .createConnectorPhysicalGates(settings));
  let loadedPhysicalGates = options.dependencies?.physicalGates || null;
  function loadPhysicalGates() {
    if (!loadedPhysicalGates) {
      const physicalPlans = options.physicalPlans ||
        (options.dependencies?.connectorGateFactory
          ? undefined
          : require("./social-3a0p-local-windows-physical-plans")
          .createWindowsPhysicalPlans({
            approval: "RUN_SOCIAL_3A0P_LOCAL_BACKUP_RESTORE",
            runMarker,
            // The state target is populated by the first bound phase. The plan
            // reads this stable object only when a physical method is invoked.
            target: options.target,
            state,
            paths,
            executables,
            processRunner,
            PoolClass,
            repositoryRoot,
            randomBytes,
            dependencies: options.dependencies?.physicalPlanDependencies
          }));
      loadedPhysicalGates = connectorGateFactory({
        dependencies: options.dependencies?.connectorGateDependencies,
        plans: physicalPlans,
        randomBytes,
        randomUUID
      });
    }
    const gates = plainObject(
      loadedPhysicalGates,
      "windows_harness_physical_gates_missing"
    );
    for (const gate of PHYSICAL_GATES) {
      if (typeof gates[gate] !== "function") {
        fail("windows_harness_physical_gate_missing");
      }
    }
    return gates;
  }
  const physicalGates = Object.freeze({
    assertConfigured() {
      return loadPhysicalGates().assertConfigured?.();
    },
    migration(input) { return loadPhysicalGates().migration(input); },
    rls(input) { return loadPhysicalGates().rls(input); },
    concurrency(input) { return loadPhysicalGates().concurrency(input); },
    vault(input) { return loadPhysicalGates().vault(input); },
    backupRestore(input) { return loadPhysicalGates().backupRestore(input); },
    destroy() {
      return loadedPhysicalGates?.destroy?.();
    }
  });
  const dpapiScript = path.join(repositoryRoot, "scripts", "social-3a0p-local-dpapi.ps1");
  // The default role bootstrap needs the stable state object after creation.
  const effectiveRoleBootstrap = options.dependencies?.roleBootstrap ||
    createDefaultRoleBootstrap({
      state,
      storage,
      PoolClass,
      product,
      instrumentRuntimePool: (pool) => pool
    });

  function remember(phase, result) {
    state.phaseResults[phase] = result;
    return result;
  }

  function phaseMetricKey(phase) {
    return phase.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  function packageInventory() {
    const descriptor = state.packageDescriptor;
    if (!descriptor) return [];
    const fileName = path.basename(descriptor.archivePath).toLowerCase();
    const canonicalFileName = fileName
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63);
    const build = /^postgresql-18\.4-(\d+)-windows-x64-binaries\.zip$/.exec(
      fileName
    )?.[1];
    return [
      canonicalFileName || "postgresql-package",
      "version-18-4",
      build ? `build-${build}` : "build-unspecified",
      descriptor.sourceOwnedByRun ? "source-run-owned" : "source-external",
      "working-copy-owned"
    ];
  }

  function availablePartialResult(phase) {
    const counts = {};
    const metrics = {};
    const hashes = {};
    const checks = {};
    const inventory = packageInventory();
    if (state.packageEvidence) {
      counts.packageBytes = state.packageEvidence.archiveBytes;
      counts.packageBuild = state.packageEvidence.build;
      metrics.packageMajor = 18;
      metrics.packageMinor = 4;
      checks.packageSourceOwnedByRun = state.packageEvidence.sourceOwnedByRun;
      checks.workingCopyOwnedByRun = true;
    }
    for (const [key, value] of Object.entries(state.diskSpace)) {
      if (value !== null) counts[key] = value;
    }
    if (state.rootAclEvidence) {
      counts.rootAclExplicitRules = state.rootAclEvidence.explicitRuleCount;
      counts.rootAclInheritedRules = state.rootAclEvidence.inheritedRuleCount;
      counts.rootAclDenyRules = state.rootAclEvidence.denyRuleCount;
      counts.rootAclUnexpectedAllowRules =
        state.rootAclEvidence.unexpectedAllowRuleCount;
      checks.rootAclOwnerCurrentUser = state.rootAclEvidence.ownerCurrentUser;
      checks.rootAclInheritanceProtected =
        state.rootAclEvidence.inheritanceProtected;
    }
    if (state.firewallBefore) {
      const components = Object.fromEntries(
        state.firewallBefore.components.map((entry) => [entry.componentName, entry])
      );
      counts.firewallProfiles = components.profiles.objectCount;
      counts.firewallGlobalSettings = components.globalSettings.objectCount;
      counts.firewallRules = components.rulesMetadata.objectCount;
      hashes.firewallProfilesBeforeSha256 = components.profiles.sha256;
      hashes.firewallGlobalSettingsBeforeSha256 = components.globalSettings.sha256;
      hashes.firewallRulesBeforeSha256 = components.rulesMetadata.sha256;
      hashes.firewallBeforeSha256 = state.firewallBefore.aggregateSha256;
      checks.fullFirewallFilterSnapshotProved = false;
      checks.processNonElevated = state.firewallContext?.processNonElevated === true;
      checks.firewallMutationCommandsAbsent =
        state.firewallExecutableProof?.firewallMutationCommandsAbsent === true;
    }
    if (state.observedPackageSha256) {
      hashes.archiveSha256 = state.observedPackageSha256;
    }
    if (state.archiveEntries.length > 0) {
      counts.archiveEntries = state.archiveEntries.length;
    }
    if (state.target) {
      counts.clusterPort = state.target.port;
      inventory.push("address-127-0-0-1");
    }
    if (Number.isSafeInteger(state.pid) && state.pid > 0) {
      counts.postmasterPid = state.pid;
    }
    checks.clusterInitialized = state.initialized === true;
    checks.clusterStarted = state.started === true;
    try {
      const pool = poolMetrics.snapshot();
      Object.assign(counts, pool.counts);
      Object.assign(metrics, pool.metrics);
      Object.assign(checks, pool.checks);
    } catch {
      // No pool has been created yet. Earlier physical evidence remains valid.
    }
    return {
      code: `windows_${phase.replaceAll("-", "_")}_partial_evidence`,
      ...(Object.keys(counts).length > 0 ? { counts } : {}),
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
      ...(Object.keys(hashes).length > 0 ? { hashes } : {}),
      ...(Object.keys(checks).length > 0 ? { checks } : {}),
      ...(inventory.length > 0
        ? { inventory: [...new Set(inventory)].sort() }
        : {})
    };
  }

  function withPartialEvidence(phase, operation) {
    return async (...args) => {
      try {
        return await operation(...args);
      } catch (error) {
        if (error?.partialResult) throw error;
        const failure = sanitizedFailure(
          error,
          `windows_harness_${phase.replaceAll("-", "_")}_failed`
        );
        failure.partialResult = availablePartialResult(phase);
        throw failure;
      }
    };
  }

  function ledgerEvidence(phase, result) {
    if (!result) return {};
    const evidence = {
      metrics: {
        phaseEvidence: {
          [phaseMetricKey(phase)]: {
            code: result.code,
            ...(result.counts ? { counts: result.counts } : {}),
            ...(result.metrics ? { metrics: result.metrics } : {}),
            ...(result.hashes ? { hashes: result.hashes } : {}),
            ...(result.checks ? { checks: result.checks } : {}),
            ...(result.inventory ? { inventory: result.inventory } : {}),
            ...(result.pendencies ? { pendencies: result.pendencies } : {})
          }
        }
      }
    };
    if (phase === "cleanup") {
      evidence.residues = {
        ownedRoot: result.checks?.ownedRootRemoved === true ? 0 : 1
      };
      if (Number.isSafeInteger(result.counts?.residualOwnedPostgresProcesses)) {
        evidence.residues.residualProcesses =
          result.counts.residualOwnedPostgresProcesses;
      }
    }
    return evidence;
  }

  async function measureSpace(field) {
    if (typeof storage.statfs !== "function") {
      fail("windows_harness_space_probe_missing");
    }
    const observed = await storage.statfs(paths.ownedParent);
    if (
      !Number.isSafeInteger(observed?.bavail) || observed.bavail < 0 ||
      !Number.isSafeInteger(observed?.bsize) || observed.bsize < 1
    ) {
      fail("windows_harness_space_probe_invalid");
    }
    const freeBytes = observed.bavail * observed.bsize;
    if (!Number.isSafeInteger(freeBytes) || freeBytes < 0) {
      fail("windows_harness_space_probe_invalid");
    }
    state.diskSpace[field] = freeBytes;
    state.diskSpace.minimumFreeBytes = state.diskSpace.minimumFreeBytes === null
      ? freeBytes
      : Math.min(state.diskSpace.minimumFreeBytes, freeBytes);
    return freeBytes;
  }

  function metricView(pool) {
    if (
      !Number.isSafeInteger(pool?.totalCount) || pool.totalCount < 0 ||
      !Number.isSafeInteger(pool?.idleCount) || pool.idleCount < 0 ||
      !Number.isSafeInteger(pool?.waitingCount) || pool.waitingCount < 0
    ) {
      fail("windows_harness_pool_metrics_unavailable");
    }
    return {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount
    };
  }

  async function systemCleanSnapshot() {
    const observed = await systemProbe.assertClean(state.target);
    const counts = [observed?.processes, observed?.services, observed?.listeners];
    if (counts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      fail("windows_harness_system_clean_probe_invalid");
    }
    const clean = counts.every((value) => value === 0);
    if (typeof observed.clean === "boolean" && observed.clean !== clean) {
      fail("windows_harness_system_clean_probe_incoherent");
    }
    if (
      observed?.servicesIncludeStopped !== true ||
      observed?.serviceExecutablePathsInspected !== true ||
      observed?.listenersEnumeratedAllPidsByTargetPort !== true
    ) {
      fail("windows_harness_system_clean_probe_scope_invalid");
    }
    return Object.freeze({
      clean,
      processes: counts[0],
      services: counts[1],
      listeners: counts[2],
      servicesIncludeStopped: true,
      serviceExecutablePathsInspected: true,
      listenersEnumeratedAllPidsByTargetPort: true
    });
  }

  async function initializeEvidenceLedger(input) {
    bind(input);
    try {
      return await evidenceLedger.initialize({
        metrics: {
          packageOwnership: {
            sourceOwnedByRun: input.packageDescriptor.sourceOwnedByRun === true,
            workingCopyOwnedByRun: input.packageDescriptor.workingCopyOwnedByRun === true
          }
        },
        residues: { ownedRoot: 1 }
      });
    } catch (error) {
      throw sanitizedFailure(error, "windows_harness_evidence_ledger_initialize_failed");
    }
  }

  async function transitionEvidenceLedger(event) {
    try {
      if (event?.kind === "started") {
        return event.phase === "cleanup"
          ? evidenceLedger.beginCleanup()
          : evidenceLedger.beginPhase(event.phase);
      }
      if (event?.kind !== "finished") {
        fail("windows_harness_evidence_ledger_event_invalid");
      }
      const evidence = ledgerEvidence(event.phase, event.result);
      return event.phase === "cleanup"
        ? evidenceLedger.finishCleanup({
          status: event.status,
          code: event.code,
          ...evidence
        })
        : evidenceLedger.finishPhase(event.phase, {
          status: event.status,
          code: event.code,
          ...evidence
        });
    } catch (error) {
      throw sanitizedFailure(error, "windows_harness_evidence_ledger_transition_failed");
    }
  }

  function bind(input) {
    if (!input || !input.context || input.target?.host !== LOOPBACK_HOST) {
      fail("windows_harness_phase_input_invalid");
    }
    if (state.target && state.target.port !== input.target.port) {
      fail("windows_harness_target_changed");
    }
    state.target = Object.freeze({ host: LOOPBACK_HOST, port: input.target.port });
    state.packageDescriptor = input.packageDescriptor;
    input.context.state.windowsPhysical = state;
    if (!input.signal || typeof input.signal.aborted !== "boolean") {
      fail("windows_harness_abort_signal_missing");
    }
    if (input.signal.aborted) fail("windows_harness_phase_aborted");
    return input;
  }

  function assertActive(input) {
    if (input.signal.aborted) fail("windows_harness_phase_aborted");
  }

  function validatePostmasterIdentity(candidate, pid) {
    if (
      !candidate ||
      Number(candidate.pid) !== pid ||
      path.resolve(String(candidate.executablePath || "")).toLowerCase() !==
        path.resolve(executables.postgres).toLowerCase() ||
      typeof candidate.creationDate !== "string" ||
      candidate.creationDate.length < 8 || candidate.creationDate.length > 80 ||
      /[\0\r\n]/.test(candidate.creationDate)
    ) {
      fail("windows_harness_postmaster_identity_invalid");
    }
    return Object.freeze({
      pid,
      executablePath: path.resolve(candidate.executablePath),
      creationDate: candidate.creationDate
    });
  }

  async function capturePostmasterIdentity(pid) {
    if (typeof systemProbe.processIdentity !== "function") {
      fail("windows_harness_postmaster_identity_probe_missing");
    }
    return validatePostmasterIdentity(await systemProbe.processIdentity(pid), pid);
  }

  async function postmasterAlive() {
    if (!state.pid || !state.postmasterIdentity) return false;
    const current = await systemProbe.processIdentity(state.pid);
    if (!current) return false;
    const verified = validatePostmasterIdentity(current, state.pid);
    if (
      verified.creationDate !== state.postmasterIdentity.creationDate ||
      verified.executablePath.toLowerCase() !==
        state.postmasterIdentity.executablePath.toLowerCase()
    ) {
      fail("windows_harness_postmaster_identity_changed");
    }
    return true;
  }

  async function reconcileAmbiguousStart(primaryError) {
    let identity;
    try {
      const pidText = await storage.readFile(
        path.join(paths.clusterRoot, "postmaster.pid"),
        "utf8"
      );
      const pid = Number(String(pidText).split(/\r?\n/, 1)[0]);
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("pid_invalid");
      identity = await capturePostmasterIdentity(pid);
      state.pid = pid;
      state.postmasterIdentity = identity;
    } catch {
      identity = null;
    }
    if (identity) {
      try {
        if ((await postmasterAlive()) !== true) throw new Error("identity_lost");
        await processRunner.run({
          executable: executables.pgCtl,
          args: ["stop", "-D", paths.clusterRoot, "-m", "immediate", "-w", "-t", "30"],
          cwd: paths.ownedRoot,
          environment: systemEnvironment,
          timeoutMs: 45_000,
          label: "postgres_start_compensation"
        });
        const gone = (await systemProbe.processIdentity(identity.pid)) === null;
        if (gone && (await systemCleanSnapshot()).clean === true) {
          state.pid = null;
          state.postmasterIdentity = null;
          state.started = false;
          state.startAmbiguous = false;
          throw primaryError;
        }
      } catch (error) {
        if (error === primaryError) throw error;
      }
    } else {
      try {
        if ((await systemCleanSnapshot()).clean === true) {
          state.started = false;
          state.startAmbiguous = false;
          throw primaryError;
        }
      } catch (error) {
        if (error === primaryError) throw error;
      }
    }
    throw new WindowsPhysicalAdapterFailure(
      "windows_harness_start_compensation_unconfirmed"
    );
  }

  async function preflight(input) {
    bind(input);
    if ((options.platform || process.platform) !== "win32") fail("windows_harness_platform_refused");
    const firewallCommand = firewallNonmutation.firewallLightEvidencePowerShell();
    state.firewallExecutableProof =
      firewallNonmutation.proveLoopbackNonmutationExecutablePath({
        command: firewallCommand,
        sources: firewallExecutableSources(repositoryRoot)
      });
    if (typeof physicalGates.assertConfigured === "function") physicalGates.assertConfigured();
    const archivePath = requireWithin(input.packageDescriptor.archivePath, ownedRoot, "windows_harness_archive_outside_root");
    if (typeof systemProbe.protectAndAuditRoot !== "function") {
      fail("windows_harness_root_acl_probe_missing");
    }
    const rootAcl = await systemProbe.protectAndAuditRoot(ownedRoot);
    if (
      typeof rootAcl?.ownerCurrentUser !== "boolean" ||
      typeof rootAcl?.inheritanceProtected !== "boolean" ||
      !Number.isSafeInteger(rootAcl?.explicitRuleCount) ||
      !Number.isSafeInteger(rootAcl?.inheritedRuleCount) ||
      !Number.isSafeInteger(rootAcl?.denyRuleCount) ||
      !Number.isSafeInteger(rootAcl?.unexpectedAllowRuleCount) ||
      [
        rootAcl.explicitRuleCount,
        rootAcl.inheritedRuleCount,
        rootAcl.denyRuleCount,
        rootAcl.unexpectedAllowRuleCount
      ].some((value) => value < 0)
    ) {
      fail("windows_harness_root_acl_invalid");
    }
    state.rootAclEvidence = Object.freeze({
      ownerCurrentUser: rootAcl.ownerCurrentUser,
      inheritanceProtected: rootAcl.inheritanceProtected,
      explicitRuleCount: rootAcl.explicitRuleCount,
      inheritedRuleCount: rootAcl.inheritedRuleCount,
      denyRuleCount: rootAcl.denyRuleCount,
      unexpectedAllowRuleCount: rootAcl.unexpectedAllowRuleCount
    });
    if (
      rootAcl.ownerCurrentUser !== true ||
      rootAcl.inheritanceProtected !== true ||
      rootAcl.explicitRuleCount !== 3 ||
      rootAcl.inheritedRuleCount !== 0 ||
      rootAcl.denyRuleCount !== 0 ||
      rootAcl.unexpectedAllowRuleCount !== 0
    ) {
      fail("windows_harness_root_acl_invalid");
    }
    const initialFreeBytes = await measureSpace("initialFreeBytes");
    if (initialFreeBytes < MINIMUM_FREE_BYTES) {
      fail("windows_harness_insufficient_free_space");
    }
    if (typeof systemProbe.firewallLightEvidence !== "function") {
      fail("windows_harness_firewall_probe_missing");
    }
    state.firewallBefore = firewallNonmutation.validateFirewallLightEvidence(
      await systemProbe.firewallLightEvidence({ signal: input.signal })
    );
    state.firewallContext = firewallNonmutation.validateLoopbackNonmutationContext({
      mode: state.firewallBefore.firewallEvidenceMode,
      platform: options.platform || process.platform,
      scope: firewallNonmutation.FIREWALL_EVIDENCE_SCOPE,
      host: state.target.host,
      processElevated: state.firewallBefore.processElevated
    });
    const root = await storage.lstat(ownedRoot);
    const archiveStat = await storage.stat(archivePath);
    if (!Number.isSafeInteger(archiveStat?.size) || archiveStat.size < 1) {
      fail("windows_harness_archive_size_invalid");
    }
    const packageMatch = /^postgresql-18\.4-(\d+)-windows-x64-binaries\.zip$/.exec(
      path.basename(archivePath)
    );
    if (!packageMatch) {
      fail("windows_harness_archive_build_invalid");
    }
    const packageBuild = Number(packageMatch[1]);
    if (!Number.isSafeInteger(packageBuild) || packageBuild < 1) {
      fail("windows_harness_archive_build_invalid");
    }
    state.packageEvidence = Object.freeze({
      archiveBytes: archiveStat.size,
      build: packageBuild,
      sourceOwnedByRun: input.packageDescriptor.sourceOwnedByRun === true
    });
    assertActive(input);
    if (!root.isDirectory() || root.isSymbolicLink() || !archiveStat.isFile()) {
      fail("windows_harness_preflight_filesystem_invalid");
    }
    const initialEntries = await storage.readdir(ownedRoot);
    if (initialEntries.some((name) => /\.(?:part|partial|tmp|crdownload)$/i.test(name))) {
      fail("windows_harness_partial_download_detected");
    }
    state.preflightSystemSnapshot = await systemCleanSnapshot();
    if (state.preflightSystemSnapshot.clean !== true) {
      fail("windows_harness_postgres_activity_detected");
    }
    assertActive(input);
    await storage.access(path.join(repositoryRoot, "db", "postgres", "roles.sql"));
    await storage.access(path.join(repositoryRoot, "scripts", "social-3a0p-local-safe-zip-extract.ps1"));
    if (
      typeof storage.exists !== "function" ||
      typeof storage.rename !== "function" ||
      typeof storage.unlink !== "function" ||
      typeof storage.existsSync !== "function" ||
      typeof storage.readFileSync !== "function" ||
      typeof storage.renameSync !== "function" ||
      typeof storage.unlinkSync !== "function" ||
      typeof storage.writeFileSync !== "function" ||
      typeof storage.statfs !== "function"
    ) {
      fail("windows_harness_storage_contract_invalid");
    }
    for (const evidencePath of [
      paths.evidencePath,
      paths.evidencePendingPath,
      paths.evidenceFinalizingPath
    ]) {
      if (await storage.exists(evidencePath)) fail("windows_harness_evidence_path_exists");
    }
    assertActive(input);
    await storage.mkdir(paths.logsRoot, { recursive: false });
    const firewallComponents = Object.fromEntries(
      state.firewallBefore.components.map((entry) => [entry.componentName, entry])
    );
    return remember("preflight", {
      code: "windows_preflight_passed",
      counts: {
        packageBytes: state.packageEvidence.archiveBytes,
        packageBuild: state.packageEvidence.build,
        diskInitialFreeBytes: initialFreeBytes,
        diskMinimumRequiredFreeBytes: MINIMUM_FREE_BYTES,
        firewallProfiles: firewallComponents.profiles.objectCount,
        firewallGlobalSettings: firewallComponents.globalSettings.objectCount,
        firewallRules: firewallComponents.rulesMetadata.objectCount,
        postgresProcessesBefore: state.preflightSystemSnapshot.processes,
        postgresServicesBeforeIncludingStopped:
          state.preflightSystemSnapshot.services,
        targetPortListenersBefore: state.preflightSystemSnapshot.listeners,
        rootAclExplicitRules: rootAcl.explicitRuleCount,
        rootAclInheritedRules: rootAcl.inheritedRuleCount,
        rootAclDenyRules: rootAcl.denyRuleCount,
        rootAclUnexpectedAllowRules: rootAcl.unexpectedAllowRuleCount
      },
      hashes: {
        firewallProfilesBeforeSha256: firewallComponents.profiles.sha256,
        firewallGlobalSettingsBeforeSha256:
          firewallComponents.globalSettings.sha256,
        firewallRulesBeforeSha256: firewallComponents.rulesMetadata.sha256,
        firewallBeforeSha256: state.firewallBefore.aggregateSha256
      },
      inventory: [
        ...packageInventory(),
        "firewall-evidence-mode-loopback-nonmutation-v1"
      ],
      checks: {
        ownedRootValidated: true,
        rootAclProtected: true,
        rootAclOwnerCurrentUser: rootAcl.ownerCurrentUser,
        rootAclInheritanceProtected: rootAcl.inheritanceProtected,
        packageSourceOwnedByRun: state.packageEvidence.sourceOwnedByRun,
        workingCopyOwnedByRun: true,
        postgresAbsent: true,
        portAvailable: true,
        postgresProcessesZero: state.preflightSystemSnapshot.processes === 0,
        postgresServicesZeroIncludingStopped:
          state.preflightSystemSnapshot.services === 0,
        postgresServiceExecutablePathsInspected:
          state.preflightSystemSnapshot.serviceExecutablePathsInspected === true,
        targetPortListenersZero: state.preflightSystemSnapshot.listeners === 0,
        targetPortAvailable: state.preflightSystemSnapshot.listeners === 0,
        minimumFreeSpaceSatisfied: initialFreeBytes >= MINIMUM_FREE_BYTES,
        firewallMutationCommandsAbsent:
          state.firewallExecutableProof.firewallMutationCommandsAbsent,
        uacElevationCommandsAbsent:
          state.firewallExecutableProof.uacElevationCommandsAbsent,
        scheduledTaskMutationCommandsAbsent:
          state.firewallExecutableProof.scheduledTaskMutationCommandsAbsent,
        serviceMutationCommandsAbsent:
          state.firewallExecutableProof.serviceMutationCommandsAbsent,
        localUserMutationCommandsAbsent:
          state.firewallExecutableProof.localUserMutationCommandsAbsent,
        currentUserResolved: state.firewallBefore.currentUserResolved,
        processNonElevated: state.firewallContext.processNonElevated,
        integrityNonAdministrative:
          state.firewallBefore.integrityNonAdministrative,
        firewallLightBaselineCaptured: true,
        fullFirewallFilterSnapshotProved: false
      }
    });
  }

  async function validatePackage(input) {
    bind(input);
    if (input.packageDescriptor.version !== POSTGRES_VERSION) {
      fail("windows_harness_postgres_version_mismatch");
    }
    const actual = await storage.hashFile(input.packageDescriptor.archivePath);
    assertActive(input);
    if (SHA256.test(actual)) state.observedPackageSha256 = actual;
    if (!SHA256.test(actual) || actual !== input.packageDescriptor.expectedSha256) {
      fail("windows_harness_archive_sha256_mismatch");
    }
    const entries = await archive.list(input.packageDescriptor.archivePath);
    assertActive(input);
    if (!Array.isArray(entries) || entries.length < REQUIRED_ARCHIVE_FILES.length) {
      fail("windows_harness_archive_inventory_invalid");
    }
    const relative = entries
      .map((entry) => canonicalArchiveEntry(entry))
      .filter((entry) => entry !== layoutRoot)
      .map((entry) => stripLayout(entry, layoutRoot));
    const collisionSet = new Set(relative.map((entry) => entry.toLowerCase()));
    if (collisionSet.size !== relative.length) {
      fail("windows_harness_archive_inventory_invalid");
    }
    for (const required of REQUIRED_ARCHIVE_FILES) {
      if (!relative.includes(required)) fail("windows_harness_archive_inventory_invalid");
    }
    state.archiveEntries = entries.slice();
    return remember("validate-package", {
      code: "windows_package_validated",
      counts: {
        archiveEntries: entries.length,
        packageBytes: state.packageEvidence.archiveBytes,
        packageBuild: state.packageEvidence.build
      },
      hashes: { archiveSha256: actual },
      inventory: packageInventory(),
      checks: {
        postgresVersionDeclared:
          input.packageDescriptor.version === POSTGRES_VERSION,
        packageSourceOwnedByRun: state.packageEvidence.sourceOwnedByRun,
        workingCopyOwnedByRun: true
      }
    });
  }

  async function extractPackage(input) {
    bind(input);
    const beforeExtractionFreeBytes = await measureSpace(
      "beforeExtractionFreeBytes"
    );
    await storage.mkdir(paths.binaryRoot, { recursive: false });
    assertActive(input);
    const actual = await storage.hashFile(input.packageDescriptor.archivePath);
    if (SHA256.test(actual)) state.observedPackageSha256 = actual;
    if (!SHA256.test(actual) || actual !== input.packageDescriptor.expectedSha256) {
      fail("windows_harness_archive_sha256_mismatch");
    }
    assertActive(input);
    await archive.extract(
      input.packageDescriptor.archivePath,
      ownedRoot,
      state.archiveEntries,
      input.packageDescriptor.expectedSha256
    );
    assertActive(input);
    await storage.assertTreeSafe(paths.binaryRoot);
    assertActive(input);
    for (const executable of [executables.postgres, executables.initdb, executables.pgCtl, executables.pgIsReady]) {
      const item = await storage.stat(executable);
      if (!item.isFile()) fail("windows_harness_postgres_binary_missing");
    }
    const version = await processRunner.run({
      executable: executables.postgres,
      args: ["--version"],
      cwd: paths.ownedRoot,
      environment: systemEnvironment,
      timeoutMs: 15_000,
      label: "postgres_version"
    });
    assertActive(input);
    if (!/\b18\.4\b/.test(version.stdoutSanitized) || /\b18\.(?!4\b)\d+\b/.test(version.stdoutSanitized)) {
      fail("windows_harness_postgres_version_mismatch");
    }
    const afterExtractionFreeBytes = await measureSpace(
      "afterExtractionFreeBytes"
    );
    return remember("extract-package", {
      code: "windows_package_extracted",
      counts: {
        diskBeforeExtractionFreeBytes: beforeExtractionFreeBytes,
        diskAfterExtractionFreeBytes: afterExtractionFreeBytes,
        diskMinimumObservedFreeBytes: state.diskSpace.minimumFreeBytes
      },
      checks: { treeSafe: true, executablesPresent: true, postgresVersionExact: true }
    });
  }

  async function initializeCluster(input) {
    bind(input);
    await storage.mkdir(paths.clusterRoot, { recursive: false });
    assertActive(input);
    state.materials.admin = fixedPassword(randomBytes);
    state.materials.provisioner = fixedPassword(randomBytes);
    state.materials.migration = fixedPassword(randomBytes);
    state.materials.runtime = fixedPassword(randomBytes);
    state.materials.dpapiProbe = randomBytes(32);
    state.materials.vault = randomBytes(32);
    const initInput = Buffer.concat([state.materials.admin, Buffer.from("\n")]);
    try {
      await processRunner.run({
        executable: executables.initdb,
        args: ["--pgdata", paths.clusterRoot, "--username", ADMIN_LOGIN, "--auth-host", "scram-sha-256", "--auth-local", "scram-sha-256", "--pwfile=-", "--encoding=UTF8", "--locale=C", "--data-checksums"],
        cwd: paths.ownedRoot,
        environment: systemEnvironment,
        timeoutMs: 10 * 60_000,
        input: initInput,
        secretValues: [state.materials.admin, initInput],
        label: "postgres_initdb"
      });
      assertActive(input);
    } finally {
      initInput.fill(0);
    }
    await storage.appendFile(path.join(paths.clusterRoot, "postgresql.conf"), [
      "",
      "listen_addresses = '127.0.0.1'",
      `port = ${state.target.port}`,
      "ssl = off",
      "password_encryption = 'scram-sha-256'",
      "fsync = on",
      "synchronous_commit = on",
      "max_connections = 24",
      ""
    ].join("\n"));
    assertActive(input);
    await storage.writeFile(path.join(paths.clusterRoot, "pg_hba.conf"), [
      "host all all 127.0.0.1/32 scram-sha-256",
      "host all all ::1/128 reject",
      ""
    ].join("\n"), { encoding: "utf8", flag: "w" });
    assertActive(input);
    state.initialized = true;
    return remember("initialize-cluster", {
      code: "windows_cluster_initialized",
      checks: {
        loopbackOnly: true,
        scramConfigured: true,
        durableWritesConfigured: true,
        dataChecksumsRequested: true
      }
    });
  }

  async function startCluster(input) {
    bind(input);
    if (!state.initialized) fail("windows_harness_cluster_not_initialized");
    try {
      await processRunner.run({
        executable: executables.pgCtl,
        args: ["start", "-D", paths.clusterRoot, "-l", path.join(paths.logsRoot, "postgres.log"), "-W"],
        cwd: paths.ownedRoot,
        environment: systemEnvironment,
        timeoutMs: 60_000,
        label: "postgres_start"
      });
      state.started = true;
      state.startAmbiguous = true;
      assertActive(input);
    } catch (error) {
      state.started = true;
      state.startAmbiguous = true;
      return reconcileAmbiguousStart(error);
    }
    let pid;
    try {
      const pidText = await storage.readFile(path.join(paths.clusterRoot, "postmaster.pid"), "utf8");
      assertActive(input);
      pid = Number(String(pidText).split(/\r?\n/, 1)[0]);
      if (!Number.isSafeInteger(pid) || pid < 1) fail("windows_harness_postmaster_pid_invalid");
      state.postmasterIdentity = await capturePostmasterIdentity(pid);
    } catch (error) {
      return reconcileAmbiguousStart(error);
    }
    state.pid = pid;
    state.startAmbiguous = false;
    return remember("start-cluster", {
      code: "windows_cluster_started",
      counts: {
        serverProcesses: 1,
        postmasterPid: pid,
        clusterPort: state.target.port
      },
      metrics: { postgresMajor: 18, postgresMinor: 4 },
      inventory: ["address-127-0-0-1", "postgresql-18-4"],
      checks: {
        postmasterPidRecorded: true,
        clusterAddressLoopback: true
      }
    });
  }

  async function createReadinessProbes(input) {
    bind(input);
    if (!state.started || !state.pid || typeof PoolClass !== "function") {
      fail("windows_harness_readiness_configuration_invalid");
    }
    return {
      pid: state.pid,
      probes: {
        processAlive: async (pid) => {
          if (pid !== state.pid) fail("windows_harness_postmaster_pid_changed");
          return postmasterAlive();
        },
        listeners: async (pid) => {
          if (pid !== state.pid || (await postmasterAlive()) !== true) {
            fail("windows_harness_postmaster_identity_changed");
          }
          const rows = await systemProbe.listeners(pid, state.target);
          const exactLoopbackListener = Array.isArray(rows) && rows.length === 1 &&
            rows[0]?.address === LOOPBACK_HOST &&
            Number(rows[0]?.port) === state.target.port &&
            Number(rows[0]?.pid) === state.pid;
          state.loopbackOnlyListenerProved = exactLoopbackListener;
          state.externalListenerAbsent = exactLoopbackListener;
          return rows;
        },
        async pgIsReady() {
          try {
            await processRunner.run({
              executable: executables.pgIsReady,
              args: ["-h", LOOPBACK_HOST, "-p", String(state.target.port), "-d", "postgres", "-U", ADMIN_LOGIN],
              cwd: paths.ownedRoot,
              environment: systemEnvironment,
              timeoutMs: 5_000,
              label: "postgres_pg_isready"
            });
            return true;
          } catch {
            return false;
          }
        },
        async openAdminSession() {
          let pool;
          let client;
          try {
            pool = new PoolClass(poolOptions(state, ADMIN_LOGIN, state.materials.admin, 1, "ia4tube-social-local-readiness", "postgres"));
            client = await pool.connect();
          } catch {
            await closePool(pool).catch(() => {});
            return null;
          }
          return {
            async selectOne() {
              const result = await client.query("SELECT 1::integer AS value");
              return Number(result.rows?.[0]?.value);
            },
            async serverVersion() {
              const result = await client.query("SHOW server_version");
              return String(result.rows?.[0]?.server_version || "");
            },
            async listenAddresses() {
              const result = await client.query("SHOW listen_addresses");
              const value = String(result.rows?.[0]?.listen_addresses || "");
              state.effectiveListenAddressesLoopback = value === LOOPBACK_HOST;
              return value;
            },
            async close() {
              client.release();
              await pool.end();
              return true;
            }
          };
        }
      }
    };
  }

  async function bootstrapRoles(input) {
    bind(input);
    if (typeof effectiveRoleBootstrap !== "function") fail("windows_harness_role_bootstrap_missing");
    let result;
    try {
      result = validateGateResult("role_bootstrap", await effectiveRoleBootstrap({ state, input }), ["idempotent", "runtimeSafe", "migrationSafe", "scramVerified"]);
      assertActive(input);
    } catch (error) {
      throw sanitizedFailure(error, "windows_harness_role_bootstrap_failed");
    }
    if (
      !Number.isSafeInteger(result.createdCount) ||
      result.createdCount < 0 ||
      result.createdCount > 2
    ) {
      fail("windows_harness_role_bootstrap_measurement_invalid");
    }
    state.productDatabasePrepared = true;
    return remember("bootstrap-roles", {
      code: "windows_roles_bootstrapped",
      counts: { rolesCreated: result.createdCount, roleKinds: 3 },
      checks: { rolesIdempotent: true, runtimeSafe: true, migrationSafe: true, scramVerified: true }
    });
  }

  async function establishCustody(input) {
    bind(input);
    const adapter = options.dependencies?.dpapi || {
      async protectAndVerify({ material }) {
        const encoded = Buffer.from(material.toString("base64"), "utf8");
        try {
          const result = await processRunner.run({
            executable: executables.powershell,
            args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", dpapiScript, "-OwnedRoot", paths.ownedRoot, "-OwnedParent", paths.ownedParent, "-CustodyPath", paths.custodyPath],
            cwd: paths.ownedRoot,
            environment: systemEnvironment,
            timeoutMs: 45_000,
            input: encoded,
            secretValues: [material, encoded],
            label: "dpapi_round_trip"
          });
          const evidence = parseJsonLine(result.stdoutSanitized, "windows_harness_dpapi_output_invalid");
          return {
            dpapiProtected: evidence.dpapiProtected === true,
            roundTripVerified: evidence.roundTripVerified === true,
            plaintextPersisted: evidence.plaintextPersisted === false,
            scope: evidence.currentUserScope === true ? "CurrentUser" : "invalid",
            custodyCreatedByThisRun: evidence.dpapiProtected === true,
            temporaryCustodyRemoved: evidence.temporaryCustodyRemoved === true
          };
        } finally {
          encoded.fill(0);
        }
      },
      async remove() {
        await storage.rm(paths.custodyPath, { force: true });
        return true;
      }
    };
    await establishDpapiCustody({
      adapter,
      material: state.materials.dpapiProbe,
      custodyPath: paths.custodyPath,
      ownedRoot: paths.ownedRoot
    });
    assertActive(input);
    return remember("establish-dpapi-custody", {
      code: "windows_dpapi_custody_verified",
      checks: { dpapiProtected: true, roundTripVerified: true, plaintextPersisted: false, temporaryCustodyRemoved: true }
    });
  }

  async function runMigrationGate(input) {
    bind(input);
    const result = validateGateResult("migration", await physicalGates.migration({ state, input }), ["profile0004", "transactionalRollback", "nonSocialUnchanged"]);
    assertActive(input);
    return remember("run-migration-gate", {
      code: "windows_migration_gate_passed",
      counts: { migrationsApplied: Number(result.migrationsApplied || 4) },
      checks: { profile0004: true, transactionalRollback: true, nonSocialUnchanged: true }
    });
  }

  async function runRlsGate(input) {
    bind(input);
    const result = validateGateResult("rls", await physicalGates.rls({ state, input }), ["tenantIsolation", "missingContextRefused", "tamperedContextRefused", "forceRls"]);
    assertActive(input);
    return remember("run-rls-gate", {
      code: "windows_rls_gate_passed",
      counts: { syntheticCompanies: Number(result.syntheticCompanies || 2) },
      checks: { tenantIsolation: true, missingContextRefused: true, tamperedContextRefused: true, forceRls: true }
    });
  }

  async function runConcurrencyGate(input) {
    bind(input);
    validateGateResult("concurrency", await physicalGates.concurrency({ state, input }), ["concurrencySafe", "oauthSynthetic", "idempotencySafe", "externalCallsAbsent"]);
    assertActive(input);
    return remember("run-concurrency-gate", {
      code: "windows_concurrency_gate_passed",
      checks: { concurrencySafe: true, oauthSynthetic: true, idempotencySafe: true, externalCallsAbsent: true }
    });
  }

  async function runVaultGate(input) {
    bind(input);
    validateGateResult("vault", await physicalGates.vault({ state, input }), ["aes256Gcm", "aadBound", "roundTrip", "rotation", "plaintextAbsent"]);
    assertActive(input);
    return remember("run-vault-gate", {
      code: "windows_vault_gate_passed",
      checks: { aes256Gcm: true, aadBound: true, roundTripVerified: true, rotationVerified: true, plaintextPersisted: false }
    });
  }

  async function runBackupRestoreGate(input) {
    bind(input);
    const result = validateGateResult("backup_restore", await physicalGates.backupRestore({ state, input }), ["profile0003", "profile0004", "restoreIsolated", "manifestTamperRefused", "crossProfileRefused", "operationalRollback", "disposableRemoved", "fileFsync"]);
    assertActive(input);
    const bundles = collectMeasuredBundleMetrics({
      bundles: [
        {
          profile: "social-schema-0003",
          size: result.bundle0003Size,
          sha256: result.bundle0003Sha256,
          tableCount: result.bundle0003Tables,
          rlsPolicyCount: result.bundle0003RlsPolicies,
          restoreApproved: result.profile0003 === true
        },
        {
          profile: "social-schema-0004",
          size: result.bundle0004Size,
          sha256: result.bundle0004Sha256,
          tableCount: result.bundle0004Tables,
          rlsPolicyCount: result.bundle0004RlsPolicies,
          restoreApproved: result.profile0004 === true
        }
      ]
    });
    assertBundleMetricsSafe(bundles);
    state.backupRestoreCompleted = true;
    return remember("run-backup-restore-gate", {
      code: "windows_backup_restore_gate_passed",
      counts: {
        schemaProfiles: 2,
        ...bundles.counts
      },
      hashes: { ...bundles.hashes },
      checks: {
        profile0003: true,
        profile0004: true,
        ...bundles.checks,
        restoreIsolated: true,
        manifestTamperRefused: true,
        crossProfileRefused: true,
        operationalRollback: true,
        fileFsync: true,
        disposableDatabasesRemoved: result.disposableRemoved === true
      },
      pendencies: ["directory-fsync-linux", "nofollow-linux"]
    });
  }

  async function collectRuntimeEvidenceMetrics() {
    const AuditPoolClass = loadBasePoolClass();
    const auditPool = new AuditPoolClass(poolOptions(
      state,
      ADMIN_LOGIN,
      state.materials.admin,
      1,
      "ia4tube-social-local-session-audit"
    ));
    poolMetrics.register(auditPool, {
      category: "administration",
      configuredMax: 1
    });
    poolMetrics.observe(auditPool, metricView(auditPool));
    let client;
    try {
      client = await auditPool.connect();
      poolMetrics.recordAcquisition(auditPool, metricView(auditPool));
      const checksum = await collectDataChecksumsMetric({
        async readSetting() {
          const result = await client.query("SHOW data_checksums");
          return result.rows?.[0]?.data_checksums;
        }
      });
      assertDataChecksumsEnabled(checksum);
      const observed = await client.query([
        "SELECT pid::integer AS pid, usename AS role, state, application_name",
        "FROM pg_catalog.pg_stat_activity",
        "WHERE pid<>pg_backend_pid()",
        "  AND backend_type='client backend'",
        "ORDER BY pid"
      ].join(" "));
      const sessions = (observed.rows || []).map((row) => ({
        pid: Number(row.pid),
        role: String(row.role || ""),
        state: String(row.state || ""),
        applicationName: String(row.application_name || "")
      }));
      const ownedSessions = [...sessionOwnership.values()];
      const sessionMetrics = collectSessionMetrics({
        sessions,
        ownedSessions,
        roleCategories: {
          runtime: [RUNTIME_LOGIN],
          migration: [MIGRATION_LOGIN],
          provisioning: [PROVISIONER_LOGIN, ADMIN_LOGIN]
        }
      });
      assertSessionMetricsSafe(sessionMetrics);
      const pool = poolMetrics.snapshot();
      return Object.freeze({
        counts: {
          ...pool.counts,
          ...sessionMetrics.counts
        },
        metrics: { ...pool.metrics },
        checks: {
          ...pool.checks,
          ...sessionMetrics.checks,
          ...checksum.checks
        }
      });
    } finally {
      if (client && typeof client.release === "function") client.release();
      try {
        await closePool(auditPool);
      } finally {
        poolMetrics.observe(auditPool, metricView(auditPool));
        poolMetrics.unregister(auditPool);
      }
    }
  }

  async function collectSanitizedEvidence(input) {
    bind(input);
    const runtimeMetrics = await collectRuntimeEvidenceMetrics();
    const phases = Object.fromEntries(
      Object.keys(state.phaseResults)
        .sort()
        .map((phase) => [phase, state.phaseResults[phase]])
    );
    const pendingPayload = {
      schemaVersion: 1,
      status: "pending_cleanup",
      physicalExecution: false,
      syntheticOnly: true,
      phaseCount: Object.keys(state.phaseResults).length,
      phases,
      pendingLinuxProofs: ["directory-fsync-linux", "nofollow-linux"]
    };
    const evidenceSha256 = crypto.createHash("sha256")
      .update(JSON.stringify(pendingPayload))
      .digest("hex");
    const evidence = { ...pendingPayload, evidenceSha256 };
    assertActive(input);
    await storage.writeFile(
      paths.evidencePendingPath,
      `${JSON.stringify(evidence)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    assertActive(input);
    state.pendingEvidence = evidence;
    return remember("collect-sanitized-evidence", {
      code: "windows_evidence_collected",
      counts: {
        completedPhases: evidence.phaseCount,
        ...runtimeMetrics.counts
      },
      metrics: { ...runtimeMetrics.metrics },
      hashes: { evidenceSha256 },
      inventory: ["physical-gates", "owned-resources", "linux-pendencies"],
      checks: {
        syntheticOnly: true,
        sensitiveDataAbsent: true,
        ...runtimeMetrics.checks
      }
    });
  }

  async function helperProcessStillOwned(pid) {
    const proof = activeChildOwnership.get(pid);
    if (!proof) fail("windows_harness_child_identity_missing");
    let originalActive;
    try {
      originalActive = proof.isOriginalProcessActive() === true;
    } catch {
      fail("windows_harness_child_identity_unconfirmed");
    }
    if (!originalActive) {
      activeChildPids.delete(pid);
      activeChildOwnership.delete(pid);
      return false;
    }
    let current;
    try {
      current = await systemProbe.processIdentity(pid);
    } catch {
      fail("windows_harness_child_identity_unconfirmed");
    }
    if (current === null) {
      activeChildPids.delete(pid);
      activeChildOwnership.delete(pid);
      return false;
    }
    if (
      Number(current?.pid) !== pid ||
      path.resolve(String(current?.executablePath || "")).toLowerCase() !==
        proof.executablePath.toLowerCase()
    ) {
      fail("windows_harness_child_identity_changed");
    }
    return true;
  }

  async function terminateProcessTree() {
    const terminate = options.dependencies?.terminateProcessTree ||
      ((pid) => terminateWindowsProcessTree(pid, {
        taskkillPath: executables.taskkill
      }));
    const targets = new Set([
      ...activeChildPids,
      ...activeChildOwnership.keys()
    ]);
    if (state.pid) targets.add(state.pid);
    let allConfirmed = activeChildPids.size === activeChildOwnership.size;
    for (const pid of targets) {
      if (pid === state.pid) {
        try {
          if ((await postmasterAlive()) !== true) {
            state.pid = null;
            state.postmasterIdentity = null;
            continue;
          }
        } catch {
          allConfirmed = false;
          continue;
        }
      } else {
        try {
          if ((await helperProcessStillOwned(pid)) !== true) continue;
        } catch {
          allConfirmed = false;
          continue;
        }
      }
      const terminated = await Promise.resolve()
        .then(() => terminate(pid))
        .catch(() => false);
      if (terminated === true) {
        const remaining = await systemProbe.processIdentity(pid)
          .catch(() => ({ unconfirmed: true }));
        if (remaining !== null) {
          allConfirmed = false;
          continue;
        }
        state.processTreesTerminated += 1;
        activeChildPids.delete(pid);
        activeChildOwnership.delete(pid);
        if (state.pid === pid) {
          state.pid = null;
          state.postmasterIdentity = null;
        }
      } else {
        allConfirmed = false;
      }
    }
    return allConfirmed;
  }

  async function cleanup(input) {
    bind(input);
    let poolsClosed = 0;
    let cleanupFailure = null;
    const recordFailure = (code) => {
      if (!cleanupFailure) cleanupFailure = new WindowsPhysicalAdapterFailure(code);
    };
    for (const pool of Object.values(state.pools)) {
      try {
        await closePool(pool);
        poolsClosed += 1;
      } catch {
        recordFailure("windows_harness_cleanup_pool_failed");
      }
    }
    state.pools = Object.create(null);
    let processConfirmedStopped = !state.pid &&
      !state.startAmbiguous &&
      activeChildPids.size === 0 &&
      activeChildOwnership.size === 0;
    if (state.pid) {
      const stoppingPid = state.pid;
      try {
        if ((await postmasterAlive()) !== true) {
          state.pid = null;
          state.postmasterIdentity = null;
          throw new Error("postmaster_absent");
        }
        await processRunner.run({
          executable: executables.pgCtl,
          args: ["stop", "-D", paths.clusterRoot, "-m", "immediate", "-w", "-t", "30"],
          cwd: paths.ownedRoot,
          environment: systemEnvironment,
          timeoutMs: 45_000,
          label: "postgres_stop"
        });
        const stillAlive = await postmasterAlive();
        const listeners = await systemProbe.listeners(stoppingPid, state.target);
        if (stillAlive || listeners.length > 0) {
          if ((await terminateProcessTree()) !== true) throw new Error("termination_failed");
        } else {
          state.pid = null;
        }
      } catch {
        if ((await terminateProcessTree()) !== true) {
          recordFailure("windows_harness_cleanup_process_failed");
        }
      }
      try {
        const current = await systemProbe.processIdentity(stoppingPid);
        processConfirmedStopped = current === null;
      } catch {
        processConfirmedStopped = false;
      }
      if (!processConfirmedStopped) {
        recordFailure("windows_harness_cleanup_process_unconfirmed");
      }
    }
    if (state.startAmbiguous) {
      try {
        processConfirmedStopped = (await systemCleanSnapshot()).clean === true &&
          activeChildPids.size === 0 &&
          activeChildOwnership.size === 0;
      } catch {
        processConfirmedStopped = false;
      }
      if (processConfirmedStopped) {
        state.startAmbiguous = false;
        state.started = false;
      } else {
        recordFailure("windows_harness_cleanup_process_unconfirmed");
      }
    }
    if (activeChildPids.size > 0 || activeChildOwnership.size > 0) {
      if ((await terminateProcessTree()) !== true) {
        processConfirmedStopped = false;
        recordFailure("windows_harness_cleanup_child_process_failed");
      } else if (!state.pid && !state.startAmbiguous) {
        processConfirmedStopped = true;
      }
    }
    for (const material of Object.values(state.materials)) {
      if (Buffer.isBuffer(material)) material.fill(0);
    }
    state.materials = Object.create(null);
    try {
      await physicalGates.destroy?.();
    } catch {
      recordFailure("windows_harness_cleanup_gate_material_failed");
    }
    let workingPackageRemoved = false;
    let ownedRootRemoved = false;
    if (processConfirmedStopped) {
      try {
        const workingPackage = requireWithin(
          state.packageDescriptor.archivePath,
          paths.ownedRoot,
          "windows_harness_working_package_outside_root"
        );
        if (await storage.exists(workingPackage)) {
          await storage.unlink(workingPackage);
        }
        workingPackageRemoved = (await storage.exists(workingPackage)) === false;
        if (!workingPackageRemoved) {
          recordFailure("windows_harness_working_package_removal_unconfirmed");
        } else {
          state.workingPackageRemoved = true;
          await measureSpace("afterPackageRemovalFreeBytes");
        }
      } catch {
        recordFailure("windows_harness_working_package_removal_failed");
      }
      try {
        const removed = await storage.removeOwnedTree(
          paths.ownedRoot,
          paths.ownedParent
        );
        ownedRootRemoved = removed === true &&
          (await storage.exists(paths.ownedRoot)) === false;
        if (!ownedRootRemoved) {
          recordFailure("windows_harness_cleanup_owned_root_unconfirmed");
        }
      } catch {
        recordFailure("windows_harness_cleanup_owned_root_failed");
      }
    }
    let firewallUnchanged = false;
    let systemClean = false;
    let noResidualProcesses = false;
    let residualProcessCount = null;
    let finalSystemSnapshot = null;
    let temporaryCustodiesRemaining = null;
    let clusterRemoved = false;
    let binariesRemoved = false;
    try {
      const residual = collectResidualProcessMetrics({
        processes: await systemProbe.residualProcesses(paths.ownedRoot)
      });
      residualProcessCount = residual.counts.residualProcesses;
      assertNoResidualProcesses(residual);
      noResidualProcesses = true;
      await measureSpace("finalFreeBytes");
      finalSystemSnapshot = await systemCleanSnapshot();
      systemClean = finalSystemSnapshot.clean === true;
      if (!systemClean) {
        recordFailure("windows_harness_cleanup_system_not_clean");
      }
      temporaryCustodiesRemaining = (await storage.exists(paths.custodyPath))
        ? 1
        : 0;
      clusterRemoved = (await storage.exists(paths.clusterRoot)) === false;
      binariesRemoved = (await storage.exists(paths.binaryRoot)) === false;
    } catch {
      recordFailure("windows_harness_cleanup_metrics_failed");
    }
    if (state.firewallBefore) {
      try {
        const firewallAfter = firewallNonmutation.validateFirewallLightEvidence(
          await systemProbe.firewallLightEvidence({ signal: input.signal })
        );
        state.firewallAfter = firewallAfter;
        state.firewallComparison = firewallNonmutation.compareFirewallLightEvidence(
          state.firewallBefore,
          firewallAfter
        );
        firewallUnchanged = state.firewallComparison.equal === true;
        if (!firewallUnchanged) {
          const componentCode = {
            profiles: "profiles",
            globalSettings: "global_settings",
            rulesMetadata: "rules_metadata",
            aggregate: "aggregate"
          }[state.firewallComparison.divergentComponent] || "unknown";
          recordFailure(`windows_harness_firewall_${componentCode}_changed`);
        }
      } catch {
        recordFailure("windows_harness_cleanup_firewall_evidence_failed");
      }
    }
    const cleanupCounts = {
      poolsClosed,
      processTreesTerminated: state.processTreesTerminated,
      helperProcessesRemaining: Math.max(
        activeChildPids.size,
        activeChildOwnership.size
      ),
      workingPackagesRemoved: workingPackageRemoved ? 1 : 0
    };
    if (state.initialized) cleanupCounts.clustersRemoved = clusterRemoved ? 1 : 0;
    if (state.productDatabasePrepared) {
      cleanupCounts.primaryDatabasesRemoved = clusterRemoved ? 1 : 0;
    }
    if (state.backupRestoreCompleted) {
      cleanupCounts.restorationDatabasesRemoved =
        clusterRemoved &&
        state.phaseResults["run-backup-restore-gate"]?.checks
          ?.disposableDatabasesRemoved === true
          ? 1
          : 0;
    }
    const firewallBeforeComponents = state.firewallBefore
      ? Object.fromEntries(
        state.firewallBefore.components.map((entry) => [entry.componentName, entry])
      )
      : null;
    const firewallAfterComponents = state.firewallAfter
      ? Object.fromEntries(
        state.firewallAfter.components.map((entry) => [entry.componentName, entry])
      )
      : null;
    const measuredCounts = {
      residualOwnedPostgresProcesses: residualProcessCount,
      postgresProcessesRemaining: finalSystemSnapshot?.processes,
      postgresServicesRemaining: finalSystemSnapshot?.services,
      postgresListenersRemaining: finalSystemSnapshot?.listeners,
      temporaryCustodiesRemaining,
      diskInitialFreeBytes: state.diskSpace.initialFreeBytes,
      diskMinimumObservedFreeBytes: state.diskSpace.minimumFreeBytes,
      diskBeforeExtractionFreeBytes: state.diskSpace.beforeExtractionFreeBytes,
      diskAfterExtractionFreeBytes: state.diskSpace.afterExtractionFreeBytes,
      diskAfterPackageRemovalFreeBytes:
        state.diskSpace.afterPackageRemovalFreeBytes,
      diskFinalFreeBytes: state.diskSpace.finalFreeBytes,
      firewallProfilesBefore: firewallBeforeComponents?.profiles.objectCount,
      firewallGlobalSettingsBefore:
        firewallBeforeComponents?.globalSettings.objectCount,
      firewallRulesBefore: firewallBeforeComponents?.rulesMetadata.objectCount,
      firewallProfilesAfter: firewallAfterComponents?.profiles.objectCount,
      firewallGlobalSettingsAfter:
        firewallAfterComponents?.globalSettings.objectCount,
      firewallRulesAfter: firewallAfterComponents?.rulesMetadata.objectCount
    };
    for (const [name, value] of Object.entries(measuredCounts)) {
      if (Number.isSafeInteger(value) && value >= 0) cleanupCounts[name] = value;
    }
    const cleanupChecks = {
      ownedRootRemoved,
      workingPackageRemoved,
      externalPackageDeletionAttempted: false,
      firewallUnchanged,
      firewallLightEvidenceStable: state.firewallComparison?.equal === true,
      firewallProfilesAndRulesMetadataStable:
        state.firewallComparison?.firewallProfilesAndRulesMetadataStable === true,
      firewallGlobalSettingsStable:
        state.firewallComparison?.firewallGlobalSettingsStable === true,
      fullFirewallFilterSnapshotProved: false,
      firewallMutationCommandsAbsent:
        state.firewallExecutableProof?.firewallMutationCommandsAbsent === true,
      processNonElevated: state.firewallContext?.processNonElevated === true,
      loopbackOnlyListenerProved: state.loopbackOnlyListenerProved === true,
      externalListenerAbsent: state.externalListenerAbsent === true,
      externalExposurePreventedByLoopbackBinding:
        state.loopbackOnlyListenerProved === true &&
        state.externalListenerAbsent === true &&
        state.effectiveListenAddressesLoopback === true,
      effectiveListenAddressesLoopback:
        state.effectiveListenAddressesLoopback === true,
      systemClean,
      noResidualProcesses,
      processesZero: finalSystemSnapshot?.processes === 0,
      servicesZero: finalSystemSnapshot?.services === 0,
      listenersZero: finalSystemSnapshot?.listeners === 0,
      postgresServicesZeroIncludingStopped:
        finalSystemSnapshot?.services === 0,
      postgresServiceExecutablePathsInspected:
        finalSystemSnapshot?.serviceExecutablePathsInspected === true,
      targetPortListenersZero: finalSystemSnapshot?.listeners === 0,
      helpersZero:
        activeChildPids.size === 0 && activeChildOwnership.size === 0,
      temporaryCustodiesZero: temporaryCustodiesRemaining === 0,
      portClosed: finalSystemSnapshot?.listeners === 0,
      finalPortClosed: finalSystemSnapshot?.listeners === 0,
      workingPackageOwnedByRun:
        state.packageDescriptor?.workingCopyOwnedByRun === true,
      sourcePackageExternal:
        state.packageDescriptor?.sourceOwnedByRun === false,
      packageSourceOwnedByRun:
        state.packageDescriptor?.sourceOwnedByRun === true,
      sanitizedEvidencePrepared: false,
      materialsZeroed: true,
      externalSystemsUntouched: true
    };
    if (state.initialized) {
      cleanupChecks.clusterRemoved = clusterRemoved;
      cleanupChecks.binariesRemoved = binariesRemoved;
    }
    if (state.productDatabasePrepared) {
      cleanupChecks.primaryDatabaseRemoved = clusterRemoved;
    }
    if (state.backupRestoreCompleted) {
      cleanupChecks.restorationDatabasesRemoved =
        cleanupCounts.restorationDatabasesRemoved === 1;
    }
    const cleanupResult = {
      code: "windows_cleanup_passed",
      counts: cleanupCounts,
      hashes: state.firewallBefore && state.firewallAfter
        ? {
          firewallProfilesBeforeSha256:
            firewallBeforeComponents.profiles.sha256,
          firewallProfilesAfterSha256:
            firewallAfterComponents.profiles.sha256,
          firewallGlobalSettingsBeforeSha256:
            firewallBeforeComponents.globalSettings.sha256,
          firewallGlobalSettingsAfterSha256:
            firewallAfterComponents.globalSettings.sha256,
          firewallRulesBeforeSha256:
            firewallBeforeComponents.rulesMetadata.sha256,
          firewallRulesAfterSha256:
            firewallAfterComponents.rulesMetadata.sha256,
          firewallBeforeSha256: state.firewallBefore.aggregateSha256,
          firewallAfterSha256: state.firewallAfter.aggregateSha256
        }
        : {},
      checks: cleanupChecks
    };
    if (!cleanupFailure && state.pendingEvidence) {
      try {
        assertActive(input);
        if (
          (await storage.exists(paths.evidencePendingPath)) !== true ||
          (await storage.exists(paths.evidencePath)) !== false ||
          (await storage.exists(paths.evidenceFinalizingPath)) !== false
        ) {
          recordFailure("windows_harness_evidence_finalize_state_invalid");
        } else {
          cleanupResult.checks.sanitizedEvidencePrepared = true;
        }
      } catch {
        recordFailure("windows_harness_evidence_finalize_state_invalid");
      }
    }
    state.cleaned = true;
    if (cleanupFailure) {
      cleanupFailure.partialResult = cleanupResult;
      throw cleanupFailure;
    }
    return cleanupResult;
  }

  function finalizeSanitizedEvidence(input) {
    let finalizingCreated = false;
    let pendingRemoved = false;
    let canonicalPromoted = false;
    try {
      const report = plainObject(input?.report, "windows_harness_evidence_report_invalid");
      assertClosedEvidenceReport(report);
      const cleanupRecord = report.phases.at(-1);
      if (
        report.ok !== true ||
        cleanupRecord?.phase !== "cleanup" ||
        cleanupRecord.status !== "passed" ||
        cleanupRecord.result?.checks?.sanitizedEvidencePrepared !== true ||
        state.cleaned !== true ||
        !state.pendingEvidence ||
        storage.existsSync(paths.evidencePendingPath) !== true ||
        storage.existsSync(paths.evidencePath) !== false ||
        storage.existsSync(paths.evidenceFinalizingPath) !== false
      ) {
        fail("windows_harness_evidence_finalize_state_invalid");
      }
      const finalPayload = {
        schemaVersion: 2,
        status: "complete",
        physicalExecution: true,
        syntheticOnly: true,
        closedReport: report,
        pendingLinuxProofs: ["directory-fsync-linux", "nofollow-linux"]
      };
      const evidenceSha256 = crypto.createHash("sha256")
        .update(JSON.stringify(finalPayload))
        .digest("hex");
      const finalEvidence = { ...finalPayload, evidenceSha256 };
      storage.writeFileSync(
        paths.evidenceFinalizingPath,
        `${JSON.stringify(finalEvidence)}\n`,
        { encoding: "utf8", flag: "wx" }
      );
      finalizingCreated = true;
      const staged = JSON.parse(
        storage.readFileSync(paths.evidenceFinalizingPath, "utf8")
      );
      const stagedHash = staged.evidenceSha256;
      delete staged.evidenceSha256;
      const stagedRecalculated = crypto.createHash("sha256")
        .update(JSON.stringify(staged))
        .digest("hex");
      if (
        staged.status !== "complete" ||
        staged.physicalExecution !== true ||
        staged.closedReport?.ok !== true ||
        staged.closedReport?.phases?.at(-1)?.status !== "passed" ||
        stagedHash !== stagedRecalculated
      ) {
        fail("windows_harness_evidence_finalize_verification_failed");
      }
      storage.unlinkSync(paths.evidencePendingPath);
      pendingRemoved = true;
      storage.renameSync(paths.evidenceFinalizingPath, paths.evidencePath);
      finalizingCreated = false;
      canonicalPromoted = true;

      const persisted = JSON.parse(storage.readFileSync(paths.evidencePath, "utf8"));
      const persistedHash = persisted.evidenceSha256;
      delete persisted.evidenceSha256;
      if (
        persisted.status !== "complete" ||
        persisted.physicalExecution !== true ||
        persisted.closedReport?.ok !== true ||
        persistedHash !== crypto.createHash("sha256")
          .update(JSON.stringify(persisted))
          .digest("hex") ||
        storage.existsSync(paths.evidencePath) !== true ||
        storage.existsSync(paths.evidencePendingPath) !== false ||
        storage.existsSync(paths.evidenceFinalizingPath) !== false
      ) {
        fail("windows_harness_evidence_finalize_verification_failed");
      }
      state.pendingEvidence = null;
      return {
        code: "windows_evidence_finalized",
        checks: {
          closedReportApproved: true,
          canonicalEvidenceCreated: true,
          pendingEvidenceRemoved: true
        }
      };
    } catch (error) {
      try {
        if (canonicalPromoted && storage.existsSync(paths.evidencePath)) {
          storage.unlinkSync(paths.evidencePath);
        }
        if (finalizingCreated && storage.existsSync(paths.evidenceFinalizingPath)) {
          storage.unlinkSync(paths.evidenceFinalizingPath);
        }
        if (
          pendingRemoved &&
          state.pendingEvidence &&
          storage.existsSync(paths.evidencePendingPath) === false
        ) {
          storage.writeFileSync(
            paths.evidencePendingPath,
            `${JSON.stringify(state.pendingEvidence)}\n`,
            { encoding: "utf8", flag: "wx" }
          );
        }
      } catch {
        // The canonical success path is removed first. Any inability to
        // restore the non-approving marker remains a closed finalization error.
      }
      throw sanitizedFailure(error, "windows_harness_evidence_finalize_failed");
    }
  }

  async function verifyPackageSourcePreserved() {
    if (state.packageDescriptor?.sourceOwnedByRun === true) {
      if (
        state.cleaned !== true ||
        state.workingPackageRemoved !== true ||
        storage.existsSync(paths.ownedRoot) !== false
      ) {
        fail("windows_harness_run_owned_package_removal_unconfirmed");
      }
      return {
        code: "windows_package_source_preserved",
        checks: {
          packageSourceOwnedByRun: true,
          runOwnedPackageRemoved: true,
          externalPackageDeletionAttempted: false
        }
      };
    }
    if (typeof sourcePackageVerifier !== "function") {
      fail("windows_harness_package_source_verifier_missing");
    }
    let result;
    try {
      result = await sourcePackageVerifier();
    } catch {
      fail("windows_harness_external_package_verification_failed");
    }
    if (
      !result ||
      Object.getPrototypeOf(result) !== Object.prototype ||
      result.externalPackagePreserved !== true ||
      result.sourceHashUnchanged !== true
    ) {
      fail("windows_harness_external_package_verification_failed");
    }
    return {
      code: "windows_package_source_preserved",
      checks: {
        packageSourceOwnedByRun: false,
        externalPackagePreserved: true,
        sourceHashUnchanged: true,
        externalPackageDeletionAttempted: false
      }
    };
  }

  consumeOwnedTemporaryRootProof(
    options.ownershipProof,
    ownedRoot,
    ownedParent
  );
  return Object.freeze({
    preflight: withPartialEvidence("preflight", preflight),
    validatePackage: withPartialEvidence("validate-package", validatePackage),
    extractPackage: withPartialEvidence("extract-package", extractPackage),
    initializeCluster: withPartialEvidence(
      "initialize-cluster",
      initializeCluster
    ),
    startCluster: withPartialEvidence("start-cluster", startCluster),
    createReadinessProbes: withPartialEvidence(
      "wait-for-readiness",
      createReadinessProbes
    ),
    bootstrapRoles: withPartialEvidence("bootstrap-roles", bootstrapRoles),
    establishDpapiCustody: withPartialEvidence(
      "establish-dpapi-custody",
      establishCustody
    ),
    runMigrationGate: withPartialEvidence(
      "run-migration-gate",
      runMigrationGate
    ),
    runRlsGate: withPartialEvidence("run-rls-gate", runRlsGate),
    runConcurrencyGate: withPartialEvidence(
      "run-concurrency-gate",
      runConcurrencyGate
    ),
    runVaultGate: withPartialEvidence("run-vault-gate", runVaultGate),
    runBackupRestoreGate: withPartialEvidence(
      "run-backup-restore-gate",
      runBackupRestoreGate
    ),
    collectSanitizedEvidence: withPartialEvidence(
      "collect-sanitized-evidence",
      collectSanitizedEvidence
    ),
    cleanup: withPartialEvidence("cleanup", cleanup),
    finalizeSanitizedEvidence,
    initializeEvidenceLedger,
    transitionEvidenceLedger,
    verifyPackageSourcePreserved,
    terminateProcessTree
  });
}

function pendingPhysicalProofs() {
  return Object.freeze({
    physicalExecutionOccurred: false,
    postgresAccessed: false,
    networkAccessed: false,
    proofs: PHYSICAL_PROOFS
  });
}

function createWindowsHarnessInvocation(options = {}) {
  plainObject(options, "windows_harness_invocation_invalid");
  const adapterOptions = plainObject(
    options.adapterOptions,
    "windows_harness_adapter_options_missing"
  );
  // Validate every non-secret controller field before the one-use ownership
  // proof can be consumed by the concrete adapter factory.
  const {
    REQUIRED_ADAPTERS,
    controllerContract
  } = require("./social-3a0p-local-physical-harness");
  const inertAdapters = Object.fromEntries(
    REQUIRED_ADAPTERS.map((name) => [name, () => {}])
  );
  const metadata = controllerContract({
    approval: options.approval,
    packageDescriptor: options.packageDescriptor,
    target: options.target,
    adapters: inertAdapters,
    ...(options.timeouts ? { timeouts: options.timeouts } : {}),
    ...(options.readinessStepTimeouts
      ? { readinessStepTimeouts: options.readinessStepTimeouts }
      : {})
  });
  return Object.freeze({
    approval: options.approval,
    packageDescriptor: metadata.packageDescriptor,
    target: metadata.target,
    adapters: createWindowsPhysicalAdapters({
      ...adapterOptions,
      target: metadata.target
    }),
    timeouts: metadata.timeouts,
    readinessStepTimeouts: metadata.readinessStepTimeouts,
    ...(typeof options.heartbeat === "function"
      ? { heartbeat: options.heartbeat }
      : {})
  });
}

async function runWindowsPhysicalHarness(options) {
  const invocation = createWindowsHarnessInvocation(options);
  const { runLocalPhysicalHarness } = require("./social-3a0p-local-physical-harness");
  return runLocalPhysicalHarness(invocation);
}

module.exports = {
  ADMIN_LOGIN,
  LOCAL_DATABASE,
  LOOPBACK_HOST,
  MINIMUM_FREE_BYTES,
  MIGRATION_LOGIN,
  PHYSICAL_GATES,
  PHYSICAL_PROOFS,
  POSTGRES_VERSION,
  PROVISIONER_LOGIN,
  REQUIRED_ARCHIVE_FILES,
  RUNTIME_LOGIN,
  WindowsPhysicalAdapterFailure,
  canonicalArchiveEntry,
  createWindowsHarnessInvocation,
  createWindowsPhysicalAdapters,
  netstatListenerParserPowerShell,
  netstatTargetListenersPowerShell,
  postgresServiceClassificationPowerShell,
  pendingPhysicalProofs,
  runWindowsPhysicalHarness,
  validateGateResult
};
