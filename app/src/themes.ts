export type ThemeId = "warp" | "sunset" | "ocean" | "forest" | "mono";

export type Theme = {
  id: ThemeId;
  label: string;
  vars: {
    "--bg": string;
    "--bg-1": string;
    "--bg-2": string;
    "--bg-3": string;
    "--accent-a": string;
    "--accent-b": string;
    "--accent-c": string;
  };
};

export const THEMES: Record<ThemeId, Theme> = {
  warp: {
    id: "warp",
    label: "warp",
    vars: {
      "--bg": "#0d0e10",
      "--bg-1": "#14161a",
      "--bg-2": "#1a1d23",
      "--bg-3": "#22262e",
      "--accent-a": "#b794f6",
      "--accent-b": "#f687b3",
      "--accent-c": "#f6ad55",
    },
  },
  sunset: {
    id: "sunset",
    label: "sunset",
    vars: {
      "--bg": "#120a0c",
      "--bg-1": "#1c1115",
      "--bg-2": "#23161a",
      "--bg-3": "#2c1c20",
      "--accent-a": "#fc8181",
      "--accent-b": "#f6ad55",
      "--accent-c": "#f6e05e",
    },
  },
  ocean: {
    id: "ocean",
    label: "ocean",
    vars: {
      "--bg": "#0a1018",
      "--bg-1": "#10171f",
      "--bg-2": "#161e28",
      "--bg-3": "#1c2632",
      "--accent-a": "#63b3ed",
      "--accent-b": "#4fd1c5",
      "--accent-c": "#9ae6b4",
    },
  },
  forest: {
    id: "forest",
    label: "forest",
    vars: {
      "--bg": "#0a120e",
      "--bg-1": "#101a14",
      "--bg-2": "#16221a",
      "--bg-3": "#1c2a22",
      "--accent-a": "#68d391",
      "--accent-b": "#4fd1c5",
      "--accent-c": "#fbd38d",
    },
  },
  mono: {
    id: "mono",
    label: "mono",
    vars: {
      "--bg": "#0d0e10",
      "--bg-1": "#15161a",
      "--bg-2": "#1c1d22",
      "--bg-3": "#23252b",
      "--accent-a": "#cbd5e0",
      "--accent-b": "#a0aec0",
      "--accent-c": "#e2e8f0",
    },
  },
};

const STORAGE_KEY = "tw-dashboard:theme";

export function loadTheme(): ThemeId {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && stored in THEMES) return stored as ThemeId;
  return "warp";
}

export function applyTheme(id: ThemeId) {
  const theme = THEMES[id];
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value);
  }
  localStorage.setItem(STORAGE_KEY, id);
}
