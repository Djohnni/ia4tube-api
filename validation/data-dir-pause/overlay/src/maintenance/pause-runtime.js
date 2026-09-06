"use strict";
const { createPauseController } = require("./pause-controller");
const REQUEST = Symbol("ia4tube.pause.request");
const CONTINUATION = Symbol("ia4tube.pause.continuation");

function createPauseRuntime({ enabled = false, defer = setImmediate, controller = createPauseController() } = {}) {
  let faults = 0;
  const admission = (req, res, next) => {
    if (!enabled) return next();
    if (controller.status().state !== "normal") {
      // Deliberately tiny read-only health response; no legacy GET is executed.
      if (req.method === "GET" && req.url === "/") return res.json({ ok: true, maintenance: true });
      res.setHeader("Retry-After", "30");
      res.setHeader("Cache-Control", "no-store");
      return res.status(503).json({ ok: false, code: "data_dir_paused", error: "Manutencao temporaria. Tente novamente depois." });
    }
    const lease = controller.acquire("http-request");
    req[REQUEST] = lease;
    const completion = lease.run(() => new Promise((resolve, reject) => {
      // Children own their actual completion. A disconnected socket therefore
      // cannot finish a running async handler or a still-open multer callback.
      res.once("finish", resolve);
      res.once("close", resolve);
      try { next(); } catch (error) { reject(error); }
    }));
    Promise.resolve(completion).catch(next);
  };

  function wrapLayer(original) {
    function invoke(receiver, args, nextIndex) {
      const req = args[nextIndex - 2], res = args[nextIndex - 1], originalNext = args[nextIndex];
      if (!req[REQUEST]) return original.apply(receiver, args);
      // A response close finishes the request's own wait, not its live handler.
      // next() must attach downstream work to that live handler rather than to
      // the already-finished request root. The scoped marker is restored before
      // yielding, so concurrent asynchronous branches do not share mutable state.
      const lease = controller.acquire("http-handler", { parent: req[CONTINUATION] || req[REQUEST] });
      const result = lease.run(() => new Promise((resolve, reject) => {
        // A response that was already finished/destroyed before this callback
        // began is not evidence that this newly admitted callback has finished.
        let returned = false, nextCalled = false, responseFinished = false, pendingPromise = false;
        const done = () => {
          if (returned && !pendingPromise && (original.length < nextIndex + 1 || nextCalled || responseFinished)) {
            res.removeListener("finish", finish); resolve();
          }
        };
        const finish = () => { responseFinished = true; done(); };
        res.once("finish", finish);
        args[nextIndex] = lease.bind((...nextArgs) => {
          nextCalled = true;
          const previous = req[CONTINUATION];
          req[CONTINUATION] = lease;
          try { originalNext(...nextArgs); } catch (error) { reject(error); }
          finally {
            if (previous === undefined) delete req[CONTINUATION];
            else req[CONTINUATION] = previous;
          }
          done();
        });
        const failed = error => {
          pendingPromise = false;
          returned = true;
          res.removeListener("finish", finish);
          // Forward while this lease is still live. A catch attached after
          // lease.run settles would otherwise point error handlers at a closed
          // parent, especially after an aborted response.
          try { args[nextIndex](error); resolve(); } catch (forwardError) { reject(forwardError); }
        };
        try {
          const value = original.apply(receiver, args);
          pendingPromise = Boolean(value && typeof value.then === "function");
          returned = true;
          if (pendingPromise) Promise.resolve(value).then(() => {
            pendingPromise = false; res.removeListener("finish", finish); resolve();
          }, failed);
          else done();
        } catch (error) { failed(error); }
      }));
      Promise.resolve(result).catch(originalNext);
      return result;
    }
    // Express 4 detects error middleware by arity. Keep it unchanged.
    return original.length === 4
      ? function(error, req, res, next) { return invoke(this, [error, req, res, next], 3); }
      : function(req, res, next) { return invoke(this, [req, res, next], 2); };
  }

  function finalizeRouting(app) {
    if (!enabled) return;
    if (!app._router || !Array.isArray(app._router.stack)) throw new Error("pause_express_stack_refused");
    const seen = new Set();
    function walk(stack) {
      for (const layer of stack) {
        if (seen.has(layer)) continue;
        seen.add(layer);
        if (layer.route && Array.isArray(layer.route.stack)) walk(layer.route.stack);
        else if (layer.handle && Array.isArray(layer.handle.stack)) walk(layer.handle.stack);
        else if (typeof layer.handle === "function" && layer.handle !== admission) layer.handle = wrapLayer(layer.handle);
        else if (layer.handle !== admission) throw new Error("pause_express_layer_refused");
      }
    }
    walk(app._router.stack);
  }
  function background(kind, fn) {
    if (!enabled) return fn;
    return function(...args) {
      if (controller.status().state !== "normal") return;
      return controller.run(kind, () => fn.apply(this, args));
    };
  }
  function detached(kind, fn) { return enabled ? controller.fork(kind, fn) : fn(); }
  function deferred(kind, fn) {
    if (!enabled) return defer(fn);
    const lease = controller.acquire(kind);
    try {
      return defer(() => { Promise.resolve(lease.run(fn)).catch(() => { faults++; }); });
    } catch (error) { faults++; lease.finish(); throw error; }
  }
  return Object.freeze({ enabled, controller, admission, finalizeRouting, background, detached, deferred, faults: () => faults });
}
module.exports = { createPauseRuntime };
