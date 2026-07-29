"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  MANUAL_TEST_FILES,
  discoverAutomatedTests
} = require("../scripts/run-node-tests");

test("the ordinary Node test runner excludes every manual database gate", () => {
  const testDirectory = path.resolve(__dirname);
  const discovered = discoverAutomatedTests(testDirectory).map((file) =>
    path.basename(file)
  );

  assert.ok(discovered.includes("node-test-runner-safety.test.js"));
  assert.deepEqual([...MANUAL_TEST_FILES], ["social-postgres-real.test.js"]);
  assert.equal(discovered.includes("social-postgres-real.test.js"), false);
});
