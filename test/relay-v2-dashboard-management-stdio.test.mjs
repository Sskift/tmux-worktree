import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const contractRoot = new URL(
  "../contracts/dashboard-relay-v2-management/v1/",
  import.meta.url,
);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", contractRoot), "utf8"));
const cases = JSON.parse(readFileSync(new URL("cases.json", contractRoot), "utf8"));
const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const cli = fileURLToPath(new URL("../dist/cli.cjs", import.meta.url));
const hiddenEntry = "__relay-v2-dashboard-management-stdio";
const decoder = new TextDecoder("utf-8", { fatal: true });

function readyValue() {
  const fixture = cases.startupHandshakeCases.find(
    (item) => item.name === "same-version-absolute-bundled-resource-ready",
  );
  assert.ok(fixture, "startup ready fixture is required");
  return {
    ...JSON.parse(fixture.input.firstStdoutFrame),
    runtimeVersion: packageVersion,
  };
}

function responseValue(operation, requestId) {
  const fixture = cases.goldenExchanges.find((item) => item.operation === operation);
  assert.ok(fixture, `missing golden exchange for ${operation}`);
  return { ...structuredClone(fixture.normalizedResponse), requestId };
}

function runChild(input, { args = [], env = {} } = {}) {
  return spawnSync(process.execPath, [cli, hiddenEntry, ...args], {
    encoding: null,
    env: { ...process.env, ...env },
    input,
    timeout: 5_000,
  });
}

function decodeFrames(stdoutBytes) {
  if (stdoutBytes.byteLength === 0) return [];
  const text = decoder.decode(stdoutBytes);
  assert.equal(text.includes("\r"), false, "stdout frames are LF-only");
  assert.equal(text.endsWith("\n"), true, "stdout must end at a complete LF frame");
  const lines = text.slice(0, -1).split("\n");
  assert.ok(lines.every((line) => line.length > 0), "stdout cannot contain an empty frame");
  return lines.map((line) => JSON.parse(line));
}

function assertQuietExit(result, status, expectedFrames) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, status, result.stderr.toString("utf8"));
  assert.deepEqual(result.stderr, Buffer.alloc(0));
  assert.deepEqual(decodeFrames(result.stdout), expectedFrames);
}

function materializeFixtureInput(input) {
  switch (input.kind) {
    case "utf8":
    case "partial-then-eof":
      return Buffer.from(input.value, "utf8");
    case "base64":
      return Buffer.from(input.value, "base64");
    case "repeat-ascii": {
      const payload = Buffer.alloc(input.count, input.ascii, "ascii");
      const terminator = input.terminator === "LF" ? Buffer.from("\n") : Buffer.alloc(0);
      return Buffer.concat([payload, terminator]);
    }
    default:
      assert.fail(`unknown fixture input kind: ${input.kind}`);
  }
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => resolve({ status, signal }));
  });
}

