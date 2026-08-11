"use strict";

// Concrete, harness-only physical plans. Importing this module performs no I/O,
// opens no socket and starts no process. The local transport exception is
// deliberately confined to the child-process adapter below; product TLS
// configuration remains unchanged.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  LOCAL_PHYSICAL_APPROVAL,
  RUN_MARKER_PATTERN,
  runProfileBackup,
  runProfileRestore
} = require("./social-3a0p-local-backup-restore");

const LOOPBACK_HOST = "127.0.0.1";
const BACKUP_LOGICAL_HOST = "backup.local.ia4tube.invalid";
const BACKUP_LOGICAL_PORT = 5432;
const BACKUP_CONNECTIVITY_MODE = "logical_dns_to_internal_container_v1";
const BACKUP_PHYSICAL_MODE = "internal_container_loopback";
const LOCAL_VERIFIER_HOST = "local.ia4tube.invalid";
const LOCAL_DATABASE = "ia4tube_social_local";
const ADMIN_LOGIN = "ia4tube_social_local_admin";
const PROVISIONER_LOGIN = "ia4tube_social_local_provisioner";
const MIGRATION_LOGIN = "ia4tube_social_local_migration";
const RUNTIME_LOGIN = "ia4tube_social_local_runtime";
const OWNER_ROLE = "ia4tube_social_owner";
const MIGRATOR_ROLE = "ia4tube_social_migrator";
const SCHEMA_PROFILE_0003 = "social-schema-0003";
const SCHEMA_PROFILE_0004 = "social-schema-0004";
const SCHEMA_PROFILE_IDS = Object.freeze([
  SCHEMA_PROFILE_0003,
  SCHEMA_PROFILE_0004
]);
const CURRENT_SOCIAL_REPOSITORY_METHODS = Object.freeze([
  "consumeReauthGrant",
  "createConnection",
  "createReauthGrant",
  "findReauthIdentity",
  "findConnection",
  "findEncryptedCredential",
  "findEncryptedCredentialForKeyRotation",
  "listCredentialKeyVersions",
  "rotateEncryptedCredential",
  "rotateEncryptedCredentialForKeyRotation",
  "storeEncryptedCredential"
]);
const LEGACY_SOCIAL_REPOSITORY_METHODS = Object.freeze([
  "consumeReauthGrant",
  "createConnection",
  "createReauthGrant",
  "findReauthIdentity",
  "findConnection",
  "findEncryptedCredential",
  "listCredentialKeyVersions",
  "rotateEncryptedCredential",
  "storeEncryptedCredential"
]);
const BACKUP_PROVENANCE_OPERATIONS = new Set([
  "rollback_backup_0003",
  "gate5_backup_0003",
  "gate5_backup_0004"
]);
const RESTORE_PROVENANCE_OPERATIONS = new Set([
  "rollback_restore_0003",
  "gate5_restore_0003",
  "gate5_restore_0004"
]);
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/;
const SAFE_ENVIRONMENT_NAMES = new Set([
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGCONNECT_TIMEOUT",
  "PGCHANNELBINDING",
  "PGSSLMODE",
  "PGSSLROOTCERT",
  "SSL_CERT_FILE",
  "PGAPPNAME"
]);
const SAFE_SYSTEM_ENVIRONMENT_NAMES = new Set([
  "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"
]);
const PSQL_ARGS = Object.freeze([
  "--no-password", "--no-psqlrc", "--set=ON_ERROR_STOP=1",
  "--set=VERBOSITY=terse", "--quiet", "--file=-"
]);

class WindowsPhysicalPlanFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "WindowsPhysicalPlanFailure";
  }
}

function fail(code) {
  throw new WindowsPhysicalPlanFailure(code);
}

function plain(value, code) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  return value;
}

function requireCanonicalSchemaProfile(schemaProfiles, expectedProfileId) {
  if (
    !Array.isArray(schemaProfiles) ||
    !Object.isFrozen(schemaProfiles) ||
    schemaProfiles.length === 0 ||
    typeof expectedProfileId !== "string" ||
    expectedProfileId !== expectedProfileId.trim() ||
    expectedProfileId.length === 0
  ) {
    fail("windows_physical_schema_profile_invalid");
  }
  const ids = new Set();
  let canonical;
  for (const profile of schemaProfiles) {
    if (
      !profile ||
      Object.getPrototypeOf(profile) !== Object.prototype ||
      !Object.isFrozen(profile) ||
      Object.keys(profile).sort().join("\u0000") !==
        ["backupTables", "evidenceTables", "id", "migrationRows", "rlsTables"].join("\u0000") ||
      typeof profile.id !== "string" ||
      profile.id !== profile.id.trim() ||
      profile.id.length === 0 ||
      ![profile.backupTables, profile.evidenceTables, profile.migrationRows, profile.rlsTables]
        .every((value) => Array.isArray(value) && Object.isFrozen(value)) ||
      ids.has(profile.id)
    ) {
      fail("windows_physical_schema_profile_invalid");
    }
    ids.add(profile.id);
    if (profile.id === expectedProfileId) canonical = profile;
  }
  if (!canonical) fail("windows_physical_schema_profile_invalid");
  return canonical;
}

function requireExactFrozenMethodObject(candidate, methodNames, code) {
  if (
    !candidate ||
    Object.getPrototypeOf(candidate) !== Object.prototype ||
    !Object.isFrozen(candidate)
  ) {
    fail(code);
  }
  const keys = Reflect.ownKeys(candidate);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== methodNames.length
  ) {
    fail(code);
  }
  const actualNames = [...keys].sort();
  const expectedNames = [...methodNames].sort();
  if (actualNames.some((key, index) => key !== expectedNames[index])) {
    fail(code);
  }
  for (const name of methodNames) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, name);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      descriptor.configurable !== false ||
      descriptor.writable !== false ||
      typeof descriptor.value !== "function" ||
      typeof descriptor.get === "function" ||
      typeof descriptor.set === "function"
    ) {
      fail(code);
    }
  }
  return candidate;
}

function createProfile0003SocialRepositoryBridge(
  currentRepository,
  legacyRepository
) {
  const current = requireExactFrozenMethodObject(
    currentRepository,
    CURRENT_SOCIAL_REPOSITORY_METHODS,
    "windows_physical_current_social_repository_invalid"
  );
  const legacy = requireExactFrozenMethodObject(
    legacyRepository,
    LEGACY_SOCIAL_REPOSITORY_METHODS,
    "windows_physical_2a_social_repository_invalid"
  );
  return requireExactFrozenMethodObject(
    Object.freeze({
      consumeReauthGrant: current.consumeReauthGrant,
      createConnection: current.createConnection,
      createReauthGrant: current.createReauthGrant,
      findReauthIdentity: current.findReauthIdentity,
      findConnection: current.findConnection,
      findEncryptedCredential: legacy.findEncryptedCredential,
      findEncryptedCredentialForKeyRotation:
        current.findEncryptedCredentialForKeyRotation,
      listCredentialKeyVersions: current.listCredentialKeyVersions,
      rotateEncryptedCredential: current.rotateEncryptedCredential,
      rotateEncryptedCredentialForKeyRotation:
        current.rotateEncryptedCredentialForKeyRotation,
      storeEncryptedCredential: current.storeEncryptedCredential
    }),
    CURRENT_SOCIAL_REPOSITORY_METHODS,
    "windows_physical_profile0003_repository_bridge_invalid"
  );
}

function createProfileAwareSocialRepositoryFactory({
  currentCreateSocialRepository,
  expectedProfile,
  legacyCreateSocialRepository
}) {
  if (
    !expectedProfile ||
    Object.getPrototypeOf(expectedProfile) !== Object.prototype ||
    !Object.isFrozen(expectedProfile) ||
    !SCHEMA_PROFILE_IDS.includes(expectedProfile.id) ||
    typeof currentCreateSocialRepository !== "function" ||
    typeof legacyCreateSocialRepository !== "function"
  ) {
    fail("windows_physical_profile_repository_factory_invalid");
  }
  if (expectedProfile.id === SCHEMA_PROFILE_0004) {
    return currentCreateSocialRepository;
  }
  return Object.freeze(function createProfile0003SocialRepository(options) {
    const currentRepository = currentCreateSocialRepository(options);
    const legacyRepository = legacyCreateSocialRepository(options);
    return createProfile0003SocialRepositoryBridge(
      currentRepository,
      legacyRepository
    );
  });
}

function requireRestoreBehaviorFacade(candidate) {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof candidate.createRestoreBehaviorVerifiers !== "function" ||
    typeof candidate.verifyRuntimeSchemaForProfile !== "function" ||
    typeof candidate.schemaProfileDiagnostics !== "function"
  ) {
    fail("windows_physical_restore_behavior_facade_invalid");
  }
  return candidate;
}

