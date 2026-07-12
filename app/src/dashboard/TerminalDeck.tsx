import type { HostConfig, PlainTerminal, Session } from "../platform";
import { Terminal } from "../Terminal";
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
          const args = isRemote && host
            ? buildSshAttachArgs(host, rawName)
            : ["attach-session", "-t", rawName];
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
                initialHistory={tmuxPreviews[name]}
                onOpenFile={onOpenFile}
              />
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
                    ? buildSshAttachArgs(remoteHost, rawName)
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
                initialHistory={tmuxPreviews[sessionKey]}
                onOpenFile={onOpenFile}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
