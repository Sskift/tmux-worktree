import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import packageMetadata from "../package.json";
import { FeishuBridge, type CreateFeishuBindingInput } from "./feishuBridge.js";
import { FeishuBridgeStore, feishuBridgePaths, type FeishuBridgePaths } from "./feishuBridgeStorage.js";
import { LarkCliBridgeAdapter, type FeishuEventSubscription, type FeishuLarkAdapter } from "./larkCliBridge.js";
import {
  CanonicalTerminalControlSocketClient,
  type CanonicalTerminalControlClient,
  type CanonicalTerminalLease,
  type CanonicalTerminalOwner,
  type CanonicalTerminalOwnerKind,
} from "./canonicalTerminalControlClient.js";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const INSTANCE_LOCK_STALE_MS = 30_000;
export const FEISHU_BRIDGE_CAPABILITIES = [
  "binding.lifecycle-notices.v1",
  "binding.create.session-summary.v1",
  "binding.target-reconciliation.v1",
  "binding.reply-mode.v1",
] as const;

type FeishuBridgeOperation =
  | "bridge.info"
  | "bridge.snapshot"
  | "bridge.shutdown"
  | "groups.list"
  | "binding.create"
  | "binding.update"
  | "binding.pause"
  | "binding.resume"
  | "binding.repair"
  | "binding.remove"
  | "binding.takeover"
  | "binding.return";

interface BridgeRequest {
  protocolVersion: 1;
  requestId: string;
  operation: FeishuBridgeOperation;
  params: Record<string, unknown>;
}

interface FeishuBridgeInfo {
  daemonVersion: string;
  larkProfile: string;
  capabilities: string[];
}

type BridgeResponse =
  | { protocolVersion: 1; requestId: string; ok: true; result: unknown }
  | { protocolVersion: 1; requestId: string; ok: false; error: { code: string; message: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > 1024) throw new Error(`invalid ${name}`);
  return value;
}

function canonicalOwner(value: unknown, name: string): CanonicalTerminalOwner {
  if (!isRecord(value) || !exactKeys(value, ["kind", "instanceId"])) {
    throw new Error(`invalid ${name}`);
  }
  const kinds: CanonicalTerminalOwnerKind[] = [
    "feishu", "dashboard", "local-cli", "relay-v1", "relay-v2", "tw-serve",
  ];
  if (!kinds.includes(value.kind as CanonicalTerminalOwnerKind)) throw new Error(`invalid ${name}.kind`);
  return {
    kind: value.kind as CanonicalTerminalOwnerKind,
    instanceId: text(value.instanceId, `${name}.instanceId`),
  };
}

function canonicalLease(value: unknown, name: string): CanonicalTerminalLease {
  if (!isRecord(value) || !exactKeys(value, [
    "controlTargetId", "controlEpoch", "leaseId", "fence", "owner", "expiresAt",
  ])) throw new Error(`invalid ${name}`);
  const fence = text(value.fence, `${name}.fence`);
  if (!/^(?:0|[1-9]\d*)$/.test(fence)) throw new Error(`invalid ${name}.fence`);
  const expiresAt = text(value.expiresAt, `${name}.expiresAt`);
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || new Date(expiresAtMs).toISOString() !== expiresAt) {
    throw new Error(`invalid ${name}.expiresAt`);
  }
  return {
    controlTargetId: text(value.controlTargetId, `${name}.controlTargetId`),
    controlEpoch: text(value.controlEpoch, `${name}.controlEpoch`),
    leaseId: text(value.leaseId, `${name}.leaseId`),
    fence,
    owner: canonicalOwner(value.owner, `${name}.owner`),
    expiresAt,
  };
}

