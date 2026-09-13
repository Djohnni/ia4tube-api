"use strict";

const crypto = require("node:crypto");
const { DEFAULT_LIMITS } = require("./upload-service");
function fail(code) { throw new Error(code); }

/** Worker-only executable, not an inline API inspector adapter.
 * The caller must reserve compute quota, persist/claim ticketId uniquely and run
 * this function in the approved isolated worker with CPU/RAM/disk limits. It has
 * no Instagram credentials. A transport bound to the approved R2 account/bucket
 * is injected. No user URL, shell command or alternate endpoint is accepted.
 * This module does not claim that the process executing it is actually isolated.
 */
function createR2BoundedInspectionWorker({ transport, decoder }) {
  if (!transport || typeof transport.get !== "function" || typeof transport.head !== "function" || typeof decoder?.inspect !== "function") fail("r2_worker_configuration_invalid");
  return Object.freeze({
    async execute(job) {
      if (!/^[a-f0-9]{64}$/.test(job?.objectKey || "") || !/^[a-f0-9]{64}$/.test(job.sha256 || "") ||
          !Number.isSafeInteger(job.sizeBytes) || job.sizeBytes < 1 || job.sizeBytes > DEFAULT_LIMITS.videoBytes ||
          !["image", "video"].includes(job.kind) || typeof job.etag !== "string" || job.etag.length > 200 ||
          job.deadlineMs !== 180000) fail("r2_worker_job_invalid");
      const abort = new AbortController(); let timer, consumed = false, bytes = 0, body;
      const hash = crypto.createHash("sha256");
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); body?.destroy?.(); reject(new Error("r2_inspection_timeout")); }, job.deadlineMs); timer.unref?.(); });
        const work = (async () => {
          const object = await transport.get(job.objectKey, job.etag, abort.signal); body = object.Body;
          if (object.ETag !== job.etag || object.ContentLength !== job.sizeBytes || !body?.[Symbol.asyncIterator]) fail("r2_object_conflict");
          async function* boundedBytes() {
            for await (const chunk of body) {
              if (abort.signal.aborted || !(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) fail("r2_inspection_invalid");
              bytes += chunk.byteLength;
              if (bytes > job.sizeBytes) fail("r2_media_too_large");
              hash.update(chunk); yield chunk;
            }
            consumed = true;
          }
          const decoded = await decoder.inspect({ stream: boundedBytes(), maxBytes: job.sizeBytes, timeoutMs: job.deadlineMs, signal: abort.signal });
          if (!consumed || bytes !== job.sizeBytes) fail("r2_inspection_incomplete");
          const sha256 = hash.digest("hex");
          if (sha256 !== job.sha256) fail("r2_checksum_mismatch");
          const current = await transport.head(job.objectKey);
          if (current?.ETag !== job.etag || current?.ContentLength !== bytes) fail("r2_object_conflict");
          return { complete: true, sizeBytes: bytes, sha256, decoded: decoded?.decoded === true,
            signatureVerified: decoded?.signatureVerified === true, detectedMime: decoded?.detectedMime,
            width: decoded?.width, height: decoded?.height,
            ...(job.kind === "image" ? { frames: decoded?.frames } : { durationMs: decoded?.durationMs, hasAudio: decoded?.hasAudio, colorMode: decoded?.colorMode }) };
        })();
        return await Promise.race([work, timeout]);
      } finally { clearTimeout(timer); abort.abort(); body?.destroy?.(); }
    }
  });
}
module.exports = { createR2BoundedInspectionWorker };
