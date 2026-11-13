"use strict";

// Read-only projection of the authenticated registration, never of editable business contacts.
function companyAccountIdentity(owner, client) {
  if (typeof owner !== "string" || !owner || owner.length > 200 ||
      /[\u0000-\u0020\u007f]/.test(owner) || client?.ativo !== true) return null;
  const provider = client.login_tipo || (owner.startsWith("google_") ? "google" : "whatsapp");
  if (provider === "google") {
    const login = typeof client.email === "string" ? client.email.trim() : "";
    return owner.startsWith("google_") && login.length <= 254 && !/[\u0000-\u001f\u007f]/.test(login) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login)
      ? { provider: "google", login } : null;
  }
  if (provider !== "whatsapp" || /^(?:google|facebook|apple|microsoft)_/.test(owner)) return null;
  return { provider: "whatsapp", login: owner };
}

module.exports = { companyAccountIdentity };
