import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MAX_OUTPUT_FILE_BYTES,
  MAX_RENDERED_SNAPSHOT_SOURCE_BYTES,
  MAX_OUTPUT_SEGMENTS,
  OUTPUT_GENERATION_OPTION,
  OUTPUT_SEGMENT_BYTES,
} from "./constants";
import {
  TerminalControlOutputChunk,
  TerminalControlOutputPosition,
  TerminalControlProtocolError,
} from "./protocol";
import { runTmux } from "./tmuxExec";
import { shellQuote } from "./shellQuote";

export function outputRoot(home = homedir()): string {
  return process.env.TW_TERMINAL_CONTROL_OUTPUT_DIR?.trim()
    || join(home, ".tmux-worktree", "terminal-control-output-v1");
}

export type OutputCapturePaths = {
  directory: string;
  generationHash: string;
  legacyPath: string;
};

export type OutputSegment = {
  path: string;
  start: number;
  size: number;
};

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output directory is not a private real directory",
    );
  }
  chmodSync(path, 0o700);
}

export function outputCapturePaths(controlTargetId: string, generation: string): OutputCapturePaths {
  const target = createHash("sha256").update(controlTargetId, "utf8").digest("hex");
  const generationHash = createHash("sha256").update(generation, "utf8").digest("hex");
  const directory = join(outputRoot(), target);
  privateDirectory(outputRoot());
  privateDirectory(directory);
  return {
    directory,
    generationHash,
    legacyPath: join(directory, `${generationHash}.bin`),
  };
}

export function segmentPath(paths: OutputCapturePaths, start: number): string {
  return join(paths.legacyPath, `${paths.generationHash}.${start}.segment`);
}

export function outputCaptureKind(paths: OutputCapturePaths): "missing" | "legacy" | "segmented" {
  if (!existsSync(paths.legacyPath)) return "missing";
  const stat = lstatSync(paths.legacyPath);
  const uid = process.getuid?.();
  if (stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output generation is not a private owned filesystem entry",
    );
  }
  if (stat.isFile()) return "legacy";
  if (stat.isDirectory()) {
    chmodSync(paths.legacyPath, 0o700);
    return "segmented";
  }
  throw new TerminalControlProtocolError(
    "RECOVERY_REQUIRED",
    "terminal output generation has an unsupported filesystem type",
  );
}

export function assertPrivateOutputFile(path: string, maxBytes?: number): Stats {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output capture file is not a private regular file",
    );
  }
  chmodSync(path, 0o600);
  if (maxBytes !== undefined && stat.size > maxBytes) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output capture segment exceeded its bounded size",
    );
  }
  return stat;
}

export function ensureOutputFile(path: string): void {
  if (!existsSync(path)) {
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
  }
  const stat = assertPrivateOutputFile(path);
  if (stat.size >= MAX_OUTPUT_FILE_BYTES) {
    throw new TerminalControlProtocolError(
      "RESOURCE_EXHAUSTED",
      "terminal output generation exceeded its bounded capture limit",
    );
  }
}

export function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function scanOutputSegments(paths: OutputCapturePaths): OutputSegment[] {
  if (outputCaptureKind(paths) !== "segmented") return [];
  const pattern = new RegExp(`^${paths.generationHash}\\.([0-9]+)\\.segment$`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const segments = readdirSync(paths.legacyPath)
        .flatMap((name): OutputSegment[] => {
          const match = pattern.exec(name);
          if (!match) return [];
          const start = Number(match[1]);
          if (!Number.isSafeInteger(start) || start < 0) {
            throw new TerminalControlProtocolError(
              "RECOVERY_REQUIRED",
              "terminal output capture segment cursor is invalid",
            );
          }
          const path = join(paths.legacyPath, name);
          const stat = assertPrivateOutputFile(path, OUTPUT_SEGMENT_BYTES);
          return [{ path, start, size: stat.size }];
        })
        .sort((left, right) => left.start - right.start);
      for (let index = 0; index < segments.length - 1; index += 1) {
        const current = segments[index];
        const next = segments[index + 1];
        if (current.size !== OUTPUT_SEGMENT_BYTES || next.start !== current.start + current.size) {
          throw new TerminalControlProtocolError(
            "RECOVERY_REQUIRED",
            "terminal output capture segments are not contiguous",
          );
        }
      }
      return segments;
    } catch (error) {
      if (attempt === 0 && isMissingFileError(error)) continue;
      throw error;
    }
  }
  return [];
}

