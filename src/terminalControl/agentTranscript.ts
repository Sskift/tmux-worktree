import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  TerminalControlProtocolError,
  type TerminalControlAgentResult,
  type TerminalControlAgentSource,
} from "./protocol";

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_HEADER_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_CANDIDATES = 4096;

type AgentProvider = TerminalControlAgentSource["provider"];

interface TranscriptCandidate {
  path: string;
  mtimeMs: number;
}

interface JsonRecord extends Record<string, unknown> {}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: unknown, maxBytes = 4096): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) return undefined;
  return value;
}

function exactTimestamp(value: unknown): string | undefined {
  const text = safeText(value, 64);
  if (!text) return undefined;
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) return undefined;
  return new Date(milliseconds).toISOString() === text ? text : undefined;
}

function privateTranscriptStat(path: string): { size: number; mtimeMs: number } {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new TerminalControlProtocolError(
      "RESOURCE_EXHAUSTED",
      `Agent result transcript is not ready: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "Agent result transcript is not a private owned regular file",
    );
  }
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

function assertBoundedTranscript(stat: { size: number }): void {
  if (stat.size > MAX_TRANSCRIPT_BYTES) {
    throw new TerminalControlProtocolError(
      "RESOURCE_EXHAUSTED",
      "Agent result transcript exceeds the bounded parser limit",
    );
  }
}

function assertUnchangedTranscript(
  before: { size: number; mtimeMs: number },
  after: { size: number; mtimeMs: number },
): void {
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new TerminalControlProtocolError(
      "RESOURCE_EXHAUSTED",
      "Agent result transcript changed during observation",
      true,
    );
  }
}

function parseJsonLines(text: string): JsonRecord[] {
  const lines = text.split("\n");
  const records: JsonRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error("record is not an object");
      records.push(parsed);
    } catch (error) {
      if (index === lines.length - 1 && !text.endsWith("\n")) {
        throw new TerminalControlProtocolError(
          "RESOURCE_EXHAUSTED",
          "Agent result transcript has an incomplete trailing record",
          true,
        );
      }
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        `Agent result transcript is malformed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return records;
}

function readJsonLines(path: string): JsonRecord[] {
  const before = privateTranscriptStat(path);
  assertBoundedTranscript(before);
  const text = readFileSync(path, "utf8");
  const after = privateTranscriptStat(path);
  assertBoundedTranscript(after);
  assertUnchangedTranscript(before, after);
  return parseJsonLines(text);
}

function readRange(path: string, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(path, "r");
  let offset = 0;
  try {
    while (offset < length) {
      const count = readSync(descriptor, buffer, offset, length - offset, position + offset);
      if (count === 0) break;
      offset += count;
    }
  } finally {
    closeSync(descriptor);
  }
  return buffer.subarray(0, offset);
}

function completeHeadText(buffer: Buffer, wholeFile: boolean): string {
  const text = buffer.toString("utf8");
  if (wholeFile || text.endsWith("\n")) return text;
  const boundary = text.lastIndexOf("\n");
  return boundary < 0 ? "" : text.slice(0, boundary + 1);
}

function codexSessionMetadata(path: string): { sessionId: string; cwd: string } | undefined {
  const before = privateTranscriptStat(path);
  const length = Math.min(before.size, MAX_CODEX_HEADER_BYTES);
  const buffer = readRange(path, 0, length);
  const after = privateTranscriptStat(path);
  assertUnchangedTranscript(before, after);
  const records = parseJsonLines(completeHeadText(buffer, length === before.size));
  for (const record of records) {
    if (record.type !== "session_meta" || !isRecord(record.payload)) continue;
    const sessionId = safeText(record.payload.id, 128);
    const cwd = safeText(record.payload.cwd, 16 * 1024);
    if (sessionId && cwd) return { sessionId, cwd };
  }
  return undefined;
}

function readCodexJsonLines(path: string): JsonRecord[] {
  const before = privateTranscriptStat(path);
  if (before.size <= MAX_TRANSCRIPT_BYTES) return readJsonLines(path);

  const headLength = Math.min(before.size, MAX_CODEX_HEADER_BYTES);
  const tailStart = Math.max(headLength, before.size - MAX_TRANSCRIPT_BYTES);
  const head = readRange(path, 0, headLength);
  const tailWithBoundary = readRange(path, tailStart - 1, before.size - tailStart + 1);
  const after = privateTranscriptStat(path);
  assertUnchangedTranscript(before, after);

  const headRecords = parseJsonLines(completeHeadText(head, false));
  const previousByte = tailWithBoundary[0];
  let tail = tailWithBoundary.subarray(1);
  if (previousByte !== 0x0a) {
    const boundary = tail.indexOf(0x0a);
    if (boundary < 0) {
      throw new TerminalControlProtocolError(
        "RESOURCE_EXHAUSTED",
        "Agent result transcript has no complete record in the bounded parser tail",
        true,
      );
    }
    tail = tail.subarray(boundary + 1);
  }
  return [...headRecords, ...parseJsonLines(tail.toString("utf8"))];
}

function boundedUtf8Head(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  let text = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    text += character;
    bytes += size;
  }
  return { text, truncated: true };
}

