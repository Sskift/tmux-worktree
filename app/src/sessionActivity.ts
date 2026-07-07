export type SessionActivityState = "running" | "stopped" | "unknown";

export type PreviousSessionActivity = {
  outputSignature: string | null;
  lastChangedAt: number | null;
};

export type SessionActivityInfo = {
  state: SessionActivityState;
  label: string;
  ageSeconds: number | null;
  changed: boolean;
  outputSignature: string | null;
  lastChangedAt: number | null;
};

type SessionLike = {
  name: string;
  outputSignature?: string | null;
  agentRunning?: boolean | null;
};

export function formatActivityAge(ageSeconds: number): string {
  const seconds = Math.max(0, Math.floor(ageSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

export function describeSessionActivity(
  session: SessionLike,
  previousActivity: PreviousSessionActivity | null | undefined,
  nowSeconds = Date.now() / 1000,
): SessionActivityInfo {
  const outputSignature = session.outputSignature ?? null;
  const previousLastChangedAt = previousActivity?.lastChangedAt ?? null;
  const outputChanged =
    !!outputSignature &&
    !!previousActivity?.outputSignature &&
    outputSignature !== previousActivity.outputSignature;

  if (session.agentRunning === true) {
    return {
      state: "running",
      label: "running",
      ageSeconds: 0,
      changed: outputChanged,
      outputSignature,
      lastChangedAt: nowSeconds,
    };
  }

  if (session.agentRunning === false) {
    const ageSeconds =
      previousLastChangedAt == null
        ? null
        : Math.max(0, Math.floor(nowSeconds - previousLastChangedAt));
    return {
      state: "stopped",
      label: ageSeconds == null ? "stopped" : formatActivityAge(ageSeconds),
      ageSeconds,
      changed: outputChanged,
      outputSignature,
      lastChangedAt: previousLastChangedAt,
    };
  }

  if (!outputSignature) {
    return {
      state: "unknown",
      label: "--",
      ageSeconds: null,
      changed: false,
      outputSignature: null,
      lastChangedAt: previousLastChangedAt,
    };
  }

  if (!previousActivity?.outputSignature) {
    return {
      state: "unknown",
      label: "--",
      ageSeconds: null,
      changed: false,
      outputSignature,
      lastChangedAt: previousLastChangedAt,
    };
  }

  const lastChangedAt = outputChanged ? nowSeconds : previousLastChangedAt;
  if (outputChanged) {
    return {
      state: "running",
      label: "running",
      ageSeconds: 0,
      changed: true,
      outputSignature,
      lastChangedAt,
    };
  }

  const ageSeconds =
    lastChangedAt == null ? null : Math.max(0, Math.floor(nowSeconds - lastChangedAt));

  return {
    state: "stopped",
    label: ageSeconds == null ? "stopped" : formatActivityAge(ageSeconds),
    ageSeconds,
    changed: false,
    outputSignature,
    lastChangedAt,
  };
}
