import { createHash, randomUUID } from "node:crypto";
import type {
  TerminalControlDrainProof,
  TerminalControlLease,
  TerminalControlOwner,
  TerminalControlOwnershipView,
  TerminalControlRecoveryProof,
  TerminalControlRequest,
} from "./protocol";
import {
  TERMINAL_CONTROL_DEFAULT_LEASE_TTL_MS,
  TERMINAL_CONTROL_MAX_OUTPUT_TAIL_BYTES,
  TerminalControlProtocolError,
} from "./protocol";
import { TmuxTerminalControlBackend, type TerminalControlBackend } from "./backend";
import {
  acquireTerminalControlStoreLock,
  leaseFromTarget,
  loadTerminalControlState,
  nextDecimal,
  releaseTerminalControlStoreLock,
  sameOwner,
  saveTerminalControlState,
  terminalControlStatePath,
  type TerminalControlOperationRecord,
  type TerminalControlRecoveryReason,
  type TerminalControlState,
  type TerminalControlTargetRecord,
} from "./store";

const MAX_COMPLETED_OPERATIONS = 128;

type AuthorityOptions = {
  statePath?: string;
  backend?: TerminalControlBackend;
  now?: () => Date;
};

function isoNow(now: () => Date): string {
  return now().toISOString();
}

function revision(target: TerminalControlTargetRecord): void {
  target.revision = nextDecimal(target.revision);
}

function ownershipView(
  state: TerminalControlState,
  target: TerminalControlTargetRecord,
  outputCursor = 0,
): TerminalControlOwnershipView {
  const base: TerminalControlOwnershipView = {
    controlTargetId: target.controlTargetId,
    controlEpoch: state.controlEpoch,
    state: target.lifecycle === "ACTIVE" ? target.ownership.state : target.lifecycle,
    fence: target.ownership.fence,
    outputGeneration: target.outputGeneration,
    outputCursor,
    revision: target.revision,
  };
  if (target.ownership.state !== "FREE") {
    base.ownerKind = target.ownership.owner.kind;
    base.leaseExpiresAt = target.ownership.leaseExpiresAt;
  } else if (target.recovery?.previousOwnerKind) {
    base.ownerKind = target.recovery.previousOwnerKind;
  }
  if (target.ownership.state === "DRAINING") {
    base.nextOwnerKind = target.ownership.handoff.nextOwner.kind;
    base.handoffId = target.ownership.handoff.handoffId;
  }
  return base;
}

function targetById(state: TerminalControlState, controlTargetId: string): TerminalControlTargetRecord {
  const target = state.targets.find((candidate) => candidate.controlTargetId === controlTargetId);
  if (!target) {
    throw new TerminalControlProtocolError("TARGET_NOT_FOUND", "control target is unknown");
  }
  return target;
}

function ensureOperable(target: TerminalControlTargetRecord): void {
  if (target.lifecycle === "TARGET_GONE") {
    throw new TerminalControlProtocolError("TARGET_GONE", "control target backend lifecycle has ended");
  }
  if (target.lifecycle === "RECOVERY_REQUIRED" || target.inFlight) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal-control continuity is uncertain; explicit local recovery is required",
    );
  }
}

function expiresAt(now: () => Date, ttlMs = TERMINAL_CONTROL_DEFAULT_LEASE_TTL_MS): string {
  return new Date(now().getTime() + ttlMs).toISOString();
}

function leaseExpired(target: TerminalControlTargetRecord, now: () => Date): boolean {
  if (target.ownership.state === "FREE") return false;
  return Date.parse(target.ownership.leaseExpiresAt) <= now().getTime();
}

function isAbandonableNonFeishuLease(target: TerminalControlTargetRecord): boolean {
  return target.lifecycle === "ACTIVE"
    && target.ownership.state === "HELD"
    && target.ownership.owner.kind !== "feishu"
    && target.inFlight === undefined;
}

function isAutoRecoverableNonFeishuState(target: TerminalControlTargetRecord): boolean {
  if (target.lifecycle !== "RECOVERY_REQUIRED" || target.inFlight || !target.recovery) return false;
  if (target.recovery.previousOwnerKind === "feishu" || target.recovery.operationId) return false;
  return !["OPERATION_IN_DOUBT", "DRAIN_UNCERTAIN"].includes(target.recovery.reason);
}

function appendOperation(
  target: TerminalControlTargetRecord,
  operation: TerminalControlOperationRecord,
): void {
  target.completedOperations.push(operation);
  if (target.completedOperations.length <= MAX_COMPLETED_OPERATIONS) return;
  const removable = target.completedOperations.findIndex((candidate) => candidate.disposition === "committed");
  if (removable >= 0) target.completedOperations.splice(removable, 1);
}

function completeInFlightAsInDoubt(
  target: TerminalControlTargetRecord,
  now: () => Date,
): string | undefined {
  const operation = target.inFlight;
  if (!operation) return undefined;
  appendOperation(target, {
    operationId: operation.operationId,
    ownerInstanceId: operation.ownerInstanceId,
    fence: operation.fence,
    payloadHash: operation.payloadHash,
    kind: operation.kind,
    disposition: "in-doubt",
    ...(operation.outputGeneration === undefined ? {} : { outputGeneration: operation.outputGeneration }),
    ...(operation.outputCursor === undefined ? {} : { outputCursor: operation.outputCursor }),
    completedAt: isoNow(now),
  });
  target.inFlight = undefined;
  return operation.operationId;
}

