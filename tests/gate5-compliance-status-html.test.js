"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const express = require("express");

const {
  createMetaComplianceRouter
} = require("../src/social/compliance");

const confirmationCode = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function request(port, accept) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: "127.0.0.1",
      port,
      path: `/meta/data-deletion/status/${confirmationCode}`,
      headers: { Accept: accept }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

test("data-deletion status supports a public human page without exposing the reference", async (t) => {
  const service = {
    async handleDeauthorization() {
      throw new Error("not used");
    },
    async handleDataDeletion() {
      throw new Error("not used");
    },
    async getStatus({ confirmationCode: received }) {
      assert.equal(received, confirmationCode);
      return { status: "completed" };
    }
  };
  const app = express();
  app.use(createMetaComplianceRouter({ service }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  });
  const port = server.address().port;

  const html = await request(port, "text/html,application/xhtml+xml");
  assert.equal(html.status, 200);
  assert.match(html.headers["content-type"], /^text\/html/);
  assert.equal(html.headers["x-robots-tag"], "noindex, nofollow, noarchive");
  assert.match(html.headers["content-security-policy"], /default-src 'none'/);
  assert.match(html.body, /Pedido técnico processado/);
  assert.doesNotMatch(html.body, new RegExp(confirmationCode));
  assert.doesNotMatch(html.body, /signed_request|access[_-]?token|app[_-]?secret/i);

  const json = await request(port, "application/json");
  assert.equal(json.status, 200);
  assert.deepEqual(JSON.parse(json.body), { status: "completed" });
});
