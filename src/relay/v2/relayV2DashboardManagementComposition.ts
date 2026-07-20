import {
  RelayV2DashboardManagementAuthority,
} from "./relayV2DashboardManagementAuthority.js";
import {
  RelayV2DashboardManagementHostCredentialAdapter,
} from "./relayV2DashboardManagementHostCredentialAdapter.js";
import {
  RelayV2DashboardManagementHostConnectorAdapter,
} from "./relayV2DashboardManagementHostConnectorAdapter.js";
import type {
  RelayV2DashboardManagementProtocolV2Request,
  RelayV2DashboardManagementProtocolV2Response,
} from "./relayV2DashboardManagementProtocolV2.js";
import {
  isRelayV2HostCredentialAuthority,
  RelayV2HostCredentialAuthority,
} from "./hostCredentialAuthority.js";
import {
  isRelayV2HostCredentialExchangeCoordinatorForAuthority,
  RelayV2HostCredentialExchangeCoordinator,
  type RelayV2HostCredentialOwnerBoundExchangePort,
} from "./hostCredentialExchangeCoordinator.js";
import {
  abortRelayV2HostDashboardManagementBinding,
  commitRelayV2HostDashboardManagementBinding,
  consumeRelayV2HostDashboardManagementBinding,
  type RelayV2HostDashboardManagementBinding,
} from "./hostRuntimeComposition.js";

type DataRecord = Record<string, unknown>;

export interface RelayV2DashboardManagementCompositionOptions {
  readonly credentialAuthority: RelayV2HostCredentialAuthority;
  readonly credentialExchangeCoordinator: RelayV2HostCredentialExchangeCoordinator;
  readonly hostManagementBinding: RelayV2HostDashboardManagementBinding;
  readonly hostId: string;
  readonly hostEpoch: string;
  readonly hostInstanceId: string;
  readonly credentialReference: string;
  readonly bootstrapSecretReference: string;
  readonly refreshSecretReference: string;
  readonly signal: AbortSignal;
  readonly clock: () => number;
}

export interface RelayV2DashboardManagementComposition {
  handleRequest(
    request: RelayV2DashboardManagementProtocolV2Request,
  ): Promise<RelayV2DashboardManagementProtocolV2Response>;
  closeAndDrain(): Promise<void>;
}

export class RelayV2DashboardManagementCompositionClosedError extends Error {
  constructor() {
    super("Relay v2 Dashboard management composition closed");
    this.name = "RelayV2DashboardManagementCompositionClosedError";
  }
}

interface ActivationSignature extends RelayV2DashboardManagementCompositionOptions {}

interface ActivationRecord {
  readonly ownership: "standalone" | "protocol_v2_session";
  readonly signature: ActivationSignature;
  readonly handle: RelayV2DashboardManagementComposition;
}

const credentialAuthorityActivations = new WeakMap<object, ActivationRecord>();
const credentialCoordinatorActivations = new WeakMap<object, ActivationRecord>();
const hostManagementBindingActivations = new WeakMap<object, ActivationRecord>();

const COORDINATOR_CREATE_OWNER =
  RelayV2HostCredentialExchangeCoordinator.prototype.createOwnerBoundPort;
const COMPOSITION_CLOSE_REQUEST_ID = "dashboard-management-composition.close";

function closed(): never {
  throw new RelayV2DashboardManagementCompositionClosedError();
}

function isObject(value: unknown): value is DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactDataObject(value: unknown, expected: readonly string[]): DataRecord {
  if (!isObject(value)) return closed();
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return closed();
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))
    || expected.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || !Object.hasOwn(descriptor, "value");
    })) return closed();
  return Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
}

