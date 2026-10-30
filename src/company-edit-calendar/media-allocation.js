"use strict";

const { canonicalJson, fail } = require("./admission-contract");

function quotaMetadata(value) {
  if (value === undefined) return null;
  if (!value || value.policyVersion !== 1 || !["image", "video"].includes(value.mediaKind) ||
      !value.grantRef || value.grantRef.policyVersion !== 1 ||
      !["grantId", "planId", "cycleStart"].every(key => typeof value.grantRef[key] === "string" && value.grantRef[key]))
    fail("allocation_reconciliation_required", 503);
  return structuredClone(value);
}

function allocationUnits(value) {
  const amounts = [value.monthly, value.monthlyVideo ?? 0, value.standalone, value.free];
  if (!amounts.every(amount => Number.isSafeInteger(amount) && amount >= 0)) fail("allocation_reconciliation_required", 503);
  const metadata = quotaMetadata(value.mediaQuota);
  if ((!metadata && amounts[1]) || (metadata?.mediaKind === "image" && amounts[1]) ||
      (metadata?.mediaKind === "video" && (amounts[0] || amounts[3]))) fail("allocation_reconciliation_required", 503);
  return amounts.reduce((sum, amount) => sum + amount, 0);
}

function reservationAllocation(reservation, cycle = reservation?.ciclo) {
  const value = { cycle, monthly: Number(reservation?.artes_mensais_reservadas || 0),
    standalone: Number(reservation?.artes_avulsas_consumidas || 0), free: Number(reservation?.artes_gratis_consumidas || 0) };
  const metadata = quotaMetadata(reservation?.media_quota), video = Number(reservation?.videos_mensais_reservados || 0);
  if (metadata && ![reservation.artes_mensais_reservadas, reservation.videos_mensais_reservados,
    reservation.artes_avulsas_consumidas, reservation.artes_gratis_consumidas].every(amount => Number.isSafeInteger(amount) && amount >= 0))
    fail("allocation_reconciliation_required", 503);
  if (metadata) { value.monthlyVideo = video; value.mediaQuota = metadata; }
  else if (video) fail("allocation_reconciliation_required", 503);
  allocationUnits(value);
  return value;
}

function matchesAllocation(value, reservation, cycle = reservation?.ciclo) {
  const actual = reservationAllocation(reservation, cycle);
  return allocationUnits(value) === allocationUnits(actual) && value.cycle === actual.cycle &&
    value.monthly === actual.monthly && (value.monthlyVideo || 0) === (actual.monthlyVideo || 0) &&
    value.standalone === actual.standalone && value.free === actual.free &&
    canonicalJson(value.mediaQuota || null) === canonicalJson(actual.mediaQuota || null);
}

module.exports = { reservationAllocation, allocationUnits, matchesAllocation };
