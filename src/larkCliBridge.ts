import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { FeishuReplyMode } from "./feishuBridgeStorage.js";
import { isRecord } from "./feishuBridgeStorage.js";
import type { FeishuReplyCard } from "./feishuReplyCard.js";

const MAX_LARK_OUTPUT_BYTES = 1024 * 1024;
const LARK_COMMAND_TIMEOUT_MS = 15_000;
const MAX_FEISHU_GROUP_PAGES = 100;

export interface FeishuInboundEvent {
  type: "im.message.receive_v1";
  event_id: string;
  message_id: string;
  chat_id: string;
  chat_type: "group" | "p2p";
  message_type: string;
  sender_id: string;
  content: string;
  create_time?: string;
  timestamp?: string;
}

export interface FeishuMessageDetail {
  senderId?: string;
  senderType?: string;
  mentionedIds: string[];
  text?: string;
}

export interface FeishuReplyResult {
  messageId?: string;
  raw: unknown;
}

export type FeishuReactionEmoji = "Typing" | "CrossMark";

export interface FeishuReactionResult {
  reactionId?: string;
  raw: unknown;
}

export interface FeishuBotIdentity {
  openId: string;
  mentionIds: string[];
}

export interface FeishuChat {
  chatId: string;
  name: string;
  ownerId?: string;
}

export interface FeishuEventSubscription {
  child: ChildProcess;
  ready: Promise<void>;
  done: Promise<void>;
  stop(): void;
}

export interface FeishuLarkAdapter {
  subscribe(onEvent: (event: FeishuInboundEvent) => Promise<void>): FeishuEventSubscription;
  messageDetail(messageId: string): Promise<FeishuMessageDetail>;
  sendCard(chatId: string, card: FeishuReplyCard, idempotencyKey: string): Promise<FeishuReplyResult>;
  replyCard(
    messageId: string,
    card: FeishuReplyCard,
    idempotencyKey: string,
    replyMode: FeishuReplyMode,
  ): Promise<FeishuReplyResult>;
  addReaction(messageId: string, emojiType: FeishuReactionEmoji): Promise<FeishuReactionResult>;
  deleteReaction(messageId: string, reactionId: string): Promise<void>;
  listGroups(): Promise<FeishuChat[]>;
  botOpenId(): Promise<string>;
  botMentionIds?(): Promise<string[]>;
}

function pickString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

export function parseFeishuInboundEvent(value: unknown): FeishuInboundEvent {
  if (!isRecord(value)) throw new Error("Feishu event must be an object");
  const type = value.type;
  const chatType = value.chat_type;
  if (type !== "im.message.receive_v1" || (chatType !== "group" && chatType !== "p2p")) {
    throw new Error("unsupported Feishu event");
  }
  const required = ["event_id", "message_id", "chat_id", "message_type", "sender_id", "content"];
  for (const key of required) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`invalid Feishu event ${key}`);
    }
  }
  return {
    type,
    event_id: value.event_id as string,
    message_id: value.message_id as string,
    chat_id: value.chat_id as string,
    chat_type: chatType,
    message_type: value.message_type as string,
    sender_id: value.sender_id as string,
    content: value.content as string,
    ...(typeof value.create_time === "string" ? { create_time: value.create_time } : {}),
    ...(typeof value.timestamp === "string" ? { timestamp: value.timestamp } : {}),
  };
}

function collectMessageDetail(
  value: unknown,
  detail: { senderId?: string; senderType?: string; mentionedIds: Set<string>; text?: string },
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectMessageDetail(item, detail);
    return;
  }
  if (!isRecord(value)) return;

  const sender = isRecord(value.sender) ? value.sender : undefined;
  const senderId = isRecord(sender?.sender_id) ? sender.sender_id : undefined;
  detail.senderId ||= pickString(
    senderId?.open_id,
    senderId?.openId,
    sender?.open_id,
    sender?.openId,
    value.sender_id,
    value.senderId,
  );
  detail.senderType ||= pickString(sender?.sender_type, sender?.senderType, value.sender_type, value.senderType);

  const mentions = Array.isArray(value.mentions) ? value.mentions : [];
  for (const mentionValue of mentions) {
    if (typeof mentionValue === "string") {
      detail.mentionedIds.add(mentionValue);
      continue;
    }
    if (!isRecord(mentionValue)) continue;
    const id = isRecord(mentionValue.id) ? mentionValue.id : undefined;
    const mentioned = pickString(
      id?.open_id,
      id?.openId,
      mentionValue.open_id,
      mentionValue.openId,
      typeof mentionValue.id === "string" ? mentionValue.id : undefined,
    );
    if (mentioned) detail.mentionedIds.add(mentioned);
  }

  const body = isRecord(value.body) ? value.body : undefined;
  const content = pickString(body?.content, value.content);
  if (!detail.text && content) {
    try {
      const parsed = JSON.parse(content) as unknown;
      detail.text = extractText(parsed) || content;
    } catch {
      detail.text = content;
    }
  }
  for (const child of Object.values(value)) collectMessageDetail(child, detail);
}

