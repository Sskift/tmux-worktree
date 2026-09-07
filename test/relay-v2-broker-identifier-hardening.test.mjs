import assert from "node:assert/strict";
import test from "node:test";

// F047 review fix: the broker identifier gates now share the hardened
// token.ts helper (unpaired-surrogate rejection + captured-intrinsic
// prototype-pollution hardening). These tests pin that protocol-visible,
// fail-closed behavior change so it cannot regress silently.
const token = await import("../dist/relay/v2/token.js");
const brokerModule = await import("../dist/relay/v2/brokerCore.js");

const broker = Object.freeze({
  ...brokerModule,
  RelayV2BrokerCore: class G2RelayV2BrokerCore extends brokerModule.RelayV2BrokerCore {
    constructor(options = {}) {
      super({
        baseCapabilityReadiness: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
        ...options,
      });
    }
  },
});

// Far-future expiry so hand-built authorization snapshots admit cleanly
// without a trusted clock.
const EXPIRES_AT_MS = Date.UTC(2100, 0, 1);

function authContext(role, overrides = {}) {
  return {
    scheme: "twcap2",
    role,
    hostId: "mac-admin",
    principalId: role === "host" ? "host-principal" : "client-principal",
    grantId: role === "host" ? "host-grant" : "client-grant",
    clientInstanceId: role === "host" ? null : "android-install",
    jti: role === "host" ? "host-jti" : "client-jti",
    kid: "key-2026-07",
    expiresAtMs: EXPIRES_AT_MS,
    authorizationRevision: "1",
    authorizationFence: "authorization-fence-1",
    ...overrides,
  };
}

test("token identifier helper rejects unpaired surrogates but accepts paired-surrogate identifiers", () => {
  const { isRelayV2AuthIdentifier } = token;
  assert.equal(isRelayV2AuthIdentifier("conn-123"), true);
  // A valid surrogate pair (😀) is well-formed UTF-8 and remains accepted.
  assert.equal(isRelayV2AuthIdentifier("conn-😀-ok"), true);
  // Lone high surrogate at the end of the string: un-encodable as UTF-8,
  // now rejected (F047 hardening).
  assert.equal(isRelayV2AuthIdentifier("conn-\uD800"), false);
  // Lone high surrogate followed by a non-low character is rejected too.
  assert.equal(isRelayV2AuthIdentifier("a\uD800b"), false);
  // Lone low surrogate in any position is rejected as well.
  assert.equal(isRelayV2AuthIdentifier("conn-\uDC00"), false);
  assert.equal(isRelayV2AuthIdentifier("\uD800"), false);
  assert.equal(isRelayV2AuthIdentifier("\uDC00"), false);
  // The pre-existing gates keep working.
  assert.equal(isRelayV2AuthIdentifier(""), false);
  assert.equal(isRelayV2AuthIdentifier(" leading-space"), false);
  assert.equal(isRelayV2AuthIdentifier("trailing-space "), false);
  assert.equal(isRelayV2AuthIdentifier("contains\nnewline"), false);
  assert.equal(isRelayV2AuthIdentifier("contains\rcr"), false);
  assert.equal(isRelayV2AuthIdentifier("contains\0nul"), false);
});

test("broker rejects client connection IDs containing unpaired surrogates", () => {
  const core = new broker.RelayV2BrokerCore();
  const highSurrogate = core.openClientRoute("conn-\uD800", authContext("client"));
  assert.equal(highSurrogate.accepted, false);
  assert.equal(highSurrogate.error.code, "INVALID_ENVELOPE");
  const lowSurrogate = core.openClientRoute("conn-\uDC00", authContext("client"));
  assert.equal(lowSurrogate.accepted, false);
  assert.equal(lowSurrogate.error.code, "INVALID_ENVELOPE");
});

test("broker refuses host carrier transport IDs containing unpaired surrogates", () => {
  let core = new broker.RelayV2BrokerCore();
  assert.throws(
    () => core.attachHostCarrier("transport-\uD800", authContext("host")),
    /invalid or duplicate Relay v2 carrier transport ID/,
  );
  assert.throws(
    () => core.attachHostCarrier("transport-\uDC00", authContext("host")),
    /invalid or duplicate Relay v2 carrier transport ID/,
  );
  // A paired-surrogate transport ID is well-formed UTF-8: it passes the
  // identifier gate and admits the carrier (contrast with the surrogates
  // above, which never reach the authorization check).
  core = new broker.RelayV2BrokerCore();
  assert.doesNotThrow(() => {
    core.attachHostCarrier("transport-😀-ok", authContext("host"));
  });
  // The same ID twice trips the duplicate half of the same gate, proving the
  // emoji carrier really was admitted on the first call.
  assert.throws(
    () => core.attachHostCarrier("transport-😀-ok", authContext("host", { jti: "emoji-dup-jti" })),
    /invalid or duplicate Relay v2 carrier transport ID/,
  );
});

test("broker identifier validation survives prototype pollution of string builtins", () => {
  const { isRelayV2AuthIdentifier } = token;
  const originalTrim = String.prototype.trim;
  const originalCharCodeAt = String.prototype.charCodeAt;
  const originalRegExpTest = RegExp.prototype.test;
  try {
    // An attacker-controlled prototype that makes the unhardened
    // `value.trim() === value`, `/[\0\r\n]/.test(value)`, or
    // `value.charCodeAt(i)` surrogate scan lie must not weaken the gate:
    // token.ts captured the intrinsics at module load. The charCodeAt stub
    // hides every surrogate and reports 'A', so rejection below proves the
    // module never calls the polluted builtins.
    String.prototype.trim = function trim() { return this; };
    RegExp.prototype.test = function test() { return false; };
    String.prototype.charCodeAt = function charCodeAt() { return 0x41; };
    assert.equal(isRelayV2AuthIdentifier(" leading-space"), false);
    assert.equal(isRelayV2AuthIdentifier("contains\nnewline"), false);
    assert.equal(isRelayV2AuthIdentifier("conn-\uD800"), false);
    assert.equal(isRelayV2AuthIdentifier("conn-\uDC00"), false);
  } finally {
    String.prototype.trim = originalTrim;
    String.prototype.charCodeAt = originalCharCodeAt;
    RegExp.prototype.test = originalRegExpTest;
  }
  // Sanity: the pollution window is closed and ordinary inputs pass.
  assert.equal(isRelayV2AuthIdentifier("conn-after-restore"), true);
});
