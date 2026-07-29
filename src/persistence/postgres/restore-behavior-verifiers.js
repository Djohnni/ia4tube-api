"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { Pool } = require("pg");
const {
  GLOBAL_VAULT_BACKFILL_POLICY
} = require("./migrations");
const {
  POLICY_PREFIX,
  targetFingerprint
} = require("./backup-restore");
const RAW_LEGACY_2A_SOURCE_MANIFEST = require(
  "./legacy-2a-source-manifest.json"
);
const {
  withTransaction,
  verifyRuntimeRole
} = require("./pool");
const {
  verifyRuntimeSchema
} = require("./runtime-validation");
const {
  createCompanyScopedRepository
} = require("./company-scoped-repository");
const {
  createSocialRepository
} = require("./social-repository");
const {
  CREDENTIAL_INVENTORY_POLICY,
  createVaultKeyRegistryAdmin
} = require("./vault-key-registry-admin");
const {
  createSocialCredentialService
} = require("../../social/credential-service");
const {
  createSocialVault
} = require("../../social/vault");
const {
  deriveVaultKeyVersion,
  vaultKeyringFingerprint
} = require("../../social/vault-key-version");
const {
  createVaultKeyRotationService
} = require("../../social/vault-key-rotation-service");

const OWNER_ROLE = "ia4tube_social_owner";
const RUNTIME_ROLE = "ia4tube_social_runtime";
const IDENTITY_DERIVATION_VERSION = "v1";
const SSL_MODE = "verify-full";
const LEGACY_2A_COMMIT =
  "9deb1e04249026a7046d44d6cbf4e2da87b9a0a4";
const LEGACY_MANIFEST_KIND =
  "ia4tube-social-legacy-2a-source-manifest";
const LEGACY_SOURCE_PATH = /^[a-z0-9][a-z0-9._/-]{0,199}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const MAX_LEGACY_SOURCE_BYTES = 16 * 1024 * 1024;
const LEGACY_2A_SOURCE_MANIFEST = Object.freeze({
  format: RAW_LEGACY_2A_SOURCE_MANIFEST.format,
  kind: RAW_LEGACY_2A_SOURCE_MANIFEST.kind,
  commit: RAW_LEGACY_2A_SOURCE_MANIFEST.commit,
  scopes: Object.freeze([
    ...RAW_LEGACY_2A_SOURCE_MANIFEST.scopes
  ]),
  files: Object.freeze({
    ...RAW_LEGACY_2A_SOURCE_MANIFEST.files
  })
});
const LEGACY_2A_MODULES = Object.freeze({
  pool: "./src/persistence/postgres/pool",
  runtimeValidation:
    "./src/persistence/postgres/runtime-validation",
  companyRepository:
    "./src/persistence/postgres/company-scoped-repository",
  socialRepository:
    "./src/persistence/postgres/social-repository",
  credentialService: "./src/social/credential-service",
  vault: "./src/social/vault"
});

const DEFAULT_DEPENDENCIES = Object.freeze({
  PoolClass: Pool,
  createCompanyScopedRepository,
  createSocialCredentialService,
  createSocialRepository,
  createSocialVault,
  createVaultKeyRegistryAdmin,
  createVaultKeyRotationService,
  deriveVaultKeyVersion,
  verifyRuntimeRole,
  verifyRuntimeSchema,
  vaultKeyringFingerprint,
  withTransaction
});

class RestoreBehaviorVerifierError extends Error {
  constructor(code) {
    super(code);
    this.name = "RestoreBehaviorVerifierError";
    this.code = code;
  }
}

function fail(code) {
  throw new RestoreBehaviorVerifierError(code);
}

function ensure(value, code) {
  if (!value) fail(code);
}

function requireText(value, code) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length === 0
  ) {
    fail(code);
  }
  return value;
}

function targetIdentity(parsed) {
  let database;
  let login;
  try {
    database = decodeURIComponent(parsed.pathname.slice(1));
    login = decodeURIComponent(parsed.username);
  } catch {
    fail("restore_behavior_target_invalid");
  }
  return Object.freeze({
    database,
    host: parsed.hostname.toLowerCase(),
    login,
    port: parsed.port || "5432"
  });
}

function inspectTarget(raw, expectedLogin, code) {
  const expected = requireText(expectedLogin, code);
  let parsed;
  try {
    parsed = new URL(raw instanceof URL ? raw.toString() : String(raw));
  } catch {
    fail(code);
  }
  const keys = [...new Set(parsed.searchParams.keys())];
  const modes = parsed.searchParams.getAll("sslmode");
  const identity = targetIdentity(parsed);
  ensure(
    ["postgres:", "postgresql:"].includes(parsed.protocol) &&
      Boolean(parsed.hostname) &&
      parsed.pathname !== "/" &&
      Boolean(parsed.username) &&
      Boolean(parsed.password) &&
      keys.length === 1 &&
      keys[0] === "sslmode" &&
      modes.length === 1 &&
      String(modes[0]).toLowerCase() === SSL_MODE &&
      identity.login === expected,
    code
  );

  const connection = new URL(parsed.toString());
  for (const key of [...connection.searchParams.keys()]) {
    connection.searchParams.delete(key);
  }
  return Object.freeze({
    ...identity,
    connectionString: connection.toString()
  });
}

