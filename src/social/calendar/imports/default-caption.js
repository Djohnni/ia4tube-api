"use strict";
const { isAuthenticatedSocialPrincipal } = require("../../auth-adapter");
const { SESSION_ISSUER, SESSION_AUDIENCE } = require("../../reauth");

function unavailable() {
  throw Object.assign(new Error("Não foi possível conferir a empresa desta mídia."),
    { code: "calendar_import_submission_caption_owner_unavailable", statusCode: 503 });
}
function field(value, max) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length <= max && !/[\u0000-\u001f\u007f]/.test(text) ? text : "";
}
/** Conservative institutional text, not visual recognition or a new AI request.
 * Only a genuine current product-session principal selects the stored owner.
 * Neither a caller-supplied company nor delegated worker identity is accepted.
 */
function createOwnerDefaultCaption(readClients) {
  return principal => {
    if (!isAuthenticatedSocialPrincipal(principal) || principal.tokenVersion !== 2 ||
        principal.issuer !== SESSION_ISSUER || principal.audience !== SESSION_AUDIENCE ||
        typeof principal.subject !== "string" || typeof readClients !== "function") unavailable();
    let clients;
    try { clients = readClients(); } catch { unavailable(); }
    const client = clients && Object.hasOwn(clients, principal.subject) ? clients[principal.subject] : null;
    if (!client || client.ativo !== true || client.cadastro_automatico === true && client.conta_finalizada !== true) unavailable();
    const niche = field(client.ramo, 100) || field(client.nicho, 100);
    if (niche.toLowerCase() === "nucleo_editorial_01")
      return "Conheça a iA4tube e veja como organizar o conteúdo da sua empresa.\n#ia4tube";
    const storedName = field(client.nome_empresa, 160) || field(client.nome_time, 160);
    const name = /^ia4tube$/i.test(storedName) ? "iA4tube" : storedName;
    return name ? `Conheça ${name} e acompanhe nosso conteúdo.` : "Conheça nosso trabalho e acompanhe nosso conteúdo.";
  };
}
module.exports = { createOwnerDefaultCaption };
