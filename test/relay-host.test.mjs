import assert from "node:assert/strict";
import test from "node:test";

const {
  parseRelayHostOptions,
  relayV2HostCarrierUrl,
  resolveRelayHostProfile,
} = await import("../dist/relayHost.js");

test("relay-host exposes only the Relay v2 profile", () => {
  assert.deepEqual(resolveRelayHostProfile(["--profile", "v2"], {}), {
    profile: "v2",
  });
  assert.deepEqual(parseRelayHostOptions(["--profile", "v2"], {}), {
    profile: "v2",
  });

  for (const argv of [
    ["--profile", "unsupported"],
    ["--relay", "wss://relay.example.test"],
  ]) {
    assert.throws(() => parseRelayHostOptions(argv, {}));
  }
  assert.throws(() => resolveRelayHostProfile([], { TW_RELAY_HOST_PROFILE: "unsupported" }));
});

test("Relay v2 Host parser admits bounded production and local-development inputs", () => {
  assert.deepEqual(parseRelayHostOptions([
    "--profile", "v2",
    "--provision-profile-input", "/tmp/profile.json",
    "--bootstrap-secret-input", "/tmp/bootstrap.txt",
  ], {}), {
    profile: "v2",
    provisionProfileInputPath: "/tmp/profile.json",
    bootstrapSecretInputPath: "/tmp/bootstrap.txt",
  });

  assert.deepEqual(parseRelayHostOptions([
    "--profile", "v2",
    "--local-development",
    "--trusted-home", "/tmp/relay-v2-home",
    "--credential-https-ca-input", "/tmp/credential-ca.pem",
    "--carrier-wss-ca-input", "/tmp/carrier-ca.pem",
  ], {}), {
    profile: "v2",
    localDevelopment: true,
    trustedHome: "/tmp/relay-v2-home",
    credentialHttpsCaInputPath: "/tmp/credential-ca.pem",
    carrierWssCaInputPath: "/tmp/carrier-ca.pem",
  });
});

test("Relay v2 Host carrier URL is exact and credential-free", () => {
  assert.equal(
    relayV2HostCarrierUrl("wss://relay.example.test"),
    "wss://relay.example.test/host",
  );
  for (const invalid of [
    "ws://relay.example.test",
    "wss://user@relay.example.test",
    "wss://relay.example.test/host",
    "wss://relay.example.test/?token=secret",
    "wss://relay.example.test/#fragment",
  ]) {
    assert.throws(() => relayV2HostCarrierUrl(invalid));
  }
});
