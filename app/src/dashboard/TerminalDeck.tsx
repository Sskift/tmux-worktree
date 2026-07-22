import { useEffect, useState } from "react";
import {
  type FeishuBinding,
  type FeishuBridgeSnapshot,
  type FeishuChat,
  type FeishuReplyMode,
  type HostConfig,
  type PlainTerminal,
  type Session,
  useDashboardBackend,
} from "../platform";
import { Terminal } from "../Terminal";
import { MenuSelect } from "../MenuSelect";
import type { Selection } from "./model/selection";
import {
  sessionDisplayName,
  terminalRawName,
  terminalSessionKey,
} from "./model/terminalIdentity";
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
  const [bindingTarget, setBindingTarget] = useState<{
    sessionName: string;
    sessionSummary: string;
    ptyId: string;
  } | null>(null);
  const [groups, setGroups] = useState<FeishuChat[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [chatId, setChatId] = useState("");
  const [chatName, setChatName] = useState("");
  const [replyMode, setReplyMode] = useState<FeishuReplyMode>("topic");
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

  const openBinding = (sessionName: string, ptyId: string, sessionSummary: string) => {
    setBindingTarget({ sessionName, ptyId, sessionSummary: sessionSummary.slice(0, 256) });
    setChatId("");
    setChatName("");
    setReplyMode("topic");
    setFeishuError(null);
    setGroups([]);
    setGroupsError(null);
    setGroupsLoading(true);
    void dashboardBackend.feishu.groups().then((nextGroups) => {
      setGroups(nextGroups);
    }).catch((error) => {
      setGroupsError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      setGroupsLoading(false);
    });
  };

  const lockOverlay = (
    sessionName: string,
    managed: boolean,
    ptyId?: string,
    sessionSummary = sessionName,
  ) => {
    if (!managed) return null;
    const binding = bindingFor(sessionName);
    const activeTurn = binding
      ? feishuSnapshot?.activeTurns.some((turn) => turn.bindingId === binding.id)
      : false;
    const activeActivityWatch = binding
      ? ["probing", "armed", "stop-candidate", "sending"].includes(
        binding.activityWatch?.status ?? "",
      )
      : false;
    const activeAgentWork = activeTurn || activeActivityWatch;
    if (!binding) {
      return (
        <div className="terminal-feishu-bar" data-state="unbound">
          <span>
            {feishuSnapshot
              ? "Feishu not linked"
              : feishuError?.includes("FEISHU_PROFILE_NOT_CONFIGURED")
                ? "Feishu bot not configured · Settings › Integrations"
                : feishuError
                  ? "Feishu bridge unavailable"
                  : "Checking input ownership…"}
          </span>
          {feishuSnapshot && (
            <button
              type="button"
              disabled={feishuBusy || !ptyId}
              onClick={() => ptyId && openBinding(sessionName, ptyId, sessionSummary)}
            >
              Link group
            </button>
          )}
        </div>
      );
    }
    return (
      <div className="terminal-feishu-bar" data-state={binding.status} role="status">
        <span>
          {binding.status === "active"
            ? `Input locked by Feishu group “${binding.chatName}”${activeTurn
              ? " (turn in progress)"
              : activeActivityWatch
                ? " (local Agent task in progress; final response will be posted)"
                : ""}`
            : binding.status === "paused"
              ? `Feishu group “${binding.chatName}” is paused; local input is active`
              : binding.status === "pausing"
                ? `Safely handing off from Feishu group “${binding.chatName}”…`
                : `Feishu link needs recovery: ${binding.staleReason ?? binding.chatName}`}
        </span>
        {binding.status === "active" && !activeAgentWork && (
          <button
            type="button"
            disabled={feishuBusy || !ptyId}
            onClick={() => ptyId && void runFeishuAction(() => dashboardBackend.feishu.takeover(binding.id, ptyId))}
          >
            Take over and pause Feishu
          </button>
        )}
        {binding.status === "active" && activeTurn && (
          <button
            type="button"
            className="danger"
            disabled={feishuBusy || !ptyId}
            onClick={() => ptyId && void runFeishuAction(() => dashboardBackend.feishu.takeover(binding.id, ptyId, true))}
          >
            Cancel turn and take over
          </button>
        )}
        {binding.status === "active" && !activeTurn && activeActivityWatch && (
          <button
            type="button"
            className="danger"
            disabled={feishuBusy || !ptyId || binding.activityWatch?.status === "sending"}
            onClick={() => ptyId && void runFeishuAction(() => dashboardBackend.feishu.takeover(binding.id, ptyId, true))}
          >
            Cancel result delivery and take over
          </button>
        )}
        {binding.status === "paused" && (
          <button
            type="button"
            disabled={feishuBusy || !ptyId}
            onClick={() => ptyId && void runFeishuAction(() => dashboardBackend.feishu.returnToFeishu(binding.id, ptyId))}
          >
            Return input to Feishu
          </button>
        )}
        {(binding.status === "paused" || binding.status === "stale") && (
          <button
            type="button"
            disabled={feishuBusy}
            onClick={() => void runFeishuAction(() => dashboardBackend.feishu.remove(binding.id, true))}
          >
            Unlink
          </button>
        )}
        {binding.status === "stale" && (
          <button
            type="button"
            disabled={feishuBusy}
            onClick={() => void runFeishuAction(() => dashboardBackend.feishu.repair(binding.id))}
          >
            Check recovery status
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
              {!isRemote && lockOverlay(
                rawName,
                controlled,
                ptyId,
                session.project
                  ? `${session.project} · ${sessionDisplayName(session)}`
                  : sessionDisplayName(session),
              )}
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
              {!terminal.hostId && lockOverlay(rawName, controlled, ptyId, terminal.label)}
            </div>
          );
        })}
        {bindingTarget && (
          <div className="terminal-feishu-dialog" role="dialog" aria-modal="true" aria-label="Link a Feishu group">
            <div className="terminal-feishu-dialog__card">
              <strong>Link a Feishu group</strong>
              <p>Anyone in the selected group can @ this bot to send one message into the session. Only terminal output explicitly marked as the public reply is sent back to the group.</p>
              <label>
                Bot groups
                <MenuSelect
                  ariaLabel="Bot groups"
                  value={chatId}
                  disabled={groupsLoading || groups.length === 0}
                  options={[
                    {
                      value: "",
                      label: groupsLoading
                        ? "Loading bot groups…"
                        : groupsError
                          ? "Groups unavailable"
                          : groups.length > 0
                            ? "Select a group…"
                            : "No groups visible to this bot",
                    },
                    ...groups.map((group) => {
                      const existing = feishuSnapshot?.bindings.find((binding) => binding.chatId === group.chatId);
                      return {
                        value: group.chatId,
                        label: group.name,
                        ...(existing ? { detail: `Linked to ${existing.sessionName}` } : {}),
                      };
                    }),
                  ]}
                  onChange={(value) => {
                    const group = groups.find((candidate) => candidate.chatId === value);
                    setChatId(value);
                    if (group) {
                      setChatName(group.name);
                    }
                  }}
                />
              </label>
              {groupsError && (
                <p className="terminal-feishu-dialog__error">
                  Could not load this bot's groups. You can still enter the group details manually: {groupsError}
                </p>
              )}
              {!groupsLoading && !groupsError && groups.length === 0 && (
                <p>No group memberships were returned for the selected bot. Add the application bot to a group, then reopen this dialog.</p>
              )}
              <label>
                Chat ID
                <input value={chatId} onChange={(event) => setChatId(event.target.value)} placeholder="oc_…" />
              </label>
              <label>
                Group name
                <input value={chatName} onChange={(event) => setChatName(event.target.value)} />
              </label>
              <label>
                Session summary shown to the group
                <input
                  value={bindingTarget.sessionSummary}
                  maxLength={256}
                  onChange={(event) => setBindingTarget((current) => current
                    ? { ...current, sessionSummary: event.target.value }
                    : current)}
                />
              </label>
              <label>
                Reply placement
                <MenuSelect
                  ariaLabel="Reply placement"
                  value={replyMode}
                  options={[
                    {
                      value: "topic",
                      label: "Topic reply",
                      detail: "Keep each answer inside the question's topic",
                    },
                    {
                      value: "direct",
                      label: "Direct reply",
                      detail: "Post each answer in the group's main timeline",
                    },
                  ]}
                  onChange={(value) => setReplyMode(value === "direct" ? "direct" : "topic")}
                />
              </label>
              {feishuError && <p className="terminal-feishu-dialog__error">{feishuError}</p>}
              <div className="terminal-feishu-dialog__actions">
                <button type="button" disabled={feishuBusy} onClick={() => setBindingTarget(null)}>Cancel</button>
                <button
                  type="button"
                  disabled={feishuBusy
                    || !chatId.trim()
                    || !chatName.trim()
                    || !bindingTarget.sessionSummary.trim()}
                  onClick={() => void runFeishuAction(async () => {
                    const groupOwner = groups.find((group) => group.chatId === chatId.trim())?.ownerId?.trim();
                    await dashboardBackend.feishu.create({
                      chatId: chatId.trim(),
                      chatName: chatName.trim(),
                      sessionName: bindingTarget.sessionName,
                      sessionSummary: bindingTarget.sessionSummary.trim(),
                      attachmentId: bindingTarget.ptyId,
                      createdBy: groupOwner || "local-dashboard",
                      allowedSenderIds: [],
                      mentionOnly: true,
                      replyMode,
                    });
                    setBindingTarget(null);
                  })}
                >
                  Confirm link
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
