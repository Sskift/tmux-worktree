import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm, type ILinkProvider, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useDashboardBackend } from "./platform";
import type { DashboardBackend, PtyConnection, PtyControlStatus, TmuxStatusTheme } from "./platform";
import {
  THEME_CHANGED_EVENT,
  getCurrentPalette,
  type TerminalPalette,
} from "./themes";
import {
  REMOTE_RECONNECT_MAX_ATTEMPTS,
  TMUX_RECONNECT_DELAY_MS,
  remoteReconnectDelayMs,
  shouldReconnectTmuxAttach,
} from "./terminalLifecycle";
import {
  detectLinks,
  resolvePath,
  shouldActivateTerminalLink,
  type LinkMatch,
} from "./linkDetect";
import { isTerminalProtocolReply } from "./terminal/terminalResponses";
import {
  buildLogicalLine,
  getBufferPositionFromMouse,
  getLinkAtPosition,
  getViewportPositionFromMouse,
  sameLink,
  sgrMouseWheel,
  type ResolvedLink,
} from "./terminal/linkDetection";
import { TerminalControlBanner } from "./terminal/TerminalControlBanner";
import { checkFileExists, openUrlInBrowser } from "./linkActions";
import {
  ControlledTerminalOutputFilter,
  isControlledTerminalTransportReport,
} from "./terminalInput";
import "@xterm/xterm/css/xterm.css";

type Props = {
  cmd: string;
  args: string[];
  cwd?: string;
  linkCwd?: string;
  active?: boolean;
  tmuxSession?: string;
  hostId?: string | null;
  controlSession?: string;
  controlHostId?: string | null;
  onAttachmentIdChange?: (id: string | null) => void;
  initialHistory?: string;
  onOpenFile?: (path: string, line?: number, col?: number, hostId?: string | null) => void;
};

