"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createLocalVerifierPoolClass,
  createTenant,
  databaseContainsMarker,
  runConcurrencyOAuthIdempotencyGate,
  runPersistedVaultGate,
  runRlsAndRoleGate,
  runRlsPrivilegeInventoryContextReproduction,
  runRlsRuntimeWriteContractReproduction,
  runRuntimeAttributesTextResolutionReproduction,
  runVaultSupplementalGate,
  runtimeWritePrivilegeInventory
} = require("../scripts/social-3a0p-linux-physical-gates");

const ROOT = path.resolve(__dirname, "..");
const MIGRATION_LOGIN = "ia4tube_social_local_migration";
const MIGRATOR_ROLE = "ia4tube_social_migrator";
const OWNER_ROLE = "ia4tube_social_owner";
const PROVISIONER_LOGIN = "ia4tube_social_local_provisioner";
const RUNTIME_LOGIN = "ia4tube_social_local_runtime";
const RUNTIME_ROLE = "ia4tube_social_runtime";
const OAUTH_CONSUMED_STATE_CODE = "social_oauth_state_already_consumed";
const OAUTH_EXPIRED_CODE = "authorization_expired";

const SUPPLEMENTAL_GATE3_SUBSTEPS = Object.freeze([
  ["S1", "supplemental_tenant_create", "internal_setup"],
  ["S2", "supplemental_tenant_a_seed", "postgres_transaction"],
  ["S3", "supplemental_tenant_b_seed", "postgres_transaction"],
  ["S4", "supplemental_connector_store_setup", "internal_setup"],
  ["S5", "supplemental_connection_reservation_race", "postgres_concurrent_transactions"],
  ["S6", "supplemental_connection_reservation_validation", "internal_validation"],
  ["S7", "supplemental_blocking_connection_inventory", "postgres_inventory"],
  ["S8", "supplemental_oauth_repository_material_setup", "internal_setup"],
  ["S9", "supplemental_oauth_authorization_create", "postgres_transaction"],
  ["S10", "supplemental_oauth_consume_race", "postgres_concurrent_transactions"],
  ["S11", "supplemental_oauth_consume_validation", "internal_validation"],
  ["S12", "supplemental_oauth_replay_cross_tenant", "postgres_concurrent_transactions"],
  ["S13", "supplemental_expired_oauth_material_setup", "internal_setup"],
  ["S14", "supplemental_expired_oauth_create", "postgres_transaction"],
  ["S15", "supplemental_oauth_force_expiry", "postgres_transaction"],
  ["S16", "supplemental_expired_oauth_consume", "postgres_transaction"],
  ["S17", "supplemental_plaintext_absence_inventory", "postgres_inventory"],
  ["S18", "supplemental_winner_disconnect", "postgres_transaction"],
  ["S19", "supplemental_connected_tenant_a_seed", "postgres_transaction"],
  ["S20", "supplemental_connected_tenant_b_seed", "postgres_transaction"],
  ["S21", "supplemental_publication_material_setup", "internal_setup"],
  ["S22", "supplemental_publication_idempotency_race", "postgres_concurrent_transactions"],
  ["S23", "supplemental_publication_race_validation", "internal_validation"],
  ["S24", "supplemental_publication_complete", "postgres_transaction"],
  ["S25", "supplemental_publication_replay", "postgres_transaction"],
  ["S26", "supplemental_publication_changed_hash_refusal", "postgres_transaction"],
  ["S27", "supplemental_publication_cross_tenant_key", "postgres_transaction"],
  ["S28", "supplemental_publication_persistence_inventory", "postgres_inventory"],
  ["S29", "supplemental_final_assertion_result", "internal_validation"],
  ["S30", "supplemental_identity_key_zeroing", "memory_cleanup"]
]);

const SUPPLEMENTAL_GATE3_RESULT = Object.freeze({
  connectionReservationsConcurrent: 2,
  blockingConnections: 1,
  secondConnectionConflict: true,
  oauthSingleConsumer: true,
  oauthSecondConsumeRefused: true,
  oauthReplayRefused: true,
  oauthExpiredRefused: true,
  oauthCrossCompanyRefused: true,
  oauthPlaintextAbsent: true,
  sameRequestReused: true,
  changedHashConflict: true,
  crossTenantKeyAccepted: true,
  publicationRows: 1,
  duplicateAttempts: 0,
  externalCalls: 0
});

const SUPPLEMENTAL_GATE4_SUBSTEPS = Object.freeze([
  ["V10", "memory_setup"],
  ["V11", "memory_crypto"],
  ["V12", "memory_crypto"],
  ["V13", "memory_validation"],
  ["V14", "memory_validation"],
  ["V15", "memory_validation"],
  ["V16", "memory_validation"],
  ["V17", "memory_validation"],
  ["V18", "memory_validation"],
  ["V19", "memory_cleanup"]
]);

const PERSISTED_GATE4_SUBSTEPS = Object.freeze([
  ["V20", "memory_setup"],
  ["V21", "postgres_verifier_setup"],
  ["V22", "postgres_runtime_isolation"],
  ["V23", "postgres_vault_verification"],
  ["V24", "postgres_verifier_cleanup"],
  ["V25", "memory_cleanup"]
]);

function syntheticPersistedGate4Harness(options = {}) {
  const observations = {
    closeCalls: 0,
    retirementCalls: 0,
    runtimeIsolationCalls: 0,
    vaultCalls: 0
  };
  const gate = {
    async close() {
      observations.closeCalls += 1;
      if (options.closeError) throw options.closeError;
    },
    verifiers: {
      async verifyRuntimeIsolation() {
        observations.runtimeIsolationCalls += 1;
        return true;
      },
      async verifyVault() {
        observations.vaultCalls += 1;
        return true;
      }
    }
  };
  const setup = {
    databaseUrl() { return "postgresql://synthetic.invalid/synthetic"; },
    original: {
      createRestoreBehaviorVerifiers() { return gate; }
    },
    passwords: Object.freeze({}),
    persistedA: Buffer.alloc(48, 0x61),
    persistedB: Buffer.alloc(48, 0x62)
  };
  async function retirePrimaryMigrationPoolBeforePersistedVault() {
    observations.retirementCalls += 1;
    if (options.retirementError) throw options.retirementError;
    return options.retirementResult === undefined
      ? true
      : options.retirementResult;
  }
  return {
    gate,
    observations,
    retirePrimaryMigrationPoolBeforePersistedVault,
    setup
  };
}

function syntheticPersistedGate4State() {
  return {
    PoolClass: class SyntheticPool {},
    database: "synthetic",
    target: { port: 5432 }
  };
}

const COMPLETE_GATE4_CAPACITY_ROW = Object.freeze({
  serverMaxConnections: 20,
  serverReservedConnections: 0,
  serverSuperuserReservedConnections: 3,
  serverClientConnectionsBeforeV22Failure: 17,
  databaseConnectionLimit: -1,
  databaseClientConnectionsBeforeV22Failure: 12,
  provisionerConnectionLimit: 2,
  provisionerClientConnectionsBeforeV22Failure: 0,
  migrationConnectionLimit: 5,
  migrationClientConnectionsBeforeV22Failure: 4,
  runtimeConnectionLimit: 8,
  runtimeClientConnectionsBeforeV22Failure: 8
});

function syntheticGate4CapacityHarness(options = {}) {
  const migrationPassword = "m".repeat(48);
  const runtimePassword = "r".repeat(48);
  const plan = {
    migration: [...(options.migrationPlan || [])],
    runtime: [...(options.runtimePlan || ["success", "53300"])]
  };
  const observations = {
    callbackReleases: [],
    closeCalls: 0,
    events: [],
    functionalClients: [],
    lifecycleEvents: options.lifecycleEvents || [],
    poolQueryCalls: 0,
    records: [],
    retirementCalls: 0,
    snapshotCalls: [],
    underlyingEndCalls: { migration: 0, runtime: 0 },
    underlyingConnectCalls: { migration: 0, runtime: 0 },
    verifierPools: {}
  };
  const capacityFailure = Object.assign(new Error("private capacity failure"), { code: "53300" });
  const otherFailure = Object.assign(new Error("private non-capacity failure"), { code: "08006" });
  let clientSequence = 0;

  class FakePool {
    constructor(configuration) {
      this.category = configuration.user === MIGRATION_LOGIN ? "migration" : "runtime";
      observations.lifecycleEvents.push(`pool:${this.category}`);
      this.options = { max: configuration.max };
      const counts = options.verifierCounts?.[this.category] || (
        this.category === "migration"
          ? { totalCount: 1, idleCount: 1, waitingCount: 0 }
          : { totalCount: 2, idleCount: 1, waitingCount: 0 }
      );
      this.totalCount = counts.totalCount;
      this.idleCount = counts.idleCount;
      this.waitingCount = counts.waitingCount;
    }

    connect(callback) {
      observations.lifecycleEvents.push(`connect:${this.category}`);
      observations.underlyingConnectCalls[this.category] += 1;
      const outcome = plan[this.category].shift() || "success";
      const error = outcome === "53300"
        ? capacityFailure
        : outcome === "08006"
          ? otherFailure
          : null;
      let client;
      if (!error) {
        const id = `${this.category}-${++clientSequence}`;
        client = {
          id,
          async query(text, values) {
            observations.events.push(`snapshot:${id}`);
            observations.snapshotCalls.push({ client, text, values });
            if (options.snapshotError) throw options.snapshotError;
            return { rows: [{ ...(options.snapshotRow || COMPLETE_GATE4_CAPACITY_ROW) }] };
          },
          release() {
            observations.events.push(`release:${id}`);
          }
        };
      }
      if (typeof callback === "function") {
        if (error) callback(error);
        else callback(null, client, client.release);
        return undefined;
      }
      return error ? Promise.reject(error) : Promise.resolve(client);
    }

    query() {
      observations.poolQueryCalls += 1;
      throw new Error("private pool query must not be used");
    }

    async end() {
      observations.underlyingEndCalls[this.category] += 1;
      observations.lifecycleEvents.push(`end:${this.category}`);
    }
  }

  const passwordByLogin = {
    [MIGRATION_LOGIN]: migrationPassword,
    [RUNTIME_LOGIN]: runtimePassword
  };
  const databaseUrl = (login) => {
    const value = new URL("postgresql://local.ia4tube.invalid:5432/ia4tube_social_local");
    value.username = login;
    value.password = passwordByLogin[login];
    value.searchParams.set("sslmode", "verify-full");
    return value.toString();
  };
  const functionalConnections = options.functionalConnections || [
    { category: "runtime", callback: false },
    { category: "runtime", callback: false }
  ];
  const setup = {
    databaseUrl,
    original: {
      createRestoreBehaviorVerifiers(configuration) {
        observations.lifecycleEvents.push("verifier-setup");
        const PoolClass = configuration.dependencies.PoolClass;
        const ssl = { rejectUnauthorized: true, servername: "local.ia4tube.invalid" };
        observations.verifierPools.migration = new PoolClass({
          connectionString: configuration.migrationDatabaseUrl,
          ssl,
          max: 1
        });
        if (options.verifierFactoryErrorAfterMigration) {
          throw options.verifierFactoryErrorAfterMigration;
        }
        observations.verifierPools.runtime = new PoolClass({
          connectionString: configuration.runtimeDatabaseUrl,
          ssl,
          max: 2
        });
        return {
          async close() {
            observations.closeCalls += 1;
            await observations.verifierPools.runtime.end();
            await observations.verifierPools.migration.end();
          },
          verifiers: {
            async verifyRuntimeIsolation() {
              for (const operation of functionalConnections) {
                const pool = observations.verifierPools[operation.category];
                const client = operation.callback
                  ? await new Promise((resolve, reject) => {
                    pool.connect((error, connectedClient, release) => {
                      if (error) return reject(error);
                      observations.callbackReleases.push(release);
                      return resolve(connectedClient);
                    });
                  })
                  : await pool.connect();
                observations.events.push(`functional:${client.id}`);
                observations.functionalClients.push(client);
                client.release();
              }
              if (options.afterConnectionsError) throw options.afterConnectionsError;
              return true;
            },
            async verifyVault() { return true; }
          }
        };
      }
    },
    passwords: passwordByLogin,
    persistedA: Buffer.alloc(48, 0x61),
    persistedB: Buffer.alloc(48, 0x62)
  };
  const pool = (max, totalCount, idleCount, waitingCount) => ({
    options: { max },
    totalCount,
    idleCount,
    waitingCount
  });
  const state = {
    PoolClass: FakePool,
    database: "ia4tube_social_local",
    passwords: passwordByLogin,
    pools: {
      migration: pool(2, 1, 1, 0),
      runtime: pool(3, 2, 1, 0)
    },
    target: { port: 5432 }
  };

  return {
    capacityFailure,
    otherFailure,
    observations,
    setup,
    state,
    async run() {
      let result;
      let thrown;
      try {
        result = await runPersistedVaultGate(state, [], "synthetic-unused-root", {
          async runGate4Substep(substep, _operationClass, operation) {
            observations.lifecycleEvents.push(substep);
            if (substep === "V20") return setup;
            return operation();
          },
          recordGate4ConnectionCapacityDiagnostics(candidate) {
            observations.records.push(candidate);
            if (options.recorderError) throw options.recorderError;
          },
          async retirePrimaryMigrationPoolBeforePersistedVault(...arguments_) {
            observations.retirementCalls += 1;
            observations.lifecycleEvents.push("handoff");
            if (options.retirementError) throw options.retirementError;
            if (arguments_.length !== 0) {
              throw new Error("retirement callback received unexpected arguments");
            }
            return options.retirementResult === undefined
              ? true
              : options.retirementResult;
          }
        });
      } catch (error) {
        thrown = error;
      }
      return { result, thrown };
    }
  };
}

function assertUnavailableGate4CapacitySnapshot(candidate) {
  assert.deepEqual(candidate.server, {
    maxConnections: null,
    reservedConnections: null,
    superuserReservedConnections: null,
    clientConnectionsBeforeV22Failure: null
  });
  assert.deepEqual(candidate.database, {
    connectionLimit: null,
    clientConnectionsBeforeV22Failure: null
  });
  for (const role of Object.values(candidate.roles)) {
    assert.deepEqual(role, {
      connectionLimit: null,
      clientConnectionsBeforeV22Failure: null
    });
  }
}

function assertGate4PoolCountersNumeric(candidate) {
  assert.deepEqual(Object.keys(candidate.pools), [
    "mainMigration",
    "mainRuntime",
    "verifierMigration",
    "verifierRuntime"
  ]);
  for (const pool of Object.values(candidate.pools)) {
    assert.deepEqual(Object.keys(pool), [
      "configuredMax",
      "totalCount",
      "idleCount",
      "waitingCount",
      "connectAttempts",
      "connectSucceeded",
      "connectionCapacityFailures"
    ]);
    for (const value of Object.values(pool)) {
      assert.equal(Number.isSafeInteger(value), true);
      assert.ok(value >= 0);
    }
    assert.ok(pool.configuredMax > 0);
  }
}

function postgresError(code) {
  return Object.assign(new Error("synthetic postgres refusal"), { code });
}

function legacyFailureCode(error) {
  const candidate = String(error?.code || error?.message || "");
  return /^[a-z][a-z0-9_]{2,119}$/.test(candidate)
    ? candidate
    : "linux_gate_unclassified_failure";
}

async function withSupplementalGate3Doubles(operation, options = {}) {
  const poolModule = require("../src/persistence/postgres/pool");
  const connectorModule = require("../src/persistence/postgres/social-connector-store");
  const oauthModule = require("../src/persistence/postgres/social-oauth-repository");
  const originals = {
    withTransaction: poolModule.withTransaction,
    createPostgresConnectorStore: connectorModule.createPostgresConnectorStore,
    createPostgresOAuthRepository: oauthModule.createPostgresOAuthRepository,
    randomBytes: crypto.randomBytes,
    now: Date.now
  };
  const observations = {
    transactions: [],
    queries: [],
    connectorCalls: [],
    oauthCalls: [],
    oauthOutcomes: []
  };
  const snapshot = (value) => JSON.parse(JSON.stringify(value));
  const postgresRefusal = (code) => Object.assign(new Error("synthetic refusal"), { code });
  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const configuredCode = (name, fallback) => hasOwn(options, name) ? options[name] : fallback;
  const s10ConsumerOutcomes = options.s10ConsumerOutcomes || [
    Object.freeze({ status: "fulfilled" }),
    Object.freeze({ status: "rejected", code: OAUTH_CONSUMED_STATE_CODE })
  ];
  const settleOAuthConsume = (tenant, outcome) => {
    if (outcome?.status === "fulfilled") {
      observations.oauthOutcomes.push({ tenant, status: "fulfilled" });
      return Object.freeze({ status: "consumed" });
    }
    const refusal = new Error("synthetic refusal");
    const observed = { tenant, status: "rejected" };
    if (hasOwn(outcome || {}, "code")) {
      refusal.code = outcome.code;
      observed.code = outcome.code;
    }
    observations.oauthOutcomes.push(observed);
    throw refusal;
  };
  const state = {
    pools: {
      migration: Object.freeze({ label: "migration" }),
      runtime: Object.freeze({ label: "runtime" })
    }
  };
  let winningConnectionId;
  let reservationCall = 0;
  let connectorScope = 0;
  let s10ConsumeCall = 0;
  let oauthScope = 0;
  let primaryAuthorizationHandle;
  let expiredAuthorizationHandle;
  let publicationRaceCall = 0;
  let publicationCompleted = false;
  let randomCall = 0;

  poolModule.withTransaction = async (pool, callback, transactionOptions = {}) => {
    observations.transactions.push({
      pool: pool === state.pools.migration ? "migration" : "runtime",
      options: snapshot(transactionOptions)
    });
    const client = {
      async query(text, values = []) {
        const sql = String(text);
        observations.queries.push({ text: sql, values: snapshot(values) });
        if (sql.includes("UPDATE ia4tube_social.social_oauth_transactions")) {
          if ((options.s15TargetState || "open") !== "open") {
            return { rowCount: 0, rows: [] };
          }
          const proof = {
            id_matches: options.s15IdMatches !== false,
            expiry_after_creation: options.s15ExpiryAfterCreation !== false,
            expiry_before_current: options.s15ExpiryBeforeCurrent !== false,
            consumed_at_is_null: options.s15ConsumedAtIsNull !== false,
            cancelled_at_is_null: options.s15CancelledAtIsNull !== false,
            failed_at_is_null: options.s15FailedAtIsNull !== false
          };
          const rowCount = options.s15RowCount ?? 1;
          return { rowCount, rows: Array.from({ length: rowCount }, () => ({ ...proof })) };
        }
        if (sql.includes("SELECT id::text AS id FROM ia4tube_social.social_connections")) {
          return { rows: [{ id: winningConnectionId }] };
        }
        if (sql.includes(") AS present")) return { rows: [{ present: false }] };
        if (sql.includes("AS publications,")) {
          return { rows: [{ publications: 1, attempts: 0 }] };
        }
        return { rows: [] };
      }
    };
    return callback(client);
  };
  connectorModule.createPostgresConnectorStore = () => ({
    scope(context) {
      const tenant = connectorScope++ === 0 ? "a" : "b";
      return Object.freeze({
        async saveConnection(record, expectedRevision) {
          observations.connectorCalls.push({
            method: "saveConnection",
            tenant,
            arguments: snapshot([record, expectedRevision])
          });
          if (record.state === "authorization_pending") {
            reservationCall += 1;
            if (reservationCall === 1) {
              winningConnectionId = record.id;
              return Object.freeze({ ...record });
            }
            throw postgresRefusal("state_transition_invalid");
          }
          return Object.freeze({ ...record });
        },
        async beginIdempotency(input) {
          observations.connectorCalls.push({
            method: "beginIdempotency",
            tenant,
            arguments: snapshot([input])
          });
          if (tenant === "b") return Object.freeze({ status: "acquired" });
          if (input.digest === "f".repeat(64)) throw postgresRefusal("idempotency_conflict");
          if (publicationCompleted) return Object.freeze({ status: "completed" });
          publicationRaceCall += 1;
          return Object.freeze({ status: publicationRaceCall === 1 ? "acquired" : "pending" });
        },
        async completeIdempotency(input) {
          observations.connectorCalls.push({
            method: "completeIdempotency",
            tenant,
            arguments: snapshot([input])
          });
          publicationCompleted = true;
          return true;
        }
      });
    }
  });
  oauthModule.createPostgresOAuthRepository = () => ({
    scope(context) {
      const tenant = oauthScope++ === 0 ? "a" : "b";
      return Object.freeze({
        async createAuthorization(input) {
          observations.oauthCalls.push({
            method: "createAuthorization",
            tenant,
            arguments: snapshot([input])
          });
          if (tenant === "a" && primaryAuthorizationHandle === undefined) {
            primaryAuthorizationHandle = input.authorizationHandle;
          } else if (tenant === "a" && input.authorizationHandle !== primaryAuthorizationHandle) {
            expiredAuthorizationHandle = input.authorizationHandle;
          }
          return true;
        },
        async consumeAuthorization(input) {
          observations.oauthCalls.push({
            method: "consumeAuthorization",
            tenant,
            arguments: snapshot([input])
          });
          if (tenant === "b") {
            return settleOAuthConsume(tenant, {
              status: "rejected",
              code: configuredCode("crossTenantCode", OAUTH_EXPIRED_CODE)
            });
          }
          if (
            expiredAuthorizationHandle !== undefined &&
            input.authorizationHandle === expiredAuthorizationHandle
          ) {
            return settleOAuthConsume(tenant, {
              status: "rejected",
              code: configuredCode("expiredCode", OAUTH_EXPIRED_CODE)
            });
          }
          if (input.authorizationHandle === primaryAuthorizationHandle && s10ConsumeCall < 2) {
            const outcome = s10ConsumerOutcomes[s10ConsumeCall];
            s10ConsumeCall += 1;
            return settleOAuthConsume(tenant, outcome);
          }
          if (input.authorizationHandle === primaryAuthorizationHandle) {
            return settleOAuthConsume(tenant, {
              status: "rejected",
              code: configuredCode("sameTenantReplayCode", OAUTH_CONSUMED_STATE_CODE)
            });
          }
          return settleOAuthConsume(tenant, {
            status: "rejected",
            code: OAUTH_EXPIRED_CODE
          });
        }
      });
    }
  });
  crypto.randomBytes = (size) => Buffer.alloc(size, ++randomCall);
  Date.now = () => 1_800_000_000_000;

  try {
    const identityKey = options.identityKey || Buffer.alloc(32, 0x5a);
    let uuid = 0;
    const dependencies = {
      identityKey,
      randomUUID() {
        uuid += 1;
        return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
      }
    };
    const sensitiveMarkers = [];
    const value = await operation({
      state,
      dependencies,
      sensitiveMarkers,
      identityKey,
      observations
    });
    return value;
  } finally {
    poolModule.withTransaction = originals.withTransaction;
    connectorModule.createPostgresConnectorStore = originals.createPostgresConnectorStore;
    oauthModule.createPostgresOAuthRepository = originals.createPostgresOAuthRepository;
    crypto.randomBytes = originals.randomBytes;
    Date.now = originals.now;
  }
}

