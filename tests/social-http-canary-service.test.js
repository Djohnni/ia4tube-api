"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createSocialHttpCanaryService,
  runVaultGate,
  sanitizeHttpCanaryResult
} = require("../src/social/http-canary-service");
const { createSocialVault } = require("../src/social/vault");
const {
  deriveVaultKeyVersion,
  vaultKeyringFingerprint
} = require("../src/social/vault-key-version");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const SECRET_MARKER = "synthetic_vault_secret_never_output";

function uuidSequence() {
  let counter = 1;
  return () => {
    const suffix = String(counter++).padStart(12, "0");
    return `00000000-0000-4000-8000-${suffix}`;
  };
}

function createVault() {
  const key = Buffer.alloc(32, 37);
  const version = deriveVaultKeyVersion(1, key);
  const vault = createSocialVault({
    keyring: {
      activeVersion: version,
      keys: new Map([[version, key]])
    },
    expectedKeyringFingerprint: vaultKeyringFingerprint(version, [version]),
    randomBytes(size) {
      return Buffer.alloc(size, 19);
    }
  });
  key.fill(0);
  return vault;
}

function passedDatabaseResult() {
  return {
    ownReadA: true,
    ownReadB: true,
    crossTenantDeniedA: true,
    crossTenantDeniedB: true,
    missingContextDenied: true,
    tamperedContextDenied: true,
    idempotentWrites: true,
    mutationRolledBack: true
  };
}

function createService(options = {}) {
  const vault = options.vault || createVault();
  let verifyCalls = 0;
  const suppliedProbe = options.probe || {
    async runMutation() {
      return passedDatabaseResult();
    },
    async verifyResiduals() {
      verifyCalls += 1;
      return 0;
    }
  };
  const probe = {
    async runExclusive(operation) {
      return operation(suppliedProbe);
    }
  };
  let now = 100;
  const service = createSocialHttpCanaryService({
    probe,
    vault,
    companyA: COMPANY_A,
    companyB: COMPANY_B,
    randomUUID: uuidSequence(),
    randomBytes(size) {
      return Buffer.alloc(size, 23);
    },
    clock() {
      now += 5;
      return now;
    },
    logger: options.logger
  });
  return { service, vault, probe, getVerifyCalls: () => verifyCalls };
}

test("service proves A/B, AES-256-GCM AAD, tamper denial and zero residues", async () => {
  const { service, vault, getVerifyCalls } = createService();
  try {
    const result = await service.run();
    assert.equal(result.status, "passed");
    assert.equal(result.ownReadA, true);
    assert.equal(result.ownReadB, true);
    assert.equal(result.crossTenantDeniedA, true);
    assert.equal(result.crossTenantDeniedB, true);
    assert.equal(result.missingContextDenied, true);
    assert.equal(result.tamperedContextDenied, true);
    assert.equal(result.idempotentWrites, true);
    assert.equal(result.mutationRolledBack, true);
    assert.equal(result.vaultRoundTripPassed, true);
    assert.equal(result.vaultCrossTenantDenied, true);
    assert.equal(result.vaultTamperDenied, true);
    assert.equal(result.cleanupCompleted, true);
    assert.equal(result.residualRecords, 0);
    assert.equal(getVerifyCalls(), 1);
    const output = JSON.stringify(result);
    assert.equal(output.includes(SECRET_MARKER), false);
    assert.equal(output.includes(COMPANY_A), false);
    assert.equal(output.includes(COMPANY_B), false);
    assert.equal(output.includes("ciphertext"), false);
  } finally {
    vault.destroy();
  }
});

test("vault gate rejects swapped company and altered ciphertext with real implementation", () => {
  const vault = createVault();
  try {
    const data = {
      companyA: COMPANY_A,
      companyB: COMPANY_B,
      vault: {
        credentialId: "33333333-3333-4333-8333-333333333333",
        subjectId: "44444444-4444-4444-8444-444444444444"
      }
    };
    assert.deepEqual(
      runVaultGate(vault, data, (size) => Buffer.alloc(size, 29)),
      {
        vaultRoundTripPassed: true,
        vaultCrossTenantDenied: true,
        vaultTamperDenied: true
      }
    );
  } finally {
    vault.destroy();
  }
});

