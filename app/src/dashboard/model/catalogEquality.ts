import type { PlainTerminal, Session } from "../../platform";
import type { SessionActivityInfo } from "./sessionActivity";

export function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function sameStringRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key]);
}

export function sameSessions(a: Session[], b: Session[]): boolean {
  return a.length === b.length && a.every((left, index) => {
    const right = b[index];
    return (
      left.name === right.name &&
      left.attached === right.attached &&
      left.window_count === right.window_count &&
      left.created === right.created &&
      left.activity === right.activity &&
      (left.output_signature ?? null) === (right.output_signature ?? null) &&
      (left.agent_running ?? null) === (right.agent_running ?? null) &&
      (left.hostId ?? null) === (right.hostId ?? null) &&
      (left.rawName ?? "") === (right.rawName ?? "") &&
      (left.project ?? "") === (right.project ?? "") &&
      (left.managed ?? false) === (right.managed ?? false)
    );
  });
}

export function samePlainTerminals(a: PlainTerminal[], b: PlainTerminal[]): boolean {
  return a.length === b.length && a.every((left, index) => {
    const right = b[index];
    return (
      left.id === right.id &&
      left.label === right.label &&
      left.cwd === right.cwd &&
      left.tmuxName === right.tmuxName &&
      (left.hostId ?? null) === (right.hostId ?? null) &&
      (left.rawName ?? "") === (right.rawName ?? "") &&
      (left.aiCmd ?? "") === (right.aiCmd ?? "") &&
      (left.discovered ?? false) === (right.discovered ?? false) &&
      (left.managed ?? false) === (right.managed ?? false)
    );
  });
}

export function sameSessionActivity(
  a: Record<string, SessionActivityInfo>,
  b: Record<string, SessionActivityInfo>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => {
    const left = a[key];
    const right = b[key];
    return !!right &&
      left.state === right.state &&
      left.label === right.label &&
      left.changed === right.changed &&
      left.ageSeconds === right.ageSeconds &&
      left.lastChangedAt === right.lastChangedAt &&
      (left.outputSignature ?? null) === (right.outputSignature ?? null);
  });
}
