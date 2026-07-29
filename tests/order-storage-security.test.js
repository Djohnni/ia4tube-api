"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const orderStorage = require("../src/orders/order.storage");

function createOrder(root, owner, month, orderId) {
  const base = path.join(root, owner, month, orderId);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(
    path.join(base, "pedido.json"),
    JSON.stringify({ id: orderId, whatsapp: owner }),
    "utf8"
  );
  return base;
}

test("novos IDs mantêm o prefixo legado e incluem entropia criptográfica", () => {
  const first = orderStorage.newPedidoId();
  const second = orderStorage.newPedidoId();

  assert.match(first, /^\d{8}_\d{6}_[a-f0-9]{32}$/);
  assert.notEqual(first, second);
});

test("resolução por proprietário é contida e rejeita traversal", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-order-storage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const baseA = createOrder(root, "empresa-a", "2026-07", "pedido-a");
  createOrder(root, "empresa-b", "2026-07", "pedido-b");

  assert.equal(orderStorage.getPedidoBase(root, "empresa-a", "pedido-a"), baseA);
  assert.equal(orderStorage.getPedidoBase(root, "empresa-a", "pedido-b"), null);
  assert.equal(orderStorage.getPedidoBase(root, "../empresa-b", "pedido-b"), null);
  assert.equal(orderStorage.getPedidoBase(root, "empresa-a", "../pedido-b"), null);
  assert.equal(orderStorage.getPedidoBase(root, "empresa-a", "x/../../pedido-b"), null);
});

test("busca global privilegiada falha de forma segura quando o ID é ambíguo", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-order-global-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const orderId = "pedido-repetido";
  createOrder(root, "empresa-a", "2026-07", orderId);
  createOrder(root, "empresa-b", "2026-07", orderId);

  const matches = orderStorage.findPedidoBasesGlobal(root, orderId);
  assert.equal(matches.length, 2);
  assert.equal(orderStorage.getPedidoBaseGlobal(root, orderId), null);
});

test("pastas fora do contrato proprietário/mês/pedido são ignoradas", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia4tube-order-layout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  createOrder(root, "empresa-a", "2026-07", "pedido-valido");
  createOrder(root, "empresa-a", "mes-invalido", "pedido-invalido");

  const orders = orderStorage.listPedidoBasesByWhatsapp(root, "empresa-a");
  assert.deepEqual(orders.map((item) => item.id), ["pedido-valido"]);
});
