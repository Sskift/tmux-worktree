import { RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  HighlightStyle,
  getIndentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";

function cssVariable(scope: Element | null | undefined, name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const themeScope = scope?.closest(".tw-shell") ?? scope ?? document.documentElement;
  return getComputedStyle(themeScope).getPropertyValue(name).trim() || fallback;
}

function isLightBackground(color: string): boolean {
  const hex = color.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return false;
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 > 150;
}

/**
 * CodeMirror's generated theme rules are recreated when the Dashboard theme
 * changes. Colors are resolved from the nearest product shell instead of the
 * document root so terminal palette changes cannot leak into the editor UI.
 */
export function createDashboardEditorTheme(scope?: Element | null): Extension {
  const background = cssVariable(scope, "--bg", "#0d0e10");
  const surface = cssVariable(scope, "--bg-1", "#14161a");
  const elevated = cssVariable(scope, "--bg-2", "#1a1d23");
  const raised = cssVariable(scope, "--bg-3", "#22262e");
  const text = cssVariable(scope, "--text", "#e6e6e8");
  const textDim = cssVariable(scope, "--text-dim", "#9598a3");
  const textFaint = cssVariable(scope, "--text-faint", "#5a5d68");
  const divider = cssVariable(scope, "--divider", "rgba(149, 152, 163, 0.24)");
  const dividerSubtle = cssVariable(scope, "--divider-subtle", "rgba(149, 152, 163, 0.14)");
  const accent = cssVariable(scope, "--accent-a", "#3a8bff");
  const accentInk = cssVariable(scope, "--accent-a-ink", accent);
  const violet = cssVariable(scope, "--accent-b", "#f687b3");
  const amber = cssVariable(scope, "--accent-c", "#f6ad55");
  const green = cssVariable(scope, "--ok", "#62c073");
  const danger = cssVariable(scope, "--danger", "#e5564b");
  const selected = cssVariable(scope, "--surface-selected", "rgba(58, 139, 255, 0.18)");
  const activeLine = cssVariable(scope, "--surface-muted", "rgba(149, 152, 163, 0.08)");
  const dark = !isLightBackground(background);

  const viewTheme = EditorView.theme(
    {
      "&": {
        height: "100%",
        color: text,
        backgroundColor: background,
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily: '"JetBrains Mono", "SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, monospace',
        lineHeight: "1.62",
      },
      ".cm-content": {
        caretColor: accent,
        padding: "12px 0 64px",
      },
      ".cm-line": {
        padding: "0 18px 0 10px",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: accent,
        borderLeftWidth: "2px",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: selected,
      },
      ".cm-activeLine": {
        backgroundColor: activeLine,
        boxShadow: `inset 2px 0 0 ${accent}`,
      },
      ".cm-gutters": {
        backgroundColor: surface,
        color: textFaint,
        borderRight: `1px solid ${dividerSubtle}`,
        paddingLeft: "4px",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        minWidth: "34px",
        padding: "0 9px 0 5px",
      },
      ".cm-activeLineGutter": {
        backgroundColor: activeLine,
        color: textDim,
      },
      ".cm-foldGutter .cm-gutterElement": {
        color: textFaint,
        padding: "0 5px 0 1px",
      },
      ".cm-foldPlaceholder": {
        color: textDim,
        backgroundColor: elevated,
        border: `1px solid ${divider}`,
        borderRadius: "4px",
        padding: "0 5px",
      },
      ".cm-matchingBracket": {
        color: text,
        backgroundColor: selected,
        outline: `1px solid ${accent}`,
        borderRadius: "2px",
      },
      ".cm-nonmatchingBracket": {
        color: danger,
        backgroundColor: "transparent",
        outline: `1px solid ${danger}`,
      },
      ".cm-searchMatch": {
        backgroundColor: `color-mix(in srgb, ${amber} 28%, transparent)`,
        outline: `1px solid color-mix(in srgb, ${amber} 65%, transparent)`,
        borderRadius: "2px",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: selected,
        outline: `1px solid ${accent}`,
      },
      ".cm-selectionMatch": {
        backgroundColor: selected,
      },
      ".cm-panels": {
        color: text,
        backgroundColor: surface,
      },
      ".cm-panels-top": {
        borderBottom: `1px solid ${divider}`,
      },
      ".cm-panels-bottom": {
        borderTop: `1px solid ${divider}`,
      },
      ".cm-search": {
        alignItems: "center",
        gap: "5px",
        padding: "7px 10px",
      },
      ".cm-search label": { color: textDim },
      ".cm-search input, .cm-textfield": {
        height: "26px",
        color: text,
        backgroundColor: background,
        border: `1px solid ${divider}`,
        borderRadius: "6px",
        padding: "0 8px",
        fontFamily: "inherit",
        outline: "none",
      },
      ".cm-search input:focus, .cm-textfield:focus": {
        borderColor: accent,
        boxShadow: `0 0 0 2px color-mix(in srgb, ${accent} 18%, transparent)`,
      },
      ".cm-button": {
        color: textDim,
        backgroundImage: "none",
        backgroundColor: elevated,
        border: `1px solid ${divider}`,
        borderRadius: "6px",
        padding: "3px 8px",
      },
      ".cm-button:hover": {
        color: text,
        backgroundColor: raised,
      },
      ".cm-panel.cm-search [name=close]": {
        color: textDim,
        fontSize: "18px",
        top: "7px",
        right: "9px",
      },
      ".cm-tooltip": {
        color: text,
        backgroundColor: elevated,
        border: `1px solid ${divider}`,
        borderRadius: "7px",
        boxShadow: "0 12px 32px rgba(0, 0, 0, 0.34)",
        overflow: "hidden",
      },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        color: text,
        backgroundColor: selected,
      },
      ".cm-completionLabel": { color: text },
      ".cm-completionDetail": { color: textFaint },
      ".cm-diagnostic-error": { borderLeftColor: danger },
      ".cm-indent-guide": {
        boxShadow: `inset 1px 0 ${dividerSubtle}`,
      },
    },
    { dark },
  );

  const highlightStyle = HighlightStyle.define([
    { tag: tags.comment, color: textFaint, fontStyle: "italic" },
    { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: violet },
    { tag: [tags.definitionKeyword, tags.controlKeyword, tags.moduleKeyword], color: violet },
    { tag: [tags.variableName, tags.self], color: accentInk },
    { tag: [tags.propertyName, tags.attributeName], color: accentInk },
    { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: amber },
    { tag: [tags.string, tags.character, tags.attributeValue, tags.docString], color: green },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: amber },
    { tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: violet },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: accent },
    { tag: [tags.operator, tags.punctuation, tags.separator], color: textDim },
    { tag: [tags.bracket, tags.paren, tags.squareBracket, tags.brace], color: textDim },
    { tag: [tags.heading, tags.strong], color: text, fontWeight: "600" },
    { tag: tags.emphasis, color: text, fontStyle: "italic" },
    { tag: [tags.link, tags.url], color: accent, textDecoration: "underline" },
    { tag: tags.meta, color: textDim },
    { tag: tags.invalid, color: danger, textDecoration: "underline wavy" },
  ]);

  return [viewTheme, syntaxHighlighting(highlightStyle)];
}

const indentGuideMark = Decoration.mark({ class: "cm-indent-guide" });

function buildIndentGuides(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const unit = Math.max(1, getIndentUnit(view.state));
  let lastLineFrom = -1;

  for (const range of view.visibleRanges) {
    let position = range.from;
    while (position <= range.to) {
      const line = view.state.doc.lineAt(position);
      if (line.from !== lastLineFrom) {
        lastLineFrom = line.from;
        const whitespace = line.text.match(/^[\t ]+/)?.[0] ?? "";
        let column = 0;
        for (let index = 0; index < whitespace.length; index += 1) {
          const character = whitespace[index];
          if (character === "\t" || column % unit === 0) {
            builder.add(line.from + index, line.from + index + 1, indentGuideMark);
          }
          column += character === "\t" ? unit - (column % unit) : 1;
        }
      }
      if (line.to >= range.to || line.to === view.state.doc.length) break;
      position = line.to + 1;
    }
  }

  return builder.finish();
}

export const indentGuides = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildIndentGuides(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildIndentGuides(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
