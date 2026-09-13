"use strict";
// Error messages, syscall arguments and paths must never cross the diagnostic
// boundary. Unknown platform codes deliberately remain one closed category.
const SPAWN_CODES = new Set(["EACCES", "EPERM", "ENOENT", "EBUSY", "EAGAIN", "ENOEXEC"]);
function closedSpawnErrorCode(error) {
  return typeof error?.code === "string" && SPAWN_CODES.has(error.code) ? error.code : "UNKNOWN";
}
module.exports = { closedSpawnErrorCode };
