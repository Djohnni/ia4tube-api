"use strict";

// A bounded allowance for a slow client. Authorization remains fresh per block.
const MEDIA_READ_TIMEOUT_MS = 5 * 60 * 1000;
const MEDIA_UPLOAD_TIMEOUT_MS = MEDIA_READ_TIMEOUT_MS;
module.exports = Object.freeze({ MEDIA_READ_TIMEOUT_MS, MEDIA_UPLOAD_TIMEOUT_MS });
