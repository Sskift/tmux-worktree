import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  THEME_CHANGED_EVENT,
  getCurrentPalette,
  type TerminalPalette,
} from "./themes";
import "@xterm/xterm/css/xterm.css";

type Props = {
  cmd: string;
  args: string[];
  cwd?: string;
  active?: boolean;
  tmuxSession?: string;
};

export function Terminal({ cmd, args, cwd, active = true, tmuxSession }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<XTerm | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let ptyId: string | null = null;
    let unlistenChunk: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
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
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    let blurHandler: (() => void) | null = null;
    if (tmuxSession) {
      blurHandler = () => {
        invoke("cancel_copy_mode", { name: tmuxSession }).catch(() => {});
      };
      host.addEventListener("focusout", blurHandler);

      term.attachCustomKeyEventHandler((e) => {
        if (e.type === "keydown" && e.metaKey && e.key === "c") {
          if (term.hasSelection()) return true;
          invoke<boolean>("copy_tmux_selection", { name: tmuxSession }).then((copied) => {
            if (!copied) {
              invoke("pty_write", { id: ptyId, data: "\x03" }).catch(() => {});
            }
          }).catch(() => {});
          return false;
        }
        return true;
      });
    }

    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        // ignore — host not yet sized
      }
    };

    safeFit();
    term.focus();

    const onThemeChange = (e: Event) => {
      const detail = (e as CustomEvent<TerminalPalette>).detail;
      if (!detail) return;
      term.options.theme = detail;
    };
    window.addEventListener(THEME_CHANGED_EVENT, onThemeChange);

    const start = async () => {
      try {
        if (tmuxSession) {
          const history = await invoke<string>("capture_pane_history", {
            name: tmuxSession,
          }).catch(() => "");
          if (history) {
            term.write(history + "\r\n");
          }
        }

        const { cols, rows } = term;
        const id = await invoke<string>("pty_open", {
          args: { cmd, args, cwd, cols, rows },
        });
        if (cancelled) {
          await invoke("pty_kill", { id }).catch(() => {});
          return;
        }
        ptyId = id;

        unlistenChunk = await listen<{ id: string; data: string }>(
          `pty:${id}`,
          (e) => term.write(e.payload.data),
        );
        unlistenExit = await listen<{ id: string; code: number }>(
          `pty-exit:${id}`,
          (e) => {
            term.write(`\r\n\x1b[2m[exit ${e.payload.code}]\x1b[0m\r\n`);
          },
        );

        term.onData((data) => {
          if (ptyId) invoke("pty_write", { id: ptyId, data }).catch(() => {});
        });
        term.onResize(({ cols, rows }) => {
          if (ptyId)
            invoke("pty_resize", { id: ptyId, cols, rows }).catch(() => {});
        });
      } catch (e) {
        term.write(`\r\n\x1b[31m[pty error] ${String(e)}\x1b[0m\r\n`);
      }
    };

    start();

    const ro = new ResizeObserver(() => safeFit());
    ro.observe(host);

    return () => {
      cancelled = true;
      ro.disconnect();
      if (blurHandler) host.removeEventListener("focusout", blurHandler);
      window.removeEventListener(THEME_CHANGED_EVENT, onThemeChange);
      unlistenChunk?.();
      unlistenExit?.();
      if (ptyId) invoke("pty_kill", { id: ptyId }).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [cmd, args.join("\x1f"), cwd, tmuxSession]);

  useEffect(() => {
    if (!active) {
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
    if (term.textarea) term.textarea.disabled = false;
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {}
      term.focus();
    });
  }, [active]);

  return <div ref={hostRef} className="term" />;
}