async function executeSupplementalGate3(options = {}) {
  return withSupplementalGate3Doubles(async (fixture) => {
    const runnerCalls = [];
    const operationCounts = new Map();
    const dependencies = { ...fixture.dependencies };
    if (options.runGate3Substep) {
      dependencies.runGate3Substep = async (substep, operationClass, operation) => {
        runnerCalls.push({ substep, operationClass });
        const countedOperation = async () => {
          operationCounts.set(substep, (operationCounts.get(substep) || 0) + 1);
          return operation();
        };
        return options.runGate3Substep(substep, operationClass, countedOperation);
      };
    }
    let result;
    let thrown;
    let didThrow = false;
    try {
      result = await runConcurrencyOAuthIdempotencyGate(
        fixture.state,
        fixture.sensitiveMarkers,
        dependencies
      );
    } catch (error) {
      didThrow = true;
      thrown = error;
    }
    return {
      ...fixture,
      result,
      thrown,
      didThrow,
      runnerCalls,
      operationCounts
    };
  }, options);
}

function supplementalGate3Source() {
  return fs.readFileSync(
    path.join(ROOT, "scripts/social-3a0p-linux-physical-gates.js"),
    "utf8"
  );
}

function supplementalSubstepSource(source, current, next) {
  const start = source.indexOf(`await runGate3Substep("${current}"`);
  const end = source.indexOf(`await runGate3Substep("${next}"`, start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.equal(end > start, true);
  return source.slice(start, end);
}

function inventoryContextProof(overrides = {}) {
  return Object.freeze({
    directSessionIdentityVerified: true,
    directLoginSuperuser: false,
    directLoginBypassRls: false,
    directLoginCreateRole: false,
    directLoginCanSetMigratorRole: true,
    directLoginInheritsMigratorRole: false,
    directSchemaUsage: false,
    directNameResolutionRefused: true,
    directTransactionPersisted: false,
    directPoolUsableAfterRefusal: true,
    inventorySessionUserMigration: true,
    inventoryCurrentUserMigrator: true,
    migratorSessionIdentityPreserved: true,
    migratorRoleActivated: true,
    migratorSchemaUsage: false,
    migratorInventorySucceeded: true,
    oidInventoryUsed: true,
    textualRelationResolutionUsed: false,
    relationCount: 2,
    roleResetAfterTransaction: true,
    privilegesUnchanged: true,
    aclUnchanged: true,
    ...overrides
  });
}

function createInventoryContextDatabase(options = {}) {
  const calls = [];
  const clients = [];
  const available = [];
  let aclReads = 0;
  let inventoryReads = 0;

  const relationRows = (client) => {
    const schemaAcl = "{synthetic_schema_acl}";
    const base = [
      {
        namespace_name: options.auditSchemaName ?? options.inventorySchemaName ?? "ia4tube_social",
        namespace_oid: options.auditNamespaceOid ?? options.inventoryNamespaceOid ?? 4100,
        relation_name: "social_audit_events",
        relation_oid: options.auditRelationOid ?? 4101,
        relation_kind: options.auditRelationKind ?? "r",
        session_user_is_migration: options.inventorySessionUserMigration !== false &&
          client.sessionUser === MIGRATION_LOGIN,
        current_user_is_migrator: options.inventoryCurrentUserMigrator !== false &&
          client.currentUser === MIGRATOR_ROLE,
        schema_usage: options.migratorSchemaUsage === true,
        runtime_login_can_set_role: true,
        runtime_login_insert: false,
        runtime_insert: options.auditInsertPrivilege !== false,
        social_audit_rls_enabled: options.auditRlsEnabled !== false,
        social_audit_force_rls: options.auditForceRls !== false,
        social_audit_policy_exists: options.auditPolicyExists !== false,
        social_audit_policy_using: options.auditPolicyUsing !== false,
        social_audit_policy_with_check: options.auditPolicyWithCheck !== false,
        social_audit_policy_company_bound: options.auditPolicyCompanyBound !== false,
        schema_acl: schemaAcl,
        relation_acl: inventoryReads > 1 && options.inventoryAclMutationAfterFirst
          ? "{mutated_audit_acl}"
          : "{synthetic_audit_acl}"
      },
      {
        namespace_name: options.userSchemaName ?? options.inventorySchemaName ?? "ia4tube_social",
        namespace_oid: options.userNamespaceOid ?? options.inventoryNamespaceOid ?? 4100,
        relation_name: "users",
        relation_oid: options.userRelationOid ?? 4102,
        relation_kind: options.userRelationKind ?? "r",
        session_user_is_migration: options.inventorySessionUserMigration !== false &&
          client.sessionUser === MIGRATION_LOGIN,
        current_user_is_migrator: options.inventoryCurrentUserMigrator !== false &&
          client.currentUser === MIGRATOR_ROLE,
        schema_usage: options.migratorSchemaUsage === true,
        runtime_login_can_set_role: true,
        runtime_login_insert: false,
        runtime_insert: options.userInsertPrivilege === true,
        social_audit_rls_enabled: false,
        social_audit_force_rls: false,
        social_audit_policy_exists: false,
        social_audit_policy_using: false,
        social_audit_policy_with_check: false,
        social_audit_policy_company_bound: false,
        schema_acl: schemaAcl,
        relation_acl: "{synthetic_users_acl}"
      }
    ];
    if (options.missingRelation || options.missingUsers) return base.slice(0, 1);
    if (options.missingAudit) return base.slice(1);
    if (options.duplicateRelation) return [...base, { ...base[1] }];
    if (Object.hasOwn(options, "userRuntimeLoginInsertRaw")) {
      base[1].runtime_login_insert = options.userRuntimeLoginInsertRaw;
    }
    if (Object.hasOwn(options, "userRuntimeInsertRaw")) {
      base[1].runtime_insert = options.userRuntimeInsertRaw;
    }
    if (options.omitUserRuntimeLoginInsert === true) delete base[1].runtime_login_insert;
    if (options.omitUserRuntimeInsert === true) delete base[1].runtime_insert;
    return base;
  };

  class Client {
    constructor() {
      this.sessionUser = MIGRATION_LOGIN;
      this.currentUser = MIGRATION_LOGIN;
      this.inTransaction = false;
      this._txStatus = "I";
      this.checkedOut = true;
      clients.push(this);
    }

    async query(text, values = []) {
      const sql = String(text);
      calls.push({
        sql,
        values: [...values],
        sessionUser: this.sessionUser,
        currentUser: this.currentUser,
        inTransaction: this.inTransaction,
        transactionStatus: this._txStatus
      });
      if (sql === "BEGIN") {
        this.inTransaction = true;
        if (options.transactionStatusAfterBegin === "absent") {
          delete this._txStatus;
        } else {
          this._txStatus = options.transactionStatusAfterBegin ?? "T";
        }
        return { rows: [] };
      }
      if (sql.startsWith("SET LOCAL ROLE")) {
        if (options.migratorRoleActivationFails) throw postgresError("42501");
        this.currentUser = MIGRATOR_ROLE;
        return { rows: [] };
      }
      if (sql === "COMMIT" || sql === "ROLLBACK") {
        this.inTransaction = false;
        this._txStatus = "I";
        if (options.roleLeakAfterTransaction !== true) {
          this.currentUser = MIGRATION_LOGIN;
        }
        return { rows: [] };
      }
      if (sql.includes("AS direct_session_identity")) {
        return { rows: [{
          direct_session_identity: options.directSessionIdentity !== false &&
            this.sessionUser === MIGRATION_LOGIN,
          direct_current_identity: options.directCurrentIdentity !== false &&
            this.currentUser === MIGRATION_LOGIN,
          direct_superuser: options.directSuperuser === true,
          direct_bypassrls: options.directBypassRls === true,
          direct_createrole: options.directCreateRole === true,
          direct_can_set_migrator: options.directCanSetMigrator !== false,
          direct_inherits_migrator: options.directInheritsMigrator === true
        }] };
      }
      if (sql.includes("AS migrator_session_identity")) {
        return { rows: [{
          migrator_session_identity: this.sessionUser === MIGRATION_LOGIN,
          migrator_current_identity: this.currentUser === MIGRATOR_ROLE,
          migrator_schema_usage: options.migratorSchemaUsage === true
        }] };
      }
      if (sql.includes("AS relation_acl") && !sql.includes("AS runtime_insert")) {
        aclReads += 1;
        const mutation = options.aclMutationAfterDirectRefusal && aclReads > 1;
        return { rows: [
          {
            relation_name: "social_audit_events",
            direct_schema_usage: options.directSchemaUsage === true,
            schema_acl: "{synthetic_schema_acl}",
            relation_acl: mutation ? "{mutated_audit_acl}" : "{synthetic_audit_acl}"
          },
          {
            relation_name: "users",
            direct_schema_usage: options.directSchemaUsage === true,
            schema_acl: "{synthetic_schema_acl}",
            relation_acl: "{synthetic_users_acl}"
          }
        ] };
      }
      if (sql.includes("AS direct_runtime_insert")) {
        throw postgresError(options.directFailureCode || "42501");
      }
      if (sql.includes("AS direct_pool_usable")) {
        return { rows: [{
          direct_pool_usable: options.directPoolUsable !== false,
          direct_transaction_persisted: false
        }] };
      }
      if (sql.includes("AS relation_name") && sql.includes("AS runtime_insert")) {
        inventoryReads += 1;
        if (options.inventoryFailure) throw postgresError("synthetic_inventory_failure");
        return { rows: relationRows(this) };
      }
      throw new Error(`unexpected inventory query: ${sql}`);
    }

    release() {
      if (!this.checkedOut) return;
      this.checkedOut = false;
      available.push(this);
    }
  }

  const migration = {
    async connect() {
      const client = available.pop() || new Client();
      client.checkedOut = true;
      return client;
    }
  };
  return {
    state: { pools: { migration } },
    calls,
    clients,
    migration,
    authorizedClient() {
      const client = new Client();
      client.inTransaction = true;
      client._txStatus = "T";
      client.currentUser = MIGRATOR_ROLE;
      return client;
    },
    get inventoryReads() { return inventoryReads; }
  };
}

function createRlsDatabase(options = {}) {
  const companies = new Set();
  const users = new Set();
  const auditEvents = new Set();
  const calls = [];
  const releases = [];
  let inventoryCalls = 0;
  const key = (companyId, id) => `${companyId}:${id}`;

  class Client {
    constructor(kind) {
      this.kind = kind;
      this.companyId = null;
      this.invalidCompanyContext = false;
      this.manualScopeClient = false;
      this.inTransaction = false;
      this._txStatus = "I";
      this.sessionUser = kind === "migration" ? MIGRATION_LOGIN : RUNTIME_LOGIN;
      this.currentUser = this.sessionUser;
    }

    async query(text, values = []) {
      const sql = String(text);
      calls.push({
        kind: this.kind,
        sql,
        values: [...values],
        manualScopeClient: this.manualScopeClient
      });
      if (sql === "BEGIN") {
        this.inTransaction = true;
        this._txStatus = "T";
        return { rows: [] };
      }
      if (sql === "COMMIT" || sql === "ROLLBACK") {
        this.companyId = null;
        this.invalidCompanyContext = false;
        this.inTransaction = false;
        this._txStatus = "I";
        this.currentUser = this.sessionUser;
        return { rows: [] };
      }
      if (sql.startsWith("SET LOCAL ROLE")) {
        if (!sql.includes('"')) this.manualScopeClient = true;
        if (sql.includes(MIGRATOR_ROLE)) this.currentUser = MIGRATOR_ROLE;
        return { rows: [] };
      }
      if (sql.includes("set_config('ia4tube.company_id'")) {
        this.companyId = values[0];
        this.invalidCompanyContext = values[0] === "not-a-uuid";
        return { rows: [{ set_config: values[0] }] };
      }
      if (sql.includes("INSERT INTO ia4tube_social.companies")) {
        companies.add(values[0]);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO ia4tube_social.users")) {
        if (this.kind === "runtime") {
          if (options.persistUserOnRuntimeFailure) users.add(key(values[0], values[1]));
          throw postgresError(options.userInsertFailureCode || "42501");
        }
        users.add(key(values[0], values[1]));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO ia4tube_social.company_memberships")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO ia4tube_social.social_audit_events")) {
        if (this.kind !== "runtime" || values[0] !== this.companyId) {
          if (options.persistCrossBeforeFailure) auditEvents.add(key(values[0], values[1]));
          throw postgresError(options.crossWriteFailureCode || "42501");
        }
        auditEvents.add(key(values[0], values[1]));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("FROM ia4tube_social.users WHERE company_id=$1 AND id=$2")) {
        return { rows: [{ n: users.has(key(values[0], values[1])) ? 1 : 0 }] };
      }
      if (sql.includes("FROM ia4tube_social.social_audit_events") && sql.includes("WHERE company_id=$1")) {
        const visible = this.companyId === values[0] && auditEvents.has(key(values[0], values[1]));
        return { rows: [{ n: visible ? 1 : 0 }] };
      }
      if (sql.includes("SELECT 1::integer AS n")) {
        return { rows: [{ n: options.runtimePoolReusable === false ? 0 : 1 }] };
      }
      if (sql.includes("FROM ia4tube_social.companies")) {
        if (this.invalidCompanyContext) throw postgresError("22P02");
        if (!sql.includes("WHERE id=$1")) return { rows: [{ n: 0 }] };
        const visible = options.connectionScopeLeaks === true && this.manualScopeClient
          ? companies.has(values[0])
          : this.companyId === values[0] && companies.has(values[0]);
        return { rows: [{ n: visible ? 1 : 0 }] };
      }
      if (sql.includes("AS relation_name") && sql.includes("AS runtime_insert")) {
        inventoryCalls += 1;
        const schemaAcl = "{synthetic_schema_acl}";
        return { rows: [
          {
            namespace_name: "ia4tube_social",
            namespace_oid: 5100,
            relation_name: "social_audit_events",
            relation_oid: 5101,
            relation_kind: "r",
            session_user_is_migration: this.sessionUser === MIGRATION_LOGIN,
            current_user_is_migrator: this.currentUser === MIGRATOR_ROLE,
            schema_usage: false,
            runtime_login_can_set_role: options.runtimeLoginCanSetRole !== false,
            runtime_login_insert: false,
            runtime_insert: options.auditInsertPrivilege !== false,
            social_audit_rls_enabled: options.auditRlsEnabled !== false,
            social_audit_force_rls: options.auditForceRls !== false,
            social_audit_policy_exists: options.auditPolicyExists !== false &&
              options.auditPolicyAppliesToRuntime !== false,
            social_audit_policy_using: options.auditPolicyUsing !== false,
            social_audit_policy_with_check: options.auditPolicyWithCheck !== false,
            social_audit_policy_company_bound: options.auditCompanyPolicy !== false &&
              options.auditPolicyCompanyBound !== false,
            schema_acl: schemaAcl,
            relation_acl: (options.mutatePrivilegeAfterRefusal === true ||
              options.mutateAclAfterRefusal === true) && inventoryCalls > 1
              ? "{mutated_audit_acl}"
              : "{synthetic_audit_acl}"
          },
          {
            namespace_name: "ia4tube_social",
            namespace_oid: 5100,
            relation_name: "users",
            relation_oid: 5102,
            relation_kind: "r",
            session_user_is_migration: this.sessionUser === MIGRATION_LOGIN,
            current_user_is_migrator: this.currentUser === MIGRATOR_ROLE,
            schema_usage: false,
            runtime_login_can_set_role: options.runtimeLoginCanSetRole !== false,
            runtime_login_insert: options.runtimeLoginUserInsertPrivilege === true,
            runtime_insert: options.userInsertPrivilege === true ||
              (options.mutatePrivilegeAfterRefusal === true && inventoryCalls > 1),
            social_audit_rls_enabled: false,
            social_audit_force_rls: false,
            social_audit_policy_exists: false,
            social_audit_policy_using: false,
            social_audit_policy_with_check: false,
            social_audit_policy_company_bound: false,
            schema_acl: schemaAcl,
            relation_acl: "{synthetic_users_acl}"
          }
        ] };
      }
      throw new Error(`unexpected synthetic query: ${sql}`);
    }

    release() {
      releases.push({ kind: this.kind, manualScopeClient: this.manualScopeClient });
      if (options.manualScopeReleaseFailure && this.manualScopeClient) {
        throw postgresError("release_cleanup_failed");
      }
    }
  }

  const migration = {
    async connect() { return new Client("migration"); },
    async query(text) {
      const sql = String(text);
      calls.push({ kind: "migration-pool", sql, values: [] });
      if (sql.includes("SELECT rolsuper")) {
        return { rows: [{
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          migrator_member: false,
          migration_table_privilege: false,
          migration_schema_create: false
        }] };
      }
      throw new Error(`unexpected synthetic pool query: ${sql}`);
    }
  };
  const runtime = {
    async connect() { return new Client("runtime"); }
  };
  return {
    state: { pools: { migration, runtime } },
    calls,
    releases,
    companies,
    users,
    auditEvents
  };
}

