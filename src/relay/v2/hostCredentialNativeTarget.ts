export type RelayV2HostCredentialNativeSupportedTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64";

// Contract facts only. Each descriptor mirrors one frozen entry of the
// manifest's nativeArtifact.supportedTargets (contract revision 6, native
// artifact v1); there is no wildcard, alternate candidate, or caller override.
// The descriptor carries the complete frozen artifact identity: cargo build
// identity, runtime artifact file name, loader-relative module specifier, and
// staged/packed layout paths.
export interface RelayV2HostCredentialNativeTargetDescriptor {
  readonly target: RelayV2HostCredentialNativeSupportedTarget;
  readonly platform: "darwin" | "linux";
  readonly architecture: "arm64" | "x64";
  readonly cargoTargetTriple:
    | "aarch64-apple-darwin"
    | "x86_64-apple-darwin"
    | "aarch64-unknown-linux-gnu"
    | "x86_64-unknown-linux-gnu";
  readonly cargoDynamicLibraryFileName: string;
  readonly runtimeArtifactFileName: string;
  readonly loaderModuleSpecifier: string;
  readonly stagedRelativePath: string;
  readonly packedRelativePath: string;
}

function descriptor(
  target: RelayV2HostCredentialNativeSupportedTarget,
  platform: "darwin" | "linux",
  architecture: "arm64" | "x64",
  cargoTargetTriple: RelayV2HostCredentialNativeTargetDescriptor["cargoTargetTriple"],
  cargoDynamicLibraryFileName: string,
): RelayV2HostCredentialNativeTargetDescriptor {
  const runtimeArtifactFileName =
    `relay-v2-host-credential-atomic-file-cell-v1-${target}.node`;
  return Object.freeze({
    target,
    platform,
    architecture,
    cargoTargetTriple,
    cargoDynamicLibraryFileName,
    runtimeArtifactFileName,
    loaderModuleSpecifier: `./native/${runtimeArtifactFileName}`,
    stagedRelativePath: `dist/relay/v2/native/${runtimeArtifactFileName}`,
    packedRelativePath: `package/dist/relay/v2/native/${runtimeArtifactFileName}`,
  });
}

const TARGET_DESCRIPTORS: Readonly<
  Record<
    RelayV2HostCredentialNativeSupportedTarget,
    RelayV2HostCredentialNativeTargetDescriptor
  >
> = Object.freeze({
  "darwin-arm64": descriptor(
    "darwin-arm64",
    "darwin",
    "arm64",
    "aarch64-apple-darwin",
    "librelay_v2_host_credential_atomic_file_cell_napi.dylib",
  ),
  "darwin-x64": descriptor(
    "darwin-x64",
    "darwin",
    "x64",
    "x86_64-apple-darwin",
    "librelay_v2_host_credential_atomic_file_cell_napi.dylib",
  ),
  "linux-arm64": descriptor(
    "linux-arm64",
    "linux",
    "arm64",
    "aarch64-unknown-linux-gnu",
    "librelay_v2_host_credential_atomic_file_cell_napi.so",
  ),
  "linux-x64": descriptor(
    "linux-x64",
    "linux",
    "x64",
    "x86_64-unknown-linux-gnu",
    "librelay_v2_host_credential_atomic_file_cell_napi.so",
  ),
});

export function selectRelayV2HostCredentialNativeTargetDescriptor(
  platform: string,
  architecture: string,
): RelayV2HostCredentialNativeTargetDescriptor | null {
  const target = `${platform}-${architecture}`;
  return Object.hasOwn(TARGET_DESCRIPTORS, target)
    ? TARGET_DESCRIPTORS[target as RelayV2HostCredentialNativeSupportedTarget]
    : null;
}

export function getRelayV2HostCredentialNativeTargetDescriptor(
  target: string,
): RelayV2HostCredentialNativeTargetDescriptor | null {
  return Object.hasOwn(TARGET_DESCRIPTORS, target)
    ? TARGET_DESCRIPTORS[target as RelayV2HostCredentialNativeSupportedTarget]
    : null;
}
