"use strict";

function assertPixIssuanceAllowed(account) {
  const value = String(account ?? "").trim();
  // Match only this phone identity, including its formatted Brazilian +55 alias.
  if (!/^[+\d\s().-]+$/.test(value)) return;
  const digits = value.replace(/\D/g, "");
  if (digits !== "47999999999" && digits !== "5547999999999") return;

  const error = new Error("Emissão de Pix bloqueada para esta conta.");
  error.code = "pix_account_blocked";
  error.statusCode = 403;
  throw error;
}

function sendBlockedPixError(error, req, res) {
  if (error?.code !== "pix_account_blocked") return false;
  // Only denied requests from the blocked account are logged; never log tokens or bodies.
  console.warn("[pix-account-blocked]", JSON.stringify({
    account: "47999999999",
    route: String(req.path || req.originalUrl || "").split("?")[0].slice(0, 160),
    ip: String(req.ip || "").slice(0, 80),
    user_agent: String(req.headers?.["user-agent"] || "").slice(0, 200)
  }));
  res.status(403).json({ ok: false, code: error.code, error: error.message });
  return true;
}

module.exports = { assertPixIssuanceAllowed, sendBlockedPixError };
