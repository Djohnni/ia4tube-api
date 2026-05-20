const ORDER_STATUS = {
  NOVO: "novo",
  EM_PRODUCAO: "em_producao",
  PRONTO: "pronto",
  AJUSTE_PENDENTE: "ajuste_pendente",
  ERRO: "erro",
  EM_ANALISE: "em_analise"
};

const PUBLIC_STATUS_VALUES = [
  ORDER_STATUS.NOVO,
  ORDER_STATUS.EM_PRODUCAO,
  ORDER_STATUS.PRONTO,
  ORDER_STATUS.AJUSTE_PENDENTE,
  ORDER_STATUS.ERRO
];

function isValidPublicStatus(status) {
  return PUBLIC_STATUS_VALUES.includes(status);
}

module.exports = {
  ORDER_STATUS,
  PUBLIC_STATUS_VALUES,
  isValidPublicStatus
};
