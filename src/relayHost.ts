import { types as nodeTypes } from "node:util";

import { CliError } from "./tmux.js";
import type {
  RelayV2HostCanonicalProductionComposition,
  RelayV2HostCanonicalProductionCompositionOptions,
} from "./relay/v2/hostCanonicalProductionComposition.js";
import {
  RelayV2HostProductionProfileStoreError,
  readRelayV2HostProductionProfile,
} from "./relay/v2/hostProductionProfileStore.js";
import { isRelayV2AuthIdentifier } from "./relay/v2/token.js";

export type RelayHostProfile = "v2";

export type RelayV2HostOptions = {
  profile: "v2";
  relay: string;
  hostId: string;
  displayName: string;
  local: string;
  statusFile: string;
  credentialReference: string;
};

type RelayV2HostProductionSelection = {
  profile: "v2";
  provisionProfileInputPath?: string;
  bootstrapSecretInputPath?: string;
  localDevelopment?: never;
  trustedHome?: never;
  credentialHttpsCaInputPath?: never;
  carrierWssCaInputPath?: never;
};

type RelayV2HostLocalDevelopmentSelection = {
  profile: "v2";
  provisionProfileInputPath?: string;
  bootstrapSecretInputPath?: string;
  localDevelopment: true;
  trustedHome: string;
  credentialHttpsCaInputPath: string;
  carrierWssCaInputPath: string;
};

export type RelayV2HostSelection =
  | RelayV2HostProductionSelection
  | RelayV2HostLocalDevelopmentSelection;

export type RelayHostOptions = RelayV2HostSelection;

function relayV2HostProductionProfileProvisioned(): boolean {
  try {
    readRelayV2HostProductionProfile();
    return true;
  } catch (error) {
    if (error instanceof RelayV2HostProductionProfileStoreError
      && error.code === "RELAY_V2_HOST_PRODUCTION_PROFILE_NOT_FOUND") {
      return false;
    }
    throw error;
  }
}

/** Resolve the sole supported Relay host profile without a compatibility path. */
export function resolveRelayHostProfile(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): { profile: RelayHostProfile } {
  let profile = env.TW_RELAY_HOST_PROFILE?.trim() || "";
  let explicitProfile = false;
  let sawRuntimeFlag = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") {
      profile = argv[index + 1] || "";
      explicitProfile = true;
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      // Help is handled by the parser.
    } else {
      sawRuntimeFlag = true;
    }
  }

  if (explicitProfile || profile !== "") {
    if (profile !== "v2") {
      throw new CliError("relay-host --profile 只接受 v2");
    }
    return { profile: "v2" };
  }
  if (sawRuntimeFlag) {
    throw new CliError("relay-host 参数必须显式选择 --profile v2");
  }
  if (!relayV2HostProductionProfileProvisioned()) {
    throw new CliError("relay-host 需要已 provision 的 Relay v2 host profile");
  }
  return { profile: "v2" };
}

const RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE = "relay-v2-host-credential-ref:";
const RELAY_V2_SENSITIVE_CREDENTIAL_PREFIXES = [
  "twcap2.",
  "twref2.",
  "twenroll2.",
  "twhostboot2.",
] as const;

function validCredentialReference(value: string): boolean {
  if (RELAY_V2_SENSITIVE_CREDENTIAL_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return false;
  }
  if (!value.startsWith(RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE) || value.length > 128) {
    return false;
  }
  const identifier = value.slice(RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE.length);
  return isRelayV2AuthIdentifier(identifier)
    && !RELAY_V2_SENSITIVE_CREDENTIAL_PREFIXES.some((prefix) => identifier.startsWith(prefix));
}

export function relayV2HostCarrierUrl(relay: string): string {
  let base: URL;
  try {
    base = new URL(relay);
  } catch {
    throw new CliError("Relay v2 host profile 需要合法的 wss:// root URL");
  }
  if (base.protocol !== "wss:"
    || base.username !== ""
    || base.password !== ""
    || base.pathname !== "/"
    || base.search !== ""
    || base.hash !== "") {
    throw new CliError(
      "Relay v2 host profile 只接受不含凭证、path、query 或 fragment 的 wss:// root URL",
    );
  }
  base.pathname = "/host";
  return base.toString();
}

