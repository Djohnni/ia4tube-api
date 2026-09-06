"use strict";

// Local preparation proof, not a deployment, load test or Instagram test.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const files = Object.freeze([
  "art-ready-production-candidate.test.js",
  "body-parser-security.test.js",
  "fcm-disabled-upload-integration.test.js",
  "fcm-final-test.test.js",
  "fcm-production-gates.test.js",
  "fcm-token-api-contract.test.js",
  "fcm-token-security.test.js",
  "free_art_campaigns.test.js",
  "free_art_campaigns_notifications.test.js",
  "monthly_planning_photo_items.test.js",
  "product_discovery.test.js",
  "zip-downloads.test.js",
  "production-social-db-preflight.test.js",
  "production-social-live-compatibility.test.js",
  "production-social-session-media.test.js",
  "production-social-web.test.js",
  "production-social-http-assembly.test.js",
  "production-social-oauth-connection-http.test.js",
  "production-social-tenant-readiness.test.js",
  "production-social-tenant-provisioning.test.js",
  "production-social-tenant-login-http.test.js",
  "social-official-owner-migration.test.js",
  "social-publication-atomic-integration.test.js",
  "social-publication-binding-migration.test.js",
  "social-publication-connection-binding.test.js",
  "social-2b0-config-security.test.js",
  "social-postgres-foundation.test.js",
  "social-postgres-tls.test.js",
  "social-vault-reauth.test.js"
].map(name => `tests/${name}`));

function sourceHashes() {
  const result = {};
  function scan(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes:true})) {
      const target = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Test source symlink refused.");
      if (entry.isDirectory()) scan(target);
      else if (entry.isFile()) result[target] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root,target))).digest('hex');
    }
  }
  for (const relative of ['src','tests','scripts','db']) scan(relative);
  for (const relative of ['server.js','package.json','package-lock.json','.gitattributes']) {
    result[relative] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root,relative))).digest('hex');
  }
  return result;
}

function main() {
  const reportDirectory = process.argv[2];
  if (!reportDirectory || !path.isAbsolute(reportDirectory)) throw new Error("Supply an absolute output directory outside the worktree.");
  const relative = path.relative(root, reportDirectory);
  if (!relative.startsWith('..') || path.isAbsolute(relative)) throw new Error("Report destination must be outside this worktree on the same volume.");
  const selectedEnvironment = {};
  for (const name of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','ComSpec','PATHEXT','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','LANG']) {
    if (process.env[name] !== undefined) selectedEnvironment[name] = process.env[name];
  }
  // No user API credentials, database variables or ambient preload enter tests.
  selectedEnvironment.NODE_OPTIONS = `--require="${path.join(root,'tests/helpers/local-network-only.cjs').replace(/\\/g,'/')}"`;
  const before = sourceHashes();
  const startedAt = new Date().toISOString();
  const run = spawnSync(process.execPath, ['--test','--test-concurrency=1','--test-reporter=tap', ...files], {
    cwd: root, env: selectedEnvironment, encoding:'utf8', windowsHide:true,
    timeout: 180000, maxBuffer: 16 * 1024 * 1024
  });
  const after = sourceHashes();
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  const output = String(run.stdout || '');
  const count = name => {
    const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
    return matches.length ? Number(matches.at(-1)[1]) : null;
  };
  const report = {
    format:1, kind:'local-production-preparation-tests', startedAt, completedAt:new Date().toISOString(),
    node:process.version, platform:process.platform, architecture:process.arch,
    files, sourceUnchangedDuringRun:unchanged, sourceSha256:after,
    tests:count('tests'), passed:count('pass'), failed:count('fail'), skipped:count('skipped'),
    cancelled:count('cancelled'), exitCode:run.status,
    infrastructureError:run.error ? 'local_test_process_failed' : null,
    passedSnapshot:run.status === 0 && unchanged && count('fail') === 0,
    network:'loopback-only Node preload; no inherited service secrets',
    databasePhysicalConcurrencyProven:false, productionCapacityProven:false, metaCallsAuthorized:false
  };
  fs.mkdirSync(reportDirectory,{recursive:true});
  const suffix = startedAt.replace(/[:.]/g,'-');
  const reportPath = path.join(reportDirectory,`PRODUCTION_PREPARATION_TESTS_${suffix}.json`);
  const logPath = path.join(reportDirectory,`PRODUCTION_PREPARATION_TESTS_${suffix}.tap`);
  fs.writeFileSync(reportPath, JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  fs.writeFileSync(logPath, output + String(run.stderr || ''),{flag:'wx'});
  process.stdout.write(JSON.stringify({reportPath,logPath,tests:report.tests,passed:report.passed,
    failed:report.failed,skipped:report.skipped,sourceUnchangedDuringRun:unchanged,exitCode:run.status})+'\n');
  process.exitCode = report.passedSnapshot ? 0 : 1;
}

if (require.main === module) main();
module.exports = { files, sourceHashes };
