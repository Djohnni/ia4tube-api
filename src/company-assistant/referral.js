"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { atomicWriteJson } = require("../notifications/fcm-token-store");

const PAGE_SIZE = 5;
const bubble = (text, role = "assistant", id = randomUUID()) => ({ id, role, text, photoIds: [] });

function choices(record) {
  return record.partners.slice(record.offset, record.offset + PAGE_SIZE);
}

function hasNextPage(record) {
  return record.offset + PAGE_SIZE < record.partners.length;
}

function question(record) {
  const lines = choices(record).map(({ name, handle }, index) => `${record.offset + index + 1}. ${name} · ${handle}`);
  const instructions = hasNextPage(record) ? "Digite o número, Mais nomes ou Pular." : "Digite o número ou Pular.";
  return ["Quem indicou você para a iA4tube?", "", ...lines, "", instructions].join("\n");
}

function createReferralStore(root, partners) {
  // The order dispatcher scans the main assistant directory for owner folders.
  const directory = path.join(root, "referrals");
  const file = ownerHash => path.join(directory, ownerHash + ".json");
  function read(ownerHash) {
    try {
      return JSON.parse(fs.readFileSync(file(ownerHash), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  function write(ownerHash, record) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    atomicWriteJson(file(ownerHash), record);
  }

  function start(ownerHash) {
    if (partners.length === 0) return null;
    const record = { partners, offset: 0, outcome: "pending", messages: [], requests: {} };
    record.messages.push(bubble(question(record)));
    write(ownerHash, record);
    return record;
  }

  function reply(ownerHash, record, { message, requestId, fingerprint, at }) {
    if (record?.outcome !== "pending") return false;
    const command = message.toLowerCase();
    let response;
    if (command === "pular") {
      record.outcome = "skipped";
      response = "Tudo certo. Como posso ajudar?";
    } else if (command === "mais nomes" && hasNextPage(record)) {
      record.offset += PAGE_SIZE;
      response = question(record);
    } else {
      const number = /^[1-9][0-9]*\.?$/.test(command) ? Number(command.replace(/\.$/, "")) : 0;
      const partner = choices(record).find(({ handle, name }, index) =>
        number === record.offset + index + 1 || command === handle.toLowerCase() || command === name.toLowerCase());
      if (!partner) return false;
      record.outcome = "selected";
      record.attribution = { ...partner, at };
      response = `Indicação registrada para ${partner.name}. Como posso ajudar?`;
    }
    record.messages.push(bubble(message, "user", requestId), bubble(response));
    record.requests[requestId] = fingerprint;
    write(ownerHash, record);
    return true;
  }

  function report(ownerHash, record, messageId, at) {
    if (!record?.messages.some(message => message.id === messageId && message.role === "assistant")) return false;
    record.reports ||= {};
    if (!Object.hasOwn(record.reports, messageId)) {
      record.reports[messageId] = at;
      write(ownerHash, record);
    }
    return true;
  }

  return { read, start, reply, report };
}

module.exports = { createReferralStore };
