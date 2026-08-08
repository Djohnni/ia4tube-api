"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const IMAGE = "docker.io/library/postgres:18.4-bookworm@sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568";
const IMAGE_DIGEST = "sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568";
const LOOPBACK = "127.0.0.1";
const INTERNAL_PORT = 5432;
const ADMIN_LOGIN = "ia4tube_social_local_admin";
const PROVISIONER_LOGIN = "ia4tube_social_local_provisioner";
const MIGRATION_LOGIN = "ia4tube_social_local_migration";
const RUNTIME_LOGIN = "ia4tube_social_local_runtime";
const DATABASE = "ia4tube_social_local";
const OWNER_ROLE = "ia4tube_social_owner";
const MIGRATOR_ROLE = "ia4tube_social_migrator";
const RUNTIME_ROLE = "ia4tube_social_runtime";
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SAFE_DATABASE = /^[a-z][a-z0-9_]{2,62}$/;
const SAFE_LOGIN = new Set([MIGRATION_LOGIN, PROVISIONER_LOGIN]);

class LinuxPostgresFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "LinuxPostgresFailure";
    this.code = code;
  }
}

function fail(code) {
  throw new LinuxPostgresFailure(code);
}

function assertExactLoopbackListener(rows, port) {
  if (
    !Array.isArray(rows) || rows.length !== 1 ||
    (String(rows[0]).trim().split(/\s+/)[3] || "") !== `${LOOPBACK}:${port}`
  ) {
    fail("linux_postgres_listener_exposure_invalid");
  }
  return true;
}

function assertAbsoluteWithin(candidate, root, code) {
  if (typeof candidate !== "string" || typeof root !== "string") fail(code);
  const absolute = path.resolve(candidate);
  const base = path.resolve(root);
  const relative = path.relative(base, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(code);
  }
  return absolute;
}

function safeRunId(value) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 48);
  if (!SAFE_RUN_ID.test(normalized)) fail("linux_postgres_run_id_invalid");
  return normalized;
}

function secretText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 43) fail("linux_postgres_material_invalid");
  const value = buffer.toString("utf8");
  if (!/^[A-Za-z0-9_-]{43,96}$/.test(value)) fail("linux_postgres_material_invalid");
  return value;
}

function generatedSecret(randomBytes = crypto.randomBytes) {
  return Buffer.from(`aA0_${randomBytes(48).toString("base64url")}`, "utf8");
}

function commandRunner({ spawnImpl = spawn, baseEnvironment = process.env } = {}) {
  return function run(executable, args, options = {}) {
    if (typeof executable !== "string" || !Array.isArray(args) || args.some((item) => typeof item !== "string")) {
      fail("linux_command_invalid");
    }
    const timeoutMs = Number(options.timeoutMs || 120_000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20 * 60_000) {
      fail("linux_command_timeout_invalid");
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let child;
      try {
        child = spawnImpl(executable, args, {
          cwd: options.cwd,
          env: { ...baseEnvironment, ...(options.environment || {}) },
          shell: false,
          windowsHide: true,
          stdio: [options.input == null ? "ignore" : "pipe", "pipe", "pipe"]
        });
      } catch {
        reject(new LinuxPostgresFailure(options.failureCode || "linux_command_spawn_failed"));
        return;
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        if (!settled) {
          timedOut = true;
          child.kill("SIGKILL");
        }
      }, timeoutMs);
      timer.unref?.();
      const append = (current, chunk) => {
        if (current.length >= 16 * 1024 * 1024) return current;
        return Buffer.concat([current, Buffer.from(chunk)]).subarray(0, 16 * 1024 * 1024);
      };
      child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
      child.once("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new LinuxPostgresFailure(options.failureCode || "linux_command_spawn_failed"));
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const result = Object.freeze({
          code: Number.isInteger(code) ? code : -1,
          signal: signal || null,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8")
        });
        stdout.fill(0);
        stderr.fill(0);
        if (timedOut) {
          reject(new LinuxPostgresFailure(`${options.failureCode || "linux_command"}_timeout`));
        } else if ((result.code !== 0 || result.signal !== null) && options.allowFailure !== true) {
          reject(new LinuxPostgresFailure(options.failureCode || "linux_command_failed"));
        } else {
          resolve(result);
        }
      });
      if (options.input != null) {
        const input = Buffer.isBuffer(options.input) ? options.input : Buffer.from(String(options.input), "utf8");
        child.stdin.end(input);
      }
    });
  };
}

