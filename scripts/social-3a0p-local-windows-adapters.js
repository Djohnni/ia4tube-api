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

function archiveListingLines(value, code) {
  if (typeof value !== "string") fail(code);
  const lines = value.split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line.length === 0)) fail(code);
  return lines;
}

function validateArchiveListings(namesOutput, verboseOutput) {
  const entries = archiveListingLines(
    namesOutput,
    "windows_harness_archive_inventory_invalid"
  ).map((entry) => canonicalArchiveEntry(entry));
  const verbose = archiveListingLines(
    verboseOutput,
    "windows_harness_archive_type_inventory_invalid"
  );
  if (entries.length !== verbose.length) {
    fail("windows_harness_archive_type_inventory_invalid");
  }
  for (const line of verbose) {
    // bsdtar emits a POSIX mode field first. Only regular files and
    // directories are accepted; links and every special-file type are
    // rejected before extraction can write anything to disk.
    if (!/^[d-][rwxstST-]{9}(?:[+@.]?)[ \t]/.test(line)) {
      fail("windows_harness_archive_entry_type_refused");
    }
  }
  return entries;
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
  if (/^[a-z][a-z0-9_]{2,95}$/.test(code)) {
    return new WindowsPhysicalAdapterFailure(code);
  }
  return new WindowsPhysicalAdapterFailure(fallback);
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

function defaultArchive({ processRunner, executables, environment, paths }) {
  async function inspect(archivePath) {
    const names = await processRunner.run({
      executable: executables.tar,
      args: ["-tf", archivePath],
      cwd: paths.ownedRoot,
      environment,
      timeoutMs: 120_000,
      label: "archive_list"
    });
    const types = await processRunner.run({
      executable: executables.tar,
      args: ["-tvf", archivePath],
      cwd: paths.ownedRoot,
      environment,
      timeoutMs: 120_000,
      label: "archive_list_types"
    });
    return validateArchiveListings(names.stdoutSanitized, types.stdoutSanitized);
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

function defaultSystemProbe({ processRunner, executables, environment, paths }) {
  async function powershell(script, label) {
    const result = await processRunner.run({
      executable: executables.powershell,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      cwd: paths.ownedRoot,
      environment,
      timeoutMs: 15_000,
      label
    });
    return parseJsonLine(result.stdoutSanitized, `${label}_output_invalid`);
  }
  return Object.freeze({
    async assertClean(target) {
      const result = await powershell(
        [
          "$p=@(Get-Process postgres -ErrorAction SilentlyContinue).Count;",
          "$s=@(Get-Service *postgres* -ErrorAction SilentlyContinue | Where-Object Status -ne 'Stopped').Count;",
          `$l=@(Get-NetTCPConnection -State Listen -LocalPort ${target.port} -ErrorAction SilentlyContinue).Count;`,
          "@{processes=$p;services=$s;listeners=$l}|ConvertTo-Json -Compress"
        ].join(""),
        "postgres_preflight"
      );
      return result.processes === 0 && result.services === 0 && result.listeners === 0;
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
      const result = await powershell(
        [
          `$r=@(Get-NetTCPConnection -State Listen -OwningProcess ${Number(pid)} -ErrorAction SilentlyContinue|`,
          "ForEach-Object{@{address=$_.LocalAddress;port=$_.LocalPort;pid=$_.OwningProcess}});",
          "@{rows=$r}|ConvertTo-Json -Compress -Depth 3"
        ].join(""),
        "postgres_listener_probe"
      );
      return (Array.isArray(result.rows) ? result.rows : result.rows ? [result.rows] : [])
        .map((row) => ({ address: row.address, port: Number(row.port), pid: Number(row.pid) }));
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

function createDefaultRoleBootstrap({ state, storage, PoolClass, product }) {
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
      state.pools.runtime = new PoolClass(poolOptions(state, RUNTIME_LOGIN, state.materials.runtime, 3, "ia4tube-social-local-runtime"));
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
    evidencePath: path.join(ownedParent, `${path.basename(ownedRoot)}-evidence.json`),
    evidencePendingPath: path.join(ownedParent, `${path.basename(ownedRoot)}-evidence.json.pending`),
    evidenceFinalizingPath: path.join(ownedParent, `${path.basename(ownedRoot)}-evidence.json.finalizing`)
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
  const childProcessJournal = Object.freeze({
    registerProcess(pid) {
      if (!Number.isSafeInteger(pid) || pid < 1 || activeChildPids.has(pid)) {
        fail("windows_harness_child_pid_invalid");
      }
      activeChildPids.add(pid);
    },
    unregisterProcess(pid) {
      activeChildPids.delete(pid);
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
  const archive = options.dependencies?.archive || defaultArchive({ processRunner, executables, environment: systemEnvironment, paths });
  const systemProbe = options.dependencies?.systemProbe || defaultSystemProbe({ processRunner, executables, environment: systemEnvironment, paths });
  const PoolClass = options.dependencies?.PoolClass || require("pg").Pool;
  const product = productDependencies(options.dependencies?.product || {});
  const randomBytes = options.dependencies?.randomBytes || crypto.randomBytes;
  const randomUUID = options.dependencies?.randomUUID || crypto.randomUUID;
  const state = {
    repositoryRoot,
    target: null,
    packageDescriptor: null,
    archiveEntries: [],
    pid: null,
    postmasterIdentity: null,
    initialized: false,
    started: false,
    startAmbiguous: false,
    materials: Object.create(null),
    pools: Object.create(null),
    phaseResults: Object.create(null),
    pendingEvidence: null,
    environmentId: randomUUID(),
    cleaned: false
  };
  const runMarker = typeof options.runMarker === "string"
    ? options.runMarker
    : `ia4tube-social-3a0p-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const physicalPlans = options.physicalPlans ||
    (options.dependencies?.physicalGates || options.dependencies?.connectorGateFactory
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
  const connectorGateFactory = options.dependencies?.connectorGateFactory ||
    ((settings) => require("./social-3a0p-local-connector-physical-gates")
      .createConnectorPhysicalGates(settings));
  const physicalGates = plainObject(
    options.dependencies?.physicalGates || connectorGateFactory({
      dependencies: options.dependencies?.connectorGateDependencies,
      plans: physicalPlans,
      randomBytes,
      randomUUID
    }),
    "windows_harness_physical_gates_missing"
  );
  for (const gate of PHYSICAL_GATES) {
    if (typeof physicalGates[gate] !== "function") fail("windows_harness_physical_gate_missing");
  }
  const dpapiScript = path.join(repositoryRoot, "scripts", "social-3a0p-local-dpapi.ps1");
  // The default role bootstrap needs the stable state object after creation.
  const effectiveRoleBootstrap = options.dependencies?.roleBootstrap || createDefaultRoleBootstrap({ state, storage, PoolClass, product });

  function remember(phase, result) {
    state.phaseResults[phase] = result;
    return result;
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
        if (gone && (await systemProbe.assertClean(state.target)) === true) {
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
        if ((await systemProbe.assertClean(state.target)) === true) {
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
    if (typeof physicalGates.assertConfigured === "function") physicalGates.assertConfigured();
    const archivePath = requireWithin(input.packageDescriptor.archivePath, ownedRoot, "windows_harness_archive_outside_root");
    const root = await storage.lstat(ownedRoot);
    const archiveStat = await storage.stat(archivePath);
    assertActive(input);
    if (!root.isDirectory() || root.isSymbolicLink() || !archiveStat.isFile()) {
      fail("windows_harness_preflight_filesystem_invalid");
    }
    const initialEntries = await storage.readdir(ownedRoot);
    if (initialEntries.some((name) => /\.(?:part|partial|tmp|crdownload)$/i.test(name))) {
      fail("windows_harness_partial_download_detected");
    }
    if ((await systemProbe.assertClean(state.target)) !== true) {
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
      typeof storage.writeFileSync !== "function"
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
    return remember("preflight", {
      code: "windows_preflight_passed",
      checks: { ownedRootValidated: true, postgresAbsent: true, portAvailable: true }
    });
  }

  async function validatePackage(input) {
    bind(input);
    if (input.packageDescriptor.version !== POSTGRES_VERSION) {
      fail("windows_harness_postgres_version_mismatch");
    }
    const actual = await storage.hashFile(input.packageDescriptor.archivePath);
    assertActive(input);
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
      counts: { archiveEntries: entries.length },
      hashes: { archiveSha256: actual },
      checks: { postgresVersionDeclared: input.packageDescriptor.version === POSTGRES_VERSION }
    });
  }

  async function extractPackage(input) {
    bind(input);
    await storage.mkdir(paths.binaryRoot, { recursive: false });
    assertActive(input);
    const actual = await storage.hashFile(input.packageDescriptor.archivePath);
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
    return remember("extract-package", {
      code: "windows_package_extracted",
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
        args: ["--pgdata", paths.clusterRoot, "--username", ADMIN_LOGIN, "--auth-host", "scram-sha-256", "--auth-local", "scram-sha-256", "--pwfile=-", "--encoding=UTF8", "--locale=C"],
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
      checks: { loopbackOnly: true, scramConfigured: true, durableWritesConfigured: true }
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
      counts: { serverProcesses: 1 },
      checks: { postmasterPidRecorded: true }
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
          return systemProbe.listeners(pid, state.target);
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
    return remember("bootstrap-roles", {
      code: "windows_roles_bootstrapped",
      counts: { rolesCreated: Number(result.createdCount || 0), roleKinds: 3 },
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
    if (!SHA256.test(String(result.bundleSha256 || "")) || !Number.isSafeInteger(result.bundleSize) || result.bundleSize < 1) {
      fail("windows_harness_backup_restore_proof_invalid");
    }
    return remember("run-backup-restore-gate", {
      code: "windows_backup_restore_gate_passed",
      counts: { schemaProfiles: 2, bundleBytes: result.bundleSize },
      hashes: { bundleSha256: result.bundleSha256 },
      checks: { profile0003: true, profile0004: true, restoreIsolated: true, manifestTamperRefused: true, crossProfileRefused: true, operationalRollback: true, fileFsync: true },
      pendencies: ["directory-fsync-linux", "nofollow-linux"]
    });
  }

  async function collectSanitizedEvidence(input) {
    bind(input);
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
      counts: { completedPhases: evidence.phaseCount },
      hashes: { evidenceSha256 },
      inventory: ["physical-gates", "owned-resources", "linux-pendencies"],
      checks: { syntheticOnly: true, sensitiveDataAbsent: true }
    });
  }

  async function terminateProcessTree() {
    const terminate = options.dependencies?.terminateProcessTree ||
      ((pid) => terminateWindowsProcessTree(pid, {
        taskkillPath: executables.taskkill
      }));
    const targets = new Set(activeChildPids);
    if (state.pid) targets.add(state.pid);
    let allConfirmed = true;
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
      }
      const terminated = await Promise.resolve()
        .then(() => terminate(pid))
        .catch(() => false);
      if (terminated === true) {
        activeChildPids.delete(pid);
        if (state.pid === pid) {
          const remaining = await systemProbe.processIdentity(pid).catch(() => ({ reused: true }));
          if (remaining !== null) {
            allConfirmed = false;
          } else {
            state.pid = null;
            state.postmasterIdentity = null;
          }
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
      !state.startAmbiguous && activeChildPids.size === 0;
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
        processConfirmedStopped = (await systemProbe.assertClean(state.target)) === true &&
          activeChildPids.size === 0;
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
    if (activeChildPids.size > 0) {
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
    let ownedRootRemoved = false;
    if (processConfirmedStopped) {
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
    const cleanupResult = {
      code: "windows_cleanup_passed",
      counts: { poolsClosed, processTreesTerminated: state.started ? 1 : 0 },
      checks: {
        ownedRootRemoved,
        sanitizedEvidencePrepared: false,
        materialsZeroed: true,
        externalSystemsUntouched: true
      }
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
    if (cleanupFailure) throw cleanupFailure;
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

  consumeOwnedTemporaryRootProof(
    options.ownershipProof,
    ownedRoot,
    ownedParent
  );
  return Object.freeze({
    preflight,
    validatePackage,
    extractPackage,
    initializeCluster,
    startCluster,
    createReadinessProbes,
    bootstrapRoles,
    establishDpapiCustody: establishCustody,
    runMigrationGate,
    runRlsGate,
    runConcurrencyGate,
    runVaultGate,
    runBackupRestoreGate,
    collectSanitizedEvidence,
    cleanup,
    finalizeSanitizedEvidence,
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
  pendingPhysicalProofs,
  runWindowsPhysicalHarness,
  validateArchiveListings,
  validateGateResult
};
