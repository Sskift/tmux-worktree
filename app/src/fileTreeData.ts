import type { DirEntry } from "./platform/domainTypes";

export type FileTreeDirectoryReader = {
  readDirectory(path: string): Promise<DirEntry[]>;
  readRemoteDirectory(hostId: string, path: string): Promise<DirEntry[]>;
};

export type FileTreeRequestToken = Readonly<{
  sourceKey: string;
  path: string;
  sequence: number;
}>;

export type FileTreeRequestGate = {
  switchSource(sourceKey: string): boolean;
  issue(path: string): FileTreeRequestToken;
  isCurrent(token: FileTreeRequestToken): boolean;
};

export function fileTreeSourceKey(root: string, hostId?: string | null): string {
  return JSON.stringify([hostId ?? null, root]);
}

export function readFileTreeDirectory(
  reader: FileTreeDirectoryReader,
  hostId: string | null | undefined,
  path: string,
): Promise<DirEntry[]> {
  return hostId == null
    ? reader.readDirectory(path)
    : reader.readRemoteDirectory(hostId, path);
}

export function createFileTreeRequestGate(initialSourceKey: string): FileTreeRequestGate {
  let sourceKey = initialSourceKey;
  let nextSequence = 0;
  const latestByPath = new Map<string, number>();

  return {
    switchSource(nextSourceKey) {
      if (nextSourceKey === sourceKey) return false;
      sourceKey = nextSourceKey;
      latestByPath.clear();
      return true;
    },

    issue(path) {
      const sequence = ++nextSequence;
      latestByPath.set(path, sequence);
      return { sourceKey, path, sequence };
    },

    isCurrent(token) {
      return (
        token.sourceKey === sourceKey &&
        latestByPath.get(token.path) === token.sequence
      );
    },
  };
}

export function fileTreeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Unable to load this folder";
}