function relayV2HostProductionCompositionFailure(): CliError {
  return new CliError("Relay v2 host production composition prerequisites are invalid");
}

function captureRelayV2HostProductionDataObject(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || nodeTypes.isProxy(value)) throw relayV2HostProductionCompositionFailure();
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw relayV2HostProductionCompositionFailure();
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw relayV2HostProductionCompositionFailure();
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))
    || expected.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !Object.hasOwn(descriptor, "value");
    })) throw relayV2HostProductionCompositionFailure();
  return Object.fromEntries(expected.map((key) => [key, descriptors[key]!.value]));
}

/** Open the canonical production Host composition from a reference-only profile. */
export async function openRelayV2HostCanonicalProductionComposition(
  rawProfile: RelayV2HostOptions,
  options: RelayV2HostCanonicalProductionCompositionOptions,
): Promise<RelayV2HostCanonicalProductionComposition | null> {
  const profile = captureRelayV2HostProductionDataObject(rawProfile, [
    "profile", "relay", "hostId", "displayName", "local", "statusFile",
    "credentialReference",
  ]);
  if (profile.profile !== "v2"
    || typeof profile.relay !== "string"
    || typeof profile.hostId !== "string"
    || !isRelayV2AuthIdentifier(profile.hostId)
    || typeof profile.displayName !== "string"
    || typeof profile.local !== "string"
    || typeof profile.statusFile !== "string"
    || typeof profile.credentialReference !== "string"
    || !validCredentialReference(profile.credentialReference)) {
    throw relayV2HostProductionCompositionFailure();
  }
  relayV2HostCarrierUrl(profile.relay);
  let entry: typeof import("./relay/v2/hostCanonicalProductionComposition.js");
  try {
    entry = await import("./relay/v2/hostCanonicalProductionComposition.js");
  } catch {
    throw relayV2HostProductionCompositionFailure();
  }
  return entry.openRelayV2HostCanonicalProductionComposition(Object.freeze({
    relayUrl: profile.relay,
    hostId: profile.hostId,
    credentialReference: profile.credentialReference,
  }), options);
}

