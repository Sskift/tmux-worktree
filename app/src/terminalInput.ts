/**
 * Mouse and focus reports are terminal-transport metadata, not pane text.
 * Controlled attachments write through tmux paste-buffer, so forwarding these
 * reports as input.raw would paste their escape bytes into the managed pane.
 */
export function isControlledTerminalTransportReport(data: string): boolean {
  return /^(?:(?:\x1b\[<\d+;\d+;\d+[mM])|(?:\x1b\[\d+;\d+;\d+M)|(?:\x1b\[M[\s\S]{3})|(?:\x1b\[[IO]))+$/.test(data);
}

const CONTROLLED_MOUSE_MODES = new Set([
  "9",
  "1000",
  "1002",
  "1003",
  "1004",
  "1005",
  "1006",
  "1015",
  "1016",
]);

/** Keeps tmux's read-only attachment from enabling xterm mouse/focus reports. */
export class ControlledTerminalOutputFilter {
  private pending = "";

  push(data: string): string {
    const input = this.pending + data;
    this.pending = "";
    let output = "";
    let index = 0;
    while (index < input.length) {
      const start = input.indexOf("\x1b", index);
      if (start < 0) {
        output += input.slice(index);
        break;
      }
      output += input.slice(index, start);
      if (start + 1 >= input.length) {
        this.pending = input.slice(start);
        break;
      }
      if (input[start + 1] !== "[") {
        output += "\x1b";
        index = start + 1;
        continue;
      }
      if (start + 2 >= input.length) {
        this.pending = input.slice(start);
        break;
      }
      if (input[start + 2] !== "?") {
        output += "\x1b[";
        index = start + 2;
        continue;
      }

      let finalIndex = start + 3;
      while (finalIndex < input.length && /[0-9;]/.test(input[finalIndex])) {
        finalIndex += 1;
      }
      if (finalIndex >= input.length) {
        this.pending = input.slice(start);
        break;
      }
      const final = input[finalIndex];
      if (final !== "h") {
        output += input.slice(start, finalIndex + 1);
        index = finalIndex + 1;
        continue;
      }
      const rawParams = input.slice(start + 3, finalIndex);
      if (!rawParams) {
        output += input.slice(start, finalIndex + 1);
        index = finalIndex + 1;
        continue;
      }
      const params = rawParams
        .split(";")
        .filter((param) => param && !CONTROLLED_MOUSE_MODES.has(param));
      if (params.length > 0) output += `\x1b[?${params.join(";")}h`;
      index = finalIndex + 1;
    }
    return output;
  }

  flush(): string {
    const pending = this.pending;
    this.pending = "";
    return pending;
  }
}