async function runChildChunks(chunks) {
  const child = spawn(process.execPath, [cli, hiddenEntry], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const exited = childExit(child);
  for (const chunk of chunks) {
    await new Promise((resolve, reject) => {
      child.stdin.write(chunk, (error) => error ? reject(error) : resolve());
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
  child.stdin.end();
  const [exit, stdoutBytes, stderrBytes] = await Promise.all([exited, stdout, stderr]);
  return { ...exit, stdout: stdoutBytes, stderr: stderrBytes, error: undefined };
}

function paddedStatusFrame(payloadBytes) {
  const status = cases.goldenExchanges.find((item) => item.operation === "status");
  assert.ok(status, "status fixture is required");
  const compact = status.requestFrame.slice(0, -1);
  const paddingBytes = payloadBytes - Buffer.byteLength(compact, "utf8");
  assert.ok(paddingBytes >= 0);
  const comma = compact.indexOf(",");
  return `${compact.slice(0, comma + 1)}${" ".repeat(paddingBytes)}${compact.slice(comma + 1)}\n`;
}

test("hidden child emits one closed ready frame from the package constant and stays absent from help", () => {
  const child = runChild(Buffer.alloc(0));
  assertQuietExit(child, 0, [readyValue()]);
  const ready = decodeFrames(child.stdout)[0];
  assert.deepEqual(
    Object.keys(ready).sort(),
    [...manifest.startupHandshake.schema.exactKeys].sort(),
  );
  assert.equal(ready.contract, manifest.contract);
  assert.equal(ready.protocolVersion, manifest.protocolVersion);
  assert.equal(ready.runtimeVersion, packageVersion);

  const help = spawnSync(process.execPath, [cli, "help"], { encoding: "utf8", timeout: 5_000 });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, "");
  assert.equal(help.stdout.includes(hiddenEntry), false);
});

test("golden operations compare normalized semantics without freezing JSON key order", async (t) => {
  for (const exchange of cases.goldenExchanges) {
    await t.test(exchange.name, () => {
      const child = runChild(Buffer.from(exchange.requestFrame, "utf8"));
      assertQuietExit(child, 0, [readyValue(), exchange.normalizedResponse]);
    });
  }
  assert.deepEqual(
    cases.goldenExchanges.filter((item) => item.operation !== "status").map(
      (item) => item.operation,
    ),
    manifest.requestSchema.mutationOperations,
  );
});

test("one child accepts reordered keys and serially emits one correlated response per request", () => {
  const reordered = cases.validSequenceCases.find(
    (item) => item.name === "json-object-key-order-does-not-change-meaning",
  );
  const sequence = cases.validSequenceCases.find(
    (item) => item.name === "handshake-then-two-requests-are-serialized-on-one-child",
  );
  assert.ok(reordered && sequence);
  const requests = sequence.steps.filter((step) => step.event === "send-request");
  const input = [
    reordered.requestFrame,
    ...requests.map((step) => `${JSON.stringify({
      protocolVersion: manifest.protocolVersion,
      requestId: step.requestId,
      operation: step.operation,
    })}\n`),
  ].join("");
  const expected = [
    readyValue(),
    responseValue("status", reordered.expected.normalizedRequest.requestId),
    ...requests.map((step) => responseValue(step.operation, step.requestId)),
  ];
  assertQuietExit(runChild(Buffer.from(input, "utf8")), 0, expected);
});

test("fixture bad request frames alone exit 64 silently and never 78", async (t) => {
  for (const invalid of cases.invalidRequestFrameCases) {
    await t.test(invalid.name, () => {
      const child = runChild(materializeFixtureInput(invalid.input));
      assertQuietExit(child, cases.constants.badRequestExitCode, [readyValue()]);
      assert.notEqual(child.status, cases.constants.supersededExitCode);
    });
  }
});

test("closed request schema rejects each missing field and a nested duplicate", async (t) => {
  const valid = cases.goldenExchanges.find((item) => item.operation === "status");
  assert.ok(valid);
  for (const key of manifest.requestSchema.exactKeys) {
    await t.test(`missing ${key}`, () => {
      const request = structuredClone(valid.normalizedRequest);
      delete request[key];
      assertQuietExit(
        runChild(Buffer.from(`${JSON.stringify(request)}\n`, "utf8")),
        cases.constants.badRequestExitCode,
        [readyValue()],
      );
    });
  }
  const nestedDuplicate = `{"protocolVersion":1,"requestId":"${valid.normalizedRequest.requestId}","operation":{"x":1,"x":2}}\n`;
  assertQuietExit(
    runChild(Buffer.from(nestedDuplicate, "utf8")),
    cases.constants.badRequestExitCode,
    [readyValue()],
  );
});

test("real child framing covers fragmented writes, exact limits, LF variants, and partial EOF", async (t) => {
  const status = cases.goldenExchanges.find((item) => item.operation === "status");
  assert.ok(status);
  const frame = Buffer.from(status.requestFrame, "utf8");

  await t.test("fragmented valid frame and normal EOF", async () => {
    const split = Math.floor(frame.byteLength / 2);
    const child = await runChildChunks([frame.subarray(0, split), frame.subarray(split)]);
    assertQuietExit(child, 0, [readyValue(), status.normalizedResponse]);
  });

  await t.test("fragmented multibyte UTF-8 is decoded only after the complete frame", async () => {
    const utf8 = Buffer.from(`{"protocolVersion":1,"requestId":"${status.normalizedRequest.requestId}","operation":"status","extra":"请"}\n`);
    const marker = utf8.indexOf(Buffer.from("请"));
    const child = await runChildChunks([
      utf8.subarray(0, marker + 1),
      utf8.subarray(marker + 1, marker + 2),
      utf8.subarray(marker + 2),
    ]);
    assertQuietExit(child, 64, [readyValue()]);
  });

  await t.test("16384-byte payload is accepted", async () => {
    const child = await runChildChunks([Buffer.from(paddedStatusFrame(16_384))]);
    assertQuietExit(child, 0, [readyValue(), status.normalizedResponse]);
  });

  await t.test("16385-byte payload is rejected", async () => {
    const child = await runChildChunks([Buffer.from(paddedStatusFrame(16_385))]);
    assertQuietExit(child, 64, [readyValue()]);
  });

  for (const [name, input, expected] of [
    ["double LF", Buffer.concat([frame, Buffer.from("\n")]), [readyValue(), status.normalizedResponse]],
    ["CRLF", Buffer.from(status.requestFrame.replace(/\n$/, "\r\n")), [readyValue()]],
    ["incomplete EOF", frame.subarray(0, frame.byteLength - 1), [readyValue()]],
  ]) {
    await t.test(name, async () => {
      const child = await runChildChunks([input]);
      assertQuietExit(child, 64, expected);
    });
  }

  await t.test("valid response is retained before a later bad frame", async () => {
    const bad = Buffer.from(`{"protocolVersion":1,"requestId":"${status.normalizedRequest.requestId}","operation":"bad"}\n`);
    const child = await runChildChunks([frame, bad]);
    assertQuietExit(child, 64, [readyValue(), status.normalizedResponse]);
  });
});

test("requestId fixture cases enforce wire canonicality without pretending to observe manager origin", async (t) => {
  const wireAcceptedClassifications = new Set(["valid-non-sensitive-requestId", "invalid-origin"]);
  for (const identityCase of cases.requestIdentityCases) {
    await t.test(identityCase.name, () => {
      const request = {
        protocolVersion: manifest.protocolVersion,
        requestId: identityCase.input.candidate,
        operation: "status",
      };
      const child = runChild(Buffer.from(`${JSON.stringify(request)}\n`, "utf8"));
      if (wireAcceptedClassifications.has(identityCase.expected.classification)) {
        assertQuietExit(child, 0, [readyValue(), responseValue("status", request.requestId)]);
      } else {
        assertQuietExit(child, 64, [readyValue()]);
      }
    });
  }
});

test("extra argv is a silent ordinary pre-handshake failure, not bad-frame 64 or superseded 78", () => {
  const child = runChild(Buffer.alloc(0), { args: ["forbidden-secret-marker"] });
  assert.notEqual(child.status, cases.constants.badRequestExitCode);
  assert.notEqual(child.status, cases.constants.supersededExitCode);
  assert.deepEqual(child.stdout, Buffer.alloc(0));
  assert.deepEqual(child.stderr, Buffer.alloc(0));
});

test("environment material is never reflected into frames, logs, or fixed errors", () => {
  const marker = "forbidden-secret-marker";
  const status = cases.goldenExchanges.find((item) => item.operation === "status");
  assert.ok(status);
  const child = runChild(Buffer.from(status.requestFrame, "utf8"), {
    env: { TW_TOKEN: marker, TW_RELAY_SECRET: marker, RELAY_V2_CREDENTIAL: marker },
  });
  assertQuietExit(child, 0, [readyValue(), status.normalizedResponse]);
  assert.equal(child.stdout.includes(Buffer.from(marker)), false);
  assert.equal(child.stderr.includes(Buffer.from(marker)), false);
});

test("valid request hitting a broken stdout channel exits ordinary non-64/non-78 without stderr", async () => {
  const status = cases.goldenExchanges.find((item) => item.operation === "status");
  assert.ok(status);
  const child = spawn(process.execPath, [cli, hiddenEntry], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = collect(child.stderr);
  const exited = childExit(child);
  const readyBytes = await new Promise((resolve, reject) => {
    const chunks = [];
    child.stdout.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      const value = Buffer.concat(chunks);
      if (value.includes(0x0a)) resolve(value);
    });
    child.stdout.once("error", reject);
  });
  const stdoutClosed = new Promise((resolve) => child.stdout.once("close", resolve));
  child.stdout.destroy();
  await stdoutClosed;
  child.stdin.end(Buffer.from(status.requestFrame, "utf8"));
  const [exit, stderrBytes] = await Promise.all([exited, stderr]);
  assert.notEqual(exit.status, cases.constants.badRequestExitCode);
  assert.notEqual(exit.status, cases.constants.supersededExitCode);
  assert.deepEqual(stderrBytes, Buffer.alloc(0));
  assert.deepEqual(decodeFrames(readyBytes), [readyValue()]);
});