function createDefaultRestoreBehaviorFacade({
  currentSocialRepository,
  restoreBehavior,
  runtimeValidation,
  schemaProfiles,
  legacy2ARoot
}) {
  if (
    !restoreBehavior ||
    typeof restoreBehavior.createRestoreBehaviorVerifiers !== "function" ||
    typeof restoreBehavior.loadLegacy2ADependencies !== "function" ||
    !currentSocialRepository ||
    typeof currentSocialRepository.createSocialRepository !== "function" ||
    !runtimeValidation ||
    typeof runtimeValidation.verifyRuntimeSchema !== "function" ||
    typeof legacy2ARoot !== "string" ||
    !path.isAbsolute(legacy2ARoot)
  ) {
    fail("windows_physical_restore_behavior_facade_invalid");
  }
  for (const profileId of SCHEMA_PROFILE_IDS) {
    requireCanonicalSchemaProfile(schemaProfiles, profileId);
  }
  if (
    schemaProfiles.length !== SCHEMA_PROFILE_IDS.length ||
    schemaProfiles.some((profile) => !SCHEMA_PROFILE_IDS.includes(profile.id))
  ) {
    fail("windows_physical_schema_profile_invalid");
  }

  let legacyDependencies;
  let legacyLoadFailure;
  let legacyLoadAttempted = false;
  let legacyLoadSucceeded = false;

  function loadLegacyDependencies() {
    if (legacyLoadAttempted) {
      if (!legacyLoadSucceeded) throw legacyLoadFailure;
      return legacyDependencies;
    }
    legacyLoadAttempted = true;
    try {
      const loaded = restoreBehavior.loadLegacy2ADependencies(legacy2ARoot);
      const operationNames = [
        "createCompanyScopedRepository",
        "createSocialCredentialService",
        "createSocialRepository",
        "createSocialVault",
        "verifyRuntimeRole",
        "verifyRuntimeSchema"
      ];
      if (
        !loaded ||
        typeof loaded !== "object" ||
        operationNames.some((name) => typeof loaded[name] !== "function")
      ) {
        fail("windows_physical_restore_behavior_2a_dependencies_invalid");
      }
      legacyDependencies = loaded;
      legacyLoadSucceeded = true;
      return legacyDependencies;
    } catch (error) {
      legacyLoadFailure = error;
      throw error;
    }
  }

  function selectedSchemaVerifier(expectedProfileId) {
    requireCanonicalSchemaProfile(schemaProfiles, expectedProfileId);
    if (!SCHEMA_PROFILE_IDS.includes(expectedProfileId)) {
      fail("windows_physical_schema_profile_invalid");
    }
    return expectedProfileId === SCHEMA_PROFILE_0003
      ? loadLegacyDependencies().verifyRuntimeSchema
      : runtimeValidation.verifyRuntimeSchema;
  }

  function boundSchemaVerifier(expectedProfileId) {
    const verifier = selectedSchemaVerifier(expectedProfileId);
    return (pool, role) => verifier(pool, role);
  }

  function profileBoundLegacyDependencies(verifyRuntimeSchema) {
    const legacy = loadLegacyDependencies();
    return Object.freeze({
      createCompanyScopedRepository: legacy.createCompanyScopedRepository,
      createSocialCredentialService: legacy.createSocialCredentialService,
      createSocialRepository: legacy.createSocialRepository,
      createSocialVault: legacy.createSocialVault,
      verifyRuntimeRole: legacy.verifyRuntimeRole,
      verifyRuntimeSchema
    });
  }

  return Object.freeze({
    createRestoreBehaviorVerifiers(options = {}) {
      if (
        !options ||
        Object.getPrototypeOf(options) !== Object.prototype ||
        Object.hasOwn(options, "legacyDependencies") ||
        (options.dependencies !== undefined && (
          !options.dependencies ||
          Object.getPrototypeOf(options.dependencies) !== Object.prototype ||
          Object.hasOwn(options.dependencies, "createSocialRepository")
        ))
      ) {
        fail("windows_physical_restore_behavior_options_invalid");
      }
      const expectedProfile = requireCanonicalSchemaProfile(
        schemaProfiles,
        options.expectedProfileId
      );
      const verifyRuntimeSchema = boundSchemaVerifier(
        expectedProfile.id
      );
      const legacyDependencies = profileBoundLegacyDependencies(
        verifyRuntimeSchema
      );
      const createSocialRepository =
        createProfileAwareSocialRepositoryFactory({
          currentCreateSocialRepository:
            currentSocialRepository.createSocialRepository,
          expectedProfile,
          legacyCreateSocialRepository:
            legacyDependencies.createSocialRepository
        });
      const forwarded = { ...options };
      delete forwarded.expectedProfileId;
      return restoreBehavior.createRestoreBehaviorVerifiers({
        ...forwarded,
        legacy2ARoot,
        dependencies: Object.freeze({
          ...(forwarded.dependencies || {}),
          createSocialRepository,
          verifyRuntimeSchema
        }),
        legacyDependencies
      });
    },
    verifyRuntimeSchemaForProfile(request) {
      if (
        !request ||
        Object.getPrototypeOf(request) !== Object.prototype ||
        Object.keys(request).sort().join("\u0000") !==
          ["expectedProfileId", "pool", "role"].join("\u0000")
      ) {
        fail("windows_physical_schema_profile_verifier_request_invalid");
      }
      return boundSchemaVerifier(request.expectedProfileId)(
        request.pool,
        request.role
      );
    },
    schemaProfileDiagnostics() {
      return null;
    }
  });
}

function identifier(value, code = "windows_physical_plan_identifier_invalid") {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) fail(code);
  return value;
}

function quoteIdentifier(value) {
  return `"${identifier(value)}"`;
}

function quoteLiteral(value) {
  const text = String(value);
  if (/[/\0\r\n]/.test(text)) fail("windows_physical_plan_literal_invalid");
  return `'${text.replaceAll("'", "''")}'`;
}

