export type ThemeId =
  | "warp"
  | "dracula"
  | "kaboo"
  | "bluearchive"
  | "ournotes"
  | "prts"
  | "cyberpunk"
  | "zzz"
  | "eva"
  | "fallout"
  | "gruvbox-dark"
  | "doupo"
  | "xianni"
  | "f1"
  | "jianlai"
  | "cultivation"
  | "naruto"
  | "idolmaster"
  | "genshin"
  | "asoul"
  | "chiikawa"
  | "garupa"
  | "pokemon"
  | "spongebob";

export type TerminalPalette = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

export type Theme = {
  id: ThemeId;
  label: string;
  ui: {
    "--bg": string;
    "--bg-1": string;
    "--bg-2": string;
    "--bg-3": string;
    "--line": string;
    "--line-2": string;
    "--text": string;
    "--text-dim": string;
    "--text-faint": string;
    "--accent-a": string;
    "--accent-b": string;
    "--accent-c": string;
  };
  term: TerminalPalette;
};

export const THEMES: Record<ThemeId, Theme> = {
  warp: {
    id: "warp",
    label: "warp",
    ui: {
      "--bg": "#0d0e10",
      "--bg-1": "#14161a",
      "--bg-2": "#1a1d23",
      "--bg-3": "#22262e",
      "--line": "rgba(255, 255, 255, 0.06)",
      "--line-2": "rgba(255, 255, 255, 0.1)",
      "--text": "#e6e6e8",
      "--text-dim": "#9598a3",
      "--text-faint": "#5a5d68",
      "--accent-a": "#b794f6",
      "--accent-b": "#f687b3",
      "--accent-c": "#f6ad55",
    },
    term: {
      background: "#0d0e10",
      foreground: "#e6e6e8",
      cursor: "#b794f6",
      cursorAccent: "#0d0e10",
      selectionBackground: "rgba(183, 148, 246, 0.3)",
      black: "#1a1d23",
      red: "#ff8272",
      green: "#9ae6b4",
      yellow: "#f6ad55",
      blue: "#90cdf4",
      magenta: "#d6bcfa",
      cyan: "#81e6d9",
      white: "#e6e6e8",
      brightBlack: "#5a5d68",
      brightRed: "#feb2b2",
      brightGreen: "#9ae6b4",
      brightYellow: "#fbd38d",
      brightBlue: "#90cdf4",
      brightMagenta: "#b794f6",
      brightCyan: "#81e6d9",
      brightWhite: "#ffffff",
    },
  },
  dracula: {
    id: "dracula",
    label: "dracula",
    ui: {
      "--bg": "#282a36",
      "--bg-1": "#21222c",
      "--bg-2": "#2e303e",
      "--bg-3": "#383a4d",
      "--line": "rgba(248, 248, 242, 0.08)",
      "--line-2": "rgba(248, 248, 242, 0.14)",
      "--text": "#f8f8f2",
      "--text-dim": "#bdbecb",
      "--text-faint": "#6272a4",
      "--accent-a": "#bd93f9",
      "--accent-b": "#ff79c6",
      "--accent-c": "#ffb86c",
    },
    term: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#ff79c6",
      cursorAccent: "#282a36",
      selectionBackground: "rgba(189, 147, 249, 0.35)",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  kaboo: {
    id: "kaboo",
    label: "kaboo",
    ui: {
      "--bg": "#050505",
      "--bg-1": "#0f0f0f",
      "--bg-2": "#171717",
      "--bg-3": "#212121",
      "--line": "rgba(232, 232, 232, 0.07)",
      "--line-2": "rgba(232, 232, 232, 0.13)",
      "--text": "#e8e8e8",
      "--text-dim": "#737373",
      "--text-faint": "#454545",
      "--accent-a": "#60d29d",
      "--accent-b": "#75a8ff",
      "--accent-c": "#f3b944",
    },
    term: {
      background: "#050505",
      foreground: "#ebebeb",
      cursor: "#60d29d",
      cursorAccent: "#050505",
      selectionBackground: "rgba(96, 210, 157, 0.3)",
      black: "#212121",
      red: "#e56c6c",
      green: "#63eead",
      yellow: "#eebf63",
      blue: "#6396ee",
      magenta: "#e56cbd",
      cyan: "#6cd5e5",
      white: "#cccccc",
      brightBlack: "#5c5c5c",
      brightRed: "#f18e8e",
      brightGreen: "#87f7c3",
      brightYellow: "#f7d287",
      brightBlue: "#87b0f7",
      brightMagenta: "#f18ed0",
      brightCyan: "#8ee4f1",
      brightWhite: "#f5f5f5",
    },
  },
  bluearchive: {
    id: "bluearchive",
    label: "blue archive",
    ui: {
      "--bg": "#0f1a2e",
      "--bg-1": "#14233e",
      "--bg-2": "#182a49",
      "--bg-3": "#1d3359",
      "--line": "rgba(245, 245, 245, 0.07)",
      "--line-2": "rgba(245, 245, 245, 0.13)",
      "--text": "#f5f5f5",
      "--text-dim": "#c2c2c2",
      "--text-faint": "#777b84",
      "--accent-a": "#005aad",
      "--accent-b": "#f3cc3f",
      "--accent-c": "#f3cc3f",
    },
    term: {
      background: "#0f1a2e",
      foreground: "#f5f5f5",
      cursor: "#005aad",
      cursorAccent: "#0f1a2e",
      selectionBackground: "rgba(0, 90, 173, 0.3)",
      black: "#1c2026",
      red: "#e56c6c",
      green: "#6ce598",
      yellow: "#eed063",
      blue: "#63abee",
      magenta: "#e56cbd",
      cyan: "#6cd5e5",
      white: "#c4cad4",
      brightBlack: "#4d586a",
      brightRed: "#f18e8e",
      brightGreen: "#8ef1b2",
      brightYellow: "#f7df87",
      brightBlue: "#87c1f7",
      brightMagenta: "#f18ed0",
      brightCyan: "#8ee4f1",
      brightWhite: "#f3f4f6",
    },
  },
  ournotes: {
    id: "ournotes",
    label: "ournotes",
    ui: {
      "--bg": "#131b2a",
      "--bg-1": "#192438",
      "--bg-2": "#1e2b43",
      "--bg-3": "#243451",
      "--line": "rgba(245, 245, 245, 0.07)",
      "--line-2": "rgba(245, 245, 245, 0.13)",
      "--text": "#f5f5f5",
      "--text-dim": "#c2c2c2",
      "--text-faint": "#797c82",
      "--accent-a": "#3488bc",
      "--accent-b": "#cf7db3",
      "--accent-c": "#ec7486",
    },
    term: {
      background: "#131b2a",
      foreground: "#f5f5f5",
      cursor: "#3488bc",
      cursorAccent: "#131b2a",
      selectionBackground: "rgba(52, 136, 188, 0.3)",
      black: "#1c2026",
      red: "#ee6378",
      green: "#6ce598",
      yellow: "#e5c76c",
      blue: "#63b8ee",
      magenta: "#ee63bf",
      cyan: "#6cd5e5",
      white: "#c4cad4",
      brightBlack: "#4d576a",
      brightRed: "#f78798",
      brightGreen: "#8ef1b2",
      brightYellow: "#f1d88e",
      brightBlue: "#87ccf7",
      brightMagenta: "#f787d2",
      brightCyan: "#8ee4f1",
      brightWhite: "#f3f4f6",
    },
  },
  prts: {
    id: "prts",
    label: "prts",
    ui: {
      "--bg": "#060c13",
      "--bg-1": "#0b1622",
      "--bg-2": "#0f1d2e",
      "--bg-3": "#14273d",
      "--line": "rgba(221, 242, 248, 0.07)",
      "--line-2": "rgba(221, 242, 248, 0.13)",
      "--text": "#ddf2f8",
      "--text-dim": "#89a3b3",
      "--text-faint": "#526470",
      "--accent-a": "#10d2f9",
      "--accent-b": "#fb8823",
      "--accent-c": "#499ef3",
    },
    term: {
      background: "#060c13",
      foreground: "#ddf2f8",
      cursor: "#10d2f9",
      cursorAccent: "#060c13",
      selectionBackground: "rgba(16, 210, 249, 0.3)",
      black: "#1c2126",
      red: "#e56c6c",
      green: "#6ce598",
      yellow: "#eea463",
      blue: "#63a8ee",
      magenta: "#e56cbd",
      cyan: "#63d7ee",
      white: "#c4cbd4",
      brightBlack: "#4d5a6a",
      brightRed: "#f18e8e",
      brightGreen: "#8ef1b2",
      brightYellow: "#f7bc87",
      brightBlue: "#87bff7",
      brightMagenta: "#f18ed0",
      brightCyan: "#87e5f7",
      brightWhite: "#f3f5f6",
    },
  },
  cyberpunk: {
    id: "cyberpunk",
    label: "cyberpunk",
    ui: {
      "--bg": "#070712",
      "--bg-1": "#0d0d21",
      "--bg-2": "#12122b",
      "--bg-3": "#18183a",
      "--line": "rgba(194, 238, 244, 0.07)",
      "--line-2": "rgba(194, 238, 244, 0.13)",
      "--text": "#c2eef4",
      "--text-dim": "#7ea5b4",
      "--text-faint": "#4c6370",
      "--accent-a": "#fbeb0e",
      "--accent-b": "#0ae7ff",
      "--accent-c": "#ff3399",
    },
    term: {
      background: "#070712",
      foreground: "#c2eef4",
      cursor: "#fbeb0e",
      cursorAccent: "#070712",
      selectionBackground: "rgba(251, 235, 14, 0.3)",
      black: "#1c1c26",
      red: "#e56c6c",
      green: "#6ce598",
      yellow: "#eee463",
      blue: "#6ca4e5",
      magenta: "#ee63a8",
      cyan: "#63e0ee",
      white: "#c4c4d4",
      brightBlack: "#4d4d6a",
      brightRed: "#f18e8e",
      brightGreen: "#8ef1b2",
      brightYellow: "#f7f087",
      brightBlue: "#8ebcf1",
      brightMagenta: "#f787bf",
      brightCyan: "#87ecf7",
      brightWhite: "#f3f3f6",
    },
  },
  zzz: {
    id: "zzz",
    label: "zzz",
    ui: {
      "--bg": "#101019",
      "--bg-1": "#171726",
      "--bg-2": "#1d1d2f",
      "--bg-3": "#25253c",
      "--line": "rgba(235, 251, 187, 0.07)",
      "--line-2": "rgba(235, 251, 187, 0.13)",
      "--text": "#ebfbbb",
      "--text-dim": "#a993b4",
      "--text-faint": "#695c73",
      "--accent-a": "#c7f53d",
      "--accent-b": "#ffd83d",
      "--accent-c": "#b347d7",
    },
    term: {
      background: "#101019",
      foreground: "#ebfbbb",
      cursor: "#c7f53d",
      cursorAccent: "#101019",
      selectionBackground: "rgba(199, 245, 61, 0.3)",
      black: "#1c1c26",
      red: "#e56c6c",
      green: "#6ce598",
      yellow: "#cbee63",
      blue: "#6ca4e5",
      magenta: "#cb63ee",
      cyan: "#6cd5e5",
      white: "#c5c5d3",
      brightBlack: "#4f4f69",
      brightRed: "#f18e8e",
      brightGreen: "#8ef1b2",
      brightYellow: "#dbf787",
      brightBlue: "#8ebcf1",
      brightMagenta: "#db87f7",
      brightCyan: "#8ee4f1",
      brightWhite: "#f3f3f6",
    },
  },
  eva: {
    id: "eva",
    label: "eva",
    ui: {
      "--bg": "#070b12",
      "--bg-1": "#0d1421",
      "--bg-2": "#111a2c",
      "--bg-3": "#17233b",
      "--line": "rgba(221, 242, 207, 0.07)",
      "--line-2": "rgba(221, 242, 207, 0.13)",
      "--text": "#ddf2cf",
      "--text-dim": "#97b493",
      "--text-faint": "#5b6d5d",
      "--accent-a": "#80f862",
      "--accent-b": "#ff8629",
      "--accent-c": "#ef4d5d",
    },
    term: {
      background: "#070b12",
      foreground: "#ddf2cf",
      cursor: "#80f862",
      cursorAccent: "#070b12",
      selectionBackground: "rgba(128, 248, 98, 0.3)",
      black: "#1c1f26",
      red: "#ee6371",
      green: "#7fee63",
      yellow: "#ee9f63",
      blue: "#6ca4e5",
      magenta: "#e56cbd",
      cyan: "#6cd5e5",
      white: "#c4c9d4",
      brightBlack: "#4d576a",
      brightRed: "#f78792",
      brightGreen: "#9ef787",
      brightYellow: "#f7b887",
      brightBlue: "#8ebcf1",
      brightMagenta: "#f18ed0",
      brightCyan: "#8ee4f1",
      brightWhite: "#f3f4f6",
    },
  },
  fallout: {
    id: "fallout",
    label: "fallout",
    ui: {
      "--bg": "#09110b",
      "--bg-1": "#101e15",
      "--bg-2": "#15281b",
      "--bg-3": "#1c3624",
      "--line": "rgba(161, 247, 190, 0.07)",
      "--line-2": "rgba(161, 247, 190, 0.13)",
      "--text": "#a1f7be",
      "--text-dim": "#6fae84",
      "--text-faint": "#446c51",
      "--accent-a": "#14f558",
      "--accent-b": "#fbc123",
      "--accent-c": "#23c791",
    },
    term: {
      background: "#09110b",
      foreground: "#a1f7be",
      cursor: "#14f558",
      cursorAccent: "#09110b",
      selectionBackground: "rgba(20, 245, 88, 0.3)",
      black: "#1c261f",
      red: "#e56c6c",
      green: "#63ee8d",
      yellow: "#eec963",
      blue: "#6ca4e5",
      magenta: "#e56cbd",
      cyan: "#63eebf",
      white: "#c4d4c9",
      brightBlack: "#4d6a57",
      brightRed: "#f18e8e",
      brightGreen: "#87f7a9",
      brightYellow: "#f7d987",
      brightBlue: "#8ebcf1",
      brightMagenta: "#f18ed0",
      brightCyan: "#87f7d2",
      brightWhite: "#f3f6f4",
    },
  },
  "gruvbox-dark": {
    id: "gruvbox-dark",
    label: "gruvbox",
    ui: {
      "--bg": "#282828",
      "--bg-1": "#1d2021",
      "--bg-2": "#32302f",
      "--bg-3": "#3c3836",
      "--line": "rgba(235, 219, 178, 0.08)",
      "--line-2": "rgba(235, 219, 178, 0.14)",
      "--text": "#ebdbb2",
      "--text-dim": "#bdae93",
      "--text-faint": "#928374",
      "--accent-a": "#fabd2f",
      "--accent-b": "#fb4934",
      "--accent-c": "#b8bb26",
    },
    term: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#fabd2f",
      cursorAccent: "#282828",
      selectionBackground: "rgba(250, 189, 47, 0.3)",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
  },
  doupo: {
    id: "doupo",
    label: "doupo",
    ui: {
      "--bg": "#1b140d",
      "--bg-1": "#291e14",
      "--bg-2": "#332519",
      "--bg-3": "#412f20",
      "--line": "rgba(243, 235, 221, 0.07)",
      "--line-2": "rgba(243, 235, 221, 0.13)",
      "--text": "#f3ebdd",
      "--text-dim": "#b0a28d",
      "--text-faint": "#716657",
      "--accent-a": "#f07b38",
      "--accent-b": "#31bcd8",
      "--accent-c": "#f2c636",
    },
    term: {
      background: "#1b140d",
      foreground: "#f3ebdd",
      cursor: "#f07b38",
      cursorAccent: "#1b140d",
      selectionBackground: "rgba(240, 123, 56, 0.3)",
      black: "#26211c",
      red: "#ee9663",
      green: "#6ce598",
      yellow: "#eecd63",
      blue: "#6ca4e5",
      magenta: "#e56cbd",
      cyan: "#63d7ee",
      white: "#d4cbc4",
      brightBlack: "#6a5b4d",
      brightRed: "#f7b087",
      brightGreen: "#8ef1b2",
      brightYellow: "#f7dd87",
      brightBlue: "#8ebcf1",
      brightMagenta: "#f18ed0",
      brightCyan: "#87e5f7",
      brightWhite: "#f6f5f3",
    },
  },
  xianni: {
    id: "xianni",
    label: "xianni",
    ui: {
      "--bg": "#0e0b0c",
      "--bg-1": "#1a1416",
      "--bg-2": "#221b1d",
      "--bg-3": "#2e2426",
      "--line": "rgba(241, 233, 218, 0.07)",
      "--line-2": "rgba(241, 233, 218, 0.13)",
      "--text": "#f1e9da",
      "--text-dim": "#b4a893",
      "--text-faint": "#6e665a",
      "--accent-a": "#b71f2e",
      "--accent-b": "#d6a743",
      "--accent-c": "#9b2736",
    },
    term: {
      background: "#0e0b0c",
      foreground: "#f1e9da",
      cursor: "#b71f2e",
      cursorAccent: "#0e0b0c",
      selectionBackground: "rgba(183, 31, 46, 0.3)",
      black: "#241f20",
      red: "#ee6371",
      green: "#6ce598",
      yellow: "#eec263",
      blue: "#6ca4e5",
      magenta: "#ee6375",
      cyan: "#6cd5e5",
      white: "#d0c8ca",
      brightBlack: "#625558",
      brightRed: "#f78792",
      brightGreen: "#8ef1b2",
      brightYellow: "#f7d487",
      brightBlue: "#8ebcf1",
      brightMagenta: "#f78796",
      brightCyan: "#8ee4f1",
      brightWhite: "#f6f4f4",
    },
  },
  f1: {
    id: "f1",
    label: "f1",
    ui: {
      "--bg": "#150a0a",
      "--bg-1": "#221111",
      "--bg-2": "#2d1616",
      "--bg-3": "#3b1c1c",
      "--line": "rgba(247, 241, 232, 0.07)",
      "--line-2": "rgba(247, 241, 232, 0.13)",
      "--text": "#f7f1e8",
      "--text-dim": "#c9baa6",
      "--text-faint": "#7d7064",
      "--accent-a": "#d20f0f",
      "--accent-b": "#ffc800",
      "--accent-c": "#c7c7c7",
    },
    term: {
      background: "#150a0a",
      foreground: "#f7f1e8",
      cursor: "#d20f0f",
      cursorAccent: "#150a0a",
      selectionBackground: "rgba(210, 15, 15, 0.3)",
      black: "#261c1c",
      red: "#ee6363",
      green: "#6ce598",
      yellow: "#eed063",
      blue: "#6ca4e5",
      magenta: "#e56cbd",
      cyan: "#6cd5e5",
      white: "#d4c4c4",
      brightBlack: "#6a4d4d",
      brightRed: "#f78787",
      brightGreen: "#8ef1b2",
      brightYellow: "#f7df87",
      brightBlue: "#8ebcf1",
      brightMagenta: "#f18ed0",
      brightCyan: "#8ee4f1",
      brightWhite: "#f6f3f3",
    },
  },
  jianlai: {
    id: "jianlai",
    label: "jianlai",
    ui: {
      "--bg": "#f2eee3",
      "--bg-1": "#ebe5d6",
      "--bg-2": "#e6dfcb",
      "--bg-3": "#e0d6be",
      "--line": "rgba(36, 51, 47, 0.1)",
      "--line-2": "rgba(36, 51, 47, 0.16)",
      "--text": "#24332f",
      "--text-dim": "#5c7069",
      "--text-faint": "#9ba59c",
      "--accent-a": "#396a5a",
      "--accent-b": "#2b4a6e",
      "--accent-c": "#76a795",
    },
    term: {
      background: "#f2eee3",
      foreground: "#24332f",
      cursor: "#396a5a",
      cursorAccent: "#f2eee3",
      selectionBackground: "rgba(57, 106, 90, 0.3)",
      black: "#474233",
      red: "#b42d2d",
      green: "#22bf8a",
      yellow: "#b4922d",
      blue: "#226bbf",
      magenta: "#b42d87",
      cyan: "#22bf85",
      white: "#bfb8a6",
      brightBlack: "#887e63",
      brightRed: "#d53434",
      brightGreen: "#28e2a4",
      brightYellow: "#d5ad34",
      brightBlue: "#287ee2",
      brightMagenta: "#d534a0",
      brightCyan: "#28e29d",
      brightWhite: "#eae7e1",
    },
  },
  cultivation: {
    id: "cultivation",
    label: "cultivation",
    ui: {
      "--bg": "#f4f2eb",
      "--bg-1": "#ede9de",
      "--bg-2": "#e7e2d5",
      "--bg-3": "#e0d9c8",
      "--line": "rgba(34, 30, 17, 0.1)",
      "--line-2": "rgba(34, 30, 17, 0.16)",
      "--text": "#221e11",
      "--text-dim": "#746c58",
      "--text-faint": "#aaa496",
      "--accent-a": "#34936f",
      "--accent-b": "#e6af37",
      "--accent-c": "#3195c4",
    },
    term: {
      background: "#f4f2eb",
      foreground: "#221e11",
      cursor: "#34936f",
      cursorAccent: "#f4f2eb",
      selectionBackground: "rgba(52, 147, 111, 0.3)",
      black: "#474233",
      red: "#b42d2d",
      green: "#22bf83",
      yellow: "#bf8d22",
      blue: "#2d6cb4",
      magenta: "#b42d87",
      cyan: "#228dbf",
      white: "#bfb8a6",
      brightBlack: "#887e63",
      brightRed: "#d53434",
      brightGreen: "#28e29a",
      brightYellow: "#e2a728",
      brightBlue: "#347fd5",
      brightMagenta: "#d534a0",
      brightCyan: "#28a7e2",
      brightWhite: "#eae7e1",
    },
  },
  naruto: {
    id: "naruto",
    label: "naruto",
    ui: {
      "--bg": "#fdf8f2",
      "--bg-1": "#faeee1",
      "--bg-2": "#f7e7d4",
      "--bg-3": "#f4ddc2",
      "--line": "rgba(58, 37, 24, 0.1)",
      "--line-2": "rgba(58, 37, 24, 0.16)",
      "--text": "#3a2518",
      "--text-dim": "#7c685a",
      "--text-faint": "#b2a49a",
      "--accent-a": "#e95d0c",
      "--accent-b": "#df2a2a",
      "--accent-c": "#389f6b",
    },
    term: {
      background: "#fdf8f2",
      foreground: "#3a2518",
      cursor: "#e95d0c",
      cursorAccent: "#fdf8f2",
      selectionBackground: "rgba(233, 93, 12, 0.3)",
      black: "#473e33",
      red: "#bf5b22",
      green: "#22bf70",
      yellow: "#b4922d",
      blue: "#2d6cb4",
      magenta: "#bf2222",
      cyan: "#2da2b4",
      white: "#bfb3a6",
      brightBlack: "#887763",
      brightRed: "#e26c28",
      brightGreen: "#28e285",
      brightYellow: "#d5ad34",
      brightBlue: "#347fd5",
      brightMagenta: "#e22828",
      brightCyan: "#34c0d5",
      brightWhite: "#eae6e1",
    },
  },
  idolmaster: {
    id: "idolmaster",
    label: "idolm@ster",
    ui: {
      "--bg": "#f9f6f1",
      "--bg-1": "#f2eee3",
      "--bg-2": "#eee7d8",
      "--bg-3": "#e7dfca",
      "--line": "rgba(30, 35, 51, 0.1)",
      "--line-2": "rgba(30, 35, 51, 0.16)",
      "--text": "#1e2333",
      "--text-dim": "#5d6479",
      "--text-faint": "#9fa1ab",
      "--accent-a": "#ce2759",
      "--accent-b": "#292e3d",
      "--accent-c": "#e2b03c",
    },
    term: {
      background: "#f9f6f1",
      foreground: "#1e2333",
      cursor: "#ce2759",
      cursorAccent: "#f9f6f1",
      selectionBackground: "rgba(206, 39, 89, 0.3)",
      black: "#474133",
      red: "#bf2251",
      green: "#2db45e",
      yellow: "#bf9022",
      blue: "#2246bf",
      magenta: "#b42d87",
      cyan: "#2da2b4",
      white: "#bfb7a6",
      brightBlack: "#887d63",
      brightRed: "#e2285f",
      brightGreen: "#34d56f",
      brightYellow: "#e2aa28",
      brightBlue: "#2853e2",
      brightMagenta: "#d534a0",
      brightCyan: "#34c0d5",
      brightWhite: "#eae7e1",
    },
  },
  genshin: {
    id: "genshin",
    label: "genshin",
    ui: {
      "--bg": "#f2f6fd",
      "--bg-1": "#e0ebfa",
      "--bg-2": "#d3e2f8",
      "--bg-3": "#c2d6f5",
      "--line": "rgba(28, 39, 59, 0.1)",
      "--line-2": "rgba(28, 39, 59, 0.16)",
      "--text": "#1c273b",
      "--text-dim": "#56637b",
      "--text-faint": "#98a1b2",
      "--accent-a": "#2087b6",
      "--accent-b": "#e7b540",
      "--accent-c": "#31a573",
    },
    term: {
      background: "#f2f6fd",
      foreground: "#1c273b",
      cursor: "#2087b6",
      cursorAccent: "#f2f6fd",
      selectionBackground: "rgba(32, 135, 182, 0.3)",
      black: "#333b47",
      red: "#b42d2d",
      green: "#22bf7b",
      yellow: "#bf9022",
      blue: "#2d6cb4",
      magenta: "#b42d87",
      cyan: "#228dbf",
      white: "#a6b0bf",
      brightBlack: "#637288",
      brightRed: "#d53434",
      brightGreen: "#28e291",
      brightYellow: "#e2aa28",
      brightBlue: "#347fd5",
      brightMagenta: "#d534a0",
      brightCyan: "#28a7e2",
      brightWhite: "#e1e5ea",
    },
  },
  asoul: {
    id: "asoul",
    label: "a-soul",
    ui: {
      "--bg": "#f5fbff",
      "--bg-1": "#e0f2ff",
      "--bg-2": "#d1ecff",
      "--bg-3": "#bde3ff",
      "--line": "rgba(24, 36, 68, 0.1)",
      "--line-2": "rgba(24, 36, 68, 0.16)",
      "--text": "#182444",
      "--text-dim": "#586589",
      "--text-faint": "#9aa4bb",
      "--accent-a": "#12b3f8",
      "--accent-b": "#f8629e",
      "--accent-c": "#ffca38",
    },
    term: {
      background: "#f5fbff",
      foreground: "#182444",
      cursor: "#12b3f8",
      cursorAccent: "#f5fbff",
      selectionBackground: "rgba(18, 179, 248, 0.3)",
      black: "#333f47",
      red: "#b42d2d",
      green: "#2db45e",
      yellow: "#bf9522",
      blue: "#2d6cb4",
      magenta: "#bf2260",
      cyan: "#2290bf",
      white: "#a6b5bf",
      brightBlack: "#637888",
      brightRed: "#d53434",
      brightGreen: "#34d56f",
      brightYellow: "#e2b028",
      brightBlue: "#347fd5",
      brightMagenta: "#e22872",
      brightCyan: "#28aae2",
      brightWhite: "#e1e6ea",
    },
  },
  chiikawa: {
    id: "chiikawa",
    label: "chiikawa",
    ui: {
      "--bg": "#f2f9fd",
      "--bg-1": "#e0f0fb",
      "--bg-2": "#d2e9f9",
      "--bg-3": "#c0e1f6",
      "--line": "rgba(39, 50, 73, 0.1)",
      "--line-2": "rgba(39, 50, 73, 0.16)",
      "--text": "#273249",
      "--text-dim": "#5e6a82",
      "--text-faint": "#9ca6b6",
      "--accent-a": "#3b7d9b",
      "--accent-b": "#fad889",
      "--accent-c": "#ea7b8a",
    },
    term: {
      background: "#f2f9fd",
      foreground: "#273249",
      cursor: "#3b7d9b",
      cursorAccent: "#f2f9fd",
      selectionBackground: "rgba(59, 125, 155, 0.3)",
      black: "#333f47",
      red: "#bf2237",
      green: "#2db45e",
      yellow: "#bf9022",
      blue: "#2d6cb4",
      magenta: "#b42d87",
      cyan: "#228dbf",
      white: "#a6b5bf",
      brightBlack: "#637988",
      brightRed: "#e22840",
      brightGreen: "#34d56f",
      brightYellow: "#e2aa28",
      brightBlue: "#347fd5",
      brightMagenta: "#d534a0",
      brightCyan: "#28a7e2",
      brightWhite: "#e1e6ea",
    },
  },
  garupa: {
    id: "garupa",
    label: "garupa",
    ui: {
      "--bg": "#f6fafd",
      "--bg-1": "#e5f0fa",
      "--bg-2": "#d8e8f8",
      "--bg-3": "#c7def5",
      "--line": "rgba(28, 37, 63, 0.1)",
      "--line-2": "rgba(28, 37, 63, 0.16)",
      "--text": "#1c253f",
      "--text-dim": "#545c78",
      "--text-faint": "#989eb0",
      "--accent-a": "#f1226e",
      "--accent-b": "#12d0ed",
      "--accent-c": "#fbbd2d",
    },
    term: {
      background: "#f6fafd",
      foreground: "#1c253f",
      cursor: "#f1226e",
      cursorAccent: "#f6fafd",
      selectionBackground: "rgba(241, 34, 110, 0.3)",
      black: "#333d47",
      red: "#b42d2d",
      green: "#2db45e",
      yellow: "#bf9022",
      blue: "#2d6cb4",
      magenta: "#bf225b",
      cyan: "#22aabf",
      white: "#a6b3bf",
      brightBlack: "#637588",
      brightRed: "#d53434",
      brightGreen: "#34d56f",
      brightYellow: "#e2aa28",
      brightBlue: "#347fd5",
      brightMagenta: "#e2286c",
      brightCyan: "#28c9e2",
      brightWhite: "#e1e6ea",
    },
  },
  pokemon: {
    id: "pokemon",
    label: "pokémon",
    ui: {
      "--bg": "#edf5fc",
      "--bg-1": "#dcebf9",
      "--bg-2": "#cfe3f7",
      "--bg-3": "#bdd9f4",
      "--line": "rgba(9, 21, 42, 0.1)",
      "--line-2": "rgba(9, 21, 42, 0.16)",
      "--text": "#09152a",
      "--text-dim": "#303d55",
      "--text-faint": "#7f8a9b",
      "--accent-a": "#c31824",
      "--accent-b": "#0c43a1",
      "--accent-c": "#face1e",
    },
    term: {
      background: "#edf5fc",
      foreground: "#09152a",
      cursor: "#c31824",
      cursorAccent: "#edf5fc",
      selectionBackground: "rgba(195, 24, 36, 0.3)",
      black: "#333d47",
      red: "#bf222c",
      green: "#2db45e",
      yellow: "#bf9f22",
      blue: "#225bbf",
      magenta: "#b42d87",
      cyan: "#2da2b4",
      white: "#a6b3bf",
      brightBlack: "#637588",
      brightRed: "#e22834",
      brightGreen: "#34d56f",
      brightYellow: "#e2bc28",
      brightBlue: "#286ce2",
      brightMagenta: "#d534a0",
      brightCyan: "#34c0d5",
      brightWhite: "#e1e6ea",
    },
  },
  spongebob: {
    id: "spongebob",
    label: "spongebob",
    ui: {
      "--bg": "#e3f8fc",
      "--bg-1": "#d1f3fa",
      "--bg-2": "#c3f0f9",
      "--bg-3": "#b0ebf7",
      "--line": "rgba(16, 43, 60, 0.1)",
      "--line-2": "rgba(16, 43, 60, 0.16)",
      "--text": "#102b3c",
      "--text-dim": "#406377",
      "--text-faint": "#84a2af",
      "--accent-a": "#fdc12b",
      "--accent-b": "#10bbd5",
      "--accent-c": "#ee6398",
    },
    term: {
      background: "#e3f8fc",
      foreground: "#102b3c",
      cursor: "#fdc12b",
      cursorAccent: "#e3f8fc",
      selectionBackground: "rgba(253, 193, 43, 0.3)",
      black: "#334447",
      red: "#b42d2d",
      green: "#2db45e",
      yellow: "#bf9222",
      blue: "#2d6cb4",
      magenta: "#bf225e",
      cyan: "#22aabf",
      white: "#a6bbbf",
      brightBlack: "#638288",
      brightRed: "#d53434",
      brightGreen: "#34d56f",
      brightYellow: "#e2ad28",
      brightBlue: "#347fd5",
      brightMagenta: "#e2286f",
      brightCyan: "#28c9e2",
      brightWhite: "#e1e8ea",
    },
  },
};

const STORAGE_KEY = "tw-dashboard:theme";
export const THEME_CHANGED_EVENT = "tw-dashboard:theme-changed";

export function loadTheme(): ThemeId {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && stored in THEMES) return stored as ThemeId;
  return "warp";
}