function hexColor(value: string, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

function tmuxStatusThemeFromPalette(palette: TerminalPalette): TmuxStatusTheme {
  const background = hexColor(palette.background, "#0d0e10");
  const foreground = hexColor(palette.foreground, "#e6e6e8");
  const surface = hexColor(palette.black, background);
  const dim = hexColor(palette.brightBlack, foreground);
  const accent = hexColor(palette.blue, hexColor(palette.cyan, foreground));
  return {
    statusBg: surface,
    statusFg: foreground,
    activeBg: accent,
    activeFg: background,
    inactiveFg: dim,
    accent,
  };
}

function applyTmuxStatusTheme(
  dashboardBackend: DashboardBackend,
  tmuxSession: string | undefined,
  palette: TerminalPalette,
) {
  if (!tmuxSession) return;
  dashboardBackend.sessions
    .applyTheme(tmuxSession, tmuxStatusThemeFromPalette(palette))
    .catch(() => {});
}

function createPtyId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `pty-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function canTerminalClaimFocus(host: HTMLElement | null): boolean {
  const focused = document.activeElement;
  return (
    focused === null ||
    focused === document.body ||
    focused === document.documentElement ||
    Boolean(host?.contains(focused))
  );
}

export function Terminal({
  cmd,
  args,
  cwd,
  linkCwd,
  active = true,
  tmuxSession,
  hostId,
  controlSession,
  controlHostId,
  onAttachmentIdChange,
  initialHistory,
  onOpenFile,
}: Props) {
  const dashboardBackend = useDashboardBackend();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const ptyConnectionRef = useRef<PtyConnection | null>(null);
  const initialHistoryRef = useRef<string | undefined>(initialHistory);
  const activeRef = useRef(active);
  const linkCwdRef = useRef(linkCwd ?? cwd);
  const onOpenFileRef = useRef(onOpenFile);
  const onAttachmentIdChangeRef = useRef(onAttachmentIdChange);
  const remoteReconnectAttemptRef = useRef(0);
  const [reconnectSeq, setReconnectSeq] = useState(0);
  const [controlStatus, setControlStatus] = useState<PtyControlStatus | null>(null);
  const [controlAction, setControlAction] = useState<"recovery" | null>(null);
  const [controlActionError, setControlActionError] = useState<string | null>(null);
  linkCwdRef.current = linkCwd ?? cwd;
  onOpenFileRef.current = onOpenFile;
  onAttachmentIdChangeRef.current = onAttachmentIdChange;

  useEffect(() => {
    if (initialHistory !== undefined) {
      initialHistoryRef.current = initialHistory;
    }
  }, [initialHistory]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let ptyId: string | null = null;
    let ptyConnection: PtyConnection | null = null;
    let parsingPtyOutput = 0;
    const pendingTerminalReplies: string[] = [];
    const ptyAbort = new AbortController();
    let reconnectTimer: number | null = null;
    let reconnectStabilityTimer: number | null = null;
    let controlStatusTimer: number | null = null;
    let fitAnimationFrame: number | null = null;
    let fitFollowupFrame: number | null = null;
    let lastControlReadOnly: boolean | null = null;
    let lastControlState: PtyControlStatus["state"] | null = null;
    let remoteRetryAvailable = false;
    let cancelled = false;

    const term = new XTerm({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowTransparency: false,
      theme: getCurrentPalette(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    const controlledOutput = controlSession ? new ControlledTerminalOutputFilter() : null;
    term.loadAddon(fit);
    term.open(host);

    const isActionableLink = (link: Pick<LinkMatch, "kind">) =>
      link.kind === "url" || (!!linkCwdRef.current && !!onOpenFileRef.current);

    const openFileLink = (link: Extract<LinkMatch, { kind: "file" }>) => {
      const fileCwd = linkCwdRef.current;
      const openFile = onOpenFileRef.current;
      if (!fileCwd || !openFile) return;
      const resolved = resolvePath(link.path, fileCwd);
      checkFileExists(dashboardBackend, resolved, hostId).then((exists) => {
        if (exists) openFile(resolved, link.line, link.col, hostId);
      });
    };

    // Remote tmux owns ordinary mouse events, so web links also support direct
    // click there. Cmd/Ctrl+click remains available for every terminal link.
    const linkProvider: ILinkProvider = {
      provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
        const logicalLine = buildLogicalLine(term, bufferLineNumber - 1);
        if (!logicalLine) { callback(undefined); return; }

        const detected = detectLinks(logicalLine.text);
        if (detected.length === 0) { callback(undefined); return; }

        const links: ILink[] = [];
        for (const match of detected) {
          if (!isActionableLink(match)) continue;
          const start = logicalLine.charToCell[match.startIndex];
          const end = logicalLine.charToCell[match.endIndex - 1];
          if (!start || !end) continue;
          if (bufferLineNumber < start.y || bufferLineNumber > end.y) continue;
          links.push({
            range: { start, end },
            text: match.text,
            decorations: { underline: true, pointerCursor: true },
            activate(event: MouseEvent, _text: string) {
              if (!shouldActivateTerminalLink(event, match, !!hostId)) return;
              if (match.kind === "url") {
                openUrlInBrowser(dashboardBackend, match.url).catch(() => {});
              } else if (match.kind === "file") {
                openFileLink(match);
              }
            },
          });
        }
        if (links.length === 0) { callback(undefined); return; }
        callback(links);
      },
    };
    term.registerLinkProvider(linkProvider);

    const writePtyOutput = (data: string) => {
      parsingPtyOutput += 1;
      term.write(data, () => {
        parsingPtyOutput = Math.max(0, parsingPtyOutput - 1);
      });
    };

    const dataSubscription = term.onData((data) => {
      if (controlSession && parsingPtyOutput > 0 && isTerminalProtocolReply(data)) {
        if (ptyConnection?.active) {
          ptyConnection.writeTerminalReply(data).catch(() => {});
        } else {
          pendingTerminalReplies.push(data);
        }
        return;
      }
      if (controlSession && isControlledTerminalTransportReport(data)) return;
      if (ptyId) {
        ptyConnection?.write(data).catch(() => {
          ptyConnection?.controlStatus().then(setControlStatus).catch(() => {});
        });
      }
    });

    let pendingLink: ResolvedLink | null = null;
    const consumeLinkMouseEvent = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      term.focus();
    };
    const openResolvedLink = (link: ResolvedLink) => {
      if (link.kind === "url") {
        openUrlInBrowser(dashboardBackend, link.url).catch(() => {});
      } else if (link.kind === "file") {
        openFileLink(link);
      }
    };
    const onLinkMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) {
        pendingLink = null;
        return;
      }
      const pos = getBufferPositionFromMouse(term, event);
      const link = pos ? getLinkAtPosition(term, pos) : null;
      if (!link || !isActionableLink(link) || !shouldActivateTerminalLink(event, link, !!hostId)) {
        pendingLink = null;
        return;
      }
      pendingLink = link;
      consumeLinkMouseEvent(event);
    };
    const onLinkMouseUp = (event: MouseEvent) => {
      const pending = pendingLink;
      pendingLink = null;
      if (event.button !== 0 || !pending || !shouldActivateTerminalLink(event, pending, !!hostId)) return;

      const pos = getBufferPositionFromMouse(term, event);
      const link = pos ? getLinkAtPosition(term, pos) : null;
      consumeLinkMouseEvent(event);
      if (link && sameLink(pending, link)) {
        openResolvedLink(link);
      }
    };
    host.addEventListener("mousedown", onLinkMouseDown, true);
    host.addEventListener("mouseup", onLinkMouseUp, true);

    const routesWheelThroughPty = Boolean(hostId || controlSession);
    let wheelAccum = 0;
    const handlePtyWheel = (event: WheelEvent): boolean => {
      if (!routesWheelThroughPty || !ptyId || event.deltaY === 0) return true;
      const pos = controlSession ? null : getViewportPositionFromMouse(term, event);
      if (!controlSession && !pos) return true;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const cellHeight = Math.max(
        1,
        (term.options.fontSize ?? 13) * (term.options.lineHeight ?? 1.2),
      );
      const deltaLines = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
        ? event.deltaY / cellHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * Math.max(1, term.rows)
          : event.deltaY;
      wheelAccum += deltaLines;

      const steps = Math.min(12, Math.floor(Math.abs(wheelAccum)));
      if (steps <= 0) return false;
      const direction = wheelAccum > 0 ? "down" : "up";
      wheelAccum -= Math.sign(wheelAccum) * steps;

      if (controlSession) {
        ptyConnection?.scroll(direction, steps).catch(() => {
          ptyConnection?.controlStatus().then(setControlStatus).catch(() => {});
        });
      } else {
        const button: 64 | 65 = direction === "down" ? 65 : 64;
        let data = "";
        for (let i = 0; i < steps; i++) {
          data += sgrMouseWheel(button, pos!);
        }
        ptyConnection?.write(data).catch(() => {});
      }
      return false;
    };
    if (routesWheelThroughPty) {
      term.attachCustomWheelEventHandler(handlePtyWheel);
    }

    termRef.current = term;
    fitRef.current = fit;

    let latestSize = { cols: term.cols, rows: term.rows };
    const resizeSubscription = term.onResize(({ cols, rows }) => {
      latestSize = { cols, rows };
      if (ptyId) ptyConnection?.resize(cols, rows).catch(() => {});
    });

    const writePty = (data: string) => {
      if (ptyId) ptyConnection?.write(data).catch(() => {});
    };

    const copyTmuxOrInterrupt = () => {
      if (!tmuxSession) return true;
      if (term.hasSelection()) return true;
      dashboardBackend.sessions.copySelection(tmuxSession).then((copied) => {
        if (!copied) writePty("\x03");
      }).catch(() => writePty("\x03"));
      return false;
    };

    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === "keydown" &&
        e.key === "Enter" &&
        hostId &&
        remoteRetryAvailable
      ) {
        remoteRetryAvailable = false;
        remoteReconnectAttemptRef.current = 0;
        setReconnectSeq((value) => value + 1);
        return false;
      }
      if (e.type === "keydown" && e.key === "Escape" && tmuxSession) {
        // Let ESC reach the PTY so TUIs (vim/less/fzf) receive it, and in
        // parallel ask tmux to exit copy-mode *only if* the pane is actually
        // in a mode (scrolled-up history). When not in copy-mode this is a
        // no-op, so normal apps keep their ESC. Do not swallow the key.
        dashboardBackend.sessions.cancelCopyModeIfActive(tmuxSession).catch(() => {});
        return true;
      }
      if (e.type === "keydown" && e.metaKey && e.key.toLowerCase() === "c") {
        return copyTmuxOrInterrupt();
      }
      return true;
    });

    let blurHandler: (() => void) | null = null;
    if (tmuxSession) {
      blurHandler = () => {
        dashboardBackend.sessions.cancelCopyMode(tmuxSession).catch(() => {});
      };
      host.addEventListener("focusout", blurHandler);
    }

    const safeFit = () => {
      const bounds = host.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return false;
      try {
        fit.fit();
        return true;
      } catch {
        // ignore — host not yet sized
        return false;
      }
    };

    const scheduleStableFit = () => {
      if (fitAnimationFrame !== null) cancelAnimationFrame(fitAnimationFrame);
      if (fitFollowupFrame !== null) cancelAnimationFrame(fitFollowupFrame);
      fitAnimationFrame = requestAnimationFrame(() => {
        fitAnimationFrame = null;
        safeFit();
        // React can reveal the selected slot and settle the workspace grid in
        // separate layout passes. Refit on the following frame so a managed
        // tmux attachment never opens permanently at xterm's 10x4 fallback.
        fitFollowupFrame = requestAnimationFrame(() => {
          fitFollowupFrame = null;
          safeFit();
        });
      });
    };

    const fitBeforeOpen = async () => {
      if (!activeRef.current) return;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          safeFit();
          resolve();
        });
      });
      if (cancelled || !activeRef.current) return;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          safeFit();
          resolve();
        });
      });
    };

    scheduleStableFit();
    if (activeRef.current && canTerminalClaimFocus(host)) term.focus();

    const onThemeChange = (e: Event) => {
      const detail = (e as CustomEvent<TerminalPalette>).detail;
      if (!detail) return;
      if (!activeRef.current) return;
      term.options.theme = detail;
      applyTmuxStatusTheme(dashboardBackend, tmuxSession, detail);
    };
    window.addEventListener(THEME_CHANGED_EVENT, onThemeChange);

    const start = async () => {
      try {
        // Fit before replaying captured output as well as before opening the
        // managed PTY. Otherwise xterm can hard-wrap the snapshot at its
        // fallback geometry and tmux briefly attaches at that stale size.
        await fitBeforeOpen();
        if (cancelled) return;

        if (tmuxSession) {
          const cachedHistory = initialHistoryRef.current;
          const history = cachedHistory !== undefined
            ? cachedHistory
            : await dashboardBackend.sessions.captureHistory(tmuxSession).catch(() => "");
          if (history) {
            const output = history + "\r\n";
            term.write(controlledOutput?.push(output) ?? output);
          }
        }

        const { cols, rows } = term;
        const id = createPtyId();

        ptyConnection = await dashboardBackend.pty.connect(
          {
            id,
            cmd,
            args,
            cwd,
            cols,
            rows,
            controlSession,
            controlHostId: controlHostId ?? undefined,
          },
          {
            onData: (event) => {
              if (cancelled) return;
              const output = controlledOutput?.push(event.data) ?? event.data;
              if (output) writePtyOutput(output);
              if (
                hostId &&
                remoteReconnectAttemptRef.current > 0 &&
                reconnectStabilityTimer === null
              ) {
                // SSH failures can emit stderr before exiting. Only reset the
                // retry budget if the PTY remains alive after producing data.
                reconnectStabilityTimer = window.setTimeout(() => {
                  reconnectStabilityTimer = null;
                  if (!cancelled && ptyId === id) {
                    remoteReconnectAttemptRef.current = 0;
                  }
                }, 2_000);
              }
            },
            onExit: async (event) => {
              if (event.id !== id) return;
              const pendingOutput = controlledOutput?.flush();
              if (pendingOutput) writePtyOutput(pendingOutput);
              ptyId = null;
              onAttachmentIdChangeRef.current?.(null);
              if (reconnectStabilityTimer !== null) {
                window.clearTimeout(reconnectStabilityTimer);
                reconnectStabilityTimer = null;
              }
              let sessionStillExists = false;
              let sessionProbeFailed = false;
              if (tmuxSession) {
                try {
                  sessionStillExists = await dashboardBackend.sessions.exists(tmuxSession);
                } catch {
                  sessionProbeFailed = true;
                }
              }
              if (cancelled) return;
              const remoteReconnectAttempt = hostId
                ? remoteReconnectAttemptRef.current
                : 0;
              if (
                shouldReconnectTmuxAttach({
                  cancelled,
                  hasTmuxSession: !!tmuxSession,
                  sessionStillExists,
                  sessionProbeFailed,
                  isRemote: !!hostId,
                  remoteReconnectAttempt,
                })
              ) {
                const reconnectDelay = hostId
                  ? remoteReconnectDelayMs(remoteReconnectAttempt)
                  : TMUX_RECONNECT_DELAY_MS;
                if (hostId) {
                  remoteReconnectAttemptRef.current = remoteReconnectAttempt + 1;
                }
                const msg = hostId
                  ? `\r\n\x1b[2m[ssh disconnected, reconnecting in ${Math.ceil(reconnectDelay / 1000)}s]\x1b[0m\r\n`
                  : "\r\n\x1b[2m[tmux detached, reconnecting]\x1b[0m\r\n";
                term.write(msg);
                reconnectTimer = window.setTimeout(() => {
                  if (!cancelled) setReconnectSeq((value) => value + 1);
                }, reconnectDelay);
                return;
              }
              if (
                hostId &&
                (sessionStillExists || sessionProbeFailed) &&
                remoteReconnectAttempt >= REMOTE_RECONNECT_MAX_ATTEMPTS
              ) {
                remoteRetryAvailable = true;
                term.write("\r\n\x1b[33m[remote terminal unavailable; press Enter to retry]\x1b[0m\r\n");
                return;
              }
              term.write(`\r\n\x1b[2m[exit ${event.code}]\x1b[0m\r\n`);
            },
          },
          ptyAbort.signal,
        );

        if (cancelled) {
          await ptyConnection.close().catch(() => {});
          return;
        }
        ptyConnectionRef.current = ptyConnection;
        for (const reply of pendingTerminalReplies.splice(0)) {
          await ptyConnection.writeTerminalReply(reply).catch(() => {});
        }
        ptyId = ptyConnection.active ? id : null;
        onAttachmentIdChangeRef.current?.(ptyId);
        if (ptyId && controlSession && !activeRef.current) {
          // TerminalDeck intentionally keeps inactive PTYs mounted for output
          // continuity. Mounted observation must not retain input ownership.
          const released = await ptyConnection.releaseControl().catch(() => null);
          if (released) {
            setControlStatus(released);
            lastControlReadOnly = released.readOnly;
            lastControlState = released.state;
          }
        }
        if (ptyId && controlSession) {
          // Controlled tmux attachments use ignore-size and therefore do not
          // resize the shared window from their read-only PTY. Seed the
          // canonical writer with the latest fitted dimensions so a layout
          // change during open cannot leave tmux at a stale size.
          void ptyConnection.resize(latestSize.cols, latestSize.rows).catch(() => {});
        }
        if (ptyId && controlSession) {
          const pollControlStatus = async () => {
            if (cancelled || !ptyConnection?.active) return;
            if (!activeRef.current) {
              const released = await ptyConnection.releaseControl().catch(() => null);
              if (released) {
                setControlStatus(released);
                lastControlReadOnly = released.readOnly;
                lastControlState = released.state;
              }
              controlStatusTimer = window.setTimeout(pollControlStatus, 1_000);
              return;
            }
            try {
              const nextStatus = await ptyConnection.controlStatus();
              setControlStatus(nextStatus);
              if (lastControlReadOnly === true && !nextStatus.readOnly) {
                void ptyConnection.resize(term.cols, term.rows).catch(() => {});
              }
              lastControlReadOnly = nextStatus.readOnly;
              lastControlState = nextStatus.state;
            } catch {}
            if (!cancelled && ptyConnection?.active) {
              // Only a HELD lease owned by this PTY uses the 20s renewal
              // cadence. FREE is writable-on-demand but still polls quickly so
              // a new Feishu binding becomes visible before the next input.
              const nextPollMs = lastControlState === "HELD" && lastControlReadOnly === false
                ? 20_000
                : 1_000;
              controlStatusTimer = window.setTimeout(pollControlStatus, nextPollMs);
            }
          };
          void pollControlStatus();
        }
      } catch (e) {
        if (cancelled || (e instanceof Error && e.name === "AbortError")) return;
        term.write(`\r\n\x1b[31m[pty error] ${String(e)}\x1b[0m\r\n`);
        if (hostId) {
          remoteRetryAvailable = true;
          term.write("\x1b[33m[press Enter to retry]\x1b[0m\r\n");
        }
      }
    };

    start();

    const ro = new ResizeObserver(() => scheduleStableFit());
    ro.observe(host);
    void document.fonts?.ready.then(() => {
      if (!cancelled) scheduleStableFit();
    });

    return () => {
      cancelled = true;
      ptyAbort.abort();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (reconnectStabilityTimer !== null) window.clearTimeout(reconnectStabilityTimer);
      if (controlStatusTimer !== null) window.clearTimeout(controlStatusTimer);
      if (fitAnimationFrame !== null) cancelAnimationFrame(fitAnimationFrame);
      if (fitFollowupFrame !== null) cancelAnimationFrame(fitFollowupFrame);
      ro.disconnect();
      host.removeEventListener("mousedown", onLinkMouseDown, true);
      host.removeEventListener("mouseup", onLinkMouseUp, true);
      if (blurHandler) host.removeEventListener("focusout", blurHandler);
      window.removeEventListener(THEME_CHANGED_EVENT, onThemeChange);
      resizeSubscription.dispose();
      dataSubscription.dispose();
      void ptyConnection?.close();
      if (ptyConnectionRef.current === ptyConnection) ptyConnectionRef.current = null;
      ptyId = null;
      onAttachmentIdChangeRef.current?.(null);
      setControlStatus(null);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [cmd, args.join("\x1f"), cwd, tmuxSession, hostId, controlSession, controlHostId, reconnectSeq]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      const connection = ptyConnectionRef.current;
      if (controlSession && connection?.active) {
        void connection.releaseControl().then(setControlStatus).catch(() => {});
      }
      const ta = termRef.current?.textarea;
      if (ta) {
        ta.blur();
        ta.disabled = true;
      }
      return;
    }
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const connection = ptyConnectionRef.current;
    if (controlSession && connection?.active) {
      void connection.controlStatus().then(setControlStatus).catch(() => {});
    }
    if (term.textarea) term.textarea.disabled = false;
    const palette = getCurrentPalette();
    term.options.theme = palette;
    applyTmuxStatusTheme(dashboardBackend, tmuxSession, palette);
    let followupFrame: number | null = null;
    const animationFrame = requestAnimationFrame(() => {
      followupFrame = requestAnimationFrame(() => {
        if (!activeRef.current || termRef.current !== term || fitRef.current !== fit) return;
        try {
          fit.fit();
        } catch {}
        if (canTerminalClaimFocus(hostRef.current)) term.focus();
      });
    });
    return () => {
      cancelAnimationFrame(animationFrame);
      if (followupFrame !== null) cancelAnimationFrame(followupFrame);
    };
  }, [active, tmuxSession, controlSession]);

  const requestTakeover = () => {
    const connection = ptyConnectionRef.current;
    if (!connection) return;
    connection.requestTakeover().then((nextStatus) => {
      setControlStatus(nextStatus);
      const term = termRef.current;
      if (term && !nextStatus.readOnly) {
        void connection.resize(term.cols, term.rows).catch(() => {});
      }
    }).catch(() => {});
  };

  const requestRecovery = async () => {
    if (controlAction) return;
    const connection = ptyConnectionRef.current;
    if (!connection) {
      setControlActionError("The terminal connection is no longer available.");
      return;
    }
    setControlActionError(null);
    let confirmed = false;
    try {
      confirmed = await dashboardBackend.dialog.confirm({
        title: "Recover local terminal input?",
        message:
          "The previous input lease expired or its controller restarted. Recovery advances the input fence and treats any uncertain in-flight operation as already attempted. Continue only if no other controller is still writing to this terminal.",
      });
    } catch (error) {
      setControlActionError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!confirmed) return;
    if (!connection.active) {
      setControlActionError("The terminal connection closed before recovery started.");
      return;
    }
    setControlAction("recovery");
    try {
      const nextStatus = await connection.requestRecovery();
      setControlStatus(nextStatus);
      setControlActionError(nextStatus.message ?? null);
      const term = termRef.current;
      if (term && !nextStatus.readOnly) {
        void connection.resize(term.cols, term.rows).catch(() => {});
      }
    } catch (error) {
      setControlActionError(error instanceof Error ? error.message : String(error));
      try {
        setControlStatus(await connection.controlStatus());
      } catch {}
    } finally {
      setControlAction(null);
    }
  };

  return (
    <div className="term-shell">
      <div ref={hostRef} className="term" />
      {controlStatus?.controlled && controlStatus.readOnly && (
        <TerminalControlBanner
          status={controlStatus}
          recoveryPending={controlAction === "recovery"}
          actionError={controlActionError}
          onTakeover={requestTakeover}
          onRecover={() => void requestRecovery()}
        />
      )}
    </div>
  );
}