function extractText(value: unknown): string {
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (!isRecord(value)) return "";
  const own = typeof value.text === "string" ? value.text : "";
  const nested = Object.entries(value)
    .filter(([key]) => key !== "text")
    .map(([, child]) => extractText(child))
    .filter(Boolean)
    .join("\n");
  return [own, nested].filter(Boolean).join("\n");
}

function findMessageById(value: unknown, messageId: string): unknown | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMessageById(item, messageId);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (pickString(value.message_id, value.messageId) === messageId) return value;
  for (const child of Object.values(value)) {
    const found = findMessageById(child, messageId);
    if (found) return found;
  }
  return undefined;
}

export function parseFeishuMessageDetail(value: unknown, messageId?: string): FeishuMessageDetail {
  const detail: {
    senderId?: string;
    senderType?: string;
    mentionedIds: Set<string>;
    text?: string;
  } = { mentionedIds: new Set() };
  collectMessageDetail(messageId ? findMessageById(value, messageId) ?? value : value, detail);
  return {
    senderId: detail.senderId,
    senderType: detail.senderType,
    mentionedIds: [...detail.mentionedIds],
    text: detail.text,
  };
}

export function larkCliCommandArgs(args: string[], profile?: string): string[] {
  if (profile === undefined) return [...args];
  if (profile.length === 0 || profile.length > 256 || profile.includes("\0")) {
    throw new Error("invalid lark-cli profile");
  }
  return ["--profile", profile, ...args];
}

function runLark(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      "lark-cli",
      args,
      { timeout: LARK_COMMAND_TIMEOUT_MS, maxBuffer: MAX_LARK_OUTPUT_BYTES, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`lark-cli ${args.slice(0, 2).join(" ")} failed: ${stderr.trim() || error.message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(new Error(`lark-cli returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
        }
      },
    );
  });
}

