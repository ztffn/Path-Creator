// Shared inspector controls for the per-shot screen composer. NumberSlider is the
// label+range+number row used across the camera and scene inspectors; RigSettingsPanel
// is the composer framing editor (screen position, dead/soft/hard zones, damping,
// lookahead, noise, dutch) that edits a VirtualCameraDefinition's ComposerSettings.
// Lifted out of App.tsx so the per-kind inspector components can reuse them.
import type { ComposerSettings } from "@huma/path-creator/core";
import { Section as SettingsSection, CheckRow } from "./panel-theme";
import type { DemoNoisePreset } from "./vcam-model";

export function NumberSlider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(72px, 96px) minmax(48px, 1fr) 52px",
        alignItems: "center",
        gap: 8,
        fontSize: 12,
        minWidth: 0
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ width: "100%", minWidth: 0 }}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isInteger(value) ? value : Number(value.toFixed(2))}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ width: "100%", boxSizing: "border-box" }}
        aria-label={`${label}${unit ? ` ${unit}` : ""}`}
      />
    </label>
  );
}

// Per-vcam screen-composer framing editor: screen position, dead/soft/hard
// zones, damping, and lookahead. Edits VirtualCameraDefinition.settings.
export function RigSettingsPanel({
  settings,
  noisePreset,
  onChange,
  onNoisePresetChange,
  onClose,
  onReset
}: {
  settings: ComposerSettings;
  noisePreset: DemoNoisePreset;
  onChange: (next: ComposerSettings) => void;
  onNoisePresetChange: (preset: DemoNoisePreset) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  function setValue<K extends keyof ComposerSettings>(key: K, value: ComposerSettings[K]): void {
    onChange({ ...settings, [key]: value });
  }

  return (
    <div
      style={{
        width: "100%",
        boxSizing: "border-box",
        padding: 10,
        borderRadius: 6,
        background: "rgba(10, 16, 28, 0.92)",
        border: "1px solid rgba(148, 163, 184, 0.22)"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 800 }}>Screen composer</div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onReset}>Reset</button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>

      <SettingsSection title="Camera">
        <label style={{ display: "grid", gridTemplateColumns: "96px 1fr", alignItems: "center", gap: 8, fontSize: 12 }}>
          <span>Noise</span>
          <select value={noisePreset} onChange={(event) => onNoisePresetChange(event.target.value as DemoNoisePreset)}>
            <option value="off">Off</option>
            <option value="subtle">Subtle handheld</option>
            <option value="rough">Rough handheld</option>
          </select>
        </label>
      </SettingsSection>

      <SettingsSection title="Screen">
        <button onClick={() => onChange({ ...settings, screenX: 0, screenY: 0 })}>Center screen</button>
        <NumberSlider label="Screen X" value={settings.screenX} min={-0.4} max={0.4} step={0.01} onChange={(v) => setValue("screenX", v)} />
        <NumberSlider label="Screen Y" value={settings.screenY} min={-0.4} max={0.4} step={0.01} onChange={(v) => setValue("screenY", v)} />
      </SettingsSection>

      <SettingsSection title="Zones">
        <NumberSlider label="Dead W" value={settings.deadWidth} min={0} max={1} step={0.01} onChange={(v) => setValue("deadWidth", v)} />
        <NumberSlider label="Dead H" value={settings.deadHeight} min={0} max={1} step={0.01} onChange={(v) => setValue("deadHeight", v)} />
        <NumberSlider label="Soft W" value={settings.softWidth} min={0} max={1} step={0.01} onChange={(v) => setValue("softWidth", v)} />
        <NumberSlider label="Soft H" value={settings.softHeight} min={0} max={1} step={0.01} onChange={(v) => setValue("softHeight", v)} />
      </SettingsSection>

      <SettingsSection title="Damping">
        <NumberSlider label="Horizontal" value={settings.dampingX} min={0} max={20} step={0.1} onChange={(v) => setValue("dampingX", v)} />
        <NumberSlider label="Vertical" value={settings.dampingY} min={0} max={20} step={0.1} onChange={(v) => setValue("dampingY", v)} />
      </SettingsSection>

      <SettingsSection title="Lookahead">
        <NumberSlider label="Time" value={settings.lookaheadTime} min={0} max={1.5} step={0.01} unit="s" onChange={(v) => setValue("lookaheadTime", v)} />
        <NumberSlider label="Smoothing" value={settings.lookaheadSmoothing} min={0} max={20} step={0.1} onChange={(v) => setValue("lookaheadSmoothing", v)} />
        <CheckRow checked={settings.lookaheadIgnoreY} onChange={(v) => setValue("lookaheadIgnoreY", v)}>Ignore Y</CheckRow>
        <CheckRow checked={settings.centerOnActivate} onChange={(v) => setValue("centerOnActivate", v)}>Center on activate</CheckRow>
      </SettingsSection>
    </div>
  );
}
