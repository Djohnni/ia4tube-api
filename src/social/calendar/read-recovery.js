"use strict";

// Only the idempotent gallery GET is eligible. Never wrap edits, consent, worker
// dispatch, OAuth or provider writes in this recovery path.
const { isPostgresConnectionFailure: connectionFailure } = require("../../persistence/postgres/errors");
function report(logger, code) {
  // No driver messages, SQL, identifiers, URL, claims, request body or secrets.
  try { logger?.warn?.({ component: "social_calendar", code }); } catch { /* Logging cannot change the result. */ }
}
async function readCalendarWithRecovery(read, logger) {
  try { return await read(); }
  catch (error) {
    if (!connectionFailure(error)) throw error;
    report(logger, "calendar_read_connection_retry");
    await new Promise(resolve => setTimeout(resolve, 100));
    try { return await read(); }
    catch (retryError) { report(logger, "calendar_read_connection_failed"); throw retryError; }
  }
}
module.exports = { connectionFailure, readCalendarWithRecovery };