test("cleanup verification still runs after an intermediate mutation failure", async () => {
  let verifyCalls = 0;
  const secretError = new Error(
    `failed with postgresql://runtime:${SECRET_MARKER}@host/database`
  );
  secretError.code = "social_http_canary_synthetic_failure";
  const { service, vault } = createService({
    probe: {
      async runMutation() {
        throw secretError;
      },
      async verifyResiduals() {
        verifyCalls += 1;
        return 0;
      }
    }
  });
  try {
    const result = await service.run();
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "social_http_canary_failed");
    assert.equal(result.cleanupCompleted, true);
    assert.equal(result.residualRecords, 0);
    assert.equal(verifyCalls, 1);
    assert.equal(JSON.stringify(result).includes(SECRET_MARKER), false);
  } finally {
    vault.destroy();
  }
});

test("uncertain transaction state escapes immediately so the locked session can be destroyed", async () => {
  for (const code of [
    "social_http_canary_rollback_failed",
    "social_http_canary_transaction_state_uncertain"
  ]) {
    let verifyCalls = 0;
    const { service, vault } = createService({
      probe: {
        async runMutation() {
          const error = new Error("Synthetic uncertain transaction state.");
          error.code = code;
          throw error;
        },
        async verifyResiduals() {
          verifyCalls += 1;
          return 0;
        }
      }
    });
    try {
      await assert.rejects(service.run(), { code });
      assert.equal(verifyCalls, 0);
    } finally {
      vault.destroy();
    }
  }
});

test("uncertain residual-verification transaction also escapes the service", async () => {
  const code = "social_http_canary_rollback_failed";
  const { service, vault } = createService({
    probe: {
      async runMutation() {
        return passedDatabaseResult();
      },
      async verifyResiduals() {
        const error = new Error("Synthetic residual rollback failure.");
        error.code = code;
        throw error;
      }
    }
  });
  try {
    await assert.rejects(service.run(), { code });
  } finally {
    vault.destroy();
  }
});

test("non-zero residue fails the whole run without partial success", async () => {
  const { service, vault } = createService({
    probe: {
      async runMutation() {
        return passedDatabaseResult();
      },
      async verifyResiduals() {
        return 1;
      }
    }
  });
  try {
    const result = await service.run();
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "social_http_canary_residual_records_found");
    assert.equal(result.cleanupCompleted, false);
    assert.equal(result.residualRecords, 1);
  } finally {
    vault.destroy();
  }
});

test("failure logs and HTTP result expose only allowlisted codes", async () => {
  const logs = [];
  const { service, vault } = createService({
    logger: {
      error(event) {
        logs.push(event);
      }
    },
    probe: {
      async runMutation() {
        const error = new Error(SECRET_MARKER);
        error.code = `social_http_canary_${SECRET_MARKER}`;
        throw error;
      },
      async verifyResiduals() {
        return 0;
      }
    }
  });
  try {
    const result = await service.run();
    assert.equal(result.errorCode, "social_http_canary_failed");
    assert.deepEqual(logs, [{
      component: "social_http_canary",
      code: "social_http_canary_failed"
    }]);
    assert.equal(JSON.stringify({ result, logs }).includes(SECRET_MARKER), false);
  } finally {
    vault.destroy();
  }
});

test("service refuses a probe result without idempotency or confirmed rollback gates", async () => {
  for (const missingField of ["idempotentWrites", "mutationRolledBack"]) {
    const database = passedDatabaseResult();
    delete database[missingField];
    const { service, vault } = createService({
      probe: {
        async runMutation() {
          return database;
        },
        async verifyResiduals() {
          return 0;
        }
      }
    });
    try {
      const result = await service.run();
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "social_http_canary_gate_failed");
      assert.equal(result[missingField], false);
    } finally {
      vault.destroy();
    }
  }
});

test("result sanitizer drops SQL, URLs, credentials, stack and arbitrary fields", () => {
  const sanitized = sanitizeHttpCanaryResult({
    runId: "55555555-5555-4555-8555-555555555555",
    status: "failed",
    errorCode: "safe_code",
    residualRecords: 0,
    durationMs: 1,
    databaseUrl: `postgresql://runtime:${SECRET_MARKER}@host/database`,
    token: SECRET_MARKER,
    ciphertext: SECRET_MARKER,
    sql: "SELECT secret",
    stack: SECRET_MARKER
  });
  assert.deepEqual(Object.keys(sanitized).sort(), [
    "cleanupCompleted",
    "crossTenantDeniedA",
    "crossTenantDeniedB",
    "durationMs",
    "errorCode",
    "idempotentWrites",
    "missingContextDenied",
    "mutationRolledBack",
    "ownReadA",
    "ownReadB",
    "residualRecords",
    "runId",
    "status",
    "tamperedContextDenied",
    "vaultCrossTenantDenied",
    "vaultRoundTripPassed",
    "vaultTamperDenied"
  ].sort());
  assert.equal(JSON.stringify(sanitized).includes(SECRET_MARKER), false);
});
