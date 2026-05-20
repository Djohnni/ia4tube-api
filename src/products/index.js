const PRODUCTS = require("./products");
const { FLYER_TIPO_TO_PRODUCT } = require("./legacy-map");

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function getProduct(productId) {
  const key = normalizeKey(productId);
  return PRODUCTS[key] || null;
}

function getProductByAlias(value) {
  const key = normalizeKey(value);
  if (!key) return null;

  if (PRODUCTS[key]) return PRODUCTS[key];

  return Object.values(PRODUCTS).find((product) =>
    (product.aliases || []).map(normalizeKey).includes(key)
  ) || null;
}

function getProductByFlyerTipo(flyerTipo) {
  const key = normalizeKey(flyerTipo);
  if (!key) return null;

  const productId = FLYER_TIPO_TO_PRODUCT[key];
  if (productId) return getProduct(productId);

  return Object.values(PRODUCTS).find((product) =>
    (product.flyerTipos || []).map(normalizeKey).includes(key)
  ) || null;
}

function resolveProductId(value) {
  const product = getProductByAlias(value) || getProductByFlyerTipo(value);
  return product ? product.id : "";
}

function resolveProductFromRequestBody(body = {}) {
  return getProductByAlias(body.product_id) ||
    getProductByFlyerTipo(body.flyer_tipo) ||
    getProductByAlias(body.categoria);
}

function getProductPrice(productId, cliente) {
  const product = getProductByAlias(productId);
  if (!product) return null;

  if (product.id === "mascote_uniforme" && cliente && cliente.brinde_mascote_disponivel === true) {
    return 0;
  }

  return Number(product.price || 0);
}

function getProductName(productId) {
  const product = getProductByAlias(productId);
  return product ? product.name : "";
}

function listProducts() {
  return Object.values(PRODUCTS);
}

module.exports = {
  PRODUCTS,
  getProduct,
  getProductByAlias,
  getProductByFlyerTipo,
  resolveProductId,
  resolveProductFromRequestBody,
  getProductPrice,
  getProductName,
  listProducts
};
