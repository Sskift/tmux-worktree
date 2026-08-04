import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TerminalControlLease, TerminalControlOwner } from "./protocol";
import { TerminalControlProtocolError } from "./protocol";
import { requestTerminalControl } from "./client";
import { terminalControlSocketPath } from "./store";

type TargetResolution = {
  controlTargetId: string;
};

type LeaseResult = {
  lease: TerminalControlLease;
};

type HandoffResult = {
  ownership: {
    handoffId?: string;
  };
};

const CONTROLLED_ATTACH_PROXY = String.raw`
import base64
import errno
import fcntl
import json
import os
import re
import select
import signal
import socket
import struct
import sys
import termios
import time
import tty
import uuid

MAX_FRAME = 384 * 1024
config_path = sys.argv[1]
with open(config_path, "r", encoding="utf-8") as handle:
    config = json.load(handle)
try:
    os.unlink(config_path)
except OSError:
    pass

socket_path = config["socketPath"]
lease = config.get("lease")
session_name = config["sessionName"]
tmux_bin = config["tmuxBin"]
stdin_fd = sys.stdin.fileno()
stdout_fd = sys.stdout.fileno()
original_termios = None
stop = False
resize_pending = True
operation_index = 0
writable = lease is not None
next_renewal = time.monotonic() + 20.0

def notice(message):
    os.write(stdout_fd, ("\r\n\x1b[33m[tw control] " + message + "\x1b[0m\r\n").encode("utf-8", "replace"))

def request(kind, **fields):
    envelope = {
        "protocolVersion": 1,
        "requestId": str(uuid.uuid4()),
        "type": kind,
    }
    envelope.update(fields)
    payload = (json.dumps(envelope, separators=(",", ":")) + "\n").encode("utf-8")
    peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    peer.settimeout(10.0)
    try:
        peer.connect(socket_path)
        peer.sendall(payload)
        response = bytearray()
        while b"\n" not in response:
            chunk = peer.recv(65536)
            if not chunk:
                raise RuntimeError("terminal-control closed without a response")
            response.extend(chunk)
            if len(response) > MAX_FRAME:
                raise RuntimeError("terminal-control response exceeded the frame limit")
        decoded = json.loads(bytes(response).split(b"\n", 1)[0].decode("utf-8"))
        if decoded.get("requestId") != envelope["requestId"] or decoded.get("protocolVersion") != 1:
            raise RuntimeError("terminal-control response correlation failed")
        if not decoded.get("ok"):
            error = decoded.get("error") or {}
            raise RuntimeError(str(error.get("code", "INTERNAL")) + ": " + str(error.get("message", "request failed")))
        return decoded.get("result")
    finally:
        peer.close()

def operation_id(kind):
    global operation_index
    operation_index += 1
    return "local-attach:" + kind + ":" + str(operation_index) + ":" + str(uuid.uuid4())

def controlled_input(data):
    global writable
    if not writable or not data:
        if data:
            notice("read-only: terminal input ownership is held elsewhere")
        return
    try:
        request(
            "input.raw",
            lease=lease,
            operationId=operation_id("raw"),
            pane="0",
            dataBase64=base64.b64encode(data).decode("ascii"),
        )
    except Exception as error:
        writable = False
        notice("input rejected; attachment is now read-only (" + str(error) + ")")

def csi_reply(sequence):
    if len(sequence) < 2:
        return False
    final = sequence[-1:]
    body = sequence[:-1]
    if re.fullmatch(br"[\x20-\x3f]*", body) is None:
        return False
    if final == b"c":
        return re.fullmatch(br"[?>=][0-9;:]*", body) is not None
    if final == b"R":
        return re.fullmatch(br"\??[0-9]+;[0-9]+", body) is not None
    if final == b"n":
        return re.fullmatch(br"(?:0|\?(?:0|10|11|13|20|21|27(?:;[0-9]+)*|53))", body) is not None
    if final == b"t":
        return re.fullmatch(br"(?:[12]|[34689];[0-9]+;[0-9]+)", body) is not None
    if final == b"x":
        return re.fullmatch(br"[23](?:;[0-9]+){6}", body) is not None
    if final == b"y":
        return re.fullmatch(br"\??[0-9;]+\$", body) is not None
    if final == b"u":
        return re.fullmatch(br"\?[0-9;]+", body) is not None
    return False

def string_reply(kind, payload):
    if kind == b"]":
        code = payload.split(b";", 1)[0]
        return b";" in payload and code in {
            b"4", b"10", b"11", b"12", b"13", b"14", b"15", b"16",
            b"17", b"18", b"19", b"50", b"52",
        }
    if kind == b"P":
        return payload.startswith((b"1+r", b"0+r", b"1$r", b"0$r", b">|"))
    return False

def terminal_reply_end(data, offset):
    if offset + 2 >= len(data) or data[offset:offset + 1] != b"\x1b":
        return None
    kind = data[offset + 1:offset + 2]
    if kind == b"[":
        for index in range(offset + 2, len(data)):
            byte = data[index]
            if 0x40 <= byte <= 0x7e:
                return index + 1 if csi_reply(data[offset + 2:index + 1]) else None
            if not 0x20 <= byte <= 0x3f:
                return None
        return None
    if kind not in (b"]", b"P"):
        return None
    for index in range(offset + 2, len(data)):
        if kind == b"]" and data[index] == 0x07:
            return index + 1 if string_reply(kind, data[offset + 2:index]) else None
        if data[index:index + 2] == b"\x1b\\":
            return index + 2 if string_reply(kind, data[offset + 2:index]) else None
    return None

def route_terminal_input(data, master_fd):
    # tmux asks the real terminal emulator for device/cursor/color state while
    # attaching. Those replies belong to the read-only tmux client; treating
    # them as user bytes would inject strings such as DA2 into the managed pane.
    cursor = 0
    user_start = 0
    while cursor < len(data):
        end = terminal_reply_end(data, cursor)
        if end is None:
            cursor += 1
            continue
        controlled_input(data[user_start:cursor])
        os.write(master_fd, data[cursor:end])
        cursor = end
        user_start = end
    controlled_input(data[user_start:])

def renew_lease():
    global lease, writable, next_renewal
    if not writable or lease is None or time.monotonic() < next_renewal:
        return
    try:
        result = request("lease.renew", lease=lease)
        lease = result["lease"]
        next_renewal = time.monotonic() + 20.0
    except Exception as error:
        writable = False
        notice("ownership liveness renewal failed; attachment is now read-only (" + str(error) + ")")

def terminal_size():
    try:
        size = os.get_terminal_size(stdin_fd)
        return max(20, size.columns), max(5, size.lines)
    except OSError:
        return 80, 24

def resize_attachment(master_fd):
    global writable
    cols, rows = terminal_size()
    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    if not writable:
        return
    try:
        request(
            "input.resize",
            lease=lease,
            operationId=operation_id("resize"),
            pane="0",
            cols=cols,
            rows=rows,
        )
    except Exception as error:
        writable = False
        notice("resize rejected; attachment is now read-only (" + str(error) + ")")

def on_stop(_signum, _frame):
    global stop
    stop = True

def on_resize(_signum, _frame):
    global resize_pending
    resize_pending = True

signal.signal(signal.SIGINT, on_stop)
signal.signal(signal.SIGTERM, on_stop)
signal.signal(signal.SIGHUP, on_stop)
signal.signal(signal.SIGWINCH, on_resize)

pid, master_fd = os.forkpty()
if pid == 0:
    os.execv(tmux_bin, [tmux_bin, "attach-session", "-r", "-f", "ignore-size", "-t", "=" + session_name])

if os.isatty(stdin_fd):
    original_termios = termios.tcgetattr(stdin_fd)
    tty.setraw(stdin_fd)

notice("controlled attach; press Ctrl-] to detach" + ("" if writable else " (read-only)"))
try:
    while not stop:
        renew_lease()
        if resize_pending:
            resize_pending = False
            resize_attachment(master_fd)
        readable, _, _ = select.select([master_fd, stdin_fd], [], [], 0.25)
        if master_fd in readable:
            try:
                output = os.read(master_fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not output:
                break
            os.write(stdout_fd, output)
        if stdin_fd in readable:
            data = os.read(stdin_fd, 65536)
            if not data:
                break
            if b"\x1d" in data:
                before, _, _after = data.partition(b"\x1d")
                route_terminal_input(before, master_fd)
                break
            route_terminal_input(data, master_fd)
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended == pid:
            pid = 0
            break
finally:
    if original_termios is not None:
        termios.tcsetattr(stdin_fd, termios.TCSADRAIN, original_termios)
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
    os.close(master_fd)
`;

