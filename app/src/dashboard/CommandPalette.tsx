import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  Clock3,
  Command,
  Compass,
  CornerDownLeft,
  LoaderCircle,
  Search,
  SearchX,
  Settings,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  useCommandPalette,
  type CommandPaletteGroupId,
  type CommandPaletteItem,
} from "./useCommandPalette";
import "./CommandPalette.css";

const GROUP_ICONS: Record<CommandPaletteGroupId, LucideIcon> = {
  actions: Command,
  navigate: Compass,
  automation: Zap,
  recent: Clock3,
  settings: Settings,
};

export type CommandPaletteProps = {
  open: boolean;
  items: readonly CommandPaletteItem[];
  onOpenChange: (open: boolean) => void;
  initialQuery?: string;
  enableHotkey?: boolean;
  footerLabel?: string;
};

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'input:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.tabIndex >= 0 && !element.hasAttribute("aria-hidden"));
}

export function CommandPalette({
  open,
  items,
  onOpenChange,
  initialQuery,
  enableHotkey,
  footerLabel = "tw dashboard",
}: CommandPaletteProps) {
  const palette = useCommandPalette({
    open,
    items,
    onOpenChange,
    initialQuery,
    enableHotkey,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(palette.close);
  closeRef.current = palette.close;
  const instanceId = useId().replace(/:/g, "");
  const titleId = `${instanceId}-title`;
  const listboxId = `${instanceId}-results`;

  const optionIds = useMemo(() => {
    const ids = new Map<string, string>();
    palette.visibleItems.forEach((item, index) => {
      ids.set(item.id, `${instanceId}-option-${index}`);
    });
    return ids;
  }, [instanceId, palette.visibleItems]);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);

    const keepFocusInside = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) {
        inputRef.current?.focus();
      }
    };

    const handleDialogKeyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1
        : activeIndex >= focusable.length - 1 ? 0 : activeIndex + 1;
      event.preventDefault();
      focusable[nextIndex]?.focus();
    };

    document.addEventListener("focusin", keepFocusInside);
    document.addEventListener("keydown", handleDialogKeyboard, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("focusin", keepFocusInside);
      document.removeEventListener("keydown", handleDialogKeyboard, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      palette.move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      palette.move(-1);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void palette.executeActive();
    }
  };

  const handleBackdropMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) palette.close();
  };

  const runningCommandId = palette.execution.phase === "running"
    ? palette.execution.commandId
    : null;
  const executionLabel = runningCommandId
    ? `Running ${items.find((item) => item.id === runningCommandId)?.label ?? "command"}…`
    : palette.execution.phase === "error"
      ? "Command failed"
      : "";

  return (
    <div className="command-palette__backdrop" onMouseDown={handleBackdropMouseDown}>
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={palette.execution.phase === "running"}
      >
        <h2 id={titleId} className="command-palette__sr-only">Command palette</h2>

        <div className="command-palette__search">
          <Search aria-hidden="true" size={19} strokeWidth={1.8} />
          <label className="command-palette__sr-only" htmlFor={`${instanceId}-input`}>
            Search commands
          </label>
          <input
            ref={inputRef}
            id={`${instanceId}-input`}
            className="command-palette__input"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={
              palette.activeId ? optionIds.get(palette.activeId) : undefined
            }
            value={palette.query}
            onChange={(event) => palette.setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Search sessions, actions, automations, and settings…"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            readOnly={palette.execution.phase === "running"}
          />
          <kbd className="command-palette__escape">Esc</kbd>
        </div>

        <div
          id={listboxId}
          className="command-palette__results"
          role="listbox"
          aria-label="Command results"
        >
          {palette.groups.map((group) => {
            const GroupIcon = GROUP_ICONS[group.id];
            const groupLabelId = `${instanceId}-group-${group.id}`;
            return (
              <section
                key={group.id}
                className="command-palette__group"
                role="group"
                aria-labelledby={groupLabelId}
              >
                <h3 id={groupLabelId} className="command-palette__group-title">
                  {group.label}
                </h3>
                <div className="command-palette__group-items">
                  {group.items.map((item) => {
                    const ItemIcon = item.icon ?? GroupIcon;
                    const active = item.id === palette.activeId;
                    const running = palette.execution.phase === "running"
                      && palette.execution.commandId === item.id;
                    const detailId = item.detail || item.disabledReason
                      ? `${optionIds.get(item.id)}-detail`
                      : undefined;
                    return (
                      <button
                        key={item.id}
                        id={optionIds.get(item.id)}
                        className="command-palette__option"
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={active}
                        aria-disabled={
                          Boolean(item.disabledReason) || palette.execution.phase === "running"
                        }
                        aria-describedby={detailId}
                        data-active={active ? "true" : "false"}
                        data-disabled={item.disabledReason ? "true" : "false"}
                        onMouseMove={() => palette.select(item.id)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void palette.execute(item)}
                        title={item.disabledReason}
                      >
                        <span className="command-palette__option-icon">
                          {running
                            ? <LoaderCircle className="command-palette__spinner" aria-hidden="true" size={17} />
                            : <ItemIcon aria-hidden="true" size={17} strokeWidth={1.8} />}
                        </span>
                        <span className="command-palette__option-copy">
                          <span className="command-palette__option-label">{item.label}</span>
                          {(item.detail || item.disabledReason) && (
                            <span
                              id={detailId}
                              className="command-palette__option-detail"
                              data-disabled={item.disabledReason ? "true" : "false"}
                            >
                              {item.disabledReason
                                ? `Unavailable: ${item.disabledReason}`
                                : item.detail}
                            </span>
                          )}
                        </span>
                        {item.shortcut && item.shortcut.length > 0 && (
                          <span className="command-palette__shortcut" aria-label={item.shortcut.join(" ")}>
                            {item.shortcut.map((key) => <kbd key={key}>{key}</kbd>)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}

          {palette.visibleItems.length === 0 && (
            <div className="command-palette__empty" role="status">
              <SearchX aria-hidden="true" size={28} strokeWidth={1.5} />
              <strong>No matching commands</strong>
              <span>
                {palette.query.trim()
                  ? `Nothing matches “${palette.query.trim()}”. Try another search.`
                  : "No commands are available in this context."}
              </span>
            </div>
          )}
        </div>

        {palette.execution.phase === "error" && (
          <div className="command-palette__error" role="alert">
            <CircleAlert aria-hidden="true" size={17} />
            <span>
              <strong>Couldn’t run the command.</strong> {palette.execution.message}
            </span>
            <button type="button" onClick={palette.clearError}>Dismiss</button>
          </div>
        )}

        <footer className="command-palette__footer">
          <span className="command-palette__hint">
            <ArrowUp aria-hidden="true" size={13} />
            <ArrowDown aria-hidden="true" size={13} />
            navigate
          </span>
          <span className="command-palette__hint">
            <CornerDownLeft aria-hidden="true" size={14} />
            select
          </span>
          <span className="command-palette__execution" role="status" aria-live="polite">
            {executionLabel}
          </span>
          <span className="command-palette__product">{footerLabel}</span>
        </footer>
      </div>
    </div>
  );
}

export type { CommandPaletteItem } from "./useCommandPalette";