function inspectSeparatedTargets(options = {}) {
  const migration = inspectTarget(
    options.migrationDatabaseUrl,
    options.expectedMigrationLogin,
    "restore_behavior_migration_target_refused"
  );
  const runtime = inspectTarget(
    options.runtimeDatabaseUrl,
    options.expectedRuntimeLogin,
    "restore_behavior_runtime_target_refused"
  );
  ensure(
    migration.host === runtime.host &&
      migration.port === runtime.port &&
      migration.database === runtime.database &&
      migration.login !== runtime.login,
    "restore_behavior_principal_separation_refused"
  );
  return Object.freeze({ migration, runtime });
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireLegacyRelativePath(value) {
  if (
    typeof value !== "string" ||
    !LEGACY_SOURCE_PATH.test(value) ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail("restore_behavior_2a_manifest_invalid");
  }
  return value;
}

function sameStableFile(left, right) {
  return Boolean(
    left &&
      right &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ctimeMs === right.ctimeMs
  );
}

function hashLegacyRegularFile(root, relative, fileSystem = fs) {
  const file = path.join(root, ...relative.split("/"));
  let before;
  let descriptor;
  let bytes;
  let canonicalBytes;
  try {
    before = fileSystem.lstatSync(file);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !Number.isSafeInteger(before.size) ||
      before.size < 1 ||
      before.size > MAX_LEGACY_SOURCE_BYTES
    ) {
      fail("restore_behavior_2a_source_invalid");
    }
    descriptor = fileSystem.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const opened = fileSystem.fstatSync(descriptor);
    if (!opened.isFile() || !sameStableFile(before, opened)) {
      fail("restore_behavior_2a_source_changed");
    }
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fileSystem.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset
      );
      if (read === 0) fail("restore_behavior_2a_source_changed");
      offset += read;
    }
    const after = fileSystem.fstatSync(descriptor);
    if (!sameStableFile(opened, after)) {
      fail("restore_behavior_2a_source_changed");
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("restore_behavior_2a_source_invalid");
    }
    canonicalBytes = Buffer.from(text.replace(/\r\n/g, "\n"), "utf8");
    return crypto
      .createHash("sha256")
      .update(canonicalBytes)
      .digest("hex");
  } catch (error) {
    if (error instanceof RestoreBehaviorVerifierError) throw error;
    fail("restore_behavior_2a_source_invalid");
  } finally {
    bytes?.fill(0);
    canonicalBytes?.fill(0);
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        fail("restore_behavior_2a_source_cleanup_failed");
      }
    }
  }
}

function collectLegacyScopeFiles(
  root,
  scope,
  output,
  fileSystem = fs
) {
  const directory = path.join(root, ...scope.split("/"));
  let stat;
  let entries;
  try {
    stat = fileSystem.lstatSync(directory);
    entries = fileSystem.readdirSync(directory, {
      withFileTypes: true
    });
  } catch {
    fail("restore_behavior_2a_source_invalid");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("restore_behavior_2a_source_invalid");
  }
  for (const entry of entries) {
    const relative = requireLegacyRelativePath(
      `${scope}/${entry.name}`
    );
    const target = path.join(root, ...relative.split("/"));
    let targetStat;
    try {
      targetStat = fileSystem.lstatSync(target);
    } catch {
      fail("restore_behavior_2a_source_invalid");
    }
    if (targetStat.isSymbolicLink()) {
      fail("restore_behavior_2a_source_invalid");
    }
    if (targetStat.isDirectory()) {
      collectLegacyScopeFiles(root, relative, output, fileSystem);
    } else if (targetStat.isFile()) {
      output.push(relative);
    } else {
      fail("restore_behavior_2a_source_invalid");
    }
  }
}

