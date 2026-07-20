import type { PlainTerminal, Session } from "../../platform";

/** Get the display name for a session (raw tmux name, not composite key). */
export function sessionDisplayName(session: Session): string {
  return session.rawName ?? session.name;
}

export function terminalRawName(terminal: PlainTerminal): string {
  if (terminal.rawName) return terminal.rawName;
  if (terminal.hostId && terminal.tmuxName.startsWith(`${terminal.hostId}:`)) {
    return terminal.tmuxName.slice(terminal.hostId.length + 1);
  }
  return terminal.tmuxName;
}

export function terminalSessionKey(terminal: PlainTerminal): string {
  return terminal.hostId
    ? `${terminal.hostId}:${terminalRawName(terminal)}`
    : terminalRawName(terminal);
}

export function orderTerminalsBySessionKey(
  terminals: readonly PlainTerminal[],
  order: readonly string[],
): PlainTerminal[] {
  const orderMap = new Map<string, number>();
  for (const key of order) {
    if (!orderMap.has(key)) orderMap.set(key, orderMap.size);
  }
  return [...terminals].sort((left, right) =>
    (orderMap.get(terminalSessionKey(left)) ?? Number.POSITIVE_INFINITY) -
    (orderMap.get(terminalSessionKey(right)) ?? Number.POSITIVE_INFINITY),
  );
}

export function isInternalTerminalName(value: string | null | undefined): boolean {
  return !!value && value.startsWith("tw-term-");
}

export function basenameFromPath(value: string | null | undefined): string {
  const parts = (value ?? "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export function normalizePlainTerminal(terminal: PlainTerminal): PlainTerminal {
  const hostId = terminal.hostId === "local" ? null : terminal.hostId ?? null;
  const rawName = terminal.rawName || terminalRawName({ ...terminal, hostId });
  const fallbackLabel = basenameFromPath(terminal.cwd) || "terminal";
  const label = !terminal.label || isInternalTerminalName(terminal.label)
    ? fallbackLabel
    : terminal.label;
  return { ...terminal, hostId, rawName, label };
}

export function isLocalDiscoveredInternalTerminal(terminal: PlainTerminal): boolean {
  if (terminal.hostId) return false;
  if (terminal.managed) return false;
  return isInternalTerminalName(terminal.rawName) || isInternalTerminalName(terminal.tmuxName);
}
