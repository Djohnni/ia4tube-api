'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_OUTPUT = 16384;

function refusal(code) { const error = new Error(code); error.code = code; return error; }
function need(test, code) { if (!test) throw refusal(code); }
function validResult(value, request) {
  return Boolean(value && Object.keys(value).sort().join('|') === [
    'kind','captureId','epoch','sourceFingerprint','verified','posixArchiveCompared',
    'posixRestoreVerified','manifestSha256','bundleSha256','bundleBytes','files','directories','logicalBytes',
  ].sort().join('|') && value.kind === 'ia4tube-data-dir-capture-result-v1' &&
    value.captureId === request.captureId && value.epoch === request.epoch &&
    value.sourceFingerprint === request.sourceFingerprint && value.verified === true &&
    value.posixArchiveCompared === true && value.posixRestoreVerified === false &&
    typeof value.manifestSha256 === 'string' && typeof value.bundleSha256 === 'string' && SHA.test(value.manifestSha256) && SHA.test(value.bundleSha256) &&
    Number.isSafeInteger(value.bundleBytes) && value.bundleBytes > 0 &&
    Number.isSafeInteger(value.logicalBytes) && value.logicalBytes >= 0 && value.logicalBytes <= 1073741824 &&
    Number.isSafeInteger(value.files) && value.files >= 0 &&
    Number.isSafeInteger(value.directories) && value.directories > 0);
}