function markRecovery(
  state: TerminalControlState,
  target: TerminalControlTargetRecord,
  reason: TerminalControlRecoveryReason,
  now: () => Date,
  options: { previousControlEpoch?: string; operationId?: string } = {},
): void {
  const previousOwnerKind = target.ownership.state === "FREE"
    ? target.recovery?.previousOwnerKind
    : target.ownership.owner.kind;
  const inFlightOperationId = completeInFlightAsInDoubt(target, now);
  const operationId = options.operationId ?? inFlightOperationId;
  target.lifecycle = "RECOVERY_REQUIRED";
  target.ownership = {
    state: "FREE",
    fence: nextDecimal(target.ownership.fence),
  };
  target.recovery = {
    reason,
    since: isoNow(now),
    previousControlEpoch: options.previousControlEpoch ?? state.controlEpoch,
    ...(previousOwnerKind === undefined ? {} : { previousOwnerKind }),
    ...(operationId === undefined ? {} : { operationId }),
  };
  revision(target);
  target.updatedAt = isoNow(now);
}

function invalidateTarget(target: TerminalControlTargetRecord, now: () => Date): void {
  target.lifecycle = "TARGET_GONE";
  target.ownership = {
    state: "FREE",
    fence: nextDecimal(target.ownership.fence),
  };
  target.inFlight = undefined;
  target.recovery = undefined;
  revision(target);
  target.updatedAt = isoNow(now);
}

function validateLease(
  state: TerminalControlState,
  target: TerminalControlTargetRecord,
  lease: TerminalControlLease,
  options: { allowDraining?: boolean } = {},
): void {
  ensureOperable(target);
  if (lease.controlTargetId !== target.controlTargetId || lease.controlEpoch !== state.controlEpoch) {
    throw new TerminalControlProtocolError("PERMISSION_DENIED", "terminal input lease is fenced");
  }
  if (target.ownership.state === "FREE") {
    throw new TerminalControlProtocolError("PERMISSION_DENIED", "target has no current input owner");
  }
  if (target.ownership.state === "DRAINING" && !options.allowDraining) {
    throw new TerminalControlProtocolError("HANDOFF_PENDING", "target is draining for ownership handoff");
  }
  if (
    target.ownership.leaseId !== lease.leaseId
    || target.ownership.fence !== lease.fence
    || !sameOwner(target.ownership.owner, lease.owner)
  ) {
    throw new TerminalControlProtocolError("PERMISSION_DENIED", "terminal input lease is fenced");
  }
}

function payloadHash(kind: string, pane: string, payload: Buffer | string): string {
  return createHash("sha256")
    .update("tmux-worktree/terminal-control/operation/v1\0", "utf8")
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(pane, "utf8")
    .update("\0", "utf8")
    .update(payload)
    .digest("hex");
}

function existingOperation(
  target: TerminalControlTargetRecord,
  operationId: string,
  ownerInstanceId: string,
  fence: string,
  hash: string,
  kind: TerminalControlOperationRecord["kind"],
): TerminalControlOperationRecord | undefined {
  const existing = target.completedOperations.find((operation) => operation.operationId === operationId);
  if (!existing) return undefined;
  if (
    existing.ownerInstanceId !== ownerInstanceId
    || existing.fence !== fence
    || existing.payloadHash !== hash
    || existing.kind !== kind
  ) {
    throw new TerminalControlProtocolError(
      "INVALID_REQUEST",
      "operationId was reused with different ownership or payload",
    );
  }
  if (existing.disposition === "in-doubt") {
    throw new TerminalControlProtocolError(
      "OPERATION_IN_DOUBT",
      "operation was accepted previously but its backend disposition is uncertain",
    );
  }
  return existing;
}

function operationResult(
  state: TerminalControlState,
  target: TerminalControlTargetRecord,
  operation: TerminalControlOperationRecord,
  deduplicated: boolean,
): Record<string, unknown> {
  return {
    operationId: operation.operationId,
    accepted: true,
    deduplicated,
    controlEpoch: state.controlEpoch,
    fence: operation.fence,
    ...(operation.outputGeneration === undefined ? {} : { outputGeneration: operation.outputGeneration }),
    ...(operation.outputCursor === undefined ? {} : { outputCursor: operation.outputCursor }),
  };
}

export class TerminalControlAuthority {
  private readonly statePath: string;
  private readonly backend: TerminalControlBackend;
  private readonly now: () => Date;

  constructor(options: AuthorityOptions = {}) {
    this.statePath = options.statePath ?? terminalControlStatePath();
    this.backend = options.backend ?? new TmuxTerminalControlBackend();
    this.now = options.now ?? (() => new Date());
  }

  async initializeContinuity(): Promise<string> {
    return this.locked(async (state) => {
      const previousControlEpoch = state.controlEpoch;
      state.controlEpoch = randomUUID();
      for (const target of state.targets) {
        if (target.lifecycle === "TARGET_GONE") continue;
        // Never erase a persisted uncertainty record on another restart. In
        // particular, its operationId is what prevents an in-doubt write from
        // later being mistaken for an idle, safely abandonable local lease.
        if (target.lifecycle === "RECOVERY_REQUIRED") continue;
        if (target.inFlight) {
          markRecovery(state, target, "OPERATION_IN_DOUBT", this.now, {
            previousControlEpoch,
          });
        } else if (target.ownership.state === "DRAINING") {
          markRecovery(state, target, "DRAIN_UNCERTAIN", this.now, {
            previousControlEpoch,
          });
        } else if (target.ownership.state === "HELD") {
          markRecovery(state, target, "CONTROLLER_RESTARTED", this.now, {
            previousControlEpoch,
          });
        }
      }
      saveTerminalControlState(state, this.statePath);
      return state.controlEpoch;
    });
  }

