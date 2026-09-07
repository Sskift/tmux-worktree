// xterm emits client-terminal escape sequences for special keys. Pasting
// those bytes directly into a pane bypasses tmux's key translation, so TUIs
// can receive the trailing characters as text (for example "[D" for Left).
// Route exact single-key frames through `send-keys`; arbitrary text and paste
// payloads still use the load-buffer path below. tmux 3.7 renders a DEL byte
// pasted from a buffer as the two visible bytes "^?", so Backspace uses the
// hexadecimal send-keys form. This preserves one literal 0x7f byte without
// relying on tmux's named BSpace lookup.
const TMUX_KEY_BY_RAW_HEX = new Map<string, string>([
  ["1b5b41", "Up"],
  ["1b4f41", "Up"],
  ["1b5b42", "Down"],
  ["1b4f42", "Down"],
  ["1b5b43", "Right"],
  ["1b4f43", "Right"],
  ["1b5b44", "Left"],
  ["1b4f44", "Left"],
  ["1b5b48", "Home"],
  ["1b4f48", "Home"],
  ["1b5b317e", "Home"],
  ["1b5b377e", "Home"],
  ["1b5b46", "End"],
  ["1b4f46", "End"],
  ["1b5b347e", "End"],
  ["1b5b387e", "End"],
  ["1b5b327e", "IC"],
  ["1b5b337e", "DC"],
  ["1b5b357e", "PPage"],
  ["1b5b367e", "NPage"],
  ["1b5b5a", "BTab"],
  ["0d", "Enter"],
  ["09", "Tab"],
  ["1b", "Escape"],
  ["1b4f50", "F1"],
  ["1b4f51", "F2"],
  ["1b4f52", "F3"],
  ["1b4f53", "F4"],
  ["1b5b31357e", "F5"],
  ["1b5b31377e", "F6"],
  ["1b5b31387e", "F7"],
  ["1b5b31397e", "F8"],
  ["1b5b32307e", "F9"],
  ["1b5b32317e", "F10"],
  ["1b5b32337e", "F11"],
  ["1b5b32347e", "F12"],
]);

export type TmuxRawKey =
  | { kind: "named"; value: string }
  | { kind: "hex"; value: string };

export function tmuxKeyForRawInput(data: Buffer): TmuxRawKey | undefined {
  const rawHex = data.toString("hex");
  if (rawHex === "7f") return { kind: "hex", value: rawHex };
  const named = TMUX_KEY_BY_RAW_HEX.get(rawHex);
  return named ? { kind: "named", value: named } : undefined;
}

export function tmuxSendKeyArgs(paneTarget: string, key: TmuxRawKey): string[] {
  return key.kind === "hex"
    ? ["send-keys", "-H", "-t", paneTarget, key.value]
    : ["send-keys", "-t", paneTarget, key.value];
}

export function tmuxSendKeyCommand(paneTarget: string, key: TmuxRawKey): string {
  return tmuxSendKeyArgs(paneTarget, key).join(" ");
}

export function sgrMouseWheelPayload(
  direction: "up" | "down",
  lines: number,
  paneWidth: number,
  paneHeight: number,
): Buffer | undefined {
  if (
    !Number.isSafeInteger(paneWidth)
    || paneWidth < 1
    || !Number.isSafeInteger(paneHeight)
    || paneHeight < 1
  ) {
    return undefined;
  }
  const button = direction === "up" ? 64 : 65;
  const x = Math.ceil(paneWidth / 2);
  const y = Math.ceil(paneHeight / 2);
  return Buffer.from(`\x1b[<${button};${x};${y}M`.repeat(lines), "ascii");
}
