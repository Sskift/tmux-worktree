import type { RelayV2JsonObject } from "./codecSchema.js";

/**
 * Shared field accessors for Relay v2 host JSON frames. Pure casts over a
 * validated RelayV2JsonObject; no module-level state.
 */

export function stringField(frame: RelayV2JsonObject, name: string): string {
  return frame[name] as string;
}

export function objectField(frame: RelayV2JsonObject, name: string): RelayV2JsonObject {
  return frame[name] as RelayV2JsonObject;
}