function createRuntimeAttributesDatabase(options = {}) {
  const calls = [];
  const clients = [];
  const available = [];
  const releaseErrors = [];
  let identityReads = 0;
  let textualReads = 0;
  let privilegeReads = 0;
  let catalogReads = 0;
  let releaseCalls = 0;
  let rollbackCalls = 0;

  const privilegeRow = () => {
    const row = {
      inventory_session_identity: options.inventorySessionIdentity !== false,
      inventory_current_identity: options.inventoryCurrentIdentity !== false,
      runtime_login_superuser: false,
      runtime_login_bypassrls: false,
      runtime_login_createdb: false,
      runtime_login_createrole: false,
      runtime_login_replication: false,
      runtime_role_superuser: false,
      runtime_role_bypassrls: false,
      runtime_role_createdb: false,
      runtime_role_createrole: false,
      runtime_role_replication: false,
      runtime_login_migrator_member: false,
      runtime_role_migrator_member: false,
      runtime_login_owner_member: false,
      runtime_role_owner_member: false,
      runtime_login_schema_usage: false,
      runtime_role_schema_usage: false,
      runtime_login_schema_create: false,
      runtime_role_schema_create: false,
      runtime_login_table_select: false,
      runtime_login_table_insert: false,
      runtime_login_table_update: false,
      runtime_login_table_delete: false,
      runtime_login_table_truncate: false,
      runtime_login_table_references: false,
      runtime_login_table_trigger: false,
      runtime_login_table_maintain: false,
      runtime_role_table_select: false,
      runtime_role_table_insert: false,
      runtime_role_table_update: false,
      runtime_role_table_delete: false,
      runtime_role_table_truncate: false,
      runtime_role_table_references: false,
      runtime_role_table_trigger: false,
      runtime_role_table_maintain: false,
      ...(options.privilegeOverrides || {})
    };
    if (options.omitPrivilegeField) delete row[options.omitPrivilegeField];
    return row;
  };

  const roleRows = () => {
    const rows = [
      { role_name: MIGRATOR_ROLE, role_oid: 6104 },
      { role_name: OWNER_ROLE, role_oid: 6105 },
      { role_name: RUNTIME_LOGIN, role_oid: 6101 },
      { role_name: RUNTIME_ROLE, role_oid: 6103 }
    ];
    if (options.missingRole) return rows.filter((row) => row.role_name !== options.missingRole);
    if (options.duplicateRole) return [...rows, { ...rows[0] }];
    if (Object.hasOwn(options, "invalidRoleOid")) rows[0].role_oid = options.invalidRoleOid;
    if (options.duplicateRoleOid) rows[1].role_oid = rows[0].role_oid;
    if (options.unexpectedRoleName) rows[0].role_name = options.unexpectedRoleName;
    return rows;
  };

  class Client {
    constructor() {
      this.sessionUser = MIGRATION_LOGIN;
      this.currentUser = MIGRATION_LOGIN;
      if (options.initialTransactionStatus !== "absent") {
        this._txStatus = options.initialTransactionStatus ?? "I";
      }
      this.checkedOut = true;
      clients.push(this);
    }

    async query(text, values = []) {
      const sql = String(text);
      calls.push({
        sql,
        values: [...values],
        transactionStatus: this._txStatus,
        sessionUser: this.sessionUser,
        currentUser: this.currentUser
      });
      if (sql === "ROLLBACK") {
        rollbackCalls += 1;
        this._txStatus = "I";
        if (options.rollbackFailureCode) throw postgresError(options.rollbackFailureCode);
        return { rows: [] };
      }
      if (sql.includes("AS direct_session_identity")) {
        identityReads += 1;
        const row = {
          direct_session_identity: options.directSessionIdentity !== false,
          direct_current_identity: options.directCurrentIdentity !== false &&
            !(options.resetIdentityDrift === true && identityReads >= 3),
          direct_inherits_migrator: options.directInheritsMigrator === true,
          direct_schema_usage: options.directSchemaUsage === true
        };
        if (options.omitDirectIdentityField) delete row[options.omitDirectIdentityField];
        return { rows: [row] };
      }
      if (sql.includes("AS textual_runtime_privilege")) {
        textualReads += 1;
        if (options.afterTextTransactionStatus === "absent") {
          delete this._txStatus;
        } else if (options.afterTextTransactionStatus) {
          this._txStatus = options.afterTextTransactionStatus;
        }
        if (options.textualQueryReturns === true) {
          return { rows: [{ textual_runtime_privilege: false }] };
        }
        throw postgresError(options.textualFailureCode || "42501");
      }
      if (sql.includes("AS direct_pool_usable")) {
        return { rows: [{
          direct_pool_usable: options.directPoolUsable !== false,
          direct_transaction_persisted: options.directTransactionPersisted === true
        }] };
      }
      if (sql.includes("AS runtime_login_superuser")) {
        privilegeReads += 1;
        if (options.privilegeFailureCode) throw postgresError(options.privilegeFailureCode);
        if (options.missingPrivilegeRow) return { rows: [] };
        const row = privilegeRow();
        return { rows: options.duplicatePrivilegeRow ? [row, { ...row }] : [row] };
      }
      if (sql.includes("AS namespace_name") && sql.includes("AS relation_name")) {
        catalogReads += 1;
        if (options.missingSchema || options.missingRelation) return { rows: [] };
        const mutated = (options.mutateAclDuringText === true && textualReads > 0) ||
          (options.mutateAclAfterPrivilege === true && privilegeReads > 0);
        const row = {
          namespace_name: options.schemaName ?? "ia4tube_migrations",
          namespace_oid: options.schemaOid ?? 6100,
          relation_name: options.relationName ?? "schema_migrations",
          relation_oid: options.relationOid ?? 6101,
          relation_kind: options.relationKind ?? "r",
          schema_acl: mutated ? "{mutated_schema_acl}" : "{synthetic_schema_acl}",
          relation_acl: mutated ? "{mutated_relation_acl}" : "{synthetic_relation_acl}"
        };
        return {
          rows: options.duplicateSchema || options.duplicateRelation ? [row, { ...row }] : [row]
        };
      }
      if (sql.includes("AS namespace_name")) {
        catalogReads += 1;
        if (options.missingSchema) return { rows: [] };
        const mutated = (options.mutateAclDuringText === true && textualReads > 0) ||
          (options.mutateAclAfterPrivilege === true && privilegeReads > 0);
        const row = {
          namespace_name: options.schemaName ?? "ia4tube_migrations",
          namespace_oid: options.schemaOid ?? 6100,
          schema_acl: mutated ? "{mutated_schema_acl}" : "{synthetic_schema_acl}"
        };
        return { rows: options.duplicateSchema ? [row, { ...row }] : [row] };
      }
      if (sql.includes("AS relation_name")) {
        if (options.missingRelation) return { rows: [] };
        const mutated = (options.mutateAclDuringText === true && textualReads > 0) ||
          (options.mutateAclAfterPrivilege === true && privilegeReads > 0);
        const row = {
          relation_name: options.relationName ?? "schema_migrations",
          relation_oid: options.relationOid ?? 6101,
          relation_kind: options.relationKind ?? "r",
          relation_acl: mutated ? "{mutated_relation_acl}" : "{synthetic_relation_acl}"
        };
        return { rows: options.duplicateRelation ? [row, { ...row }] : [row] };
      }
      if (sql.includes("AS role_name")) {
        return { rows: roleRows() };
      }
      throw new Error(`unexpected runtime attributes query: ${sql}`);
    }

    release(error) {
      if (!this.checkedOut) return;
      releaseCalls += 1;
      releaseErrors.push(error?.code || null);
      this.checkedOut = false;
      if (options.releaseFailureAt === releaseCalls) {
        throw postgresError(options.releaseFailureCode || "runtime_attributes_release_failed");
      }
      available.push(this);
    }
  }

  const migration = {
    async connect() {
      const client = available.pop() || new Client();
      client.checkedOut = true;
      return client;
    }
  };
  return {
    state: { pools: { migration } },
    calls,
    clients,
    releaseErrors,
    get catalogReads() { return catalogReads; },
    get identityReads() { return identityReads; },
    get privilegeReads() { return privilegeReads; },
    get releaseCalls() { return releaseCalls; },
    get rollbackCalls() { return rollbackCalls; },
    get textualReads() { return textualReads; }
  };
}

function reproductionProof(overrides = {}) {
  return Object.freeze({
    runtimeWriteContractReproductionPassed: true,
    tenantSeedsCreatedByAdministrativeRole: true,
    runtimeCoreUserInsertPrivilege: false,
    runtimeCoreUserInsertRefused: true,
    runtimeCoreUserInsertPersisted: false,
    runtimePoolUsableAfterRefusal: true,
    runtimePrivilegesUnchanged: true,
    socialAuditEventInsertPrivilege: true,
    socialAuditEventsRlsProtected: true,
    oldGateLaterStagesReached: false,
    ...overrides
  });
}

function runtimeAttributesProof(overrides = {}) {
  return Object.freeze({
    runtimeLoginAttributesSafe: true,
    runtimeRoleAttributesSafe: true,
    runtimeLoginMigratorMember: false,
    runtimeRoleMigratorMember: false,
    runtimeLoginOwnerMember: false,
    runtimeRoleOwnerMember: false,
    runtimeLoginMigrationSchemaUsage: false,
    runtimeRoleMigrationSchemaUsage: false,
    runtimeLoginMigrationSchemaCreate: false,
    runtimeRoleMigrationSchemaCreate: false,
    runtimeLoginMigrationTablePrivileges: false,
    runtimeRoleMigrationTablePrivileges: false,
    migrationSchemaLocatedByOid: true,
    migrationLedgerLocatedByOid: true,
    textualResolutionUsed: false,
    aclUnchanged: true,
    ...overrides
  });
}

test("runtime attributes phase exposes the closed OID contract", () => {
  assert.equal(typeof runRuntimeAttributesTextResolutionReproduction, "function");
  assert.equal(Object.keys(runtimeAttributesProof()).length, 16);
});

test("runtime attributes phase reproduces textual 42501 before the exact OID inventory", async () => {
  const database = createRuntimeAttributesDatabase();
  const substeps = [];
  const result = await runRuntimeAttributesTextResolutionReproduction(database.state, {
    async runSubstep(name, operation) {
      substeps.push(name);
      return operation();
    }
  });
  assert.deepEqual(result, runtimeAttributesProof());
  assert.deepEqual(Object.keys(result), Object.keys(runtimeAttributesProof()));
  assert.deepEqual(substeps, [
    "rls_runtime_attributes_direct_identity",
    "rls_runtime_attributes_text_resolution_refusal",
    "rls_runtime_attributes_oid_catalog",
    "rls_runtime_attributes_oid_privileges",
    "rls_runtime_attributes_acl_reset"
  ]);
  assert.equal(database.textualReads, 1);
  assert.equal(database.privilegeReads, 1);
  assert.equal(database.identityReads, 3);
  const textualIndex = database.calls.findIndex((call) =>
    call.sql.includes("AS textual_runtime_privilege")
  );
  const oidIndex = database.calls.findIndex((call) =>
    call.sql.includes("AS runtime_login_superuser")
  );
  assert.ok(textualIndex >= 0 && textualIndex < oidIndex);
  const textual = database.calls[textualIndex];
  assert.deepEqual(textual.values, [RUNTIME_LOGIN]);
  assert.equal(textual.transactionStatus, "I");
  const oid = database.calls[oidIndex];
  assert.deepEqual(oid.values, [
    MIGRATION_LOGIN,
    "6100",
    "6101",
    "6101",
    "6103",
    "6104",
    "6105"
  ]);
  assert.match(oid.sql, /has_schema_privilege\(runtime_login\.oid,namespace\.oid,'USAGE'\)/);
  assert.match(oid.sql, /has_table_privilege\(runtime_role\.oid,relation\.oid,'MAINTAIN'\)/);
  assert.match(oid.sql, /pg_has_role\(runtime_role\.oid,owner_role\.oid,'MEMBER'\)/);
  assert.equal((oid.sql.match(/has_table_privilege\(/g) || []).length, 16);
  assert.equal((oid.sql.match(/has_schema_privilege\(/g) || []).length, 4);
  assert.equal((oid.sql.match(/pg_has_role\(/g) || []).length, 4);
  assert.doesNotMatch(oid.sql, /::\s*regclass|to_regclass|ia4tube_migrations\.schema_migrations/i);
  assert.equal(database.calls.some((call) =>
    /(?:^|\n)\s*(?:INSERT|UPDATE|DELETE|GRANT|REVOKE|ALTER|CREATE|DROP|TRUNCATE)\b/m.test(call.sql)
  ), false);
  assert.equal(database.clients.every((client) => client.checkedOut === false), true);
});

test("runtime attributes corrected path has one isolated textual relation and no fallback", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "scripts/social-3a0p-linux-physical-gates.js"),
    "utf8"
  );
  assert.equal((source.match(/'ia4tube_migrations\.schema_migrations'/g) || []).length, 1);
  assert.equal((source.match(/AS textual_runtime_privilege/g) || []).length, 1);
  assert.doesNotMatch(source, /::\s*regclass|to_regclass/i);
  assert.match(source, /FROM pg_catalog\.pg_namespace namespace/);
  assert.match(source, /FROM pg_catalog\.pg_class relation/);
  assert.match(source, /WHERE relation\.relnamespace=\$1::oid/);
  assert.match(source, /runtime_login\.oid=\$4::oid/);
  assert.match(source, /owner_role\.oid=\$7::oid/);
});

test("runtime attributes textual reproduction fails closed before OID privilege results", async () => {
  for (const [options, code] of [
    [{ textualFailureCode: "22P02" }, "linux_gate_runtime_attributes_text_resolution_invalid"],
    [{ textualQueryReturns: true }, "linux_gate_runtime_attributes_text_resolution_invalid"],
    [{ directPoolUsable: false }, "linux_gate_runtime_attributes_pool_state_invalid"],
    [{ directTransactionPersisted: true }, "linux_gate_runtime_attributes_pool_state_invalid"],
    [{ mutateAclDuringText: true }, "linux_gate_runtime_attributes_acl_changed"]
  ]) {
    const database = createRuntimeAttributesDatabase(options);
    const substeps = [];
    await assert.rejects(
      runRuntimeAttributesTextResolutionReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code }
    );
    assert.equal(substeps.at(-1), "rls_runtime_attributes_text_resolution_refusal");
    assert.equal(database.privilegeReads, 0);
    assert.equal(database.clients.every((client) => client.checkedOut === false), true);
  }
});

test("runtime attributes reproduction requires exact direct identity booleans", async () => {
  for (const options of [
    { directSessionIdentity: false },
    { directCurrentIdentity: false },
    { directInheritsMigrator: true },
    { directSchemaUsage: true },
    { omitDirectIdentityField: "direct_schema_usage" }
  ]) {
    const database = createRuntimeAttributesDatabase(options);
    await assert.rejects(
      runRuntimeAttributesTextResolutionReproduction(database.state, {
        runSubstep: (_name, operation) => operation()
      }),
      { code: "linux_gate_runtime_attributes_direct_identity_invalid" }
    );
    assert.equal(database.textualReads, 0);
    assert.equal(database.privilegeReads, 0);
  }
});

test("runtime attributes reproduction requires idle physical state and cleans contaminated clients", async () => {
  for (const initialTransactionStatus of ["T", "E", "absent"]) {
    const database = createRuntimeAttributesDatabase({ initialTransactionStatus });
    const substeps = [];
    await assert.rejects(
      runRuntimeAttributesTextResolutionReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code: "linux_gate_runtime_attributes_transaction_state_invalid" }
    );
    assert.equal(substeps.at(-1), "rls_runtime_attributes_direct_identity");
    assert.equal(database.rollbackCalls, initialTransactionStatus === "absent" ? 0 : 1);
    assert.equal(database.releaseCalls, 1);
  }
  const afterText = createRuntimeAttributesDatabase({ afterTextTransactionStatus: "T" });
  const substeps = [];
  await assert.rejects(
    runRuntimeAttributesTextResolutionReproduction(afterText.state, {
      async runSubstep(name, operation) {
        substeps.push(name);
        return operation();
      }
    }),
    { code: "linux_gate_runtime_attributes_transaction_state_invalid" }
  );
  assert.equal(substeps.at(-1), "rls_runtime_attributes_text_resolution_refusal");
  assert.equal(afterText.rollbackCalls, 1);
  assert.equal(afterText.releaseCalls, 1);
});

test("runtime attributes cleanup preserves primary and propagates cleanup-only failure", async () => {
  const primary = createRuntimeAttributesDatabase({
    initialTransactionStatus: "T",
    rollbackFailureCode: "runtime_attributes_rollback_failed",
    releaseFailureAt: 1
  });
  await assert.rejects(
    runRuntimeAttributesTextResolutionReproduction(primary.state, {
      runSubstep: (_name, operation) => operation()
    }),
    { code: "linux_gate_runtime_attributes_transaction_state_invalid" }
  );
  assert.equal(primary.rollbackCalls, 1);
  assert.equal(primary.releaseCalls, 1);
  assert.deepEqual(primary.releaseErrors, ["runtime_attributes_rollback_failed"]);

  const cleanupOnly = createRuntimeAttributesDatabase({ releaseFailureAt: 3 });
  const substeps = [];
  await assert.rejects(
    runRuntimeAttributesTextResolutionReproduction(cleanupOnly.state, {
      async runSubstep(name, operation) {
        substeps.push(name);
        return operation();
      }
    }),
    { code: "runtime_attributes_release_failed" }
  );
  assert.equal(substeps.at(-1), "rls_runtime_attributes_acl_reset");
  assert.equal(cleanupOnly.releaseCalls, 3);
});