function sameSignature(
  left: ActivationSignature,
  right: ActivationSignature,
): boolean {
  return left.credentialAuthority === right.credentialAuthority
    && left.credentialExchangeCoordinator === right.credentialExchangeCoordinator
    && left.hostManagementBinding === right.hostManagementBinding
    && left.hostId === right.hostId
    && left.hostEpoch === right.hostEpoch
    && left.hostInstanceId === right.hostInstanceId
    && left.credentialReference === right.credentialReference
    && left.bootstrapSecretReference === right.bootstrapSecretReference
    && left.refreshSecretReference === right.refreshSecretReference
    && left.signal === right.signal
    && left.clock === right.clock;
}

function existingActivation(signature: ActivationSignature): ActivationRecord | null {
  const records = [
    credentialAuthorityActivations.get(signature.credentialAuthority),
    credentialCoordinatorActivations.get(signature.credentialExchangeCoordinator),
    hostManagementBindingActivations.get(signature.hostManagementBinding),
  ];
  const existing = records.filter((record): record is ActivationRecord => record !== undefined);
  if (existing.length === 0) return null;
  const winner = existing[0];
  if (existing.length !== records.length
    || existing.some((record) => record !== winner)
    || !sameSignature(winner.signature, signature)) return closed();
  return winner;
}

function captureOptions(value: unknown): ActivationSignature {
  const fields = exactDataObject(value, [
    "credentialAuthority",
    "credentialExchangeCoordinator",
    "hostManagementBinding",
    "hostId",
    "hostEpoch",
    "hostInstanceId",
    "credentialReference",
    "bootstrapSecretReference",
    "refreshSecretReference",
    "signal",
    "clock",
  ]);
  if (!(fields.signal instanceof AbortSignal) || typeof fields.clock !== "function") {
    return closed();
  }
  return Object.freeze({
    credentialAuthority: fields.credentialAuthority as RelayV2HostCredentialAuthority,
    credentialExchangeCoordinator:
      fields.credentialExchangeCoordinator as RelayV2HostCredentialExchangeCoordinator,
    hostManagementBinding:
      fields.hostManagementBinding as RelayV2HostDashboardManagementBinding,
    hostId: fields.hostId as string,
    hostEpoch: fields.hostEpoch as string,
    hostInstanceId: fields.hostInstanceId as string,
    credentialReference: fields.credentialReference as string,
    bootstrapSecretReference: fields.bootstrapSecretReference as string,
    refreshSecretReference: fields.refreshSecretReference as string,
    signal: fields.signal,
    clock: fields.clock as () => number,
  });
}

function validateOwners(signature: ActivationSignature): void {
  if (!isRelayV2HostCredentialAuthority(signature.credentialAuthority)
    || !isRelayV2HostCredentialExchangeCoordinatorForAuthority(
      signature.credentialExchangeCoordinator,
      signature.credentialAuthority,
    )) return closed();
}

/**
 * Default-off, unwired composition for one exact Dashboard management owner.
 * It chooses no protocol and owns no process, socket, transport, credential,
 * enrollment, capability, or fallback lifecycle.
 */