function findReplyMessageId(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findReplyMessageId(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const own = pickString(value.message_id, value.messageId);
  if (own) return own;
  for (const child of Object.values(value)) {
    const found = findReplyMessageId(child);
    if (found) return found;
  }
  return undefined;
}

export function parseFeishuReactionId(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = parseFeishuReactionId(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const own = pickString(value.reaction_id, value.reactionId);
  if (own) return own;
  for (const child of Object.values(value)) {
    const found = parseFeishuReactionId(child);
    if (found) return found;
  }
  return undefined;
}

export function parseFeishuChats(value: unknown): FeishuChat[] {
  const chats = new Map<string, FeishuChat>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!isRecord(candidate)) return;
    const chatId = pickString(candidate.chat_id, candidate.chatId);
    const name = pickString(candidate.name, candidate.chat_name, candidate.chatName);
    const ownerId = pickString(candidate.owner_id, candidate.ownerId);
    if (chatId?.startsWith("oc_") && name) {
      chats.set(chatId, { chatId, name, ...(ownerId?.startsWith("ou_") ? { ownerId } : {}) });
    }
    for (const child of Object.values(candidate)) visit(child);
  };
  visit(value);
  return [...chats.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function parseFeishuChatPage(value: unknown): {
  chats: FeishuChat[];
  hasMore: boolean;
  pageToken?: string;
} {
  const page = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (!isRecord(page)) throw new Error("invalid Feishu chat list response");
  const hasMore = page.has_more === true || page.hasMore === true;
  const pageToken = pickString(page.page_token, page.pageToken);
  if (hasMore && !pageToken) {
    throw new Error("Feishu chat list omitted the next page token");
  }
  return {
    chats: parseFeishuChats(page.chats ?? page.items ?? []),
    hasMore,
    ...(pageToken ? { pageToken } : {}),
  };
}

export function parseFeishuBotIdentity(value: unknown): FeishuBotIdentity {
  if (!isRecord(value)) throw new Error("invalid bot info response");
  const data = isRecord(value.data) ? value.data : value;
  const identities = isRecord(value.identities) ? value.identities : undefined;
  const bot = isRecord(identities?.bot)
    ? identities.bot
    : isRecord(data.bot)
      ? data.bot
      : data;
  const openId = pickString(bot.open_id, bot.openId);
  if (!openId?.startsWith("ou_")) throw new Error("bot info omitted open_id");
  const appId = pickString(value.app_id, value.appId, data.app_id, data.appId, bot.app_id, bot.appId);
  return {
    openId,
    mentionIds: [...new Set([
      openId,
      ...(appId?.startsWith("cli_") ? [appId] : []),
    ])],
  };
}

export function parseFeishuBotOpenId(value: unknown): string {
  return parseFeishuBotIdentity(value).openId;
}

export class LarkCliBridgeAdapter implements FeishuLarkAdapter {
  private readonly profile?: string;
  private readonly runner: (args: string[]) => Promise<unknown>;
  private botIdentityCache?: FeishuBotIdentity;

  constructor(options: {
    profile?: string;
    runner?: (args: string[]) => Promise<unknown>;
  } = {}) {
    if (options.profile !== undefined) larkCliCommandArgs([], options.profile);
    this.profile = options.profile;
    this.runner = options.runner ?? runLark;
  }

  private commandArgs(args: string[]): string[] {
    return larkCliCommandArgs(args, this.profile);
  }

  subscribe(onEvent: (event: FeishuInboundEvent) => Promise<void>): FeishuEventSubscription {
    // No --quiet: lark-cli emits a `[event] ready event_key=<key>` marker on
    // stderr once the subscription is actually established (per the lark-event
    // skill contract). --quiet suppresses that marker (and drop warnings),
    // leaving us with only the child 'spawn' event — which fires the moment
    // the process launches, before the bus/handshake/auth setup, so a setup
    // failure (exit 1-4) would race with a fake "ready" reading.
    const child = spawn(
      "lark-cli",
      this.commandArgs(["event", "consume", "im.message.receive_v1", "--as", "bot"]),
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let readyLineBuffer = "";
    let chain = Promise.resolve();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_LARK_OUTPUT_BYTES) {
        // Backpressure fuse for a pathological single line (normal events are
        // KB-sized NDJSON and drained per line below, so this only trips on
        // malformed output). Record why before the supervisor only sees an
        // exit code; the restart path resubscribes immediately.
        process.stderr.write("[feishu-bridge] event consumer stdout exceeded 1MiB without a line boundary; restarting the subscription\n");
        child.kill("SIGTERM");
        return;
      }
      while (true) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line.trim()) continue;
        chain = chain.then(async () => {
          try {
            await onEvent(parseFeishuInboundEvent(JSON.parse(line)));
          } catch (error) {
            process.stderr.write(`[feishu-bridge] event rejected: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        });
      }
    });
    let readyResolved = false;
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const markReady = () => {
      if (readyResolved) return;
      readyResolved = true;
      readyResolve();
    };
    const failReady = (error: Error) => {
      if (readyResolved) return;
      readyResolved = true;
      readyReject(error);
    };

    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
      if (readyResolved) return;
      // Scan stderr line-by-line for the ready marker until the subscription
      // is established; after that markers never reappear.
      readyLineBuffer += chunk;
      let newline: number;
      while ((newline = readyLineBuffer.indexOf("\n")) >= 0) {
        const line = readyLineBuffer.slice(0, newline).trim();
        readyLineBuffer = readyLineBuffer.slice(newline + 1);
        if (line.startsWith("[event] ready")) {
          markReady();
          break;
        }
      }
    });
    const done = new Promise<void>((resolve, reject) => {
      child.once("error", (error) => {
        // Spawn failure (e.g. ENOENT): the child never launched. Surface the
        // deterministic cause so the caller can distinguish it from a setup
        // failure of a child that did spawn.
        failReady(error);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        void chain.finally(() => {
          const graceful = code === 0 || signal === "SIGTERM" || signal === "SIGINT";
          if (graceful) {
            // Exit before the ready marker (e.g. SIGTERM during startup) must
            // not leave `ready` pending; reject so the awaiting caller unblocks.
            failReady(new Error("lark-cli event consumer stopped before the subscription was established"));
            resolve();
            return;
          }
          // Non-zero exit before the ready marker = setup failure (auth exit
          // 3, network/handshake exit 4, validation exit 2, ...): reject
          // ready so no fake 'running' state is published and start() aborts /
          // the restart loop applies bounded backoff instead of reading the
          // subscription as established.
          const message = `lark-cli event consumer exited ${code ?? signal} before ready: ${stderr.trim()}`;
          failReady(new Error(message));
          reject(new Error(`lark-cli event consumer exited ${code ?? signal}: ${stderr.trim()}`));
        });
      });
    });
    return {
      child,
      ready,
      done,
      stop() {
        try { child.kill("SIGTERM"); } catch {}
      },
    };
  }

  async messageDetail(messageId: string): Promise<FeishuMessageDetail> {
    const raw = await this.runner(this.commandArgs([
      "im", "+messages-mget",
      "--message-ids", messageId,
      "--as", "bot",
      "--no-reactions",
      "--json",
    ]));
    return parseFeishuMessageDetail(raw, messageId);
  }

  async replyCard(
    messageId: string,
    card: FeishuReplyCard,
    idempotencyKey: string,
    replyMode: FeishuReplyMode,
  ): Promise<FeishuReplyResult> {
    if (replyMode !== "topic" && replyMode !== "direct") {
      throw new Error("invalid Feishu reply mode");
    }
    const raw = await this.runner(this.commandArgs([
      "im", "+messages-reply",
      "--message-id", messageId,
      "--msg-type", "interactive",
      "--content", JSON.stringify(card),
      ...(replyMode === "topic" ? ["--reply-in-thread"] : []),
      "--idempotency-key", idempotencyKey,
      "--as", "bot",
      "--json",
    ]));
    return { messageId: findReplyMessageId(raw), raw };
  }

  async sendCard(
    chatId: string,
    card: FeishuReplyCard,
    idempotencyKey: string,
  ): Promise<FeishuReplyResult> {
    const raw = await this.runner(this.commandArgs([
      "im", "+messages-send",
      "--chat-id", chatId,
      "--msg-type", "interactive",
      "--content", JSON.stringify(card),
      "--idempotency-key", idempotencyKey,
      "--as", "bot",
      "--json",
    ]));
    return { messageId: findReplyMessageId(raw), raw };
  }

  async addReaction(
    messageId: string,
    emojiType: FeishuReactionEmoji,
  ): Promise<FeishuReactionResult> {
    const raw = await this.runner(this.commandArgs([
      "im", "reactions", "create",
      "--params", JSON.stringify({ message_id: messageId }),
      "--data", JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      "--as", "bot",
      "--json",
    ]));
    return { reactionId: parseFeishuReactionId(raw), raw };
  }

  async deleteReaction(messageId: string, reactionId: string): Promise<void> {
    await this.runner(this.commandArgs([
      "im", "reactions", "delete",
      "--params", JSON.stringify({ message_id: messageId, reaction_id: reactionId }),
      "--as", "bot",
      "--json",
    ]));
  }

  async listGroups(): Promise<FeishuChat[]> {
    const chats = new Map<string, FeishuChat>();
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_FEISHU_GROUP_PAGES; pageIndex++) {
      const args = [
        "im", "+chat-list",
        "--as", "bot",
        "--page-size", "100",
        "--json",
        ...(pageToken ? ["--page-token", pageToken] : []),
      ];
      const page = parseFeishuChatPage(await this.runner(this.commandArgs(args)));
      for (const chat of page.chats) chats.set(chat.chatId, chat);
      if (!page.hasMore) {
        return [...chats.values()].sort((left, right) => left.name.localeCompare(right.name));
      }
      pageToken = page.pageToken;
      if (!pageToken || seenPageTokens.has(pageToken)) {
        throw new Error("Feishu chat list pagination did not advance");
      }
      seenPageTokens.add(pageToken);
    }
    throw new Error("Feishu chat list exceeded the pagination limit");
  }

  private async botIdentity(): Promise<FeishuBotIdentity> {
    if (this.botIdentityCache) return this.botIdentityCache;
    const raw = await this.runner(this.commandArgs([
      "auth", "status", "--json", "--verify",
    ]));
    this.botIdentityCache = parseFeishuBotIdentity(raw);
    return this.botIdentityCache;
  }

  async botOpenId(): Promise<string> {
    return (await this.botIdentity()).openId;
  }

  async botMentionIds(): Promise<string[]> {
    return [...(await this.botIdentity()).mentionIds];
  }
}
