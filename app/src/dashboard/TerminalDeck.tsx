import { useEffect, useState } from "react";
import {
  type FeishuBinding,
  type FeishuBridgeSnapshot,
  type FeishuChat,
  type HostConfig,
  type PlainTerminal,
  type Session,
  useDashboardBackend,
} from "../platform";
import { Terminal } from "../Terminal";
import { MenuSelect } from "../MenuSelect";
import type { Selection } from "./model/selection";
import { terminalRawName, terminalSessionKey } from "./model/terminalIdentity";
import { buildSshAttachArgs } from "../terminal/attach";

export {
  sessionDisplayName,
  terminalRawName,
  terminalSessionKey,
} from "./model/terminalIdentity";
export {
  buildSshAttachArgs,
  shellQuoteArg,
  sharedSshConnectionArgs,
} from "../terminal/attach";

type OpenFileHandler = (
  path: string,
  line?: number,
  col?: number,
  hostId?: string | null,
) => void;

type TerminalDeckProps = {
  selection: Selection;
  sessions: Session[];
  terminals: PlainTerminal[];
  hosts: HostConfig[];
  openedSessions: string[];
  openedTerminals: string[];
  cwdsBySession: Record<string, string>;
  tmuxPreviews: Record<string, string>;
  metadataPending: boolean;
  visible: boolean;
  blocked: boolean;
  onOpenFile: OpenFileHandler;
};

/**
 * Keeps every lazily-opened PTY mounted for the lifetime of its catalog entry.
 * Non-terminal views only hide this deck and mark its terminals inactive.
 */