  private async locked<T>(operation: (state: TerminalControlState) => Promise<T>): Promise<T> {
    const lock = await acquireTerminalControlStoreLock(`${this.statePath}.lock`);
    try {
      const state = loadTerminalControlState(this.statePath);
      return await operation(state);
    } finally {
      releaseTerminalControlStoreLock(lock);
    }
  }

  private async reconcileAbandonedOwnership(
    state: TerminalControlState,
    target: TerminalControlTargetRecord,
  ): Promise<boolean> {
    if (target.lifecycle === "ACTIVE" && leaseExpired(target, this.now)) {
      const abandonable = isAbandonableNonFeishuLease(target);
      markRecovery(
        state,
        target,
        target.ownership.state === "DRAINING" ? "DRAIN_UNCERTAIN" : "LEASE_EXPIRED",
        this.now,
      );
      saveTerminalControlState(state, this.statePath);
      if (!abandonable) return false;
    }
    if (!isAutoRecoverableNonFeishuState(target)) return false;

    try {
      await this.backend.assertCurrent(target.managedSession, target.backend.tmuxInstanceId);
    } catch (error) {
      if (
        error instanceof TerminalControlProtocolError
        && (error.code === "TARGET_GONE" || error.code === "TARGET_NOT_FOUND")
      ) {
        invalidateTarget(target, this.now);
        saveTerminalControlState(state, this.statePath);
        throw new TerminalControlProtocolError("TARGET_GONE", error.message);
      }
      markRecovery(state, target, "BACKEND_IDENTITY_UNCERTAIN", this.now);
      saveTerminalControlState(state, this.statePath);
      return false;
    }

    try {
      const output = await this.backend.resetOutput(
        target.controlTargetId,
        target.managedSession.name,
        "0",
        target.outputGeneration,
      );
      target.outputGeneration = output.generation;
    } catch {
      markRecovery(state, target, "OUTPUT_CONTINUITY_UNCERTAIN", this.now);
      saveTerminalControlState(state, this.statePath);
      return false;
    }
    target.lifecycle = "ACTIVE";
    target.recovery = undefined;
    target.ownership = {
      state: "FREE",
      // markRecovery already advanced this fence before recovery was entered.
      fence: target.ownership.fence,
    };
    revision(target);
    target.updatedAt = isoNow(this.now);
    saveTerminalControlState(state, this.statePath);
    return true;
  }