function activateComposition(
  signature: ActivationSignature,
  ownership: ActivationRecord["ownership"],
): RelayV2DashboardManagementComposition {
  const hostIdentity = Object.freeze({
    hostId: signature.hostId,
    hostEpoch: signature.hostEpoch,
    hostInstanceId: signature.hostInstanceId,
    credentialReference: signature.credentialReference,
  });
  let committed = false;
  try {
    validateOwners(signature);
    const credentialOwner = Reflect.apply(
      COORDINATOR_CREATE_OWNER,
      signature.credentialExchangeCoordinator,
      [],
    ) as RelayV2HostCredentialOwnerBoundExchangePort;
    const credential = new RelayV2DashboardManagementHostCredentialAdapter({
      owner: credentialOwner,
      credentialReference: signature.credentialReference,
      hostId: signature.hostId,
      hostEpoch: signature.hostEpoch,
      hostInstanceId: signature.hostInstanceId,
      bootstrapSecretReference: signature.bootstrapSecretReference,
      refreshSecretReference: signature.refreshSecretReference,
      signal: signature.signal,
    });
    const hostPorts = consumeRelayV2HostDashboardManagementBinding(
      signature.hostManagementBinding,
      hostIdentity,
      signature.credentialAuthority,
    );
    if (hostPorts === null) return closed();
    const connector = new RelayV2DashboardManagementHostConnectorAdapter({
      controller: hostPorts.connectorLifecycle,
      hostId: signature.hostId,
      hostEpoch: signature.hostEpoch,
      hostInstanceId: signature.hostInstanceId,
      credentialReference: signature.credentialReference,
      signal: signature.signal,
    });
    const authority = new RelayV2DashboardManagementAuthority({
      credential,
      connector,
      carrierControl: hostPorts.carrierControl,
      clock: signature.clock,
    });

    let accepting = true;
    let closePromise: Promise<void> | null = null;
    const pending = new Set<Promise<RelayV2DashboardManagementProtocolV2Response>>();
    const handleRequest = (
      request: RelayV2DashboardManagementProtocolV2Request,
    ): Promise<RelayV2DashboardManagementProtocolV2Response> => {
      if (!accepting) {
        return Promise.reject(new RelayV2DashboardManagementCompositionClosedError());
      }
      const operation = Promise.resolve().then(() => authority.handle(request));
      pending.add(operation);
      void operation.then(
        () => { pending.delete(operation); },
        () => { pending.delete(operation); },
      );
      return operation;
    };
    const closeAndDrain = (): Promise<void> => {
      if (closePromise !== null) return closePromise;
      accepting = false;
      closePromise = (async () => {
        await Promise.allSettled([...pending]);
        const cut = await connector.inspectCut();
        if (cut.status !== "stopped") {
          await connector.stop({ requestId: COMPOSITION_CLOSE_REQUEST_ID });
          const drained = await connector.inspectCut();
          if (drained.status !== "stopped") return closed();
        }
      })().catch(() => {
        throw new RelayV2DashboardManagementCompositionClosedError();
      });
      return closePromise;
    };
    const handle = Object.freeze(Object.assign(Object.create(null), {
      handleRequest,
      closeAndDrain,
    })) as RelayV2DashboardManagementComposition;
    const record: ActivationRecord = Object.freeze({ ownership, signature, handle });
    if (!commitRelayV2HostDashboardManagementBinding(
      signature.hostManagementBinding,
      hostIdentity,
      signature.credentialAuthority,
    )) return closed();
    committed = true;
    credentialAuthorityActivations.set(signature.credentialAuthority, record);
    credentialCoordinatorActivations.set(signature.credentialExchangeCoordinator, record);
    hostManagementBindingActivations.set(signature.hostManagementBinding, record);
    return handle;
  } catch {
    if (!committed) {
      abortRelayV2HostDashboardManagementBinding(
        signature.hostManagementBinding,
        hostIdentity,
        signature.credentialAuthority,
      );
    }
    return closed();
  }
}

export function createRelayV2DashboardManagementComposition(
  options: RelayV2DashboardManagementCompositionOptions,
): RelayV2DashboardManagementComposition {
  const signature = captureOptions(options);
  const existing = existingActivation(signature);
  if (existing !== null) {
    if (existing.ownership !== "standalone") return closed();
    return existing.handle;
  }
  return activateComposition(signature, "standalone");
}

/**
 * Atomically reserves a fresh composition activation for the canonical
 * protocol-v2 session owner. Any prior activation, including an exact closed
 * standalone activation, is terminal; the public idempotent factory cannot
 * reacquire the resulting handle.
 */
export function claimRelayV2DashboardManagementCompositionForProtocolV2Session(
  options: RelayV2DashboardManagementCompositionOptions,
): RelayV2DashboardManagementComposition {
  const signature = captureOptions(options);
  if (existingActivation(signature) !== null) return closed();
  return activateComposition(signature, "protocol_v2_session");
}
