import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/dashboard/Settings/ConnectionsSettings.tsx", import.meta.url),
  "utf8",
);

test("configured hosts retain native button semantics inside list items", () => {
  assert.match(source, /className="connections-host-list" role="list"/);
  assert.match(source, /className="connections-host-list__item" role="listitem">\s*<button/);
  assert.doesNotMatch(source, /<button[^>]*role="listitem"/);
});

test("Relay field errors are programmatically associated with their controls", () => {
  assert.match(source, /const RELAY_BROKER_ERROR_ID = `\$\{RELAY_BROKER_ID\}-error`/);
  assert.match(source, /id=\{RELAY_BROKER_ID\}/);
  assert.match(source, /ariaDescribedBy=\{relayErrors\.brokerHostId \? RELAY_BROKER_ERROR_ID : undefined\}/);
  assert.match(source, /ariaErrorMessage=\{relayErrors\.brokerHostId \? RELAY_BROKER_ERROR_ID : undefined\}/);
  assert.match(source, /<small id=\{RELAY_BROKER_ERROR_ID\}/);
  assert.match(source, /const errorId = `\$\{id\}-error`/);
  assert.match(source, /aria-describedby=\{error \? errorId : undefined\}/);
  assert.match(source, /aria-errormessage=\{error \? errorId : undefined\}/);
  assert.match(source, /<small id=\{errorId\}/);
});

test("Relay Settings exposes one-click setup plus connector and Android status", () => {
  assert.match(source, /aria-label="Relay connection stages"/);
  assert.match(source, /Relay center ·/);
  assert.match(source, /Mac connector/);
  assert.match(source, /Android pairing ·/);
  assert.match(source, /Disconnect this Mac/);
  assert.doesNotMatch(source, /Reconfigure Relay & rotate token/);
  assert.match(source, /\? "Setting up Relay"\s*: "Set up \/ repair Relay"/);
  assert.match(source, /broker, trusted WSS, and this Mac in one step/);
  assert.match(source, /temporary Cloudflare Quick Tunnel/);
  assert.match(source, /<details className="connections-relay-manual">/);
  assert.match(source, /Save fields only/);
  assert.match(source, /Connect this Mac/);
  assert.doesNotMatch(source, /Copy Android v1 launch|copyLaunch/);
});
