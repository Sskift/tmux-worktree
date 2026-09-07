import { existsSync } from "node:fs";
import net from "node:net";
import { request as httpsRequest } from "node:https";
import { TEST_LOOPBACK_CERT_PEM } from "./relayV2LoopbackTls.mjs";

/**
 * Shared async/Promise helpers for the Relay v2 test suite.
 */

// Deferred Promise handle. Callers that only need resolve can ignore reject.
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// Reserve an ephemeral TCP port on the loopback interface.
export function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

// Yield to the event loop for one setImmediate tick.
export function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Poll until a file exists, or throw after timeoutMs.
export async function waitForFile(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Poll a predicate until truthy. Deadline-based; throws Error on timeout.
// Per-call timeout/interval/message preserve each call site's original timing.
export async function waitFor(predicate, options = {}) {
  const {
    timeoutMs = 5_000,
    intervalMs = 5,
    message = "timed out waiting",
  } = options;
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// POST JSON to a loopback HTTPS broker. Defaults verify the shared loopback
// test certificate; shipping-style callers pass { rejectUnauthorized: false }.
// A null body omits the payload (for GET-style requests).
export function postJson(port, requestPath, body, options = {}) {
  const {
    method = "POST",
    ca = TEST_LOOPBACK_CERT_PEM,
    rejectUnauthorized = true,
    servername = "localhost",
  } = options;
  const payload = body === null ? null : Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host: "127.0.0.1",
      servername,
      port,
      path: requestPath,
      method,
      ca,
      rejectUnauthorized,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...(payload === null ? {} : { "Content-Length": String(payload.byteLength) }),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = text === "" ? null : JSON.parse(text);
        } catch {
          // keep raw text only
        }
        resolve({ status: response.statusCode, json, text });
      });
    });
    request.once("error", reject);
    if (payload !== null) request.write(payload);
    request.end();
  });
}
