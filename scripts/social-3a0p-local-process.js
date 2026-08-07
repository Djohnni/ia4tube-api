"use strict";

const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const {
  HarnessFailure,
  canonicalCode
} = require("./social-3a0p-local-harness-core");

const SAFE_BASE_ENVIRONMENT = new Set([
  "comspec",
  "path",
  "pathext",
  "systemdrive",
  "systemroot",
  "temp",
  "tmp",
  "tmpdir",
  "windir"
]);
const SENSITIVE_ARGUMENT = Object.freeze([
  /postgres(?:ql)?:\/\//i,
  /(?:password|secret|token|authorization)\s*[:=]/i,
  /bearer\s+[a-z0-9._~-]+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i
]);
const OUTPUT_REDACTIONS = Object.freeze([
  [/(?:postgres|postgresql):\/\/[^\s"']+/gi, "[redacted-database-url]"],
  [
    /(authorization\s*[:=]\s*)(bearer\s+[^\s,;]+|[^\s,;]+)/gi,
    "$1[redacted]"
  ],
  [/(bearer\s+)([a-z0-9._~-]+)/gi, "$1[redacted]"],
  [
    /((?:password|secret|token|private[_-]?key)\s*[:=]\s*)([^\s,;]+)/gi,
    "$1[redacted]"
  ],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
    "[redacted-private-key]"
  ]
]);

function percentHexLower(value) {
  return value.replace(/%[0-9A-F]{2}/g, (match) => match.toLowerCase());
}

function createSecretRegistry(values = []) {
  if (!Array.isArray(values)) {
    throw new HarnessFailure("harness_process_secret_registry_invalid");
  }
  const variants = new Set();
  for (const value of values) {
    if (Buffer.isBuffer(value)) {
      if (value.length < 4) {
        throw new HarnessFailure("harness_process_secret_registry_value_invalid");
      }
      variants.add(value.toString("hex"));
      variants.add(value.toString("base64"));
      variants.add(value.toString("base64url"));
      const utf8 = value.toString("utf8");
      if (
        !utf8.includes("\0") &&
        Buffer.from(utf8, "utf8").equals(value)
      ) {
        variants.add(utf8);
        const encoded = encodeURIComponent(utf8);
        const formEncoded = new URLSearchParams([["value", utf8]])
          .toString()
          .slice("value=".length);
        variants.add(encoded);
        variants.add(percentHexLower(encoded));
        variants.add(formEncoded);
        variants.add(percentHexLower(formEncoded));
      }
      continue;
    }
    const secret = value;
    if (
      typeof secret !== "string" ||
      secret.length < 4 ||
      secret.includes("\0")
    ) {
      throw new HarnessFailure("harness_process_secret_registry_value_invalid");
    }
    const encoded = encodeURIComponent(secret);
    const formEncoded = new URLSearchParams([["value", secret]])
      .toString()
      .slice("value=".length);
    const bytes = Buffer.from(secret, "utf8");
    for (const representation of [
      secret,
      encoded,
      percentHexLower(encoded),
      formEncoded,
      percentHexLower(formEncoded),
      bytes.toString("base64"),
      bytes.toString("base64url")
    ]) {
      if (representation.length >= 4) variants.add(representation);
    }
  }
  const ordered = [...variants].sort((left, right) => right.length - left.length);
  const maxVariantBytes = ordered.reduce(
    (maximum, value) => Math.max(maximum, Buffer.byteLength(value, "utf8")),
    0
  );
  return Object.freeze({
    maxVariantBytes,
    redact(text) {
      let result = text;
      for (const variant of ordered) {
        result = result.split(variant).join("[scrubbed]");
      }
      return result;
    },
    assertAbsent(text) {
      if (ordered.some((variant) => text.includes(variant))) {
        throw new HarnessFailure("harness_process_output_secret_redaction_failed");
      }
      return true;
    }
  });
}

function normalizeSecretRegistry(registry) {
  if (registry === undefined || registry === null) return createSecretRegistry([]);
  if (
    typeof registry !== "object" ||
    typeof registry.redact !== "function" ||
    typeof registry.assertAbsent !== "function" ||
    !Number.isSafeInteger(registry.maxVariantBytes) ||
    registry.maxVariantBytes < 0
  ) {
    throw new HarnessFailure("harness_process_secret_registry_invalid");
  }
  return registry;
}

function combineSecretRegistries(baseRegistry, perRunRegistry) {
  const base = normalizeSecretRegistry(baseRegistry);
  const perRun = normalizeSecretRegistry(perRunRegistry);
  return Object.freeze({
    maxVariantBytes: Math.max(
      base.maxVariantBytes,
      perRun.maxVariantBytes
    ),
    redact(text) {
      return perRun.redact(base.redact(text));
    },
    assertAbsent(text) {
      base.assertAbsent(text);
      perRun.assertAbsent(text);
      return true;
    }
  });
}

function requirePid(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new HarnessFailure("harness_process_pid_invalid");
  }
  return pid;
}

