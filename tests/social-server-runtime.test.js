"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  initializeSocialServerRuntime,
  installSocialRuntimeShutdown,
  safeErrorCode
} = require("../src/social/server-runtime");

test("disabled social persistence preserves startup without creating a runtime", async () => {
  let createCalls = 0;
  const state = await initializeSocialServerRuntime({
    env: { SOCIAL_PERSISTENCE_ENABLED: "false" },
    async createRuntime() {
      createCalls += 1;
    }
  });
  assert.equal(state.enabled, false);
  assert.equal(createCalls, 0);
  await state.close();
  assert.equal(createCalls, 0);

  const processObject = new EventEmitter();
  assert.equal(
    installSocialRuntimeShutdown({
      runtimeState: state,
      server: { close() {} },
      processObject
    }),
    false
  );
  assert.equal(processObject.listenerCount("SIGTERM"), 0);
  assert.equal(processObject.listenerCount("SIGINT"), 0);
});

test("enabled social persistence uses the same normalized true semantics as config", async () => {
  let createCalls = 0;
  const state = await initializeSocialServerRuntime({
    env: { SOCIAL_PERSISTENCE_ENABLED: " TRUE " },
    async createRuntime() {
      createCalls += 1;
      return {
        enabled: true,
        async close() {}
      };
    }
  });
  assert.equal(state.enabled, true);
  assert.equal(createCalls, 1);
  await state.close();
});

test("enabled social persistence initializes and closes exactly once", async () => {
  let createCalls = 0;
  let closeCalls = 0;
  const env = { SOCIAL_PERSISTENCE_ENABLED: "true" };
  const state = await initializeSocialServerRuntime({
    env,
    async createRuntime(options) {
      createCalls += 1;
      assert.equal(options.env, env);
      return {
        enabled: true,
        async close() {
          closeCalls += 1;
        }
      };
    }
  });
  assert.equal(state.enabled, true);
  assert.equal(createCalls, 1);
  await state.close();
  await state.close();
  assert.equal(closeCalls, 1);
});

test("server runtime refuses a pool other than three before initialization", async () => {
  let createCalls = 0;
  await assert.rejects(
    initializeSocialServerRuntime({
      env: {
        SOCIAL_PERSISTENCE_ENABLED: "true",
        SOCIAL_DATABASE_POOL_MAX: "2"
      },
      async createRuntime() {
        createCalls += 1;
      }
    }),
    { code: "social_server_runtime_pool_must_be_three" }
  );
  assert.equal(createCalls, 0);
});

test("enabled runtime must return a closeable initialized instance", async () => {
  await assert.rejects(
    initializeSocialServerRuntime({
      env: { SOCIAL_PERSISTENCE_ENABLED: "true" },
      async createRuntime() {
        return { enabled: false };
      }
    }),
    { code: "social_server_runtime_initialization_failed" }
  );
});

test("SIGTERM closes HTTP and social runtime without duplicate shutdown", async () => {
  const processObject = new EventEmitter();
  let serverCloseCalls = 0;
  let runtimeCloseCalls = 0;
  let exitCalls = 0;
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const timer = { unref() {} };

  const installed = installSocialRuntimeShutdown({
    runtimeState: {
      enabled: true,
      async close() {
        runtimeCloseCalls += 1;
      }
    },
    server: {
      close(callback) {
        serverCloseCalls += 1;
        callback();
      }
    },
    processObject,
    setTimer() {
      return timer;
    },
    clearTimer(value) {
      assert.equal(value, timer);
    },
    exit(code) {
      exitCalls += 1;
      resolveExit(code);
    }
  });

  assert.equal(installed, true);
  processObject.emit("SIGTERM");
  processObject.emit("SIGINT");
  assert.equal(await exited, 0);
  assert.equal(serverCloseCalls, 1);
  assert.equal(runtimeCloseCalls, 1);
  assert.equal(exitCalls, 1);
});

test("safe startup reporting never falls back to an exception message", () => {
  assert.equal(
    safeErrorCode(
      {
        code: "database_url_missing",
        message: "postgresql://user:secret@host/database"
      },
      "fallback"
    ),
    "database_url_missing"
  );
  assert.equal(
    safeErrorCode(
      {
        code: "unsafe code postgresql://user:secret@host/database",
        message: "secret"
      },
      "fallback"
    ),
    "fallback"
  );
});
