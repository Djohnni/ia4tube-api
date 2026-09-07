"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  APP_REVIEW_COMPANY_LABEL,
  APP_REVIEW_LOGIN,
  repairAppReviewCompanyLabel
} = require("../src/social/app-review-policy");

const MOJIBAKE_LABEL = "IA4Tube \u00e2\u20ac\u201d Meta App Review";

test("repairs only the exact app-review login and mojibake label", () => {
  assert.equal(
    repairAppReviewCompanyLabel(APP_REVIEW_LOGIN, MOJIBAKE_LABEL),
    APP_REVIEW_COMPANY_LABEL
  );
  assert.equal(
    repairAppReviewCompanyLabel(`${APP_REVIEW_LOGIN}-other`, MOJIBAKE_LABEL),
    MOJIBAKE_LABEL
  );
  assert.equal(
    repairAppReviewCompanyLabel(APP_REVIEW_LOGIN, "Unrelated company"),
    "Unrelated company"
  );
});

test("the repair is idempotent", () => {
  const repaired = repairAppReviewCompanyLabel(
    APP_REVIEW_LOGIN,
    MOJIBAKE_LABEL
  );
  assert.equal(repaired, APP_REVIEW_COMPANY_LABEL);
  assert.equal(
    repairAppReviewCompanyLabel(APP_REVIEW_LOGIN, repaired),
    APP_REVIEW_COMPANY_LABEL
  );
});
