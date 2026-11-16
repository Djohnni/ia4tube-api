"use strict";
// Only the customer's current, affirmative request may authorize grouping.
// Image/model text and prior confirmed campaigns never provide this permission.
function explicitPhotoIntent(message) {
  const source = String(message || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  let intent = null;
  for (const clause of source.split(/[.!?;,\n]+|\bmas\b|\bporem\b/)) {
    const separate = /\b(?:cada\s+(?:foto|imagem|produto)|(?:artes|imagens|publicacoes|posts)\s+(?:separad[ao]s|individuais)|uma\s+(?:arte|imagem|publicacao)\s+(?:por|para cada)\s+(?:foto|imagem|produto))\b/.exec(clause);
    if (separate && !/\b(?:nao|nunca|nem|sem)\b[^.!?;,]{0,45}$/.test(clause.slice(0, separate.index))) intent = "separate";
    const join = /\b(?:junt(?:ar|e|a|ando)|reun(?:ir|a|indo)|combin(?:ar|e|ando)|un(?:ir|a|indo)|mescl(?:ar|e|ando)|agrup(?:ar|e|ando))\b/.exec(clause);
    const one = /\b(?:(?:uma?|1)\s+(?:(?:unica?|so|mesma?)\s+)?|unica?\s+|mesma?\s+)(?:arte|imagem|publicacao|post|composicao|combo)\b/.exec(clause);
    const references = /\b(?:fotos?|imagens?|produtos?|tudo|todas|todos|essas|estas|esses|estes)\b/.test(clause);
    const joinObject = join ? clause.slice(join.index + join[0].length).trim() : "";
    const designOnly = /^(?:(?:as?|os?|essas?|esses?|estas?|estes?)\s+)?(?:cores|cor|paleta|precos|valores|fundo|cenario|estilo|luz|iluminacao)\b/.test(joinObject);
    if (join && references && !designOnly) {
      intent = /\b(?:nao|nunca|nem|sem)\b[^.!?;,]{0,45}$/.test(clause.slice(0, join.index)) ? "separate" : "combine";
    } else if (one && references && (/\b(?:com|usando|incluindo|junto|juntos|juntas|para todas|para todos|dessas|destas)\b/.test(clause.slice(one.index)) || /\b(?:na|em|numa)\s+$/.test(clause.slice(0, one.index)))) {
      if (!/\b(?:nao|nunca|nem|sem)\b[^.!?;,]{0,45}$/.test(clause.slice(0, one.index))) intent = "combine";
    } else {
      const together = /\b(?:fotos|imagens|produtos)\b.{0,45}\bjunt[ao]s\b/.exec(clause);
      if (together) intent = /\b(?:nao|nunca|nem|sem)\b[^.!?;,]{0,45}$/.test(clause.slice(0, together.index)) ? "separate" : "combine";
    }
  }
  return intent;
}
const sourceIds = item => item.photoIds || [item.photoId];
function compositionContext(message, selectedIds, preferredIds, draft) {
  const intent = explicitPhotoIntent(message);
  const previous = draft?.items?.length === 1 && sourceIds(draft.items[0]).length > 1 ? sourceIds(draft.items[0]) : [];
  const keep = !selectedIds.length && previous.length && intent !== "separate";
  const ids = keep ? previous : preferredIds;
  return { mode: ids.length >= 2 && (intent === "combine" || keep) ? "combine" : "separate", photoIds: ids };
}
module.exports = { explicitPhotoIntent, compositionContext, sourceIds };