function normalizedExecutable(executable) {
  if (typeof executable !== "string" || !path.isAbsolute(executable)) {
    throw new HarnessFailure("harness_process_executable_invalid");
  }
  const resolved = path.resolve(executable);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertSafeArguments(args) {
  if (!Array.isArray(args)) {
    throw new HarnessFailure("harness_process_arguments_invalid");
  }
  for (const argument of args) {
    if (
      typeof argument !== "string" ||
      argument.includes("\0") ||
      SENSITIVE_ARGUMENT.some((pattern) => pattern.test(argument))
    ) {
      throw new HarnessFailure("harness_process_sensitive_argument_refused");
    }
  }
  return true;
}

function assertProcessEnvironment(environment, allowedEnvironmentNames = []) {
  if (!environment || Object.getPrototypeOf(environment) !== Object.prototype) {
    throw new HarnessFailure("harness_process_environment_invalid");
  }
  const allowed = new Set(
    allowedEnvironmentNames.map((name) => String(name).toLowerCase())
  );
  for (const [name, value] of Object.entries(environment)) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === "node_path") {
      throw new HarnessFailure("harness_process_node_path_refused");
    }
    if (!SAFE_BASE_ENVIRONMENT.has(normalizedName) && !allowed.has(normalizedName)) {
      throw new HarnessFailure("harness_process_environment_key_refused");
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw new HarnessFailure("harness_process_environment_value_invalid");
    }
  }
  return true;
}

function sanitizeProcessText(value, maxBytes = 64 * 1024, secretRegistry = null) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) {
    throw new HarnessFailure("harness_process_output_limit_invalid");
  }
  const registry = normalizeSecretRegistry(secretRegistry);
  let text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
  text = registry.redact(text);
  for (const [pattern, replacement] of OUTPUT_REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  registry.assertAbsent(text);
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) return text;
  return `${encoded.subarray(0, maxBytes).toString("utf8")}[truncated]`;
}

function terminateProcessTree(
  pid,
  {
    execFileImpl = execFile,
    platform = process.platform,
    taskkillPath,
    timeoutMs = 10_000
  } = {}
) {
  requirePid(pid);
  if (platform !== "win32") {
    return Promise.resolve(false);
  }
  if (
    typeof taskkillPath !== "string" ||
    !path.isAbsolute(taskkillPath) ||
    path.basename(taskkillPath).toLowerCase() !== "taskkill.exe"
  ) {
    return Promise.resolve(false);
  }
  const taskkill = path.resolve(taskkillPath);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(false);
    }, timeoutMs);
    try {
      execFileImpl(
        taskkill,
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: timeoutMs },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(!error);
        }
      );
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
    }
  });
}

