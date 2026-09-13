"use strict";

// Official SDK integration. No ambient credentials, endpoint overrides, retries,
// logging or network work at module import/construction. The caller injects SDKs.
function fail() { throw new Error("r2_transport_invalid"); }
function createR2SdkTransport({ sdk, getSignedUrl, credentials, accountId, bucket, clock = Date.now }) {
  if (!sdk || typeof sdk.S3Client !== "function" || typeof getSignedUrl !== "function" ||
      !/^[a-f0-9]{32}$/.test(accountId || "") || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket || "") ||
      !credentials || typeof credentials.accessKeyId !== "string" || typeof credentials.secretAccessKey !== "string") fail();
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const client = new sdk.S3Client({ region: "auto", endpoint, forcePathStyle: true, credentials,
    maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
  const command = (name, input) => {
    if (typeof sdk[name + "Command"] !== "function") fail();
    return new sdk[name + "Command"]({ Bucket: bucket, ...input });
  };
  async function send(name, input, signal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new Error("r2_metadata_timeout"));
    }, 10000); timer.unref?.(); });
    try { return await Promise.race([client.send(command(name, input), { abortSignal: controller.signal }), timeout]); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
  }
  function missing(error) { return error?.$metadata?.httpStatusCode === 404 || ["NotFound", "NoSuchKey", "NoSuchUpload"].includes(error?.name); }
  return Object.freeze({
    origin: endpoint,
    capabilities: Object.freeze({ sdk: "aws-sdk-v3", oneAttempt: true, privateEndpoint: true }),
    async head(key) {
      try { return await send("HeadObject", { Key: key }); } catch (error) { if (missing(error)) return null; throw error; }
    },
    async create(key, assetId) {
      return send("CreateMultipartUpload", { Key: key, ContentType: "application/octet-stream", CacheControl: "private, no-store",
        ChecksumAlgorithm: "SHA256", Metadata: { "import-asset-id": assetId } });
    },
    async findUploads(key) {
      const found = []; let marker = {};
      for (let page = 0; page < 10; page++) {
        const result = await send("ListMultipartUploads", { Prefix: key, MaxUploads: 100, ...marker });
        for (const row of result.Uploads || []) if (row.Key === key) found.push(row);
        if (!result.IsTruncated) return found;
        if (!result.NextKeyMarker || result.NextKeyMarker === marker.KeyMarker && result.NextUploadIdMarker === marker.UploadIdMarker) fail();
        marker = { KeyMarker: result.NextKeyMarker, UploadIdMarker: result.NextUploadIdMarker };
      }
      fail();
    },
    async listParts(key, uploadId) {
      const found = []; let marker;
      for (let page = 0; page < 2; page++) {
        const result = await send("ListParts", { Key: key, UploadId: uploadId, MaxParts: 100, ...(marker ? { PartNumberMarker: marker } : {}) });
        found.push(...(result.Parts || []));
        if (!result.IsTruncated) return found;
        if (!Number.isSafeInteger(result.NextPartNumberMarker) || result.NextPartNumberMarker <= (marker || 0)) fail();
        marker = result.NextPartNumberMarker;
      }
      fail();
    },
    async complete(key, uploadId, parts) {
      return send("CompleteMultipartUpload", { Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } });
    },
    async abort(key, uploadId) {
      try { await send("AbortMultipartUpload", { Key: key, UploadId: uploadId }); }
      catch (error) { if (!missing(error)) throw error; }
    },
    async get(key, etag, signal) { return send("GetObject", { Key: key, IfMatch: etag }, signal); },
    async signPart({ key, uploadId, partNumber, sizeBytes, sha256, md5Base64, expiresAt }) {
      const expiresIn = Math.floor((expiresAt - clock()) / 1000);
      if (expiresIn < 1 || expiresIn > 600) fail();
      const checksum = Buffer.from(sha256, "hex").toString("base64");
      const request = command("UploadPart", { Key: key, UploadId: uploadId, PartNumber: partNumber,
        ContentLength: sizeBytes, ContentMD5: md5Base64, ChecksumSHA256: checksum });
      const url = await getSignedUrl(client, request, { expiresIn, signingDate: new Date(clock()),
        signableHeaders: new Set(["content-length", "content-md5", "x-amz-checksum-sha256"]),
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]) });
      const parsed = new URL(url);
      const signed = new Set((parsed.searchParams.get("X-Amz-SignedHeaders") || "").split(";"));
      if (parsed.origin !== endpoint || parsed.username || parsed.password || parsed.pathname !== `/${bucket}/${key}` ||
          parsed.searchParams.get("uploadId") !== uploadId || parsed.searchParams.get("partNumber") !== String(partNumber) ||
          !["content-length", "content-md5", "x-amz-checksum-sha256"].every(header => signed.has(header))) fail();
      return { url, method: "PUT", headers: { "content-length": String(sizeBytes), "content-md5": md5Base64, "x-amz-checksum-sha256": checksum }, expiresAt, sizeBytes };
    },
    close() { client.destroy(); }
  });
}

module.exports = { createR2SdkTransport };
