import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { assertPortAvailable } from "./benchmark-startup.mjs";

test("startup benchmark rejects a port that already accepts connections", async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");

  try {
    await assert.rejects(
      assertPortAvailable({ url: `http://127.0.0.1:${address.port}` }),
      /already accepts TCP connections/,
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("startup benchmark accepts a port that refuses connections", async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  await assert.doesNotReject(assertPortAvailable({ url }));
});
