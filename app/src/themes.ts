export type ThemeId =
  | "warp"
  | "dracula"
  | "gruvbox-dark"
  | "solarized-dark"
  | "ocean"
  | "mono";

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
  "solarized-dark": {
    id: "solarized-dark",
    label: "solarized",
    ui: {
      "--bg": "#002b36",
      "--bg-1": "#073642",
      "--bg-2": "#0c4452",
      "--bg-3": "#155060",
      "--line": "rgba(238, 232, 213, 0.07)",
      "--line-2": "rgba(238, 232, 213, 0.14)",
      "--text": "#eee8d5",
      "--text-dim": "#93a1a1",
      "--text-faint": "#586e75",
      "--accent-a": "#268bd2",
      "--accent-b": "#2aa198",
      "--accent-c": "#b58900",
    },
    term: {
      background: "#002b36",
      foreground: "#eee8d5",
      cursor: "#268bd2",
      cursorAccent: "#002b36",
      selectionBackground: "rgba(38, 139, 210, 0.3)",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  ocean: {
    id: "ocean",
    label: "ocean",
    ui: {
      "--bg": "#0a1018",
      "--bg-1": "#10171f",
      "--bg-2": "#161e28",
      "--bg-3": "#1c2632",
      "--line": "rgba(255, 255, 255, 0.06)",
      "--line-2": "rgba(255, 255, 255, 0.1)",
      "--text": "#e6edf3",
      "--text-dim": "#8b95a5",
      "--text-faint": "#55606e",
      "--accent-a": "#63b3ed",
      "--accent-b": "#4fd1c5",
      "--accent-c": "#9ae6b4",
    },
    term: {
      background: "#0a1018",
      foreground: "#e6edf3",
      cursor: "#63b3ed",
      cursorAccent: "#0a1018",
      selectionBackground: "rgba(99, 179, 237, 0.3)",
      black: "#10171f",
      red: "#fc8181",
      green: "#9ae6b4",
      yellow: "#f6e05e",
      blue: "#63b3ed",
      magenta: "#b794f6",
      cyan: "#4fd1c5",
      white: "#e6edf3",
      brightBlack: "#55606e",
      brightRed: "#feb2b2",
      brightGreen: "#c6f6d5",
      brightYellow: "#faf089",
      brightBlue: "#90cdf4",
      brightMagenta: "#d6bcfa",
      brightCyan: "#81e6d9",
      brightWhite: "#ffffff",
    },
  },
  mono: {
    id: "mono",
    label: "mono",
    ui: {
      "--bg": "#0d0e10",
      "--bg-1": "#15161a",
      "--bg-2": "#1c1d22",
      "--bg-3": "#23252b",
      "--line": "rgba(255, 255, 255, 0.06)",
      "--line-2": "rgba(255, 255, 255, 0.1)",
      "--text": "#e6e6e8",
      "--text-dim": "#a0a4ac",
      "--text-faint": "#5a5d68",
      "--accent-a": "#cbd5e0",
      "--accent-b": "#a0aec0",
      "--accent-c": "#e2e8f0",
    },
    term: {
      background: "#0d0e10",
      foreground: "#e6e6e8",
      cursor: "#cbd5e0",
      cursorAccent: "#0d0e10",
      selectionBackground: "rgba(203, 213, 224, 0.25)",
      black: "#1a1d23",
      red: "#a0aec0",
      green: "#cbd5e0",
      yellow: "#e2e8f0",
      blue: "#a0aec0",
      magenta: "#cbd5e0",
      cyan: "#e2e8f0",
      white: "#e6e6e8",
      brightBlack: "#5a5d68",
      brightRed: "#cbd5e0",
      brightGreen: "#e2e8f0",
      brightYellow: "#edf2f7",
      brightBlue: "#cbd5e0",
      brightMagenta: "#e2e8f0",
      brightCyan: "#edf2f7",
      brightWhite: "#ffffff",
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

export function applyTheme(id: ThemeId) {
  const theme = THEMES[id];
  currentTheme = id;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.ui)) {
    root.style.setProperty(key, value);
  }
  localStorage.setItem(STORAGE_KEY, id);
  window.dispatchEvent(
    new CustomEvent<TerminalPalette>(THEME_CHANGED_EVENT, {
      detail: theme.term,
    }),
  );
}
