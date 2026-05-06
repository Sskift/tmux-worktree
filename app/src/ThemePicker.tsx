import { useState } from "react";
import { THEMES, type ThemeId, applyTheme } from "./themes";

type Props = {
  current: ThemeId;
  onChange: (id: ThemeId) => void;
};

export function ThemePicker({ current, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const theme = THEMES[current];

  const handle = (id: ThemeId) => {
    applyTheme(id);
    onChange(id);
    setOpen(false);
  };

  return (
    <div className="theme">
      <button
        type="button"
        className="theme__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-label="theme"
        title="theme"
      >
        <span
          className="theme__swatch"
          style={{
            background: `linear-gradient(135deg, ${theme.ui["--accent-a"]}, ${theme.ui["--accent-b"]} 50%, ${theme.ui["--accent-c"]})`,
          }}
        />
        <span className="theme__label">{theme.label}</span>
      </button>

      {open && (
        <>
          <div className="theme__backdrop" onClick={() => setOpen(false)} />
          <div className="theme__menu" role="menu">
            {Object.values(THEMES).map((t) => (
              <button
                key={t.id}
                type="button"
                className={`theme__item ${t.id === current ? "theme__item--current" : ""}`}
                onClick={() => handle(t.id)}
                role="menuitemradio"
                aria-checked={t.id === current}
              >
                <span
                  className="theme__swatch"
                  style={{
                    background: `linear-gradient(135deg, ${t.ui["--accent-a"]}, ${t.ui["--accent-b"]} 50%, ${t.ui["--accent-c"]})`,
                  }}
                />
                <span className="theme__label">{t.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
