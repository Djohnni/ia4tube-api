// Historical IDs keep their original grants, including pending Pix and renewals.
const LEGACY_PLANS = {
  i4_essencial: {
    id: "i4_essencial",
    name: "i4 Essencial",
    price: 39.90,
    artsPerMonth: 8,
    whatsappDirect: false
  },
  i4_profissional: {
    id: "i4_profissional",
    name: "i4 Profissional",
    price: 79.90,
    artsPerMonth: 20,
    whatsappDirect: false
  },
  i4_empresarial: {
    id: "i4_empresarial",
    name: "i4 Empresarial",
    price: 149.90,
    artsPerMonth: 40,
    whatsappDirect: true
  }
};

const CURRENT_PLANS = {
  i4_imagens_10_v1: {
    id: "i4_imagens_10_v1", name: "Imagens", price: 69,
    quotaVersion: 1, imagesPerMonth: 10, videosPerMonth: 0, artsPerMonth: 10, whatsappDirect: false
  },
  i4_combo_10i_4v_v1: {
    id: "i4_combo_10i_4v_v1", name: "Essencial", price: 99,
    quotaVersion: 1, imagesPerMonth: 10, videosPerMonth: 4, artsPerMonth: 10, whatsappDirect: false
  },
  i4_combo_15i_6v_v1: {
    id: "i4_combo_15i_6v_v1", name: "Destaque", price: 139,
    quotaVersion: 1, imagesPerMonth: 15, videosPerMonth: 6, artsPerMonth: 15, whatsappDirect: false
  },
  i4_combo_20i_10v_v1: {
    id: "i4_combo_20i_10v_v1", name: "Profissional", price: 199,
    quotaVersion: 1, imagesPerMonth: 20, videosPerMonth: 10, artsPerMonth: 20, whatsappDirect: false
  },
  i4_combo_20i_15v_v1: {
    id: "i4_combo_20i_15v_v1", name: "Empresarial", price: 259,
    quotaVersion: 1, imagesPerMonth: 20, videosPerMonth: 15, artsPerMonth: 20, whatsappDirect: false
  }
};
const PLANS = { ...LEGACY_PLANS, ...CURRENT_PLANS };

const BALANCE_PACKAGES = {
  saldo_990: { id: "saldo_990", title: "Saldo IA4Tube - R$9,90", amount: 9.90, credit: 9.90 },
  saldo_2990: { id: "saldo_2990", title: "Saldo IA4Tube - R$29,90", amount: 29.90, credit: 29.90 },
  saldo_4990: { id: "saldo_4990", title: "Saldo IA4Tube - R$49,90", amount: 49.90, credit: 49.90 },
  saldo_9990: { id: "saldo_9990", title: "Saldo IA4Tube - R$99,90", amount: 99.90, credit: 99.90 }
};

const SINGLE_ART_PURCHASE = {
  id: "arte_avulsa_599",
  title: "Arte avulsa IA4Tube - R$5,99",
  amount: 5.99,
  quantity: 1
};

function normalizeId(value) {
  return String(value || "").trim().toLowerCase();
}

function getPlan(planId) {
  const key = normalizeId(planId);
  return Object.hasOwn(PLANS, key) ? PLANS[key] : null;
}

function getPurchasablePlan(planId) {
  const key = normalizeId(planId);
  return Object.hasOwn(CURRENT_PLANS, key) ? CURRENT_PLANS[key] : null;
}

function listPlans() {
  return Object.values(CURRENT_PLANS);
}

function getBalancePackage(packageId) {
  return BALANCE_PACKAGES[normalizeId(packageId)] || null;
}

function listBalancePackages() {
  return Object.values(BALANCE_PACKAGES);
}

function getSingleArtPurchase() {
  return { ...SINGLE_ART_PURCHASE };
}

module.exports = {
  PLANS,
  BALANCE_PACKAGES,
  SINGLE_ART_PURCHASE,
  getPlan,
  getPurchasablePlan,
  listPlans,
  getBalancePackage,
  listBalancePackages,
  getSingleArtPurchase
};