function verifyLegacy2ASourceManifest(
  legacy2ARoot,
  manifest = LEGACY_2A_SOURCE_MANIFEST,
  fileSystem = fs
) {
  const root = path.resolve(
    requireText(legacy2ARoot, "restore_behavior_2a_root_missing")
  );
  let rootStat;
  let realRoot;
  try {
    rootStat = fileSystem.lstatSync(root);
    realRoot = path.resolve(fileSystem.realpathSync(root));
  } catch {
    fail("restore_behavior_2a_root_invalid");
  }
  const comparableRoot =
    process.platform === "win32" ? root.toLowerCase() : root;
  const comparableReal =
    process.platform === "win32" ? realRoot.toLowerCase() : realRoot;
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    comparableRoot !== comparableReal ||
    !manifest ||
    Array.isArray(manifest) ||
    manifest.format !== 1 ||
    manifest.kind !== LEGACY_MANIFEST_KIND ||
    !GIT_COMMIT.test(String(manifest.commit || "")) ||
    Object.keys(manifest).sort().join("\u0000") !==
      ["commit", "files", "format", "kind", "scopes"].join("\u0000") ||
    !Array.isArray(manifest.scopes) ||
    manifest.scopes.length < 1 ||
    !manifest.files ||
    Array.isArray(manifest.files) ||
    typeof manifest.files !== "object"
  ) {
    fail("restore_behavior_2a_manifest_invalid");
  }
  const scopes = manifest.scopes.map(requireLegacyRelativePath);
  if (new Set(scopes).size !== scopes.length) {
    fail("restore_behavior_2a_manifest_invalid");
  }
  const manifestFiles = Object.freeze({ ...manifest.files });
  const expectedFiles = Object.keys(manifestFiles)
    .map(requireLegacyRelativePath)
    .sort();
  if (
    expectedFiles.length < 1 ||
    expectedFiles.some(
      (relative) => !SHA256.test(String(manifestFiles[relative] || ""))
    )
  ) {
    fail("restore_behavior_2a_manifest_invalid");
  }
  const scopedFiles = [];
  for (const scope of scopes) {
    collectLegacyScopeFiles(root, scope, scopedFiles, fileSystem);
  }
  const rootManifestFiles = expectedFiles.filter(
    (relative) =>
      !scopes.some(
        (scope) => relative === scope || relative.startsWith(`${scope}/`)
      )
  );
  const actualFiles = [...scopedFiles, ...rootManifestFiles].sort();
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((relative, index) => relative !== expectedFiles[index])
  ) {
    fail("restore_behavior_2a_source_tree_mismatch");
  }
  for (const relative of expectedFiles) {
    const actual = hashLegacyRegularFile(root, relative, fileSystem);
    const expected = manifestFiles[relative];
    if (
      !crypto.timingSafeEqual(
        Buffer.from(actual, "hex"),
        Buffer.from(expected, "hex")
      )
    ) {
      fail("restore_behavior_2a_source_hash_mismatch");
    }
  }
  return Object.freeze({
    commit: String(manifest.commit),
    files: expectedFiles.length,
    manifestSha256: crypto
      .createHash("sha256")
      .update(canonicalJson({
        commit: String(manifest.commit),
        files: manifestFiles,
        format: 1,
        kind: LEGACY_MANIFEST_KIND,
        scopes
      }))
      .digest("hex")
  });
}

function loadLegacy2ADependencies(
  legacy2ARoot,
  createRequireFunction = createRequire
) {
  const root = path.resolve(
    requireText(legacy2ARoot, "restore_behavior_2a_root_missing")
  );
  const provenanceBefore = verifyLegacy2ASourceManifest(root);
  ensure(
    provenanceBefore.commit === LEGACY_2A_COMMIT,
    "restore_behavior_2a_commit_mismatch"
  );
  const require2A = createRequireFunction(path.join(root, "package.json"));
  if (typeof require2A !== "function") {
    fail("restore_behavior_2a_loader_invalid");
  }
  const pool = require2A(LEGACY_2A_MODULES.pool);
  const runtimeValidation = require2A(
    LEGACY_2A_MODULES.runtimeValidation
  );
  const companyRepository = require2A(
    LEGACY_2A_MODULES.companyRepository
  );
  const socialRepository = require2A(
    LEGACY_2A_MODULES.socialRepository
  );
  const credentialService = require2A(
    LEGACY_2A_MODULES.credentialService
  );
  const vault = require2A(LEGACY_2A_MODULES.vault);
  const legacy = Object.freeze({
    createCompanyScopedRepository:
      companyRepository.createCompanyScopedRepository,
    createSocialCredentialService:
      credentialService.createSocialCredentialService,
    createSocialRepository:
      socialRepository.createSocialRepository,
    createSocialVault: vault.createSocialVault,
    verifyRuntimeRole: pool.verifyRuntimeRole,
    verifyRuntimeSchema: runtimeValidation.verifyRuntimeSchema
  });
  for (const [name, operation] of Object.entries(legacy)) {
    if (typeof operation !== "function") {
      fail(`restore_behavior_2a_${name}_missing`);
    }
  }
  const provenanceAfter = verifyLegacy2ASourceManifest(root);
  ensure(
    provenanceAfter.commit === LEGACY_2A_COMMIT &&
      provenanceAfter.files === provenanceBefore.files &&
      provenanceAfter.manifestSha256 ===
        provenanceBefore.manifestSha256,
    "restore_behavior_2a_source_changed"
  );
  return legacy;
}

function poolConfiguration(target, applicationName, maximum) {
  return Object.freeze({
    connectionString: target.connectionString,
    ssl: Object.freeze({
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      servername: target.host
    }),
    application_name: applicationName,
    max: maximum,
    min: 0,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
    query_timeout: 30000,
    options: [
      "-c statement_timeout=25000",
      "-c lock_timeout=5000",
      "-c idle_in_transaction_session_timeout=5000",
      "-c search_path=pg_catalog"
    ].join(" "),
    allowExitOnIdle: false
  });
}

