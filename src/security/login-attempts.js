"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const MINUTE = 60_000;
const WINDOW_MS = 15 * MINUTE;
const RETENTION_MS = 24 * 60 * MINUTE;
const DELAYS_MS = Object.freeze([MINUTE, 5 * MINUTE, 15 * MINUTE]);
const MAX_ENTRIES = 20_000;
const MAX_BYTES = 4 * 1024 * 1024;
const RECORD_FIELDS = ["count", "windowStart", "level", "blockedUntil", "expiresAt"];

function subnetList(ranges) {
  const list = new net.BlockList();
  for (const cidr of ranges) {
    const [ip, bits] = cidr.split("/");
    list.addSubnet(ip, Number(bits), net.isIP(ip) === 6 ? "ipv6" : "ipv4");
  }
  return list;
}
const privateProxies = subnetList([
  "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8",
  "169.254.0.0/16", "::1/128", "fc00::/7", "fe80::/10"
]);
// Cloudflare's published proxy ranges, verified on 2026-11-08. Only used
// behind the existing Render ingress; never trust caller-supplied leftmost IPs.
const cloudflareProxies = subnetList([
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22", "2400:cb00::/32",
  "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
  "2a06:98c0::/29", "2c0f:f248::/32"
]);

function canonicalIp(raw) {
  let value = String(raw || "").trim().toLowerCase();
  if (!net.isIP(value)) return null;
  if (value.startsWith("::ffff:") && net.isIPv4(value.slice(7))) value = value.slice(7);
  if (net.isIPv6(value)) {
    value = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    if (value.startsWith("::ffff:")) {
      const parts = value.slice(7).split(":");
      if (parts.length === 2) {
        const n = parseInt(parts[0], 16) * 65536 + parseInt(parts[1], 16);
        return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
      }
    }
  }
  return value;
}
function inList(list, ip) {
  return Boolean(ip && list.check(ip, net.isIP(ip) === 6 ? "ipv6" : "ipv4"));
}
function loginOrigin(req, env = process.env) {
  const peer = canonicalIp(req?.socket?.remoteAddress) || "unknown";
  // Direct/local deployments ignore all forwarded headers. On this Render
  // service the internal peer and Cloudflare hops are trusted, walking right
  // to left and stopping at the nearest untrusted address, not a fixed hop count.
  if (env.RENDER !== "true" || !env.RENDER_SERVICE_ID || !inList(privateProxies, peer)) {
    return { ip: peer, source: "socket" };
  }
  const raw = req?.headers?.["x-forwarded-for"];
  if (typeof raw !== "string" || raw.length > 8192) return { ip: peer, source: "proxy_fallback" };
  const chain = raw.split(",");
  if (!chain.length || chain.length > 32) return { ip: peer, source: "proxy_fallback" };
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const ip = canonicalIp(chain[i]);
    if (!ip) return { ip: peer, source: "proxy_fallback" };
    if (inList(privateProxies, ip) || inList(cloudflareProxies, ip)) continue;
    return { ip, source: "render_forwarded" };
  }
  return { ip: peer, source: "proxy_fallback" };
}

function storeError() {
  return Object.assign(new Error("Login protection storage unavailable."), { code: "login_protection_unavailable" });
}

