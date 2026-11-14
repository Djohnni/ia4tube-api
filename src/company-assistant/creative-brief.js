"use strict";
// Existing receiver notes carry the brief; no new public contract or publication path.
const HEADER = "Orientação visual do cliente — iA4tube:\n";
function creativeNotes(customerRequest, visualInstructions) {
  if (customerRequest === undefined && visualInstructions === undefined) return undefined;
  const original = String(customerRequest || "").trim(), direction = String(visualInstructions || "").trim();
  if (!original && !direction) return undefined;
  let body = direction || original;
  if (direction && original && direction !== original && (HEADER + body + "\nPedido original: " + original).length <= 1700)
    body += "\nPedido original: " + original;
  // New model output has a complete direction of <=1,000 chars. Keep the whole raw request in chat state.
  if ((HEADER + body).length > 1700) body = body.slice(0, 1699 - HEADER.length).replace(/[\uD800-\uDBFF]$/, "") + "…";
  return HEADER + body;
}
module.exports = { HEADER, creativeNotes };
