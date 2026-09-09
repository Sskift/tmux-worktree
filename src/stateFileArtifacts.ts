import { readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Quarantine backups are forensic evidence for a torn/corrupt state file;
// keep them for a week before unlinking so they can be hand-inspected,
// but do not let them accumulate forever.
const CORRUPT_SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

// A pre-rename atomic-write temp file that outlives an hour cannot
// belong to a live writer — an atomic write completes in milliseconds —
// so it is a kill/crash orphan and safe to unlink. Mirrors the Rust
// side `sweep_state_file_artifacts` (app/src-tauri/src/support/
// atomic_file.rs), which uses the same two windows and name patterns.
const TMP_SWEEP_MAX_AGE_MS = 60 * 60 * 1_000;

/// Delete quarantine backups and atomic-write temp files orphaned next to
/// `path` by crashed processes on either side (Node CLI/relay or Rust
/// Dashboard). Only scans the state file's own directory (never
/// recursive) and only these name patterns:
/// - `<basename>.corrupt-*` quarantine backups (both sides),
/// - `<basename>.*.tmp` Node `<pid>.<uuid>` atomic temp files,
/// - `.<basename>.tmp-*` Rust atomic_write_file temp files.
///
/// Call ONLY after a successful state load: a failed load may need the
/// quarantined bytes for recovery, and the age windows (7 days /
/// 1 hour) are what make deletion safe, not the call site. Individual
/// unlink failures are warned and skipped so one bad entry never blocks
/// the rest of the sweep.
export function sweepStateFileArtifacts(path: string, now = Date.now()): void {
  const directory = dirname(path);
  const base = basename(path);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of entries) {
    const isCorrupt = name.startsWith(`${base}.corrupt-`);
    const isNodeTmp = name.startsWith(`${base}.`) && name.endsWith(".tmp");
    const isRustTmp = name.startsWith(`.${base}.tmp-`);
    if (!isCorrupt && !isNodeTmp && !isRustTmp) continue;
    const sibling = join(directory, name);
    try {
      const age = now - statSync(sibling).mtimeMs;
      const maxAge = isCorrupt ? CORRUPT_SWEEP_MAX_AGE_MS : TMP_SWEEP_MAX_AGE_MS;
      if (age <= maxAge) continue;
      rmSync(sibling, { force: true });
    } catch (error) {
      process.stderr.write(
        `warning: could not sweep stale state artifact ${sibling}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}