test("runtime attributes OID catalog refuses schema, relation, relkind and role drift", async () => {
  for (const [options, code] of [
    [{ missingSchema: true }, "linux_gate_runtime_attributes_migration_schema_invalid"],
    [{ duplicateSchema: true }, "linux_gate_runtime_attributes_migration_schema_invalid"],
    [{ schemaName: "unexpected_schema" }, "linux_gate_runtime_attributes_migration_schema_invalid"],
    [{ schemaOid: 0 }, "linux_gate_runtime_attributes_migration_schema_invalid"],
    [{ missingRelation: true }, "linux_gate_runtime_attributes_migration_ledger_invalid"],
    [{ duplicateRelation: true }, "linux_gate_runtime_attributes_migration_ledger_invalid"],
    [{ relationName: "unexpected_relation" }, "linux_gate_runtime_attributes_migration_ledger_invalid"],
    [{ relationOid: 0 }, "linux_gate_runtime_attributes_migration_ledger_invalid"],
    [{ relationKind: "v" }, "linux_gate_runtime_attributes_migration_ledger_kind_invalid"],
    [{ missingRole: OWNER_ROLE }, "linux_gate_runtime_attributes_role_catalog_invalid"],
    [{ duplicateRole: true }, "linux_gate_runtime_attributes_role_catalog_invalid"],
    [{ invalidRoleOid: 0 }, "linux_gate_runtime_attributes_role_catalog_invalid"],
    [{ duplicateRoleOid: true }, "linux_gate_runtime_attributes_role_catalog_invalid"],
    [{ unexpectedRoleName: "unexpected_role" }, "linux_gate_runtime_attributes_role_catalog_invalid"]
  ]) {
    const database = createRuntimeAttributesDatabase(options);
    const substeps = [];
    await assert.rejects(
      runRuntimeAttributesTextResolutionReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code }
    );
    assert.equal(substeps.at(-1), "rls_runtime_attributes_oid_catalog");
    assert.equal(database.textualReads, 1);
    assert.equal(database.privilegeReads, 0);
  }
});

test("runtime attributes OID inventory refuses unsafe attributes and memberships separately", async () => {
  for (const [field, code] of [
    ["runtime_login_superuser", "linux_gate_runtime_login_attributes_unsafe"],
    ["runtime_login_bypassrls", "linux_gate_runtime_login_attributes_unsafe"],
    ["runtime_login_createdb", "linux_gate_runtime_login_attributes_unsafe"],
    ["runtime_login_createrole", "linux_gate_runtime_login_attributes_unsafe"],
    ["runtime_login_replication", "linux_gate_runtime_login_attributes_unsafe"],
    ["runtime_role_superuser", "linux_gate_runtime_role_attributes_unsafe"],
    ["runtime_role_bypassrls", "linux_gate_runtime_role_attributes_unsafe"],
    ["runtime_role_createdb", "linux_gate_runtime_role_attributes_unsafe"],
    ["runtime_role_createrole", "linux_gate_runtime_role_attributes_unsafe"],
    ["runtime_role_replication", "linux_gate_runtime_role_attributes_unsafe"],
    ["runtime_login_migrator_member", "linux_gate_runtime_login_migrator_membership_unexpected"],
    ["runtime_role_migrator_member", "linux_gate_runtime_role_migrator_membership_unexpected"],
    ["runtime_login_owner_member", "linux_gate_runtime_login_owner_membership_unexpected"],
    ["runtime_role_owner_member", "linux_gate_runtime_role_owner_membership_unexpected"]
  ]) {
    const database = createRuntimeAttributesDatabase({ privilegeOverrides: { [field]: true } });
    await assert.rejects(
      runRuntimeAttributesTextResolutionReproduction(database.state, {
        runSubstep: (_name, operation) => operation()
      }),
      { code }
    );
  }
});

test("runtime attributes OID inventory refuses migration schema privileges separately", async () => {
  for (const [field, code] of [
    ["runtime_login_schema_usage", "linux_gate_runtime_login_migration_schema_usage_unexpected"],
    ["runtime_role_schema_usage", "linux_gate_runtime_role_migration_schema_usage_unexpected"],
    ["runtime_login_schema_create", "linux_gate_runtime_login_migration_schema_create_unexpected"],
    ["runtime_role_schema_create", "linux_gate_runtime_role_migration_schema_create_unexpected"]
  ]) {
    const database = createRuntimeAttributesDatabase({ privilegeOverrides: { [field]: true } });
    await assert.rejects(
      runRuntimeAttributesTextResolutionReproduction(database.state, {
        runSubstep: (_name, operation) => operation()
      }),
      { code }
    );
  }
});

test("runtime attributes OID inventory refuses every migration table privilege for both subjects", async () => {
  const privileges = [
    "select",
    "insert",
    "update",
    "delete",
    "truncate",
    "references",
    "trigger",
    "maintain"
  ];
  for (const subject of ["runtime_login", "runtime_role"]) {
    for (const privilege of privileges) {
      const field = `${subject}_table_${privilege}`;
      const database = createRuntimeAttributesDatabase({ privilegeOverrides: { [field]: true } });
      await assert.rejects(
        runRuntimeAttributesTextResolutionReproduction(database.state, {
          runSubstep: (_name, operation) => operation()
        }),
        {
          code: subject === "runtime_login"
            ? "linux_gate_runtime_login_migration_table_privilege_unexpected"
            : "linux_gate_runtime_role_migration_table_privilege_unexpected"
        }
      );
    }
  }
});

test("runtime attributes OID inventory refuses null and omitted security booleans", async () => {
  const expectedCodes = {
    runtime_login_superuser: "linux_gate_runtime_login_attributes_unsafe",
    runtime_login_bypassrls: "linux_gate_runtime_login_attributes_unsafe",
    runtime_login_createdb: "linux_gate_runtime_login_attributes_unsafe",
    runtime_login_createrole: "linux_gate_runtime_login_attributes_unsafe",
    runtime_login_replication: "linux_gate_runtime_login_attributes_unsafe",
    runtime_role_superuser: "linux_gate_runtime_role_attributes_unsafe",
    runtime_role_bypassrls: "linux_gate_runtime_role_attributes_unsafe",
    runtime_role_createdb: "linux_gate_runtime_role_attributes_unsafe",
    runtime_role_createrole: "linux_gate_runtime_role_attributes_unsafe",
    runtime_role_replication: "linux_gate_runtime_role_attributes_unsafe",
    runtime_login_migrator_member: "linux_gate_runtime_login_migrator_membership_unexpected",
    runtime_role_migrator_member: "linux_gate_runtime_role_migrator_membership_unexpected",
    runtime_login_owner_member: "linux_gate_runtime_login_owner_membership_unexpected",
    runtime_role_owner_member: "linux_gate_runtime_role_owner_membership_unexpected",
    runtime_login_schema_usage: "linux_gate_runtime_login_migration_schema_usage_unexpected",
    runtime_role_schema_usage: "linux_gate_runtime_role_migration_schema_usage_unexpected",
    runtime_login_schema_create: "linux_gate_runtime_login_migration_schema_create_unexpected",
    runtime_role_schema_create: "linux_gate_runtime_role_migration_schema_create_unexpected"
  };
  for (const subject of ["runtime_login", "runtime_role"]) {
    for (const privilege of [
      "select", "insert", "update", "delete", "truncate", "references", "trigger", "maintain"
    ]) {
      expectedCodes[`${subject}_table_${privilege}`] = subject === "runtime_login"
        ? "linux_gate_runtime_login_migration_table_privilege_unexpected"
        : "linux_gate_runtime_role_migration_table_privilege_unexpected";
    }
  }
  for (const [field, code] of Object.entries(expectedCodes)) {
    for (const options of [
      { privilegeOverrides: { [field]: null } },
      { omitPrivilegeField: field }
    ]) {
      const database = createRuntimeAttributesDatabase(options);
      await assert.rejects(
        runRuntimeAttributesTextResolutionReproduction(database.state, {
          runSubstep: (_name, operation) => operation()
        }),
        { code }
      );
    }
  }
});

test("runtime attributes OID inventory refuses result drift and resets after exceptions", async () => {
  for (const [options, code, lastSubstep] of [
    [
      { inventorySessionIdentity: false },
      "linux_gate_runtime_attributes_oid_inventory_invalid",
      "rls_runtime_attributes_oid_privileges"
    ],
    [
      { inventoryCurrentIdentity: false },
      "linux_gate_runtime_attributes_oid_inventory_invalid",
      "rls_runtime_attributes_oid_privileges"
    ],
    [
      { missingPrivilegeRow: true },
      "linux_gate_runtime_attributes_oid_inventory_invalid",
      "rls_runtime_attributes_oid_privileges"
    ],
    [
      { duplicatePrivilegeRow: true },
      "linux_gate_runtime_attributes_oid_inventory_invalid",
      "rls_runtime_attributes_oid_privileges"
    ],
    [
      { mutateAclAfterPrivilege: true },
      "linux_gate_runtime_attributes_acl_changed",
      "rls_runtime_attributes_acl_reset"
    ],
    [
      { resetIdentityDrift: true },
      "linux_gate_runtime_attributes_direct_identity_invalid",
      "rls_runtime_attributes_acl_reset"
    ]
  ]) {
    const database = createRuntimeAttributesDatabase(options);
    const substeps = [];
    await assert.rejects(
      runRuntimeAttributesTextResolutionReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code }
    );
    assert.equal(substeps.at(-1), lastSubstep);
    assert.equal(database.clients.every((client) => client.checkedOut === false), true);
  }
});

test("runtime privilege inventory refuses a raw pool before any query", async () => {
  let queried = false;
  const rawPool = {
    async connect() { throw new Error("must not connect"); },
    async query() {
      queried = true;
      throw new Error("must not query");
    }
  };
  await assert.rejects(
    runtimeWritePrivilegeInventory(rawPool),
    { code: "linux_gate_rls_privilege_inventory_client_required" }
  );
  assert.equal(queried, false);
});

test("runtime privilege inventory refuses an isolated client without the private transaction authorization", async () => {
  const database = createInventoryContextDatabase();
  const client = database.authorizedClient();
  await assert.rejects(
    runtimeWritePrivilegeInventory(client),
    { code: "linux_gate_rls_privilege_inventory_transaction_client_required" }
  );
  assert.equal(database.inventoryReads, 0);
  client.release();
});

test("runtime privilege inventory refuses idle or missing physical transaction status", async () => {
  for (const transactionStatusAfterBegin of ["I", "absent"]) {
    const database = createInventoryContextDatabase({ transactionStatusAfterBegin });
    const substeps = [];
    await assert.rejects(
      runRlsPrivilegeInventoryContextReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code: "linux_gate_rls_privilege_inventory_transaction_client_required" }
    );
    assert.equal(substeps.at(-1), "rls_inventory_migrator_privilege_read");
    assert.equal(database.inventoryReads, 0);
    assert.equal(database.calls.some((call) => call.sql === "ROLLBACK"), true);
  }
});

test("runtime privilege inventory refuses missing or duplicate catalog relations", async () => {
  for (const options of [
    { missingUsers: true },
    { missingAudit: true },
    { duplicateRelation: true }
  ]) {
    const database = createInventoryContextDatabase(options);
    await assert.rejects(
      runRlsPrivilegeInventoryContextReproduction(database.state, {
        runSubstep: (_name, operation) => operation()
      }),
      { code: "linux_gate_rls_privilege_inventory_relations_invalid" }
    );
  }
});

test("runtime privilege inventory refuses identity, schema, OID and relkind drift", async () => {
  for (const options of [
    { inventorySessionUserMigration: false },
    { inventoryCurrentUserMigrator: false },
    { inventorySchemaName: "unexpected_schema" },
    { userSchemaName: "unexpected_schema" },
    { userRelationKind: "v" },
    { inventoryNamespaceOid: 0 },
    { userNamespaceOid: 4103 },
    { userRelationOid: 0 },
    { userRelationOid: 4101 }
  ]) {
    const database = createInventoryContextDatabase(options);
    await assert.rejects(
      runRlsPrivilegeInventoryContextReproduction(database.state, {
        runSubstep: (_name, operation) => operation()
      }),
      { code: "linux_gate_rls_privilege_inventory_context_invalid" }
    );
  }
});

test("runtime privilege inventory refuses null or omitted negative users privileges", async () => {
  for (const options of [
    { userRuntimeLoginInsertRaw: null },
    { omitUserRuntimeLoginInsert: true },
    { userRuntimeInsertRaw: null },
    { omitUserRuntimeInsert: true }
  ]) {
    const database = createInventoryContextDatabase(options);
    const substeps = [];
    await assert.rejects(
      runRlsPrivilegeInventoryContextReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code: "linux_gate_rls_core_user_insert_privilege_unexpected" }
    );
    assert.equal(substeps.at(-1), "rls_inventory_migrator_privilege_read");
    assert.equal(database.inventoryReads, 1);
  }
});

test("corrected inventory contains no textual regclass path outside the isolated negative proof", () => {
  const inventorySource = runtimeWritePrivilegeInventory.toString();
  assert.match(inventorySource, /pg_catalog\.pg_class/);
  assert.match(inventorySource, /pg_catalog\.pg_namespace/);
  assert.match(
    inventorySource,
    /has_schema_privilege\(current_user,namespace\.oid,'USAGE'\)/
  );
  assert.equal(
    (inventorySource.match(/has_table_privilege\(\$[34],relation\.oid,'INSERT'\)/g) || []).length,
    2
  );
  assert.match(inventorySource, /policy\.polrelid=relation\.oid/);
  assert.doesNotMatch(inventorySource, /::\s*regclass|to_regclass/i);
  assert.doesNotMatch(inventorySource, /pg_stat_activity|xact_start|query_start/);
  assert.doesNotMatch(
    inventorySource,
    /has_table_privilege\([^\n]*['"]ia4tube_social\.(?:users|social_audit_events)/
  );
  const fullSource = fs.readFileSync(
    path.join(ROOT, "scripts/social-3a0p-linux-physical-gates.js"),
    "utf8"
  );
  assert.equal((fullSource.match(/'ia4tube_social\.users'/g) || []).length, 1);
  assert.match(fullSource, /AS direct_runtime_insert/);
  assert.match(fullSource, /const AUTHORIZED_RLS_INVENTORY_CLIENTS = new WeakSet\(\)/);
  assert.match(fullSource, /AUTHORIZED_RLS_INVENTORY_CLIENTS\.add\(client\)/);
  assert.match(fullSource, /AUTHORIZED_RLS_INVENTORY_CLIENTS\.delete\(client\)/);
  assert.match(fullSource, /client\._txStatus !== "T"/);
});

test("inventory context reproduction closes direct refusal, migrator inventory, reset and ACL proof", async () => {
  const database = createInventoryContextDatabase();
  const substeps = [];
  const result = await runRlsPrivilegeInventoryContextReproduction(database.state, {
    async runSubstep(name, operation) {
      substeps.push(name);
      return operation();
    }
  });
  assert.deepEqual(result, inventoryContextProof());
  assert.deepEqual(Object.keys(result), Object.keys(inventoryContextProof()));
  assert.deepEqual(substeps, [
    "rls_inventory_direct_session_identity",
    "rls_inventory_direct_schema_access",
    "rls_inventory_direct_name_resolution_refusal",
    "rls_inventory_migrator_role_activation",
    "rls_inventory_migrator_privilege_read",
    "rls_inventory_role_reset"
  ]);
  assert.equal(database.inventoryReads, 1);
  const beginIndex = database.calls.findIndex((call) => call.sql === "BEGIN");
  const roleIndex = database.calls.findIndex((call) =>
    call.sql === `SET LOCAL ROLE "${MIGRATOR_ROLE}"`
  );
  const inventoryIndex = database.calls.findIndex((call) =>
    call.sql.includes("AS relation_name") && call.sql.includes("AS runtime_insert")
  );
  const commitIndex = database.calls.findIndex((call, index) =>
    index > inventoryIndex && call.sql === "COMMIT"
  );
  assert.ok(beginIndex >= 0 && beginIndex < roleIndex);
  assert.ok(roleIndex < inventoryIndex && inventoryIndex < commitIndex);
  assert.equal(database.calls[inventoryIndex].inTransaction, true);
  assert.equal(database.calls[inventoryIndex].transactionStatus, "T");
  assert.equal(database.calls[inventoryIndex].currentUser, MIGRATOR_ROLE);
  assert.deepEqual(database.calls[inventoryIndex].values, [
    MIGRATION_LOGIN,
    MIGRATOR_ROLE,
    RUNTIME_LOGIN,
    RUNTIME_ROLE
  ]);
  assert.equal(database.calls.some((call) =>
    call.sql.includes("AS direct_runtime_insert") && call.currentUser !== MIGRATION_LOGIN
  ), false);
  assert.equal(database.clients.every((client) =>
    client.inTransaction === false && client.currentUser === MIGRATION_LOGIN && client.checkedOut === false
  ), true);
  assert.equal(database.calls.some((call) =>
    /(?:^|\n)\s*(?:INSERT|UPDATE|DELETE|GRANT|REVOKE|ALTER|CREATE|DROP|TRUNCATE)\b/m.test(call.sql)
  ), false);
  const callCountAfterReproduction = database.calls.length;
  await assert.rejects(
    runtimeWritePrivilegeInventory(database.clients.at(-1)),
    { code: "linux_gate_rls_privilege_inventory_transaction_client_required" }
  );
  assert.equal(database.calls.length, callCountAfterReproduction);
});

test("OID inventory refuses every RLS and exact policy component divergence", async () => {
  for (const [options, code] of [
    [{ auditRlsEnabled: false }, "linux_gate_rls_social_audit_rls_disabled"],
    [{ auditForceRls: false }, "linux_gate_rls_social_audit_force_rls_disabled"],
    [{ auditPolicyExists: false }, "linux_gate_rls_social_audit_policy_missing"],
    [{ auditPolicyUsing: false }, "linux_gate_rls_social_audit_policy_using_missing"],
    [
      { auditPolicyWithCheck: false },
      "linux_gate_rls_social_audit_policy_with_check_missing"
    ],
    [
      { auditPolicyCompanyBound: false },
      "linux_gate_rls_social_audit_policy_company_scope_missing"
    ]
  ]) {
    const database = createInventoryContextDatabase(options);
    const substeps = [];
    await assert.rejects(
      runRlsPrivilegeInventoryContextReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code }
    );
    assert.equal(substeps.at(-1), "rls_inventory_migrator_privilege_read");
  }
});

test("inventory context reproduction stops at each direct-session divergence", async () => {
  for (const [options, code, lastSubstep] of [
    [
      { directCanSetMigrator: false },
      "linux_gate_rls_inventory_direct_session_invalid",
      "rls_inventory_direct_session_identity"
    ],
    [
      { directSchemaUsage: true },
      "linux_gate_rls_inventory_direct_schema_access_unexpected",
      "rls_inventory_direct_schema_access"
    ],
    [
      { directFailureCode: "22P02" },
      "linux_gate_rls_inventory_direct_name_resolution_invalid",
      "rls_inventory_direct_name_resolution_refusal"
    ],
    [
      { directPoolUsable: false },
      "linux_gate_rls_inventory_direct_pool_state_invalid",
      "rls_inventory_direct_name_resolution_refusal"
    ]
  ]) {
    const database = createInventoryContextDatabase(options);
    const substeps = [];
    await assert.rejects(
      runRlsPrivilegeInventoryContextReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code }
    );
    assert.equal(substeps.at(-1), lastSubstep);
    assert.equal(database.inventoryReads, 0);
    assert.equal(substeps.includes("rls_inventory_migrator_privilege_read"), false);
  }
});

test("unexpected schema USAGE under MIGRATOR_ROLE stops before the OID inventory and Gate 2", async () => {
  const database = createInventoryContextDatabase({ migratorSchemaUsage: true });
  const substeps = [];
  await assert.rejects(
    runRlsPrivilegeInventoryContextReproduction(database.state, {
      async runSubstep(name, operation) {
        substeps.push(name);
        return operation();
      }
    }),
    { code: "linux_gate_rls_inventory_migrator_schema_privilege_unexpected" }
  );
  assert.equal(substeps.at(-1), "rls_inventory_migrator_role_activation");
  assert.equal(substeps.includes("rls_inventory_migrator_privilege_read"), false);
  assert.equal(database.inventoryReads, 0);
  assert.equal(database.calls.some((call) => call.sql === "ROLLBACK"), true);
  assert.equal(database.clients.every((client) =>
    client.inTransaction === false && client.currentUser === MIGRATION_LOGIN
  ), true);
});