function createProcessRunner({
  allowedExecutables,
  spawnImpl = spawn,
  terminateTree = terminateProcessTree,
  resourceJournal = null,
  now = Date.now,
  maxOutputBytes = 64 * 1024,
  terminationTimeoutMs = 5_000,
  secretRegistry = null
} = {}) {
  if (!Array.isArray(allowedExecutables) || allowedExecutables.length < 1) {
    throw new HarnessFailure("harness_process_allowlist_missing");
  }
  const allowlist = new Set(allowedExecutables.map(normalizedExecutable));
  if (typeof spawnImpl !== "function" || typeof terminateTree !== "function") {
    throw new HarnessFailure("harness_process_runner_invalid");
  }
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 128 ||
    !Number.isSafeInteger(terminationTimeoutMs) ||
    terminationTimeoutMs < 1
  ) {
    throw new HarnessFailure("harness_process_runner_invalid");
  }
  const registry = normalizeSecretRegistry(secretRegistry);

  return Object.freeze({
    async run({
      executable,
      args = [],
      environment,
      allowedEnvironmentNames = [],
      cwd,
      timeoutMs,
      input = null,
      secretValues = [],
      signal = null,
      label = "subprocess"
    }) {
      const normalized = normalizedExecutable(executable);
      if (!allowlist.has(normalized)) {
        throw new HarnessFailure("harness_process_executable_refused");
      }
      assertSafeArguments(args);
      assertProcessEnvironment(environment, allowedEnvironmentNames);
      if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
        throw new HarnessFailure("harness_process_cwd_invalid");
      }
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new HarnessFailure("harness_process_timeout_invalid");
      }
      if (
        signal !== null &&
        (!signal ||
          typeof signal.aborted !== "boolean" ||
          typeof signal.addEventListener !== "function" ||
          typeof signal.removeEventListener !== "function")
      ) {
        throw new HarnessFailure("harness_process_abort_signal_invalid");
      }
      if (signal?.aborted === true) {
        throw new HarnessFailure(`${canonicalCode(label, "subprocess")}_aborted`);
      }
      if (input !== null && !Buffer.isBuffer(input)) {
        throw new HarnessFailure("harness_process_input_invalid");
      }
      const effectiveRegistry = combineSecretRegistries(
        registry,
        createSecretRegistry(secretValues)
      );
      const captureLimit =
        maxOutputBytes + Math.max(4_096, effectiveRegistry.maxVariantBytes);
      const codePrefix = canonicalCode(label, "subprocess");
      const startedAt = now();
      let child;
      try {
        child = spawnImpl(executable, args, {
          cwd,
          env: environment,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch {
        throw new HarnessFailure(`${codePrefix}_spawn_failed`);
      }
      let pid;
      try {
        pid = requirePid(child?.pid);
      } catch {
        let terminationConfirmed = false;
        if (child && typeof child.once === "function") {
          terminationConfirmed = await new Promise((resolveTermination) => {
            let settledTermination = false;
            const finishTermination = (confirmed) => {
              if (settledTermination) return;
              settledTermination = true;
              clearTimeout(terminationTimer);
              resolveTermination(confirmed);
            };
            const terminationTimer = setTimeout(
              () => finishTermination(false),
              terminationTimeoutMs
            );
            child.once("close", () => finishTermination(true));
            child.once("error", () => finishTermination(true));
            try {
              if (typeof child.kill !== "function" || child.kill() !== true) {
                finishTermination(false);
              }
            } catch {
              finishTermination(false);
            }
          });
        }
        throw new HarnessFailure(
          terminationConfirmed
            ? `${codePrefix}_pid_invalid`
            : `${codePrefix}_pid_invalid_termination_unconfirmed`,
          { terminationConfirmed }
        );
      }
      let originalProcessActive = true;
      const ownershipProof = Object.freeze({
        pid,
        executablePath: normalized,
        isOriginalProcessActive: () => originalProcessActive === true
      });
      try {
        resourceJournal?.registerProcess(pid, ownershipProof);
      } catch {
        let terminationTimer;
        const terminationConfirmed = await Promise.race([
          Promise.resolve()
            .then(() => terminateTree(pid))
            .then((value) => value === true)
            .catch(() => false),
          new Promise((resolveTermination) => {
            terminationTimer = setTimeout(
              () => resolveTermination(false),
              terminationTimeoutMs
            );
          })
        ]);
        clearTimeout(terminationTimer);
        if (terminationConfirmed) {
          originalProcessActive = false;
          try {
            resourceJournal?.unregisterProcess(pid);
          } catch {
            // The registration failure remains authoritative.
          }
        }
        throw new HarnessFailure(
          terminationConfirmed
            ? `${codePrefix}_journal_registration_failed`
            : `${codePrefix}_journal_registration_failed_termination_unconfirmed`,
          { terminationConfirmed }
        );
      }
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const append = (target, chunk, currentBytes) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = Math.max(0, captureLimit - currentBytes);
        if (remaining > 0) target.push(buffer.subarray(0, remaining));
        return currentBytes + buffer.length;
      };
      return await new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        let onAbort;
        const safeUnregister = () => {
          originalProcessActive = false;
          try {
            resourceJournal?.unregisterProcess(pid);
          } catch {
            // A closed/confirmed process must not change the primary result.
          }
        };
        const claim = () => {
          if (settled) return false;
          settled = true;
          clearTimeout(timer);
          if (onAbort) signal.removeEventListener("abort", onAbort);
          return true;
        };
        const confirmTermination = async () => {
          let terminationTimer;
          const attempt = Promise.resolve()
            .then(() => terminateTree(pid))
            .then((value) => value === true)
            .catch(() => false);
          const confirmed = await Promise.race([
            attempt,
            new Promise((resolveTermination) => {
              terminationTimer = setTimeout(
                () => resolveTermination(false),
                terminationTimeoutMs
              );
            })
          ]);
          clearTimeout(terminationTimer);
          return confirmed === true;
        };
        const rejectAfterTermination = async (primaryCode) => {
          if (!claim()) return;
          const confirmed = await confirmTermination();
          if (confirmed) safeUnregister();
          reject(
            new HarnessFailure(
              confirmed
                ? primaryCode
                : `${primaryCode}_termination_unconfirmed`,
              { terminationConfirmed: confirmed }
            )
          );
        };
        timer = setTimeout(() => {
          void rejectAfterTermination(`${codePrefix}_timeout`);
        }, timeoutMs);

        if (signal) {
          onAbort = () => {
            void rejectAfterTermination(`${codePrefix}_aborted`);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }

        child.once("error", () => {
          void rejectAfterTermination(`${codePrefix}_spawn_failed`);
        });
        child.once("close", (exitCode, signal) => {
          safeUnregister();
          if (!claim()) return;
          try {
            const result = Object.freeze({
              exitCode: Number.isInteger(exitCode) ? exitCode : null,
              signal: typeof signal === "string" ? signal : null,
              durationMs: Math.max(0, now() - startedAt),
              stdoutSanitized: sanitizeProcessText(
                Buffer.concat(stdout),
                maxOutputBytes,
                effectiveRegistry
              ),
              stderrSanitized: sanitizeProcessText(
                Buffer.concat(stderr),
                maxOutputBytes,
                effectiveRegistry
              ),
              stdoutTruncated: stdoutBytes > maxOutputBytes,
              stderrTruncated: stderrBytes > maxOutputBytes
            });
            if (exitCode === 0 && signal === null) resolve(result);
            else reject(new HarnessFailure(`${codePrefix}_failed`));
          } catch (error) {
            reject(
              error instanceof HarnessFailure
                ? error
                : new HarnessFailure("harness_process_output_sanitization_failed")
            );
          }
        });
        const streamFailure = (channel) => {
          void rejectAfterTermination(`${codePrefix}_${channel}_failed`);
        };
        if (
          !child.stdin ||
          !child.stdout ||
          !child.stderr ||
          typeof child.stdin.once !== "function" ||
          typeof child.stdout.once !== "function" ||
          typeof child.stderr.once !== "function"
        ) {
          void rejectAfterTermination(`${codePrefix}_streams_invalid`);
          return;
        }
        child.stdin.once("error", () => streamFailure("stdin"));
        child.stdout.once("error", () => streamFailure("stdout"));
        child.stderr.once("error", () => streamFailure("stderr"));
        child.stdout.on("data", (chunk) => {
          stdoutBytes = append(stdout, chunk, stdoutBytes);
        });
        child.stderr.on("data", (chunk) => {
          stderrBytes = append(stderr, chunk, stderrBytes);
        });
        try {
          if (input) child.stdin.end(input);
          else child.stdin.end();
        } catch {
          streamFailure("stdin");
        }
      });
    }
  });
}

module.exports = {
  assertProcessEnvironment,
  assertSafeArguments,
  combineSecretRegistries,
  createProcessRunner,
  createSecretRegistry,
  sanitizeProcessText,
  terminateProcessTree
};
