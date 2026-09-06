'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

// Process-local admission/accounting only. Every writer, including detached work,
// must register before it is scheduled. This module does not discover writers,
// cancel business work, supervise OS processes or prove a capture artifact.
function createPauseController(options = {}) {
  const now = options.now || (() => performance.now());
  const schedule = options.setTimeout || setTimeout;
  const unschedule = options.clearTimeout || clearTimeout;
  if ([now, schedule, unschedule].some(value => typeof value !== 'function')) {
    throw failure('pause_configuration_invalid');
  }
  const epoch = randomUUID();
  const context = new AsyncLocalStorage();
  const leases = new WeakMap();
  const operations = new Set();
  const captureIds = new Set();
  let state = 'normal';
  let drain = null;
  let cycleHadCapture = false;
  let capture = null;
  let lastCapture = null;

  function failure(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }
  function requireState(condition, code) {
    if (!condition) throw failure(code);
  }
  function status() {
    const kinds = Object.create(null);
    for (const operation of operations) kinds[operation.kind] = (kinds[operation.kind] || 0) + 1;
    return Object.freeze({
      state, epoch, inFlight: operations.size, kinds: Object.freeze(kinds),
      capture: capture ? Object.freeze({
        captureId: capture.captureId, epoch, valid: capture.valid,
        abortRequested: capture.abortRequested, abortHookFailed: capture.abortHookFailed,
      }) : null,
      lastCapture: lastCapture ? Object.freeze({ ...lastCapture }) : null,
    });
  }
  function stopDrainWait(error) {
    if (!drain) return;
    const pending = drain;
    drain = null;
    if (pending.timer !== null) unschedule(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(status());
  }
  function checkDrained() {
    if (state === 'draining' && operations.size === 0) {
      state = 'frozen';
      stopDrainWait();
    }
  }
  function settle(operation) {
    if (operation.removed || !operation.ownFinished || operation.children.size !== 0) return;
    operation.removed = true;
    operations.delete(operation);
    if (operation.parent) {
      operation.parent.children.delete(operation);
      settle(operation.parent);
    }
    checkDrained();
  }
  function finish(operation) {
    // HTTP finish/close cannot release a lease whose actual Promise is running.
    if (operation.ownFinished || operation.running) return;
    operation.ownFinished = true;
    settle(operation);
  }
  function acquire(kind, acquireOptions = {}) {
    requireState(typeof kind === 'string' && /^[a-z][a-z0-9_-]{0,47}$/.test(kind), 'pause_kind_invalid');
    requireState(acquireOptions && typeof acquireOptions === 'object', 'pause_options_invalid');
    let parent;
    if (Object.hasOwn(acquireOptions, 'parent')) {
      parent = leases.get(acquireOptions.parent);
      requireState(Boolean(parent), 'pause_parent_invalid');
    } else {
      parent = context.getStore() || null;
    }
    if (parent) {
      // A late callback inherited from a finished operation must not silently
      // acquire a new root, even after normal operation has resumed.
      requireState(!parent.ownFinished && !parent.removed, 'pause_parent_closed');
      requireState(state === 'normal' || state === 'draining', 'pause_admission_closed');
    } else {
      requireState(state === 'normal', 'pause_admission_closed');
    }
    const operation = { kind, parent, children: new Set(), ownFinished: false, running: false, ran: false, removed: false };
    operations.add(operation);
    if (parent) parent.children.add(operation);
    const lease = Object.freeze({
      async run(fn) {
        requireState(typeof fn === 'function', 'pause_operation_invalid');
        requireState(!operation.ran && !operation.ownFinished && !operation.removed, 'pause_lease_closed');
        operation.ran = true;
        operation.running = true;
        try { return await context.run(operation, fn); }
        finally {
          operation.running = false;
          operation.ownFinished = true;
          settle(operation);
        }
      },
      finish() { finish(operation); },
      bind(fn) {
        requireState(typeof fn === 'function', 'pause_operation_invalid');
        requireState(!operation.ownFinished && !operation.removed, 'pause_parent_closed');
        // Binding restores the context for a callback, not its lifetime. The
        // caller must keep this lease running until the callback actually ends.
        return function(...args) {
          requireState(!operation.ownFinished && !operation.removed, 'pause_parent_closed');
          return context.run(operation, () => fn.apply(this, args));
        };
      },
    });
    leases.set(lease, operation);
    return lease;
  }
  function run(kind, fn) {
    requireState(typeof fn === 'function', 'pause_operation_invalid');
    return acquire(kind).run(fn);
  }
  function beginDrain({ timeoutMs } = {}) {
    requireState(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 1800000, 'pause_timeout_invalid');
    if (state === 'draining' && drain) return drain.promise;
    requireState(state === 'normal', 'pause_state_conflict');
    const deadline = now() + timeoutMs;
    requireState(Number.isFinite(deadline), 'pause_clock_invalid');
    state = 'draining'; // Synchronous fence, before returning the wait Promise.
    cycleHadCapture = false;
    let resolve, reject;
    const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    drain = { promise, resolve, reject, timer: null, deadline };
    const pending = drain;
    function deadlineReached() {
      if (drain !== pending) return;
      const remaining = pending.deadline - now();
      if (Number.isFinite(remaining) && remaining > 0) {
        pending.timer = schedule(deadlineReached, remaining);
      } else {
        // Timeout is not cancellation or completion. Admission stays closed and
        // the same operations stay counted until their actual settlement.
        stopDrainWait(failure('pause_drain_timeout'));
      }
    }
    pending.timer = schedule(deadlineReached, timeoutMs);
    checkDrained();
    return promise;
  }
  function cancelDrain() {
    requireState((state === 'draining' || state === 'frozen') && !cycleHadCapture && !capture, 'pause_state_conflict');
    state = 'normal';
    stopDrainWait(failure('pause_drain_cancelled'));
    return status();
  }
  function checkEpoch(requestEpoch) {
    requireState(requestEpoch === epoch, 'pause_epoch_stale');
  }
  function matchCapture(captureId, requestEpoch) {
    checkEpoch(requestEpoch);
    requireState(capture && capture.captureId === captureId && (state === 'capturing' || state === 'aborting'), 'pause_capture_stale');
  }
  function startCapture(captureId, { abort, epoch: requestEpoch } = {}) {
    checkEpoch(requestEpoch);
    requireState(typeof captureId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(captureId), 'pause_capture_id_invalid');
    requireState(typeof abort === 'function', 'pause_capture_abort_invalid');
    requireState(state === 'frozen' && operations.size === 0 && !capture, 'pause_state_conflict');
    requireState(!captureIds.has(captureId), 'pause_capture_stale');
    captureIds.add(captureId);
    cycleHadCapture = true;
    capture = { captureId, abort, valid: true, abortRequested: false, abortHookFailed: false };
    state = 'capturing';
    return status();
  }
  function abortCapture(captureId, { epoch: requestEpoch } = {}) {
    matchCapture(captureId, requestEpoch);
    if (state === 'aborting') return status();
    const current = capture;
    current.valid = false;
    current.abortRequested = true;
    state = 'aborting'; // Invalidate before invoking the supervisor's abort hook.
    try {
      Promise.resolve(current.abort()).catch(() => { current.abortHookFailed = true; });
    } catch (_) { current.abortHookFailed = true; }
    return status();
  }
  function captureClosed(captureId, { success, verified, epoch: requestEpoch } = {}) {
    // TRUST BOUNDARY: only the in-process supervisor calls this after child
    // 'close' (not timeout/exit or a client's asserted boolean). This module
    // cannot independently establish OS process closure or artifact integrity.
    matchCapture(captureId, requestEpoch);
    requireState(typeof success === 'boolean' && typeof verified === 'boolean', 'pause_capture_result_invalid');
    const completed = state === 'capturing' && capture.valid && success && verified;
    lastCapture = { captureId, epoch, outcome: completed ? 'completed' : 'invalid', verified: completed };
    capture = null;
    state = 'frozen';
    return status();
  }
  function resume() {
    requireState(state === 'frozen' && !capture && operations.size === 0, 'pause_state_conflict');
    state = 'normal';
    return status();
  }
  return Object.freeze({ acquire, run, fork: run, beginDrain, cancelDrain, status, startCapture, abortCapture, captureClosed, resume });
}

module.exports = { createPauseController };
