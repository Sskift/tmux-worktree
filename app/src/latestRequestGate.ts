export type LatestRequestToken = Readonly<{
  sourceKey: string;
  sequence: number;
}>;

export type LatestRequestGate = {
  issue(sourceKey: string): LatestRequestToken;
  isCurrent(token: LatestRequestToken): boolean;
  cancel(token: LatestRequestToken): void;
  invalidate(): void;
};

/**
 * Identifies an async request by every piece of state that determines its
 * destination. JSON encoding avoids delimiter collisions in paths and host IDs.
 */
export function requestSourceKey(
  ...parts: ReadonlyArray<string | number | boolean | null | undefined>
): string {
  return JSON.stringify(parts.map((part) => part ?? null));
}

/**
 * Allows only the most recently issued request to publish its result. The
 * caller still owns transport cancellation; this gate protects React state
 * when an older, non-cancellable backend request finishes late.
 */
export function createLatestRequestGate(): LatestRequestGate {
  let currentSourceKey = "";
  let currentSequence = 0;
  let nextSequence = 0;

  return {
    issue(sourceKey) {
      const sequence = ++nextSequence;
      currentSourceKey = sourceKey;
      currentSequence = sequence;
      return { sourceKey, sequence };
    },

    isCurrent(token) {
      return (
        token.sourceKey === currentSourceKey &&
        token.sequence === currentSequence
      );
    },

    cancel(token) {
      if (
        token.sourceKey === currentSourceKey &&
        token.sequence === currentSequence
      ) {
        currentSequence = ++nextSequence;
      }
    },

    invalidate() {
      currentSequence = ++nextSequence;
    },
  };
}