function sourceId(
  provider: AgentProvider,
  boundary: TerminalControlAgentSource["boundary"],
  sessionId: string,
  turnId: string,
): string {
  return createHash("sha256")
    .update(`${provider}\0${boundary}\0${sessionId}\0${turnId}`, "utf8")
    .digest("hex");
}

function source(
  provider: AgentProvider,
  boundary: TerminalControlAgentSource["boundary"],
  sessionId: string,
  turnId: string,
  startedAt: string,
): TerminalControlAgentSource {
  return {
    provider,
    boundary,
    sourceId: sourceId(provider, boundary, sessionId, turnId),
    sessionId,
    turnId,
    startedAt,
  };
}

export function agentProviderFromStartCommand(command: string): AgentProvider | undefined {
  const claude = /(?:^|[\s;"'])claude(?:[\s;"']|$)/u.test(command);
  const codex = /(?:^|[\s;"'])codex(?:[\s;"']|$)/u.test(command);
  if (claude === codex) return undefined;
  return claude ? "claude" : "codex";
}

function claudeProjectDirectory(cwd: string, home: string): string {
  const encoded = cwd.replace(/[^A-Za-z0-9]/g, "-");
  return join(home, ".claude", "projects", encoded);
}

function directJsonlCandidates(directory: string): TranscriptCandidate[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new TerminalControlProtocolError(
      "RESOURCE_EXHAUSTED",
      `Agent result transcript directory is not ready: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => {
      const path = join(directory, entry.name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function codexJsonlCandidates(home: string): TranscriptCandidate[] {
  const root = join(home, ".codex", "sessions");
  const candidates: TranscriptCandidate[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 4 || candidates.length > MAX_TRANSCRIPT_CANDIDATES) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (depth === 0) {
        throw new TerminalControlProtocolError(
          "RESOURCE_EXHAUSTED",
          `Agent result transcript directory is not ready: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        visit(join(directory, entry.name), depth + 1);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/u.test(entry.name)) {
        const path = join(directory, entry.name);
        candidates.push({ path, mtimeMs: statSync(path).mtimeMs });
      }
    }
  };
  visit(root, 0);
  if (candidates.length > MAX_TRANSCRIPT_CANDIDATES) {
    throw new TerminalControlProtocolError(
      "RESOURCE_EXHAUSTED",
      "Agent result transcript catalog exceeds the bounded parser limit",
    );
  }
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function claudeHumanTurn(record: JsonRecord, cwd: string): {
  turnId: string;
  startedAt: string;
} | undefined {
  if (record.type !== "user" || record.isSidechain === true || record.isMeta === true
    || record.cwd !== cwd || !isRecord(record.message)
    || typeof record.message.content !== "string") return undefined;
  const content = record.message.content.trimStart();
  if (!content
    || /^<(?:command-name|local-command-stdout|local-command-caveat|task-notification)>/u.test(content)) {
    return undefined;
  }
  const turnId = safeText(record.uuid, 128);
  const startedAt = exactTimestamp(record.timestamp);
  return turnId && startedAt ? { turnId, startedAt } : undefined;
}

function activeClaudeSource(records: JsonRecord[], cwd: string): TerminalControlAgentSource | undefined {
  const sessionId = safeText(records.find((record) => record.sessionId)?.sessionId, 128);
  if (!sessionId || !records.some((record) => record.cwd === cwd && record.sessionId === sessionId)) {
    return undefined;
  }
  let lastCompletionIndex = -1;
  for (let index = 0; index < records.length; index += 1) {
    if (records[index].type === "system" && records[index].subtype === "turn_duration"
      && records[index].isSidechain !== true) lastCompletionIndex = index;
  }
  if (lastCompletionIndex >= 0) {
    const completion = records[lastCompletionIndex];
    const turnId = safeText(completion.uuid, 128);
    const startedAt = exactTimestamp(completion.timestamp);
    if (!turnId || !startedAt) return undefined;
    const hasLaterActivity = records.slice(lastCompletionIndex + 1).some((record) =>
      record.sessionId === sessionId && record.isSidechain !== true
      && (record.type === "user" || record.type === "assistant"));
    return source(
      "claude",
      hasLaterActivity ? "after" : "inclusive",
      sessionId,
      turnId,
      startedAt,
    );
  }
  for (let index = 0; index < records.length; index += 1) {
    const turn = claudeHumanTurn(records[index], cwd);
    if (!turn) continue;
    return source("claude", "after", sessionId, turn.turnId, turn.startedAt);
  }
  return undefined;
}

function claudeResult(
  records: JsonRecord[],
  cwd: string,
  expected: TerminalControlAgentSource,
  maxBytes: number,
): TerminalControlAgentResult | undefined {
  if (expected.boundary === "exact") return undefined;
  const startIndex = records.findIndex((record) => record.uuid === expected.turnId
    && record.sessionId === expected.sessionId
    && exactTimestamp(record.timestamp) === expected.startedAt
    && (record.cwd === cwd || record.type === "system"));
  if (startIndex < 0) return undefined;
  let completionIndex = -1;
  for (let index = startIndex; index < records.length; index += 1) {
    const record = records[index];
    if (record.type !== "system" || record.subtype !== "turn_duration"
      || record.isSidechain === true) continue;
    if (index > startIndex || expected.boundary === "inclusive") completionIndex = index;
  }
  if (completionIndex < 0) return undefined;
  const completion = records[completionIndex];
  const assistantUuid = safeText(completion.parentUuid, 128);
  const completedAt = exactTimestamp(completion.timestamp);
  if (!assistantUuid || !completedAt) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "Claude completion correlation is malformed",
    );
  }
  let assistant: JsonRecord | undefined;
  for (let index = completionIndex - 1; index >= 0; index -= 1) {
    const candidate = records[index];
    if (candidate.type === "assistant" && candidate.uuid === assistantUuid
      && isRecord(candidate.message) && candidate.message.role === "assistant") {
      assistant = candidate;
      break;
    }
  }
  if (!assistant || !isRecord(assistant.message) || !Array.isArray(assistant.message.content)) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "Claude completion does not reference an exact final assistant message",
    );
  }
  const content: unknown[] = assistant.message.content;
  const text = content
    .filter((block: unknown): block is Record<string, unknown> => isRecord(block) && block.type === "text")
    .map((block: Record<string, unknown>) => typeof block.text === "string" ? block.text : "")
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (!text) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "Claude final assistant message contains no public text",
    );
  }
  const bounded = boundedUtf8Head(text, maxBytes);
  return { source: expected, completedAt, text: bounded.text, truncated: bounded.truncated };
}

