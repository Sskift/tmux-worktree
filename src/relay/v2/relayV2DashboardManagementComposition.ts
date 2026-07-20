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
  isRelayV2HostCarrierActorForDashboardManagement,
  RelayV2HostCarrierActor,
} from "./hostCarrier.js";
import {
  isRelayV2HostConnectorControllerForIdentity,
  RelayV2HostConnectorController,
  type RelayV2HostConnectorControllerPort,
} from "./hostConnectorController.js";
import {
  isRelayV2HostCredentialAuthority,
  RelayV2HostCredentialAuthority,
} from "./hostCredentialAuthority.js";
import {
  isRelayV2HostCredentialExchangeCoordinatorForAuthority,
  RelayV2HostCredentialExchangeCoordinator,
  type RelayV2HostCredentialOwnerBoundExchangePort,
} from "./hostCredentialExchangeCoordinator.js";

type DataRecord = Record<string, unknown>;

export interface RelayV2DashboardManagementCompositionOptions {
  readonly credentialAuthority: RelayV2HostCredentialAuthority;
  readonly credentialExchangeCoordinator: RelayV2HostCredentialExchangeCoordinator;
  readonly connectorController: RelayV2HostConnectorController;
  readonly hostCarrierActor: RelayV2HostCarrierActor;
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
  readonly signature: ActivationSignature;
  readonly handle: RelayV2DashboardManagementComposition;
}

const credentialAuthorityActivations = new WeakMap<object, ActivationRecord>();
const credentialCoordinatorActivations = new WeakMap<object, ActivationRecord>();
const connectorControllerActivations = new WeakMap<object, ActivationRecord>();
const hostCarrierActorActivations = new WeakMap<object, ActivationRecord>();

const CONTROLLER_INSPECT = RelayV2HostConnectorController.prototype.inspectCut;
const CONTROLLER_START = RelayV2HostConnectorController.prototype.start;
const CONTROLLER_STOP_AND_DRAIN = RelayV2HostConnectorController.prototype.stopAndDrain;
const ACTOR_STATUS = RelayV2HostCarrierActor.prototype.status;
const ACTOR_CREATE_CONTROL =
  RelayV2HostCarrierActor.prototype.createDashboardManagementCarrierControlAdapter;
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
    && left.connectorController === right.connectorController
    && left.hostCarrierActor === right.hostCarrierActor
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
    connectorControllerActivations.get(signature.connectorController),
    hostCarrierActorActivations.get(signature.hostCarrierActor),
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
    "connectorController",
    "hostCarrierActor",
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
    connectorController: fields.connectorController as RelayV2HostConnectorController,
    hostCarrierActor: fields.hostCarrierActor as RelayV2HostCarrierActor,
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
  const identity = Object.freeze({
    hostId: signature.hostId,
    hostEpoch: signature.hostEpoch,
    hostInstanceId: signature.hostInstanceId,
    credentialReference: signature.credentialReference,
  });
  if (!isRelayV2HostCredentialAuthority(signature.credentialAuthority)
    || !isRelayV2HostCredentialExchangeCoordinatorForAuthority(
      signature.credentialExchangeCoordinator,
      signature.credentialAuthority,
    )
    || !isRelayV2HostConnectorControllerForIdentity(
      signature.connectorController,
      identity,
    )
    || !isRelayV2HostCarrierActorForDashboardManagement(
      signature.hostCarrierActor,
      {
        hostId: signature.hostId,
        hostEpoch: signature.hostEpoch,
        hostInstanceId: signature.hostInstanceId,
        credentialReferences: signature.credentialAuthority,
      },
    )) return closed();

  let controllerCut: ReturnType<RelayV2HostConnectorController["inspectCut"]>;
  let actorStatus: ReturnType<RelayV2HostCarrierActor["status"]>;
  try {
    controllerCut = Reflect.apply(CONTROLLER_INSPECT, signature.connectorController, []);
    actorStatus = Reflect.apply(ACTOR_STATUS, signature.hostCarrierActor, []);
  } catch {
    return closed();
  }
  if (controllerCut.status !== "stopped"
    || controllerCut.controllerGeneration !== "0"
    || actorStatus !== null) return closed();
}

function createControllerPort(
  controller: RelayV2HostConnectorController,
): RelayV2HostConnectorControllerPort {
  return Object.freeze({
    inspectCut: () => Reflect.apply(CONTROLLER_INSPECT, controller, []),
    start: (input) => Reflect.apply(CONTROLLER_START, controller, [input]),
    stopAndDrain: (input) => Reflect.apply(CONTROLLER_STOP_AND_DRAIN, controller, [input]),
  });
}

/**
 * Default-off, unwired composition for one exact Dashboard management owner.
 * It chooses no protocol and owns no process, socket, transport, credential,
 * enrollment, capability, or fallback lifecycle.
 */
export function createRelayV2DashboardManagementComposition(
  options: RelayV2DashboardManagementCompositionOptions,
): RelayV2DashboardManagementComposition {
  const signature = captureOptions(options);
  const existing = existingActivation(signature);
  if (existing !== null) return existing.handle;
  validateOwners(signature);

  let credentialOwner: RelayV2HostCredentialOwnerBoundExchangePort;
  let carrierControl: ReturnType<
    RelayV2HostCarrierActor["createDashboardManagementCarrierControlAdapter"]
  >;
  try {
    credentialOwner = Reflect.apply(
      COORDINATOR_CREATE_OWNER,
      signature.credentialExchangeCoordinator,
      [],
    );
    carrierControl = Reflect.apply(ACTOR_CREATE_CONTROL, signature.hostCarrierActor, []);
  } catch {
    return closed();
  }
  const connector = new RelayV2DashboardManagementHostConnectorAdapter({
    controller: createControllerPort(signature.connectorController),
    hostId: signature.hostId,
    hostEpoch: signature.hostEpoch,
    hostInstanceId: signature.hostInstanceId,
    credentialReference: signature.credentialReference,
    signal: signature.signal,
  });
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
  const authority = new RelayV2DashboardManagementAuthority({
    credential,
    connector,
    carrierControl,
    clock: signature.clock,
  });

  let accepting = true;
  let closePromise: Promise<void> | null = null;
  const pending = new Set<Promise<RelayV2DashboardManagementProtocolV2Response>>();
  const handleRequest = (
    request: RelayV2DashboardManagementProtocolV2Request,
  ): Promise<RelayV2DashboardManagementProtocolV2Response> => {
    if (!accepting) return Promise.reject(new RelayV2DashboardManagementCompositionClosedError());
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
  const record: ActivationRecord = Object.freeze({ signature, handle });
  credentialAuthorityActivations.set(signature.credentialAuthority, record);
  credentialCoordinatorActivations.set(signature.credentialExchangeCoordinator, record);
  connectorControllerActivations.set(signature.connectorController, record);
  hostCarrierActorActivations.set(signature.hostCarrierActor, record);
  return handle;
}