export function currentOutputSegments(paths: OutputCapturePaths): OutputSegment[] {
  // The capture writer is the sole owner of current-generation retention.
  // Readers may observe the brief create-before-unlink window and simply use
  // the newest two contiguous segments; they never race the writer by
  // unlinking a live segment themselves.
  return scanOutputSegments(paths).slice(-MAX_OUTPUT_SEGMENTS);
}

export function createInitialOutputSegment(paths: OutputCapturePaths): OutputSegment[] {
  mkdirSync(paths.legacyPath, { mode: 0o700 });
  if (outputCaptureKind(paths) !== "segmented") {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output generation directory could not be established",
    );
  }
  const path = segmentPath(paths, 0);
  const fd = openSync(path, "wx", 0o600);
  closeSync(fd);
  return [{ path, start: 0, size: 0 }];
}

export function outputPositionFromSegments(
  generation: string,
  segments: OutputSegment[],
): TerminalControlOutputPosition {
  const current = segments.at(-1);
  if (!current) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output capture has no retained segment",
    );
  }
  const cursor = current.start + current.size;
  if (!Number.isSafeInteger(cursor)) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output cursor exceeded the supported range",
    );
  }
  return {
    generation,
    cursor,
    retainedStartCursor: segments[0].start,
  };
}

export function pruneObsoleteOutputFiles(paths: OutputCapturePaths): void {
  const captureName = /^([0-9a-f]{64})\.bin$/;
  const flatSegmentName = /^([0-9a-f]{64})\.[0-9]+\.segment$/;
  for (const name of readdirSync(paths.directory)) {
    const match = captureName.exec(name) ?? flatSegmentName.exec(name);
    if (!match || match[1] === paths.generationHash) continue;
    const path = join(paths.directory, name);
    try {
      const stat = lstatSync(path);
      const uid = process.getuid?.();
      if (stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) continue;
      if (stat.isFile()) {
        unlinkSync(path);
        continue;
      }
      if (!stat.isDirectory() || !captureName.test(name)) continue;
      const segmentPattern = new RegExp(`^${match[1]}\\.[0-9]+\\.segment$`);
      const children = readdirSync(path);
      const safeChildren = children.every((child) => {
        if (!segmentPattern.test(child)) return false;
        const childStat = lstatSync(join(path, child));
        return childStat.isFile()
          && !childStat.isSymbolicLink()
          && (uid === undefined || childStat.uid === uid);
      });
      if (!safeChildren) continue;
      for (const child of children) unlinkSync(join(path, child));
      rmdirSync(path);
    } catch (error) {
      if (!isMissingFileError(error)) {
        // Capture cleanup is bounded best effort. Unknown or concurrently
        // changing entries must never weaken the current generation's fence.
      }
    }
  }
}

export const SEGMENTED_CAPTURE_SCRIPT = [
  "const fs=require('fs')",
  "const directory=process.argv[1]",
  "const generation=process.argv[2]",
  "let start=Number(process.argv[3])",
  "const limit=Number(process.argv[4])",
  "const retain=Number(process.argv[5])",
  "if(!/^[0-9a-f]{64}$/.test(generation)||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(limit)||limit<=0||!Number.isSafeInteger(retain)||retain<2){process.exit(2)}",
  "const segmentPath=(cursor)=>directory+'/'+generation+'.'+cursor+'.segment'",
  "let path=segmentPath(start)",
  "let fd=fs.openSync(path,fs.constants.O_WRONLY|fs.constants.O_APPEND)",
  "let size=fs.fstatSync(fd).size",
  "if(size>limit){process.exit(3)}",
  "const cleanup=()=>{",
  "const pattern=new RegExp('^'+generation+'\\\\.([0-9]+)\\\\.segment$')",
  "const segments=fs.readdirSync(directory).map((name)=>{const match=pattern.exec(name);return match?{name,start:Number(match[1])}:null}).filter(Boolean).filter((entry)=>Number.isSafeInteger(entry.start)).sort((a,b)=>a.start-b.start)",
  "for(const entry of segments.slice(0,-retain)){const candidate=directory+'/'+entry.name;try{const stat=fs.lstatSync(candidate);if(!stat.isFile()||stat.isSymbolicLink()){process.exit(4)}fs.unlinkSync(candidate)}catch(error){if(error.code!=='ENOENT'){throw error}}}",
  "}",
  "cleanup()",
  "const rotate=()=>{",
  "fs.closeSync(fd)",
  "start+=size",
  "if(!Number.isSafeInteger(start)){process.exit(5)}",
  "path=segmentPath(start)",
  "fd=fs.openSync(path,'wx',0o600)",
  "size=0",
  "cleanup()",
  "}",
  "process.stdin.on('data',(chunk)=>{",
  "let offset=0",
  "while(offset<chunk.length){",
  "if(size===limit){rotate()}",
  "const length=Math.min(limit-size,chunk.length-offset)",
  "let written=0",
  "while(written<length){written+=fs.writeSync(fd,chunk,offset+written,length-written)}",
  "offset+=length",
  "size+=length",
  "}",
  "})",
  "process.stdin.on('end',()=>{fs.closeSync(fd)})",
].join(";");

