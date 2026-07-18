export type RelayV2BrokerCredentialStateStoreSupportedNativeTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64";

export interface RelayV2BrokerCredentialStateStoreNativeArtifactDescriptor {
  readonly target: RelayV2BrokerCredentialStateStoreSupportedNativeTarget;
  readonly moduleSpecifier: string;
}

export interface RelayV2BrokerCredentialStateStoreNativeTargetDescriptor {
  readonly target: RelayV2BrokerCredentialStateStoreSupportedNativeTarget;
  readonly platform: "darwin" | "linux";
  readonly architecture: "arm64" | "x64";
  readonly cargoTargetTriple:
    | "aarch64-apple-darwin"
    | "x86_64-apple-darwin"
    | "aarch64-unknown-linux-gnu"
    | "x86_64-unknown-linux-gnu";
  readonly cargoDynamicLibraryFileName: string;
  readonly runtimeArtifact: RelayV2BrokerCredentialStateStoreNativeArtifactDescriptor;
}

function descriptor(
  target: RelayV2BrokerCredentialStateStoreSupportedNativeTarget,
  platform: "darwin" | "linux",
  architecture: "arm64" | "x64",
  cargoTargetTriple: RelayV2BrokerCredentialStateStoreNativeTargetDescriptor["cargoTargetTriple"],
  cargoDynamicLibraryFileName: string,
  moduleSpecifier: string,
): RelayV2BrokerCredentialStateStoreNativeTargetDescriptor {
  return Object.freeze({
    target,
    platform,
    architecture,
    cargoTargetTriple,
    cargoDynamicLibraryFileName,
    runtimeArtifact: Object.freeze({
      target,
      moduleSpecifier,
    }),
  });
}

const TARGET_DESCRIPTORS: Readonly<
  Record<
    RelayV2BrokerCredentialStateStoreSupportedNativeTarget,
    RelayV2BrokerCredentialStateStoreNativeTargetDescriptor
  >
> = Object.freeze({
  "darwin-arm64": descriptor(
    "darwin-arm64",
    "darwin",
    "arm64",
    "aarch64-apple-darwin",
    "librelay_v2_broker_credential_state_store_napi.dylib",
    "./native/relay-v2-broker-credential-state-store-v1-darwin-arm64.node",
  ),
  "darwin-x64": descriptor(
    "darwin-x64",
    "darwin",
    "x64",
    "x86_64-apple-darwin",
    "librelay_v2_broker_credential_state_store_napi.dylib",
    "./native/relay-v2-broker-credential-state-store-v1-darwin-x64.node",
  ),
  "linux-arm64": descriptor(
    "linux-arm64",
    "linux",
    "arm64",
    "aarch64-unknown-linux-gnu",
    "librelay_v2_broker_credential_state_store_napi.so",
    "./native/relay-v2-broker-credential-state-store-v1-linux-arm64.node",
  ),
  "linux-x64": descriptor(
    "linux-x64",
    "linux",
    "x64",
    "x86_64-unknown-linux-gnu",
    "librelay_v2_broker_credential_state_store_napi.so",
    "./native/relay-v2-broker-credential-state-store-v1-linux-x64.node",
  ),
});

export function selectRelayV2BrokerCredentialStateStoreNativeTargetDescriptor(
  platform: string,
  architecture: string,
): RelayV2BrokerCredentialStateStoreNativeTargetDescriptor | null {
  const target = `${platform}-${architecture}`;
  return Object.hasOwn(TARGET_DESCRIPTORS, target)
    ? TARGET_DESCRIPTORS[
        target as RelayV2BrokerCredentialStateStoreSupportedNativeTarget
      ]
    : null;
}

export function getRelayV2BrokerCredentialStateStoreNativeTargetDescriptor(
  target: string,
): RelayV2BrokerCredentialStateStoreNativeTargetDescriptor | null {
  return Object.hasOwn(TARGET_DESCRIPTORS, target)
    ? TARGET_DESCRIPTORS[
        target as RelayV2BrokerCredentialStateStoreSupportedNativeTarget
      ]
    : null;
}
