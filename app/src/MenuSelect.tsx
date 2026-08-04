import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ChevronDown } from "lucide-react";

export type MenuOption = {
  value: string;
  label: string;
  detail?: string;
};

export type MenuSelectNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

type MenuSelectProps = {
  ariaLabel: string;
  value: string;
  options: MenuOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  ariaDescribedBy?: string;
  ariaErrorMessage?: string;
  ariaInvalid?: boolean;
};

export function getMenuSelectNavigationIndex(
  key: MenuSelectNavigationKey,
  currentIndex: number,
  optionCount: number,
): number {
  if (optionCount <= 0) return -1;
  const normalizedIndex = currentIndex >= 0 && currentIndex < optionCount
    ? currentIndex
    : 0;

  if (key === "Home") return 0;
  if (key === "End") return optionCount - 1;
  if (key === "ArrowDown") return (normalizedIndex + 1) % optionCount;
  return (normalizedIndex - 1 + optionCount) % optionCount;
}

function isNavigationKey(key: string): key is MenuSelectNavigationKey {
  return key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End";
}

export function MenuSelect({
  ariaLabel,
  value,
  options,
  onChange,
  disabled = false,
  className = "",
  id,
  ariaDescribedBy,
  ariaErrorMessage,
  ariaInvalid = false,
}: MenuSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const generatedId = useId();
  const triggerId = id ?? `menu-select-${generatedId}`;
  const menuId = `${triggerId}-listbox`;
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex];
  const rootClassName = `automation-menu-select${className ? ` ${className}` : ""}`;

  const closeMenu = (restoreTriggerFocus = false) => {
    setOpen(false);
    if (restoreTriggerFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  const openMenu = (index = selectedIndex) => {
    if (disabled || options.length === 0) return;
    setActiveIndex(Math.min(Math.max(index, 0), options.length - 1));
    setOpen(true);
  };

  const selectOption = (value: string) => {
    onChange(value);
    closeMenu(true);
  };

  const focusOption = (index: number) => {
    if (index < 0) return;
    setActiveIndex(index);
    optionRefs.current[index]?.focus();
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!isNavigationKey(event.key)) {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
      }
      return;
    }

    event.preventDefault();
    const initialIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : selectedIndex;
    openMenu(initialIndex);
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isNavigationKey(event.key)) {
      event.preventDefault();
      focusOption(getMenuSelectNavigationIndex(event.key, activeIndex, options.length));
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) selectOption(option.value);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    }
  };

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, open]);

  useEffect(() => {
    if (open) return;
    setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  useEffect(() => {
    optionRefs.current.length = options.length;
    setActiveIndex((current) => Math.min(Math.max(current, 0), Math.max(options.length - 1, 0)));
  }, [options.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div
      ref={rootRef}
      className={rootClassName}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={`automation-menu-select__button${open ? " automation-menu-select__button--open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid || undefined}
        aria-errormessage={ariaInvalid ? ariaErrorMessage : undefined}
        disabled={disabled}
        onClick={() => open ? closeMenu() : openMenu()}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="automation-menu-select__value">
          <span className="automation-menu-select__label">{selected?.label ?? ""}</span>
          {selected?.detail ? (
            <span className="automation-menu-select__detail">{selected.detail}</span>
          ) : null}
        </span>
        <ChevronDown
          className="automation-menu-select__chevron"
          aria-hidden="true"
          size={14}
          strokeWidth={1.8}
        />
      </button>
      {open && (
        <div
          id={menuId}
          className="automation-menu-select__menu"
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={`${menuId}-option-${activeIndex}`}
          onKeyDown={handleMenuKeyDown}
        >
          {options.map((option, index) => {
            const selectedOption = option.value === value;
            const focusedOption = index === activeIndex;
            return (
              <button
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                id={`${menuId}-option-${index}`}
                key={option.value}
                type="button"
                role="option"
                aria-selected={selectedOption}
                tabIndex={focusedOption ? 0 : -1}
                className={`automation-menu-select__option${selectedOption || focusedOption ? " automation-menu-select__option--active" : ""}`}
                onFocus={() => setActiveIndex(index)}
                onPointerMove={() => setActiveIndex(index)}
                onClick={(event) => {
                  // Assistive technology can activate an option without a pointer event.
                  if (event.detail === 0) selectOption(option.value);
                }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  selectOption(option.value);
                }}
              >
                <span className="automation-menu-select__option-label">{option.label}</span>
                {option.detail ? (
                  <span className="automation-menu-select__option-detail">{option.detail}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
