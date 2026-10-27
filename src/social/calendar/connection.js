"use strict";

// The same connection eligibility and public shape for calendar publishing and
// fresh observations within a media read. No credential material is returned.
function calendarConnectionFromDetails(connection) {
  if (!connection || connection.state !== "connected" || connection.health !== "healthy" ||
      !connection.activeCredentialId || !["business", "creator"].includes(connection.account?.accountType) ||
      !["instagram_business_basic", "instagram_business_content_publish"].every(scope => (connection.grantedScopes || []).includes(scope))) return null;
  return { binding: { connectionId: connection.id, externalId: connection.account.externalId,
    connectionRevision: connection.revision }, username: connection.account.username, accountType: connection.account.accountType };
}

module.exports = { calendarConnectionFromDetails };