function parseRequest(value: unknown): BridgeRequest {
  if (!isRecord(value) || !exactKeys(value, ["protocolVersion", "requestId", "operation", "params"])) {
    throw new Error("Feishu bridge request must be a closed object");
  }
  if (value.protocolVersion !== PROTOCOL_VERSION || !isRecord(value.params)) {
    throw new Error("unsupported Feishu bridge protocol");
  }
  text(value.requestId, "requestId");
  const operations: FeishuBridgeOperation[] = [
    "bridge.info", "bridge.snapshot", "bridge.shutdown", "groups.list", "binding.create", "binding.update", "binding.pause", "binding.resume", "binding.repair", "binding.remove",
    "binding.takeover", "binding.return",
  ];
  if (!operations.includes(value.operation as FeishuBridgeOperation)) throw new Error("unknown Feishu bridge operation");
  return value as unknown as BridgeRequest;
}

async function dispatch(
  bridge: FeishuBridge,
  lark: FeishuLarkAdapter,
  request: BridgeRequest,
  info: FeishuBridgeInfo,
): Promise<unknown> {
  const params = request.params;
  switch (request.operation) {
    case "bridge.info":
      if (!exactKeys(params, [])) throw new Error("invalid bridge.info params");
      return structuredClone(info);
    case "bridge.snapshot":
      if (!exactKeys(params, [])) throw new Error("invalid snapshot params");
      return bridge.snapshot();
    case "bridge.shutdown": {
      if (!exactKeys(params, [])) throw new Error("invalid bridge.shutdown params");
      const snapshot = bridge.snapshot();
      if (snapshot.bindings.length > 0 || snapshot.activeTurns.length > 0) {
        throw new Error("Feishu bridge cannot restart while group bindings exist");
      }
      return { stopping: true };
    }
    case "groups.list":
      if (!exactKeys(params, [])) throw new Error("invalid groups.list params");
      return lark.listGroups();
    case "binding.create": {
      if (!exactKeys(params, ["chatId", "chatName", "sessionName", "createdBy"], [
        "sessionSummary", "allowedSenderIds", "mentionOnly", "replyMode", "dashboardLease",
      ])) throw new Error("invalid binding.create params");
      if (params.allowedSenderIds !== undefined
        && (!Array.isArray(params.allowedSenderIds)
          || !params.allowedSenderIds.every((item) => typeof item === "string"))) {
        throw new Error("invalid allowedSenderIds");
      }
      if (params.mentionOnly !== undefined && typeof params.mentionOnly !== "boolean") {
        throw new Error("invalid mentionOnly");
      }
      if (params.replyMode !== undefined
        && params.replyMode !== "topic"
        && params.replyMode !== "direct") {
        throw new Error("invalid replyMode");
      }
      const dashboardLease = params.dashboardLease === undefined
        ? undefined
        : canonicalLease(params.dashboardLease, "dashboardLease");
      return bridge.createBinding({
        chatId: text(params.chatId, "chatId"),
        chatName: text(params.chatName, "chatName"),
        sessionName: text(params.sessionName, "sessionName"),
        createdBy: text(params.createdBy, "createdBy"),
        ...(params.sessionSummary === undefined ? {} : {
          sessionSummary: text(params.sessionSummary, "sessionSummary"),
        }),
        ...(params.allowedSenderIds === undefined ? {} : {
          allowedSenderIds: params.allowedSenderIds.map((item) => text(item, "allowedSenderId")),
        }),
        ...(params.mentionOnly === undefined ? {} : { mentionOnly: params.mentionOnly }),
        ...(params.replyMode === undefined ? {} : { replyMode: params.replyMode }),
        ...(dashboardLease === undefined ? {} : { dashboardLease }),
      } satisfies CreateFeishuBindingInput);
    }
    case "binding.update":
      if (!exactKeys(params, ["bindingId", "replyMode"])
        || (params.replyMode !== "topic" && params.replyMode !== "direct")) {
        throw new Error("invalid binding.update params");
      }
      return bridge.updateBinding(
        text(params.bindingId, "bindingId"),
        params.replyMode,
      );
    case "binding.pause":
      if (!exactKeys(params, ["bindingId"], ["force"]) || (params.force !== undefined && typeof params.force !== "boolean")) {
        throw new Error("invalid binding.pause params");
      }
      return bridge.pauseBinding(text(params.bindingId, "bindingId"), params.force === true);
    case "binding.resume":
      if (!exactKeys(params, ["bindingId"])) throw new Error("invalid binding.resume params");
      return bridge.resumeBinding(text(params.bindingId, "bindingId"));
    case "binding.repair":
      if (!exactKeys(params, ["bindingId"])) throw new Error("invalid binding.repair params");
      return bridge.repairBinding(text(params.bindingId, "bindingId"));
    case "binding.remove":
      if (!exactKeys(params, ["bindingId"], ["force"]) || (params.force !== undefined && typeof params.force !== "boolean")) {
        throw new Error("invalid binding.remove params");
      }
      await bridge.removeBinding(text(params.bindingId, "bindingId"), params.force === true);
      return { removed: true };
    case "binding.takeover":
      if (!exactKeys(params, ["bindingId", "dashboardOwnerInstance"], ["force"])
        || (params.force !== undefined && typeof params.force !== "boolean")) {
        throw new Error("invalid binding.takeover params");
      }
      return bridge.takeoverBinding(
        text(params.bindingId, "bindingId"),
        text(params.dashboardOwnerInstance, "dashboardOwnerInstance"),
        params.force === true,
      );
    case "binding.return":
      if (!exactKeys(params, ["bindingId", "dashboardLease"])
        || !isRecord(params.dashboardLease)) {
        throw new Error("invalid binding.return params");
      }
      return bridge.returnBinding(
        text(params.bindingId, "bindingId"),
        canonicalLease(params.dashboardLease, "dashboardLease"),
      );
  }
}