export function outputCaptureCommand(paths: OutputCapturePaths, current: OutputSegment): string {
  return [
    "exec",
    shellQuote(process.execPath),
    "-e",
    shellQuote(SEGMENTED_CAPTURE_SCRIPT),
    shellQuote(paths.legacyPath),
    paths.generationHash,
    String(current.start),
    String(OUTPUT_SEGMENT_BYTES),
    String(MAX_OUTPUT_SEGMENTS),
  ].join(" ");
}

export async function outputCaptureBackendState(
  paneTarget: string,
): Promise<{ generation: string; pipeActive: boolean }> {
  const fields = (await runTmux([
    "display-message",
    "-p",
    "-t",
    paneTarget,
    `#{@${OUTPUT_GENERATION_OPTION.slice(1)}}\u001f#{pane_pipe}`,
  ])).stdout.trimEnd().split("\u001f");
  if (fields.length !== 2 || (fields[1] !== "0" && fields[1] !== "1")) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output capture state is malformed",
    );
  }
  return { generation: fields[0], pipeActive: fields[1] === "1" };
}

export async function replaceSegmentedOutputCapture(
  sessionId: string,
  paneTarget: string,
  paths: OutputCapturePaths,
  generation: string,
  current: OutputSegment,
): Promise<TerminalControlOutputPosition> {
  await runTmux(["set-option", "-t", sessionId, OUTPUT_GENERATION_OPTION, generation]);
  // Uppercase -O selects pane output; unlike lowercase -o it replaces any
  // existing pipe. This makes retrying the exact recovery generation converge
  // on the canonical capture command instead of trusting an unknown live pipe.
  await runTmux(["pipe-pane", "-O", "-t", paneTarget, outputCaptureCommand(paths, current)]);
  const confirmed = await outputCaptureBackendState(paneTarget);
  if (confirmed.generation !== generation || !confirmed.pipeActive) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output capture generation or pipe could not be established",
    );
  }
  pruneObsoleteOutputFiles(paths);
  return outputPositionFromSegments(generation, currentOutputSegments(paths));
}

export async function establishSegmentedOutputCapture(
  sessionId: string,
  paneTarget: string,
  paths: OutputCapturePaths,
  generation: string,
  capturePane = false,
): Promise<TerminalControlOutputPosition> {
  if (outputCaptureKind(paths) !== "missing") {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "new terminal output generation already has capture data",
    );
  }
  const current = createInitialOutputSegment(paths)[0];
  if (!capturePane) {
    return replaceSegmentedOutputCapture(sessionId, paneTarget, paths, generation, current);
  }
  const snapshotBuffer = `tw-terminal-snapshot-${process.pid}-${randomUUID()}`;
  try {
    // These commands share one tmux command queue: capture the exact current
    // pane into the initial generation segment, then install the live pipe
    // before later pane output can pass that boundary.
    await runTmux([
      "capture-pane", "-e", "-b", snapshotBuffer, "-t", paneTarget,
      // This is a brand-new, exclusively owned generation segment.  Write
      // the snapshot as its initial contents; the live capture process opens
      // the same file with O_APPEND immediately afterwards.  Using tmux's
      // append mode here can leave the pre-created file at zero bytes on the
      // Dashboard-managed shutdown/open path even though the buffer is not
      // empty.
      ";", "save-buffer", "-b", snapshotBuffer, current.path,
      ";", "delete-buffer", "-b", snapshotBuffer,
      ";", "set-option", "-t", sessionId, OUTPUT_GENERATION_OPTION, generation,
      ";", "pipe-pane", "-O", "-t", paneTarget, outputCaptureCommand(paths, current),
    ]);
  } catch (error) {
    await runTmux(
      ["delete-buffer", "-b", snapshotBuffer],
      { allowFailure: true },
    ).catch(() => undefined);
    throw error;
  }
  const confirmed = await outputCaptureBackendState(paneTarget);
  if (confirmed.generation !== generation || !confirmed.pipeActive) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output capture generation or pipe could not be established",
    );
  }
  let segments = currentOutputSegments(paths);
  if (outputPositionFromSegments(generation, segments).cursor === 0) {
    // Some real Dashboard-managed tmux lifecycles acknowledge the queued
    // capture/save/pipe sequence while leaving the pre-created segment empty.
    // The pipe is already live at this point, so repair the renderer without
    // losing subsequent output: append a terminal reset plus a direct current
    // pane snapshot, then restart the writer so its retained-size accounting
    // includes the externally appended seed.
    const captured = await runTmux(
      ["capture-pane", "-p", "-e", "-t", paneTarget],
      { maxStdoutBytes: MAX_RENDERED_SNAPSHOT_SOURCE_BYTES },
    );
    const seed = Buffer.concat([
      Buffer.from("\u001bc", "ascii"),
      Buffer.from(captured.stdout, "utf8"),
    ]);
    if (seed.byteLength > OUTPUT_SEGMENT_BYTES) {
      throw new TerminalControlProtocolError(
        "RESOURCE_EXHAUSTED",
        "terminal pane snapshot exceeded the initial capture segment",
      );
    }
    appendFileSync(current.path, seed);
    await replaceSegmentedOutputCapture(sessionId, paneTarget, paths, generation, current);
    segments = currentOutputSegments(paths);
  }
  pruneObsoleteOutputFiles(paths);
  return outputPositionFromSegments(generation, segments);
}