  private async assertTargetCurrent(
    state: TerminalControlState,
    target: TerminalControlTargetRecord,
  ): Promise<void> {
    await this.reconcileAbandonedOwnership(state, target);
    ensureOperable(target);
    try {
      await this.backend.assertCurrent(target.managedSession, target.backend.tmuxInstanceId);
    } catch (error) {
      if (
        error instanceof TerminalControlProtocolError
        && (error.code === "TARGET_GONE" || error.code === "TARGET_NOT_FOUND")
      ) {
        invalidateTarget(target, this.now);
        saveTerminalControlState(state, this.statePath);
        throw new TerminalControlProtocolError("TARGET_GONE", error.message);
      }
      markRecovery(state, target, "BACKEND_IDENTITY_UNCERTAIN", this.now);
      saveTerminalControlState(state, this.statePath);
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        `could not prove the exact terminal backend lifecycle: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async prepareOutput(
    state: TerminalControlState,
    target: TerminalControlTargetRecord,
  ): Promise<{ generation: string; cursor: number }> {
    try {
      const output = await this.backend.prepareOutput(
        target.controlTargetId,
        target.managedSession.name,
        "0",
        target.outputGeneration,
      );
      target.outputGeneration = output.generation;
      return output;
    } catch (error) {
      // Dashboard/Relay/local producers do not own a Feishu output turn. If
      // their otherwise idle capture disappeared, rotate the observation
      // generation and rebuild pane_pipe before treating the terminal as
      // unavailable. Feishu and every draining/in-flight state remain strict.
      if (
        target.lifecycle === "ACTIVE"
        && target.ownership.state === "HELD"
        && target.ownership.owner.kind !== "feishu"
        && !target.inFlight
      ) {
        try {
          await this.backend.assertCurrent(target.managedSession, target.backend.tmuxInstanceId);
          const repaired = await this.backend.resetOutput(
            target.controlTargetId,
            target.managedSession.name,
            "0",
            target.outputGeneration,
          );
          target.outputGeneration = repaired.generation;
          revision(target);
          target.updatedAt = isoNow(this.now);
          saveTerminalControlState(state, this.statePath);
          return repaired;
        } catch {
          // The normal recovery path below persists and fences this failure.
        }
      }
      markRecovery(state, target, "OUTPUT_CONTINUITY_UNCERTAIN", this.now);
      saveTerminalControlState(state, this.statePath);
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        `terminal output continuity is uncertain: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async resetOutput(
    state: TerminalControlState,
    target: TerminalControlTargetRecord,
  ): Promise<{ generation: string; cursor: number }> {
    try {
      const output = await this.backend.resetOutput(
        target.controlTargetId,
        target.managedSession.name,
        "0",
        target.outputGeneration,
      );
      target.outputGeneration = output.generation;
      return output;
    } catch (error) {
      markRecovery(state, target, "OUTPUT_CONTINUITY_UNCERTAIN", this.now);
      saveTerminalControlState(state, this.statePath);
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        `terminal output continuity is uncertain: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async handle(request: TerminalControlRequest): Promise<unknown> {
    if (request.type === "ping") {
      return { protocolVersion: 1, authority: "local-terminal-control" };
    }
    if (request.type === "target.resolve") return this.resolveTarget(request.sessionName);
    if (request.type === "ownership.status") return this.status(request.controlTargetId);
    if (request.type === "lease.acquire") return this.acquire(request.controlTargetId, request.owner, request.ttlMs);
    if (request.type === "lease.renew") return this.renew(request.lease, request.ttlMs);
    if (request.type === "lease.release") return this.release(request.lease);
    if (request.type === "handoff.begin") {
      return this.beginHandoff(request.controlTargetId, request.nextOwner, request.currentLease);
    }
    if (request.type === "handoff.commit") {
      return this.commitHandoff(
        request.handoffId,
        request.currentLease,
        request.drain,
        request.ttlMs,
      );
    }
    if (request.type === "handoff.cancel") {
      return this.cancelHandoff(request.handoffId, request.currentLease);
    }
    if (request.type === "handoff.withdraw") {
      return this.withdrawHandoff(
        request.controlTargetId,
        request.handoffId,
        request.nextOwner,
      );
    }
    if (request.type === "handoff.force") {
      return this.forceHandoff(
        request.controlTargetId,
        request.expectedControlEpoch,
        request.nextOwner,
        request.proof,
        request.acknowledgeUncertainOperation,
        request.ttlMs,
      );
    }
    if (request.type === "input.raw") {
      return this.executeInput(
        request.lease,
        request.operationId,
        request.pane,
        "raw",
        Buffer.from(request.dataBase64, "base64"),
      );
    }
    if (request.type === "input.agent-message") {
      const normalized = request.message.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      return this.executeInput(
        request.lease,
        request.operationId,
        request.pane,
        "agent-message",
        `${normalized}\0${request.submit ? "1" : "0"}`,
      );
    }
    if (request.type === "input.scroll") {
      return this.executeInput(
        request.lease,
        request.operationId,
        request.pane,
        "scroll",
        `${request.direction}:${request.lines}`,
      );
    }
    if (request.type === "lifecycle.kill") {
      return this.executeLifecycleKill(request.lease, request.operationId);
    }
    if (request.type === "output.tail") {
      return this.tailOutput(
        request.controlTargetId,
        request.controlEpoch,
        request.outputGeneration,
        request.cursor,
        request.maxBytes,
      );
    }
    return this.executeInput(
      request.lease,
      request.operationId,
      request.pane,
      "resize",
      `${request.cols}x${request.rows}`,
    );
  }

  private async resolveTarget(sessionName: string): Promise<unknown> {
    return this.locked(async (state) => {
      const resolved = await this.backend.resolveManagedSession(sessionName);
      let changed = false;
      for (const existing of state.targets) {
        if (
          existing.lifecycle !== "TARGET_GONE"
          && existing.managedSession.name === resolved.managedSession.name
          && (
            existing.managedSession.kind !== resolved.managedSession.kind
            || existing.managedSession.createdAt !== resolved.managedSession.createdAt
            || existing.backend.tmuxInstanceId !== resolved.tmuxInstanceId
          )
        ) {
          invalidateTarget(existing, this.now);
          changed = true;
        }
      }
      let target = state.targets.find((candidate) =>
        candidate.lifecycle !== "TARGET_GONE"
        && candidate.managedSession.name === resolved.managedSession.name
        && candidate.managedSession.kind === resolved.managedSession.kind
        && candidate.managedSession.createdAt === resolved.managedSession.createdAt
        && candidate.backend.tmuxInstanceId === resolved.tmuxInstanceId
      );
      if (!target) {
        target = {
          controlTargetId: randomUUID(),
          lifecycle: "ACTIVE",
          managedSession: {
            name: resolved.managedSession.name,
            kind: resolved.managedSession.kind,
            createdAt: resolved.managedSession.createdAt,
          },
          backend: { kind: "tmux", tmuxInstanceId: resolved.tmuxInstanceId },
          outputGeneration: randomUUID(),
          ownership: { state: "FREE", fence: "0" },
          revision: "1",
          completedOperations: [],
          updatedAt: isoNow(this.now),
        };
        state.targets.push(target);
        changed = true;
      }
      if (target.inFlight && target.lifecycle === "ACTIVE") {
        markRecovery(state, target, "OPERATION_IN_DOUBT", this.now);
        changed = true;
      }
      await this.reconcileAbandonedOwnership(state, target);
      const output = target.lifecycle === "ACTIVE"
        ? await this.prepareOutput(state, target)
        : { generation: target.outputGeneration, cursor: 0 };
      if (changed) saveTerminalControlState(state, this.statePath);
      return {
        controlTargetId: target.controlTargetId,
        controlEpoch: state.controlEpoch,
        managedSession: target.managedSession,
        ownership: ownershipView(state, target, output.cursor),
      };
    });
  }

  private async status(controlTargetId: string): Promise<TerminalControlOwnershipView> {
    return this.locked(async (state) => {
      const target = targetById(state, controlTargetId);
      let changed = false;
      if (target.inFlight && target.lifecycle === "ACTIVE") {
        markRecovery(state, target, "OPERATION_IN_DOUBT", this.now);
        changed = true;
      }
      await this.reconcileAbandonedOwnership(state, target);
      if (target.lifecycle === "ACTIVE") {
        await this.assertTargetCurrent(state, target);
      }
      const output = target.lifecycle === "ACTIVE"
        ? await this.prepareOutput(state, target)
        : { generation: target.outputGeneration, cursor: 0 };
      if (changed) saveTerminalControlState(state, this.statePath);
      return ownershipView(state, target, output.cursor);
    });
  }

  private async acquire(
    controlTargetId: string,
    owner: TerminalControlOwner,
    ttlMs = TERMINAL_CONTROL_DEFAULT_LEASE_TTL_MS,
  ): Promise<unknown> {
    return this.locked(async (state) => {
      const target = targetById(state, controlTargetId);
      await this.assertTargetCurrent(state, target);
      if (target.ownership.state === "FREE") {
        const output = await this.prepareOutput(state, target);
        target.ownership = {
          state: "HELD",
          fence: nextDecimal(target.ownership.fence),
          owner,
          leaseId: randomUUID(),
          leaseExpiresAt: expiresAt(this.now, ttlMs),
        };
        revision(target);
        target.updatedAt = isoNow(this.now);
        saveTerminalControlState(state, this.statePath);
        return { lease: leaseFromTarget(state, target), ownership: ownershipView(state, target, output.cursor) };
      }
      if (target.ownership.state === "HELD" && sameOwner(target.ownership.owner, owner)) {
        const output = await this.prepareOutput(state, target);
        return { lease: leaseFromTarget(state, target), ownership: ownershipView(state, target, output.cursor) };
      }
      if (target.ownership.state === "DRAINING" && sameOwner(target.ownership.handoff.nextOwner, owner)) {
        throw new TerminalControlProtocolError("HANDOFF_PENDING", "target is still draining its previous input owner");
      }
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        `terminal input is owned by ${target.ownership.owner.kind}`,
      );
    });
  }

  private async renew(
    lease: TerminalControlLease,
    ttlMs = TERMINAL_CONTROL_DEFAULT_LEASE_TTL_MS,
  ): Promise<unknown> {
    return this.locked(async (state) => {
      const target = targetById(state, lease.controlTargetId);
      await this.assertTargetCurrent(state, target);
      validateLease(state, target, lease, { allowDraining: true });
      if (target.ownership.state === "FREE") {
        throw new TerminalControlProtocolError("PERMISSION_DENIED", "target has no current input owner");
      }
      target.ownership.leaseExpiresAt = expiresAt(this.now, ttlMs);
      revision(target);
      target.updatedAt = isoNow(this.now);
      const output = await this.prepareOutput(state, target);
      saveTerminalControlState(state, this.statePath);
      return {
        lease: leaseFromTarget(state, target),
        ownership: ownershipView(state, target, output.cursor),
      };
    });
  }

  private async release(lease: TerminalControlLease): Promise<TerminalControlOwnershipView> {
    return this.locked(async (state) => {
      const target = targetById(state, lease.controlTargetId);
      await this.assertTargetCurrent(state, target);
      validateLease(state, target, lease, { allowDraining: true });
      if (target.ownership.state === "DRAINING") {
        throw new TerminalControlProtocolError(
          "HANDOFF_PENDING",
          "draining ownership must commit or cancel its handoff; it cannot pass through FREE",
        );
      }
      const output = await this.resetOutput(state, target);
      target.ownership = { state: "FREE", fence: nextDecimal(target.ownership.fence) };
      revision(target);
      target.updatedAt = isoNow(this.now);
      saveTerminalControlState(state, this.statePath);
      return ownershipView(state, target, output.cursor);
    });
  }

  private async beginHandoff(
    controlTargetId: string,
    nextOwner: TerminalControlOwner,
    currentLease?: TerminalControlLease,
  ): Promise<unknown> {
    return this.locked(async (state) => {
      const target = targetById(state, controlTargetId);
      await this.assertTargetCurrent(state, target);
      if (target.ownership.state === "FREE") {
        const output = await this.prepareOutput(state, target);
        target.ownership = {
          state: "HELD",
          fence: nextDecimal(target.ownership.fence),
          owner: nextOwner,
          leaseId: randomUUID(),
          leaseExpiresAt: expiresAt(this.now),
        };
        revision(target);
        target.updatedAt = isoNow(this.now);
        saveTerminalControlState(state, this.statePath);
        return { lease: leaseFromTarget(state, target), ownership: ownershipView(state, target, output.cursor) };
      }
      if (target.ownership.state === "DRAINING") {
        if (sameOwner(target.ownership.handoff.nextOwner, nextOwner)) {
          const output = await this.prepareOutput(state, target);
          return { ownership: ownershipView(state, target, output.cursor) };
        }
        throw new TerminalControlProtocolError("HANDOFF_PENDING", "another ownership handoff is already draining");
      }
      if (currentLease) {
        validateLease(state, target, currentLease);
      } else if (
        target.ownership.owner.kind !== "feishu"
        || (nextOwner.kind !== "dashboard" && nextOwner.kind !== "local-cli")
      ) {
        throw new TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "only a controlled local owner may request a lease-less graceful takeover from Feishu",
        );
      }
      if (sameOwner(target.ownership.owner, nextOwner)) {
        const output = await this.prepareOutput(state, target);
        return { lease: leaseFromTarget(state, target), ownership: ownershipView(state, target, output.cursor) };
      }
      target.ownership = {
        state: "DRAINING",
        fence: target.ownership.fence,
        owner: target.ownership.owner,
        leaseId: target.ownership.leaseId,
        leaseExpiresAt: target.ownership.leaseExpiresAt,
        handoff: {
          handoffId: randomUUID(),
          nextOwner,
          requestedAt: isoNow(this.now),
        },
      };
      revision(target);
      target.updatedAt = isoNow(this.now);
      const output = await this.prepareOutput(state, target);
      saveTerminalControlState(state, this.statePath);
      return { ownership: ownershipView(state, target, output.cursor) };
    });
  }

  private async commitHandoff(
    handoffId: string,
    currentLease: TerminalControlLease,
    drain: TerminalControlDrainProof,
    ttlMs = TERMINAL_CONTROL_DEFAULT_LEASE_TTL_MS,
  ): Promise<unknown> {
    return this.locked(async (state) => {
      const target = targetById(state, currentLease.controlTargetId);
      await this.assertTargetCurrent(state, target);
      validateLease(state, target, currentLease, { allowDraining: true });
      if (target.ownership.state !== "DRAINING" || target.ownership.handoff.handoffId !== handoffId) {
        throw new TerminalControlProtocolError("INVALID_REQUEST", "handoff is not current");
      }
      target.ownership.handoff.drain = drain;
      if (drain.disposition === "uncertain") {
        markRecovery(state, target, "DRAIN_UNCERTAIN", this.now);
        saveTerminalControlState(state, this.statePath);
        throw new TerminalControlProtocolError(
          "RECOVERY_REQUIRED",
          "handoff drain disposition is uncertain; ownership was not transferred",
        );
      }
      const nextOwner = target.ownership.handoff.nextOwner;
      const output = await this.resetOutput(state, target);
      target.ownership = {
        state: "HELD",
        fence: nextDecimal(target.ownership.fence),
        owner: nextOwner,
        leaseId: randomUUID(),
        leaseExpiresAt: expiresAt(this.now, ttlMs),
      };
      target.recovery = undefined;
      revision(target);
      target.updatedAt = isoNow(this.now);
      saveTerminalControlState(state, this.statePath);
      return { lease: leaseFromTarget(state, target), ownership: ownershipView(state, target, output.cursor) };
    });
  }

  private async cancelHandoff(
    handoffId: string,
    currentLease: TerminalControlLease,
  ): Promise<TerminalControlOwnershipView> {
    return this.locked(async (state) => {
      const target = targetById(state, currentLease.controlTargetId);
      await this.assertTargetCurrent(state, target);
      validateLease(state, target, currentLease, { allowDraining: true });
      if (target.ownership.state !== "DRAINING" || target.ownership.handoff.handoffId !== handoffId) {
        throw new TerminalControlProtocolError("INVALID_REQUEST", "handoff is not current");
      }
      target.ownership = {
        state: "HELD",
        fence: target.ownership.fence,
        owner: target.ownership.owner,
        leaseId: target.ownership.leaseId,
        leaseExpiresAt: target.ownership.leaseExpiresAt,
      };
      revision(target);
      target.updatedAt = isoNow(this.now);
      const output = await this.prepareOutput(state, target);
      saveTerminalControlState(state, this.statePath);
      return ownershipView(state, target, output.cursor);
    });
  }

  private async withdrawHandoff(
    controlTargetId: string,
    handoffId: string,
    nextOwner: TerminalControlOwner,
  ): Promise<TerminalControlOwnershipView> {
    return this.locked(async (state) => {
      const target = targetById(state, controlTargetId);
      await this.assertTargetCurrent(state, target);
      if (
        target.ownership.state !== "DRAINING"
        || target.ownership.handoff.handoffId !== handoffId
        || !sameOwner(target.ownership.handoff.nextOwner, nextOwner)
      ) {
        throw new TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "only the exact pending next owner may withdraw this handoff",
        );
      }
      target.ownership = {
        state: "HELD",
        fence: target.ownership.fence,
        owner: target.ownership.owner,
        leaseId: target.ownership.leaseId,
        leaseExpiresAt: target.ownership.leaseExpiresAt,
      };
      revision(target);
      target.updatedAt = isoNow(this.now);
      const output = await this.prepareOutput(state, target);
      saveTerminalControlState(state, this.statePath);
      return ownershipView(state, target, output.cursor);
    });
  }

  private async forceHandoff(
    controlTargetId: string,
    expectedControlEpoch: string,
    nextOwner: TerminalControlOwner,
    proof: TerminalControlRecoveryProof,
    acknowledgeUncertainOperation: boolean,
    ttlMs = TERMINAL_CONTROL_DEFAULT_LEASE_TTL_MS,
  ): Promise<unknown> {
    if (
      (nextOwner.kind !== "dashboard" && nextOwner.kind !== "local-cli")
      || !acknowledgeUncertainOperation
    ) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "force takeover requires a controlled local owner and persisted external cancellation proof",
      );
    }
    return this.locked(async (state) => {
      const target = targetById(state, controlTargetId);
      if (state.controlEpoch !== expectedControlEpoch) {
        throw new TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "force takeover was prepared for a stale controller epoch",
        );
      }
      if (target.lifecycle === "TARGET_GONE") {
        throw new TerminalControlProtocolError("TARGET_GONE", "control target backend lifecycle has ended");
      }
      const previousOwnerKind = target.ownership.state === "FREE"
        ? target.recovery?.previousOwnerKind
        : target.ownership.owner.kind;
      if (previousOwnerKind === "feishu" && proof.kind === "owner-unreachable") {
        throw new TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "force takeover from Feishu requires a persisted turn cancellation or explicit in-doubt acknowledgement",
        );
      }
      if (target.lifecycle === "ACTIVE" && leaseExpired(target, this.now)) {
        markRecovery(state, target, "LEASE_EXPIRED", this.now);
      }
      if (target.lifecycle === "RECOVERY_REQUIRED" || target.inFlight) {
        try {
          await this.backend.assertCurrent(target.managedSession, target.backend.tmuxInstanceId);
        } catch (error) {
          if (
            error instanceof TerminalControlProtocolError
            && (error.code === "TARGET_GONE" || error.code === "TARGET_NOT_FOUND")
          ) {
            invalidateTarget(target, this.now);
            saveTerminalControlState(state, this.statePath);
            throw new TerminalControlProtocolError(
              "TARGET_GONE",
              error.message,
            );
          }
          if (target.lifecycle !== "RECOVERY_REQUIRED") {
            markRecovery(state, target, "BACKEND_IDENTITY_UNCERTAIN", this.now);
          }
          saveTerminalControlState(state, this.statePath);
          throw new TerminalControlProtocolError(
            "RECOVERY_REQUIRED",
            `force recovery could not prove the exact terminal backend lifecycle: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // The explicit acknowledgement accepts that the persisted in-flight
        // operation may have taken effect. Advancing the fence is the recovery
        // boundary; the old operation is never replayed by this authority.
        completeInFlightAsInDoubt(target, this.now);
      } else {
        await this.assertTargetCurrent(state, target);
      }
      const output = await this.resetOutput(state, target);
      target.lifecycle = "ACTIVE";
      target.recovery = undefined;
      target.ownership = {
        state: "HELD",
        fence: nextDecimal(target.ownership.fence),
        owner: nextOwner,
        leaseId: randomUUID(),
        leaseExpiresAt: expiresAt(this.now, ttlMs),
      };
      revision(target);
      target.updatedAt = isoNow(this.now);
      saveTerminalControlState(state, this.statePath);
      return { lease: leaseFromTarget(state, target), ownership: ownershipView(state, target, output.cursor) };
    });
  }

