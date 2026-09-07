import type {
  RelayV2TerminalCanonicalTargetBindingV1,
  RelayV2TerminalDurableOpenOutcome,
} from "./terminalManager.js";

/**
 * Deep-copies the nested mutable slices of a canonical target binding so the
 * caller can freeze or persist them without sharing structure with the
 * resolution that produced them. Shared by the terminal manager (live state)
 * and the durable lineage store (persisted state).
 */
export function cloneCanonicalBinding(
  value: RelayV2TerminalCanonicalTargetBindingV1,
): RelayV2TerminalCanonicalTargetBindingV1 {
  return {
    ...value,
    processTarget: { ...value.processTarget },
    managedTarget: { ...value.managedTarget },
    exactControlIdentity: { ...value.exactControlIdentity },
  };
}

/**
 * Compares two durable open outcomes field-by-field. A recovered outcome must
 * match the in-memory one exactly, so the manager and the lineage store share
 * this comparator instead of maintaining parallel copies.
 */
export function sameDurableOpenOutcome(
  left: RelayV2TerminalDurableOpenOutcome,
  right: RelayV2TerminalDurableOpenOutcome,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "opened" && right.kind === "opened") {
    return left.generation === right.generation
      && left.resumeTokenHash === right.resumeTokenHash
      && left.disposition === right.disposition
      && left.replayFromOffset === right.replayFromOffset;
  }
  if (left.kind === "reset" && right.kind === "reset") {
    return left.generation === right.generation
      && left.reason === right.reason
      && left.requestedOffset === right.requestedOffset
      && left.bufferStartOffset === right.bufferStartOffset
      && left.tailOffset === right.tailOffset;
  }
  return left.kind === "error"
    && right.kind === "error"
    && left.code === right.code
    && left.message === right.message;
}