function codexSessionId(records: JsonRecord[]): string | undefined {
  for (const record of records) {
    if (record.type === "session_meta" && isRecord(record.payload)) {
      const id = safeText(record.payload.id, 128);
      if (id) return id;
    }
  }
  return undefined;
}

function activeCodexSource(records: JsonRecord[], cwd: string): TerminalControlAgentSource | undefined {
  const sessionId = codexSessionId(records);
  if (!sessionId || !records.some((record) =>
    record.type === "session_meta" && isRecord(record.payload)
    && record.payload.id === sessionId && record.payload.cwd === cwd)) return undefined;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.type !== "event_msg" || !isRecord(record.payload)
      || record.payload.type !== "task_started") continue;
    const turnId = safeText(record.payload.turn_id, 128);
    const startedAt = exactTimestamp(record.timestamp);
    if (!turnId || !startedAt) continue;
    const completed = records.slice(index + 1).some((candidate) =>
      candidate.type === "event_msg" && isRecord(candidate.payload)
      && candidate.payload.type === "task_complete" && candidate.payload.turn_id === turnId);
    if (completed) continue;
    return source("codex", "exact", sessionId, turnId, startedAt);
  }
  return undefined;
}

function codexResult(
  records: JsonRecord[],
  cwd: string,
  expected: TerminalControlAgentSource,
  maxBytes: number,
): TerminalControlAgentResult | undefined {
  if (codexSessionId(records) !== expected.sessionId) return undefined;
  const cwdMatches = records.some((candidate) =>
    candidate.type === "session_meta" && isRecord(candidate.payload)
    && candidate.payload.id === expected.sessionId && candidate.payload.cwd === cwd);
  if (!cwdMatches) return undefined;
  const startIndex = records.findIndex((record) => record.type === "event_msg"
    && isRecord(record.payload) && record.payload.type === "task_started"
    && record.payload.turn_id === expected.turnId
    && exactTimestamp(record.timestamp) === expected.startedAt);
  if (startIndex < 0) return undefined;
  const completion = records.slice(startIndex + 1).find((record) =>
    record.type === "event_msg" && isRecord(record.payload)
    && record.payload.type === "task_complete" && record.payload.turn_id === expected.turnId);
  if (!completion || !isRecord(completion.payload)) return undefined;
  const text = safeText(completion.payload.last_agent_message, MAX_TRANSCRIPT_BYTES)?.trim();
  if (!text) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "Codex task completion contains no final assistant message",
    );
  }
  const completedAt = exactTimestamp(completion.timestamp);
  if (!completedAt) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "Codex completion timestamp is malformed",
    );
  }
  const bounded = boundedUtf8Head(text, maxBytes);
  return { source: expected, completedAt, text: bounded.text, truncated: bounded.truncated };
}