// Trusted in-process configuration only. No paths/commands supplied by IPC users.
function createCaptureSupervisor(options) {
  const { controller } = options || {};
  need(controller && ['status','startCapture','abortCapture','captureClosed'].every(name => typeof controller[name] === 'function'), 'capture_controller_invalid');
  const fixture = options.testOnly === true;
  need(!fixture || typeof options.spawnWorker === 'function', 'capture_fixture_spawn_required');
  const workerPath = path.join(__dirname, 'capture-worker.js');
  const schedule = options.setTimeout || setTimeout;
  const unschedule = options.clearTimeout || clearTimeout;
  const launch = options.spawnWorker || ((command, args, settings) => spawn(command, args, settings));
  const groupAlive = options.groupAlive || (child => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw refusal('capture_group_state_unknown'); }
  });
  const terminate = options.terminate || (child => {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw refusal('capture_group_termination_failed'); }
  });
  let active = null;

  function start(input) {
    need(!active, 'capture_already_active');
    need(input && typeof input.captureId === 'string' && typeof input.epoch === 'string' && typeof input.sourceFingerprint === 'string' && UUID.test(input.captureId) && UUID.test(input.epoch) && SHA.test(input.sourceFingerprint), 'capture_request_invalid');
    need(Number.isSafeInteger(input.ttlMs) && input.ttlMs > 0 && input.ttlMs <= 1800000, 'capture_deadline_invalid');
    need(Buffer.isBuffer(input.bundleKey) && input.bundleKey.length === 32, 'capture_key_invalid');
    const initial = controller.status();
    need(initial.state === 'frozen' && initial.inFlight === 0 && initial.epoch === input.epoch && !initial.capture, 'capture_not_frozen');
    need(options.sourceRoot === undefined || path.resolve(options.sourceRoot) === path.resolve('/var/data'), 'capture_source_configuration_refused');
    need(options.envelopePath === undefined || path.resolve(options.envelopePath) === path.join(__dirname, 'recovery', 'encrypted-backup-bundle.js'), 'capture_envelope_configuration_refused');
    if (!fixture) {
      need(process.platform === 'linux', 'capture_posix_required');
      for (const pin of [options.workerSha256, options.envelopeSha256, options.tarSha256]) need(typeof pin === 'string' && SHA.test(pin), 'capture_tool_pin_required');
      const stat = fs.lstatSync(workerPath);
      need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && crypto.createHash('sha256').update(fs.readFileSync(workerPath)).digest('hex') === options.workerSha256, 'capture_worker_pin_mismatch');
    }
    const request = {
      kind: 'ia4tube-data-dir-capture-request-v1', captureId: input.captureId, epoch: input.epoch,
      sourceRoot: '/var/data', sourceFingerprint: input.sourceFingerprint,
      envelopeSha256: options.envelopeSha256, tarSha256: options.tarSha256,
      keyBase64: input.bundleKey.toString('base64'),
    };
    const env = { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
    for (const name of ['SystemRoot','WINDIR','TEMP','TMP']) if (process.env[name]) env[name] = process.env[name];
    // Worker initially waits for stdin. Nothing can capture before startCapture.
    const child = launch(process.execPath, [workerPath], { shell: false, windowsHide: true, detached: !fixture,
      stdio: ['pipe','pipe','pipe'], env });
    let resolveCompletion;
    const completion = new Promise(resolve => { resolveCompletion = resolve; });
    const run = { child, request, closed: false, invalid: false, registered: false, done: false,
      timer: null, poll: null, output: [], bytes: 0, stderr: false, processError: false, result: null };
    active = run;
    function stopChild() { run.invalid = true; terminate(child); }
    function invalidate() {
      if (run.done) return false;
      run.invalid = true;
      if (run.registered) controller.abortCapture(request.captureId, { epoch: request.epoch });
      else { try { terminate(child); } catch (_) { /* Closure remains mandatory. */ } }
      return true;
    }
    function afterClose() {
      if (!run.closed || run.done) return;
      let alive;
      try { alive = groupAlive(child); }
      catch (_) { alive = true; invalidate(); }
      if (alive) {
        invalidate();
        // Unknown or surviving descendants keep the barrier closed indefinitely.
        // This is supervision, not a timeout interpreted as termination.
        run.poll = schedule(afterClose, 100);
        return;
      }
      const verified = !run.invalid && run.result !== null && run.registered;
      let status = controller.status();
      if (run.registered) status = controller.captureClosed(request.captureId, { epoch: request.epoch, success: verified, verified });
      run.done = true;
      active = null;
      run.output.length = 0;
      resolveCompletion(Object.freeze({ passed: verified, code: verified ? 'capture_verified' : 'capture_invalidated',
        captureId: request.captureId, childClosed: true, processGroupEmpty: true,
        result: verified ? run.result : null, status }));
    }
    child.on('error', () => { run.processError = true; invalidate(); });
    child.stdin.on('error', () => { run.processError = true; invalidate(); });
    child.stdout.on('data', chunk => {
      run.bytes += chunk.length;
      if (run.bytes > MAX_OUTPUT) { run.output.length = 0; invalidate(); }
      else if (!run.invalid) run.output.push(Buffer.from(chunk));
    });
    child.stderr.on('data', () => { run.stderr = true; invalidate(); }); // Never expose raw child output.
    // 'exit' is deliberately not a completion event: stdio/descendants may remain.
    child.once('close', (code, signal) => {
      run.closed = true;
      if (run.timer !== null) unschedule(run.timer);
      if (code !== 0 || signal || run.processError || run.stderr) invalidate();
      if (!run.invalid) {
        try {
          const value = JSON.parse(Buffer.concat(run.output).toString('utf8'));
          if (!validResult(value, request)) invalidate(); else run.result = value;
        } catch (_) { invalidate(); }
      }
      afterClose();
    });
    try {
      controller.startCapture(request.captureId, { epoch: request.epoch, abort: stopChild });
      run.registered = true;
      run.timer = schedule(invalidate, input.ttlMs);
      const packet = Buffer.from(JSON.stringify(request) + '\n');
      request.keyBase64 = undefined;
      child.stdin.end(packet, () => packet.fill(0));
    } catch (_) { request.keyBase64 = undefined; invalidate(); child.stdin.destroy(); }
    return Object.freeze({ captureId: request.captureId, completion, abandon: invalidate });
  }
  return Object.freeze({ start, status: () => active ? Object.freeze({ captureId: active.request.captureId, closed: active.closed, invalid: active.invalid }) : null });
}

module.exports = { createCaptureSupervisor, validResult };