export function TerminalDeck({
  selection,
  sessions,
  terminals,
  hosts,
  openedSessions,
  openedTerminals,
  cwdsBySession,
  tmuxPreviews,
  metadataPending,
  visible,
  blocked,
  onOpenFile,
}: TerminalDeckProps) {
  const dashboardBackend = useDashboardBackend();
  const [feishuSnapshot, setFeishuSnapshot] = useState<FeishuBridgeSnapshot | null>(null);
  const [feishuError, setFeishuError] = useState<string | null>(null);
  const [feishuBusy, setFeishuBusy] = useState(false);
  const [bindingTarget, setBindingTarget] = useState<{ sessionName: string; ptyId: string } | null>(null);
  const [groups, setGroups] = useState<FeishuChat[]>([]);
  const [chatId, setChatId] = useState("");
  const [chatName, setChatName] = useState("");
  const [createdBy, setCreatedBy] = useState("");
  const [attachmentIds, setAttachmentIds] = useState<Record<string, string>>({});

  const setAttachmentId = (key: string, id: string | null) => {
    setAttachmentIds((current) => {
      if (id !== null && current[key] === id) return current;
      if (id === null && !Object.prototype.hasOwnProperty.call(current, key)) return current;
      const next = { ...current };
      if (id === null) delete next[key];
      else next[key] = id;
      return next;
    });
  };

  const refreshFeishu = async () => {
    try {
      const snapshot = await dashboardBackend.feishu.status();
      setFeishuSnapshot(snapshot);
      setFeishuError(null);
    } catch (error) {
      setFeishuError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const snapshot = await dashboardBackend.feishu.status();
        if (!cancelled) {
          setFeishuSnapshot(snapshot);
          setFeishuError(null);
        }
      } catch (error) {
        if (!cancelled) setFeishuError(error instanceof Error ? error.message : String(error));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [dashboardBackend]);

  const bindingFor = (sessionName: string): FeishuBinding | undefined =>
    feishuSnapshot?.bindings.find((binding) => binding.sessionName === sessionName);

  const runFeishuAction = async (operation: () => Promise<unknown>) => {
    setFeishuBusy(true);
    setFeishuError(null);
    try {
      await operation();
      await refreshFeishu();
    } catch (error) {
      setFeishuError(error instanceof Error ? error.message : String(error));
    } finally {
      setFeishuBusy(false);
    }
  };

  const openBinding = (sessionName: string, ptyId: string) => {
    setBindingTarget({ sessionName, ptyId });
    setChatId("");
    setChatName("");
    setFeishuError(null);
    void dashboardBackend.feishu.groups().then(setGroups).catch((error) => {
      setGroups([]);
      setFeishuError(`无法读取机器人群列表，可手动填写：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const lockOverlay = (
    sessionName: string,
    managed: boolean,
    ptyId?: string,
  ) => {
    if (!managed) return null;
    const binding = bindingFor(sessionName);
    const activeTurn = binding
      ? feishuSnapshot?.activeTurns.some((turn) => turn.bindingId === binding.id)
      : false;
    if (!binding) {
      return (
        <div className="terminal-feishu-bar" data-state="unbound">
          <span>{feishuSnapshot ? "Feishu 未绑定" : "正在核对输入所有权…"}</span>
          {feishuSnapshot && (
            <button
              type="button"
              disabled={feishuBusy || !ptyId}
              onClick={() => ptyId && openBinding(sessionName, ptyId)}
            >
              绑定群聊
            </button>
          )}
        </div>
      );
    }
    return (
      <div className="terminal-feishu-bar" data-state={binding.status} role="status">
        <span>
          {binding.status === "active"
            ? `输入已被飞书群「${binding.chatName}」锁定${activeTurn ? "（正在处理一轮）" : ""}`
            : binding.status === "paused"
              ? `飞书群「${binding.chatName}」已暂停，本地拥有输入`
              : binding.status === "pausing"
                ? `正在从飞书群「${binding.chatName}」安全交接…`
                : `飞书绑定需要恢复：${binding.staleReason ?? binding.chatName}`}
        </span>
        {binding.status === "active" && !activeTurn && (
          <button
            type="button"
            disabled={feishuBusy || !ptyId}
            onClick={() => ptyId && void runFeishuAction(() => dashboardBackend.feishu.takeover(binding.id, ptyId))}
          >
            接管并暂停飞书
          </button>
        )}
        {binding.status === "active" && activeTurn && (
          <button
            type="button"
            className="danger"
            disabled={feishuBusy || !ptyId}
            onClick={() => ptyId && void runFeishuAction(() => dashboardBackend.feishu.takeover(binding.id, ptyId, true))}
          >
            强制取消本轮并接管
          </button>
        )}
        {binding.status === "paused" && (
          <button
            type="button"
            disabled={feishuBusy || !ptyId}
            onClick={() => ptyId && void runFeishuAction(() => dashboardBackend.feishu.returnToFeishu(binding.id, ptyId))}
          >
            交还飞书
          </button>
        )}
        {(binding.status === "paused" || binding.status === "stale") && (
          <button
            type="button"
            disabled={feishuBusy}
            onClick={() => void runFeishuAction(() => dashboardBackend.feishu.remove(binding.id, true))}
          >
            解除绑定
          </button>
        )}
        {binding.status === "stale" && (
          <button
            type="button"
            disabled={feishuBusy}
            onClick={() => void runFeishuAction(() => dashboardBackend.feishu.repair(binding.id))}
          >
            检查本地恢复状态
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      className="pane pane--term terminal-deck"
      data-terminal-deck
      aria-hidden={!visible}
      style={{ display: visible ? undefined : "none" }}
    >
      <div className="pane__body pane__body--stack">
        {metadataPending && (
          <div className="pane__hint" data-terminal-pending role="status">
            <strong>Loading workspace details…</strong>
            <span>Waiting for session and host metadata before connecting.</span>
          </div>
        )}
        {openedSessions.map((name) => {
          const session = sessions.find((candidate) => candidate.name === name);
          if (!session) return null;
          const isRemote = session.hostId != null;
          const host = isRemote
            ? hosts.find((candidate) => candidate.id === session.hostId)
            : null;
          if (isRemote && !host) return null;
          const rawName = session.rawName ?? name;
          const command = isRemote && host ? "ssh" : "tmux";
          const controlled = session?.managed === true;
          const args = isRemote && host
            ? buildSshAttachArgs(host, rawName, controlled)
            : controlled
              ? ["attach-session", "-r", "-f", "ignore-size", "-t", rawName]
              : ["attach-session", "-t", rawName];
          const attachmentKey = `session:${name}`;
          const ptyId = attachmentIds[attachmentKey];
          return (
            <div
              key={`s:${name}`}
              className="term-slot"
              data-terminal-slot={`session:${name}`}
              style={{
                display:
                  selection?.kind === "session" && selection.name === name
                    ? "flex"
                    : "none",
              }}
            >
              <Terminal
                cmd={command}
                args={args}
                cwd={isRemote ? undefined : cwdsBySession[name]}
                linkCwd={cwdsBySession[name]}
                active={
                  visible &&
                  !blocked &&
                  selection?.kind === "session" &&
                  selection.name === name
                }
                tmuxSession={name}
                hostId={session?.hostId ?? null}
                controlSession={session.managed ? rawName : undefined}
                controlHostId={session.managed ? session.hostId : undefined}
                onAttachmentIdChange={(id) => setAttachmentId(attachmentKey, id)}
                initialHistory={tmuxPreviews[name]}
                onOpenFile={onOpenFile}
              />
              {!isRemote && lockOverlay(rawName, controlled, ptyId)}
            </div>
          );
        })}
        {openedTerminals.map((id) => {
          const terminal = terminals.find((candidate) => candidate.id === id);
          if (!terminal) return null;
          const remoteHost = terminal.hostId
            ? hosts.find((candidate) => candidate.id === terminal.hostId)
            : null;
          if (terminal.hostId && !remoteHost) return null;
          const rawName = terminalRawName(terminal);
          const sessionKey = terminalSessionKey(terminal);
          const controlled = terminal.managed === true;
          const attachmentKey = `terminal:${id}`;
          const ptyId = attachmentIds[attachmentKey];
          return (
            <div
              key={`t:${id}`}
              className="term-slot"
              data-terminal-slot={`terminal:${id}`}
              style={{
                display:
                  selection?.kind === "terminal" && selection.id === id
                    ? "flex"
                    : "none",
              }}
            >
              <Terminal
                cmd={terminal.hostId ? "ssh" : "tmux"}
                args={
                  terminal.hostId && remoteHost
                    ? buildSshAttachArgs(remoteHost, rawName, terminal.managed === true)
                    : terminal.managed === true
                      ? ["attach-session", "-r", "-f", "ignore-size", "-t", terminal.tmuxName]
                      : ["attach-session", "-t", terminal.tmuxName]
                }
                cwd={terminal.hostId ? undefined : terminal.cwd}
                linkCwd={terminal.cwd}
                active={
                  visible &&
                  !blocked &&
                  selection?.kind === "terminal" &&
                  selection.id === id
                }
                tmuxSession={sessionKey}
                hostId={terminal.hostId ?? null}
                controlSession={terminal.managed ? rawName : undefined}
                controlHostId={terminal.managed ? terminal.hostId : undefined}
                onAttachmentIdChange={(nextId) => setAttachmentId(attachmentKey, nextId)}
                initialHistory={tmuxPreviews[sessionKey]}
                onOpenFile={onOpenFile}
              />
              {!terminal.hostId && lockOverlay(rawName, controlled, ptyId)}
            </div>
          );
        })}
        {bindingTarget && (
          <div className="terminal-feishu-dialog" role="dialog" aria-modal="true" aria-label="绑定飞书群聊">
            <div className="terminal-feishu-dialog__card">
              <strong>绑定飞书群聊</strong>
              <p>终端中完整公开标记内的内容会发送给群内所有成员。相同系统账号仍可用原始 tmux 或低层 RPC 命令绕过产品级输入锁。</p>
              {groups.length > 0 && (
                <label>
                  机器人所在群
                  <MenuSelect
                    ariaLabel="机器人所在群"
                    value={chatId}
                    options={[
                      { value: "", label: "选择群聊…" },
                      ...groups.map((group) => ({ value: group.chatId, label: group.name })),
                    ]}
                    onChange={(value) => {
                      const group = groups.find((candidate) => candidate.chatId === value);
                      setChatId(value);
                      if (group) setChatName(group.name);
                    }}
                  />
                </label>
              )}
              <label>
                Chat ID
                <input value={chatId} onChange={(event) => setChatId(event.target.value)} placeholder="oc_…" />
              </label>
              <label>
                群名称
                <input value={chatName} onChange={(event) => setChatName(event.target.value)} />
              </label>
              <label>
                管理员 Open ID
                <input value={createdBy} onChange={(event) => setCreatedBy(event.target.value)} placeholder="ou_…" />
              </label>
              {feishuError && <p className="terminal-feishu-dialog__error">{feishuError}</p>}
              <div className="terminal-feishu-dialog__actions">
                <button type="button" disabled={feishuBusy} onClick={() => setBindingTarget(null)}>取消</button>
                <button
                  type="button"
                  disabled={feishuBusy || !chatId.trim() || !chatName.trim() || !createdBy.trim()}
                  onClick={() => void runFeishuAction(async () => {
                    await dashboardBackend.feishu.create({
                      chatId: chatId.trim(),
                      chatName: chatName.trim(),
                      sessionName: bindingTarget.sessionName,
                      attachmentId: bindingTarget.ptyId,
                      createdBy: createdBy.trim(),
                      allowedSenderIds: [createdBy.trim()],
                      mentionOnly: true,
                    });
                    setBindingTarget(null);
                  })}
                >
                  确认独占绑定
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