function createLoginAttemptStore({ dataDir, secret, clock = Date.now, maxEntries = MAX_ENTRIES }) {
  if (typeof dataDir !== "string" || !dataDir || typeof secret !== "string" || secret.length < 32) {
    throw new TypeError("Invalid login protection configuration.");
  }
  const file = path.join(dataDir, "security", "login-attempts-v1.json");
  const key = (kind, value) => crypto.createHmac("sha256", secret)
    .update(`ia4tube:login-attempts:v1:${kind}:`).update(value).digest("hex");
  const keys = (owner, ip) => [key("account", owner), key("origin", ip)];

  function read(now) {
    let raw;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw storeError();
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return Object.create(null);
      throw storeError();
    }
    let state;
    try { state = JSON.parse(raw); } catch { throw storeError(); }
    if (state?.version !== 1 || !state.entries || typeof state.entries !== "object" || Array.isArray(state.entries)) throw storeError();
    const entries = Object.entries(state.entries);
    if (entries.length > maxEntries) throw storeError();
    const active = Object.create(null);
    for (const [id, entry] of entries) {
      if (!/^[a-f0-9]{64}$/.test(id) || !entry || Object.keys(entry).length !== RECORD_FIELDS.length ||
          !RECORD_FIELDS.every(field => Number.isSafeInteger(entry[field]) && entry[field] >= 0) ||
          entry.count > 30 || entry.level > DELAYS_MS.length) throw storeError();
      if (entry.expiresAt > now) active[id] = entry;
    }
    return active;
  }
  function write(entries) {
    if (Object.keys(entries).length > maxEntries) throw storeError();
    const serialized = JSON.stringify({ version: 1, entries });
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw storeError();
    const directory = path.dirname(file);
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fd = fs.openSync(tmp, "wx", 0o600);
      fs.writeFileSync(fd, serialized, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, file);
      // fsync the parent on Linux so the replacement survives power loss.
      if (process.platform !== "win32") {
        const directoryFd = fs.openSync(directory, "r");
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      }
    } catch { throw storeError(); }
    finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== "ENOENT") { /* no credentials in temporary files */ } }
    }
  }
  function status(entries, ids, now) {
    const until = Math.max(...ids.map(id => entries[id]?.blockedUntil || 0));
    return { blocked: until > now, retryAfterSeconds: Math.max(0, Math.ceil((until - now) / 1000)) };
  }
  // These read/modify/rename operations are synchronous and have no awaits:
  // atomic with respect to all requests in the existing single Node process.
  // The Render service uses one process and an exclusive persistent disk.
  // Horizontal/multi-process deployment must use a shared transactional store.
  function check(owner, ip) {
    const now = Number(clock());
    return status(read(now), keys(owner, ip), now);
  }
  function failure(owner, ip) {
    const now = Number(clock()), entries = read(now), ids = keys(owner, ip);
    const current = status(entries, ids, now);
    if (current.blocked) return { ...current, newlyBlocked: false };
    let newlyBlocked = false;
    ids.forEach((id, index) => {
      let entry = entries[id];
      if (!entry) entry = { count: 0, windowStart: now, level: 0, blockedUntil: 0, expiresAt: now + RETENTION_MS };
      if (now - entry.windowStart >= WINDOW_MS) { entry.count = 0; entry.windowStart = now; }
      entry.count += 1;
      entry.expiresAt = now + RETENTION_MS;
      if (entry.count >= (index === 0 ? 5 : 30)) {
        const delay = index === 0 ? DELAYS_MS[Math.min(entry.level, DELAYS_MS.length - 1)] : 15 * MINUTE;
        entry.level = Math.min(entry.level + 1, DELAYS_MS.length);
        entry.blockedUntil = now + delay;
        entry.count = 0;
        entry.windowStart = now;
        newlyBlocked = true;
      }
      entries[id] = entry;
    });
    write(entries);
    return { ...status(entries, ids, now), newlyBlocked };
  }
  function success(owner, ip) {
    const now = Number(clock()), entries = read(now), [accountId] = keys(owner, ip);
    // A valid password resets this account's mistakes, not an abusive origin
    // trying other accounts. No customer record, hash, token or session is edited.
    if (entries[accountId]) { delete entries[accountId]; write(entries); }
  }
  return Object.freeze({ check, failure, success });
}

function createLoginAttemptProtection({ dataDir, secret, env = process.env, clock = Date.now, logger = console, store }) {
  const attempts = store || createLoginAttemptStore({ dataDir, secret, clock });
  let lastStorageError = -Infinity;
  function unavailable(res) {
    if (Number(clock()) - lastStorageError >= MINUTE) {
      lastStorageError = Number(clock());
      logger.warn?.("[login-protection]", { code: "login_protection_unavailable" });
    }
    res.setHeader("Retry-After", "5");
    res.status(503).json({ ok: false, code: "login_protection_unavailable",
      error: "Não foi possível conferir o login agora. Aguarde alguns instantes e tente novamente." });
  }
  function limited(res, result) {
    const seconds = Math.max(1, result.retryAfterSeconds);
    const amount = seconds >= 60 ? Math.ceil(seconds / 60) : seconds;
    const unit = seconds >= 60 ? (amount === 1 ? "minuto" : "minutos") : (amount === 1 ? "segundo" : "segundos");
    res.setHeader("Retry-After", String(seconds));
    res.setHeader("Cache-Control", "no-store");
    return res.status(429).json({ ok: false, code: "login_rate_limited", retryAfterSeconds: seconds,
      error: `Muitas tentativas de login. Aguarde ${amount} ${unit} e tente novamente.` });
  }
  function begin(req, res, owner) {
    const origin = loginOrigin(req, env);
    try {
      const result = attempts.check(owner, origin.ip);
      if (result.blocked) { limited(res, result); return null; }
    } catch { unavailable(res); return null; }
    return Object.freeze({
      reject(statusCode, message) {
        try {
          const result = attempts.failure(owner, origin.ip);
          if (result.newlyBlocked) logger.warn?.("[login-protection]", {
            code: "login_rate_limited", originSource: origin.source, retryAfterSeconds: result.retryAfterSeconds
          });
          if (result.blocked) return limited(res, result);
          return res.status(statusCode).json({ ok: false, error: message });
        } catch { return unavailable(res); }
      },
      accept() {
        try { attempts.success(owner, origin.ip); return true; }
        catch { unavailable(res); return false; }
      }
    });
  }
  return Object.freeze({ begin });
}

module.exports = { canonicalIp, loginOrigin, createLoginAttemptStore, createLoginAttemptProtection };
