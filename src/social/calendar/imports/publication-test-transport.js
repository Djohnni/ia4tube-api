"use strict";
const transports = new WeakSet(), states = new WeakMap();
// Explicit test composition: the publisher receives this exact callable, never
// a missing transport that could fall back to fetch. No production config reads.
function createLocalPublicationTransport(handler) {
  if (typeof handler !== "function") throw new TypeError("local_publication_transport_invalid");
  const transport = async (url, request) => {
    const parsed = new URL(url);
    if (parsed.origin !== "https://graph.instagram.com" || !/^\/v25\.0\/[0-9]{5,64}(?:\/media|\/media_publish)?$/.test(parsed.pathname) ||
        !["GET", "POST"].includes(request?.method) || request?.redirect !== "error") throw new Error("local_publication_request_invalid");
    return handler(url, request);
  };
  transports.add(transport); return Object.freeze(transport);
}
function isLocalPublicationTransport(value) { return typeof value === "function" && transports.has(value); }
function withLocalPublicationState(state, transport, operation) {
  if (!isLocalPublicationTransport(transport)) throw new TypeError("local_publication_transport_invalid");
  states.set(state, transport);
  try { return operation(); } finally { states.delete(state); }
}
function isLocalPublicationState(state, transport) { return isLocalPublicationTransport(transport) && states.get(state) === transport; }
module.exports = { createLocalPublicationTransport, isLocalPublicationTransport, withLocalPublicationState, isLocalPublicationState };
