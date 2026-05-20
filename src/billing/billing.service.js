function hasMascoteUniformeGift(categoria, cliente) {
  return categoria === "mascote_uniforme" && cliente.brinde_mascote_disponivel === true;
}

function getAvailableBalance(cliente) {
  return Number(cliente.saldo_mensal || 0) + Number(cliente.saldo_extra || 0);
}

function hasEnoughBalance(cliente, custoPedido) {
  return getAvailableBalance(cliente) >= custoPedido;
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

function applyOrderCharge(cliente, { custoPedido, mesAtual, temBrindeMascote }) {
  let restante = custoPedido;

  const saldoExtraAtual = Number(cliente.saldo_extra || 0);
  const descontoExtra = Math.min(saldoExtraAtual, restante);
  cliente.saldo_extra = Number((saldoExtraAtual - descontoExtra).toFixed(2));
  restante = Number((restante - descontoExtra).toFixed(2));

  if (restante > 0) {
    const saldoMensalAtual = Number(cliente.saldo_mensal || 0);
    cliente.saldo_mensal = Number(Math.max(0, saldoMensalAtual - restante).toFixed(2));
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
  hasMascoteUniformeGift,
  getAvailableBalance,
  hasEnoughBalance,
  ensureCurrentBillingCycle,
  formatInsufficientBalanceMessage,
  applyOrderCharge
};
