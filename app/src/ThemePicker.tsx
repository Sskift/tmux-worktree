import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { THEMES, type ThemeId, applyTheme } from "./themes";
import {
  calculateThemeMenuPosition,
  type ThemeMenuPosition,
} from "./themePickerPosition";

type Props = {
  current: ThemeId;
  onChange: (id: ThemeId) => void;
};

export function ThemePicker({ current, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<ThemeMenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const theme = THEMES[current];

  const returnFocusToTrigger = useCallback(() => {
    window.requestAnimationFrame(() => {
      const trigger = triggerRef.current;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    });
  }, []);

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) returnFocusToTrigger();
  }, [returnFocusToTrigger]);

  const handle = useCallback((id: ThemeId) => {
    applyTheme(id);
    onChange(id);
    closeMenu(true);
  }, [closeMenu, onChange]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const anchor = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const nextPosition = calculateThemeMenuPosition(
      {
        top: anchor.top,
        right: anchor.right,
        bottom: anchor.bottom,
        width: anchor.width,
      },
      {
        width: menuRect.width,
        height: menu.scrollHeight,
      },
      {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    );

    setPosition((previous) => {
      if (
        previous &&
        previous.top === nextPosition.top &&
        previous.left === nextPosition.left &&
        previous.width === nextPosition.width &&
        previous.maxHeight === nextPosition.maxHeight &&
        previous.side === nextPosition.side
      ) {
        return previous;
      }
      return nextPosition;
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();

    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updatePosition);
    if (triggerRef.current) resizeObserver?.observe(triggerRef.current);
    if (menuRef.current) resizeObserver?.observe(menuRef.current);

    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;

    const handleOutsidePointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (
        rootRef.current?.contains(event.target) ||
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      closeMenu();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    };

    document.addEventListener("pointerdown", handleOutsidePointer, true);
    document.addEventListener("keydown", handleEscape, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointer, true);
      document.removeEventListener("keydown", handleEscape, true);
    };
  }, [closeMenu, open]);

  useEffect(() => {
    if (!open) return;
    const animationFrame = window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')
        ?.focus();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [open]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
    );
    if (items.length === 0) return;

    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = currentIndex < 0
        ? items.length - 1
        : (currentIndex - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    } else if (event.key === "Tab") {
      const direction = event.shiftKey ? -1 : 1;
      const startingIndex = currentIndex < 0 ? (direction > 0 ? -1 : 0) : currentIndex;
      nextIndex = (startingIndex + direction + items.length) % items.length;
    }

    if (nextIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    items[nextIndex]?.focus();
  };

  const menu = open && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="theme__menu"
          role="menu"
          aria-label="Terminal themes"
          data-side={position?.side}
          onKeyDown={handleMenuKeyDown}
          style={position
            ? {
                top: position.top,
                left: position.left,
                width: position.width,
                maxHeight: position.maxHeight,
              }
            : { top: 0, left: 0, visibility: "hidden" }}
        >
          {Object.values(THEMES).map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className={`theme__item ${candidate.id === current ? "theme__item--current" : ""}`}
              onClick={() => handle(candidate.id)}
              role="menuitemradio"
              aria-checked={candidate.id === current}
            >
              <span
                className="theme__swatch"
                style={{
                  background: `linear-gradient(135deg, ${candidate.ui["--accent-a"]}, ${candidate.ui["--accent-b"]} 50%, ${candidate.ui["--accent-c"]})`,
                }}
              />
              <span className="theme__label">{candidate.label}</span>
              {candidate.id === current ? (
                <Check
                  className="theme__check"
                  aria-hidden="true"
                  size={13}
                  strokeWidth={2}
                />
              ) : null}
            </button>
          ))}
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="theme" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="theme__trigger"
        onClick={() => {
          if (open) closeMenu();
          else setOpen(true);
        }}
        aria-label="Terminal theme"
        title="Terminal theme"
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
      >
        <span
          className="theme__swatch"
          style={{
            background: `linear-gradient(135deg, ${theme.ui["--accent-a"]}, ${theme.ui["--accent-b"]} 50%, ${theme.ui["--accent-c"]})`,
          }}
        />
        <span className="theme__label">{theme.label}</span>
      </button>
      {menu}
    </div>
  );
}
