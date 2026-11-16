"use strict";
const { closeCreativeContext } = require("./creative-context");

// A successful, local chat reply: never a provider call, order cancellation or credit operation.
const PENDING_NOTICE = "Escolha dia, horário e formato e aperte Continuar. Para cancelar e começar outra, escreva Nova arte.";
function isNewArtCommand(value) {
  return /^nova\s+arte[.!]*$/i.test(String(value || "").trim().normalize("NFC"));
}
function clearUnsentPreparation(state, requestId, now) {
  const hadDraft = !!state.draft?.items?.length;
  if (hadDraft) state.closedDrafts = [...(state.closedDrafts || []), {
    at: now, reason: "nova-arte", draft: state.draft
  }].slice(-5);
  state.draft = null;
  // Existing messages/photos stay preserved; they cannot supply creative inputs to the next draft.
  // Company profile/logo, balances and confirmed campaigns are stored separately and untouched.
  closeCreativeContext(state, requestId);
  return hadDraft;
}
module.exports = { PENDING_NOTICE, isNewArtCommand, clearUnsentPreparation };
