"use strict";

const TITLE = "Sua arte está pronta!";
const BODY = "Toque para visualizar sua criação na IA4Tube.";
const GENERATION_ID_PATTERN =
  /^art_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PEDIDO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

class ArtReadyContractError extends Error {
  constructor(code) {
    super("Contrato de notificacao de arte pronta recusado.");
    this.name = "ArtReadyContractError";
    this.code = code;
  }
}

function fail(code) {
  throw new ArtReadyContractError(code);
}

function validateGenerationId(value) {
  const normalized = String(value || "").trim();
  if (!GENERATION_ID_PATTERN.test(normalized)) {
    fail("art_ready_generation_id_invalid");
  }
  return normalized;
}

function validatePedidoId(value) {
  const normalized = String(value || "").trim();
  if (!PEDIDO_ID_PATTERN.test(normalized)) {
    fail("art_ready_pedido_id_invalid");
  }
  return normalized;
}

function artReadyData({ eventId, pedidoId }) {
  return Object.freeze({
    schema_version: "1",
    tipo: "arte_pronta",
    event_id: validateGenerationId(eventId),
    pedido_id: validatePedidoId(pedidoId),
    title: TITLE,
    body: BODY
  });
}

module.exports = {
  ArtReadyContractError,
  BODY,
  TITLE,
  artReadyData,
  validateGenerationId,
  validatePedidoId
};