export async function resumeSegmentedOutputCapture(
  sessionId: string,
  paneTarget: string,
  paths: OutputCapturePaths,
  generation: string,
): Promise<TerminalControlOutputPosition> {
  if (outputCaptureKind(paths) !== "segmented") {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "planned terminal output recovery data is missing",
    );
  }
  const current = currentOutputSegments(paths).at(-1);
  if (!current) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "planned terminal output recovery has no retained segment",
    );
  }
  return replaceSegmentedOutputCapture(sessionId, paneTarget, paths, generation, current);
}

export function legacyCaptureRequiresRotation(path: string): never {
  ensureOutputFile(path);
  throw new TerminalControlProtocolError(
    "RESOURCE_EXHAUSTED",
    "terminal output legacy capture requires bounded rotation",
  );
}

export function readSegmentedOutput(
  paths: OutputCapturePaths,
  generation: string,
  cursor: number,
  maxBytes: number,
): TerminalControlOutputChunk {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const segments = currentOutputSegments(paths);
      const position = outputPositionFromSegments(generation, segments);
      const floor = segments[0].start;
      if (cursor < floor || cursor > position.cursor) {
        throw new TerminalControlProtocolError("STALE_OUTPUT_CURSOR", "terminal output cursor is stale");
      }
      const length = Math.min(maxBytes, position.cursor - cursor);
      const buffer = Buffer.alloc(length);
      let nextCursor = cursor;
      let outputOffset = 0;
      for (const segment of segments) {
        if (outputOffset >= length) break;
        const segmentEnd = segment.start + segment.size;
        if (nextCursor >= segmentEnd) continue;
        if (nextCursor < segment.start) {
          throw new TerminalControlProtocolError(
            "RECOVERY_REQUIRED",
            "terminal output capture contains a retained cursor gap",
          );
        }
        let fd = -1;
        try {
          fd = openSync(segment.path, "r");
          const stat = fstatSync(fd);
          const uid = process.getuid?.();
          if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || stat.size > OUTPUT_SEGMENT_BYTES) {
            throw new TerminalControlProtocolError(
              "RECOVERY_REQUIRED",
              "terminal output capture segment is not a private bounded regular file",
            );
          }
          const fileOffset = nextCursor - segment.start;
          const available = Math.min(segment.size - fileOffset, length - outputOffset);
          const read = available > 0
            ? readSync(fd, buffer, outputOffset, available, fileOffset)
            : 0;
          outputOffset += read;
          nextCursor += read;
          if (read !== available) {
            throw new TerminalControlProtocolError(
              "RECOVERY_REQUIRED",
              "terminal output capture changed during a retained read",
            );
          }
        } finally {
          if (fd >= 0) closeSync(fd);
        }
      }
      if (outputOffset !== length) {
        throw new TerminalControlProtocolError(
          "RECOVERY_REQUIRED",
          "terminal output capture could not satisfy a retained read",
        );
      }
      return {
        generation,
        cursor,
        dataBase64: buffer.toString("base64"),
        nextCursor,
      };
    } catch (error) {
      if (attempt === 0 && isMissingFileError(error)) continue;
      throw error;
    }
  }
  throw new TerminalControlProtocolError(
    "RECOVERY_REQUIRED",
    "terminal output capture changed repeatedly during a retained read",
  );
}