test("inventory exceptions roll back and reset the activated migrator role", async () => {
  const database = createInventoryContextDatabase({ inventoryFailure: true });
  const substeps = [];
  await assert.rejects(
    runRlsPrivilegeInventoryContextReproduction(database.state, {
      async runSubstep(name, operation) {
        substeps.push(name);
        return operation();
      }
    }),
    { code: "synthetic_inventory_failure" }
  );
  assert.equal(substeps.at(-1), "rls_inventory_migrator_privilege_read");
  assert.equal(database.calls.some((call) => call.sql === "ROLLBACK"), true);
  assert.equal(database.clients.every((client) =>
    client.inTransaction === false && client.currentUser === MIGRATION_LOGIN && client.checkedOut === false
  ), true);
});

test("inventory context reproduction rejects role leaks and ACL changes in its reset substep", async () => {
  for (const [options, code] of [
    [{ roleLeakAfterTransaction: true }, "linux_gate_rls_inventory_role_reset_invalid"],
    [{ aclMutationAfterDirectRefusal: true }, "linux_gate_rls_inventory_acl_changed"]
  ]) {
    const database = createInventoryContextDatabase(options);
    const substeps = [];
    await assert.rejects(
      runRlsPrivilegeInventoryContextReproduction(database.state, {
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code }
    );
    assert.equal(substeps.at(-1), "rls_inventory_role_reset");
  }
});

test("old runtime write contract reproduces 42501 before every corrected write stage", async () => {
  const database = createRlsDatabase();
  const substeps = [];
  const result = await runRlsRuntimeWriteContractReproduction(database.state, {
    inventoryContextReproduction: inventoryContextProof(),
    legacyFailureCode,
    async runSubstep(name, operation) {
      substeps.push(name);
      return operation();
    }
  });
  assert.deepEqual(result, reproductionProof());
  assert.deepEqual(substeps, [
    "rls_seed_tenants",
    "rls_inventory_migrator_privilege_read",
    "rls_core_user_insert_reproduction",
    "rls_core_user_insert_refusal",
    "rls_inventory_migrator_privilege_read"
  ]);
  const runtimeUserWrites = database.calls.filter((call) =>
    call.kind === "runtime" && call.sql.includes("INSERT INTO ia4tube_social.users")
  );
  assert.equal(runtimeUserWrites.length, 1);
  assert.equal(database.calls.some((call) =>
    call.sql.includes("INSERT INTO ia4tube_social.social_audit_events")
  ), false);
  assert.equal(database.users.size, 2);
  assert.equal(database.calls.filter((call) => call.sql === "ROLLBACK").length, 1);
  assert.equal(database.calls.some((call) => call.sql.includes("SELECT 1::integer AS n")), true);
});

test("reproduction stops before the old insert when runtime unexpectedly owns users INSERT", async () => {
  const database = createRlsDatabase({ userInsertPrivilege: true });
  const substeps = [];
  await assert.rejects(
    runRlsRuntimeWriteContractReproduction(database.state, {
      inventoryContextReproduction: inventoryContextProof(),
      legacyFailureCode,
      async runSubstep(name, operation) {
        substeps.push(name);
        return operation();
      }
    }),
    { code: "linux_gate_rls_core_user_insert_privilege_unexpected" }
  );
  assert.deepEqual(substeps, ["rls_seed_tenants", "rls_inventory_migrator_privilege_read"]);
  assert.equal(database.calls.some((call) =>
    call.kind === "runtime" && call.sql.includes("INSERT INTO ia4tube_social.users")
  ), false);
});

test("privilege inventory seals SET ROLE and refuses direct login identity writes", async () => {
  for (const [options, code] of [
    [{ runtimeLoginCanSetRole: false }, "linux_gate_rls_runtime_role_set_missing"],
    [{ runtimeLoginUserInsertPrivilege: true }, "linux_gate_rls_core_user_insert_privilege_unexpected"]
  ]) {
    const database = createRlsDatabase(options);
    await assert.rejects(
      runRlsRuntimeWriteContractReproduction(database.state, {
        inventoryContextReproduction: inventoryContextProof(),
        legacyFailureCode,
        runSubstep: (_name, operation) => operation()
      }),
      { code }
    );
    assert.equal(database.calls.some((call) =>
      call.kind === "runtime" && call.sql.includes("INSERT INTO ia4tube_social.users")
    ), false);
  }
});

test("privilege inventory pins the exact audit policy and both tenant expressions", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "scripts/social-3a0p-linux-physical-gates.js"),
    "utf8"
  );
  assert.match(source, /policy\.polname='social_audit_events_company_scope'/);
  assert.match(source, /policy\.polroles=ARRAY\[0::oid\]/);
  assert.match(source, /pg_get_expr\(policy\.polqual,policy\.polrelid\)/);
  assert.match(source, /pg_get_expr\(policy\.polwithcheck,policy\.polrelid\)/);
  assert.equal((source.match(/\/length\('company_id'\)>=2/g) || []).length, 2);
  assert.match(source, /position\('ia4tube\.company_id'/);
});

test("reproduction fails closed when users refusal or audit write surface diverges", async () => {
  for (const [options, code] of [
    [{ userInsertFailureCode: "23505" }, "linux_gate_rls_core_user_insert_reproduction_invalid"],
    [{ auditInsertPrivilege: false }, "linux_gate_rls_social_audit_insert_privilege_missing"],
    [{ auditRlsEnabled: false }, "linux_gate_rls_social_audit_rls_disabled"],
    [{ auditForceRls: false }, "linux_gate_rls_social_audit_force_rls_disabled"],
    [{ auditPolicyExists: false }, "linux_gate_rls_social_audit_policy_missing"],
    [{ auditPolicyUsing: false }, "linux_gate_rls_social_audit_policy_using_missing"],
    [
      { auditPolicyWithCheck: false },
      "linux_gate_rls_social_audit_policy_with_check_missing"
    ],
    [
      { auditPolicyCompanyBound: false },
      "linux_gate_rls_social_audit_policy_company_scope_missing"
    ],
    [{ auditPolicyAppliesToRuntime: false }, "linux_gate_rls_social_audit_policy_missing"]
  ]) {
    const database = createRlsDatabase(options);
    await assert.rejects(
      runRlsRuntimeWriteContractReproduction(database.state, {
        inventoryContextReproduction: inventoryContextProof(),
        legacyFailureCode,
        runSubstep: (_name, operation) => operation()
      }),
      { code }
    );
    assert.equal(database.calls.some((call) =>
      call.sql.includes("INSERT INTO ia4tube_social.social_audit_events")
    ), false);
  }
});

test("every post-insert reproduction failure retains its exact closed substep", async () => {
  for (const [options, code, lastSubstep] of [
    [{ persistUserOnRuntimeFailure: true }, "linux_gate_rls_core_user_insert_persisted", "rls_core_user_insert_refusal"],
    [{ runtimePoolReusable: false }, "linux_gate_rls_runtime_pool_unusable_after_refusal", "rls_core_user_insert_refusal"],
    [
      { mutatePrivilegeAfterRefusal: true },
      "linux_gate_rls_core_user_insert_privilege_unexpected",
      "rls_inventory_migrator_privilege_read"
    ],
    [
      { mutateAclAfterRefusal: true },
      "linux_gate_rls_runtime_privilege_changed",
      "rls_inventory_migrator_privilege_read"
    ]
  ]) {
    const database = createRlsDatabase(options);
    const substeps = [];
    await assert.rejects(
      runRlsRuntimeWriteContractReproduction(database.state, {
        inventoryContextReproduction: inventoryContextProof(),
        legacyFailureCode,
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code }
    );
    assert.equal(substeps.at(-1), lastSubstep);
    assert.equal(substeps.includes("rls_own_social_write"), false);
  }
});

test("reproduction requires the old numeric SQLSTATE classification in the physical substep", async () => {
  for (const classifier of [undefined, () => "postgres_insufficient_privilege"]) {
    const database = createRlsDatabase();
    const substeps = [];
    await assert.rejects(
      runRlsRuntimeWriteContractReproduction(database.state, {
        inventoryContextReproduction: inventoryContextProof(),
        legacyFailureCode: classifier,
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code: "linux_gate_rls_legacy_failure_classification_invalid" }
    );
    assert.equal(substeps.at(-1), "rls_core_user_insert_reproduction");
  }
});

test("corrected RLS gate has no fallback around base or reproduction prerequisites", async () => {
  const runSubstep = (_name, operation) => operation();
  const baseMissing = createRlsDatabase();
  await assert.rejects(
    runRlsAndRoleGate(baseMissing.state, { runSubstep, reproduction: reproductionProof() }),
    { code: "linux_gate_rls_base_gate_prerequisite_missing" }
  );
  assert.equal(baseMissing.calls.length, 0);
  for (const reproduction of [
    undefined,
    reproductionProof({ runtimeCoreUserInsertRefused: false })
  ]) {
    const database = createRlsDatabase();
    const substeps = [];
    await assert.rejects(
      runRlsAndRoleGate(database.state, {
        baseRlsGatePassed: true,
        runtimeAttributesTextResolutionReproduction: runtimeAttributesProof(),
        reproduction,
        async runSubstep(name, operation) {
          substeps.push(name);
          return operation();
        }
      }),
      { code: "linux_gate_rls_runtime_write_reproduction_required" }
    );
    assert.deepEqual(substeps, ["rls_seed_tenants", "rls_core_user_insert_refusal"]);
    assert.equal(database.calls.some((call) =>
      call.sql.includes("INSERT INTO ia4tube_social.social_audit_events")
    ), false);
  }
});

test("corrected RLS gate requires the exact runtime attributes proof before tenant work", async () => {
  for (const runtimeAttributesTextResolutionReproduction of [
    undefined,
    runtimeAttributesProof({ runtimeRoleMigrationTablePrivileges: true })
  ]) {
    const database = createRlsDatabase();
    await assert.rejects(
      runRlsAndRoleGate(database.state, {
        baseRlsGatePassed: true,
        reproduction: reproductionProof(),
        runtimeAttributesTextResolutionReproduction,
        runSubstep: (_name, operation) => operation()
      }),
      { code: "linux_gate_runtime_attributes_reproduction_required" }
    );
    assert.equal(database.calls.length, 0);
  }
});

test("corrected RLS gate writes own audit events and rejects both cross-tenant directions", async () => {
  const database = createRlsDatabase();
  const substeps = [];
  const result = await runRlsAndRoleGate(database.state, {
    baseRlsGatePassed: true,
    runtimeAttributesTextResolutionReproduction: runtimeAttributesProof(),
    reproduction: reproductionProof(),
    async runSubstep(name, operation) {
      substeps.push(name);
      return operation();
    }
  });
  assert.deepEqual(substeps, [
    "rls_seed_tenants",
    "rls_core_user_insert_refusal",
    "rls_bidirectional_read",
    "rls_missing_context",
    "rls_tampered_context",
    "rls_own_social_write",
    "rls_cross_tenant_write",
    "rls_connection_scope_reset"
  ]);
  assert.deepEqual(result, {
    baseRlsGatePassed: true,
    tenantSeedsCreatedByAdministrativeRole: true,
    runtimeCoreUserInsertPrivilege: false,
    runtimeCoreUserInsertRefused: true,
    runtimeCoreUserInsertPersisted: false,
    companyAOwnRead: true,
    companyBOwnRead: true,
    companyAToBReadRefused: true,
    companyBToAReadRefused: true,
    companyAOwnSocialWrite: true,
    companyBOwnSocialWrite: true,
    companyAToBWriteRefused: true,
    companyBToAWriteRefused: true,
    crossTenantRowsPersisted: false,
    missingContextZeroRows: true,
    tamperedContextRefused: true,
    connectionScopeReset: true,
    runtimeSuperuser: false,
    runtimeBypassRls: false,
    runtimeCreateDb: false,
    runtimeCreateRole: false,
    runtimeMigrationPrivileges: false
  });
  assert.equal(Object.keys(result).length, 22);
  assert.equal(database.auditEvents.size, 2);
  assert.equal(database.calls.filter((call) =>
    call.kind === "runtime" && call.sql.includes("INSERT INTO ia4tube_social.social_audit_events")
  ).length, 4);
  assert.equal(database.calls.some((call) =>
    call.kind === "runtime" && call.sql.includes("INSERT INTO ia4tube_social.users")
  ), false);
});

test("corrected RLS gate detects any cross-tenant event that remains persisted", async () => {
  const database = createRlsDatabase({ persistCrossBeforeFailure: true });
  await assert.rejects(
    runRlsAndRoleGate(database.state, {
      baseRlsGatePassed: true,
      runtimeAttributesTextResolutionReproduction: runtimeAttributesProof(),
      reproduction: reproductionProof(),
      runSubstep: (_name, operation) => operation()
    }),
    { code: "linux_gate_rls_cross_write_persisted" }
  );
});

test("connection reset preserves a primary failure while still attempting release", async () => {
  const database = createRlsDatabase({
    connectionScopeLeaks: true,
    manualScopeReleaseFailure: true
  });
  const substeps = [];
  await assert.rejects(
    runRlsAndRoleGate(database.state, {
      baseRlsGatePassed: true,
      runtimeAttributesTextResolutionReproduction: runtimeAttributesProof(),
      reproduction: reproductionProof(),
      async runSubstep(name, operation) {
        substeps.push(name);
        return operation();
      }
    }),
    { code: "linux_gate_rls_connection_context_leaked" }
  );
  assert.equal(substeps.at(-1), "rls_connection_scope_reset");
  assert.equal(database.releases.filter((entry) => entry.manualScopeClient).length, 1);
  assert.equal(database.calls.some((call) =>
    call.kind === "runtime" && call.sql === "ROLLBACK" && call.manualScopeClient
  ), true);
});

test("connection reset propagates a release-only failure from its closed substep", async () => {
  const database = createRlsDatabase({ manualScopeReleaseFailure: true });
  const substeps = [];
  await assert.rejects(
    runRlsAndRoleGate(database.state, {
      baseRlsGatePassed: true,
      runtimeAttributesTextResolutionReproduction: runtimeAttributesProof(),
      reproduction: reproductionProof(),
      async runSubstep(name, operation) {
        substeps.push(name);
        return operation();
      }
    }),
    { code: "release_cleanup_failed" }
  );
  assert.equal(substeps.at(-1), "rls_connection_scope_reset");
  assert.equal(database.releases.filter((entry) => entry.manualScopeClient).length, 1);
});

test("synthetic tenant context is locally derived and contains no external account", () => {
  const identityKey = Buffer.alloc(32, 7);
  const ids = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000004",
    "00000000-0000-4000-8000-000000000005",
    "00000000-0000-4000-8000-000000000006",
    "00000000-0000-4000-8000-000000000007",
    "00000000-0000-4000-8000-000000000008",
    "00000000-0000-4000-8000-000000000009"
  ];
  const tenant = createTenant("test-tenant", {
    identityKey,
    randomUUID: () => ids.shift()
  });
  assert.equal(tenant.context.provider, "instagram");
  assert.equal(tenant.context.environment, "test");
  assert.equal(tenant.context.companyId, tenant.fixture.companyId);
  assert.equal(tenant.context.userId, tenant.fixture.userId);
  assert.equal(Object.hasOwn(tenant.fixture, "accessToken"), false);
  identityKey.fill(0);
});

test("local verifier maps a verified synthetic TLS identity only to loopback", () => {
  const seen = [];
  class FakePool {
    constructor(configuration) {
      seen.push(configuration);
      return configuration;
    }
  }
  const passwords = {
    ia4tube_social_local_migration: "m".repeat(48),
    ia4tube_social_local_runtime: "r".repeat(48)
  };
  const LocalPool = createLocalVerifierPoolClass({
    PoolClass: FakePool,
    port: 49152,
    database: "ia4tube_social_local",
    passwords
  });
  const url = new URL("postgresql://local.ia4tube.invalid:49152/ia4tube_social_local");
  url.username = "ia4tube_social_local_runtime";
  url.password = passwords.ia4tube_social_local_runtime;
  const mapped = new LocalPool({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, servername: "local.ia4tube.invalid" },
    max: 2
  });
  assert.equal(mapped.host, "127.0.0.1");
  assert.equal(mapped.port, 49152);
  assert.equal(mapped.ssl, false);
  const bad = new URL(url);
  bad.hostname = "external.invalid";
  assert.throws(() => new LocalPool({
    connectionString: bad.toString(),
    ssl: { rejectUnauthorized: true, servername: "external.invalid" },
    max: 2
  }));
  assert.equal(seen.length, 1);
});

