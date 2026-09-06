"use strict";

const fs = require("node:fs/promises");
const net = require("node:net");
const { decodePacket, MAX_PACKET_BYTES } = require("./local-control");

function refuse() { throw new Error("pause_cli_refused"); }
function parsePidArgs(args) {
  if (!Array.isArray(args) || args.length !== 2 || args[0] !== "--pid" || !/^[1-9][0-9]{0,8}$/.test(args[1])) refuse();
  return Number(args[1]);
}
async function readPacket(stream) {
  if (stream.isTTY) refuse();
  const parts = []; let bytes = 0;
  try {
    for await (const part of stream) {
      bytes += part.length;
      if (bytes > MAX_PACKET_BYTES) refuse();
      parts.push(Buffer.from(part));
    }
    const packet = Buffer.concat(parts);
    try { return decodePacket(packet); } finally { packet.fill(0); }
  } finally { for (const part of parts) part.fill(0); }
}
async function verifySocket(pid) {
  if (process.platform !== "linux" || typeof process.getuid !== "function") refuse();
  const directory = `/tmp/ia4tube-data-dir-pause-${pid}`;
  const socketPath = `${directory}/control.sock`;
  const owner = process.getuid();
  const tmp = await fs.lstat("/tmp");
  if (!tmp.isDirectory() || tmp.isSymbolicLink() || tmp.uid !== 0 || await fs.realpath("/tmp") !== "/tmp" ||
    ((tmp.mode & 0o022) !== 0 && (tmp.mode & 0o1000) === 0)) refuse();
  const parent = await fs.lstat(directory), socket = await fs.lstat(socketPath);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== owner || (parent.mode & 0o777) !== 0o700 ||
      await fs.realpath(directory) !== directory || !socket.isSocket() || socket.isSymbolicLink() ||
      socket.uid !== owner || (socket.mode & 0o777) !== 0o600) refuse();
  return socketPath;
}
// One stdin JSON request, one sanitized JSON result. Never supply the bundle key
// in argv/environment, and never invoke this via a shell command containing it.
async function runCli({ args = process.argv.slice(2), input = process.stdin, output = process.stdout } = {}) {
  let packet;
  try {
    const pid = parsePidArgs(args);
    const socketPath = await verifySocket(pid);
    packet = await readPacket(input);
    const wire = Buffer.from(JSON.stringify(packet) + "\n");
    packet.bundleKeyBase64 = undefined;
    const result = await new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const chunks = []; let size = 0; let settled = false;
      // Capture deadline is server-supervised; timeout here abandons the socket,
      // which invalidates capture. It is never reported as capture completion.
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error("pause_cli_timeout")); }, 1210000);
      function finish(error, value) {
        if (settled) return; settled = true; clearTimeout(timeout); wire.fill(0);
        for (const chunk of chunks) chunk.fill(0);
        if (error) reject(new Error("pause_cli_refused")); else resolve(value);
      }
      socket.once("connect", () => socket.write(wire, () => wire.fill(0)));
      socket.on("error", () => finish(true));
      socket.on("data", chunk => {
        size += chunk.length;
        if (size > 32768) { finish(true); socket.destroy(); return; }
        chunks.push(Buffer.from(chunk));
      });
      socket.once("close", () => {
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          // The local server emits only its fixed public result vocabulary.
          if (!response || typeof response.ok !== "boolean" || !/^local_[a-z_]+$/.test(response.code) ||
            Object.keys(response).some(key => !["ok", "code", "status", "fence", "result", "externalWriterAttestation"].includes(key))) return finish(true);
          finish(false, response);
        } catch (_) { finish(true); }
      });
    });
    output.write(JSON.stringify(result) + "\n");
    return result.ok ? 0 : 2;
  } catch (_) { output.write('{"ok":false,"code":"pause_cli_refused"}\n'); return 2; }
  finally { if (packet) packet.bundleKeyBase64 = undefined; }
}

if (require.main === module) runCli().then(code => { process.exitCode = code; }, () => { process.exitCode = 2; });
module.exports = { parsePidArgs, readPacket, runCli };
