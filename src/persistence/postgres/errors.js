"use strict";

class SocialPostgresError extends Error {
  constructor(code, message = "Operacao PostgreSQL social recusada.", cause) {
    super(message);
    this.name = "SocialPostgresError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function postgresFail(code, message, cause) {
  throw new SocialPostgresError(code, message, cause);
}

const CONNECTION_CODES = new Set(["25P03", "57P01", "57P02", "57P03", "08000", "08001", "08003", "08004", "08006", "08007", "08P01", "ECONNRESET", "ETIMEDOUT", "EPIPE"]);
const CLOSED_CLIENT_MESSAGES = new Set(["Connection terminated unexpectedly", "Connection terminated",
  "Client has encountered a connection error and is not queryable", "Client was closed and is not queryable"]);
function isPostgresConnectionFailure(error) {
  for (let depth = 0; error && depth < 4; depth++, error = error.cause) {
    if (CONNECTION_CODES.has(error.code) || CLOSED_CLIENT_MESSAGES.has(error.message)) return true;
  }
  return false;
}

module.exports = {
  SocialPostgresError,
  isPostgresConnectionFailure,
  postgresFail
};
