"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { getPurchasablePlan } = require("../billing/plans");

const APPLIED_PAYMENTS = new Set([
  "activated_from_payment_date", "renewed_from_previous_due_date", "scheduled_next_cycle"
]);
const sha256 = value => createHash("sha256").update(value).digest("hex");

function label(value) {
  return typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim() : "";
}

function customerName(owner, client) {
  const name = label(client.nome_time);
  const lowerName = name.toLowerCase();
  const privateValues = [owner, client.google_id, client.senha_hash].filter(value => typeof value === "string" && value);
  const showsPrivateValue = privateValues.some(value => {
    const lowerValue = value.toLowerCase();
    return lowerName === lowerValue || (value.length >= 7 && lowerName.includes(lowerValue));
  });
  const showsPhone = /^\d{7,}$/.test(owner) && name.replace(/\D/g, "").includes(owner);
  if (!name || showsPrivateValue || showsPhone || /\S+@\S+/.test(name) || /^\+?[\d\s().-]{7,}$/.test(name)) return "Cliente";
  return name.slice(0, 100);
}

function loginLabel(owner, client) {
  if (client.login_tipo === "google" || owner.startsWith("google_")) return "Google";
  return /^\d{7,}$/.test(owner) ? `WhatsApp · final ${owner.slice(-4)}` : "WhatsApp";
}

async function referralFiles(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function selectedReferral(file) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const record = JSON.parse(raw);
  const attribution = record?.attribution;
  if (record?.outcome !== "selected" || !attribution) return null;
  const name = label(attribution.name).slice(0, 100);
  const handle = label(attribution.handle).toLowerCase();
  const at = attribution.at;
  if (!name || !/^@[a-z0-9._]{1,30}$/.test(handle) || !Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime())) return null;
  return { name, handle, at };
}

function approvedPurchase(paymentId, payment, selected) {
  if (payment.tipo !== "plano_pix" || payment.status !== "approved") return null;
  const plan = getPurchasablePlan(payment.plan_id);
  if (!plan || plan.quotaVersion !== 1) return null;
  const receipt = selected.client.plano_cotas_pagamentos?.[sha256(paymentId)];
  if (receipt?.schemaVersion !== 1 || receipt.planId !== plan.id || !APPLIED_PAYMENTS.has(receipt.status) ||
      typeof receipt.paidAt !== "string") return null;
  const paidAt = Date.parse(receipt.paidAt);
  if (!Number.isFinite(paidAt) || paidAt < selected.at) return null;
  return { planName: plan.name, paidAt: new Date(paidAt).toISOString() };
}

async function buildReferralReport({ dataDir, readClients, readPayments }) {
  const directory = path.join(dataDir, "company_assistant_v1", "referrals");
  const files = await referralFiles(directory);
  const totals = { referrals: 0, customersWithPurchase: 0 };
  if (files.length === 0) return { ok: true, totals, partners: [] };

  const ownersByFile = new Map(Object.entries(readClients()).map(([owner, client]) =>
    [sha256("assistant-v1\0" + owner) + ".json", { owner, client }]));
  const selectedByOwner = new Map();
  for (const file of files) {
    const account = ownersByFile.get(file.name);
    if (!file.isFile() || !account?.client) continue;
    const selected = await selectedReferral(path.join(directory, file.name));
    if (!selected) continue;
    selectedByOwner.set(account.owner, { ...account, ...selected, purchases: [] });
  }
  if (selectedByOwner.size === 0) return { ok: true, totals, partners: [] };

  for (const [paymentId, payment] of Object.entries(readPayments())) {
    const selected = selectedByOwner.get(payment?.whatsapp);
    if (!selected) continue;
    const purchase = approvedPurchase(paymentId, payment, selected);
    if (purchase) selected.purchases.push(purchase);
  }

  const grouped = new Map();
  const selections = [...selectedByOwner.values()].sort((a, b) => b.at - a.at);
  for (const { owner, client, name, handle, at, purchases } of selections) {
    if (!grouped.has(handle)) grouped.set(handle, { name, handle, referrals: [] });
    grouped.get(handle).referrals.push({ name: customerName(owner, client), loginLabel: loginLabel(owner, client),
      referredAt: new Date(at).toISOString(), purchases: purchases.sort((a, b) => b.paidAt.localeCompare(a.paidAt)) });
    totals.referrals++;
    if (purchases.length) totals.customersWithPurchase++;
  }
  const partners = [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR") || a.handle.localeCompare(b.handle));
  return { ok: true, totals, partners };
}

module.exports = { buildReferralReport };
