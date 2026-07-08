// Scene inspector: the demo's global settings, shown when the Scene row is selected.
// Gathers what used to be scattered across "Blend" and "Viewport Debug" — blend
// curve/duration + transition readout, the live-camera release strip, the Edit/Play
// view mode, and the PiP/frustum/path-as-rail viewport toggles. Pure presentation;
// every value + setter is threaded from App via the Inspector dispatcher.
import type { VirtualCameraBlendCurve } from "@huma/path-creator/three";
import { NumberSlider } from "./rig-settings-panel";
import { Section as SettingsSection } from "./panel-theme";
import { IconVideo, IconDirector } from "./icons";

export interface SceneInspectorProps {
  viewMode: "edit" | "play";
  onViewModeChange: (mode: "edit" | "play") => void;
  debugPreview: boolean;
  onDebugPreviewChange: (value: boolean) => void;
  debugFrustum: boolean;
  onDebugFrustumChange: (value: boolean) => void;
  pathStyle: "rail" | "line";
  onPathStyleChange: (value: "rail" | "line") => void;
  blendCurve: VirtualCameraBlendCurve;
  onBlendCurveChange: (curve: VirtualCameraBlendCurve) => void;
  blendDuration: number;
  onBlendDurationChange: (duration: number) => void;
  transitionProgress: number;
  liveCameraName: string | null;
  onRelease: () => void;
}

export function SceneInspector({
  viewMode,
  onViewModeChange,
  debugPreview,
  onDebugPreviewChange,
  debugFrustum,
  onDebugFrustumChange,
  pathStyle,
  onPathStyleChange,
  blendCurve,
  onBlendCurveChange,
  blendDuration,
  onBlendDurationChange,
  transitionProgress,
  liveCameraName,
  onRelease
}: SceneInspectorProps) {
  return (
    <>
      <SettingsSection title="View">
        <div
          role="group"
          aria-label="View mode"
          title="Edit: editor camera + controls in the main view, driven camera in the PiP. Play: driven camera fills the main view and all interaction pilots it. Shortcut: P"
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}
        >
          {(["edit", "play"] as const).map((mode) => {
            const active = viewMode === mode;
            return (
              <button
                key={mode}
                onClick={() => onViewModeChange(mode)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  padding: "6px 8px",
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: "capitalize",
                  borderRadius: 0,
                  cursor: "pointer",
                  color: active ? "#0f172a" : "#cbd5e1",
                  background: active
                    ? mode === "play"
                      ? "rgba(34, 197, 94, 0.9)"
                      : "rgba(148, 163, 184, 0.9)"
                    : "rgba(15, 23, 42, 0.6)",
                  border: `1px solid ${active ? "transparent" : "rgba(148, 163, 184, 0.25)"}`
                }}
              >
                {mode === "play" ? <IconVideo size={13} /> : <IconDirector size={13} />}
                {mode === "play" ? "Play" : "Edit"}
              </button>
            );
          })}
        </div>
        {liveCameraName ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 11, color: "#22c55e" }}>Live: {liveCameraName}</span>
            <button onClick={onRelease}>Release</button>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Blend">
        <label style={{ display: "grid", gridTemplateColumns: "96px 1fr", alignItems: "center", gap: 8, fontSize: 12 }}>
          <span>Curve</span>
          <select value={blendCurve} onChange={(event) => onBlendCurveChange(event.target.value as VirtualCameraBlendCurve)}>
            <option value="cut">Cut</option>
            <option value="easeInOut">Ease In Out</option>
            <option value="easeIn">Ease In</option>
            <option value="easeOut">Ease Out</option>
            <option value="hardIn">Hard In</option>
            <option value="hardOut">Hard Out</option>
            <option value="linear">Linear</option>
          </select>
        </label>
        <NumberSlider label="Duration" value={blendDuration} min={0} max={5} step={0.1} unit="s" onChange={onBlendDurationChange} />
        <div style={{ height: 6, borderRadius: 999, background: "rgba(148, 163, 184, 0.2)", overflow: "hidden" }}>
          <div style={{ width: `${Math.round(transitionProgress * 100)}%`, height: "100%", background: "#22c55e" }} />
        </div>
      </SettingsSection>

      <SettingsSection title="Viewport">
        <label style={{ display: "block", fontSize: 12 }}>
          <input type="checkbox" checked={debugPreview} onChange={(e) => onDebugPreviewChange(e.target.checked)} />
          <span style={{ marginLeft: 6 }}>Show camera PiP</span>
        </label>
        <label style={{ display: "block", fontSize: 12 }}>
          <input type="checkbox" checked={debugFrustum} onChange={(e) => onDebugFrustumChange(e.target.checked)} />
          <span style={{ marginLeft: 6 }}>Show camera frustum</span>
        </label>
        <label style={{ display: "block", fontSize: 12 }}>
          <input type="checkbox" checked={pathStyle === "rail"} onChange={(e) => onPathStyleChange(e.target.checked ? "rail" : "line")} />
          <span style={{ marginLeft: 6 }}>Path as dolly rail</span>
        </label>
        <div style={{ fontSize: 11, color: "rgba(232, 238, 245, 0.55)", lineHeight: 1.45 }}>
          Orbit: right-drag. Pan: middle-drag. Zoom: wheel.
        </div>
      </SettingsSection>
    </>
  );
}
