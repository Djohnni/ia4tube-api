"use strict";

const { Readable } = require("node:stream");
const { runCli } = require("./pause-cli");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REFUSED = '{"ok":false,"code":"capture_prompt_refused"}\n';

function refuse() { throw new Error("capture_prompt_refused"); }
function parseCaptureArgs(args) {
  const names = ["--pid", "--capture-id", "--epoch", "--ttl-ms"];
  if (!Array.isArray(args) || args.length !== 8 || args.some(value => typeof value !== "string")) refuse();
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!names.includes(args[i]) || Object.hasOwn(values, args[i])) refuse();
    values[args[i]] = args[i + 1];
  }
  if (!/^[1-9][0-9]{0,8}$/.test(values["--pid"]) || !UUID.test(values["--capture-id"]) ||
      !UUID.test(values["--epoch"]) || !/^[1-9][0-9]{0,5}$/.test(values["--ttl-ms"]) ||
      Number(values["--ttl-ms"]) > 900000) refuse();
  return { pid: values["--pid"], captureId: values["--capture-id"], epoch: values["--epoch"], ttlMs: Number(values["--ttl-ms"]) };
}

// Buffers are erased on every path. V8 strings used by base64/JSON and copies in
// the existing CLI cannot be guaranteed erased: this is not a secure-memory API.
async function readHiddenKey(input, promptOutput, signals) {
  const bytes = Buffer.alloc(44);
  const previousRaw = input.isRaw === true;
  let size = 0, answer = null, onData, onEnd, onError, onInterrupt, onClose;
  try {
    input.setRawMode(true);
    answer = await new Promise((resolve, reject) => {
      let settled = false;
      function finish(failed) {
        if (settled) return;
        settled = true;
        input.pause();
        if (failed || size !== 44) return reject(new Error("capture_prompt_refused"));
        const text = bytes.toString("ascii");
        const decoded = Buffer.from(text, "base64");
        try {
          if (!/^[A-Za-z0-9+/]{43}=$/.test(text) || decoded.length !== 32 || decoded.toString("base64") !== text) return reject(new Error("capture_prompt_refused"));
          resolve(Buffer.from(bytes));
        } finally { decoded.fill(0); }
      }
      onData = part => {
        if (!Buffer.isBuffer(part)) return finish(true);
        try {
          if (settled) return;
          for (let i = 0; i < part.length; i++) {
            const byte = part[i];
            if (byte === 10 || byte === 13) {
              // Only a final LF, CR, or CRLF; never a second input/command.
              if (i !== part.length - 1 && !(byte === 13 && i === part.length - 2 && part[i + 1] === 10)) return finish(true);
              return finish(false);
            }
            if (size >= 44 || byte < 43 || byte > 122 || !((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57) || byte === 43 || byte === 47 || byte === 61)) return finish(true);
            bytes[size++] = byte;
          }
        } catch (_) { finish(true); }
        finally { part.fill(0); }
      };
      onEnd = () => finish(false);
      onError = onInterrupt = onClose = () => finish(true);
      input.on("data", onData); input.once("end", onEnd); input.once("error", onError); input.once("close", onClose);
      signals.once("SIGINT", onInterrupt); signals.once("SIGTERM", onInterrupt);
      promptOutput.write("Capture key (base64, input hidden; Enter confirms, Ctrl-C cancels): ");
      input.resume();
    });
    return answer;
  } finally {
    bytes.fill(0);
    input.pause();
    for (const [event, listener] of [["data", onData], ["end", onEnd], ["error", onError], ["close", onClose]]) if (listener) input.removeListener(event, listener);
    if (onInterrupt) { signals.removeListener("SIGINT", onInterrupt); signals.removeListener("SIGTERM", onInterrupt); }
    try { input.setRawMode(previousRaw); }
    catch (_) { if (answer) answer.fill(0); refuse(); }
  }
}

async function runCapturePrompt(options = {}) {
  const { args = process.argv.slice(2), input = process.stdin, output = process.stdout, promptOutput = process.stderr } = options;
  let key = null, wire = null, packet = null, packetInput = null;
  try {
    const metadata = parseCaptureArgs(args);
    const fixture = options.testOnly === true;
    if (fixture ? typeof options.runCli !== "function" : (process.platform !== "linux" || input !== process.stdin || options.runCli !== undefined || options.signals !== undefined)) refuse();
    if (input.isTTY !== true || typeof input.setRawMode !== "function" || input.readableEncoding || input.destroyed || input.readableEnded) refuse();
    key = await readHiddenKey(input, promptOutput, fixture ? options.signals || process : process);
    packet = { command: "capture", captureId: metadata.captureId, epoch: metadata.epoch, ttlMs: metadata.ttlMs, bundleKeyBase64: key.toString("ascii") };
    wire = Buffer.from(JSON.stringify(packet) + "\n");
    packet.bundleKeyBase64 = undefined;
    key.fill(0);
    packetInput = Readable.from([wire], { objectMode: false });
    // Erase the original transport buffer as soon as the existing CLI consumes
    // its input; do not retain it for the potentially long capture completion.
    packetInput.once("end", () => wire.fill(0));
    packetInput.once("close", () => wire.fill(0));
    const code = await (fixture ? options.runCli : runCli)({ args: ["--pid", metadata.pid], input: packetInput, output });
    return code === 0 ? 0 : 2;
  } catch (_) {
    try { output.write(REFUSED); } catch (_) { /* Do not expose input or raw errors. */ }
    return 2;
  } finally {
    if (key) key.fill(0);
    if (wire) wire.fill(0);
    if (packet) packet.bundleKeyBase64 = undefined;
    if (packetInput) packetInput.destroy();
  }
}

if (require.main === module) runCapturePrompt().then(code => { process.exitCode = code; }, () => { process.exitCode = 2; });
module.exports = { parseCaptureArgs, runCapturePrompt };
