import type { RelayV2MaterializedStateRuntimeH2Port } from "./resourceState.js";
import type {
  RelayV2RecoveredHostH2SnapshotSpoolPort,
} from "./stateSnapshotSpool.js";

export type RelayV2HostH2ReadinessSnapshotSpool = RelayV2RecoveredHostH2SnapshotSpoolPort;

export interface RelayV2HostH2ReadinessLifecycle {
  close(): void;
}

/**
 * Internal result delivered only through the issuer-bound host-composition
 * invocation. There is deliberately no standalone H2 activation factory.
 */
export interface RelayV2HostH2ReadinessActivation {
  readonly runtimeH2: RelayV2MaterializedStateRuntimeH2Port;
  readonly snapshotSpool: RelayV2HostH2ReadinessSnapshotSpool;
  readonly lifecycle: RelayV2HostH2ReadinessLifecycle;
  cancelConstruction(): void;
  dispose(): void;
}
