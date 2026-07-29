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

module.exports = {
  SocialPostgresError,
  postgresFail
};
