import { useEffect, useRef, useState } from "react";

export type MenuOption = {
  value: string;
  label: string;
  detail?: string;
};

type MenuSelectProps = {
  ariaLabel: string;
  value: string;
  options: MenuOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
};

export function MenuSelect({
  ariaLabel,
  value,
  options,
  onChange,
  disabled = false,
  className = "",
}: MenuSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const rootClassName = `automation-menu-select${className ? ` ${className}` : ""}`;
  const selectOption = (value: string) => {
    onChange(value);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
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
        type="button"
        className={`automation-menu-select__button${open ? " automation-menu-select__button--open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="automation-menu-select__value">
          <span className="automation-menu-select__label">{selected?.label ?? ""}</span>
          {selected?.detail ? (
            <span className="automation-menu-select__detail">{selected.detail}</span>
          ) : null}
        </span>
        <span className="automation-menu-select__chevron">⌄</span>
      </button>
      {open && (
        <div className="automation-menu-select__menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                className={`automation-menu-select__option${active ? " automation-menu-select__option--active" : ""}`}
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
