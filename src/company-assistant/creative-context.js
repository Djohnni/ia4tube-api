"use strict";

// Conversation history remains visible, but creative inputs belong to one
// preparation only. Company profile/logo are supplied separately by the service.
function emptyContext(id, boundaryMessageId = "") {
  return { schema: 1, id, boundaryMessageId, messageIds: [], photoIds: [], lastPhotoIds: [], photoDescriptions: {} };
}

function rememberPhotos(context, ids) {
  if (!ids?.length) return;
  context.photoIds = [...new Set([...context.photoIds, ...ids])];
  context.lastPhotoIds = [...ids];
}

function ensureCreativeContext(state) {
  if (state.creativeContext?.schema === 1) return state.creativeContext;
  // Upgrade on the next normal write. Never erase historical messages/orders,
  // and never reuse global photo descriptions from an earlier preparation.
  const latest = (state.campaigns || []).reduce((last, item) =>
    !last || item.createdAt >= last.createdAt ? item : last, null);
  const context = emptyContext(latest?.id || "initial", latest?.afterMessageId || "");
  let messages = state.messages;
  if (latest) {
    const boundary = messages.findIndex(m => m.id === latest.afterMessageId);
    if (boundary >= 0) messages = messages.slice(boundary + 1);
    else {
      // The receipt's anchor may have fallen outside the retained history.
      // An unambiguous newer user attempt is the only safe fallback.
      const first = messages.findIndex(m => m.role === "user" && state.attempts?.[m.id]?.at > latest.createdAt);
      messages = first < 0 ? [] : messages.slice(first);
    }
    if (!messages.length) delete state.assistanceTopic;
  }
  context.messageIds = messages.map(m => m.id);
  for (const message of messages) if (message.role === "user") rememberPhotos(context, message.photoIds);
  // An unconfirmed proposal is still the same preparation, including legacy
  // states whose earlier user messages have already been trimmed.
  for (const item of state.draft?.items || []) {
    if (!context.photoIds.includes(item.photoId)) context.photoIds.push(item.photoId);
  }
  state.creativeContext = context;
  return context;
}

function appendContextMessages(state, ...messages) {
  const context = ensureCreativeContext(state);
  state.messages.push(...messages);
  state.messages = state.messages.slice(-80);
  const retained = new Set(state.messages.map(m => m.id));
  context.messageIds = [...context.messageIds, ...messages.map(m => m.id)].filter(id => retained.has(id));
  for (const message of messages) if (message.role === "user") rememberPhotos(context, message.photoIds);
}

function contextMessages(state) {
  const ids = new Set(ensureCreativeContext(state).messageIds);
  return state.messages.filter(m => ids.has(m.id));
}

function closeCreativeContext(state, id) {
  state.creativeContext = emptyContext(id, state.messages.at(-1)?.id || "");
  delete state.assistanceTopic;
}

module.exports = { ensureCreativeContext, appendContextMessages, contextMessages, closeCreativeContext };
