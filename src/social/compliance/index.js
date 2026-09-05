"use strict";

const {
  createInMemoryMetaComplianceRepository
} = require("./meta-compliance-memory-repository");
const {
  META_COMPLIANCE_PATHS,
  createMetaComplianceRouter
} = require("./meta-compliance-router");
const {
  createMetaComplianceService
} = require("./meta-compliance-service");
const {
  createMetaSignedRequestVerifier
} = require("./meta-signed-request");
const {
  createPostgresMetaComplianceRepository
} = require("../../persistence/postgres/meta-compliance-repository");

module.exports = {
  META_COMPLIANCE_PATHS,
  createInMemoryMetaComplianceRepository,
  createMetaComplianceRouter,
  createMetaComplianceService,
  createPostgresMetaComplianceRepository,
  createMetaSignedRequestVerifier
};
