// Shared design tokens + control styling for the demo panels, mirroring the twin
// author workspace (three-geospatial .../author/theme.ts) so the demo pre-matches
// where it will be incorporated: opaque #101820 chrome, sharp corners, borders-only
// ghost buttons, #151f29 raised fields, one accent (Huma red) for destructive.
// panelGlobalCss styles every native control inside a .pc-panel; Section is a
// persisted collapsible block (labelStyle title + chevron).
import { useState, type CSSProperties, type ReactNode } from "react";

export const SANS = "ui-sans-serif, system-ui, sans-serif";
export const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

export const BG = "#101820";
export const BG_RAISED = "#151f29";
export const TEXT = "#e8eef5";
export const SECONDARY = "rgba(232, 238, 245, 0.78)";
export const MUTED = "rgba(232, 238, 245, 0.55)";
export const FAINT = "rgba(232, 238, 245, 0.34)";
export const BORDER = "rgba(255, 255, 255, 0.10)";
export const BORDER_FAINT = "rgba(255, 255, 255, 0.06)";
export const ACCENT = "oklch(0.6671 0.2199 26.4681)"; // Huma red — destructive only

/** Section label: 10px, 500, uppercase, wide tracking, muted. */
export const labelStyle: CSSProperties = {
  fontFamily: SANS,
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: MUTED
};

// Styles native controls inside `.pc-panel` (side panels — full treatment incl.
// opaque bg + a min-width:0 overflow guard) and `.pc-controls` (the timeline
// transport — controls only, no bg/overflow rules so the third-party lane editor
// layout is untouched). Inject once via <style>.
export const panelGlobalCss = `
.pc-panel { background: ${BG}; color: ${TEXT}; font-family: ${SANS}; }
.pc-panel button, .pc-controls button {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 26px; padding: 0 10px; font-family: ${SANS}; font-size: 11px; font-weight: 500;
  color: ${TEXT}; background: transparent; border: 1px solid ${BORDER}; border-radius: 0; cursor: pointer;
}
.pc-panel button:hover, .pc-controls button:hover { background: rgba(255, 255, 255, 0.06); }
.pc-panel button:active, .pc-controls button:active { background: rgba(255, 255, 255, 0.10); }
.pc-panel button:disabled, .pc-controls button:disabled { opacity: 0.45; cursor: default; }
.pc-panel button:disabled:hover, .pc-controls button:disabled:hover { background: transparent; }
.pc-panel button.pc-danger:hover, .pc-controls button.pc-danger:hover { color: ${ACCENT}; border-color: ${ACCENT}; background: transparent; }
.pc-panel input[type="text"], .pc-panel input[type="number"], .pc-panel select,
.pc-controls input[type="text"], .pc-controls input[type="number"], .pc-controls select {
  min-width: 0; height: 26px; padding: 0 8px; font-family: ${SANS}; font-size: 12px;
  color: ${TEXT}; background: ${BG_RAISED}; border: 1px solid ${BORDER}; border-radius: 0; outline: none;
  box-sizing: border-box;
}
.pc-panel select, .pc-controls select { cursor: pointer; }
.pc-panel input[type="text"]:focus, .pc-panel input[type="number"]:focus, .pc-panel select:focus,
.pc-controls input[type="text"]:focus, .pc-controls input[type="number"]:focus, .pc-controls select:focus {
  border-color: rgba(255, 255, 255, 0.28);
}
/* Range: thin track + small rectangular thumb (no round knob). */
.pc-panel input[type="range"], .pc-controls input[type="range"] {
  -webkit-appearance: none; appearance: none;
  height: 4px; background: rgba(255, 255, 255, 0.16); border-radius: 0; cursor: pointer;
}
.pc-panel input[type="range"]::-webkit-slider-thumb, .pc-controls input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 6px; height: 14px; margin-top: -5px; border: none; border-radius: 0; background: ${ACCENT}; cursor: pointer;
}
.pc-panel input[type="range"]::-moz-range-track, .pc-controls input[type="range"]::-moz-range-track {
  height: 4px; background: rgba(255, 255, 255, 0.16); border-radius: 0;
}
.pc-panel input[type="range"]::-moz-range-thumb, .pc-controls input[type="range"]::-moz-range-thumb {
  width: 6px; height: 14px; border: none; border-radius: 0; background: ${ACCENT}; cursor: pointer;
}
.pc-panel input[type="checkbox"], .pc-panel input[type="radio"] { accent-color: ${ACCENT}; }
/* Overflow guard: let flex/grid children shrink so no row is clipped horizontally. */
.pc-panel :where(div, label, span) { min-width: 0; }
/* Collapsible section/group header: a chrome-less full-width toggle. */
.pc-panel button.pc-section-toggle {
  height: auto; padding: 0; width: 100%; justify-content: space-between;
  background: transparent; border: none;
}
.pc-panel button.pc-section-toggle:hover { background: transparent; }
.pc-panel a.pc-link { color: ${MUTED}; text-decoration: none; font-size: 11px; }
.pc-panel a.pc-link:hover { color: ${TEXT}; }
`;

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width={9}
      height={9}
      viewBox="0 0 10 10"
      style={{ transition: "transform 150ms", transform: open ? "rotate(90deg)" : "none", flex: "0 0 auto" }}
      aria-hidden
    >
      <path d="M3 1 L7 5 L3 9" fill="none" stroke={MUTED} strokeWidth={1.4} />
    </svg>
  );
}

const openKey = (title: string): string => `pc:section-open:${title}`;

/** A persisted collapsible section: uppercase label + chevron; body renders when open. */
export function Section({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(openKey(title));
      return stored === null ? defaultOpen : stored === "1";
    } catch {
      return defaultOpen;
    }
  });
  const toggle = (): void =>
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(openKey(title), next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  return (
    <div style={{ borderTop: `1px solid ${BORDER_FAINT}`, paddingTop: 10, marginTop: 10 }}>
      <button className="pc-section-toggle" onClick={toggle} aria-expanded={open}>
        <span style={labelStyle}>{title}</span>
        <Chevron open={open} />
      </button>
      {open ? <div style={{ display: "grid", gap: 8, marginTop: 8 }}>{children}</div> : null}
    </div>
  );
}

/** A checkbox + inline label row (the demo's standard boolean control). */
export function CheckRow({ checked, onChange, children }: { checked: boolean; onChange: (value: boolean) => void; children: ReactNode }) {
  return (
    <label style={{ display: "block", fontSize: 12 }}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span style={{ marginLeft: 6 }}>{children}</span>
    </label>
  );
}

/** A lighter, chrome-less collapsible sub-group used inside a Section (chevron + 9px label). */
export function CollapsibleGroup({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <button className="pc-section-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open} style={{ justifyContent: "flex-start", gap: 6 }}>
        <Chevron open={open} />
        <span style={{ ...labelStyle, fontSize: 9 }}>{title}</span>
      </button>
      {open ? children : null}
    </div>
  );
}