test("database plaintext probe is parameterized and never interpolates the marker", async () => {
  const marker = `synthetic-${crypto.randomBytes(24).toString("hex")}`;
  let call;
  const client = {
    async query(text, values) {
      if (String(text).includes("SELECT (")) {
        call = { text, values };
        return { rows: [{ present: false }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const pool = {
    async connect() { return client; }
  };
  const companyId = crypto.randomUUID();
  assert.equal(await databaseContainsMarker(pool, marker, companyId), false);
  assert.equal(call.text.includes(marker), false);
  assert.deepEqual(call.values, [marker]);
  assert.match(call.text, /social_encrypted_credentials/);
  assert.doesNotMatch(call.text, /social_credentials\b/);
});

test("supplemental Gate 3 exposes every closed S1-S30 pass-through boundary", () => {
  assert.equal(typeof runConcurrencyOAuthIdempotencyGate, "function");
  const source = fs.readFileSync(path.join(ROOT, "scripts/social-3a0p-linux-physical-gates.js"), "utf8");
  for (const [substep, _description, operationClass] of SUPPLEMENTAL_GATE3_SUBSTEPS) {
    assert.match(source, new RegExp(
      `runGate3Substep\\(\\s*[\"']${substep}[\"']\\s*,\\s*[\"']${operationClass}[\"']`
    ));
  }
  assert.match(source, /runGate3Substep\("S5", "postgres_concurrent_transactions", \(\) =>\s*Promise\.allSettled\(\[/);
  assert.match(source, /runGate3Substep\("S10", "postgres_concurrent_transactions", \(\) =>\s*Promise\.allSettled\(\[/);
  assert.match(source, /runGate3Substep\("S12", "postgres_concurrent_transactions", \(\) => Promise\.all\(\[/);
  assert.match(source, /runGate3Substep\("S22", "postgres_concurrent_transactions", \(\) =>\s*Promise\.all\(\[/);
  assert.equal((source.match(/runGate3Substep\("S(?:[1-9]|[12][0-9]|30)"/g) || []).length, 30);
});

test("S10-S12 source closes the consumed-state, cross-tenant and expiry code boundaries", () => {
  const source = supplementalGate3Source();
  const s10 = supplementalSubstepSource(source, "S10", "S11");
  const s11 = supplementalSubstepSource(source, "S11", "S12");
  const s12 = supplementalSubstepSource(source, "S12", "S13");
  const s16 = supplementalSubstepSource(source, "S16", "S17");
  const closedContract = [s10, s11, s12].join("\n");
  const exactRejectionSource = source.slice(
    source.indexOf("function exactRejection"),
    source.indexOf("async function expectErrorCode")
  );
  const expectErrorCodeSource = source.slice(
    source.indexOf("async function expectErrorCode"),
    source.indexOf("function requireSubstepRunner")
  );

  assert.match(s10, /Promise\.allSettled\(\[/);
  assert.equal((s10.match(/oauthA\.consumeAuthorization\(consume\)/g) || []).length, 2);
  assert.doesNotMatch(s10, /oauthB\.consumeAuthorization/);
  assert.match(
    s11,
    /exactRejection\(consumers, 1, "linux_gate_oauth_single_consumer_invalid", "social_oauth_state_already_consumed"\)/
  );
  assert.doesNotMatch(s11, /"authorization_expired"/);
  assert.match(
    s12,
    /expectErrorCode\(\(\) => oauthA\.consumeAuthorization\(consume\), "social_oauth_state_already_consumed", "linux_gate_oauth_replay_invalid"\)/
  );
  assert.match(
    s12,
    /expectErrorCode\(\(\) => oauthB\.consumeAuthorization\(consume\), "authorization_expired", "linux_gate_oauth_cross_company_invalid"\)/
  );
  assert.equal((closedContract.match(/"social_oauth_state_already_consumed"/g) || []).length, 2);
  assert.equal((closedContract.match(/"authorization_expired"/g) || []).length, 1);
  assert.doesNotMatch(
    closedContract,
    /\.(?:includes|startsWith|endsWith|match|test)\s*\(|\bRegExp\b|\bnew\s+Set\b|\bcatch\b|\|\|/
  );
  assert.match(exactRejectionSource, /item\.reason\?\.code === rejectedCode/);
  assert.match(expectErrorCodeSource, /if \(error\?\.code === expected\) return true;\s*fail\(code\);/);
  assert.doesNotMatch(
    `${exactRejectionSource}\n${expectErrorCodeSource}`,
    /\.(?:includes|startsWith|endsWith|match|test)\s*\(|\bRegExp\b|\bnew\s+Set\b/
  );
  assert.match(s16, /"authorization_expired"/);
  assert.doesNotMatch(s16, /"social_oauth_state_already_consumed"/);
});

test("S10-S12 synthetic contract permits either winner and preserves every exact refusal context", async () => {
  const raceOrders = [
    [
      { status: "fulfilled" },
      { status: "rejected", code: OAUTH_CONSUMED_STATE_CODE }
    ],
    [
      { status: "rejected", code: OAUTH_CONSUMED_STATE_CODE },
      { status: "fulfilled" }
    ]
  ];

  for (const s10ConsumerOutcomes of raceOrders) {
    const execution = await executeSupplementalGate3({
      s10ConsumerOutcomes,
      runGate3Substep: (_substep, _operationClass, operation) => operation()
    });
    const oauthCreates = execution.observations.oauthCalls.filter(
      ({ method }) => method === "createAuthorization"
    );
    const oauthConsumes = execution.observations.oauthCalls.filter(
      ({ method }) => method === "consumeAuthorization"
    );
    const primaryHandle = oauthCreates[0].arguments[0].authorizationHandle;
    const expiredHandle = oauthCreates[1].arguments[0].authorizationHandle;
    const expectedRaceOutcomes = s10ConsumerOutcomes.map((outcome) => outcome.status === "fulfilled"
      ? { tenant: "a", status: "fulfilled" }
      : { tenant: "a", status: "rejected", code: outcome.code });

    assert.equal(execution.didThrow, false);
    assert.deepEqual(execution.result, SUPPLEMENTAL_GATE3_RESULT);
    assert.equal(JSON.stringify(execution.result), JSON.stringify(SUPPLEMENTAL_GATE3_RESULT));
    assert.equal(execution.result.externalCalls, 0);
    assert.equal(Object.isFrozen(execution.result), true);
    assert.deepEqual(
      execution.runnerCalls.map(({ substep }) => substep),
      SUPPLEMENTAL_GATE3_SUBSTEPS.map(([substep]) => substep)
    );
    assert.deepEqual(
      [...execution.operationCounts.entries()],
      SUPPLEMENTAL_GATE3_SUBSTEPS.map(([substep]) => [substep, 1])
    );
    assert.equal(oauthCreates.length, 2);
    assert.equal(oauthCreates.every(({ tenant }) => tenant === "a"), true);
    assert.equal(execution.observations.oauthCalls.some(
      ({ method, tenant }) => method === "createAuthorization" && tenant === "b"
    ), false);
    assert.equal(oauthConsumes.length, 5);
    assert.deepEqual(oauthConsumes.map(({ tenant }) => tenant), ["a", "a", "a", "b", "a"]);
    assert.deepEqual(
      oauthConsumes.map(({ arguments: [input] }) => input.authorizationHandle),
      [primaryHandle, primaryHandle, primaryHandle, primaryHandle, expiredHandle]
    );
    assert.deepEqual(oauthConsumes[2].arguments[0], oauthConsumes[3].arguments[0]);
    assert.deepEqual(execution.observations.oauthOutcomes, [
      ...expectedRaceOutcomes,
      { tenant: "a", status: "rejected", code: OAUTH_CONSUMED_STATE_CODE },
      { tenant: "b", status: "rejected", code: OAUTH_EXPIRED_CODE },
      { tenant: "a", status: "rejected", code: OAUTH_EXPIRED_CODE }
    ]);
    assert.equal(
      execution.observations.oauthOutcomes[3].code === OAUTH_CONSUMED_STATE_CODE,
      false
    );
    assert.equal(execution.identityKey.every((byte) => byte === 0), true);
  }
});

test("S10-S12 S11 rejects every non-exact race result and still performs S30", async (context) => {
  const scenarios = [
    {
      name: "both consumers win",
      outcomes: [{ status: "fulfilled" }, { status: "fulfilled" }]
    },
    {
      name: "both consumers fail",
      outcomes: [
        { status: "rejected", code: OAUTH_CONSUMED_STATE_CODE },
        { status: "rejected", code: OAUTH_CONSUMED_STATE_CODE }
      ]
    },
    {
      name: "the loser returns authorization_expired",
      outcomes: [
        { status: "fulfilled" },
        { status: "rejected", code: OAUTH_EXPIRED_CODE }
      ]
    },
    {
      name: "the loser returns an unknown code",
      outcomes: [
        { status: "fulfilled" },
        { status: "rejected", code: "social_oauth_state_unknown" }
      ]
    },
    {
      name: "the loser has no code property",
      outcomes: [{ status: "fulfilled" }, { status: "rejected" }]
    },
    {
      name: "the loser returns a prefixed impostor",
      outcomes: [
        { status: "fulfilled" },
        { status: "rejected", code: `${OAUTH_CONSUMED_STATE_CODE}_extra` }
      ]
    }
  ];

  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const execution = await executeSupplementalGate3({
        s10ConsumerOutcomes: scenario.outcomes,
        runGate3Substep: (_substep, _operationClass, operation) => operation()
      });
      const steps = execution.runnerCalls.map(({ substep }) => substep);

      assert.equal(execution.didThrow, true);
      assert.equal(execution.thrown?.code, "linux_gate_oauth_single_consumer_invalid");
      assert.deepEqual(steps.slice(-2), ["S11", "S30"]);
      assert.equal(steps.includes("S12"), false);
      assert.equal(execution.operationCounts.get("S10"), 1);
      assert.equal(execution.operationCounts.get("S11"), 1);
      assert.equal(execution.operationCounts.has("S12"), false);
      assert.equal(execution.operationCounts.get("S30"), 1);
      assert.equal(execution.observations.oauthOutcomes.length, 2);
      assert.equal(execution.identityKey.every((byte) => byte === 0), true);
    });
  }
});

test("S10-S12 refuses same-tenant and cross-tenant code swaps without disclosure", async (context) => {
  const scenarios = [
    {
      name: "same-tenant consumed replay cannot collapse to authorization_expired",
      options: { sameTenantReplayCode: OAUTH_EXPIRED_CODE },
      failureCode: "linux_gate_oauth_replay_invalid"
    },
    {
      name: "cross-tenant lookup cannot reveal a consumed authorization",
      options: { crossTenantCode: OAUTH_CONSUMED_STATE_CODE },
      failureCode: "linux_gate_oauth_cross_company_invalid"
    }
  ];

  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const execution = await executeSupplementalGate3({
        ...scenario.options,
        runGate3Substep: (_substep, _operationClass, operation) => operation()
      });
      const steps = execution.runnerCalls.map(({ substep }) => substep);
      const oauthConsumes = execution.observations.oauthCalls.filter(
        ({ method }) => method === "consumeAuthorization"
      );

      assert.equal(execution.didThrow, true);
      assert.equal(execution.thrown?.code, scenario.failureCode);
      assert.deepEqual(steps.slice(-2), ["S12", "S30"]);
      assert.equal(steps.includes("S13"), false);
      assert.equal(execution.operationCounts.get("S12"), 1);
      assert.equal(execution.operationCounts.get("S30"), 1);
      assert.equal(oauthConsumes.length, 4);
      assert.deepEqual(oauthConsumes.map(({ tenant }) => tenant), ["a", "a", "a", "b"]);
      assert.deepEqual(oauthConsumes[2].arguments[0], oauthConsumes[3].arguments[0]);
      assert.equal(execution.observations.oauthOutcomes.length, 4);
      assert.equal(execution.identityKey.every((byte) => byte === 0), true);
    });
  }
});

test("S16 refuses the consumed-state code for a truly expired authorization", async () => {
  const execution = await executeSupplementalGate3({
    expiredCode: OAUTH_CONSUMED_STATE_CODE,
    runGate3Substep: (_substep, _operationClass, operation) => operation()
  });
  const steps = execution.runnerCalls.map(({ substep }) => substep);

  assert.equal(execution.didThrow, true);
  assert.equal(execution.thrown?.code, "linux_gate_oauth_expired_invalid");
  assert.deepEqual(steps.slice(-2), ["S16", "S30"]);
  assert.equal(steps.includes("S17"), false);
  assert.equal(execution.operationCounts.get("S16"), 1);
  assert.equal(execution.operationCounts.get("S30"), 1);
  assert.deepEqual(execution.observations.oauthOutcomes.at(-1), {
    tenant: "a",
    status: "rejected",
    code: OAUTH_CONSUMED_STATE_CODE
  });
  assert.equal(execution.identityKey.every((byte) => byte === 0), true);
});

test("S13-S16 S15 keeps the closed substep contract and deterministic SQL fixture", () => {
  const source = supplementalGate3Source();
  const s15 = supplementalSubstepSource(source, "S15", "S16");
  const s13 = source.indexOf('await runGate3Substep("S13"');
  const s14 = source.indexOf('await runGate3Substep("S14"');
  const s15Index = source.indexOf('await runGate3Substep("S15"');
  const s16 = source.indexOf('await runGate3Substep("S16"');

  assert.deepEqual(SUPPLEMENTAL_GATE3_SUBSTEPS.slice(12, 16), [
    ["S13", "supplemental_expired_oauth_material_setup", "internal_setup"],
    ["S14", "supplemental_expired_oauth_create", "postgres_transaction"],
    ["S15", "supplemental_oauth_force_expiry", "postgres_transaction"],
    ["S16", "supplemental_expired_oauth_consume", "postgres_transaction"]
  ]);
  assert.equal(s13 < s14 && s14 < s15Index && s15Index < s16, true);
  assert.equal((s15.match(/client\.query\(/g) || []).length, 1);
  assert.match(s15, /SET created_at=CURRENT_TIMESTAMP-INTERVAL '2 seconds',/);
  assert.match(s15, /expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second'/);
  assert.match(s15, /WHERE company_id=\$1 AND id=\$2/);
  assert.match(s15, /AND consumed_at IS NULL/);
  assert.match(s15, /AND cancelled_at IS NULL/);
  assert.match(s15, /AND failed_at IS NULL/);
  assert.match(s15, /id=\$2 AS id_matches/);
  assert.match(s15, /expires_at>created_at AS expiry_after_creation/);
  assert.match(s15, /expires_at<CURRENT_TIMESTAMP AS expiry_before_current/);
  assert.match(s15, /consumed_at IS NULL AS consumed_at_is_null/);
  assert.match(s15, /cancelled_at IS NULL AS cancelled_at_is_null/);
  assert.match(s15, /failed_at IS NULL AS failed_at_is_null/);
  assert.match(s15, /\[a\.fixture\.companyId, a\.fixture\.expiredAuthorizationId\]/);
  assert.equal((s15.match(/\sAS\s[a-z_]+/g) || []).length, 6);
  assert.match(s15, /forcedExpiry\?\.rowCount !== 1/);
  assert.match(s15, /forcedExpiry\.rows\?\.length !== 1/);
  assert.match(s15, /linux_gate_oauth_force_expiry_target_invalid/);
  assert.match(s15, /linux_gate_oauth_force_expiry_temporal_order_invalid/);
  assert.doesNotMatch(s15, /SET\s+expires_at\s*=\s*CURRENT_TIMESTAMP\s*-\s*INTERVAL/i);
  assert.doesNotMatch(
    s15,
    /\b(?:setTimeout|setInterval|sleep|retry|globalThis)\b|Date\.now|Date\s*=|process\.env\.TZ|timezone/i
  );
});

test("S13-S16 S15 accepts one open target and permits S16 authorization_expired", async () => {
  const execution = await executeSupplementalGate3({
    runGate3Substep: (_substep, _operationClass, operation) => operation()
  });
  const ordered = execution.runnerCalls.map(({ substep }) => substep);
  const s15Query = execution.observations.queries.find(({ text }) =>
    text.includes("UPDATE ia4tube_social.social_oauth_transactions"));

  assert.equal(execution.didThrow, false);
  assert.deepEqual(ordered.slice(12, 16), ["S13", "S14", "S15", "S16"]);
  assert.equal(execution.operationCounts.get("S15"), 1);
  assert.equal(execution.operationCounts.get("S16"), 1);
  assert.equal(s15Query.values.length, 2);
  assert.deepEqual(execution.result, SUPPLEMENTAL_GATE3_RESULT);
  assert.equal(execution.result.oauthExpiredRefused, true);
  assert.doesNotMatch(
    JSON.stringify(execution.result),
    /synthetic-linux|00000000|created_at|expires_at|\d{4}-\d{2}-\d{2}T/
  );
  assert.match(
    supplementalSubstepSource(supplementalGate3Source(), "S16", "S17"),
    /"authorization_expired"/
  );
});

test("S13-S16 S15 refuses closed or mismatched targets before S16", async () => {
  const refusedTargets = [
    "consumed",
    "cancelled",
    "failed",
    "wrong_company",
    "wrong_authorization"
  ];
  for (const s15TargetState of refusedTargets) {
    const execution = await executeSupplementalGate3({
      s15TargetState,
      runGate3Substep: (_substep, _operationClass, operation) => operation()
    });
    const steps = execution.runnerCalls.map(({ substep }) => substep);
    assert.equal(execution.didThrow, true);
    assert.equal(execution.thrown?.code, "linux_gate_oauth_force_expiry_target_invalid");
    assert.deepEqual(steps.slice(-2), ["S15", "S30"]);
    assert.equal(steps.some((substep) => /^S(?:1[6-9]|2[0-9])$/.test(substep)), false);
    assert.equal(steps.filter((substep) => substep === "S30").length, 1);
  }
});

test("S13-S16 S15 requires exactly one returned target row", async () => {
  for (const s15RowCount of [0, 2]) {
    const execution = await executeSupplementalGate3({
      s15RowCount,
      runGate3Substep: (_substep, _operationClass, operation) => operation()
    });
    assert.equal(execution.didThrow, true);
    assert.equal(execution.thrown?.code, "linux_gate_oauth_force_expiry_target_invalid");
    assert.equal(execution.runnerCalls.some(({ substep }) => substep === "S16"), false);
  }
});

test("S13-S16 S15 refuses invalid identity or open-state proof", async () => {
  const invalidProofs = [
    "s15IdMatches",
    "s15ConsumedAtIsNull",
    "s15CancelledAtIsNull",
    "s15FailedAtIsNull"
  ];
  for (const option of invalidProofs) {
    const execution = await executeSupplementalGate3({
      [option]: false,
      runGate3Substep: (_substep, _operationClass, operation) => operation()
    });
    assert.equal(execution.didThrow, true);
    assert.equal(execution.thrown?.code, "linux_gate_oauth_force_expiry_target_invalid");
    assert.equal(execution.runnerCalls.some(({ substep }) => substep === "S16"), false);
  }
});

test("S13-S16 S15 refuses invalid temporal proof", async () => {
  for (const option of ["s15ExpiryAfterCreation", "s15ExpiryBeforeCurrent"]) {
    const execution = await executeSupplementalGate3({
      [option]: false,
      runGate3Substep: (_substep, _operationClass, operation) => operation()
    });
    assert.equal(execution.didThrow, true);
    assert.equal(
      execution.thrown?.code,
      "linux_gate_oauth_force_expiry_temporal_order_invalid"
    );
    assert.equal(execution.runnerCalls.some(({ substep }) => substep === "S16"), false);
  }
});

test("S13-S16 migration keeps OAuth expiry after creation constraint", () => {
  const migration = fs.readFileSync(path.join(
    ROOT,
    "db/migrations/0002_social_connections_and_vault.up.sql"
  ), "utf8");
  assert.match(migration, /CONSTRAINT social_oauth_transactions_expiry_after_creation\s+CHECK \(expires_at > created_at\)/);
});

test("supplemental Gate 3 pass-through preserves success result, calls, arguments and cleanup", async () => {
  const baseline = await executeSupplementalGate3();
  const instrumented = await executeSupplementalGate3({
    runGate3Substep: (_substep, _operationClass, operation) => operation()
  });

  assert.equal(baseline.didThrow, false);
  assert.equal(instrumented.didThrow, false);
  assert.deepEqual(baseline.result, SUPPLEMENTAL_GATE3_RESULT);
  assert.deepEqual(instrumented.result, baseline.result);
  assert.deepEqual(instrumented.observations, baseline.observations);
  assert.deepEqual(instrumented.sensitiveMarkers, baseline.sensitiveMarkers);
  assert.deepEqual(
    instrumented.runnerCalls,
    SUPPLEMENTAL_GATE3_SUBSTEPS.map(([substep, _description, operationClass]) => ({
      substep,
      operationClass
    }))
  );
  assert.deepEqual(
    [...instrumented.operationCounts.entries()],
    SUPPLEMENTAL_GATE3_SUBSTEPS.map(([substep]) => [substep, 1])
  );
  assert.equal(instrumented.observations.transactions.length, 9);
  assert.equal(instrumented.observations.queries.length, 13);
  assert.equal(instrumented.observations.connectorCalls.length, 9);
  assert.equal(instrumented.observations.oauthCalls.length, 7);
  assert.equal(instrumented.identityKey.every((byte) => byte === 0), true);
  assert.equal(Object.isFrozen(instrumented.result), true);
});

test("supplemental Gate 3 rethrows the same error at every S1-S30 boundary and still cleans up", async (context) => {
  const errorShapes = [
    () => Object.assign(new Error("dsn=postgres://secret SQL SELECT stdout stderr"), { code: "23505" }),
    () => Object.assign(new Error("dsn=postgres://secret SQL SELECT stdout stderr"), { code: "57014" }),
    () => Object.assign(new Error("dsn=postgres://secret SQL SELECT stdout stderr"), { code: "ECONNRESET" }),
    () => Object.assign(new Error("dsn=postgres://secret SQL SELECT stdout stderr"), { code: "ETIMEDOUT" }),
    () => new TypeError("dsn=postgres://secret SQL SELECT stdout stderr"),
    () => new Error("dsn=postgres://secret SQL SELECT stdout stderr")
  ];

  for (let index = 0; index < SUPPLEMENTAL_GATE3_SUBSTEPS.length; index += 1) {
    const [target, description] = SUPPLEMENTAL_GATE3_SUBSTEPS[index];
    await context.test(`${target} ${description}`, async () => {
      const failure = errorShapes[index % errorShapes.length]();
      const execution = await executeSupplementalGate3({
        runGate3Substep: async (substep, _operationClass, operation) => {
          if (substep !== target) return operation();
          if (substep === "S30") {
            await operation();
          }
          throw failure;
        }
      });
      const expectedSteps = SUPPLEMENTAL_GATE3_SUBSTEPS
        .slice(0, index + 1)
        .map(([substep]) => substep);
      if (target !== "S30") expectedSteps.push("S30");

      assert.equal(execution.didThrow, true);
      assert.strictEqual(execution.thrown, failure);
      assert.deepEqual(execution.runnerCalls.map(({ substep }) => substep), expectedSteps);
      assert.equal(execution.runnerCalls.filter(({ substep }) => substep === target).length, 1);
      assert.equal(execution.runnerCalls.filter(({ substep }) => substep === "S30").length, 1);
      if (target !== "S1") {
        assert.equal(execution.identityKey.every((byte) => byte === 0), true);
      }
      const publicTrace = JSON.stringify({ runnerCalls: execution.runnerCalls });
      assert.doesNotMatch(publicTrace, /postgres:\/\/|secret|SELECT|stdout|stderr/i);
    });
  }
});

test("supplemental Gate 3 first failure wins over a later S30 failure", async () => {
  const primary = Object.assign(new Error("primary secret"), { code: "57014" });
  const cleanup = Object.assign(new Error("cleanup secret"), { code: "ECONNRESET" });
  const execution = await executeSupplementalGate3({
    runGate3Substep: async (substep, _operationClass, operation) => {
      if (substep === "S10") throw primary;
      if (substep === "S30") {
        await operation();
        throw cleanup;
      }
      return operation();
    }
  });

  assert.equal(execution.didThrow, true);
  assert.strictEqual(execution.thrown, primary);
  assert.deepEqual(execution.runnerCalls.map(({ substep }) => substep), [
    "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S30"
  ]);
  assert.equal(execution.identityKey.every((byte) => byte === 0), true);
});

test("supplemental Gate 3 propagates an S30-only failure after zeroing identity material", async () => {
  const cleanup = Object.assign(new Error("cleanup secret"), { code: "ETIMEDOUT" });
  const execution = await executeSupplementalGate3({
    runGate3Substep: async (substep, _operationClass, operation) => {
      const value = await operation();
      if (substep === "S30") throw cleanup;
      return value;
    }
  });

  assert.equal(execution.didThrow, true);
  assert.strictEqual(execution.thrown, cleanup);
  assert.equal(execution.identityKey.every((byte) => byte === 0), true);
  assert.equal(execution.operationCounts.get("S30"), 1);
});

test("supplemental Gate 3 attempts both identity-key zeroing operations and preserves the first cleanup error", async () => {
  const identityKey = Buffer.alloc(32, 0x6b);
  const cleanup = Object.assign(new Error("first fill failed"), { code: "ECONNRESET" });
  let fillCalls = 0;
  Object.defineProperty(identityKey, "fill", {
    configurable: true,
    value(...arguments_) {
      fillCalls += 1;
      if (fillCalls === 1) throw cleanup;
      return Buffer.prototype.fill.call(this, ...arguments_);
    }
  });
  const execution = await executeSupplementalGate3({ identityKey });

  assert.equal(execution.didThrow, true);
  assert.strictEqual(execution.thrown, cleanup);
  assert.equal(fillCalls, 2);
  assert.equal(identityKey.every((byte) => byte === 0), true);
});

test("vault supplemental gate proves connection and AAD binding without persistence", async () => {
  const markers = [];
  const state = { materials: { vault: Buffer.alloc(32, 11) } };
  const result = await runVaultSupplementalGate(state, markers);
  assert.deepEqual(result, {
    algorithm: "AES-256-GCM",
    aadBound: true,
    companyChangeRefused: true,
    providerChangeRefused: true,
    connectionChangeRefused: true,
    ciphertextTamperRefused: true,
    aadTamperRefused: true
  });
  assert.equal(markers.length, 1);
  assert.match(markers[0], /^synthetic-linux-token-/);
  state.materials.vault.fill(0);
  markers[0] = "";
});

test("vault supplemental Gate 4 instrumentation executes V10-V19 once in closed order", async () => {
  const calls = [];
  const markers = [];
  const state = { materials: { vault: Buffer.alloc(32, 11) } };
  const result = await runVaultSupplementalGate(state, markers, {
    async runGate4Substep(substep, operationClass, operation) {
      calls.push([substep, operationClass]);
      return operation();
    }
  });

  assert.deepEqual(calls, SUPPLEMENTAL_GATE4_SUBSTEPS);
  assert.deepEqual(result, {
    algorithm: "AES-256-GCM",
    aadBound: true,
    companyChangeRefused: true,
    providerChangeRefused: true,
    connectionChangeRefused: true,
    ciphertextTamperRefused: true,
    aadTamperRefused: true
  });
  assert.equal(markers.length, 1);
  state.materials.vault.fill(0);
  markers[0] = "";
});

test("vault supplemental Gate 4 injection preserves each V10-V19 failure and stops non-cleanup work", async (t) => {
  for (const [index, [target]] of SUPPLEMENTAL_GATE4_SUBSTEPS.entries()) {
    await t.test(target, async () => {
      const calls = [];
      const markers = [];
      const state = { materials: { vault: Buffer.alloc(32, 11) } };
      const failure = Object.assign(new Error(`private ${target}`), { code: "ETIMEDOUT" });
      let thrown;
      try {
        await runVaultSupplementalGate(state, markers, {
          async runGate4Substep(substep, operationClass, operation) {
            calls.push([substep, operationClass]);
            if (substep === target) {
              if (substep === "V19") await operation();
              throw failure;
            }
            return operation();
          }
        });
      } catch (error) {
        thrown = error;
      }

      const expected = SUPPLEMENTAL_GATE4_SUBSTEPS
        .slice(0, index + 1)
        .map(([substep]) => substep);
      if (target !== "V19") expected.push("V19");
      assert.strictEqual(thrown, failure);
      assert.deepEqual(calls.map(([substep]) => substep), expected);
      assert.deepEqual(
        calls.filter(([substep]) => substep !== "V19"),
        SUPPLEMENTAL_GATE4_SUBSTEPS.slice(0, index + 1).filter(([substep]) => substep !== "V19")
      );
      state.materials.vault.fill(0);
      for (let marker = 0; marker < markers.length; marker += 1) markers[marker] = "";
    });
  }
});

test("vault supplemental Gate 4 primary failure wins over a later V19 failure", async () => {
  const primary = Object.assign(new Error("private primary"), { code: "23514" });
  const cleanup = Object.assign(new Error("private cleanup"), { code: "ECONNRESET" });
  const state = { materials: { vault: Buffer.alloc(32, 11) } };
  let thrown;
  try {
    await runVaultSupplementalGate(state, [], {
      async runGate4Substep(substep, _operationClass, operation) {
        if (substep === "V14") throw primary;
        if (substep === "V19") {
          await operation();
          throw cleanup;
        }
        return operation();
      }
    });
  } catch (error) {
    thrown = error;
  }
  assert.strictEqual(thrown, primary);
  state.materials.vault.fill(0);
});

test("vault supplemental Gate 4 retains V11 resources when the runner fails after creation", async () => {
  const failure = Object.assign(new Error("private post-create failure"), { code: "ETIMEDOUT" });
  const token = Buffer.alloc(48, 0x74);
  const observations = { destroyCalls: 0 };
  const vault = {
    destroy() { observations.destroyCalls += 1; }
  };
  const setup = {
    context: Object.freeze({}),
    createSocialVault() { return vault; },
    key: Buffer.alloc(32, 0x6b),
    token,
    version: "synthetic-version",
    vaultKeyringFingerprint() { return "synthetic-fingerprint"; }
  };
  const calls = [];
  let thrown;
  try {
    await runVaultSupplementalGate({}, [], {
      async runGate4Substep(substep, _operationClass, operation) {
        calls.push(substep);
        if (substep === "V10") return setup;
        if (substep === "V11") {
          await operation();
          throw failure;
        }
        return operation();
      }
    });
  } catch (error) {
    thrown = error;
  }
  assert.strictEqual(thrown, failure);
  assert.deepEqual(calls, ["V10", "V11", "V19"]);
  assert.equal(observations.destroyCalls, 1);
  assert.equal(token.every((byte) => byte === 0), true);
  setup.key.fill(0);
});

test("persisted Gate 4 instrumentation executes V20-V25 with synthetic dependencies only", async () => {
  const calls = [];
  const {
    observations,
    retirePrimaryMigrationPoolBeforePersistedVault,
    setup
  } = syntheticPersistedGate4Harness();
  const result = await runPersistedVaultGate(
    syntheticPersistedGate4State(),
    [],
    "synthetic-unused-root",
    {
    async runGate4Substep(substep, operationClass, operation) {
      calls.push([substep, operationClass]);
      if (substep === "V20") return setup;
      return operation();
    },
      retirePrimaryMigrationPoolBeforePersistedVault
    }
  );

  assert.deepEqual(calls, PERSISTED_GATE4_SUBSTEPS);
  assert.deepEqual(result, {
    runtimeIsolationPrerequisite: true,
    persistedRoundTrip: true,
    keyRotation: true,
    retirementWhileInUseRefused: true,
    plaintextDatabaseAbsent: true
  });
  assert.deepEqual(observations, {
    closeCalls: 1,
    retirementCalls: 1,
    runtimeIsolationCalls: 1,
    vaultCalls: 1
  });
  assert.equal(setup.persistedA.every((byte) => byte === 0), true);
  assert.equal(setup.persistedB.every((byte) => byte === 0), true);
});

test("Gate 4 hands off the primary migration pool inside V21 before verifier setup and connects", async () => {
  const lifecycleEvents = [];
  const markers = [];
  const supplementalState = { materials: { vault: Buffer.alloc(32, 11) } };
  await runVaultSupplementalGate(supplementalState, markers, {
    async runGate4Substep(substep, _operationClass, operation) {
      if (substep === "V19") lifecycleEvents.push("V19");
      return operation();
    }
  });

  const harness = syntheticGate4CapacityHarness({
    lifecycleEvents,
    runtimePlan: ["success", "success"]
  });
  const { result, thrown } = await harness.run();

  assert.equal(thrown, undefined);
  assert.equal(result.runtimeIsolationPrerequisite, true);
  assert.deepEqual(lifecycleEvents, [
    "V19",
    "V20",
    "V21",
    "handoff",
    "verifier-setup",
    "pool:migration",
    "pool:runtime",
    "V22",
    "connect:runtime",
    "connect:runtime",
    "V23",
    "V24",
    "end:runtime",
    "end:migration",
    "V25"
  ]);
  assert.equal(harness.observations.retirementCalls, 1);
  assert.equal(harness.observations.verifierPools.migration.options.max, 1);
  assert.equal(harness.observations.verifierPools.runtime.options.max, 2);
  assert.equal(harness.observations.closeCalls, 1);
  assert.deepEqual(harness.observations.underlyingEndCalls, {
    migration: 1,
    runtime: 1
  });
  assert.equal(harness.setup.persistedA.every((byte) => byte === 0), true);
  assert.equal(harness.setup.persistedB.every((byte) => byte === 0), true);
  supplementalState.materials.vault.fill(0);
  for (let marker = 0; marker < markers.length; marker += 1) markers[marker] = "";
});

test("Gate 4 verifierMigration connects successfully only after the V21 handoff", async () => {
  const harness = syntheticGate4CapacityHarness({
    functionalConnections: [
      { category: "migration", callback: false },
      { category: "runtime", callback: false }
    ],
    migrationPlan: ["success"],
    runtimePlan: ["success"]
  });
  const { result, thrown } = await harness.run();

  assert.equal(thrown, undefined);
  assert.equal(result.runtimeIsolationPrerequisite, true);
  assert.equal(harness.observations.retirementCalls, 1);
  assert.equal(harness.observations.underlyingConnectCalls.migration, 1);
  assert.equal(harness.observations.underlyingConnectCalls.runtime, 1);
  assert.equal(harness.observations.records.length, 0);
  const handoffIndex = harness.observations.lifecycleEvents.indexOf("handoff");
  const migrationPoolIndex = harness.observations.lifecycleEvents.indexOf("pool:migration");
  const v22Index = harness.observations.lifecycleEvents.indexOf("V22");
  const migrationConnectIndex = harness.observations.lifecycleEvents.indexOf("connect:migration");
  assert.ok(handoffIndex >= 0 && migrationPoolIndex > handoffIndex);
  assert.ok(v22Index > migrationPoolIndex && migrationConnectIndex > v22Index);
  assert.equal(harness.observations.verifierPools.migration.options.max, 1);
  assert.equal(harness.observations.verifierPools.runtime.options.max, 2);
  assert.deepEqual(harness.observations.underlyingEndCalls, {
    migration: 1,
    runtime: 1
  });
});

test("Gate 4 refuses a V21 runner that returns without executing the mandatory handoff", async () => {
  const calls = [];
  const {
    gate,
    observations,
    retirePrimaryMigrationPoolBeforePersistedVault,
    setup
  } = syntheticPersistedGate4Harness();
  let thrown;
  try {
    await runPersistedVaultGate({}, [], "synthetic-unused-root", {
      retirePrimaryMigrationPoolBeforePersistedVault,
      async runGate4Substep(substep, _operationClass, operation) {
        calls.push(substep);
        if (substep === "V20") return setup;
        if (substep === "V21") return gate;
        return operation();
      }
    });
  } catch (error) {
    thrown = error;
  }

  assert.equal(thrown?.code, "linux_gate_primary_migration_pool_retirement_invalid");
  assert.equal(observations.retirementCalls, 0);
  assert.equal(observations.runtimeIsolationCalls, 0);
  assert.equal(observations.closeCalls, 1);
  assert.deepEqual(calls, ["V20", "V21", "V24", "V25"]);
  assert.equal(setup.persistedA.every((byte) => byte === 0), true);
  assert.equal(setup.persistedB.every((byte) => byte === 0), true);
});

test("Gate 4 closes a verifier pool created before a partial V21 factory failure", async () => {
  const factoryFailure = Object.assign(new Error("private verifier factory failure"), {
    code: "synthetic_verifier_factory_failure"
  });
  const harness = syntheticGate4CapacityHarness({
    verifierFactoryErrorAfterMigration: factoryFailure
  });
  const { thrown } = await harness.run();

  assert.strictEqual(thrown, factoryFailure);
  assert.equal(harness.observations.retirementCalls, 1);
  assert.ok(harness.observations.verifierPools.migration);
  assert.equal(harness.observations.verifierPools.runtime, undefined);
  assert.equal(harness.observations.closeCalls, 0);
  assert.deepEqual(harness.observations.underlyingConnectCalls, {
    migration: 0,
    runtime: 0
  });
  assert.deepEqual(harness.observations.underlyingEndCalls, {
    migration: 1,
    runtime: 0
  });
  assert.deepEqual(harness.observations.lifecycleEvents, [
    "V20",
    "V21",
    "handoff",
    "verifier-setup",
    "pool:migration",
    "V24",
    "end:migration",
    "V25"
  ]);
  assert.equal(harness.setup.persistedA.every((byte) => byte === 0), true);
  assert.equal(harness.setup.persistedB.every((byte) => byte === 0), true);
});

test("Gate 4 rejects a missing or unsuccessful V21 migration pool handoff before verifier work", async (t) => {
  for (const scenario of ["missing", "invalid-result"]) {
    await t.test(scenario, async () => {
      const calls = [];
      let verifierSetupCalls = 0;
      let verifierPoolConstructions = 0;
      let verifierMigrationConnectCalls = 0;
      const { gate, setup } = syntheticPersistedGate4Harness();
      setup.original = {
        createRestoreBehaviorVerifiers() {
          verifierSetupCalls += 1;
          return gate;
        }
      };
      class SyntheticVerifierPool {
        constructor() {
          verifierPoolConstructions += 1;
        }
        connect() {
          verifierMigrationConnectCalls += 1;
          throw new Error("verifier connect must remain unreachable");
        }
      }
      const dependencies = {
        async runGate4Substep(substep, _operationClass, operation) {
          calls.push(substep);
          if (substep === "V20") return setup;
          return operation();
        }
      };
      if (scenario === "invalid-result") {
        dependencies.retirePrimaryMigrationPoolBeforePersistedVault =
          async () => false;
      }
      let thrown;
      try {
        await runPersistedVaultGate({
          PoolClass: SyntheticVerifierPool,
          database: "synthetic",
          target: { port: 5432 }
        }, [], "synthetic-unused-root", dependencies);
      } catch (error) {
        thrown = error;
      }

      assert.equal(thrown?.message, "linux_gate_primary_migration_pool_retirement_invalid");
      assert.deepEqual(calls, ["V20", "V21", "V24", "V25"]);
      assert.equal(verifierSetupCalls, 0);
      assert.equal(verifierPoolConstructions, 0);
      assert.equal(verifierMigrationConnectCalls, 0);
      assert.equal(calls.includes("V22"), false);
      assert.equal(setup.persistedA.every((byte) => byte === 0), true);
      assert.equal(setup.persistedB.every((byte) => byte === 0), true);
    });
  }
});

test("Gate 4 preserves the exact V21 handoff error over later cleanup failures", async () => {
  const calls = [];
  const handoffFailure = Object.assign(new Error("private handoff failure"), {
    code: "ECONNRESET"
  });
  const verifierCleanupFailure = new Error("private verifier cleanup failure");
  const materialCleanupFailure = new Error("private material cleanup failure");
  let handoffCalls = 0;
  let verifierSetupCalls = 0;
  let verifierPoolConstructions = 0;
  let verifierMigrationConnectCalls = 0;
  const { gate, setup } = syntheticPersistedGate4Harness();
  setup.original = {
    createRestoreBehaviorVerifiers() {
      verifierSetupCalls += 1;
      return gate;
    }
  };
  class SyntheticVerifierPool {
    constructor() {
      verifierPoolConstructions += 1;
    }
    connect() {
      verifierMigrationConnectCalls += 1;
      throw new Error("verifier connect must remain unreachable");
    }
  }
  let thrown;
  try {
    await runPersistedVaultGate({
      PoolClass: SyntheticVerifierPool,
      database: "synthetic",
      target: { port: 5432 }
    }, [], "synthetic-unused-root", {
      async retirePrimaryMigrationPoolBeforePersistedVault(...arguments_) {
        handoffCalls += 1;
        assert.equal(arguments_.length, 0);
        throw handoffFailure;
      },
      async runGate4Substep(substep, _operationClass, operation) {
        calls.push(substep);
        if (substep === "V20") return setup;
        if (substep === "V24") {
          await operation();
          throw verifierCleanupFailure;
        }
        if (substep === "V25") {
          await operation();
          throw materialCleanupFailure;
        }
        return operation();
      }
    });
  } catch (error) {
    thrown = error;
  }

  assert.strictEqual(thrown, handoffFailure);
  assert.equal(handoffCalls, 1);
  assert.deepEqual(calls, ["V20", "V21", "V24", "V25"]);
  assert.equal(verifierSetupCalls, 0);
  assert.equal(verifierPoolConstructions, 0);
  assert.equal(verifierMigrationConnectCalls, 0);
  assert.equal(calls.includes("V22"), false);
  assert.equal(setup.persistedA.every((byte) => byte === 0), true);
  assert.equal(setup.persistedB.every((byte) => byte === 0), true);
});

test("Gate 4 V22 capacity diagnostics use one same-client snapshot and emit closed raw counters", async () => {
  const harness = syntheticGate4CapacityHarness();
  const { thrown } = await harness.run();
  const { observations } = harness;

  assert.strictEqual(thrown, harness.capacityFailure);
  assert.equal(observations.records.length, 1);
  const candidate = observations.records[0];
  assert.deepEqual(Object.keys(candidate), ["server", "database", "roles", "pools"]);
  assert.deepEqual(candidate.server, {
    maxConnections: 20,
    reservedConnections: 0,
    superuserReservedConnections: 3,
    clientConnectionsBeforeV22Failure: 17
  });
  assert.deepEqual(candidate.database, {
    connectionLimit: -1,
    clientConnectionsBeforeV22Failure: 12
  });
  assert.deepEqual(candidate.roles, {
    provisioner: { connectionLimit: 2, clientConnectionsBeforeV22Failure: 0 },
    migration: { connectionLimit: 5, clientConnectionsBeforeV22Failure: 4 },
    runtime: { connectionLimit: 8, clientConnectionsBeforeV22Failure: 8 }
  });
  assertGate4PoolCountersNumeric(candidate);
  assert.deepEqual(candidate.pools.mainMigration, {
    configuredMax: 2,
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
    connectAttempts: 0,
    connectSucceeded: 0,
    connectionCapacityFailures: 0
  });
  assert.deepEqual(candidate.pools.mainRuntime, {
    configuredMax: 3,
    totalCount: 2,
    idleCount: 1,
    waitingCount: 0,
    connectAttempts: 0,
    connectSucceeded: 0,
    connectionCapacityFailures: 0
  });
  assert.deepEqual(candidate.pools.verifierRuntime, {
    configuredMax: 2,
    totalCount: 2,
    idleCount: 1,
    waitingCount: 0,
    connectAttempts: 2,
    connectSucceeded: 1,
    connectionCapacityFailures: 1
  });
  assert.equal(observations.underlyingConnectCalls.runtime, 2);
  assert.equal(observations.underlyingConnectCalls.migration, 0);
  assert.equal(observations.poolQueryCalls, 0);
  assert.equal(observations.snapshotCalls.length, 1);
  assert.strictEqual(observations.snapshotCalls[0].client, observations.functionalClients[0]);
  assert.deepEqual(observations.events.slice(0, 2), [
    `snapshot:${observations.functionalClients[0].id}`,
    `functional:${observations.functionalClients[0].id}`
  ]);
  assert.deepEqual(observations.snapshotCalls[0].values, [
    "ia4tube_social_local",
    PROVISIONER_LOGIN,
    MIGRATION_LOGIN,
    RUNTIME_LOGIN
  ]);
  assert.doesNotMatch(
    observations.snapshotCalls[0].text,
    /pg_backend_pid|application_name|client_addr|backend_start|\bstate\b/i
  );
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(Object.isFrozen(candidate.server), true);
  assert.equal(Object.isFrozen(candidate.roles.runtime), true);
  assert.equal(Object.isFrozen(candidate.pools.verifierRuntime), true);
  assert.throws(() => { candidate.server.maxConnections = 99; }, TypeError);
  const serialized = JSON.stringify(candidate);
  for (const forbidden of [
    "ia4tube_social_local",
    PROVISIONER_LOGIN,
    MIGRATION_LOGIN,
    RUNTIME_LOGIN,
    "private capacity failure",
    "postgresql://",
    "local.ia4tube.invalid",
    "password",
    "stack",
    "cause"
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("Gate 4 V22 first connect 53300 records all-null SQL fields without retry", async () => {
  const harness = syntheticGate4CapacityHarness({
    functionalConnections: [{ category: "runtime", callback: true }],
    runtimePlan: ["53300"]
  });
  const { thrown } = await harness.run();

  assert.strictEqual(thrown, harness.capacityFailure);
  assert.equal(harness.observations.snapshotCalls.length, 0);
  assert.equal(harness.observations.poolQueryCalls, 0);
  assert.equal(harness.observations.underlyingConnectCalls.runtime, 1);
  assert.equal(harness.observations.callbackReleases.length, 0);
  assert.equal(harness.observations.records.length, 1);
  const candidate = harness.observations.records[0];
  assertUnavailableGate4CapacitySnapshot(candidate);
  assertGate4PoolCountersNumeric(candidate);
  assert.deepEqual(candidate.pools.verifierRuntime, {
    configuredMax: 2,
    totalCount: 2,
    idleCount: 1,
    waitingCount: 0,
    connectAttempts: 1,
    connectSucceeded: 0,
    connectionCapacityFailures: 1
  });
});

test("Gate 4 V22 snapshot failure is swallowed once and never masks or retries 53300", async () => {
  const snapshotError = new Error("private snapshot failure");
  const harness = syntheticGate4CapacityHarness({
    functionalConnections: [
      { category: "runtime", callback: false },
      { category: "runtime", callback: false },
      { category: "runtime", callback: false }
    ],
    runtimePlan: ["success", "success", "53300"],
    snapshotError
  });
  const { thrown } = await harness.run();

  assert.strictEqual(thrown, harness.capacityFailure);
  assert.equal(harness.observations.snapshotCalls.length, 1);
  assert.equal(harness.observations.underlyingConnectCalls.runtime, 3);
  assert.equal(harness.observations.functionalClients.length, 2);
  assert.equal(harness.observations.records.length, 1);
  const candidate = harness.observations.records[0];
  assertUnavailableGate4CapacitySnapshot(candidate);
  assertGate4PoolCountersNumeric(candidate);
  assert.deepEqual(candidate.pools.verifierRuntime, {
    configuredMax: 2,
    totalCount: 2,
    idleCount: 1,
    waitingCount: 0,
    connectAttempts: 3,
    connectSucceeded: 2,
    connectionCapacityFailures: 1
  });
});

test("Gate 4 V22 verifier instrumentation preserves callback connect and its release argument", async () => {
  const harness = syntheticGate4CapacityHarness({
    functionalConnections: [
      { category: "runtime", callback: true },
      { category: "runtime", callback: false }
    ]
  });
  const { thrown } = await harness.run();

  assert.strictEqual(thrown, harness.capacityFailure);
  assert.equal(harness.observations.snapshotCalls.length, 1);
  assert.equal(harness.observations.callbackReleases.length, 1);
  assert.strictEqual(
    harness.observations.callbackReleases[0],
    harness.observations.functionalClients[0].release
  );
  assert.equal(harness.observations.underlyingConnectCalls.runtime, 2);
  assert.deepEqual(harness.observations.records[0].pools.verifierRuntime, {
    configuredMax: 2,
    totalCount: 2,
    idleCount: 1,
    waitingCount: 0,
    connectAttempts: 2,
    connectSucceeded: 1,
    connectionCapacityFailures: 1
  });
});

test("Gate 4 V22 passing path never publishes a captured capacity snapshot", async () => {
  const harness = syntheticGate4CapacityHarness({
    runtimePlan: ["success", "success"]
  });
  const { result, thrown } = await harness.run();

  assert.equal(thrown, undefined);
  assert.equal(result.runtimeIsolationPrerequisite, true);
  assert.equal(harness.observations.snapshotCalls.length, 1);
  assert.equal(harness.observations.underlyingConnectCalls.runtime, 2);
  assert.equal(harness.observations.records.length, 0);
  assert.equal(harness.observations.closeCalls, 1);
});

test("Gate 4 V22 non-53300 failure never publishes capacity diagnostics", async () => {
  const harness = syntheticGate4CapacityHarness({
    functionalConnections: [{ category: "runtime", callback: false }],
    runtimePlan: ["08006"]
  });
  const { thrown } = await harness.run();

  assert.strictEqual(thrown, harness.otherFailure);
  assert.equal(harness.observations.snapshotCalls.length, 0);
  assert.equal(harness.observations.underlyingConnectCalls.runtime, 1);
  assert.equal(harness.observations.records.length, 0);
  assert.equal(harness.observations.closeCalls, 1);
});

test("Gate 4 V22 partial SQL snapshot becomes coherently all-null without a second attempt", async () => {
  const partial = { ...COMPLETE_GATE4_CAPACITY_ROW };
  delete partial.runtimeClientConnectionsBeforeV22Failure;
  const harness = syntheticGate4CapacityHarness({ snapshotRow: partial });
  const { thrown } = await harness.run();

  assert.strictEqual(thrown, harness.capacityFailure);
  assert.equal(harness.observations.snapshotCalls.length, 1);
  assert.equal(harness.observations.underlyingConnectCalls.runtime, 2);
  assert.equal(harness.observations.records.length, 1);
  assertUnavailableGate4CapacitySnapshot(harness.observations.records[0]);
  assertGate4PoolCountersNumeric(harness.observations.records[0]);
});

test("Gate 4 V22 recorder failure cannot replace the original 53300 or cleanup", async () => {
  const recorderError = new Error("private recorder failure");
  const harness = syntheticGate4CapacityHarness({ recorderError });
  const { thrown } = await harness.run();

  assert.strictEqual(thrown, harness.capacityFailure);
  assert.equal(harness.observations.records.length, 1);
  assert.equal(harness.observations.closeCalls, 1);
  assert.equal(harness.setup.persistedA.every((value) => value === 0), true);
  assert.equal(harness.setup.persistedB.every((value) => value === 0), true);
});

test("Gate 4 V22 migration 53300 increments only verifierMigration capacity counters", async () => {
  const harness = syntheticGate4CapacityHarness({
    functionalConnections: [{ category: "migration", callback: false }],
    migrationPlan: ["53300"],
    runtimePlan: []
  });
  const { thrown } = await harness.run();

  assert.strictEqual(thrown, harness.capacityFailure);
  const candidate = harness.observations.records[0];
  assertUnavailableGate4CapacitySnapshot(candidate);
  assert.equal(candidate.pools.verifierMigration.connectAttempts, 1);
  assert.equal(candidate.pools.verifierMigration.connectSucceeded, 0);
  assert.equal(candidate.pools.verifierMigration.connectionCapacityFailures, 1);
  assert.equal(candidate.pools.verifierRuntime.connectAttempts, 0);
  assert.equal(candidate.pools.verifierRuntime.connectSucceeded, 0);
  assert.equal(candidate.pools.verifierRuntime.connectionCapacityFailures, 0);
  assert.equal(harness.observations.underlyingConnectCalls.migration, 1);
  assert.equal(harness.observations.underlyingConnectCalls.runtime, 0);
});

test("Gate 4 V22 query-level 53300 is not miscounted as a pool connect failure", async () => {
  const harness = syntheticGate4CapacityHarness({
    afterConnectionsError: Object.assign(new Error("private query refusal"), { code: "53300" }),
    functionalConnections: [{ category: "runtime", callback: false }],
    runtimePlan: ["success"]
  });
  const { thrown } = await harness.run();

  assert.equal(thrown?.code, "53300");
  assert.equal(harness.observations.snapshotCalls.length, 1);
  assert.equal(harness.observations.records.length, 1);
  assert.equal(harness.observations.records[0].server.maxConnections, 20);
  assert.deepEqual(harness.observations.records[0].pools.verifierRuntime, {
    configuredMax: 2,
    totalCount: 2,
    idleCount: 1,
    waitingCount: 0,
    connectAttempts: 1,
    connectSucceeded: 1,
    connectionCapacityFailures: 0
  });
});

test("persisted Gate 4 injection preserves each V20-V25 failure without a database or process", async (t) => {
  for (const [index, [target]] of PERSISTED_GATE4_SUBSTEPS.entries()) {
    await t.test(target, async () => {
      const calls = [];
      const {
        observations,
        retirePrimaryMigrationPoolBeforePersistedVault,
        setup
      } = syntheticPersistedGate4Harness();
      const failure = Object.assign(new Error(`private ${target}`), { code: "23505" });
      let thrown;
      try {
        await runPersistedVaultGate(syntheticPersistedGate4State(), [], "synthetic-unused-root", {
          async runGate4Substep(substep, operationClass, operation) {
            calls.push([substep, operationClass]);
            if (substep === target) {
              if (substep === "V25") await operation();
              throw failure;
            }
            if (substep === "V20") return setup;
            return operation();
          },
          retirePrimaryMigrationPoolBeforePersistedVault
        });
      } catch (error) {
        thrown = error;
      }

      const expectedCalls = {
        V20: ["V20", "V24", "V25"],
        V21: ["V20", "V21", "V24", "V25"],
        V22: ["V20", "V21", "V22", "V24", "V25"],
        V23: ["V20", "V21", "V22", "V23", "V24", "V25"],
        V24: ["V20", "V21", "V22", "V23", "V24", "V25"],
        V25: ["V20", "V21", "V22", "V23", "V24", "V25"]
      };
      assert.strictEqual(thrown, failure);
      assert.equal(observations.retirementCalls, index >= 2 ? 1 : 0);
      assert.deepEqual(calls.map(([substep]) => substep), expectedCalls[target]);
      const expectedCoreLength = Math.min(index, 3) + 1;
      assert.deepEqual(
        calls.filter(([substep]) => !new Set(["V24", "V25"]).has(substep)),
        PERSISTED_GATE4_SUBSTEPS.slice(0, expectedCoreLength)
      );
      if (target !== "V20") {
        assert.equal(setup.persistedA.every((byte) => byte === 0), true);
        assert.equal(setup.persistedB.every((byte) => byte === 0), true);
      }
    });
  }
});

test("persisted Gate 4 primary failure wins over V24 and V25 cleanup failures", async () => {
  const calls = [];
  const {
    observations,
    retirePrimaryMigrationPoolBeforePersistedVault,
    setup
  } = syntheticPersistedGate4Harness();
  const primary = Object.assign(new Error("private primary"), { code: "23514" });
  const verifierCleanup = Object.assign(new Error("private verifier cleanup"), { code: "ECONNRESET" });
  const materialCleanup = Object.assign(new Error("private material cleanup"), { code: "ERANGE" });
  let thrown;
  try {
    await runPersistedVaultGate(syntheticPersistedGate4State(), [], "synthetic-unused-root", {
      async runGate4Substep(substep, _operationClass, operation) {
        calls.push(substep);
        if (substep === "V20") return setup;
        if (substep === "V22") throw primary;
        if (substep === "V24") throw verifierCleanup;
        if (substep === "V25") {
          await operation();
          throw materialCleanup;
        }
        return operation();
      },
      retirePrimaryMigrationPoolBeforePersistedVault
    });
  } catch (error) {
    thrown = error;
  }
  assert.strictEqual(thrown, primary);
  assert.equal(observations.retirementCalls, 1);
  assert.deepEqual(calls, ["V20", "V21", "V22", "V24", "V25"]);
  assert.equal(setup.persistedA.every((byte) => byte === 0), true);
  assert.equal(setup.persistedB.every((byte) => byte === 0), true);
});

test("persisted Gate 4 retains partial V20 material when the runner fails after setup", async () => {
  const failure = Object.assign(new Error("private post-setup failure"), { code: "ETIMEDOUT" });
  const calls = [];
  const markers = [];
  let capturedSetup;
  let thrown;
  try {
    await runPersistedVaultGate({
      database: "synthetic",
      passwords: {
        [MIGRATION_LOGIN]: "synthetic-migration-password",
        [RUNTIME_LOGIN]: "synthetic-runtime-password"
      },
      target: { port: 5432 }
    }, markers, "synthetic-unused-root", {
      async runGate4Substep(substep, _operationClass, operation) {
        calls.push(substep);
        if (substep === "V20") {
          capturedSetup = await operation();
          throw failure;
        }
        return operation();
      },
      async retirePrimaryMigrationPoolBeforePersistedVault() { return true; }
    });
  } catch (error) {
    thrown = error;
  }
  assert.strictEqual(thrown, failure);
  assert.deepEqual(calls, ["V20", "V24", "V25"]);
  assert.equal(capturedSetup.persistedA.every((byte) => byte === 0), true);
  assert.equal(capturedSetup.persistedB.every((byte) => byte === 0), true);
  for (let marker = 0; marker < markers.length; marker += 1) markers[marker] = "";
});

test("persisted Gate 4 retains V21 verifier when the runner fails after creation", async () => {
  const failure = Object.assign(new Error("private post-verifier failure"), { code: "ETIMEDOUT" });
  const calls = [];
  const {
    observations,
    retirePrimaryMigrationPoolBeforePersistedVault,
    setup
  } = syntheticPersistedGate4Harness();
  let thrown;
  try {
    await runPersistedVaultGate({
      PoolClass: class SyntheticPool {},
      database: "synthetic",
      target: { port: 5432 }
    }, [], "synthetic-unused-root", {
      async runGate4Substep(substep, _operationClass, operation) {
        calls.push(substep);
        if (substep === "V20") return setup;
        if (substep === "V21") {
          await operation();
          throw failure;
        }
        return operation();
      },
      retirePrimaryMigrationPoolBeforePersistedVault
    });
  } catch (error) {
    thrown = error;
  }
  assert.strictEqual(thrown, failure);
  assert.deepEqual(calls, ["V20", "V21", "V24", "V25"]);
  assert.equal(observations.retirementCalls, 1);
  assert.equal(observations.closeCalls, 1);
  assert.equal(setup.persistedA.every((byte) => byte === 0), true);
  assert.equal(setup.persistedB.every((byte) => byte === 0), true);
});

test("persisted Gate 4 records a V24 close failure first and still executes V25", async () => {
  const closeFailure = Object.assign(new Error("private close"), { code: "ECONNRESET" });
  const {
    observations,
    retirePrimaryMigrationPoolBeforePersistedVault,
    setup
  } = syntheticPersistedGate4Harness({ closeError: closeFailure });
  let thrown;
  try {
    await runPersistedVaultGate(syntheticPersistedGate4State(), [], "synthetic-unused-root", {
      async runGate4Substep(substep, _operationClass, operation) {
        if (substep === "V20") return setup;
        return operation();
      },
      retirePrimaryMigrationPoolBeforePersistedVault
    });
  } catch (error) {
    thrown = error;
  }
  assert.strictEqual(thrown, closeFailure);
  assert.equal(observations.retirementCalls, 1);
  assert.equal(observations.closeCalls, 1);
  assert.equal(setup.persistedA.every((byte) => byte === 0), true);
  assert.equal(setup.persistedB.every((byte) => byte === 0), true);
});

test("Linux physical adapter contains no provider endpoint, customer data or real OAuth path", () => {
  const source = fs.readFileSync(path.join(ROOT, "scripts/social-3a0p-linux-physical-gates.js"), "utf8");
  assert.doesNotMatch(source, /graph\.facebook\.com|api\.instagram\.com|instagram\.com\/oauth/i);
  assert.doesNotMatch(source, /\b(?:119|customer|cliente_real|production_token)\b/i);
  assert.doesNotMatch(source, /\b(?:fetch|axios|undici|https?\.request)\s*\(/);
  assert.doesNotMatch(source, /currentLegacyDependencies|legacyDependencies:\s*current/);
  assert.match(source, /legacy2ARoot/);
  const runtimeIsolation = source.indexOf("gate.verifiers.verifyRuntimeIsolation()");
  const persistedVault = source.indexOf("gate.verifiers.verifyVault()");
  assert.ok(runtimeIsolation >= 0 && persistedVault > runtimeIsolation);
});
