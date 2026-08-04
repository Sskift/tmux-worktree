import assert from "node:assert/strict";
import test from "node:test";
import QRCode from "qrcode";
import { buildMobileRelayV1PairingPayload } from "../src/dashboard/hooks/useMobileRelayController.ts";

test("Relay v1 pairing payloads remain encodable by the Dashboard QR library", () => {
  const payload = buildMobileRelayV1PairingPayload({
    relayUrl: "wss://relay.example.com",
    hostId: "mac-admin",
    secret: "secret",
  });
  assert.ok(payload);
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
});