function quoteIdentifier(value) {
  if (!SAFE_DATABASE.test(value)) fail("linux_postgres_identifier_invalid");
  return `"${value}"`;
}

function poolOptions({ port, database, login, password, max, applicationName }) {
  return {
    host: LOOPBACK,
    port,
    database,
    user: login,
    password,
    ssl: false,
    max,
    min: 0,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000,
    query_timeout: 20_000,
    application_name: applicationName,
    options: "-c statement_timeout=15000 -c lock_timeout=7000 -c idle_in_transaction_session_timeout=7000",
    allowExitOnIdle: false
  };
}

function instrumentedPoolClass(Pool, metricsRegistry) {
  if (typeof Pool !== "function" || !metricsRegistry) fail("linux_pool_instrumentation_invalid");
  return class LinuxInstrumentedPool extends Pool {
    constructor(configuration = {}) {
      super(configuration);
      const applicationName = String(configuration.application_name || "");
      const category = applicationName.includes("runtime")
        ? "runtime"
        : applicationName.includes("migration")
          ? "migration"
          : applicationName.includes("provisioner")
            ? "provisioning"
            : "administration";
      metricsRegistry.register(this, { category, configuredMax: Number(configuration.max) });
      const observe = () => metricsRegistry.observe(this, this);
      this.on("connect", observe);
      this.on("acquire", () => metricsRegistry.recordAcquisition(this, this));
      this.on("remove", observe);
      observe();
    }
  };
}

function dockerNames(runId) {
  const suffix = crypto.createHash("sha256").update(runId).digest("hex").slice(0, 12);
  return Object.freeze({
    container: `ia4tube-social-3a0p-pg-${suffix}`,
    network: `ia4tube-social-3a0p-net-${suffix}`,
    volume: `ia4tube-social-3a0p-data-${suffix}`,
    label: `ia4tube.social3a0p.run=${suffix}`,
    suffix
  });
}