function responseError(requestId: string, error: unknown): BridgeResponse {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "BRIDGE_ERROR";
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message: error instanceof Error ? error.message : String(error) },
  };
}

function attachSocket(
  bridge: FeishuBridge,
  lark: FeishuLarkAdapter,
  info: FeishuBridgeInfo,
  socket: Socket,
  onShutdown: () => void,
): void {
  socket.setEncoding("utf8");
  let buffer = "";
  let chain = Promise.resolve();
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
      socket.end(`${JSON.stringify(responseError("invalid", new Error("Feishu bridge frame too large")))}\n`);
      return;
    }
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      chain = chain.then(async () => {
        let requestId = "invalid";
        let response: BridgeResponse;
        let shutdown = false;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (isRecord(parsed) && typeof parsed.requestId === "string") requestId = parsed.requestId;
          const request = parseRequest(parsed);
          shutdown = request.operation === "bridge.shutdown";
          response = {
            protocolVersion: PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            result: await dispatch(bridge, lark, request, info),
          };
        } catch (error) {
          response = responseError(requestId, error);
        }
        const frame = `${JSON.stringify(response)}\n`;
        if (shutdown && response.ok) {
          socket.end(frame, onShutdown);
        } else {
          socket.write(frame);
        }
      });
    }
  });
  socket.on("error", () => {});
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function claimInstance(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  if (existsSync(path)) {
    let validDeadOwner = false;
    try {
      const current = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isRecord(current)
        || !exactKeys(current, ["pid", "startedAt"])
        || !Number.isInteger(current.pid)
        || typeof current.startedAt !== "number"
        || !Number.isFinite(current.startedAt)) {
        throw new Error("malformed Feishu bridge instance lock");
      }
      if (processExists(current.pid as number)) {
        throw new Error("Feishu bridge is already running");
      }
      validDeadOwner = true;
    } catch (error) {
      if (error instanceof Error && error.message === "Feishu bridge is already running") throw error;
      if (Date.now() - statSync(path).mtimeMs <= INSTANCE_LOCK_STALE_MS) {
        throw new Error("Feishu bridge instance lock is malformed; explicit recovery is required");
      }
    }
    if (!validDeadOwner && Date.now() - statSync(path).mtimeMs <= INSTANCE_LOCK_STALE_MS) {
      throw new Error("Feishu bridge instance lock cannot be recovered safely");
    }
    rmSync(path, { force: true });
  }
  writeFileSync(path, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

export class FeishuBridgeServer {
  readonly paths: FeishuBridgePaths;
  readonly bridge: FeishuBridge;
  private readonly lark: FeishuLarkAdapter;
  private readonly info: FeishuBridgeInfo;
  private readonly server: Server;
  private consumer?: FeishuEventSubscription;
  private pollTimer?: ReturnType<typeof setInterval>;
  private renewTimer?: ReturnType<typeof setInterval>;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  readonly stopped: Promise<void>;
  private resolveStopped!: () => void;

  private constructor(options: {
    paths: FeishuBridgePaths;
    bridge: FeishuBridge;
    lark: FeishuLarkAdapter;
    info: FeishuBridgeInfo;
  }) {
    this.paths = options.paths;
    this.bridge = options.bridge;
    this.lark = options.lark;
    this.info = options.info;
    this.stopped = new Promise<void>((resolve) => {
      this.resolveStopped = resolve;
    });
    this.server = createServer((socket) => attachSocket(
      this.bridge,
      this.lark,
      this.info,
      socket,
      () => { void this.stop(); },
    ));
  }

  static async create(options: {
    paths?: FeishuBridgePaths;
    control?: CanonicalTerminalControlClient;
    lark?: FeishuLarkAdapter;
    larkProfile?: string;
    botOpenId?: string;
  } = {}): Promise<FeishuBridgeServer> {
    const paths = options.paths ?? feishuBridgePaths();
    const control = options.control ?? new CanonicalTerminalControlSocketClient();
    const larkProfile = options.larkProfile ?? process.env.TW_FEISHU_LARK_PROFILE ?? "";
    const lark = options.lark ?? new LarkCliBridgeAdapter({
      profile: larkProfile || undefined,
    });
    const bridge = new FeishuBridge({
      control,
      lark,
      store: new FeishuBridgeStore(paths),
      botOpenId: options.botOpenId ?? process.env.TW_FEISHU_BOT_OPEN_ID,
    });
    bridge.initializeAfterRestart();
    return new FeishuBridgeServer({
      paths,
      bridge,
      lark,
      info: {
        daemonVersion: typeof packageMetadata.version === "string" ? packageMetadata.version : "unknown",
        larkProfile,
        capabilities: [...FEISHU_BRIDGE_CAPABILITIES],
      },
    });
  }

  async start(): Promise<void> {
    claimInstance(this.paths.instanceLock);
    mkdirSync(dirname(this.paths.socket), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.paths.socket), 0o700);
    if (existsSync(this.paths.socket)) rmSync(this.paths.socket, { force: true });
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.paths.socket, () => resolve());
      });
      chmodSync(this.paths.socket, 0o600);
      await this.bridge.reconcileBindingTargets();
      this.pollTimer = setInterval(() => {
        void this.bridge.pollTurns().then(
          () => this.bridge.reconcileHandoffs(),
        ).catch((error) => {
          process.stderr.write(`[feishu-bridge] output poll failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      }, 500);
      this.pollTimer.unref();
      this.renewTimer = setInterval(() => {
        void this.bridge.renewLeases().then(
          () => this.bridge.reconcileBindingTargets(),
        ).catch((error) => {
          process.stderr.write(`[feishu-bridge] lease renewal failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      }, 20_000);
      this.renewTimer.unref();
      this.startConsumer();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    try {
      if (this.pollTimer) clearInterval(this.pollTimer);
      if (this.renewTimer) clearInterval(this.renewTimer);
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.consumer?.stop();
      await new Promise<void>((resolve) => {
        if (!this.server.listening) resolve();
        else this.server.close(() => resolve());
      });
      await this.bridge.close();
    } finally {
      rmSync(this.paths.socket, { force: true });
      rmSync(this.paths.instanceLock, { force: true });
      this.resolveStopped();
    }
  }

  private startConsumer(): void {
    if (this.stopping) return;
    this.consumer = this.lark.subscribe((event) => this.bridge.handleEvent(event));
    void this.consumer.done.catch((error) => {
      if (this.stopping) return;
      process.stderr.write(`[feishu-bridge] event consumer stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    }).finally(() => {
      if (this.stopping) return;
      this.restartTimer = setTimeout(() => this.startConsumer(), 2_000);
      this.restartTimer.unref();
    });
  }
}

export class FeishuBridgeClient {
  private readonly socketPath: string;

  constructor(socketPath = feishuBridgePaths().socket) {
    this.socketPath = socketPath;
  }

  request<T = unknown>(operation: FeishuBridgeOperation, params: Record<string, unknown>): Promise<T> {
    const requestId = `bridge-${randomUUID()}`;
    return new Promise<T>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Feishu bridge request timed out"));
      }, REQUEST_TIMEOUT_MS);
      const finish = (error?: Error, result?: T) => {
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(result as T);
      };
      socket.setEncoding("utf8");
      socket.once("error", (error) => finish(new Error(`Feishu bridge unavailable: ${error.message}`)));
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          operation,
          params,
        })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as BridgeResponse;
          if (response.protocolVersion !== PROTOCOL_VERSION || response.requestId !== requestId) {
            finish(new Error("Feishu bridge response correlation failed"));
          } else if (!response.ok) {
            const error = new Error(response.error.message) as Error & { code?: string };
            error.code = response.error.code;
            finish(error);
          } else {
            finish(undefined, response.result as T);
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }
}

function flag(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredFlag(args: string[], name: string): string {
  const value = flag(args, name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

export async function feishuBridgeCmd(args: string[]): Promise<void> {
  const [command] = args;
  if (command === "serve") {
    const server = await FeishuBridgeServer.create({
      larkProfile: flag(args, "--lark-profile"),
    });
    await server.start();
    process.stderr.write(`[feishu-bridge] ready socket=${server.paths.socket}\n`);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void server.stop();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    await server.stopped;
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    return;
  }
  const client = new FeishuBridgeClient();
  switch (command) {
    case "status":
    case "list":
      process.stdout.write(`${JSON.stringify(await client.request("bridge.snapshot", {}), null, 2)}\n`);
      return;
    case "bind":
      process.stdout.write(`${JSON.stringify(await client.request("binding.create", {
        chatId: requiredFlag(args, "--chat-id"),
        chatName: requiredFlag(args, "--chat-name"),
        sessionName: requiredFlag(args, "--session"),
        createdBy: requiredFlag(args, "--created-by"),
        ...(flag(args, "--summary") ? { sessionSummary: flag(args, "--summary") } : {}),
        ...(args.includes("--no-mention-required") ? { mentionOnly: false } : {}),
        ...(flag(args, "--allow-senders") ? {
          allowedSenderIds: flag(args, "--allow-senders")!.split(",").filter(Boolean),
        } : {}),
      }), null, 2)}\n`);
      return;
    case "pause":
      process.stdout.write(`${JSON.stringify(await client.request("binding.pause", {
        bindingId: requiredFlag(args, "--binding"),
        ...(args.includes("--force") ? { force: true } : {}),
      }), null, 2)}\n`);
      return;
    case "resume":
      process.stdout.write(`${JSON.stringify(await client.request("binding.resume", {
        bindingId: requiredFlag(args, "--binding"),
      }), null, 2)}\n`);
      return;
    case "unbind":
      process.stdout.write(`${JSON.stringify(await client.request("binding.remove", {
        bindingId: requiredFlag(args, "--binding"),
        ...(args.includes("--force") ? { force: true } : {}),
      }), null, 2)}\n`);
      return;
    default:
      throw new Error("usage: tw feishu-bridge serve [--lark-profile NAME]|status|bind|pause|resume|unbind");
  }
}