let currentTheme: ThemeId = "warp";

export function getCurrentPalette(): TerminalPalette {
  return THEMES[currentTheme].term;
}

function toRgba(color: string, alpha: number) {
  const hex = color.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const rgb = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgb) {
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  }

  return `rgba(255, 255, 255, ${alpha})`;
}

// ─── contrast-aware color derivation ───
// Status colors and accent-as-text were originally hardcoded for dark themes,
// so on light themes they became light-on-light and vanished. We instead derive
// readable variants at apply time: parse the color, and if its WCAG contrast
// against the actual background is too low, blend it toward black (on light bg)
// or white (on dark bg) until it clears the target. One place fixes every theme.

type RGB = [number, number, number];

function parseRgb(color: string): RGB {
  const hex = color.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return [
      parseInt(hex[0] + hex[0], 16),
      parseInt(hex[1] + hex[1], 16),
      parseInt(hex[2] + hex[2], 16),
    ];
  }
  const m = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return [+m[1], +m[2], +m[3]];
  return [255, 255, 255];
}

function relLuminance([r, g, b]: RGB): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(a: RGB, b: RGB): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function toHex([r, g, b]: RGB): string {
  const h = (v: number) => v.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

const isLightBg = (bg: RGB) => relLuminance(bg) > 0.4;

/** Return `color` adjusted to meet `target` contrast against `bg`, by blending
 *  toward black (light bg) or white (dark bg). Already-readable colors are
 *  returned unchanged so vivid themes keep their character. */
function ink(color: string, bg: RGB, target = 4.5): string {
  const base = parseRgb(color);
  if (contrastRatio(base, bg) >= target) return toHex(base);
  const towards: RGB = isLightBg(bg) ? [0, 0, 0] : [255, 255, 255];
  let best = base;
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    best = mix(base, towards, t);
    if (contrastRatio(best, bg) >= target) break;
  }
  return toHex(best);
}

