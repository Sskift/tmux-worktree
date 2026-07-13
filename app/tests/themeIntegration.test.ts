import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { THEMES, deriveThemeVars } from "../src/themes.ts";

type Rgb = readonly [number, number, number];

function parseHex(color: string): Rgb {
  assert.match(color, /^#[0-9a-f]{6}$/i);
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function relativeLuminance(color: string): number {
  const channels = parseHex(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

test("every theme supplies the complete Dashboard shell palette", () => {
  const requiredShellVariables = [
    "--shell-bg",
    "--shell-sidebar",
    "--shell-workspace",
    "--shell-header",
    "--shell-surface-1",
    "--shell-surface-2",
    "--shell-surface-3",
    "--shell-surface-hover",
    "--shell-border",
    "--shell-border-strong",
    "--shell-text",
    "--shell-text-secondary",
    "--shell-text-muted",
    "--shell-text-faint",
    "--shell-text-disabled",
    "--shell-accent",
    "--shell-accent-hover",
    "--shell-accent-soft",
    "--shell-focus",
    "--shell-success",
    "--shell-warning",
    "--shell-danger",
  ] as const;

  for (const theme of Object.values(THEMES)) {
    const variables = deriveThemeVars(theme);
    for (const variable of requiredShellVariables) {
      assert.ok(variables[variable], `${theme.id} is missing ${variable}`);
    }

    assert.equal(variables["--shell-bg"], theme.ui["--bg"]);
    assert.equal(variables["--shell-sidebar"], theme.ui["--bg-1"]);
    assert.equal(variables["--shell-surface-1"], theme.ui["--bg-2"]);
    assert.equal(variables["--shell-surface-3"], theme.ui["--bg-3"]);
    assert.equal(variables["--shell-accent"], theme.ui["--accent-a"]);
    for (const surfaceVariable of ["--shell-sidebar", "--shell-surface-3"] as const) {
      const surface = variables[surfaceVariable];
      for (const textVariable of [
        "--shell-text-secondary",
        "--shell-text-muted",
        "--shell-text-faint",
      ] as const) {
        assert.ok(
          contrastRatio(variables[textVariable], surface) >= 4.5,
          `${theme.id} ${textVariable} should remain readable on ${surfaceVariable}`,
        );
      }
      assert.ok(
        contrastRatio(variables["--shell-focus"], surface) >= 3,
        `${theme.id} focus indicator should remain visible on ${surfaceVariable}`,
      );
    }

    const raisedSurface = variables["--shell-surface-3"];
    for (const statusVariable of [
      "--shell-success",
      "--shell-warning",
      "--shell-danger",
    ] as const) {
      assert.ok(
        contrastRatio(variables[statusVariable], raisedSurface) >= 3.5,
        `${theme.id} ${statusVariable} should remain visible on raised surfaces`,
      );
    }
  }
});

test("shell CSS consumes theme-derived chrome and interaction tokens", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const appCss = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  const tokenCss = readFileSync(
    new URL("../src/dashboard/design/tokens.css", import.meta.url),
    "utf8",
  );
  const shellCss = readFileSync(
    new URL("../src/dashboard/DashboardShell.css", import.meta.url),
    "utf8",
  );
  const picker = readFileSync(new URL("../src/ThemePicker.tsx", import.meta.url), "utf8");
  const settingsCss = readFileSync(
    new URL("../src/dashboard/Settings/SettingsDialog.css", import.meta.url),
    "utf8",
  );
  const commandPaletteCss = readFileSync(
    new URL("../src/dashboard/CommandPalette.css", import.meta.url),
    "utf8",
  );

  assert.match(app, /<strong>Dashboard theme<\/strong>/);
  assert.match(app, /Controls the app chrome, editor, terminal/);
  assert.match(appCss, /color-scheme:\s*var\(--theme-color-scheme, dark\)/);
  assert.match(tokenCss, /color-scheme:\s*var\(--theme-color-scheme, dark\)/);
  assert.match(shellCss, /--surface-selected-hover:\s*color-mix\(in srgb, var\(--shell-accent\) 24%, transparent\)/);
  assert.match(shellCss, /--accent-a-glow:\s*color-mix\(in srgb, var\(--shell-accent\) 38%, transparent\)/);
  assert.doesNotMatch(shellCss, /rgb\(58 139 255/);
  assert.match(picker, /aria-label="Dashboard themes"/);
  assert.match(picker, /aria-label="Dashboard theme"/);
  assert.match(settingsCss, /background:\s*var\(--shell-sidebar\)/);
  assert.match(settingsCss, /\.settings-notice--warning\s*\{[\s\S]*?var\(--shell-warning-soft\)/);
  assert.doesNotMatch(settingsCss, /background:\s*#161617/);
  assert.match(commandPaletteCss, /\.command-palette__error\s*\{[\s\S]*?var\(--shell-danger-soft\)/);
  assert.doesNotMatch(commandPaletteCss, /rgb\(58 139 255/);
});