  private async executeInput(
    lease: TerminalControlLease,
    operationId: string,
    pane: string,
    kind: TerminalControlOperationRecord["kind"],
    payload: Buffer | string,
  ): Promise<unknown> {
    return this.locked(async (state) => {
      const target = targetById(state, lease.controlTargetId);
      const hasFencedRawPath = kind === "raw"
        && this.backend.rawInputPosition !== undefined
        && this.backend.writeRawFenced !== undefined;
      if (hasFencedRawPath) {
        await this.reconcileAbandonedOwnership(state, target);
      } else {
        await this.assertTargetCurrent(state, target);
      }
      validateLease(state, target, lease);
      const hash = payloadHash(kind, pane, payload);
      const completed = existingOperation(
        target,
        operationId,
        lease.owner.instanceId,
        lease.fence,
        hash,
        kind,
      );
      if (completed) {
        if (hasFencedRawPath) await this.assertTargetCurrent(state, target);
        return operationResult(state, target, completed, true);
      }
      let output: { generation: string; cursor: number };
      if (hasFencedRawPath) {
        try {
          output = await this.backend.rawInputPosition!(
            target.controlTargetId,
            target.outputGeneration,
          );
        } catch (error) {
          if (lease.owner.kind !== "feishu" && target.ownership.state === "HELD" && !target.inFlight) {
            try {
              await this.backend.assertCurrent(target.managedSession, target.backend.tmuxInstanceId);
              output = await this.backend.resetOutput(
                target.controlTargetId,
                target.managedSession.name,
                "0",
                target.outputGeneration,
              );
              target.outputGeneration = output.generation;
              revision(target);
              target.updatedAt = isoNow(this.now);
              saveTerminalControlState(state, this.statePath);
            } catch {
              markRecovery(state, target, "OUTPUT_CONTINUITY_UNCERTAIN", this.now);
              saveTerminalControlState(state, this.statePath);
              throw new TerminalControlProtocolError(
                "RECOVERY_REQUIRED",
                `terminal output continuity is uncertain: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          } else {
            markRecovery(state, target, "OUTPUT_CONTINUITY_UNCERTAIN", this.now);
            saveTerminalControlState(state, this.statePath);
            throw new TerminalControlProtocolError(
              "RECOVERY_REQUIRED",
              `terminal output continuity is uncertain: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } else {
        output = await this.prepareOutput(state, target);
      }
      target.inFlight = {
        operationId,
        ownerInstanceId: lease.owner.instanceId,
        fence: lease.fence,
        payloadHash: hash,
        kind,
        outputGeneration: output.generation,
        outputCursor: output.cursor,
        startedAt: isoNow(this.now),
      };
      revision(target);
      target.updatedAt = isoNow(this.now);
      saveTerminalControlState(state, this.statePath);
      try {
        const sessionName = target.managedSession.name;
        if (kind === "raw") {
          if (hasFencedRawPath) {
            await this.backend.writeRawFenced!(
              target.managedSession,
              target.backend.tmuxInstanceId,
              output.generation,
              pane,
              payload as Buffer,
            );
          } else {
            await this.backend.writeRaw(sessionName, pane, payload as Buffer);
          }
        } else if (kind === "agent-message") {
          const separator = (payload as string).lastIndexOf("\0");
          await this.backend.sendAgentMessage(
            sessionName,
            pane,
            (payload as string).slice(0, separator),
            (payload as string).slice(separator + 1) === "1",
          );
        } else if (kind === "scroll") {
          const match = /^(up|down):(\d+)$/.exec(payload as string);
          if (!match) throw new Error("invalid normalized scroll payload");
          await this.backend.scroll(
            sessionName,
            pane,
            match[1] as "up" | "down",
            Number(match[2]),
          );
        } else {
          const match = /^(\d+)x(\d+)$/.exec(payload as string);
          if (!match) throw new Error("invalid normalized resize payload");
          await this.backend.resize(sessionName, pane, Number(match[1]), Number(match[2]));
        }
      } catch (error) {
        if (
          hasFencedRawPath
          && error instanceof TerminalControlProtocolError
          && ["TARGET_GONE", "TARGET_NOT_FOUND", "RECOVERY_REQUIRED"].includes(error.code)
        ) {
          // writeRawFenced only returns these errors from pre-write checks or
          // the false branch of tmux if-shell, which proves paste-buffer did
          // not run. Clear the durable in-flight marker without classifying
          // the raw bytes themselves as ambiguous.
          target.inFlight = undefined;
          if (error.code === "TARGET_GONE" || error.code === "TARGET_NOT_FOUND") {
            invalidateTarget(target, this.now);
            saveTerminalControlState(state, this.statePath);
            throw new TerminalControlProtocolError("TARGET_GONE", error.message);
          }
          markRecovery(state, target, "BACKEND_IDENTITY_UNCERTAIN", this.now);
          saveTerminalControlState(state, this.statePath);
          throw new TerminalControlProtocolError("RECOVERY_REQUIRED", error.message);
        }
        markRecovery(state, target, "OPERATION_IN_DOUBT", this.now, { operationId });
        try { saveTerminalControlState(state, this.statePath); } catch {}
        throw new TerminalControlProtocolError(
          "OPERATION_IN_DOUBT",
          `terminal backend write did not reach a provable boundary: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const record: TerminalControlOperationRecord = {
        operationId,
        ownerInstanceId: lease.owner.instanceId,
        fence: lease.fence,
        payloadHash: hash,
        kind,
        disposition: "committed",
        outputGeneration: output.generation,
        outputCursor: output.cursor,
        completedAt: isoNow(this.now),
      };
      appendOperation(target, record);
      target.inFlight = undefined;
      revision(target);
      target.updatedAt = isoNow(this.now);
      saveTerminalControlState(state, this.statePath);
      return operationResult(state, target, record, false);
    });
  }

  private async tailOutput(
    controlTargetId: string,
    controlEpoch: string,
    outputGeneration: string,
    cursor: number,
    maxBytes = TERMINAL_CONTROL_MAX_OUTPUT_TAIL_BYTES,
  ): Promise<unknown> {
    return this.locked(async (state) => {
      const target = targetById(state, controlTargetId);
      if (controlEpoch !== state.controlEpoch || outputGeneration !== target.outputGeneration) {
        throw new TerminalControlProtocolError(
          "STALE_OUTPUT_CURSOR",
          "terminal output cursor was fenced by an ownership or controller generation change",
        );
      }
      await this.assertTargetCurrent(state, target);
      let chunk;
      try {
        chunk = await this.backend.tailOutput(
          target.controlTargetId,
          target.managedSession.name,
          "0",
          outputGeneration,
          cursor,
          maxBytes,
        );
      } catch (error) {
        if (error instanceof TerminalControlProtocolError && error.code === "STALE_OUTPUT_CURSOR") {
          throw error;
        }
        markRecovery(state, target, "OUTPUT_CONTINUITY_UNCERTAIN", this.now);
        saveTerminalControlState(state, this.statePath);
        throw new TerminalControlProtocolError(
          "RECOVERY_REQUIRED",
          `terminal output continuity is uncertain: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        controlTargetId: target.controlTargetId,
        controlEpoch: state.controlEpoch,
        fence: target.ownership.fence,
        ownerKind: target.ownership.state === "FREE" ? undefined : target.ownership.owner.kind,
        outputGeneration: chunk.generation,
        cursor: chunk.cursor,
        dataBase64: chunk.dataBase64,
        nextCursor: chunk.nextCursor,
      };
    });
  }

  private async executeLifecycleKill(
    lease: TerminalControlLease,
    operationId: string,
  ): Promise<unknown> {
    return this.locked(async (state) => {
      const target = targetById(state, lease.controlTargetId);
      const hash = payloadHash("lifecycle-kill", "0", target.managedSession.name);
      const completed = existingOperation(
        target,
        operationId,
        lease.owner.instanceId,
        lease.fence,
        hash,
        "lifecycle-kill",
      );
      if (completed) return operationResult(state, target, completed, true);
      await this.assertTargetCurrent(state, target);
      validateLease(state, target, lease);
      const output = await this.prepareOutput(state, target);
      target.inFlight = {
        operationId,
        ownerInstanceId: lease.owner.instanceId,
        fence: lease.fence,
        payloadHash: hash,
        kind: "lifecycle-kill",
        outputGeneration: output.generation,
        outputCursor: output.cursor,
        startedAt: isoNow(this.now),
      };
      revision(target);
      target.updatedAt = isoNow(this.now);
      saveTerminalControlState(state, this.statePath);
      try {
        await this.backend.killManaged(target.managedSession.name);
      } catch (error) {
        try {
          await this.backend.assertCurrent(target.managedSession, target.backend.tmuxInstanceId);
          target.inFlight = undefined;
          revision(target);
          target.updatedAt = isoNow(this.now);
          saveTerminalControlState(state, this.statePath);
          throw error;
        } catch (proofError) {
          if (proofError === error) throw error;
          markRecovery(state, target, "OPERATION_IN_DOUBT", this.now, { operationId });
          try { saveTerminalControlState(state, this.statePath); } catch {}
          throw new TerminalControlProtocolError(
            "OPERATION_IN_DOUBT",
            "managed target closure did not reach a provable boundary",
          );
        }
      }
      const record: TerminalControlOperationRecord = {
        operationId,
        ownerInstanceId: lease.owner.instanceId,
        fence: lease.fence,
        payloadHash: hash,
        kind: "lifecycle-kill",
        disposition: "committed",
        outputGeneration: output.generation,
        outputCursor: output.cursor,
        completedAt: isoNow(this.now),
      };
      appendOperation(target, record);
      target.inFlight = undefined;
      invalidateTarget(target, this.now);
      saveTerminalControlState(state, this.statePath);
      return operationResult(state, target, record, false);
    });
  }
}
