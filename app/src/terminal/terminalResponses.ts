const MAX_TERMINAL_REPLY_BYTES = 8 * 1024;

const OSC_REPLY_CODES = new Set([
  "4", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "50", "52",
]);

function csiReply(sequence: string): boolean {
  if (sequence.length < 2) return false;
  const final = sequence[sequence.length - 1];
  const body = sequence.slice(0, -1);
  if (!/^[\x20-\x3f]*$/.test(body)) return false;

  if (final === "c") return /^[?>=][0-9;:]*$/.test(body);
  if (final === "R") return /^\??[0-9]+;[0-9]+$/.test(body);
  if (final === "n") return /^(?:0|\?(?:0|10|11|13|20|21|27(?:;[0-9]+)*|53))$/.test(body);
  if (final === "t") return /^(?:[12]|[34689];[0-9]+;[0-9]+)$/.test(body);
  if (final === "x") return /^[23](?:;[0-9]+){6}$/.test(body);
  if (final === "y") return /^\??[0-9;]+\$$/.test(body);
  if (final === "u") return /^\?[0-9;]+$/.test(body);
  return false;
}

function stringReply(kind: string, payload: string): boolean {
  if (kind === "]") {
    const separator = payload.indexOf(";");
    const code = separator < 0 ? payload : payload.slice(0, separator);
    return separator > 0 && OSC_REPLY_CODES.has(code);
  }
  if (kind === "P") {
    return /^(?:[01][+$]r|>\|)/.test(payload);
  }
  return false;
}

function consumeTerminalReply(data: string, offset: number): number {
  if (data.charCodeAt(offset) !== 0x1b || offset + 2 >= data.length) return -1;
  const kind = data[offset + 1];
  if (kind === "[") {
    for (let index = offset + 2; index < data.length; index++) {
      const code = data.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) {
        return csiReply(data.slice(offset + 2, index + 1)) ? index + 1 : -1;
      }
      if (code < 0x20 || code > 0x3f) return -1;
    }
    return -1;
  }
  if (kind !== "]" && kind !== "P") return -1;

  for (let index = offset + 2; index < data.length; index++) {
    if (kind === "]" && data.charCodeAt(index) === 0x07) {
      return stringReply(kind, data.slice(offset + 2, index)) ? index + 1 : -1;
    }
    if (data.charCodeAt(index) === 0x1b && data[index + 1] === "\\") {
      return stringReply(kind, data.slice(offset + 2, index)) ? index + 2 : -1;
    }
  }
  return -1;
}

/**
 * Recognizes terminal-emulator replies that belong to the read-only tmux
 * attachment. These must return to that client instead of becoming pane input.
 */
export function isTerminalProtocolReply(data: string): boolean {
  if (!data || new TextEncoder().encode(data).byteLength > MAX_TERMINAL_REPLY_BYTES) return false;
  let offset = 0;
  while (offset < data.length) {
    offset = consumeTerminalReply(data, offset);
    if (offset < 0) return false;
  }
  return true;
}
