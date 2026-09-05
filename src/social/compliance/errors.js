"use strict";

class MetaComplianceError extends Error {
  constructor(code, statusCode = 400) {
    super("Meta compliance request rejected.");
    this.name = "MetaComplianceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function complianceFail(code, statusCode = 400) {
  throw new MetaComplianceError(code, statusCode);
}

module.exports = {
  MetaComplianceError,
  complianceFail
};