async function waitForTakeover(
  controlTargetId: string,
  owner: TerminalControlOwner,
  interrupted: () => boolean,
): Promise<TerminalControlLease> {
  process.stderr.write("等待当前 Feishu owner 完成安全暂停…按 Ctrl-C 撤回请求。\n");
  while (true) {
    if (interrupted()) throw new Error("takeover wait interrupted");
    try {
      const acquired = await requestTerminalControl<LeaseResult>({
        type: "lease.acquire",
        controlTargetId,
        owner,
      });
      return acquired.lease;
    } catch (error) {
      if (!(error instanceof TerminalControlProtocolError) || error.code !== "HANDOFF_PENDING") throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

export async function runControlledAttach(options: {
  sessionName: string;
  tmuxBin: string;
  takeover: boolean;
}): Promise<number> {
  const owner: TerminalControlOwner = {
    kind: "local-cli",
    instanceId: `local-cli:${process.pid}:${randomUUID()}`,
  };
  const resolved = await requestTerminalControl<TargetResolution>({
    type: "target.resolve",
    sessionName: options.sessionName,
  });
  let lease: TerminalControlLease | undefined;
  try {
    try {
      lease = (await requestTerminalControl<LeaseResult>({
        type: "lease.acquire",
        controlTargetId: resolved.controlTargetId,
        owner,
      })).lease;
    } catch (error) {
      if (!(error instanceof TerminalControlProtocolError) || error.code !== "PERMISSION_DENIED") throw error;
      if (options.takeover) {
        const handoff = await requestTerminalControl<HandoffResult>({
          type: "handoff.begin",
          controlTargetId: resolved.controlTargetId,
          nextOwner: owner,
        });
        const handoffId = handoff.ownership.handoffId;
        if (!handoffId) throw new Error("terminal-control did not return a pending handoffId");
        let interrupted = false;
        const onInterrupt = () => { interrupted = true; };
        process.once("SIGINT", onInterrupt);
        process.once("SIGTERM", onInterrupt);
        process.once("SIGHUP", onInterrupt);
        try {
          lease = await waitForTakeover(resolved.controlTargetId, owner, () => interrupted);
        } catch (waitError) {
          const withdrawn = await requestTerminalControl({
            type: "handoff.withdraw",
            controlTargetId: resolved.controlTargetId,
            handoffId,
            nextOwner: owner,
          }).then(() => true, () => false);
          if (!withdrawn) {
            const committed = await requestTerminalControl<LeaseResult>({
              type: "lease.acquire",
              controlTargetId: resolved.controlTargetId,
              owner,
            }).catch(() => undefined);
            if (committed?.lease) {
              await requestTerminalControl({
                type: "lease.release",
                lease: committed.lease,
              }).catch(() => undefined);
            }
          }
          throw waitError;
        } finally {
          process.off("SIGINT", onInterrupt);
          process.off("SIGTERM", onInterrupt);
          process.off("SIGHUP", onInterrupt);
        }
      } else {
        process.stderr.write(`当前 terminal input 由其他入口持有；${options.sessionName} 将以只读方式打开。\n`);
      }
    }

    const home = join(homedir(), ".tmux-worktree");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const tempDir = mkdtempSync(join(home, ".controlled-attach-"));
    const configPath = join(tempDir, "config.json");
    try {
      writeFileSync(configPath, JSON.stringify({
        socketPath: terminalControlSocketPath(),
        sessionName: options.sessionName,
        tmuxBin: options.tmuxBin,
        lease,
      }), { mode: 0o600, flag: "wx" });
      const result = spawnSync("python3", ["-u", "-c", CONTROLLED_ATTACH_PROXY, configPath], {
        stdio: "inherit",
      });
      if (result.error) throw result.error;
      if (result.signal) return 128;
      return result.status ?? 1;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } finally {
    if (lease) {
      await requestTerminalControl({ type: "lease.release", lease }).catch(() => undefined);
    }
  }
}