function createLinuxPostgres(options = {}) {
  const runnerTemp = path.resolve(String(options.runnerTemp || ""));
  const runId = safeRunId(options.runId);
  const names = dockerNames(runId);
  const runRoot = assertAbsoluteWithin(path.join(runnerTemp, `ia4tube-social-3a0p-linux-${names.suffix}`), runnerTemp, "linux_postgres_root_invalid");
  const dataDirectory = path.join(runRoot, "pgdata");
  const workDirectory = path.join(runRoot, "work");
  const passwordFile = path.join(runRoot, "admin-password");
  const run = options.runCommand || commandRunner(options);
  const PoolClass = options.PoolClass;
  const metricsRegistry = options.metricsRegistry;
  const runnerUid = options.runnerUid ?? process.getuid?.();
  const runnerGid = options.runnerGid ?? process.getgid?.();
  if (
    typeof PoolClass !== "function" || !metricsRegistry ||
    !Number.isSafeInteger(runnerUid) || runnerUid < 1 ||
    !Number.isSafeInteger(runnerGid) || runnerGid < 0
  ) fail("linux_postgres_dependencies_invalid");
  const trackedPools = new Set();
  const MetricsPool = instrumentedPoolClass(PoolClass, metricsRegistry);
  class InstrumentedPool extends MetricsPool {
    constructor(configuration = {}) {
      super(configuration);
      trackedPools.add(this);
      this.linuxMetricsRegistered = true;
    }

    async end(...args) {
      try {
        return await super.end(...args);
      } finally {
        if (this.linuxMetricsRegistered) {
          try { metricsRegistry.observe(this, this); } catch {}
          metricsRegistry.unregister(this);
          this.linuxMetricsRegistered = false;
        }
        trackedPools.delete(this);
      }
    }
  }
  const materials = Object.freeze({
    admin: generatedSecret(options.randomBytes),
    provisioner: generatedSecret(options.randomBytes),
    migration: generatedSecret(options.randomBytes),
    runtime: generatedSecret(options.randomBytes),
    vault: options.randomBytes ? options.randomBytes(32) : crypto.randomBytes(32)
  });
  let port = 0;
  let started = false;

  function makePool(database, login, material, max, applicationName) {
    const pool = new InstrumentedPool(poolOptions({
      port,
      database,
      login,
      password: secretText(material),
      max,
      applicationName
    }));
    return pool;
  }

  async function docker(args, extra = {}) {
    return run("docker", args, {
      timeoutMs: extra.timeoutMs || 120_000,
      allowFailure: extra.allowFailure,
      environment: extra.environment,
      input: extra.input,
      cwd: runnerTemp,
      failureCode: extra.failureCode || "linux_docker_command_failed"
    });
  }

  async function hostListeners(targetPort) {
    const result = await run("ss", ["-H", "-ltn"], {
      timeoutMs: 15_000,
      cwd: runnerTemp,
      failureCode: "linux_listener_probe_failed"
    });
    const rows = result.stdout.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
    return rows.filter((row) => Number((row.split(/\s+/)[3] || "").match(/:(\d+)$/)?.[1]) === targetPort);
  }

  async function waitReady() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const probe = await docker([
        "exec", names.container, "pg_isready", "--host", LOOPBACK,
        "--port", String(INTERNAL_PORT), "--username", ADMIN_LOGIN, "--dbname", "postgres"
      ], { allowFailure: true, timeoutMs: 10_000 });
      if (probe.code === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    fail("linux_postgres_readiness_failed");
  }

  async function verifyImage() {
    const result = await docker(["image", "inspect", IMAGE, "--format", "{{json .}}"], {
      failureCode: "linux_postgres_image_inspect_failed"
    });
    let value;
    try { value = JSON.parse(result.stdout.trim()); } catch { fail("linux_postgres_image_metadata_invalid"); }
    if (
      value?.Os !== "linux" || value?.Architecture !== "amd64" ||
      !Array.isArray(value?.RepoDigests) ||
      !value.RepoDigests.some((item) => String(item).endsWith(`@${IMAGE_DIGEST}`))
    ) {
      fail("linux_postgres_image_identity_mismatch");
    }
    return true;
  }

  async function start() {
    if (started || fs.existsSync(runRoot)) fail("linux_postgres_root_collision");
    fs.mkdirSync(runRoot, { recursive: false, mode: 0o700 });
    fs.mkdirSync(dataDirectory, { recursive: false, mode: 0o700 });
    fs.mkdirSync(workDirectory, { recursive: false, mode: 0o700 });
    fs.writeFileSync(passwordFile, `${secretText(materials.admin)}\n`, { flag: "wx", mode: 0o600 });
    fs.chmodSync(passwordFile, 0o600);
    await docker(["pull", "--platform", "linux/amd64", IMAGE], {
      timeoutMs: 10 * 60_000,
      failureCode: "linux_postgres_image_pull_failed"
    });
    await verifyImage();
    await docker(["network", "create", "--internal", "--label", names.label, names.network], {
      failureCode: "linux_postgres_network_create_failed"
    });
    await docker([
      "volume", "create", "--driver", "local", "--label", names.label,
      "--opt", "type=none", "--opt", "o=bind", "--opt", `device=${dataDirectory}`,
      names.volume
    ], { failureCode: "linux_postgres_volume_create_failed" });
    await docker([
      "run", "--detach", "--name", names.container, "--hostname", names.container,
      "--label", names.label, "--network", names.network, "--log-driver", "none",
      "--publish", `${LOOPBACK}::${INTERNAL_PORT}`,
      "--mount", `type=volume,src=${names.volume},dst=/var/lib/postgresql`,
      "--mount", `type=bind,src=${runRoot},dst=${runRoot}`,
      "--mount", `type=bind,src=${passwordFile},dst=/run/secrets/postgres-password,readonly`,
      "--env", "POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password",
      "--env", `POSTGRES_USER=${ADMIN_LOGIN}`, "--env", "POSTGRES_DB=postgres",
      "--env", "PGDATA=/var/lib/postgresql/18/docker", "--env", "LANG=C",
      "--env", "LC_ALL=C", "--env", "POSTGRES_INITDB_ARGS=--data-checksums --encoding=UTF8 --locale=C --auth-host=scram-sha-256 --auth-local=scram-sha-256",
      IMAGE, "postgres", "-c", "listen_addresses=*", "-c", "password_encryption=scram-sha-256"
    ], { timeoutMs: 120_000, failureCode: "linux_postgres_container_start_failed" });
    started = true;
    await waitReady();
    const mapping = await docker(["port", names.container, `${INTERNAL_PORT}/tcp`], {
      failureCode: "linux_postgres_port_inspect_failed"
    });
    const match = mapping.stdout.trim().match(/^127\.0\.0\.1:(\d+)$/);
    port = Number(match?.[1]);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) fail("linux_postgres_port_invalid");
    const bindingResult = await docker([
      "inspect", names.container, "--format", "{{json .HostConfig.PortBindings}}"
    ], { failureCode: "linux_postgres_port_binding_inspect_failed" });
    let bindings;
    try { bindings = JSON.parse(bindingResult.stdout.trim()); } catch { fail("linux_postgres_port_binding_invalid"); }
    const expectedBindings = bindings?.[`${INTERNAL_PORT}/tcp`];
    if (
      !Array.isArray(expectedBindings) || expectedBindings.length !== 1 ||
      expectedBindings[0]?.HostIp !== LOOPBACK || Number(expectedBindings[0]?.HostPort) !== port
    ) fail("linux_postgres_port_binding_invalid");
    const listeners = await hostListeners(port);
    assertExactLoopbackListener(listeners, port);
    const admin = makePool("postgres", ADMIN_LOGIN, materials.admin, 1, "ia4tube-social-3a0p-administration");
    try {
      const result = await admin.query([
        "SELECT current_setting('server_version_num') AS version_num,",
        " current_setting('server_encoding') AS encoding,",
        " current_setting('data_checksums') AS checksums,",
        " current_setting('password_encryption') AS password_encryption,",
        " (SELECT datcollate FROM pg_catalog.pg_database WHERE datname=current_database()) AS datcollate,",
        " (SELECT datctype FROM pg_catalog.pg_database WHERE datname=current_database()) AS datctype,",
        " (SELECT COALESCE(bool_and(auth_method='scram-sha-256'),false) FROM pg_catalog.pg_hba_file_rules WHERE error IS NULL AND type IN('local','host','hostssl','hostnossl')) AS hba_scram,",
        " (SELECT rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_catalog.pg_authid WHERE rolname=current_user) AS admin_password_scram,",
        " 1::integer AS selected"
      ].join("\n"));
      const row = result.rows?.[0];
      if (
        row?.version_num !== "180004" || row?.encoding !== "UTF8" ||
        row?.checksums !== "on" || row?.password_encryption !== "scram-sha-256" ||
        row?.datcollate !== "C" || row?.datctype !== "C" ||
        row?.hba_scram !== true || row?.admin_password_scram !== true ||
        Number(row?.selected) !== 1
      ) {
        fail("linux_postgres_runtime_identity_invalid");
      }
    } finally {
      await admin.end();
      trackedPools.delete(admin);
    }
    return Object.freeze({
      image: IMAGE,
      imageDigest: IMAGE_DIGEST,
      architecture: "linux/amd64",
      version: "18.4",
      dataChecksums: true,
      encoding: "UTF8",
      locale: "C",
      scramSha256: true,
      hostAuthenticationScramSha256: true,
      hostListener: "loopback_ipv4_only",
      externalIpv4Listeners: 0,
      externalIpv6Listeners: 0,
      port
    });
  }

  async function bootstrap(repositoryRoot, environmentId) {
    if (!started || !port) fail("linux_postgres_not_started");
    const loginBootstrap = require("../src/persistence/postgres/login-bootstrap");
    const rolesSql = fs.readFileSync(path.join(repositoryRoot, "db", "postgres", "roles.sql"), "utf8");
    const admin = makePool("postgres", ADMIN_LOGIN, materials.admin, 1, "ia4tube-social-3a0p-administration");
    let provisioner;
    try {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL password_encryption='scram-sha-256'");
        await client.query("SELECT set_config('ia4tube.provisioner_login',$1,true),set_config('ia4tube.provisioner_password',$2,true)", [PROVISIONER_LOGIN, secretText(materials.provisioner)]);
        await client.query([
          "DO $bootstrap$ DECLARE l text:=current_setting('ia4tube.provisioner_login'); p text:=current_setting('ia4tube.provisioner_password');",
          "BEGIN EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',l,p); END $bootstrap$;"
        ].join("\n"));
        await client.query("COMMIT");
        await client.query(`CREATE DATABASE ${quoteIdentifier(DATABASE)} OWNER ${quoteIdentifier(PROVISIONER_LOGIN)}`);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      provisioner = makePool(DATABASE, PROVISIONER_LOGIN, materials.provisioner, 1, "ia4tube-social-3a0p-provisioner");
      const owner = await provisioner.connect();
      try {
        await owner.query(rolesSql);
        await owner.query("BEGIN");
        await owner.query("GRANT ia4tube_social_owner TO CURRENT_USER WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY CURRENT_USER");
        await owner.query("SET LOCAL ROLE ia4tube_social_owner");
        await owner.query("INSERT INTO ia4tube_migrations.environment_identity(singleton,environment_id,environment_name) VALUES(TRUE,$1,'local')", [environmentId]);
        await owner.query("RESET ROLE");
        await owner.query("REVOKE ia4tube_social_owner FROM CURRENT_USER GRANTED BY CURRENT_USER RESTRICT");
        await owner.query("COMMIT");
      } catch (error) {
        await owner.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        owner.release();
      }
      const target = {
        host: LOOPBACK, port: String(port), database: DATABASE,
        provisionerLogin: PROVISIONER_LOGIN, migrationLogin: MIGRATION_LOGIN, runtimeLogin: RUNTIME_LOGIN
      };
      const connectionString = new URL(`postgresql://${LOOPBACK}:${port}/${DATABASE}`);
      connectionString.username = PROVISIONER_LOGIN;
      connectionString.password = secretText(materials.provisioner);
      const configuration = {
        target,
        targetFingerprint: loginBootstrap.targetFingerprint(target),
        provisionerPool: { ...poolOptions({ port, database: DATABASE, login: PROVISIONER_LOGIN, password: secretText(materials.provisioner), max: 1, applicationName: "ia4tube-social-3a0p-provisioner" }), connectionString: connectionString.toString() },
        migration: { login: MIGRATION_LOGIN, role: MIGRATOR_ROLE, connectionLimit: loginBootstrap.MIGRATION_CONNECTION_LIMIT },
        runtime: { login: RUNTIME_LOGIN, role: RUNTIME_ROLE, connectionLimit: loginBootstrap.RUNTIME_CONNECTION_LIMIT }
      };
      Object.defineProperty(configuration.migration, "password", { value: secretText(materials.migration), enumerable: false });
      Object.defineProperty(configuration.runtime, "password", { value: secretText(materials.runtime), enumerable: false });
      const first = await loginBootstrap.bootstrapDatabaseLogins(provisioner, configuration);
      const second = await loginBootstrap.bootstrapDatabaseLogins(provisioner, configuration);
      const verified = await loginBootstrap.verifyProvisionedLoginCredentials(InstrumentedPool, configuration);
      if (first.safe !== true || second.safe !== true || second.created?.migration !== false || second.created?.runtime !== false || verified.verified !== 2) {
        fail("linux_postgres_role_bootstrap_invalid");
      }
      const migration = makePool(DATABASE, MIGRATION_LOGIN, materials.migration, 2, "ia4tube-social-3a0p-migration");
      const runtime = makePool(DATABASE, RUNTIME_LOGIN, materials.runtime, 3, "ia4tube-social-3a0p-runtime");
      const runtimePoolConfiguredMax = Number(runtime.options?.max);
      if (runtimePoolConfiguredMax !== 3) fail("linux_postgres_runtime_pool_max_invalid");
      return Object.freeze({
        pools: Object.freeze({ migration, runtime }),
        roles: Object.freeze({
          admin: ADMIN_LOGIN, provisioner: PROVISIONER_LOGIN, migrationLogin: MIGRATION_LOGIN,
          runtimeLogin: RUNTIME_LOGIN, ownerRole: OWNER_ROLE, migratorRole: MIGRATOR_ROLE, runtimeRole: RUNTIME_ROLE
        }),
        checks: Object.freeze({
          roleBootstrapIdempotent: true,
          runtimePoolMax3: runtimePoolConfiguredMax === 3,
          runtimePoolConfiguredMax,
          syntheticCredentialsOnly: true
        })
      });
    } finally {
      if (provisioner) { await provisioner.end(); trackedPools.delete(provisioner); }
      await admin.end();
      trackedPools.delete(admin);
    }
  }

  function createRunTool() {
    return async (plan) => {
      const executable = path.posix.basename(String(plan?.executable || ""));
      if (!new Set(["psql", "pg_dump", "pg_restore"]).has(executable) || !Array.isArray(plan.args)) {
        fail("linux_postgres_tool_plan_refused");
      }
      const environment = plan.env || {};
      const offline = executable === "pg_restore" && plan.args[0] === "--list";
      const dockerArgs = ["exec", "--interactive", "--user", `${runnerUid}:${runnerGid}`];
      const childEnvironment = {};
      if (!offline) {
        if (
          environment.PGHOST !== LOOPBACK || Number(environment.PGPORT) !== port ||
          !SAFE_DATABASE.test(environment.PGDATABASE) || !SAFE_LOGIN.has(environment.PGUSER) ||
          typeof environment.PGPASSWORD !== "string" || environment.PGPASSWORD.length < 43
        ) fail("linux_postgres_tool_transport_refused");
        Object.assign(childEnvironment, {
          PGPASSWORD: environment.PGPASSWORD,
          PGHOST: LOOPBACK,
          PGPORT: String(INTERNAL_PORT),
          PGDATABASE: environment.PGDATABASE,
          PGUSER: environment.PGUSER,
          PGSSLMODE: "disable",
          PGAPPNAME: "ia4tube-social-backup-restore"
        });
        for (const name of Object.keys(childEnvironment)) dockerArgs.push("--env", name);
      }
      dockerArgs.push(names.container, executable, ...plan.args);
      const result = await docker(dockerArgs, {
        allowFailure: true,
        timeoutMs: 10 * 60_000,
        environment: childEnvironment,
        input: plan.input,
        failureCode: "linux_postgres_tool_execution_failed"
      });
      childEnvironment.PGPASSWORD = "";
      return Object.freeze({ code: result.code, stdout: result.stdout, stderr: result.stderr });
    };
  }

  async function sessionRows(adminPool) {
    const result = await adminPool.query([
      "SELECT pid,usename AS role,state,application_name",
      "FROM pg_catalog.pg_stat_activity",
      "WHERE pid<>pg_backend_pid() AND datname=$1 AND backend_type='client backend'",
      "ORDER BY pid"
    ].join("\n"), [DATABASE]);
    return result.rows.map((row) => Object.freeze({
      pid: Number(row.pid), role: row.role, state: row.state, applicationName: row.application_name
    }));
  }

  async function orphanSessionCount(adminPool) {
    const result = await adminPool.query(
      "SELECT COUNT(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=$1 AND backend_type='client backend'",
      [DATABASE]
    );
    const count = Number(result.rows?.[0]?.n);
    if (!Number.isSafeInteger(count) || count < 0) fail("linux_postgres_session_count_invalid");
    return count;
  }

  async function scanDataDirectoryMarkers(markers) {
    if (!Array.isArray(markers) || markers.length < 1 || markers.some((marker) => (
      typeof marker !== "string" || marker.length < 16 || /[\0\r\n]/.test(marker)
    ))) fail("linux_postgres_marker_scan_input_invalid");
    const input = Buffer.from(`${markers.join("\n")}\n`, "utf8");
    try {
      const result = await docker([
        "exec", "--interactive", "--user", "0:0", names.container,
        "grep", "-rFqa", "--devices=skip", "-f", "-", "--", "/var/lib/postgresql/18/docker"
      ], {
        allowFailure: true,
        input,
        timeoutMs: 120_000,
        failureCode: "linux_postgres_data_marker_scan_failed"
      });
      if (result.stdout !== "" || result.stderr !== "" || !new Set([0, 1]).has(result.code) || result.signal !== null) {
        fail("linux_postgres_data_marker_scan_failed");
      }
      return Object.freeze({ markersPresent: result.code === 0, scanCompleted: true });
    } finally {
      input.fill(0);
    }
  }

  async function cleanup() {
    for (const pool of [...trackedPools]) {
      try { await pool.end(); } catch {}
      trackedPools.delete(pool);
    }
    let commandFailures = 0;
    const invoke = async (args, extra = {}) => {
      try {
        const result = await docker(args, { ...extra, allowFailure: true });
        if (result.code !== 0 || result.signal !== null) commandFailures += 1;
        return result;
      } catch {
        commandFailures += 1;
        return null;
      }
    };
    const lines = (result) => result?.code === 0 && result.signal === null
      ? result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
      : [];
    const containerBefore = await invoke([
      "ps", "--all", "--quiet", "--filter", `label=${names.label}`, "--filter", `name=^/${names.container}$`
    ]);
    const volumeBefore = await invoke(["volume", "ls", "--quiet", "--filter", `label=${names.label}`]);
    const networkBefore = await invoke([
      "network", "ls", "--quiet", "--filter", `label=${names.label}`, "--filter", `name=^${names.network}$`
    ]);
    const ownedContainersBefore = lines(containerBefore);
    const ownedVolumesBefore = volumeBefore?.code === 0
      ? volumeBefore.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
      : [];
    const ownedNetworksBefore = lines(networkBefore);
    if (
      ownedContainersBefore.length > 1 ||
      ownedVolumesBefore.some((item) => item !== names.volume) ||
      ownedNetworksBefore.length > 1
    ) commandFailures += 1;
    if (ownedContainersBefore.length === 1) {
      await invoke(["rm", "--force", "--volumes", names.container], { timeoutMs: 60_000 });
    }
    if (ownedVolumesBefore.includes(names.volume)) {
      await invoke([
        "run", "--rm", "--network", "none", "--log-driver", "none",
        "--label", names.label, "--user", "0:0",
        "--mount", `type=volume,src=${names.volume},dst=/owned`,
        IMAGE, "chown", "-R", `${runnerUid}:${runnerGid}`, "/owned"
      ], { timeoutMs: 120_000 });
      await invoke(["volume", "rm", "--force", names.volume], { timeoutMs: 60_000 });
    }
    if (ownedNetworksBefore.length === 1) {
      await invoke(["network", "rm", names.network], { timeoutMs: 60_000 });
    }
    started = false;
    try {
      if (fs.existsSync(runRoot)) fs.rmSync(runRoot, { recursive: true, force: false, maxRetries: 0 });
    } catch {
      commandFailures += 1;
    }
    const containers = await invoke(["ps", "--all", "--quiet", "--filter", `label=${names.label}`]);
    const volumes = await invoke(["volume", "ls", "--quiet", "--filter", `label=${names.label}`]);
    const networks = await invoke(["network", "ls", "--quiet", "--filter", `label=${names.label}`]);
    const listeners = port ? await hostListeners(port).catch(() => ["probe-failed"]) : [];
    for (const material of Object.values(materials)) material.fill(0);
    const containerResiduals = containers?.code === 0 && !containers.stdout.trim() ? 0 : 1;
    const volumeResiduals = volumes?.code === 0 && !volumes.stdout.trim() ? 0 : 1;
    const networkResiduals = networks?.code === 0 && !networks.stdout.trim() ? 0 : 1;
    const result = Object.freeze({
      containerResiduals,
      volumeResiduals,
      networkResiduals,
      listenerResiduals: listeners.length,
      temporaryRootResiduals: fs.existsSync(runRoot) ? 1 : 0,
      containerRemoved: containerResiduals === 0,
      volumeRemoved: volumeResiduals === 0,
      networkRemoved: networkResiduals === 0,
      syntheticCredentialMaterialRemoved: !fs.existsSync(passwordFile),
      cleanupCompleted: commandFailures === 0 && containerResiduals === 0 && volumeResiduals === 0 && networkResiduals === 0 && listeners.length === 0 && !fs.existsSync(runRoot)
    });
    if (!result.cleanupCompleted) fail("linux_postgres_cleanup_incomplete");
    return result;
  }

  return Object.freeze({
    bootstrap,
    cleanup,
    createRunTool,
    get InstrumentedPool() { return InstrumentedPool; },
    get materials() { return materials; },
    get names() { return names; },
    get port() { return port; },
    get runRoot() { return runRoot; },
    get workDirectory() { return workDirectory; },
    makePool,
    orphanSessionCount,
    scanDataDirectoryMarkers,
    sessionRows,
    start
  });
}

module.exports = {
  ADMIN_LOGIN,
  DATABASE,
  IMAGE,
  IMAGE_DIGEST,
  assertExactLoopbackListener,
  INTERNAL_PORT,
  LOOPBACK,
  LinuxPostgresFailure,
  MIGRATION_LOGIN,
  MIGRATOR_ROLE,
  OWNER_ROLE,
  PROVISIONER_LOGIN,
  RUNTIME_LOGIN,
  RUNTIME_ROLE,
  commandRunner,
  createLinuxPostgres,
  dockerNames,
  generatedSecret,
  instrumentedPoolClass,
  poolOptions,
  safeRunId
};