function fixedDigest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function bufferEquals(left, right) {
  return (
    Buffer.isBuffer(left) &&
    Buffer.isBuffer(right) &&
    left.length === right.length &&
    crypto.timingSafeEqual(left, right)
  );
}

function wipeEnvelope(envelope) {
  envelope?.ciphertext?.fill?.(0);
  envelope?.nonce?.fill?.(0);
  envelope?.authTag?.fill?.(0);
  envelope?.auth_tag?.fill?.(0);
}

async function expectAsyncCode(operation, code) {
  try {
    await operation();
  } catch (error) {
    ensure(
      error?.code === code,
      "restore_behavior_expected_refusal_mismatch"
    );
    return;
  }
  fail("restore_behavior_expected_refusal_missing");
}

function expectSyncCode(operation, code) {
  try {
    operation();
  } catch (error) {
    ensure(
      error?.code === code,
      "restore_behavior_expected_refusal_mismatch"
    );
    return;
  }
  fail("restore_behavior_expected_refusal_missing");
}

function requireDependencies(overrides = {}) {
  const dependencies = Object.freeze({
    ...DEFAULT_DEPENDENCIES,
    ...overrides
  });
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (typeof dependency !== "function") {
      fail(`restore_behavior_${name}_invalid`);
    }
  }
  return dependencies;
}

function requireLegacyDependencies(candidate) {
  if (!candidate || typeof candidate !== "object") {
    fail("restore_behavior_2a_dependencies_invalid");
  }
  const dependencies = Object.freeze({ ...candidate });
  for (const name of [
    "createCompanyScopedRepository",
    "createSocialCredentialService",
    "createSocialRepository",
    "createSocialVault",
    "verifyRuntimeRole",
    "verifyRuntimeSchema"
  ]) {
    if (typeof dependencies[name] !== "function") {
      fail(`restore_behavior_2a_${name}_missing`);
    }
  }
  return dependencies;
}

