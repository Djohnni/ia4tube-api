"use strict";

// Internal projection shared by ordinary connector reads and bounded media-read
// sessions. Only the observation clock varies; selection and scope stay exact.
const { connectorFail } = require("../../social/connectors/errors");

function connectionDetailsSelect(statementTime = false) {
  if (typeof statementTime !== "boolean") connectorFail("connector_contract_invalid");
  const observedAt = statementTime ? "statement_timestamp()" : "CURRENT_TIMESTAMP";
  return [
    "SELECT connection.company_id, connection.id, connection.provider,",
    "  connection.status, connection.revision, connection.created_at,",
    "  connection.connected_at, connection.updated_at,",
    "  connection.disconnected_at, connection.expires_at,",
    "  account.id AS external_account_id, account.external_id,",
    "  account.username, account.display_name, account.account_type,",
    "  account.status AS external_account_status,",
    "  credential.id AS active_credential_id,",
    "  credential.expires_at AS credential_expires_at,",
    "  ARRAY(",
    "    SELECT granted.scope",
    "    FROM ia4tube_social.social_connection_scopes granted",
    "    WHERE granted.company_id=connection.company_id",
    "      AND granted.connection_id=connection.id",
    "      AND (granted.expires_at IS NULL OR",
    `        granted.expires_at > ${observedAt})`,
    "    ORDER BY granted.scope",
    "  ) AS granted_scopes,",
    `  ${observedAt} AS observed_at`,
    "FROM ia4tube_social.social_connections connection",
    "LEFT JOIN LATERAL (",
    "  SELECT id,external_id,username,display_name,account_type,status",
    "  FROM ia4tube_social.social_external_accounts",
    "  WHERE company_id=connection.company_id",
    "    AND connection_id=connection.id AND provider=connection.provider",
    "  ORDER BY (status='active') DESC,updated_at DESC,id",
    "  LIMIT 1",
    ") account ON TRUE",
    "LEFT JOIN LATERAL (",
    "  SELECT id,expires_at",
    "  FROM ia4tube_social.social_encrypted_credentials",
    "  WHERE company_id=connection.company_id",
    "    AND connection_id=connection.id AND provider=connection.provider",
    "    AND credential_type IN ('instagram_user_access_token','access_token')",
    "    AND revoked_at IS NULL",
    "  ORDER BY (credential_type='instagram_user_access_token') DESC,",
    "    (expires_at IS NULL) DESC,expires_at DESC,updated_at DESC,id",
    "  LIMIT 1",
    ") credential ON TRUE"
  ].join("\n");
}

function currentConnectionDetailsSelect(statementTime = false) {
  return `${connectionDetailsSelect(statementTime)}\n` +
    "WHERE connection.company_id=$1 AND connection.provider=$2\n" +
    "ORDER BY (connection.status=ANY($3::text[])) DESC," +
    " connection.updated_at DESC,connection.id\nLIMIT 1";
}

module.exports = Object.freeze({ connectionDetailsSelect, currentConnectionDetailsSelect });
