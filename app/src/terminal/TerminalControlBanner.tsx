import type { PtyControlStatus } from "../platform";

type Props = {
  status: PtyControlStatus;
  recoveryPending: boolean;
  actionError: string | null;
  onTakeover(): void;
  onRecover(): void;
};

export function TerminalControlBanner({
  status,
  recoveryPending,
  actionError,
  onTakeover,
  onRecover,
}: Props) {
  const detail = actionError || status.message;
  const summary = status.state === "DRAINING"
    ? `Waiting for ${status.ownerKind ?? "the current owner"} to finish local handoff…`
    : status.state === "RECOVERY_REQUIRED"
      ? "Read-only · terminal input continuity needs local recovery"
      : `Read-only · input owned by ${status.ownerKind ?? "another controller"}`;

  return (
    <div className="term-control-banner" role="status" data-terminal-control-state={status.state}>
      <span className="term-control-banner__copy">
        <span>{summary}</span>
        {detail && <span className="term-control-banner__message">{detail}</span>}
      </span>
      {status.canTakeOver && (
        <button type="button" onClick={onTakeover}>Take over locally</button>
      )}
      {status.canRecover && (
        <button type="button" disabled={recoveryPending} onClick={onRecover}>
          {recoveryPending ? "Recovering…" : "Recover local input"}
        </button>
      )}
    </div>
  );
}
