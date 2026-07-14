import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";

execFileSync("npm", ["run", "build"], { stdio: "ignore" });

const terminalControl = await import("../dist/terminalControl/index.js");

function collect(stream) {
  let value = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { value += chunk; });
  return () => value;
}

function request(requestId, type = "ping") {
  return {
    protocolVersion: terminalControl.TERMINAL_CONTROL_PROTOCOL_VERSION,
    requestId,
    type,
  };
}

test("terminal-control proxy preserves JSON-line correlation and serializes local UDS requests", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputText = collect(output);
  const calls = [];
  let active = false;
  const running = terminalControl.runTerminalControlProxy({
    input,
    output,
    request: async (value) => {
      assert.equal(active, false, "proxy requests must remain serial");
      active = true;
      calls.push(value);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active = false;
      if (calls.length === 1) {
        throw new terminalControl.TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "injected authority rejection",
        );
      }
      return { authority: "test-proxy" };
    },
  });

  const first = `${JSON.stringify(request("proxy-one"))}\r\n`;
  const second = `${JSON.stringify(request("proxy-two"))}\n`;
  input.write(first.slice(0, 17));
  input.end(`${first.slice(17)}${second}`);
  await running;

  assert.deepEqual(calls, [{ type: "ping" }, { type: "ping" }]);
  const responses = outputText().trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses.length, 2);
  assert.equal(responses[0].requestId, "proxy-one");
  assert.equal(responses[0].ok, false);
  assert.equal(responses[1].requestId, "proxy-two");
  assert.equal(responses[1].ok, true);
  assert.deepEqual(responses[1].result, { authority: "test-proxy" });
});

test("terminal-control proxy tears down on a local UDS transport failure", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputText = collect(output);
  const running = terminalControl.runTerminalControlProxy({
    input,
    output,
    request: async () => {
      throw new Error("injected UDS timeout");
    },
  });
  input.end(`${JSON.stringify(request("transport-failure"))}\n`);
  await assert.rejects(running, /injected UDS timeout/);
  assert.equal(outputText(), "");
});

test("terminal-control proxy rejects an oversized unterminated frame before dispatch", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputText = collect(output);
  let calls = 0;
  const running = terminalControl.runTerminalControlProxy({
    input,
    output,
    request: async () => {
      calls += 1;
      return {};
    },
  });
  input.end(Buffer.alloc(terminalControl.TERMINAL_CONTROL_MAX_FRAME_BYTES + 1, 0x61));
  await assert.rejects(running, /request exceeds the frame limit/);
  assert.equal(calls, 0);
  assert.equal(outputText(), "");
});

test("terminal-control proxy treats EOF with a partial line as a transport failure", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let calls = 0;
  const running = terminalControl.runTerminalControlProxy({
    input,
    output,
    request: async () => {
      calls += 1;
      return {};
    },
  });
  input.end(JSON.stringify(request("partial-eof")));
  await assert.rejects(running, /stdin closed with an incomplete frame/);
  assert.equal(calls, 0);
});

test("tw terminal-control proxy exposes the strict EOF framing at the CLI boundary", () => {
  const result = spawnSync(
    process.execPath,
    ["dist/cli.cjs", "terminal-control", "proxy"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: JSON.stringify(request("cli-partial-eof")),
    },
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /stdin closed with an incomplete frame/);
});

test("terminal-control proxy refuses an oversized response envelope", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const running = terminalControl.runTerminalControlProxy({
    input,
    output,
    request: async () => ({ data: "x".repeat(terminalControl.TERMINAL_CONTROL_MAX_FRAME_BYTES) }),
  });
  input.end(`${JSON.stringify(request("large-response"))}\n`);
  await assert.rejects(running, /response exceeds the frame limit/);
});