function createRestoreBehaviorVerifiers(options = {}) {
  const dependencies = requireDependencies(options.dependencies);
  const legacy = requireLegacyDependencies(
    options.legacyDependencies ||
      loadLegacy2ADependencies(
        options.legacy2ARoot,
        options.createRequireFunction
      )
  );
  const targets = inspectSeparatedTargets(options);
  const verifierTargetFingerprint = targetFingerprint({
    host: targets.runtime.host,
    port: targets.runtime.port,
    database: targets.runtime.database
  });
  const randomBytes =
    options.randomBytes === undefined
      ? crypto.randomBytes
      : options.randomBytes;
  const randomUuid =
    options.randomUuid === undefined
      ? crypto.randomUUID
      : options.randomUuid;
  const randomInt =
    options.randomInt === undefined
      ? crypto.randomInt
      : options.randomInt;
  for (const [name, operation] of Object.entries({
    randomBytes,
    randomUuid,
    randomInt
  })) {
    if (typeof operation !== "function") {
      fail(`restore_behavior_${name}_invalid`);
    }
  }

  const migrationPool = new dependencies.PoolClass(
    poolConfiguration(
      targets.migration,
      "ia4tube-restore-behavior-migration",
      1
    )
  );
  const runtimePool = new dependencies.PoolClass(
    poolConfiguration(
      targets.runtime,
      "ia4tube-restore-behavior-runtime",
      2
    )
  );
  const state = {
    closed: false,
    fixtures: null,
    keyV2: null,
    plaintextA: null,
    repository: null,
    vaultVerified: false,
    versionV2: null
  };

  function assertOpen() {
    if (state.closed) fail("restore_behavior_verifier_closed");
  }

  function createFixture() {
    return Object.freeze({
      companyId: randomUuid(),
      userId: randomUuid(),
      connectionId: randomUuid(),
      credentialId: randomUuid()
    });
  }

  async function seedCore(fixture) {
    await dependencies.withTransaction(
      migrationPool,
      async (client) => {
        await client.query(
          [
            "INSERT INTO ia4tube_social.companies (",
            "  id, name, identity_derivation_version",
            ") VALUES ($1, 'Synthetic Restore Gate', $2)"
          ].join("\n"),
          [fixture.companyId, IDENTITY_DERIVATION_VERSION]
        );
        await client.query(
          [
            "INSERT INTO ia4tube_social.users (",
            "  company_id, id, login_key_digest",
            ") VALUES ($1, $2, $3)"
          ].join("\n"),
          [
            fixture.companyId,
            fixture.userId,
            fixedDigest(
              Buffer.from(`synthetic:${fixture.userId}`, "utf8")
            )
          ]
        );
        await client.query(
          [
            "INSERT INTO ia4tube_social.company_memberships (",
            "  company_id, user_id, role",
            ") VALUES ($1, $2, 'owner')"
          ].join("\n"),
          [fixture.companyId, fixture.userId]
        );
      },
      { role: OWNER_ROLE, companyId: fixture.companyId }
    );
  }

  async function activateConnection(repository, fixture) {
    await repository.createConnection({
      companyId: fixture.companyId,
      id: fixture.connectionId,
      provider: "instagram",
      createdByUserId: fixture.userId
    });
    const result = await dependencies.withTransaction(
      runtimePool,
      (client) =>
        client.query(
          [
            "UPDATE ia4tube_social.social_connections",
            "SET status = 'active', connected_at = CURRENT_TIMESTAMP",
            "WHERE company_id = $1 AND id = $2",
            "RETURNING id"
          ].join("\n"),
          [fixture.companyId, fixture.connectionId]
        ),
      { role: RUNTIME_ROLE, companyId: fixture.companyId }
    );
    ensure(
      result.rowCount === 1,
      "restore_behavior_connection_activation_failed"
    );
  }

  async function verifyRuntimeIsolation() {
    assertOpen();
    ensure(
      state.fixtures === null,
      "restore_behavior_runtime_gate_repeated"
    );
    await dependencies.verifyRuntimeRole(runtimePool, RUNTIME_ROLE);
    await dependencies.verifyRuntimeSchema(runtimePool, RUNTIME_ROLE);

    const companyA = createFixture();
    const companyB = createFixture();
    await seedCore(companyA);
    await seedCore(companyB);
    const repository = dependencies.createSocialRepository({
      pool: runtimePool,
      runtimeRole: RUNTIME_ROLE,
      identityDerivationVersion: IDENTITY_DERIVATION_VERSION
    });
    await activateConnection(repository, companyA);
    await activateConnection(repository, companyB);

    const own = await repository.findConnection({
      companyId: companyA.companyId,
      connectionId: companyA.connectionId
    });
    const cross = await repository.findConnection({
      companyId: companyA.companyId,
      connectionId: companyB.connectionId
    });
    ensure(
      own?.id === companyA.connectionId && cross === null,
      "restore_behavior_runtime_repository_isolation_failed"
    );

    const scoped = await dependencies.withTransaction(
      runtimePool,
      (client) =>
        client.query(
          [
            "SELECT id::text",
            "FROM ia4tube_social.companies",
            "WHERE id = ANY($1::uuid[])",
            "ORDER BY id"
          ].join("\n"),
          [[companyA.companyId, companyB.companyId]]
        ),
      { role: RUNTIME_ROLE, companyId: companyA.companyId }
    );
    ensure(
      scoped.rowCount === 1 &&
        scoped.rows?.[0]?.id === companyA.companyId,
      "restore_behavior_runtime_rls_select_failed"
    );

    const unscoped = await dependencies.withTransaction(
      runtimePool,
      (client) =>
        client.query(
          [
            "SELECT COUNT(*)::integer AS visible",
            "FROM ia4tube_social.companies",
            "WHERE id = ANY($1::uuid[])"
          ].join("\n"),
          [[companyA.companyId, companyB.companyId]]
        ),
      { role: RUNTIME_ROLE }
    );
    ensure(
      Number(unscoped.rows?.[0]?.visible) === 0,
      "restore_behavior_runtime_context_leaked"
    );

    await expectAsyncCode(
      () =>
        dependencies.withTransaction(
          runtimePool,
          (client) =>
            client.query(
              [
                "INSERT INTO ia4tube_social.social_connections (",
                "  company_id, id, provider, created_by_user_id",
                ") VALUES ($1, $2, 'instagram', $3)"
              ].join("\n"),
              [
                companyA.companyId,
                randomUuid(),
                companyA.userId
              ]
            ),
          { role: RUNTIME_ROLE, companyId: companyB.companyId }
        ),
      "42501"
    );

    const concurrent = await Promise.all(
      [
        [companyA, companyB],
        [companyB, companyA]
      ].map(([current, foreign]) =>
        dependencies.withTransaction(
          runtimePool,
          (client) =>
            client.query(
              [
                "SELECT pg_backend_pid() AS backend_pid,",
                "  current_setting('ia4tube.company_id', true) AS scope,",
                "  EXISTS (",
                "    SELECT 1 FROM ia4tube_social.companies WHERE id = $1",
                "  ) AS own_visible,",
                "  EXISTS (",
                "    SELECT 1 FROM ia4tube_social.companies WHERE id = $2",
                "  ) AS foreign_visible,",
                "  pg_sleep(0.05)"
              ].join("\n"),
              [current.companyId, foreign.companyId]
            ),
          { role: RUNTIME_ROLE, companyId: current.companyId }
        )
      )
    );
    ensure(
      concurrent[0].rows?.[0]?.backend_pid !==
        concurrent[1].rows?.[0]?.backend_pid &&
        concurrent[0].rows?.[0]?.scope === companyA.companyId &&
        concurrent[1].rows?.[0]?.scope === companyB.companyId &&
        concurrent.every(
          (result) =>
            result.rows?.[0]?.own_visible === true &&
            result.rows?.[0]?.foreign_visible === false
      ),
      "restore_behavior_runtime_concurrent_scope_failed"
    );
    const afterConcurrent = await dependencies.withTransaction(
      runtimePool,
      (client) =>
        client.query(
          [
            "SELECT COUNT(*)::integer AS visible",
            "FROM ia4tube_social.companies",
            "WHERE id = ANY($1::uuid[])"
          ].join("\n"),
          [[companyA.companyId, companyB.companyId]]
        ),
      { role: RUNTIME_ROLE }
    );
    ensure(
      Number(afterConcurrent.rows?.[0]?.visible) === 0,
      "restore_behavior_runtime_concurrent_context_leaked"
    );

    state.fixtures = Object.freeze({ companyA, companyB });
    state.repository = repository;
    return true;
  }

  async function verifyVault() {
    assertOpen();
    ensure(
      state.fixtures && state.repository && !state.vaultVerified,
      "restore_behavior_runtime_gate_required"
    );
    const { companyA, companyB } = state.fixtures;
    const keyV1 = randomBytes(32);
    const keyV2 = randomBytes(32);
    ensure(
      Buffer.isBuffer(keyV1) &&
        keyV1.length === 32 &&
        Buffer.isBuffer(keyV2) &&
        keyV2.length === 32,
      "restore_behavior_random_key_invalid"
    );
    const baseGeneration =
      1000000000 + randomInt(1000000000);
    const versionV1 = dependencies.deriveVaultKeyVersion(
      baseGeneration,
      keyV1
    );
    const versionV2 = dependencies.deriveVaultKeyVersion(
      baseGeneration + 1,
      keyV2
    );
    const plaintextA = randomBytes(48);
    const plaintextB = randomBytes(48);
    ensure(
      Buffer.isBuffer(plaintextA) &&
        plaintextA.length === 48 &&
        Buffer.isBuffer(plaintextB) &&
        plaintextB.length === 48,
      "restore_behavior_random_plaintext_invalid"
    );
    let vaultV1;
    let vaultV2;
    let raw;
    let envelope;
    try {
      const registry = dependencies.createVaultKeyRegistryAdmin({
        pool: migrationPool,
        ownerRole: OWNER_ROLE
      });
      await registry.register({ keyVersion: versionV1 });
      await registry.register({ keyVersion: versionV2 });
      const readable = [versionV1, versionV2];
      vaultV1 = dependencies.createSocialVault({
        keyring: {
          activeVersion: versionV1,
          keys: new Map([
            [versionV1, keyV1],
            [versionV2, keyV2]
          ])
        },
        expectedKeyringFingerprint:
          dependencies.vaultKeyringFingerprint(versionV1, readable)
      });
      vaultV2 = dependencies.createSocialVault({
        keyring: {
          activeVersion: versionV2,
          keys: new Map([
            [versionV1, keyV1],
            [versionV2, keyV2]
          ])
        },
        expectedKeyringFingerprint:
          dependencies.vaultKeyringFingerprint(versionV2, readable)
      });
      const credentialsV1 =
        dependencies.createSocialCredentialService({
          repository: state.repository,
          vault: vaultV1
        });
      const credentialsV2 =
        dependencies.createSocialCredentialService({
          repository: state.repository,
          vault: vaultV2
        });

      await credentialsV1.store({
        companyId: companyA.companyId,
        provider: "instagram",
        credentialId: companyA.credentialId,
        credentialType: "access_token",
        connectionId: companyA.connectionId,
        plaintext: plaintextA
      });
      await credentialsV1.store({
        companyId: companyB.companyId,
        provider: "instagram",
        credentialId: companyB.credentialId,
        credentialType: "refresh_token",
        connectionId: companyB.connectionId,
        plaintext: plaintextB
      });
      ensure(
        await credentialsV1.withDecryptedCredential(
          {
            companyId: companyA.companyId,
            credentialId: companyA.credentialId
          },
          (value) => bufferEquals(value, plaintextA)
        ),
        "restore_behavior_vault_plaintext_mismatch"
      );
      await expectAsyncCode(
        () =>
          credentialsV1.withDecryptedCredential(
            {
              companyId: companyA.companyId,
              credentialId: companyB.credentialId
            },
            () => true
          ),
        "credential_not_found"
      );

      raw = await state.repository.findEncryptedCredential({
        companyId: companyA.companyId,
        credentialId: companyA.credentialId
      });
      ensure(
        raw &&
          !raw.ciphertext.includes(plaintextA) &&
          raw.key_version === versionV1,
        "restore_behavior_vault_storage_not_encrypted"
      );
      envelope = {
        ciphertext: Buffer.from(raw.ciphertext),
        nonce: Buffer.from(raw.nonce),
        authTag: Buffer.from(raw.auth_tag),
        keyVersion: raw.key_version,
        aadVersion: raw.aad_version
      };
      const context = Object.freeze({
        companyId: companyA.companyId,
        provider: "instagram",
        credentialId: companyA.credentialId,
        credentialType: "access_token",
        subjectType: "connection",
        subjectId: companyA.connectionId
      });
      for (const field of ["ciphertext", "nonce", "authTag"]) {
        const altered = {
          ciphertext: Buffer.from(envelope.ciphertext),
          nonce: Buffer.from(envelope.nonce),
          authTag: Buffer.from(envelope.authTag),
          keyVersion: envelope.keyVersion,
          aadVersion: envelope.aadVersion
        };
        altered[field][0] ^= 1;
        try {
          expectSyncCode(
            () => vaultV1.decrypt(altered, context),
            "vault_authentication_failed"
          );
        } finally {
          wipeEnvelope(altered);
        }
      }
      expectSyncCode(
        () =>
          vaultV1.decrypt(envelope, {
            ...context,
            companyId: companyB.companyId
          }),
        "vault_authentication_failed"
      );

      const rotation = dependencies.createVaultKeyRotationService({
        credentialService: credentialsV2,
        keyRegistryAdmin: registry,
        vault: vaultV2,
        backoff: async () => undefined
      });
      const previous = await registry.currentAuthority();
      const first = await rotation.rotateTenant({
        companyId: companyA.companyId,
        credentialIds: [companyA.credentialId],
        keyVersion: versionV2,
        expectedActiveKeyVersion:
          previous?.activeKeyVersion ?? null
      });
      ensure(
        first.changed === 1 &&
          first.credentials === 1 &&
          first.results?.[0]?.keyVersion === versionV2,
        "restore_behavior_vault_rotation_failed"
      );
      const repeated = await rotation.rotateTenant({
        companyId: companyA.companyId,
        credentialIds: [companyA.credentialId],
        keyVersion: versionV2,
        expectedActiveKeyVersion: versionV2
      });
      ensure(
        repeated.changed === 0 && repeated.alreadyCurrent === 1,
        "restore_behavior_vault_rotation_not_idempotent"
      );
      await expectAsyncCode(
        () => rotation.retire({ keyVersion: versionV2 }),
        "vault_active_key_retirement_refused"
      );
      await expectAsyncCode(
        () => rotation.retire({ keyVersion: versionV1 }),
        "vault_key_version_in_use"
      );
      const second = await rotation.rotateTenant({
        companyId: companyB.companyId,
        credentialIds: [companyB.credentialId],
        keyVersion: versionV2,
        expectedActiveKeyVersion: versionV2
      });
      ensure(
        second.changed === 1,
        "restore_behavior_vault_second_tenant_rotation_failed"
      );
      const retired = await rotation.retire({
        keyVersion: versionV1
      });
      ensure(
        retired.retired === true,
        "restore_behavior_vault_retirement_failed"
      );
      ensure(
        await credentialsV2.withDecryptedCredential(
          {
            companyId: companyA.companyId,
            credentialId: companyA.credentialId
          },
          (value) => bufferEquals(value, plaintextA)
        ),
        "restore_behavior_vault_rotated_plaintext_mismatch"
      );

      state.keyV2 = keyV2;
      state.versionV2 = versionV2;
      state.plaintextA = plaintextA;
      state.vaultVerified = true;
      return true;
    } finally {
      vaultV1?.destroy();
      vaultV2?.destroy();
      keyV1.fill(0);
      plaintextB.fill(0);
      wipeEnvelope(raw);
      wipeEnvelope(envelope);
      if (!state.vaultVerified) {
        keyV2.fill(0);
        plaintextA.fill(0);
      }
    }
  }

  async function verify2ACompatibility() {
    assertOpen();
    ensure(
      state.vaultVerified &&
        state.keyV2 &&
        state.versionV2 &&
        state.plaintextA,
      "restore_behavior_vault_gate_required"
    );
    const { companyA, companyB } = state.fixtures;
    const extraCredentialId = randomUuid();
    const extraPlaintext = randomBytes(48);
    ensure(
      Buffer.isBuffer(extraPlaintext) &&
        extraPlaintext.length === 48,
      "restore_behavior_random_plaintext_invalid"
    );
    let legacyVault;
    let currentVault;
    try {
      await legacy.verifyRuntimeRole(runtimePool, RUNTIME_ROLE);
      await legacy.verifyRuntimeSchema(runtimePool, RUNTIME_ROLE);
      const companies = legacy.createCompanyScopedRepository({
        pool: runtimePool,
        runtimeRole: RUNTIME_ROLE,
        identityDerivationVersion: IDENTITY_DERIVATION_VERSION
      });
      const repository = legacy.createSocialRepository({
        pool: runtimePool,
        runtimeRole: RUNTIME_ROLE,
        identityDerivationVersion: IDENTITY_DERIVATION_VERSION
      });
      const company = await companies.findCompanyById(
        companyA.companyId
      );
      const membership = await companies.findMembership({
        companyId: companyA.companyId,
        userId: companyA.userId
      });
      const own = await repository.findConnection({
        companyId: companyA.companyId,
        connectionId: companyA.connectionId
      });
      const cross = await repository.findConnection({
        companyId: companyA.companyId,
        connectionId: companyB.connectionId
      });
      ensure(
        company?.id === companyA.companyId &&
          membership?.user_id === companyA.userId &&
          own?.id === companyA.connectionId &&
          cross === null,
        "restore_behavior_2a_repository_contract_failed"
      );

      legacyVault = legacy.createSocialVault({
        keyring: {
          activeVersion: state.versionV2,
          keys: new Map([[state.versionV2, state.keyV2]])
        }
      });
      const legacyCredentials =
        legacy.createSocialCredentialService({
          repository,
          vault: legacyVault
        });
      ensure(
        await legacyCredentials.withDecryptedCredential(
          {
            companyId: companyA.companyId,
            credentialId: companyA.credentialId
          },
          (value) => bufferEquals(value, state.plaintextA)
        ),
        "restore_behavior_2a_cannot_read_2b_envelope"
      );
      const stored = await legacyCredentials.store({
        companyId: companyA.companyId,
        provider: "instagram",
        credentialId: extraCredentialId,
        credentialType: "synthetic_2a_probe",
        connectionId: companyA.connectionId,
        plaintext: extraPlaintext
      });
      ensure(
        stored.keyVersion === state.versionV2,
        "restore_behavior_2a_write_failed"
      );
      ensure(
        await legacyCredentials.withDecryptedCredential(
          {
            companyId: companyA.companyId,
            credentialId: extraCredentialId
          },
          (value) => bufferEquals(value, extraPlaintext)
        ),
        "restore_behavior_2a_read_after_write_failed"
      );

      currentVault = dependencies.createSocialVault({
        keyring: {
          activeVersion: state.versionV2,
          keys: new Map([[state.versionV2, state.keyV2]])
        },
        expectedKeyringFingerprint:
          dependencies.vaultKeyringFingerprint(
            state.versionV2,
            [state.versionV2]
          )
      });
      const currentCredentials =
        dependencies.createSocialCredentialService({
          repository: state.repository,
          vault: currentVault
        });
      ensure(
        await currentCredentials.withDecryptedCredential(
          {
            companyId: companyA.companyId,
            credentialId: extraCredentialId
          },
          (value) => bufferEquals(value, extraPlaintext)
        ),
        "restore_behavior_2b_cannot_read_2a_envelope"
      );
      await expectAsyncCode(
        () =>
          legacyCredentials.withDecryptedCredential(
            {
              companyId: companyB.companyId,
              credentialId: extraCredentialId
            },
            () => true
          ),
        "credential_not_found"
      );
      const noChange = await legacyCredentials.rotate({
        companyId: companyA.companyId,
        credentialId: extraCredentialId
      });
      ensure(
        noChange.changed === false &&
          noChange.keyVersion === state.versionV2,
        "restore_behavior_2a_idempotency_failed"
      );

      await legacy.verifyRuntimeSchema(runtimePool, RUNTIME_ROLE);
      await dependencies.verifyRuntimeSchema(
        runtimePool,
        RUNTIME_ROLE
      );
      const policies = await dependencies.withTransaction(
        migrationPool,
        (client) =>
          client.query(
            [
              "SELECT COUNT(*)::integer AS transient_count",
              "FROM pg_catalog.pg_policies",
              "WHERE schemaname = 'ia4tube_social'",
              "  AND (",
              "    left(policyname, length($1)) = $1",
              "    OR policyname = ANY($2::text[])",
              "  )"
            ].join("\n"),
            [
              POLICY_PREFIX,
              [
                GLOBAL_VAULT_BACKFILL_POLICY,
                CREDENTIAL_INVENTORY_POLICY
              ]
            ]
          ),
        { role: OWNER_ROLE }
      );
      ensure(
        Number(policies.rows?.[0]?.transient_count) === 0,
        "restore_behavior_transient_policy_remained"
      );
      return true;
    } finally {
      legacyVault?.destroy();
      currentVault?.destroy();
      extraPlaintext.fill(0);
      state.keyV2?.fill(0);
      state.plaintextA?.fill(0);
    }
  }

  async function close() {
    if (state.closed) return;
    state.closed = true;
    state.keyV2?.fill(0);
    state.plaintextA?.fill(0);
    let failed = false;
    try {
      await runtimePool.end();
    } catch {
      failed = true;
    }
    try {
      await migrationPool.end();
    } catch {
      failed = true;
    }
    if (failed) fail("restore_behavior_cleanup_failed");
  }

  return Object.freeze({
    close,
    verifiers: Object.freeze({
      verifierTargetFingerprint,
      verify2ACompatibility,
      verifyRuntimeIsolation,
      verifyVault
    })
  });
}

module.exports = {
  IDENTITY_DERIVATION_VERSION,
  LEGACY_2A_COMMIT,
  LEGACY_2A_MODULES,
  LEGACY_2A_SOURCE_MANIFEST,
  OWNER_ROLE,
  RUNTIME_ROLE,
  RestoreBehaviorVerifierError,
  createRestoreBehaviorVerifiers,
  inspectSeparatedTargets,
  loadLegacy2ADependencies,
  poolConfiguration,
  verifyLegacy2ASourceManifest
};
