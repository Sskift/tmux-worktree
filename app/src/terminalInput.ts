export type TerminalEscapeAction = "ignore" | "focus-terminal" | "cancel-copy-mode" | "send-to-terminal";

export function terminalEscapeAction({
  key,
  type,
  terminalActive,
  terminalFocused,
  targetHandlesEscape = false,
  tmuxPaneInMode,
}: {
  key: string;
  type: string;
  terminalActive: boolean;
  terminalFocused: boolean;
  targetHandlesEscape?: boolean;
  tmuxPaneInMode?: boolean;
}): TerminalEscapeAction {
  if (type !== "keydown" || key !== "Escape" || !terminalActive) return "ignore";
  if (targetHandlesEscape) return "ignore";
  if (!terminalFocused) return "focus-terminal";
  if (tmuxPaneInMode === true) return "cancel-copy-mode";
  return "send-to-terminal";
}
