"use strict";
// Real provider adapter, imported only by the explicitly confirmed external
// CLI. Unit tests inject a transport; importing this file starts no request.
const https = require("node:https");
const { MANIFEST } = require("./vm-proof-manifest");
function fail(code) { throw Object.assign(new Error("vm_proof_provider_" + code), { code: "vm_proof_provider_" + code }); }
function validId(id) { if (!Number.isSafeInteger(id) || id <= 0) fail("id_invalid"); return id; }
function createTransport(token) {
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(token || "")) fail("credential_invalid");
  return async ({ method, pathname, body, signal }) => {
    if (!["GET", "POST", "DELETE"].includes(method) || !/^\/v2\/(?:account\/keys\/\d+|droplets(?:\/\d+|\?(?:per_page=200&page=\d+|tag_name=ia4tube-proof-[a-f0-9-]+&per_page=200))?)$/.test(pathname)) fail("route_invalid");
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    if (data && data.length > 65536) fail("request_too_large");
    return new Promise((resolve, reject) => {
      const closed = () => reject(Object.assign(new Error("vm_proof_provider_request_failed"), { code: "vm_proof_provider_request_failed" }));
      const req = https.request({ protocol: "https:", hostname: "api.digitalocean.com", port: 443, path: pathname,
        method, rejectUnauthorized: true, minVersion: "TLSv1.2", signal, timeout: 20000,
        headers: { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json",
          ...(data ? { "Content-Length": data.length } : {}) } }, res => {
        let size = 0; const chunks = [];
        // Redirects, response bodies and provider messages are never followed,
        // reflected in exceptions, or printed. A body can contain user_data.
        if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); closed(); return; }
        res.on("data", chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) { res.destroy(); closed(); } else chunks.push(chunk); });
        res.on("error", closed); res.on("end", () => {
          try { resolve({ status: res.statusCode, json: size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null }); } catch { closed(); }
        });
      });
      req.on("error", closed); req.on("timeout", () => req.destroy()); if (data) req.write(data); req.end();
    });
  };
}
function createDigitalOceanProvider({ token, transport = createTransport(token) }) {
  async function get(resourceId, { signal } = {}) {
    const r = await transport({ method: "GET", pathname: "/v2/droplets/" + validId(resourceId), signal });
    if (r.status === 404) return null;
    if (r.status !== 200 || !r.json?.droplet) fail("get_failed"); return r.json.droplet;
  }
  return Object.freeze({
    async verifySshKey(key, { signal } = {}) {
      if (!key || !/^(?:[a-f0-9]{2}:){15}[a-f0-9]{2}$/.test(key.fingerprint || "")) fail("ssh_key_reference_invalid");
      const r = await transport({ method: "GET", pathname: "/v2/account/keys/" + validId(key.id), signal });
      if (r.status !== 200 || r.json?.ssh_key?.id !== key.id || r.json.ssh_key.fingerprint !== key.fingerprint ||
          !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(r.json.ssh_key.public_key || "")) fail("existing_ssh_key_not_verified");
      return { verified: true };
    },
    async inventory({ signal } = {}) {
      const rows = [];
      for (let page = 1; page <= 50; page++) {
        const r = await transport({ method: "GET", pathname: `/v2/droplets?per_page=200&page=${page}`, signal });
        if (r.status !== 200 || !Array.isArray(r.json?.droplets) || r.json.droplets.length > 200) fail("inventory_failed");
        rows.push(...r.json.droplets.map(d => ({ id: validId(d.id) })));
        if (!r.json.links?.pages?.next) return rows; // Never follow provider-supplied URL.
      }
      fail("inventory_limit");
    },
    async create({ name, tag, resource, identity, sshKey, signal }) {
      if (!/^ia4tube-proof-[a-f0-9-]{36}$/.test(name) || tag !== name || resource !== MANIFEST.resource ||
          !/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(identity?.adminPublicKey || "") ||
          typeof identity?.cloudConfig !== "string" || identity.cloudConfig.length > 16000 ||
          !Number.isSafeInteger(sshKey?.id) || sshKey.id <= 0) fail("create_contract_invalid");
      const r = await transport({ method: "POST", pathname: "/v2/droplets", signal, body: {
        name, region: resource.region, size: resource.size, image: resource.image,
        backups: false, ipv6: false, monitoring: false, tags: [tag],
        // Existing account key required: no omission that could create a root
        // password/email path, and no automatic key registration resource.
        ssh_keys: [sshKey.id],
        user_data: identity.cloudConfig
      } });
      if (r.status !== 202 || !r.json?.droplet) fail("create_response_unknown"); return r.json.droplet;
    },
    async findByTag(tag, { signal } = {}) {
      if (!/^ia4tube-proof-[a-f0-9-]{36}$/.test(tag)) fail("tag_invalid");
      const r = await transport({ method: "GET", pathname: "/v2/droplets?tag_name=" + tag + "&per_page=200", signal });
      if (r.status !== 200 || !Array.isArray(r.json?.droplets) || r.json.links?.pages?.next) fail("reconcile_failed");
      return r.json.droplets;
    }, get,
    async destroy(resourceId, { signal } = {}) {
      const r = await transport({ method: "DELETE", pathname: "/v2/droplets/" + validId(resourceId), signal });
      if (![204, 404].includes(r.status)) fail("delete_unconfirmed"); return { accepted: true };
    }
  });
}
module.exports = { createTransport, createDigitalOceanProvider };