/** Compute all derived CSS custom properties for a theme. Single source of
 *  truth shared by applyTheme() (runtime) and the offline preview generator. */
export function deriveThemeVars(theme: Theme): Record<string, string> {
  const ui = theme.ui;
  const bg = parseRgb(ui["--bg"]);
  // The raised surface is the closest background to foreground text in both
  // dark and light palettes, so meeting contrast there also covers the flatter
  // sidebar, header, and workspace surfaces.
  const chromeSurface = parseRgb(ui["--bg-3"]);
  const light = isLightBg(bg);
  const text = parseRgb(ui["--text"]);
  const textDim = parseRgb(ui["--text-dim"]);
  const accent = parseRgb(ui["--accent-a"]);
  const vars: Record<string, string> = {
    "--theme-color-scheme": light ? "light" : "dark",
    "--divider-subtle": toRgba(ui["--text-dim"], 0.14),
    "--divider": toRgba(ui["--text-dim"], 0.24),
    "--divider-strong": toRgba(ui["--text-dim"], 0.34),
    "--border": toRgba(ui["--text-dim"], 0.28),
    "--surface-muted": toRgba(ui["--text-dim"], 0.08),
    "--surface-hover": toRgba(ui["--accent-a"], 0.1),
    "--surface-hover-strong": toRgba(ui["--accent-a"], 0.16),
    "--surface-selected": toRgba(ui["--accent-a"], 0.18),
    "--surface-selected-hover": toRgba(ui["--accent-a"], 0.24),
    "--surface-accent-soft": toRgba(ui["--accent-a"], 0.12),
    "--surface-warn-soft": toRgba(ui["--accent-c"], 0.14),
    "--scrollbar": toRgba(ui["--text-dim"], 0.18),
    "--scrollbar-hover": toRgba(ui["--text-dim"], 0.3),
    "--accent-a-glow": toRgba(ui["--accent-a"], 0.38),
    // Accent used as small text (commit hash, ahead/behind counters): keep the
    // vivid accent for fills/gradients, but ink a readable version for text.
    "--accent-a-ink": ink(ui["--accent-a"], bg, 4.0),
    "--accent-c-ink": ink(ui["--accent-c"], bg, 4.0),

    // The product shell has its own semantic token vocabulary because it also
    // needs secondary text, focus, chrome, and interaction states. Populate it
    // from the selected theme instead of leaving the shell on a fixed dark
    // palette while only the terminal and legacy panes change color.
    "--shell-bg": ui["--bg"],
    "--shell-sidebar": ui["--bg-1"],
    "--shell-workspace": ui["--bg"],
    "--shell-header": ui["--bg-1"],
    "--shell-surface-1": ui["--bg-2"],
    "--shell-surface-2": toHex(mix(parseRgb(ui["--bg-2"]), parseRgb(ui["--bg-3"]), 0.45)),
    "--shell-surface-3": ui["--bg-3"],
    "--shell-surface-hover": toRgba(ui["--accent-a"], light ? 0.08 : 0.12),
    "--shell-border": ui["--line"],
    "--shell-border-strong": ui["--line-2"],
    "--shell-text": ink(ui["--text"], chromeSurface, 7.0),
    "--shell-text-secondary": ink(toHex(mix(text, textDim, 0.24)), chromeSurface, 4.5),
    "--shell-text-muted": ink(ui["--text-dim"], chromeSurface, 4.5),
    "--shell-text-faint": ink(ui["--text-faint"], chromeSurface, 4.5),
    "--shell-text-disabled": ink(ui["--text-faint"], chromeSurface, 3.0),
    "--shell-accent": ui["--accent-a"],
    "--shell-accent-hover": toHex(mix(accent, light ? [0, 0, 0] : [255, 255, 255], 0.16)),
    "--shell-accent-soft": toRgba(ui["--accent-a"], light ? 0.13 : 0.18),
    "--shell-focus": ink(ui["--accent-a"], chromeSurface, 3.2),
  };
  // Theme-adaptive semantic status colors, inked against the real --bg so they
  // stay legible on both light and dark themes.
  const status: Record<string, string> = {
    "--danger": ink("#e5564b", bg, 4.0),
    "--ok": ink("#2f9e63", bg, 3.6),
    "--warn": ink("#d98a2b", bg, 3.6),
    "--info": ink("#3a8ed0", bg, 3.6),
  };
  for (const [key, val] of Object.entries(status)) {
    vars[key] = val;
    vars[`${key}-soft`] = toRgba(val, light ? 0.16 : 0.12);
    vars[`${key}-line`] = toRgba(val, 0.3);
  }
  vars["--shell-success"] = ink(vars["--ok"], chromeSurface, 3.6);
  vars["--shell-success-soft"] = toRgba(vars["--shell-success"], light ? 0.16 : 0.12);
  vars["--shell-warning"] = ink(vars["--warn"], chromeSurface, 3.6);
  vars["--shell-warning-soft"] = toRgba(vars["--shell-warning"], light ? 0.16 : 0.12);
  vars["--shell-danger"] = ink(vars["--danger"], chromeSurface, 4.0);
  vars["--shell-danger-soft"] = toRgba(vars["--shell-danger"], light ? 0.16 : 0.12);
  vars["--shell-danger-line"] = toRgba(vars["--shell-danger"], 0.3);
  vars["--shell-info-soft"] = toRgba(
    ink(vars["--info"], chromeSurface, 3.6),
    light ? 0.16 : 0.12,
  );
  return vars;
}

export function applyTheme(id: ThemeId) {
  const theme = THEMES[id];
  currentTheme = id;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.ui)) {
    root.style.setProperty(key, value);
  }
  for (const [key, value] of Object.entries(deriveThemeVars(theme))) {
    root.style.setProperty(key, value);
  }

  localStorage.setItem(STORAGE_KEY, id);
  window.dispatchEvent(
    new CustomEvent<TerminalPalette>(THEME_CHANGED_EVENT, {
      detail: theme.term,
    }),
  );
}
