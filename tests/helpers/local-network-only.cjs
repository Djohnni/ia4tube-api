"use strict";

// Test-process preload only. It is not imported by the application.
// Descendant Node processes inherit NODE_OPTIONS from the test runner.
const net = require("node:net");
const dns = require("node:dns");
const allowed = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
function refuse() {
  const error = new Error("Non-loopback networking is forbidden in this test run.");
  error.code = "TEST_EXTERNAL_NETWORK_FORBIDDEN";
  throw error;
}
function assertLoopback(host) {
  if (host !== undefined && !allowed.has(String(host).toLowerCase())) refuse();
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (options && typeof options === "object") {
    if (options.path) refuse();
    assertLoopback(options.host || options.hostname);
  } else if (typeof options === "number") {
    assertLoopback(typeof args[1] === "string" ? args[1] : undefined);
  } else {
    refuse();
  }
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (hostname, ...args) {
  assertLoopback(hostname);
  return lookup.call(this, hostname, ...args);
};