export function parseRelayHostOptions(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): RelayHostOptions {
  resolveRelayHostProfile(argv, env);
  let explicitProfileCount = 0;
  let provisionProfileInputPath: string | undefined;
  let bootstrapSecretInputPath: string | undefined;
  let localDevelopmentCount = 0;
  let trustedHome: string | undefined;
  let credentialHttpsCaInputPath: string | undefined;
  let carrierWssCaInputPath: string | undefined;

  const readPath = (argvIndex: number, flag: string): string => {
    const value = argv[argvIndex + 1];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new CliError(`relay-host ${flag} 需要非空文件路径`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") {
      explicitProfileCount += 1;
      if (argv[index + 1] !== "v2") throw new CliError("relay-host --profile 只接受 v2");
      index += 1;
    } else if (arg === "--provision-profile-input") {
      if (provisionProfileInputPath !== undefined) {
        throw new CliError("relay-host --provision-profile-input 只能指定一次");
      }
      provisionProfileInputPath = readPath(index, arg);
      index += 1;
    } else if (arg === "--bootstrap-secret-input") {
      if (bootstrapSecretInputPath !== undefined) {
        throw new CliError("relay-host --bootstrap-secret-input 只能指定一次");
      }
      bootstrapSecretInputPath = readPath(index, arg);
      index += 1;
    } else if (arg === "--local-development") {
      localDevelopmentCount += 1;
      if (localDevelopmentCount > 1) {
        throw new CliError("relay-host --local-development 只能指定一次");
      }
    } else if (arg === "--trusted-home") {
      if (trustedHome !== undefined) throw new CliError("relay-host --trusted-home 只能指定一次");
      trustedHome = readPath(index, arg);
      index += 1;
    } else if (arg === "--credential-https-ca-input") {
      if (credentialHttpsCaInputPath !== undefined) {
        throw new CliError("relay-host --credential-https-ca-input 只能指定一次");
      }
      credentialHttpsCaInputPath = readPath(index, arg);
      index += 1;
    } else if (arg === "--carrier-wss-ca-input") {
      if (carrierWssCaInputPath !== undefined) {
        throw new CliError("relay-host --carrier-wss-ca-input 只能指定一次");
      }
      carrierWssCaInputPath = readPath(index, arg);
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new CliError(`未知 relay-host 参数: ${arg}`);
    }
  }

  if (explicitProfileCount > 1) throw new CliError("relay-host --profile 只能指定一次");
  if (provisionProfileInputPath !== undefined && explicitProfileCount !== 1) {
    throw new CliError("relay-host provisioning 要求显式指定 --profile v2");
  }
  const localDevelopmentRequested = localDevelopmentCount === 1
    || trustedHome !== undefined
    || credentialHttpsCaInputPath !== undefined
    || carrierWssCaInputPath !== undefined;
  if (localDevelopmentRequested) {
    if (explicitProfileCount !== 1 || localDevelopmentCount !== 1) {
      throw new CliError("Relay v2 Host 本机开发要求显式 --profile v2 --local-development");
    }
    if (trustedHome === undefined
      || credentialHttpsCaInputPath === undefined
      || carrierWssCaInputPath === undefined) {
      throw new CliError(
        "relay-host --local-development 要求 --trusted-home、"
        + "--credential-https-ca-input 与 --carrier-wss-ca-input",
      );
    }
    return {
      profile: "v2",
      ...(provisionProfileInputPath === undefined ? {} : { provisionProfileInputPath }),
      ...(bootstrapSecretInputPath === undefined ? {} : { bootstrapSecretInputPath }),
      localDevelopment: true,
      trustedHome,
      credentialHttpsCaInputPath,
      carrierWssCaInputPath,
    };
  }
  return {
    profile: "v2",
    ...(provisionProfileInputPath === undefined ? {} : { provisionProfileInputPath }),
    ...(bootstrapSecretInputPath === undefined ? {} : { bootstrapSecretInputPath }),
  };
}

function printHelp(): void {
  console.log(`tw relay-host — Relay v2 Mac connector

用法:
  tw relay-host
  tw relay-host --profile v2 [--provision-profile-input <path>]
    [--bootstrap-secret-input <path>]
  tw relay-host --profile v2 --local-development \\
    --trusted-home <absolute-path> \\
    --credential-https-ca-input <path> --carrier-wss-ca-input <path>

裸调用只读取 canonical Relay v2 Host profile。缺失、损坏或不安全的 profile
会 fail closed。不存在其它协议入口。`);
}

export async function run(): Promise<void> {
  const opts = parseRelayHostOptions(process.argv.slice(3));
  const deployment = await import("./relay/v2/hostShippingDeploymentSource.js");
  if (opts.localDevelopment === true) {
    process.exitCode = await deployment.runRelayV2HostShippingFromLocalDevelopment({
      trustedHome: opts.trustedHome,
      credentialHttpsCaInputPath: opts.credentialHttpsCaInputPath,
      carrierWssCaInputPath: opts.carrierWssCaInputPath,
      ...(opts.provisionProfileInputPath === undefined
        ? {}
        : { provisionProfileInputPath: opts.provisionProfileInputPath }),
      ...(opts.bootstrapSecretInputPath === undefined
        ? {}
        : { bootstrapSecretInputPath: opts.bootstrapSecretInputPath }),
    });
    return;
  }
  if (opts.provisionProfileInputPath !== undefined) {
    const {
      loadOrCreateRelayV2HostProductionProfile,
      readRelayV2HostProductionProfileProvisioningInput,
    } = await import("./relay/v2/hostProductionProfileStore.js");
    const profile = readRelayV2HostProductionProfileProvisioningInput({
      inputPath: opts.provisionProfileInputPath,
    });
    loadOrCreateRelayV2HostProductionProfile({ profile });
  }
  process.exitCode = opts.bootstrapSecretInputPath === undefined
    ? await deployment.runRelayV2HostShippingFromTrustedDeployment()
    : await deployment.runRelayV2HostShippingFromTrustedDeployment(
      opts.bootstrapSecretInputPath,
    );
}
