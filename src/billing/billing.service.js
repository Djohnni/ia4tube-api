const plansRegistry = require("./plans");
const crypto = require("node:crypto");

const PLAN_GRACE_DAYS = 3;

function hasMascoteUniformeGift(categoria, cliente) {
  return categoria === "mascote_uniforme" && cliente.brinde_mascote_disponivel === true;
}

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function parseDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date;
}

function toIsoDate(date) {
  return date.toISOString();
}

function formatCycle(date) {
  const d = parseDate(date) || new Date();
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function addDays(date, days) {
  const d = parseDate(date) || new Date();
  const next = new Date(d.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonthsPreserveDay(date, months = 1) {
  const d = parseDate(date) || new Date();
  const target = new Date(Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth() + months,
    1,
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds()
  ));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return target;
}

function clearPendingPlanCycle(cliente) {
  delete cliente.plano_proximo_ciclo_pago;
  delete cliente.plano_proximo_ciclo_id;
  delete cliente.plano_proximo_ciclo_nome;
  delete cliente.plano_proximo_ciclo_inicio_em;
  delete cliente.plano_proximo_ciclo_renova_em;
  delete cliente.plano_proximo_ciclo_pagamento_id;
  delete cliente.plano_proximo_ciclo_pago_em;
  delete cliente.plano_proximo_ciclo_cotas_concessao_id;
}

function mediaQuotaError(code, statusCode = 503) {
  const error = new Error("As cotas deste combo precisam ser conferidas.");
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

const MONTHLY_MEDIA_FIELDS = {
  image: ["artes_mensais_total", "artes_mensais_usadas", "artes_mensais_restantes"],
  video: ["videos_mensais_total", "videos_mensais_usados", "videos_mensais_restantes"]
};

function isTypedMonthlyPlan(cliente) {
  if (cliente?.plano_cotas_versao === undefined) return false;
  if (cliente.plano_cotas_versao !== 1) throw mediaQuotaError("billing_media_quota_invalid");
  return true;
}

function assertTypedPlan(plan) {
  if (plan.quotaVersion !== 1 || ![plan.imagesPerMonth, plan.videosPerMonth].every(
    value => Number.isSafeInteger(value) && value >= 0) || plan.artsPerMonth !== plan.imagesPerMonth) {
    throw mediaQuotaError("billing_media_quota_invalid");
  }
}

function concessionId(plan, start, paymentId, savedId) {
  if (paymentId) return crypto.createHash("sha256").update(JSON.stringify(
    [1, String(plan.id), toIsoDate(start), String(paymentId)])).digest("hex");
  return savedId || crypto.randomUUID();
}

function typedGrantRef(cliente) {
  const grantId = cliente.plano_cotas_concessao_id;
  const planId = cliente.plano_atual || cliente.plano;
  const cycleStart = cliente.plano_ciclo_inicio_em;
  if (typeof grantId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(grantId) ||
      typeof planId !== "string" || !planId || typeof cycleStart !== "string" || !parseDate(cycleStart)) {
    throw mediaQuotaError("billing_media_quota_invalid");
  }
  return { policyVersion: 1, grantId, planId, cycleStart };
}

function sameGrantRef(left, right) {
  return left && typeof left === "object" && left.policyVersion === right.policyVersion &&
    left.grantId === right.grantId && left.planId === right.planId && left.cycleStart === right.cycleStart;
}

function readTypedMonthlyBucket(cliente, kind) {
  const names = MONTHLY_MEDIA_FIELDS[kind];
  if (!names) throw mediaQuotaError("billing_media_quota_invalid_kind", 400);
  const [total, used, remaining] = names.map(name => cliente[name]);
  if (![total, used, remaining].every(value => Number.isSafeInteger(value) && value >= 0) ||
      used + remaining > total) throw mediaQuotaError("billing_media_quota_invalid");
  return { total, used, remaining };
}

/** Pure projection. Legacy image/video entries refer to the SAME shared pool. */
function getMediaQuotaStatus(cliente, now = new Date()) {
  const copy = structuredClone(cliente || {});
  refreshManualPlanCycle(copy, now);
  const active = isPlanActive(copy, now);
  if (!isTypedMonthlyPlan(copy)) {
    const nonnegative = value => Math.max(0, Number(value) || 0);
    const bucket = { total: nonnegative(copy.artes_mensais_total), used: nonnegative(copy.artes_mensais_usadas),
      remaining: active ? nonnegative(copy.artes_mensais_restantes) : 0 };
    return { policyVersion: 0, active, monthly: { image: { ...bucket }, video: { ...bucket } }, grantRef: null };
  }
  const image = readTypedMonthlyBucket(copy, "image"), video = readTypedMonthlyBucket(copy, "video");
  return { policyVersion: 1, active, monthly: {
    image: { ...image, remaining: active ? image.remaining : 0 },
    video: { ...video, remaining: active ? video.remaining : 0 }
  }, grantRef: typedGrantRef(copy) };
}

/** Caller persists this synchronous mutation under its existing reservation receipt. */
function changeMonthlyMediaQuota(cliente, kind, quantity, expectedGrantRef, now, refund) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw mediaQuotaError("billing_media_quota_invalid_quantity", 400);
  if (!MONTHLY_MEDIA_FIELDS[kind]) throw mediaQuotaError("billing_media_quota_invalid_kind", 400);
  refreshManualPlanCycle(cliente, now);
  if (!isTypedMonthlyPlan(cliente)) throw mediaQuotaError("billing_media_quota_not_typed");
  const reference = typedGrantRef(cliente);
  if (!sameGrantRef(expectedGrantRef, reference)) throw mediaQuotaError("billing_media_quota_grant_changed");
  if (!isPlanActive(cliente, now)) throw mediaQuotaError("billing_media_quota_inactive", 409);
  const bucket = readTypedMonthlyBucket(cliente, kind);
  if (refund ? quantity > bucket.used : quantity > bucket.remaining) {
    throw mediaQuotaError(refund ? "billing_media_quota_invalid_refund" : "billing_required", refund ? 503 : 402);
  }
  const [, usedName, remainingName] = MONTHLY_MEDIA_FIELDS[kind];
  cliente[usedName] = bucket.used + (refund ? -quantity : quantity);
  cliente[remainingName] = bucket.remaining + (refund ? quantity : -quantity);
  return { policyVersion: 1, mediaKind: kind, quantity, grantRef: reference,
    monthly: readTypedMonthlyBucket(cliente, kind) };
}

function consumeMonthlyMediaQuota(cliente, kind, quantity, expectedGrantRef, now = new Date()) {
  return changeMonthlyMediaQuota(cliente, kind, quantity, expectedGrantRef, now, false);
}

function refundMonthlyMediaQuota(cliente, kind, quantity, expectedGrantRef, now = new Date()) {
  return changeMonthlyMediaQuota(cliente, kind, quantity, expectedGrantRef, now, true);
}

function activatePlanCycle(cliente, plan, { paymentId, paidAt, cycleStart, renewalDate, quotaGrantId }) {
  const start = parseDate(cycleStart) || parseDate(paidAt) || new Date();
  const renewal = parseDate(renewalDate) || addMonthsPreserveDay(start, 1);
  const paid = parseDate(paidAt) || new Date();

  cliente.plano = plan.id;
  cliente.plano_atual = plan.id;
  cliente.plano_status = "active";
  cliente.plano_nome = plan.name;
  cliente.plano_preco = roundMoney(plan.price);
  cliente.plano_artes_mes = Number(plan.artsPerMonth || 0);
  cliente.plano_ciclo = formatCycle(start);
  cliente.plano_ciclo_inicio_em = toIsoDate(start);
  cliente.plano_renova_em = toIsoDate(renewal);
  cliente.plano_whatsapp_direto = plan.whatsappDirect === true;
  cliente.artes_mensais_total = Number(plan.artsPerMonth || 0);
  cliente.artes_mensais_usadas = 0;
  cliente.artes_mensais_restantes = Number(plan.artsPerMonth || 0);
  if (plan.quotaVersion === 1) {
    assertTypedPlan(plan);
    cliente.plano_cotas_versao = 1;
    cliente.plano_cotas_concessao_id = concessionId(plan, start, paymentId, quotaGrantId);
    cliente.videos_mensais_total = plan.videosPerMonth;
    cliente.videos_mensais_usados = 0;
    cliente.videos_mensais_restantes = plan.videosPerMonth;
  } else {
    // An old purchase still activates its original shared-credit regime.
    for (const name of ["plano_cotas_versao", "plano_cotas_concessao_id", ...MONTHLY_MEDIA_FIELDS.video]) delete cliente[name];
  }
  cliente.ultimo_pagamento_plano_id = paymentId ? String(paymentId) : "";
  cliente.ultimo_pagamento_plano_em = toIsoDate(paid);
  cliente.ativo = true;

  clearPendingPlanCycle(cliente);
  return cliente;
}

function scheduleNextPlanCycle(cliente, plan, { paymentId, paidAt, currentRenewal }) {
  const start = parseDate(currentRenewal);
  const paid = parseDate(paidAt) || new Date();

  if (!start) return false;

  cliente.plano_proximo_ciclo_pago = true;
  cliente.plano_proximo_ciclo_id = plan.id;
  cliente.plano_proximo_ciclo_nome = plan.name;
  cliente.plano_proximo_ciclo_inicio_em = toIsoDate(start);
  cliente.plano_proximo_ciclo_renova_em = toIsoDate(addMonthsPreserveDay(start, 1));
  cliente.plano_proximo_ciclo_pagamento_id = paymentId ? String(paymentId) : "";
  cliente.plano_proximo_ciclo_pago_em = toIsoDate(paid);
  if (plan.quotaVersion === 1) {
    assertTypedPlan(plan);
    cliente.plano_proximo_ciclo_cotas_concessao_id = concessionId(plan, start, paymentId);
  } else delete cliente.plano_proximo_ciclo_cotas_concessao_id;
  return true;
}

function ensureStandaloneArtFields(cliente) {
  if (!cliente || typeof cliente !== "object") return cliente;

  cliente.artes_avulsas_restantes = Math.max(0, Number(cliente.artes_avulsas_restantes || 0));
  cliente.artes_avulsas_usadas = Math.max(0, Number(cliente.artes_avulsas_usadas || 0));
  cliente.artes_avulsas_total_compradas = Math.max(0, Number(cliente.artes_avulsas_total_compradas || 0));
  cliente.artes_avulsas_compras = Array.isArray(cliente.artes_avulsas_compras)
    ? cliente.artes_avulsas_compras
    : [];
  cliente.artes_avulsas_consumos = Array.isArray(cliente.artes_avulsas_consumos)
    ? cliente.artes_avulsas_consumos
    : [];

  return cliente;
}

function getStandaloneArtStatus(cliente) {
  ensureStandaloneArtFields(cliente);
  const product = plansRegistry.getSingleArtPurchase();

  return {
    artes_avulsas_restantes: Number(cliente?.artes_avulsas_restantes || 0),
    artes_avulsas_usadas: Number(cliente?.artes_avulsas_usadas || 0),
    artes_avulsas_total_compradas: Number(cliente?.artes_avulsas_total_compradas || 0),
    arte_avulsa_valor: roundMoney(product.amount),
    arte_avulsa_quantidade_compra: Number(product.quantity || 1),
    arte_avulsa_produto_id: product.id,
    arte_avulsa_titulo: product.title
  };
}

function hasAvailableStandaloneArt(cliente) {
  ensureStandaloneArtFields(cliente);
  return Number(cliente.artes_avulsas_restantes || 0) > 0;
}

function freeArtFeatureEnabled() {
  const value = String(process.env.IA4TUBE_FREE_ART_ENABLED || "true").trim().toLowerCase();
  return !["0", "false", "no", "nao", "não", "off"].includes(value);
}

function markFreeArtEligible(cliente, { eligible = process.env.IA4TUBE_FREE_ART_POLICY_INSTAGRAM_ONLY !== "true", now = new Date() } = {}) {
  if (!cliente || typeof cliente !== "object") return cliente;

  if (cliente.arte_gratis_usada !== true) {
    cliente.arte_gratis_usada = false;
  }
  cliente.arte_gratis_disponivel = eligible === true;
  cliente.arte_gratis_criada_em = cliente.arte_gratis_criada_em || toIsoDate(now);
  cliente.arte_gratis_usos = Array.isArray(cliente.arte_gratis_usos)
    ? cliente.arte_gratis_usos
    : [];

  return cliente;
}

function ensureFreeArtFields(cliente) {
  if (!cliente || typeof cliente !== "object") return cliente;

  if (cliente.arte_gratis_usada !== true) {
    cliente.arte_gratis_usada = false;
  }
  cliente.arte_gratis_usos = Array.isArray(cliente.arte_gratis_usos)
    ? cliente.arte_gratis_usos
    : [];

  return cliente;
}

function getFreeArtStatus(cliente, options = {}) {
  ensureFreeArtFields(cliente);
  const used = cliente?.arte_gratis_usada === true || process.env.IA4TUBE_FREE_ART_POLICY_INSTAGRAM_ONLY === "true" &&
    (Boolean(cliente?.arte_gratis_pedido_id) || Number(cliente?.arte_gratis_usos?.length || 0) > 0);
  const blocked = options?.freeArtBlocked === true;
  const available = freeArtFeatureEnabled() && !blocked && used !== true && cliente?.arte_gratis_disponivel === true;

  return {
    arte_gratis_ativa: freeArtFeatureEnabled(),
    arte_gratis_disponivel: available,
    arte_gratis_usada: used,
    arte_gratis_usada_em: cliente?.arte_gratis_usada_em || "",
    arte_gratis_pedido_id: cliente?.arte_gratis_pedido_id || ""
  };
}

function hasAvailableFreeCompanyArt(cliente, options = {}) {
  return getFreeArtStatus(cliente, options).arte_gratis_disponivel === true;
}

function refreshManualPlanCycle(cliente, now = new Date()) {
  let changed = false;
  const current = parseDate(now) || new Date();

  if (cliente.plano_proximo_ciclo_pago === true) {
    const pendingStart = parseDate(cliente.plano_proximo_ciclo_inicio_em);
    const pendingRenewal = parseDate(cliente.plano_proximo_ciclo_renova_em);
    const pendingPlan = plansRegistry.getPlan(cliente.plano_proximo_ciclo_id);

    if (pendingPlan && pendingStart && current >= pendingStart) {
      activatePlanCycle(cliente, pendingPlan, {
        paymentId: cliente.plano_proximo_ciclo_pagamento_id,
        paidAt: cliente.plano_proximo_ciclo_pago_em,
        cycleStart: pendingStart,
        renewalDate: pendingRenewal,
        quotaGrantId: cliente.plano_proximo_ciclo_cotas_concessao_id
      });
      changed = true;
    }
  }

  const renewal = parseDate(cliente.plano_renova_em);
  if (cliente.plano_status === "active" && renewal && current >= renewal) {
    cliente.plano_status = "past_due";
    cliente.artes_mensais_restantes = 0;
    if (cliente.plano_cotas_versao === 1) cliente.videos_mensais_restantes = 0;
    changed = true;
  }

  return { changed, cliente };
}

function getBillingStatus(cliente, now = new Date(), options = {}) {
  if (now && typeof now === "object" && !(now instanceof Date) && !Number.isFinite(Number(now))) {
    options = now;
    now = new Date();
  }
  refreshManualPlanCycle(cliente, now);
  const standaloneArt = getStandaloneArtStatus(cliente);
  const availableCombos = plansRegistry.listPlans();
  const freeArt = getFreeArtStatus(cliente, options);
  const mediaQuota = getMediaQuotaStatus(cliente, now);

  return {
    plano: cliente.plano || "",
    plano_atual: cliente.plano_atual || cliente.plano || "",
    plano_status: cliente.plano_status || "none",
    plano_nome: cliente.plano_nome || "",
    plano_preco: roundMoney(cliente.plano_preco || 0),
    plano_artes_mes: Number(cliente.plano_artes_mes || cliente.artes_mensais_total || 0),
    plano_ciclo: cliente.plano_ciclo || "",
    plano_ciclo_inicio_em: cliente.plano_ciclo_inicio_em || "",
    plano_renova_em: cliente.plano_renova_em || "",
    plano_whatsapp_direto: cliente.plano_whatsapp_direto === true,
    artes_mensais_total: Number(cliente.artes_mensais_total || 0),
    artes_mensais_usadas: Number(cliente.artes_mensais_usadas || 0),
    artes_mensais_restantes: Number(cliente.artes_mensais_restantes || 0),
    quotaVersion: mediaQuota.policyVersion,
    imageQuota: mediaQuota.monthly.image,
    videoQuota: mediaQuota.monthly.video,
    ...freeArt,
    ...standaloneArt,
    saldo_mensal: roundMoney(cliente.saldo_mensal || 0),
    saldo_extra: roundMoney(cliente.saldo_extra || 0),
    saldo: getAvailableBalance(cliente),
    plano_proximo_ciclo_pago: cliente.plano_proximo_ciclo_pago === true,
    plano_proximo_ciclo_inicio_em: cliente.plano_proximo_ciclo_inicio_em || "",
    plano_proximo_ciclo_renova_em: cliente.plano_proximo_ciclo_renova_em || "",
    combos: availableCombos,
    planos: availableCombos,
    pacotes_saldo: plansRegistry.listBalancePackages()
  };
}

function isPlanActive(cliente, now = new Date()) {
  refreshManualPlanCycle(cliente, now);
  const renewal = parseDate(cliente.plano_renova_em);
  return cliente.plano_status === "active" && (!renewal || (parseDate(now) || new Date()) < renewal);
}

function hasAvailablePlanArt(cliente, now = new Date()) {
  return isPlanActive(cliente, now) && Number(cliente.artes_mensais_restantes || 0) > 0;
}

function getAvailableBalance(cliente) {
  return roundMoney(Number(cliente.saldo_mensal || 0) + Number(cliente.saldo_extra || 0));
}

function hasEnoughBalance(cliente, custoPedido) {
  return getAvailableBalance(cliente) >= Number(custoPedido || 0);
}

function hasEnoughExtraBalance(cliente, custoPedido) {
  return Number(cliente.saldo_extra || 0) >= Number(custoPedido || 0);
}

function ensureCurrentBillingCycle(cliente, mesAtual) {
  if (cliente.ciclo_mes !== mesAtual) {
    cliente.ciclo_mes = mesAtual;
    cliente.usados_no_ciclo = 0;
  }

  return cliente;
}

function formatInsufficientBalanceMessage(custoPedido) {
  return `Saldo insuficiente. Este pedido custa R$ ${custoPedido.toFixed(2).replace(".", ",")}`;
}

function resolveCompanyArtCharge(cliente, { custoPedido, now = new Date(), freeArtBlocked = false }) {
  const refresh = refreshManualPlanCycle(cliente, now);
  const standaloneArt = plansRegistry.getSingleArtPurchase();

  if (hasAvailableFreeCompanyArt(cliente, { freeArtBlocked })) {
    return {
      allowed: true,
      source: "arte_gratis",
      amount: 0,
      billingChanged: true
    };
  }

  if (hasAvailablePlanArt(cliente, now)) {
    const mediaQuota = getMediaQuotaStatus(cliente, now);
    return {
      allowed: true,
      source: "plano",
      billingChanged: refresh.changed,
      planId: cliente.plano_atual || cliente.plano || "",
      planCycle: cliente.plano_ciclo || "",
      ...(mediaQuota.policyVersion === 1 ? {
        mediaKind: "image", quotaPolicyVersion: 1, grantRef: mediaQuota.grantRef
      } : {})
    };
  }

  if (hasAvailableStandaloneArt(cliente)) {
    return {
      allowed: true,
      source: "arte_avulsa",
      amount: roundMoney(standaloneArt.amount),
      billingChanged: refresh.changed
    };
  }

  if (hasEnoughExtraBalance(cliente, custoPedido)) {
    return {
      allowed: true,
      source: "saldo_extra",
      amount: roundMoney(custoPedido),
      billingChanged: refresh.changed
    };
  }

  return {
    allowed: false,
    code: "billing_required",
    billingChanged: refresh.changed,
    required_amount: roundMoney(standaloneArt.amount),
    saldo_extra: roundMoney(cliente.saldo_extra || 0),
    artes_mensais_restantes: Number(cliente.artes_mensais_restantes || 0),
    artes_avulsas_restantes: Number(cliente.artes_avulsas_restantes || 0),
    plano_status: cliente.plano_status || "none"
  };
}

function recordStandaloneArtPurchasePending(cliente, { purchaseId, paymentId, amount, quantity = 1, createdAt } = {}) {
  ensureStandaloneArtFields(cliente);

  const purchaseKey = String(purchaseId || "").trim();
  const paymentKey = String(paymentId || "").trim();
  let entry = cliente.artes_avulsas_compras.find(item =>
    (purchaseKey && String(item.purchase_id || "") === purchaseKey) ||
    (paymentKey && String(item.payment_id || "") === paymentKey)
  );

  if (!entry) {
    entry = {};
    cliente.artes_avulsas_compras.push(entry);
  }

  Object.assign(entry, {
    purchase_id: purchaseKey || entry.purchase_id || "",
    payment_id: paymentKey || entry.payment_id || "",
    status: entry.status === "approved" ? "approved" : "pending",
    quantidade: Number(quantity || entry.quantidade || 1),
    valor_pago: roundMoney(amount || entry.valor_pago || 0),
    criado_em: entry.criado_em || createdAt || new Date().toISOString()
  });

  return entry;
}

function creditStandaloneArtPurchase(cliente, { purchaseId, paymentId, amount, quantity = 1, paidAt } = {}) {
  ensureStandaloneArtFields(cliente);

  const purchaseKey = String(purchaseId || "").trim();
  const paymentKey = String(paymentId || "").trim();
  const paid = paidAt || new Date().toISOString();
  const existingApproved = cliente.artes_avulsas_compras.find(item =>
    item?.status === "approved" &&
    ((purchaseKey && String(item.purchase_id || "") === purchaseKey) ||
      (paymentKey && String(item.payment_id || "") === paymentKey))
  );

  if (existingApproved) {
    return { credited: false, duplicate: true, cliente, entry: existingApproved };
  }

  const entry = recordStandaloneArtPurchasePending(cliente, {
    purchaseId,
    paymentId,
    amount,
    quantity,
    createdAt: paid
  });
  const qty = Math.max(1, Number(quantity || entry.quantidade || 1));

  entry.status = "approved";
  entry.aprovado_em = paid;
  entry.valor_pago = roundMoney(amount || entry.valor_pago || 0);
  entry.quantidade = qty;

  cliente.artes_avulsas_total_compradas = Number(cliente.artes_avulsas_total_compradas || 0) + qty;
  cliente.artes_avulsas_restantes = Number(cliente.artes_avulsas_restantes || 0) + qty;
  cliente.ativo = true;

  return { credited: true, duplicate: false, cliente, entry };
}

function applyResolvedCompanyArtCharge(cliente, charge, { custoPedido, mesAtual, pedidoId }) {
  if (!charge || charge.allowed !== true) return cliente;

  if (charge.source === "plano") {
    if (isTypedMonthlyPlan(cliente)) {
      if (charge.mediaKind !== "image" || charge.quotaPolicyVersion !== 1) throw mediaQuotaError("billing_media_quota_invalid");
      consumeMonthlyMediaQuota(cliente, "image", 1, charge.grantRef);
    } else {
      cliente.artes_mensais_usadas = Number(cliente.artes_mensais_usadas || 0) + 1;
      cliente.artes_mensais_restantes = Math.max(0, Number(cliente.artes_mensais_restantes || 0) - 1);
    }
  } else if (charge.source === "arte_gratis") {
    ensureFreeArtFields(cliente);
    const now = new Date().toISOString();
    cliente.arte_gratis_usada = true;
    cliente.arte_gratis_disponivel = false;
    cliente.arte_gratis_usada_em = now;
    cliente.arte_gratis_pedido_id = pedidoId ? String(pedidoId) : "";
    cliente.arte_gratis_usos.push({
      pedido_id: pedidoId ? String(pedidoId) : "",
      consumido_em: now,
      produto: "arte_empresa"
    });
  } else if (charge.source === "arte_avulsa") {
    ensureStandaloneArtFields(cliente);
    cliente.artes_avulsas_restantes = Math.max(0, Number(cliente.artes_avulsas_restantes || 0) - 1);
    cliente.artes_avulsas_usadas = Number(cliente.artes_avulsas_usadas || 0) + 1;
    cliente.artes_avulsas_consumos.push({
      pedido_id: pedidoId ? String(pedidoId) : "",
      consumido_em: new Date().toISOString(),
      valor_unitario: roundMoney(charge.amount || plansRegistry.getSingleArtPurchase().amount),
      produto: "arte_empresa"
    });
  } else if (charge.source === "saldo_extra") {
    const saldoExtraAtual = Number(cliente.saldo_extra || 0);
    cliente.saldo_extra = roundMoney(Math.max(0, saldoExtraAtual - Number(custoPedido || 0)));
  }

  cliente.usados_no_ciclo = (cliente.usados_no_ciclo || 0) + 1;
  cliente.ciclo_mes = mesAtual;
  return cliente;
}

function typedPaymentContext(cliente, plan, paymentId) {
  if (plan.quotaVersion !== 1) return null;
  assertTypedPlan(plan);
  const paymentKey = paymentId == null ? "" : String(paymentId).trim();
  if (!paymentKey) return null;
  const receipts = cliente.plano_cotas_pagamentos;
  if (receipts !== undefined && (!receipts || typeof receipts !== "object" || Array.isArray(receipts)))
    throw mediaQuotaError("billing_media_quota_invalid");
  const key = crypto.createHash("sha256").update(paymentKey).digest("hex");
  const hasPrior = receipts && Object.hasOwn(receipts, key);
  const prior = hasPrior ? receipts[key] : null;
  if (hasPrior && (!prior || typeof prior !== "object" || prior.schemaVersion !== 1 || prior.planId !== plan.id ||
      !["scheduled_next_cycle", "renewed_from_previous_due_date", "activated_from_payment_date"].includes(prior.status) ||
      prior.grantRef?.policyVersion !== 1 || prior.grantRef.planId !== plan.id ||
      typeof prior.grantRef.grantId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(prior.grantRef.grantId) ||
      typeof prior.grantRef.cycleStart !== "string" || !parseDate(prior.grantRef.cycleStart)))
    throw mediaQuotaError("billing_media_quota_payment_conflict");
  return { key, prior, paymentKey };
}

function finishManualPlanPayment(cliente, plan, receipt, status, paid) {
  if (!receipt) return { status, cliente };
  const grantRef = status === "scheduled_next_cycle" ? {
    policyVersion: 1, grantId: cliente.plano_proximo_ciclo_cotas_concessao_id,
    planId: plan.id, cycleStart: cliente.plano_proximo_ciclo_inicio_em
  } : typedGrantRef(cliente);
  if (!cliente.plano_cotas_pagamentos) cliente.plano_cotas_pagamentos = {};
  cliente.plano_cotas_pagamentos[receipt.key] = {
    schemaVersion: 1, planId: plan.id, status, paidAt: toIsoDate(paid), grantRef
  };
  return { status, cliente, duplicate: false };
}

function applyManualPlanPayment(cliente, plan, { paymentId, paidAt } = {}) {
  // For new products the same client write owns both the grant and its receipt.
  // Check before any cycle refresh: a crash replay must not roll or reset stock.
  const receipt = typedPaymentContext(cliente, plan, paymentId);
  if (receipt?.prior) return { status: receipt.prior.status, cliente, duplicate: true };
  if (receipt) paymentId = receipt.paymentKey;
  const paid = parseDate(paidAt) || new Date();
  refreshManualPlanCycle(cliente, paid);

  const currentRenewal = parseDate(cliente.plano_renova_em);
  const samePlan = (cliente.plano_atual || cliente.plano || "") === plan.id;
  const active = cliente.plano_status === "active";

  if (samePlan && active && currentRenewal && paid < currentRenewal) {
    scheduleNextPlanCycle(cliente, plan, { paymentId, paidAt: paid, currentRenewal });
    return finishManualPlanPayment(cliente, plan, receipt, "scheduled_next_cycle", paid);
  }

  if (samePlan && currentRenewal && paid <= addDays(currentRenewal, PLAN_GRACE_DAYS)) {
    activatePlanCycle(cliente, plan, {
      paymentId,
      paidAt: paid,
      cycleStart: currentRenewal,
      renewalDate: addMonthsPreserveDay(currentRenewal, 1)
    });
    return finishManualPlanPayment(cliente, plan, receipt, "renewed_from_previous_due_date", paid);
  }

  activatePlanCycle(cliente, plan, {
    paymentId,
    paidAt: paid,
    cycleStart: paid,
    renewalDate: addMonthsPreserveDay(paid, 1)
  });
  return finishManualPlanPayment(cliente, plan, receipt, "activated_from_payment_date", paid);
}

function applyOrderCharge(cliente, { custoPedido, mesAtual, temBrindeMascote }) {
  let restante = custoPedido;

  const saldoExtraAtual = Number(cliente.saldo_extra || 0);
  const descontoExtra = Math.min(saldoExtraAtual, restante);
  cliente.saldo_extra = roundMoney(saldoExtraAtual - descontoExtra);
  restante = roundMoney(restante - descontoExtra);

  if (restante > 0) {
    const saldoMensalAtual = Number(cliente.saldo_mensal || 0);
    cliente.saldo_mensal = roundMoney(Math.max(0, saldoMensalAtual - restante));
  }

  cliente.usados_no_ciclo = (cliente.usados_no_ciclo || 0) + 1;
  cliente.ciclo_mes = mesAtual;

  if (temBrindeMascote) {
    cliente.brinde_mascote_disponivel = false;
    cliente.brinde_mascote_usado_em = new Date().toISOString();
  }

  return cliente;
}

module.exports = {
  PLAN_GRACE_DAYS,
  hasMascoteUniformeGift,
  roundMoney,
  parseDate,
  addDays,
  addMonthsPreserveDay,
  getBillingStatus,
  getMediaQuotaStatus,
  isTypedMonthlyPlan,
  consumeMonthlyMediaQuota,
  refundMonthlyMediaQuota,
  ensureStandaloneArtFields,
  getStandaloneArtStatus,
  hasAvailableStandaloneArt,
  markFreeArtEligible,
  ensureFreeArtFields,
  getFreeArtStatus,
  hasAvailableFreeCompanyArt,
  recordStandaloneArtPurchasePending,
  creditStandaloneArtPurchase,
  refreshManualPlanCycle,
  isPlanActive,
  hasAvailablePlanArt,
  getAvailableBalance,
  hasEnoughBalance,
  hasEnoughExtraBalance,
  ensureCurrentBillingCycle,
  formatInsufficientBalanceMessage,
  resolveCompanyArtCharge,
  applyResolvedCompanyArtCharge,
  applyManualPlanPayment,
  applyOrderCharge
};
