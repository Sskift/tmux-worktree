import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import QRCode from "qrcode";
import { buildMobileRelayV1PairingPayload } from "../src/dashboard/hooks/useMobileRelayController.ts";

const settingsSource = readFileSync(
  new URL("../src/dashboard/Settings/ConnectionsSettings.tsx", import.meta.url),
  "utf8",
);
const documentation = readFileSync(
  new URL("../../docs/remote-relay-android.md", import.meta.url),
  "utf8",
);

test("Dashboard renders the Relay v1 profile as a QR canvas", () => {
  const componentStart = settingsSource.indexOf("function MobileRelayV1ProfileQrCode");
  const componentEnd = settingsSource.indexOf("interface RelayFieldProps", componentStart);
  const component = settingsSource.slice(componentStart, componentEnd);

  assert.ok(componentStart >= 0 && componentEnd > componentStart);
  assert.match(component, /QRCode\.toCanvas\(canvas, payload/);
  assert.match(component, /aria-label="Android Relay v1 profile QR code"/);
  assert.doesNotMatch(component, /\b(?:alt|title)=/);
  assert.match(settingsSource, />Relay v1 profile</);
  assert.match(settingsSource, /review before saving/);
  assert.match(settingsSource, /not a Relay v2 capability/);

  const payload =
    "tmuxworktree://pair?relayUrl=wss%3A%2F%2Frelay.example.com&token=secret&hostId=mac-admin";
  const generated = QRCode.create(payload, { errorCorrectionLevel: "M" });
  assert.ok(generated.modules.size > 0);
  assert.ok(generated.modules.data.some((module) => module === 1));

  const largePayload = buildMobileRelayV1PairingPayload({
    relayUrl: "wss://relay.example.test",
    hostId: "mac-admin",
    secret: "a".repeat(2_000),
  });
  assert.ok(largePayload);
  assert.ok(QRCode.create(largePayload, { errorCorrectionLevel: "M" }).modules.size > 0);

  assert.match(documentation, /Relay v1 profile/);
  assert.match(documentation, /Set up Relay/);
  assert.match(documentation, /Mac connector connected/);
  assert.match(documentation, /does not place an adb command/);
  assert.doesNotMatch(documentation, /ws:\/\/<mac-local-name>\.local/);
  assert.doesNotMatch(documentation, /--ez autoConnect true/);
});
