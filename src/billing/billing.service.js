const plansRegistry = require("./plans");

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
}

function activatePlanCycle(cliente, plan, { paymentId, paidAt, cycleStart, renewalDate }) {
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
        renewalDate: pendingRenewal
      });
      changed = true;
    }
  }

  const renewal = parseDate(cliente.plano_renova_em);
  if (cliente.plano_status === "active" && renewal && current >= renewal) {
    cliente.plano_status = "past_due";
    cliente.artes_mensais_restantes = 0;
    changed = true;
  }

  return { changed, cliente };
}

function getBillingStatus(cliente, now = new Date()) {
  refreshManualPlanCycle(cliente, now);
  const standaloneArt = getStandaloneArtStatus(cliente);

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
    ...standaloneArt,
    saldo_mensal: roundMoney(cliente.saldo_mensal || 0),
    saldo_extra: roundMoney(cliente.saldo_extra || 0),
    saldo: getAvailableBalance(cliente),
    plano_proximo_ciclo_pago: cliente.plano_proximo_ciclo_pago === true,
    plano_proximo_ciclo_inicio_em: cliente.plano_proximo_ciclo_inicio_em || "",
    plano_proximo_ciclo_renova_em: cliente.plano_proximo_ciclo_renova_em || "",
    planos: plansRegistry.listPlans(),
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

function resolveCompanyArtCharge(cliente, { custoPedido, now = new Date() }) {
  const refresh = refreshManualPlanCycle(cliente, now);
  const standaloneArt = plansRegistry.getSingleArtPurchase();

  if (hasAvailablePlanArt(cliente, now)) {
    return {
      allowed: true,
      source: "plano",
      billingChanged: refresh.changed,
      planId: cliente.plano_atual || cliente.plano || "",
      planCycle: cliente.plano_ciclo || ""
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
    cliente.artes_mensais_usadas = Number(cliente.artes_mensais_usadas || 0) + 1;
    cliente.artes_mensais_restantes = Math.max(0, Number(cliente.artes_mensais_restantes || 0) - 1);
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

function applyManualPlanPayment(cliente, plan, { paymentId, paidAt } = {}) {
  const paid = parseDate(paidAt) || new Date();
  refreshManualPlanCycle(cliente, paid);

  const currentRenewal = parseDate(cliente.plano_renova_em);
  const samePlan = (cliente.plano_atual || cliente.plano || "") === plan.id;
  const active = cliente.plano_status === "active";

  if (samePlan && active && currentRenewal && paid < currentRenewal) {
    scheduleNextPlanCycle(cliente, plan, { paymentId, paidAt: paid, currentRenewal });
    return { status: "scheduled_next_cycle", cliente };
  }

  if (samePlan && currentRenewal && paid <= addDays(currentRenewal, PLAN_GRACE_DAYS)) {
    activatePlanCycle(cliente, plan, {
      paymentId,
      paidAt: paid,
      cycleStart: currentRenewal,
      renewalDate: addMonthsPreserveDay(currentRenewal, 1)
    });
    return { status: "renewed_from_previous_due_date", cliente };
  }

  activatePlanCycle(cliente, plan, {
    paymentId,
    paidAt: paid,
    cycleStart: paid,
    renewalDate: addMonthsPreserveDay(paid, 1)
  });
  return { status: "activated_from_payment_date", cliente };
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
  ensureStandaloneArtFields,
  getStandaloneArtStatus,
  hasAvailableStandaloneArt,
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