function isWithin(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function materialText(value) {
  if (!Buffer.isBuffer(value) || value.length < 32) {
    fail("windows_physical_plan_material_invalid");
  }
  return value.toString("utf8");
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

function exactTarget(target) {
  plain(target, "windows_physical_plan_target_invalid");
  if (
    target.host !== LOOPBACK_HOST ||
    !Number.isSafeInteger(target.port) ||
    target.port < 1024 ||
    target.port > 65535
  ) {
    fail("windows_physical_plan_target_invalid");
  }
  return Object.freeze({ host: LOOPBACK_HOST, port: target.port });
}

function assertRunBinding({ approval, runMarker, target }) {
  if (approval !== LOCAL_PHYSICAL_APPROVAL) {
    fail("windows_physical_plan_approval_missing");
  }
  if (!RUN_MARKER_PATTERN.test(String(runMarker || ""))) {
    fail("windows_physical_plan_run_marker_invalid");
  }
  return Object.freeze({ runMarker, target: exactTarget(target) });
}

function assertLocalToolPlan(plan, binding) {
  plain(plan, "windows_local_tool_plan_invalid");
  const environment = plain(plan.env, "windows_local_tool_environment_invalid");
  const executable = typeof plan.executable === "string"
    ? path.resolve(plan.executable).toLowerCase()
    : "";
  const args = Array.isArray(plan.args) ? plan.args : [];
  const restoreExecutable = binding.executables.pgRestore;
  if (
    executable === restoreExecutable &&
    args.length === 2 &&
    args[0] === "--list"
  ) {
    if (
      typeof args[1] !== "string" ||
      !path.isAbsolute(args[1]) ||
      !isWithin(args[1], binding.ownedRoot) ||
      Object.keys(environment).some((name) => !SAFE_SYSTEM_ENVIRONMENT_NAMES.has(name)) ||
      plan.input !== undefined
    ) {
      fail("windows_local_tool_offline_plan_refused");
    }
    return Object.freeze({ environment, offline: true });
  }
  if (
    binding.approval !== LOCAL_PHYSICAL_APPROVAL ||
    !RUN_MARKER_PATTERN.test(binding.runMarker) ||
    environment.PGHOST !== LOOPBACK_HOST ||
    environment.PGPORT !== String(binding.target.port) ||
    !binding.allowedDatabases.has(environment.PGDATABASE) ||
    !binding.allowedLogins.has(environment.PGUSER) ||
    typeof environment.PGPASSWORD !== "string" ||
    environment.PGPASSWORD.length < 32 ||
    environment.PGSSLMODE !== "verify-full" ||
    environment.PGCHANNELBINDING !== "disable" ||
    environment.PGSSLROOTCERT !== "system" ||
    typeof environment.SSL_CERT_FILE !== "string" ||
    !path.isAbsolute(environment.SSL_CERT_FILE) ||
    !isWithin(environment.SSL_CERT_FILE, binding.ownedRoot) ||
    environment.PGCONNECT_TIMEOUT !== "10" ||
    environment.PGAPPNAME !== "ia4tube-social-backup-restore"
  ) {
    fail("windows_local_tool_transport_refused");
  }
  const names = Object.keys(environment);
  if (names.some((name) => !SAFE_ENVIRONMENT_NAMES.has(name))) {
    fail("windows_local_tool_environment_refused");
  }
  const fileArgument = (prefix) => args.find((argument) => argument.startsWith(prefix));
  const ownedFileArgument = (prefix) => {
    const value = fileArgument(prefix)?.slice(prefix.length);
    return typeof value === "string" && path.isAbsolute(value) && isWithin(value, binding.ownedRoot);
  };
  const exact = (expected) => args.length === expected.length &&
    args.every((argument, index) => argument === expected[index]);
  const isPsql = executable === binding.executables.psql &&
    exact(PSQL_ARGS) &&
    (typeof plan.input === "string" || Buffer.isBuffer(plan.input));
  const isDump = executable === binding.executables.pgDump &&
    args.length === 10 &&
    exact([
      "--format=custom", "--compress=9", "--no-password",
      `--role=${OWNER_ROLE}`, "--schema=ia4tube_social",
      "--schema=ia4tube_social_admin", "--schema=ia4tube_migrations",
      "--lock-wait-timeout=10000", "--schema-only", args[9]
    ]) &&
    ownedFileArgument("--file=") && plan.input === undefined;
  const isRestore = executable === restoreExecutable &&
    args.length === 7 &&
    exact([
      "--exit-on-error", "--single-transaction", "--no-password",
      "--no-owner", `--role=${OWNER_ROLE}`,
      `--dbname=${environment.PGDATABASE}`, args[6]
    ]) &&
    path.isAbsolute(args[6]) && isWithin(args[6], binding.ownedRoot) &&
    plan.input === undefined;
  if (
    typeof plan.executable !== "string" || !path.isAbsolute(plan.executable) ||
    !binding.allowedExecutables.has(executable) ||
    args.some((argument) => typeof argument !== "string") ||
    !(isPsql || isDump || isRestore)
  ) {
    fail("windows_local_tool_command_refused");
  }
  return Object.freeze({ environment, offline: false });
}

function createLocalPgToolRunner({
  approval,
  runMarker,
  target,
  ownedRoot,
  processRunner,
  executables,
  allowedDatabases,
  allowedLogins
}) {
  const runBinding = assertRunBinding({ approval, runMarker, target });
  if (
    typeof ownedRoot !== "string" ||
    !path.isAbsolute(ownedRoot) ||
    !processRunner ||
    typeof processRunner.run !== "function"
  ) {
    fail("windows_local_tool_runner_invalid");
  }
  const executableSet = new Set(
    [executables?.psql, executables?.pgDump, executables?.pgRestore]
      .map((item) => typeof item === "string" ? path.resolve(item).toLowerCase() : "")
      .filter(Boolean)
  );
  if (executableSet.size !== 3) fail("windows_local_tool_executables_invalid");
  const executableBinding = Object.freeze({
    psql: path.resolve(executables.psql).toLowerCase(),
    pgDump: path.resolve(executables.pgDump).toLowerCase(),
    pgRestore: path.resolve(executables.pgRestore).toLowerCase()
  });
  const databasePolicy = typeof allowedDatabases === "function"
    ? allowedDatabases
    : () => new Set(allowedDatabases || []);
  const loginSet = new Set(allowedLogins || []);
  if (loginSet.size < 1) fail("windows_local_tool_logins_invalid");

  return async function runLocalTool(plan) {
    const binding = {
      ...runBinding,
      approval,
      ownedRoot: path.resolve(ownedRoot),
      allowedExecutables: executableSet,
      executables: executableBinding,
      allowedDatabases: new Set(databasePolicy()),
      allowedLogins: loginSet
    };
    const validated = assertLocalToolPlan(plan, binding);
    const sourceEnvironment = validated.environment;
    const environment = {
      ...sourceEnvironment,
      TEMP: path.resolve(ownedRoot),
      TMP: path.resolve(ownedRoot),
      TMPDIR: path.resolve(ownedRoot)
    };
    if (!validated.offline) {
      environment.PGSSLMODE = "disable";
      delete environment.PGSSLROOTCERT;
      delete environment.SSL_CERT_FILE;
    }
    const input = plan.input === undefined
      ? null
      : Buffer.isBuffer(plan.input)
        ? Buffer.from(plan.input)
        : Buffer.from(String(plan.input), "utf8");
    try {
      const result = await processRunner.run({
        executable: plan.executable,
        args: [...plan.args],
        cwd: path.resolve(ownedRoot),
        environment,
        allowedEnvironmentNames: Object.keys(environment),
        timeoutMs: 10 * 60_000,
        input,
        secretValues: validated.offline ? [] : [sourceEnvironment.PGPASSWORD],
        label: `postgres_tool_${path.basename(plan.executable, ".exe")}`
      });
      return Object.freeze({
        code: result.exitCode,
        stdout: result.stdoutSanitized,
        stderr: result.stderrSanitized
      });
    } finally {
      input?.fill(0);
      if (!validated.offline) environment.PGPASSWORD = "";
    }
  };
}

function connectionUrl({ target, database, login, password, verifyFull = true }) {
  const url = new URL(`postgresql://${target.host || LOOPBACK_HOST}:${target.port}/${identifier(database)}`);
  url.username = identifier(login);
  url.password = password;
  if (verifyFull) url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

function createLocalVerifierPoolClass({ PoolClass, target, database, passwords }) {
  if (typeof PoolClass !== "function") fail("windows_physical_verifier_pool_invalid");
  return class LocalVerifierPool {
    constructor(configuration) {
      let parsed;
      try { parsed = new URL(configuration?.connectionString); } catch { fail("windows_physical_verifier_target_refused"); }
      const login = decodeURIComponent(parsed.username);
      const password = decodeURIComponent(parsed.password);
      const expectedMaximum = login === MIGRATION_LOGIN ? 1 : login === RUNTIME_LOGIN ? 2 : -1;
      if (
        parsed.protocol !== "postgresql:" || parsed.hostname !== LOCAL_VERIFIER_HOST ||
        (parsed.port || "5432") !== String(target.port) ||
        decodeURIComponent(parsed.pathname.slice(1)) !== database ||
        parsed.search || parsed.hash || password !== passwords[login] ||
        configuration?.max !== expectedMaximum || configuration?.min !== 0 ||
        configuration?.ssl?.rejectUnauthorized !== true ||
        configuration?.ssl?.minVersion !== "TLSv1.2" ||
        configuration?.ssl?.servername !== LOCAL_VERIFIER_HOST ||
        typeof configuration?.ssl?.checkServerIdentity !== "function"
      ) {
        fail("windows_physical_verifier_target_refused");
      }
      return new PoolClass({
        ...configuration,
        connectionString: undefined,
        host: LOOPBACK_HOST,
        port: target.port,
        database,
        user: login,
        password,
        ssl: false
      });
    }
  };
}

function poolOptions(state, database, login, password, max, applicationName) {
  return {
    host: LOOPBACK_HOST,
    port: state.target.port,
    database: identifier(database),
    user: identifier(login),
    password,
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

function markerText(identity) {
  return [
    "ia4tube-social-3a0p-owned-v1",
    identity.runMarker,
    identity.profileId,
    identity.database
  ].join(":");
}

function exactIdentity(identity, expected) {
  if (
    !identity ||
    Object.getPrototypeOf(identity) !== Object.prototype ||
    identity.host !== LOOPBACK_HOST ||
    identity.database !== expected.database ||
    identity.profileId !== expected.profileId ||
    identity.runMarker !== expected.runMarker
  ) {
    fail("windows_physical_database_identity_invalid");
  }
  return Object.freeze({ ...expected });
}

function exactProof(proof, identity) {
  if (
    !proof ||
    Object.getPrototypeOf(proof) !== Object.prototype ||
    proof.createdByThisRun !== true ||
    proof.host !== identity.host ||
    proof.database !== identity.database ||
    proof.profileId !== identity.profileId ||
    proof.runMarker !== identity.runMarker
  ) {
    fail("windows_physical_database_ownership_invalid");
  }
  return Object.freeze({ ...proof });
}

function createDefaultDatabaseManager({
  state,
  paths,
  PoolClass,
  createLoginCredentialVerifierBridge = null,
  repositoryRoot,
  product,
  fileSystem = fs
}) {
  if (
    typeof PoolClass !== "function" ||
    (createLoginCredentialVerifierBridge !== null &&
      typeof createLoginCredentialVerifierBridge !== "function")
  ) {
    fail("windows_physical_pool_missing");
  }
  const migrations = product.migrations;
  const loginBootstrap = product.loginBootstrap;
  const rolesSql = fileSystem.readFileSync(
    path.join(repositoryRoot, "db", "postgres", "roles.sql"),
    "utf8"
  );
  const owned = new Map();
  const pools = new Map();

  function password(login) {
    const materials = {
      [ADMIN_LOGIN]: state.materials.admin,
      [PROVISIONER_LOGIN]: state.materials.provisioner,
      [MIGRATION_LOGIN]: state.materials.migration,
      [RUNTIME_LOGIN]: state.materials.runtime
    };
    return materialText(materials[login]);
  }

  function pool(database, login, max = 1) {
    const key = `${database}/${login}/${max}`;
    if (!pools.has(key)) {
      pools.set(key, new PoolClass(poolOptions(
        state,
        database,
        login,
        password(login),
        max,
        `ia4tube-social-3a0p-${login.slice(-16)}`
      )));
    }
    return pools.get(key);
  }

  async function withAdmin(operation) {
    const adminPool = pool("postgres", ADMIN_LOGIN, 1);
    const client = await adminPool.connect();
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }

  async function inspect(identity) {
    const expected = identity;
    return withAdmin(async (client) => {
      const result = await client.query(
        [
          "SELECT owner.rolname AS owner,",
          "  pg_catalog.shobj_description(database.oid,'pg_database') AS marker",
          "FROM pg_catalog.pg_database database",
          "JOIN pg_catalog.pg_roles owner ON owner.oid=database.datdba",
          "WHERE database.datname=$1"
        ].join("\n"),
        [expected.database]
      );
      if (result.rowCount === 0) return Object.freeze({ status: "absent" });
      const row = result.rows[0];
      if (row.owner !== PROVISIONER_LOGIN || row.marker !== markerText(expected)) {
        fail("windows_physical_database_collision");
      }
      return Object.freeze({ status: "owned" });
    });
  }

  async function initializeDatabase(database) {
    const provisionerPool = pool(database, PROVISIONER_LOGIN, 1);
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
    // The physical LOGIN roles are cluster-scoped and already exist after the
    // primary local database bootstrap. CONNECT, however, is database-scoped.
    // Grant it explicitly from this database owner, then let the definitive
    // bootstrap re-audit the complete role/ACL topology twice.
    const aclClient = await provisionerPool.connect();
    try {
      const existing = await aclClient.query(
        "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname",
        [[MIGRATION_LOGIN, RUNTIME_LOGIN]]
      );
      if (existing.rowCount !== 2) {
        fail("windows_physical_database_logins_missing");
      }
      await aclClient.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(MIGRATION_LOGIN)}`
      );
      await aclClient.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(RUNTIME_LOGIN)}`
      );
    } finally {
      aclClient.release();
    }
    const target = {
      host: LOOPBACK_HOST,
      port: String(state.target.port),
      database,
      provisionerLogin: PROVISIONER_LOGIN,
      migrationLogin: MIGRATION_LOGIN,
      runtimeLogin: RUNTIME_LOGIN
    };
    const configuration = {
      target,
      targetFingerprint: loginBootstrap.targetFingerprint(target),
      provisionerPool: {
        ...poolOptions(
          state,
          database,
          PROVISIONER_LOGIN,
          password(PROVISIONER_LOGIN),
          1,
          "ia4tube-social-3a0p-provisioner"
        ),
        connectionString: connectionUrl({
          target: state.target,
          database,
          login: PROVISIONER_LOGIN,
          password: password(PROVISIONER_LOGIN),
          verifyFull: false
        })
      },
      migration: hidden({
        login: MIGRATION_LOGIN,
        role: loginBootstrap.MIGRATOR_ROLE,
        connectionLimit: loginBootstrap.MIGRATION_CONNECTION_LIMIT
      }, "password", password(MIGRATION_LOGIN)),
      runtime: hidden({
        login: RUNTIME_LOGIN,
        role: loginBootstrap.RUNTIME_ROLE,
        connectionLimit: loginBootstrap.RUNTIME_CONNECTION_LIMIT
      }, "password", password(RUNTIME_LOGIN))
    };
    const first = await loginBootstrap.bootstrapDatabaseLogins(
      provisionerPool,
      configuration
    );
    const second = await loginBootstrap.bootstrapDatabaseLogins(
      provisionerPool,
      configuration
    );
    let verifierPoolClass = PoolClass;
    let verifierConfiguration = configuration;
    if (createLoginCredentialVerifierBridge) {
      const bridge = createLoginCredentialVerifierBridge({ database, configuration });
      if (
        !bridge || Object.getPrototypeOf(bridge) !== Object.prototype ||
        typeof bridge.PoolClass !== "function" ||
        typeof bridge.authorizeProvisionerPool !== "function"
      ) {
        fail("windows_physical_login_verifier_bridge_invalid");
      }
      const authorizedProvisionerPool = bridge.authorizeProvisionerPool(
        configuration.provisionerPool
      );
      if (
        !authorizedProvisionerPool ||
        authorizedProvisionerPool === configuration.provisionerPool
      ) {
        fail("windows_physical_login_verifier_bridge_invalid");
      }
      verifierPoolClass = bridge.PoolClass;
      verifierConfiguration = Object.freeze({
        ...configuration,
        provisionerPool: authorizedProvisionerPool
      });
    }
    const verified = await loginBootstrap.verifyProvisionedLoginCredentials(
      verifierPoolClass,
      verifierConfiguration
    );
    if (
      first.safe !== true ||
      second.safe !== true ||
      second.created?.migration !== false ||
      second.created?.runtime !== false ||
      verified.verified !== 2
    ) {
      fail("windows_physical_database_logins_invalid");
    }
  }

  async function create(identity) {
    const expected = exactIdentity(identity, identity);
    if (owned.has(expected.database) || (await inspect(expected)).status !== "absent") {
      fail("windows_physical_database_collision");
    }
    let createConfirmed = false;
    try {
      await withAdmin(async (client) => {
        await client.query(
          `CREATE DATABASE ${quoteIdentifier(expected.database)} OWNER ${quoteIdentifier(PROVISIONER_LOGIN)}`
        );
        createConfirmed = true;
        await client.query(
          `COMMENT ON DATABASE ${quoteIdentifier(expected.database)} IS ${quoteLiteral(markerText(expected))}`
        );
      });
      await initializeDatabase(expected.database);
      const proof = Object.freeze({ createdByThisRun: true, ...expected });
      owned.set(expected.database, proof);
      return proof;
    } catch (error) {
      // If CREATE was confirmed but the durable marker was not, compensate only
      // this exact newly-created name. An ambiguous server result is reconciled
      // by the caller and never adopted.
      if (createConfirmed) {
        const observed = await inspect(expected).catch(() => null);
        if (observed?.status === "owned") {
          owned.set(expected.database, Object.freeze({ createdByThisRun: true, ...expected }));
        }
      }
      throw error;
    }
  }

  async function reconcile(identity) {
    const expected = exactIdentity(identity, identity);
    const result = await inspect(expected);
    return Object.freeze({
      ...expected,
      status: result.status,
      createdByThisRun: result.status === "owned"
    });
  }

  async function assertCreated(proof) {
    const expected = exactProof(proof, proof);
    return (await inspect(expected)).status === "owned";
  }

  async function closeDatabasePools(database) {
    for (const [key, instance] of [...pools.entries()]) {
      if (!key.startsWith(`${database}/`)) continue;
      pools.delete(key);
      await instance.end();
    }
  }

  async function remove(proof) {
    const expected = exactProof(proof, proof);
    if (!owned.has(expected.database) || (await inspect(expected)).status !== "owned") {
      fail("windows_physical_database_ownership_invalid");
    }
    await closeDatabasePools(expected.database);
    await withAdmin((client) => client.query(
      `DROP DATABASE ${quoteIdentifier(expected.database)} WITH (FORCE)`
    ));
    owned.delete(expected.database);
    return true;
  }

  async function assertRemoved(proof) {
    const expected = exactProof(proof, proof);
    return (await inspect(expected)).status === "absent";
  }

  function subsetManifestDirectory() {
    const directory = path.join(paths.ownedRoot, "migration-profile-0003");
    if (!fileSystem.existsSync(directory)) {
      fileSystem.mkdirSync(directory, { recursive: false });
      const manifest = JSON.parse(fileSystem.readFileSync(
        path.join(repositoryRoot, "db", "migrations", "checksums.json"),
        "utf8"
      ));
      const subset = manifest.migrations.filter((item) => item.version.startsWith("0001_") || item.version.startsWith("0002_") || item.version.startsWith("0003_"));
      for (const item of subset) {
        fileSystem.copyFileSync(
          path.join(repositoryRoot, "db", "migrations", item.file),
          path.join(directory, item.file),
          fs.constants.COPYFILE_EXCL
        );
      }
      fileSystem.writeFileSync(
        path.join(directory, "checksums.json"),
        `${JSON.stringify({ format: 1, migrations: subset }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" }
      );
    }
    return directory;
  }

  async function applyProfile(database, profileId) {
    const target = {
      approval: migrations.APPLY_APPROVAL,
      productionApproval: "not-applicable-local-harness",
      environment: "local",
      environmentId: state.environmentId,
      host: LOOPBACK_HOST,
      port: String(state.target.port),
      database,
      username: MIGRATION_LOGIN
    };
    const manifestOptions = profileId === "social-schema-0003"
      ? {
          migrationsDirectory: subsetManifestDirectory(),
          manifestPath: path.join(subsetManifestDirectory(), "checksums.json")
        }
      : { root: repositoryRoot };
    const runner = migrations.createMigrationRunner({
      pool: pool(database, MIGRATION_LOGIN, 2),
      ownerRole: OWNER_ROLE,
      migratorRole: MIGRATOR_ROLE,
      target,
      manifestOptions
    });
    await runner.apply({
      SOCIAL_MIGRATION_TARGET_FINGERPRINT: migrations.targetFingerprint(target)
    });
    const validation = await runner.validate();
    const expected = profileId === "social-schema-0003" ? 3 : 4;
    if (validation.valid !== true || validation.applied !== expected || validation.pending !== 0) {
      fail("windows_physical_database_profile_invalid");
    }
    return true;
  }

  async function applyControlledFailing0004(database) {
    const migration = migrations.readManifest({ root: repositoryRoot })
      .find((item) => item.version === "0004_social_connector_persistence");
    if (!migration) fail("windows_physical_migration_0004_missing");
    const client = await pool(database, MIGRATION_LOGIN, 2).connect();
    let controlledFailureObserved = false;
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${quoteIdentifier(OWNER_ROLE)}`);
      await client.query(migration.sql);
      try {
        await client.query(
          "DO $ia4tube_controlled_failure$ BEGIN RAISE EXCEPTION 'ia4tube_controlled_migration_failure'; END $ia4tube_controlled_failure$;"
        );
      } catch {
        controlledFailureObserved = true;
      }
      await client.query("ROLLBACK");
      if (!controlledFailureObserved) {
        fail("windows_physical_controlled_failure_missing");
      }
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function profileRows(database) {
    const result = await pool(database, MIGRATION_LOGIN, 2).query(
      [
        "SELECT version,checksum_sha256 AS checksum",
        "FROM ia4tube_migrations.schema_migrations ORDER BY version"
      ].join("\n")
    );
    return result.rows;
  }

  async function verifyProfile(database, profileId) {
    const profile = product.backup.resolveSchemaProfile(await profileRows(database));
    if (profile.id !== profileId) fail("windows_physical_database_profile_invalid");
    const rls = await pool(database, MIGRATION_LOGIN, 2).query(
      [
        "SELECT COUNT(*)::integer AS missing",
        "FROM pg_catalog.pg_class relation",
        "JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace",
        "WHERE namespace.nspname='ia4tube_social' AND relation.relkind IN ('r','p')",
        "  AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity)"
      ].join("\n")
    );
    if (Number(rls.rows?.[0]?.missing) !== 0) {
      fail("windows_physical_database_rls_invalid");
    }
    return profile;
  }

  async function catalogFingerprint(database) {
    const result = await pool(database, MIGRATION_LOGIN, 2).query(
      [
        "SELECT jsonb_build_object(",
        " 'relations',COALESCE(jsonb_agg(jsonb_build_array(namespace.nspname,relation.relname,relation.relkind,relation.relrowsecurity,relation.relforcerowsecurity) ORDER BY namespace.nspname,relation.relname),'[]'::jsonb)",
        ")::text AS inventory",
        "FROM pg_catalog.pg_class relation",
        "JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace",
        "WHERE namespace.nspname IN ('ia4tube_social','ia4tube_social_admin','ia4tube_migrations')"
      ].join("\n")
    );
    return crypto.createHash("sha256").update(String(result.rows?.[0]?.inventory || "")).digest("hex");
  }

  async function nonSocialFingerprint(database) {
    const result = await pool(database, MIGRATION_LOGIN, 2).query(
      [
        "SELECT COALESCE(jsonb_agg(jsonb_build_array(namespace.nspname,relation.relname,relation.relkind) ORDER BY namespace.nspname,relation.relname),'[]'::jsonb)::text AS inventory",
        "FROM pg_catalog.pg_class relation",
        "JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace",
        "WHERE namespace.nspname NOT IN ('pg_catalog','information_schema','ia4tube_social','ia4tube_social_admin','ia4tube_migrations')",
        "  AND namespace.nspname NOT LIKE 'pg_toast%'"
      ].join("\n")
    );
    return crypto.createHash("sha256").update(String(result.rows?.[0]?.inventory || "")).digest("hex");
  }

  async function cleanupAll() {
    for (const proof of [...owned.values()].reverse()) {
      await remove(proof);
      if ((await assertRemoved(proof)) !== true) {
        fail("windows_physical_database_remove_unconfirmed");
      }
    }
  }

  return Object.freeze({
    applyControlledFailing0004,
    applyProfile,
    assertCreated,
    assertRemoved,
    catalogFingerprint,
    cleanupAll,
    create,
    getPools(database) {
      return Object.freeze({
        provisioner: pool(database, PROVISIONER_LOGIN, 1),
        migration: pool(database, MIGRATION_LOGIN, 2),
        runtime: pool(database, RUNTIME_LOGIN, 3)
      });
    },
    isAllowedDatabase(database) {
      return database === LOCAL_DATABASE || owned.has(database);
    },
    nonSocialFingerprint,
    profileRows,
    reconcile,
    remove,
    verifyProfile
  });
}

function createWindowsPhysicalPlans(options = {}) {
  plain(options, "windows_physical_plan_options_invalid");
  const binding = assertRunBinding(options);
  const state = options.state;
  const paths = options.paths;
  const executables = options.executables;
  if (
    !state ||
    !paths ||
    !path.isAbsolute(paths.ownedRoot) ||
    !path.isAbsolute(options.repositoryRoot || "")
  ) {
    fail("windows_physical_plan_options_invalid");
  }
  const backup = options.dependencies?.backup || require("../src/persistence/postgres/backup-restore");
  const migrations = options.dependencies?.migrations || require("../src/persistence/postgres/migrations");
  const loginBootstrap = options.dependencies?.loginBootstrap || require("../src/persistence/postgres/login-bootstrap");
  const runProfileRestoreImpl = options.dependencies?.runProfileRestore ||
    runProfileRestore;
  if (typeof runProfileRestoreImpl !== "function") {
    fail("windows_physical_restore_runner_invalid");
  }
  const legacy2ARoot = path.join(
    path.dirname(options.repositoryRoot),
    "social-checkpoint-2a-postgres-vault-20260729"
  );
  const restoreBehavior = options.dependencies?.restoreBehavior === undefined
    ? createDefaultRestoreBehaviorFacade({
        currentSocialRepository: require("../src/persistence/postgres/social-repository"),
        restoreBehavior: require("../src/persistence/postgres/restore-behavior-verifiers"),
        runtimeValidation: require("../src/persistence/postgres/runtime-validation"),
        schemaProfiles: backup.SCHEMA_PROFILES,
        legacy2ARoot
      })
    : requireRestoreBehaviorFacade(options.dependencies.restoreBehavior);
  const product = { backup, migrations, loginBootstrap };
  const databaseManager = options.dependencies?.databaseManager || createDefaultDatabaseManager({
    state,
    paths,
    PoolClass: options.PoolClass,
    createLoginCredentialVerifierBridge:
      options.dependencies?.createLoginCredentialVerifierBridge || null,
    repositoryRoot: options.repositoryRoot,
    product,
    fileSystem: options.dependencies?.fileSystem || fs
  });
  const digest = crypto.createHash("sha256").update(binding.runMarker).digest("hex").slice(0, 12);
  const names = Object.freeze({
    rollbackSource: `ia4tube_social_disposable_rollback_source_${digest}`,
    rollbackRestore: `ia4tube_social_disposable_rollback_0003_${digest}`,
    backupSource0003: `ia4tube_social_disposable_source_0003_${digest}`,
    restore0003: `ia4tube_social_disposable_restore_0003_${digest}`,
    restore0004: `ia4tube_social_disposable_restore_0004_${digest}`,
    tamper: `ia4tube_social_disposable_tamper_${digest}`,
    cross: `ia4tube_social_disposable_cross_${digest}`
  });
  for (const name of Object.values(names)) identifier(name);
  const bundleKey = (options.randomBytes || crypto.randomBytes)(32);
  if (!Buffer.isBuffer(bundleKey) || bundleKey.length !== 32) {
    fail("windows_physical_plan_bundle_key_invalid");
  }
  const ownedDatabaseNames = () => [LOCAL_DATABASE, ...Object.values(names)]
    .filter((name) => databaseManager.isAllowedDatabase(name));
  const runTool = options.dependencies?.runTool || createLocalPgToolRunner({
    approval: LOCAL_PHYSICAL_APPROVAL,
    runMarker: binding.runMarker,
    target: binding.target,
    ownedRoot: paths.ownedRoot,
    processRunner: options.processRunner,
    executables,
    allowedDatabases: ownedDatabaseNames,
    allowedLogins: [MIGRATION_LOGIN, PROVISIONER_LOGIN]
  });
  const createBackupTransportBridge =
    options.dependencies?.createBackupTransportBridge || null;
  if (
    createBackupTransportBridge !== null &&
    typeof createBackupTransportBridge !== "function"
  ) {
    fail("windows_physical_backup_transport_bridge_invalid");
  }
  const backupRestoreProvenance =
    options.dependencies?.backupRestoreProvenance;
  if (
    backupRestoreProvenance !== undefined && (
      !backupRestoreProvenance ||
      Object.getPrototypeOf(backupRestoreProvenance) !== Object.prototype ||
      JSON.stringify(Object.keys(backupRestoreProvenance).sort()) !==
        JSON.stringify(["bindBackup", "bindRestore", "runBackup", "runRestore"]) ||
      typeof backupRestoreProvenance.bindBackup !== "function" ||
      typeof backupRestoreProvenance.bindRestore !== "function" ||
      typeof backupRestoreProvenance.runBackup !== "function" ||
      typeof backupRestoreProvenance.runRestore !== "function"
    )
  ) {
    fail("windows_physical_backup_restore_provenance_invalid");
  }
  const fileSystem = options.dependencies?.fileSystem || fs;
  const createdPlans = new Set();
  let planDirectoriesCreated = false;

  function createRestoreVerifierOwnershipLatch() {
    let confirmed = false;
    return Object.freeze({
      confirm() {
        confirmed = true;
        return true;
      },
      isConfirmed() {
        return confirmed;
      },
      reset() {
        confirmed = false;
        return true;
      }
    });
  }

  function restoreVerifiers(database, expectedProfileId, ownershipLatch) {
    if (
      !ownershipLatch ||
      typeof ownershipLatch.confirm !== "function" ||
      typeof ownershipLatch.isConfirmed !== "function" ||
      typeof ownershipLatch.reset !== "function"
    ) {
      fail("windows_physical_verifier_database_refused");
    }
    const expectedProfile = requireCanonicalSchemaProfile(
      backup.SCHEMA_PROFILES,
      expectedProfileId
    );
    let gate;
    let closed = false;
    const passwords = Object.freeze({
      [MIGRATION_LOGIN]: materialText(state.materials.migration),
      [RUNTIME_LOGIN]: materialText(state.materials.runtime)
    });
    const get = () => {
      if (closed) fail("windows_physical_restore_verifier_closed");
      if (!gate) {
        if (
          ownershipLatch.isConfirmed() !== true ||
          !databaseManager.isAllowedDatabase(database)
        ) {
          fail("windows_physical_verifier_database_refused");
        }
        const facade = requireRestoreBehaviorFacade(restoreBehavior);
        const verifierTarget = { host: LOCAL_VERIFIER_HOST, port: binding.target.port };
        gate = facade.createRestoreBehaviorVerifiers({
          env: {},
          expectedProfileId: expectedProfile.id,
          migrationDatabaseUrl: connectionUrl({ target: verifierTarget, database, login: MIGRATION_LOGIN, password: passwords[MIGRATION_LOGIN] }),
          runtimeDatabaseUrl: connectionUrl({ target: verifierTarget, database, login: RUNTIME_LOGIN, password: passwords[RUNTIME_LOGIN] }),
          expectedMigrationLogin: MIGRATION_LOGIN,
          expectedRuntimeLogin: RUNTIME_LOGIN,
          legacy2ARoot,
          dependencies: {
            PoolClass: createLocalVerifierPoolClass({
              PoolClass: options.PoolClass,
              target: binding.target,
              database,
              passwords
            })
          }
        });
        if (
          !gate ||
          typeof gate.close !== "function" ||
          !gate.verifiers ||
          typeof gate.verifiers.verifyRuntimeIsolation !== "function" ||
          typeof gate.verifiers.verifyVault !== "function" ||
          typeof gate.verifiers.verify2ACompatibility !== "function"
        ) {
          fail("windows_physical_restore_behavior_gate_invalid");
        }
      }
      return gate;
    };
    return Object.freeze({
      verifyRuntimeIsolation: async () => get().verifiers.verifyRuntimeIsolation(),
      verifyVault: async () => get().verifiers.verifyVault(),
      verify2ACompatibility: async () => get().verifiers.verify2ACompatibility(),
      async closeVerifiers() {
        if (closed) return;
        closed = true;
        const current = gate;
        gate = undefined;
        if (current) await current.close();
      }
    });
  }

  function ensurePlanDirectories() {
    if (planDirectoriesCreated) return;
    fileSystem.mkdirSync(path.join(paths.ownedRoot, "backups"), {
      recursive: false
    });
    try {
      fileSystem.mkdirSync(path.join(paths.ownedRoot, "restore-work"), {
        recursive: false
      });
    } catch (error) {
      try {
        fileSystem.rmdirSync(path.join(paths.ownedRoot, "backups"));
      } catch {}
      throw error;
    }
    planDirectoriesCreated = true;
  }

  function identity(database, profileId) {
    return Object.freeze({
      host: LOOPBACK_HOST,
      database,
      profileId,
      runMarker: binding.runMarker
    });
  }

  function lifecycle(database, profileId, ownershipLatch) {
    const expected = identity(database, profileId);
    return Object.freeze({
      markedDisposable: true,
      productionLike: false,
      ...expected,
      create(candidate) {
        const exact = exactIdentity(candidate, expected);
        ownershipLatch.reset();
        return databaseManager.create(exact);
      },
      reconcileCreateFailure: (candidate) => databaseManager.reconcile(exactIdentity(candidate, expected)),
      async assertCreated(proof) {
        const exact = exactProof(proof, expected);
        ownershipLatch.reset();
        const confirmed = await databaseManager.assertCreated(exact);
        if (confirmed === true) ownershipLatch.confirm();
        return confirmed;
      },
      remove(proof) {
        const exact = exactProof(proof, expected);
        ownershipLatch.reset();
        return databaseManager.remove(exact);
      },
      assertRemoved: (proof) => databaseManager.assertRemoved(exactProof(proof, expected))
    });
  }

  function backupConnectionTarget(database, login) {
    return Object.freeze({
      host: createBackupTransportBridge ? BACKUP_LOGICAL_HOST : binding.target.host,
      port: createBackupTransportBridge ? BACKUP_LOGICAL_PORT : binding.target.port,
      database,
      login
    });
  }

  function requireBackupTransport(database) {
    const target = backupConnectionTarget(database, MIGRATION_LOGIN);
    const targetFingerprint = backup.targetFingerprint(target);
    if (!createBackupTransportBridge) {
      return Object.freeze({
        localBinding: Object.freeze({
          host: LOOPBACK_HOST,
          port: String(binding.target.port),
          database,
          login: MIGRATION_LOGIN,
          runMarker: binding.runMarker
        }),
        runTool,
        target,
        targetFingerprint
      });
    }
    const contract = Object.freeze({
      database,
      login: MIGRATION_LOGIN,
      runMarker: binding.runMarker,
      targetFingerprint
    });
    const bridge = createBackupTransportBridge(contract);
    const localBinding = bridge?.localBinding;
    const expectedKeys = [
      "connectivityMode", "containerIdentityDigest", "database", "logicalHost",
      "logicalPort", "login", "physicalHost", "physicalMode", "physicalPort",
      "runMarker", "targetFingerprint"
    ];
    if (
      !bridge || Object.getPrototypeOf(bridge) !== Object.prototype ||
      JSON.stringify(Object.keys(bridge).sort()) !== JSON.stringify(["localBinding", "runTool"]) ||
      !Object.isFrozen(bridge) ||
      !localBinding || Object.getPrototypeOf(localBinding) !== Object.prototype ||
      JSON.stringify(Object.keys(localBinding).sort()) !== JSON.stringify(expectedKeys) ||
      !Object.isFrozen(localBinding) ||
      localBinding.connectivityMode !== BACKUP_CONNECTIVITY_MODE ||
      localBinding.logicalHost !== BACKUP_LOGICAL_HOST ||
      localBinding.logicalPort !== BACKUP_LOGICAL_PORT ||
      localBinding.physicalMode !== BACKUP_PHYSICAL_MODE ||
      localBinding.physicalHost !== LOOPBACK_HOST ||
      localBinding.physicalPort !== BACKUP_LOGICAL_PORT ||
      localBinding.database !== database ||
      localBinding.login !== MIGRATION_LOGIN ||
      localBinding.runMarker !== binding.runMarker ||
      localBinding.targetFingerprint !== targetFingerprint ||
      !/^[0-9a-f]{64}$/.test(String(localBinding.containerIdentityDigest || "")) ||
      typeof bridge.runTool !== "function"
    ) {
      fail("windows_physical_backup_transport_bridge_invalid");
    }
    return Object.freeze({
      localBinding,
      runTool: bridge.runTool,
      target,
      targetFingerprint
    });
  }

  function connectionEnvironment(prefix, database, label, bundlePath) {
    const migrationPassword = materialText(state.materials.migration);
    const provisionerPassword = materialText(state.materials.provisioner);
    const target = backupConnectionTarget(database, MIGRATION_LOGIN);
    const operator = backupConnectionTarget(database, PROVISIONER_LOGIN);
    const base = {
      [`${prefix}_EXPECTED_MIGRATION_LOGIN`]: MIGRATION_LOGIN,
      [`${prefix}_EXPECTED_RUNTIME_LOGIN`]: RUNTIME_LOGIN,
      SOCIAL_BACKUP_BUNDLE_KEY: bundleKey.toString("base64")
    };
    if (prefix === "SOCIAL_BACKUP") {
      return {
        ...base,
        SOCIAL_BACKUP_APPROVED: backup.BACKUP_APPROVAL,
        SOCIAL_BACKUP_DIRECTORY_PROTECTED: "true",
        SOCIAL_BACKUP_OUTPUT_DIRECTORY: path.join(paths.ownedRoot, "backups"),
        SOCIAL_BACKUP_LABEL: label,
        SOCIAL_BACKUP_SOURCE_DATABASE_URL: connectionUrl({ target, database, login: MIGRATION_LOGIN, password: migrationPassword }),
        SOCIAL_BACKUP_SOURCE_EXPECTED_HOST: target.host,
        SOCIAL_BACKUP_SOURCE_EXPECTED_PORT: String(target.port),
        SOCIAL_BACKUP_SOURCE_EXPECTED_DATABASE: database,
        SOCIAL_BACKUP_SOURCE_EXPECTED_LOGIN: MIGRATION_LOGIN,
        SOCIAL_BACKUP_SOURCE_EXPECTED_FINGERPRINT: backup.targetFingerprint(target),
        SOCIAL_BACKUP_OPERATOR_PROVISIONER_DATABASE_URL: connectionUrl({ target: operator, database, login: PROVISIONER_LOGIN, password: provisionerPassword }),
        SOCIAL_BACKUP_OPERATOR_EXPECTED_HOST: operator.host,
        SOCIAL_BACKUP_OPERATOR_EXPECTED_PORT: String(operator.port),
        SOCIAL_BACKUP_OPERATOR_EXPECTED_DATABASE: database,
        SOCIAL_BACKUP_OPERATOR_EXPECTED_LOGIN: PROVISIONER_LOGIN,
        SOCIAL_BACKUP_OPERATOR_EXPECTED_FINGERPRINT: backup.targetFingerprint(operator),
        SOCIAL_BACKUP_EXPECTED_ENVIRONMENT_ID: state.environmentId,
        SOCIAL_BACKUP_EXPECTED_ENVIRONMENT: "local",
        SOCIAL_BACKUP_PG_DUMP_PATH: executables.pgDump,
        SOCIAL_BACKUP_PG_RESTORE_PATH: executables.pgRestore,
        SOCIAL_BACKUP_PSQL_PATH: executables.psql
      };
    }
    return {
      ...base,
      SOCIAL_RESTORE_APPROVED: backup.RESTORE_APPROVAL,
      SOCIAL_RESTORE_WORK_DIRECTORY_PROTECTED: "true",
      SOCIAL_RESTORE_WORK_DIRECTORY: path.join(paths.ownedRoot, "restore-work"),
      SOCIAL_RESTORE_BUNDLE: bundlePath,
      SOCIAL_RESTORE_LABEL: label,
      SOCIAL_RESTORE_TARGET_DATABASE_URL: connectionUrl({ target, database, login: MIGRATION_LOGIN, password: migrationPassword }),
      SOCIAL_RESTORE_TARGET_EXPECTED_HOST: target.host,
      SOCIAL_RESTORE_TARGET_EXPECTED_PORT: String(target.port),
      SOCIAL_RESTORE_TARGET_EXPECTED_DATABASE: database,
      SOCIAL_RESTORE_TARGET_EXPECTED_LOGIN: MIGRATION_LOGIN,
      SOCIAL_RESTORE_TARGET_EXPECTED_FINGERPRINT: backup.targetFingerprint(target),
      SOCIAL_RESTORE_OPERATOR_PROVISIONER_DATABASE_URL: connectionUrl({ target: operator, database, login: PROVISIONER_LOGIN, password: provisionerPassword }),
      SOCIAL_RESTORE_OPERATOR_EXPECTED_HOST: operator.host,
      SOCIAL_RESTORE_OPERATOR_EXPECTED_PORT: String(operator.port),
      SOCIAL_RESTORE_OPERATOR_EXPECTED_DATABASE: database,
      SOCIAL_RESTORE_OPERATOR_EXPECTED_LOGIN: PROVISIONER_LOGIN,
      SOCIAL_RESTORE_OPERATOR_EXPECTED_FINGERPRINT: backup.targetFingerprint(operator),
      SOCIAL_RESTORE_SOURCE_FINGERPRINT: options.sourceFingerprint,
      SOCIAL_RESTORE_PG_RESTORE_PATH: executables.pgRestore,
      SOCIAL_RESTORE_PSQL_PATH: executables.psql
    };
  }

  function bindProvenanceOperation(request, kind, operation) {
    if (operation === undefined || backupRestoreProvenance === undefined) {
      return request;
    }
    const backupMode = kind === "backup";
    const operations = backupMode
      ? BACKUP_PROVENANCE_OPERATIONS
      : RESTORE_PROVENANCE_OPERATIONS;
    if (!operations.has(operation)) {
      fail("windows_physical_backup_restore_provenance_operation_invalid");
    }
    const bound = backupMode
      ? backupRestoreProvenance.bindBackup(operation, request)
      : backupRestoreProvenance.bindRestore(operation, request);
    if (bound !== request) {
      fail("windows_physical_backup_restore_provenance_binding_invalid");
    }
    return bound;
  }

  function runRollbackBackup(request) {
    if (backupRestoreProvenance === undefined) {
      return runProfileBackup(request);
    }
    return backupRestoreProvenance.runBackup(
      runProfileBackup,
      request
    );
  }

  function runRollbackRestore(request) {
    const execute = async (candidate) => {
      let primaryFailure;
      try {
        const result = await backup.runLogicalRestore(candidate);
        if (result?.ok !== true) {
          fail("windows_physical_restore_execution_unconfirmed");
        }
        await candidate.verifyRestoredProfile?.();
        return result;
      } catch (error) {
        primaryFailure = error;
        throw error;
      } finally {
        try {
          await candidate.closeVerifiers?.();
        } catch (closingError) {
          if (!primaryFailure) throw closingError;
        }
      }
    };
    return backupRestoreProvenance === undefined
      ? execute(request)
      : backupRestoreProvenance.runRestore(
          execute,
          request
        );
  }

  function backupRequest(database, profile, label, provenanceOperation) {
    const transport = requireBackupTransport(database);
    const config = backup.loadBackupConfig(
      connectionEnvironment("SOCIAL_BACKUP", database, label),
      { repositoryRoot: options.repositoryRoot }
    );
    const request = bindProvenanceOperation({
      approval: LOCAL_PHYSICAL_APPROVAL,
      profileRows: profile.migrationRows,
      config,
      runMarker: binding.runMarker,
      localBinding: transport.localBinding,
      pool: databaseManager.getPools(database).provisioner,
      runTool: transport.runTool,
      generatedAt: new Date().toISOString()
    }, "backup", provenanceOperation);
    return Object.freeze({ request: Object.freeze(request), config, profile });
  }

  function restoreRequest(
    sourcePlan,
    targetDatabase,
    expectedProfile,
    provenanceOperation,
    afterRestoredProfileVerified
  ) {
    const transport = requireBackupTransport(targetDatabase);
    const env = connectionEnvironment(
      "SOCIAL_RESTORE",
      targetDatabase,
      sourcePlan.config.label,
      sourcePlan.config.files.bundle
    );
    env.SOCIAL_RESTORE_SOURCE_FINGERPRINT = sourcePlan.config.sourceFingerprint;
    const config = backup.loadRestoreConfig(env, {
      repositoryRoot: options.repositoryRoot
    });
    const ownershipLatch = createRestoreVerifierOwnershipLatch();
    const targetLifecycle = lifecycle(
      targetDatabase,
      expectedProfile.id,
      ownershipLatch
    );
    const behavior = restoreVerifiers(
      targetDatabase,
      expectedProfile.id,
      ownershipLatch
    );
    const baseVerifyRestoredProfile = () =>
      databaseManager.verifyProfile(targetDatabase, expectedProfile.id);
    const verifyRestoredProfile = afterRestoredProfileVerified === undefined
      ? baseVerifyRestoredProfile
      : async () => {
          const profile = await baseVerifyRestoredProfile();
          await afterRestoredProfileVerified();
          return profile;
        };
    const request = bindProvenanceOperation({
      approval: LOCAL_PHYSICAL_APPROVAL,
      expectedProfile,
      config,
      localBinding: transport.localBinding,
      pool: databaseManager.getPools(targetDatabase).provisioner,
      runTool: transport.runTool,
      verifierTargetFingerprint: config.targetFingerprint,
      verifyRuntimeIsolation: behavior.verifyRuntimeIsolation,
      verifyVault: behavior.verifyVault,
      verify2ACompatibility: behavior.verify2ACompatibility,
      closeVerifiers: behavior.closeVerifiers,
      verifyRestoredProfile,
      runMarker: binding.runMarker,
      lifecycle: targetLifecycle
    }, "restore", provenanceOperation);
    return Object.freeze(request);
  }

  async function createRollbackAdapter() {
    const profile0003 = requireCanonicalSchemaProfile(
      backup.SCHEMA_PROFILES,
      "social-schema-0003"
    );
    const profile0004 = requireCanonicalSchemaProfile(
      backup.SCHEMA_PROFILES,
      "social-schema-0004"
    );
    const sourceIdentity = identity(names.rollbackSource, profile0003.id);
    const restoreIdentity = identity(names.rollbackRestore, profile0003.id);
    let sourceProof;
    let canonical;
    let nonSocial;
    let sourcePlan;
    let restoreConfig;
    let restored0003ProfileConfirmation;
    const restoreOwnershipLatch = createRestoreVerifierOwnershipLatch();
    const restoreLifecycle = lifecycle(
      names.rollbackRestore,
      profile0003.id,
      restoreOwnershipLatch
    );
    return Object.freeze({
      markedDisposable: true,
      productionLike: false,
      disposableDatabase: names.rollbackRestore,
      runMarker: binding.runMarker,
      async captureCanonical0003() {
        ensurePlanDirectories();
        sourceProof = await databaseManager.create(sourceIdentity);
        if ((await databaseManager.assertCreated(sourceProof)) !== true) return false;
        await databaseManager.applyProfile(names.rollbackSource, profile0003.id);
        canonical = await databaseManager.catalogFingerprint(names.rollbackSource);
        nonSocial = await databaseManager.nonSocialFingerprint(names.rollbackSource);
        return true;
      },
      async applyControlledFailing0004() {
        return options.dependencies?.controlledMigrationFailure
          ? options.dependencies.controlledMigrationFailure({ database: names.rollbackSource, databaseManager })
          : databaseManager.applyControlledFailing0004(names.rollbackSource);
      },
      async verifyTransactionRollback() {
        await databaseManager.verifyProfile(names.rollbackSource, profile0003.id);
        return true;
      },
      async compareCanonical0003() {
        return canonical === await databaseManager.catalogFingerprint(names.rollbackSource);
      },
      async backup0003() {
        sourcePlan = backupRequest(
          names.rollbackSource,
          profile0003,
          `rollback-0003-${digest}`,
          "rollback_backup_0003"
        );
        await runRollbackBackup(sourcePlan.request);
        return true;
      },
      async apply0004() {
        return databaseManager.applyProfile(names.rollbackSource, profile0004.id);
      },
      createDisposable0003: restoreLifecycle.create,
      reconcileDisposable0003CreateFailure:
        restoreLifecycle.reconcileCreateFailure,
      assertDisposable0003Created: restoreLifecycle.assertCreated,
      async restore0003(proof) {
        exactProof(proof, restoreIdentity);
        const transport = requireBackupTransport(names.rollbackRestore);
        const env = connectionEnvironment("SOCIAL_RESTORE", names.rollbackRestore, sourcePlan.config.label, sourcePlan.config.files.bundle);
        env.SOCIAL_RESTORE_SOURCE_FINGERPRINT = sourcePlan.config.sourceFingerprint;
        restoreConfig = backup.loadRestoreConfig(env, { repositoryRoot: options.repositoryRoot });
        const behavior = restoreVerifiers(
          names.rollbackRestore,
          profile0003.id,
          restoreOwnershipLatch
        );
        const request = Object.freeze(bindProvenanceOperation({
          config: restoreConfig,
          operator: backup.createPostgresBackupOperator(databaseManager.getPools(names.rollbackRestore).provisioner),
          runTool: (plan) => transport.runTool(plan, transport.localBinding),
          verifierTargetFingerprint: restoreConfig.targetFingerprint,
          verifyRuntimeIsolation: behavior.verifyRuntimeIsolation,
          verifyVault: behavior.verifyVault,
          verify2ACompatibility: behavior.verify2ACompatibility,
          async verifyRestoredProfile() {
            const profile = await databaseManager.verifyProfile(
              names.rollbackRestore,
              profile0003.id
            );
            if (profile?.id !== profile0003.id) {
              fail("windows_physical_restore_profile_validation_unconfirmed");
            }
            restored0003ProfileConfirmation = Object.freeze({
              database: names.rollbackRestore,
              profileId: profile0003.id,
              runMarker: binding.runMarker
            });
            return profile;
          },
          closeVerifiers: behavior.closeVerifiers
        }, "restore", "rollback_restore_0003"));
        const result = await runRollbackRestore(request);
        return result.ok === true;
      },
      async verifyRestored0003(proof) {
        exactProof(proof, restoreIdentity);
        if (
          restored0003ProfileConfirmation?.database !== names.rollbackRestore ||
          restored0003ProfileConfirmation?.profileId !== profile0003.id ||
          restored0003ProfileConfirmation?.runMarker !== binding.runMarker
        ) {
          fail("windows_physical_restore_profile_validation_unconfirmed");
        }
        return true;
      },
      removeDisposable0003: restoreLifecycle.remove,
      assertDisposable0003Removed: restoreLifecycle.assertRemoved,
      async reapply0004() {
        return databaseManager.applyProfile(names.rollbackSource, profile0004.id);
      },
      async verify0004Checksum() {
        await databaseManager.verifyProfile(names.rollbackSource, profile0004.id);
        return true;
      },
      async verifyProfile0004() {
        await databaseManager.verifyProfile(names.rollbackSource, profile0004.id);
        const facade = requireRestoreBehaviorFacade(restoreBehavior);
        if (typeof databaseManager.getPools !== "function") {
          fail("windows_physical_profile_schema_pool_invalid");
        }
        const runtimePool = databaseManager.getPools(names.rollbackSource)?.runtime;
        if (!runtimePool) fail("windows_physical_profile_schema_pool_invalid");
        const validation = await facade.verifyRuntimeSchemaForProfile({
          expectedProfileId: profile0004.id,
          pool: runtimePool,
          role: loginBootstrap.RUNTIME_ROLE
        });
        if (validation?.valid !== true) {
          fail("windows_physical_profile_schema_validation_failed");
        }
        return true;
      },
      async verifyNonSocialUnchanged() {
        let primaryFailed = false;
        let primaryFailure;
        let unchanged = false;
        try {
          unchanged = nonSocial === await databaseManager.nonSocialFingerprint(
            names.rollbackSource
          );
        } catch (error) {
          primaryFailed = true;
          primaryFailure = error;
        }
        let cleanupFailed = false;
        let cleanupFailure;
        const recordCleanupFailure = (error) => {
          if (!cleanupFailed) {
            cleanupFailed = true;
            cleanupFailure = error;
          }
        };
        if (sourceProof) {
          const proof = sourceProof;
          try {
            await databaseManager.remove(proof);
          } catch (error) {
            recordCleanupFailure(error);
          }
          try {
            if ((await databaseManager.assertRemoved(proof)) !== true) {
              recordCleanupFailure(new WindowsPhysicalPlanFailure(
                "windows_physical_source_cleanup_unconfirmed"
              ));
            } else {
              sourceProof = undefined;
            }
          } catch (error) {
            recordCleanupFailure(error);
          }
        }
        if (primaryFailed) throw primaryFailure;
        if (!unchanged) return false;
        if (cleanupFailed) throw cleanupFailure;
        return true;
      }
    });
  }

  async function prepareBackupRestore(_state, preparationHooks) {
    if (
      preparationHooks !== undefined && (
        !preparationHooks ||
        Object.getPrototypeOf(preparationHooks) !== Object.prototype ||
        JSON.stringify(Object.keys(preparationHooks).sort()) !==
          JSON.stringify(["installProfile0003RestoreVerification"]) ||
        typeof preparationHooks.installProfile0003RestoreVerification !== "function"
      )
    ) {
      fail("windows_physical_backup_restore_preparation_hooks_invalid");
    }
    ensurePlanDirectories();
    const profile0003 = requireCanonicalSchemaProfile(
      backup.SCHEMA_PROFILES,
      "social-schema-0003"
    );
    const profile0004 = requireCanonicalSchemaProfile(
      backup.SCHEMA_PROFILES,
      "social-schema-0004"
    );
    const verifyProfile0003FixtureRestored = preparationHooks === undefined
      ? undefined
      : preparationHooks.installProfile0003RestoreVerification();
    if (
      verifyProfile0003FixtureRestored !== undefined &&
      typeof verifyProfile0003FixtureRestored !== "function"
    ) {
      fail("windows_physical_restore_profile_verifier_wrapper_invalid");
    }
    const sourceProof = await databaseManager.create(identity(names.backupSource0003, profile0003.id));
    await databaseManager.applyProfile(names.backupSource0003, profile0003.id);
    const plan0003 = backupRequest(
      names.backupSource0003,
      profile0003,
      `profile-0003-${digest}`,
      "gate5_backup_0003"
    );
    const plan0004 = backupRequest(
      LOCAL_DATABASE,
      profile0004,
      `profile-0004-${digest}`,
      "gate5_backup_0004"
    );
    const result = {
      backup0003: plan0003.request,
      restore0003: restoreRequest(
        plan0003,
        names.restore0003,
        profile0003,
        "gate5_restore_0003",
        verifyProfile0003FixtureRestored
      ),
      backup0004: plan0004.request,
      restore0004: restoreRequest(
        plan0004,
        names.restore0004,
        profile0004,
        "gate5_restore_0004"
      ),
      async assertManifestTamperRefused() {
        const tampered = `${plan0003.config.files.bundle}.tampered`;
        let descriptor;
        let rejected = false;
        let primaryFailed = false;
        let primaryFailure;
        let cleanupFailed = false;
        let cleanupFailure;
        const tamperIdentity = identity(names.tamper, profile0003.id);
        const recordCleanupFailure = (error) => {
          if (!cleanupFailed) {
            cleanupFailed = true;
            cleanupFailure = error;
          }
        };
        try {
          fileSystem.copyFileSync(plan0003.config.files.bundle, tampered, fs.constants.COPYFILE_EXCL);
          descriptor = fileSystem.openSync(tampered, "r+");
          const stat = fileSystem.fstatSync(descriptor);
          if (!stat.isFile() || stat.size < 1) {
            fail("windows_physical_tamper_fixture_invalid");
          }
          const byte = Buffer.alloc(1);
          fileSystem.readSync(descriptor, byte, 0, 1, stat.size - 1);
          byte[0] ^= 0xff;
          fileSystem.writeSync(descriptor, byte, 0, 1, stat.size - 1);
          fileSystem.fsyncSync(descriptor);
          byte.fill(0);
          fileSystem.closeSync(descriptor);
          descriptor = undefined;

          const request = restoreRequest(plan0003, names.tamper, profile0003);
          const env = connectionEnvironment("SOCIAL_RESTORE", names.tamper, plan0003.config.label, tampered);
          env.SOCIAL_RESTORE_SOURCE_FINGERPRINT = plan0003.config.sourceFingerprint;
          const tamperedConfig = backup.loadRestoreConfig(env, {
            repositoryRoot: options.repositoryRoot
          });
          try {
            await runProfileRestoreImpl({ ...request, config: tamperedConfig });
          } catch (error) {
            if (error?.code !== "restore_encrypted_bundle_invalid") throw error;
            rejected = true;
          }
        } catch (error) {
          primaryFailed = true;
          primaryFailure = error;
        }
        if (descriptor !== undefined) {
          try {
            fileSystem.closeSync(descriptor);
          } catch (error) {
            recordCleanupFailure(error);
          }
        }
        try {
          fileSystem.unlinkSync(tampered);
        } catch (error) {
          if (error?.code !== "ENOENT") recordCleanupFailure(error);
        }
        try {
          const reconciliation = await databaseManager.reconcile(tamperIdentity);
          if (reconciliation.status !== "absent") {
            fail("windows_physical_tamper_cleanup_unconfirmed");
          }
        } catch (error) {
          recordCleanupFailure(error);
        }
        if (primaryFailed) throw primaryFailure;
        if (!rejected) return false;
        if (cleanupFailed) throw cleanupFailure;
        return true;
      },
      async assertCrossProfileRefused() {
        const request = restoreRequest(plan0003, names.cross, profile0004);
        let rejected = false;
        let primaryFailed = false;
        let primaryFailure;
        let reconciliationFailed = false;
        let reconciliationFailure;
        try {
          await runProfileRestoreImpl(request);
        } catch (error) {
          if (error?.code === "local_backup_restore_cross_profile_refused") {
            rejected = true;
          } else {
            primaryFailed = true;
            primaryFailure = error;
          }
        }
        try {
          const reconciliation = await databaseManager.reconcile(
            identity(names.cross, profile0004.id)
          );
          if (reconciliation.status !== "absent") {
            fail("windows_physical_cross_profile_cleanup_unconfirmed");
          }
        } catch (error) {
          reconciliationFailed = true;
          reconciliationFailure = error;
        }
        if (primaryFailed) throw primaryFailure;
        if (!rejected) return false;
        if (reconciliationFailed) throw reconciliationFailure;
        return true;
      },
      async cleanup() {
        if ((await databaseManager.assertCreated(sourceProof)) === true) {
          await databaseManager.remove(sourceProof);
          if ((await databaseManager.assertRemoved(sourceProof)) !== true) {
            fail("windows_physical_source_cleanup_unconfirmed");
          }
        }
      }
    };
    createdPlans.add(result);
    return Object.freeze(result);
  }

  return Object.freeze({
    runMarker: binding.runMarker,
    createRollbackAdapter,
    prepareBackupRestore,
    async destroy() {
      try {
        await databaseManager.cleanupAll();
      } finally {
        bundleKey.fill(0);
        createdPlans.clear();
      }
    }
  });
}

module.exports = {
  ADMIN_LOGIN,
  BACKUP_CONNECTIVITY_MODE,
  BACKUP_LOGICAL_HOST,
  BACKUP_LOGICAL_PORT,
  BACKUP_PHYSICAL_MODE,
  CURRENT_SOCIAL_REPOSITORY_METHODS,
  LEGACY_SOCIAL_REPOSITORY_METHODS,
  LOCAL_DATABASE,
  LOOPBACK_HOST,
  MIGRATION_LOGIN,
  PROVISIONER_LOGIN,
  RUNTIME_LOGIN,
  WindowsPhysicalPlanFailure,
  assertLocalToolPlan,
  assertRunBinding,
  createDefaultRestoreBehaviorFacade,
  createLocalPgToolRunner,
  createProfile0003SocialRepositoryBridge,
  createProfileAwareSocialRepositoryFactory,
  createWindowsPhysicalPlans,
  requireCanonicalSchemaProfile
};
