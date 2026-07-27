"use strict";

const { validateGenerationId } = require("./art-ready-notification.service");

function successfulCompletionTransition({
  previousStatus,
  previousOrderStatus,
  existingGenerationId,
  createGenerationId
}) {
  const wasAlreadyReady = (
    String(previousStatus || "").trim() === "pronto" ||
    String(previousOrderStatus || "").trim() === "pronto"
  );
  if (wasAlreadyReady) {
    const candidate = String(existingGenerationId || "").trim();
    return {
      transitioned: false,
      generationId: candidate ? validateGenerationId(candidate) : ""
    };
  }
  if (typeof createGenerationId !== "function") {
    const error = new Error("Gerador de ID de geracao indisponivel.");
    error.code = "art_ready_generation_factory_invalid";
    throw error;
  }
  return {
    transitioned: true,
    generationId: validateGenerationId(createGenerationId())
  };
}

module.exports = {
  successfulCompletionTransition
};