function transcriptCandidates(provider: AgentProvider, cwd: string, home: string): TranscriptCandidate[] {
  return provider === "claude"
    ? directJsonlCandidates(claudeProjectDirectory(cwd, home))
    : codexJsonlCandidates(home);
}

export function discoverActiveAgentSource(input: {
  provider: AgentProvider;
  cwd: string;
  home?: string;
}): TerminalControlAgentSource {
  const home = input.home ?? homedir();
  const matches: TerminalControlAgentSource[] = [];
  for (const candidate of transcriptCandidates(input.provider, input.cwd, home)) {
    if (input.provider === "codex") {
      const metadata = codexSessionMetadata(candidate.path);
      if (!metadata || metadata.cwd !== input.cwd) continue;
    }
    const records = input.provider === "codex"
      ? readCodexJsonLines(candidate.path)
      : readJsonLines(candidate.path);
    const found = input.provider === "claude"
      ? activeClaudeSource(records, input.cwd)
      : activeCodexSource(records, input.cwd);
    if (found) {
      matches.push(found);
      break;
    }
  }
  if (matches.length === 1) return matches[0];
  throw new TerminalControlProtocolError(
    "RESOURCE_EXHAUSTED",
    "the running Agent turn is not yet available in its structured transcript",
    true,
  );
}

export function readCompletedAgentResult(input: {
  source: TerminalControlAgentSource;
  cwd: string;
  maxBytes: number;
  home?: string;
}): TerminalControlAgentResult {
  const expectedId = sourceId(
    input.source.provider,
    input.source.boundary,
    input.source.sessionId,
    input.source.turnId,
  );
  if (expectedId !== input.source.sourceId) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "Agent result source identity is malformed",
    );
  }
  const home = input.home ?? homedir();
  for (const candidate of transcriptCandidates(input.source.provider, input.cwd, home)) {
    if (!candidate.path.endsWith(`${input.source.sessionId}.jsonl`)) continue;
    const records = input.source.provider === "codex"
      ? readCodexJsonLines(candidate.path)
      : readJsonLines(candidate.path);
    const result = input.source.provider === "claude"
      ? claudeResult(records, input.cwd, input.source, input.maxBytes)
      : codexResult(records, input.cwd, input.source, input.maxBytes);
    if (result) return result;
  }
  throw new TerminalControlProtocolError(
    "RESOURCE_EXHAUSTED",
    "the exact Agent final response is not yet available in its structured transcript",
    true,
  );
}
