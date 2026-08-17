// Scene inspector: the demo's global settings, shown when the Scene row is selected.
// Gathers what used to be scattered across "Blend" and "Viewport Debug" — blend
// curve/duration + transition readout, the live-camera release strip, the Edit/Play
// view mode, and the PiP/frustum/path-as-rail viewport toggles. Pure presentation;
// every value + setter is threaded from App via the Inspector dispatcher.
import type { VirtualCameraBlendCurve } from "@huma/path-creator/three";
import { NumberSlider } from "./rig-settings-panel";
import { Section as SettingsSection, CheckRow } from "./panel-theme";
import { ViewModeToggle } from "./view-mode-toggle";

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
  /** The ACTIVE scene's embed clips (other scenes played inside its windows);
   *  the lane creates/moves them, retarget/offset/blend/delete live here. */
  embeds: { id: string; sceneId: string; start: number; end: number; offset: number; blendSeconds: number }[];
  /** The other scenes an embed clip may play. */
  embedScenes: { id: string; name: string }[];
  onUpdateEmbed: (clipId: string, patch: { sceneId?: string; offset?: number; blendSeconds?: number }) => void;
  onDeleteEmbed: (clipId: string) => void;
  /** The ACTIVE scene's timeline markers (the lane creates/moves them); kind
   *  is what marker triggers filter on. */
  markers: { id: string; time: number; kind: string }[];
  onUpdateMarkerKind: (markerId: string, kind: string) => void;
  onDeleteMarker: (markerId: string) => void;
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
  onRelease,
  embeds,
  embedScenes,
  onUpdateEmbed,
  onDeleteEmbed,
  markers,
  onUpdateMarkerKind,
  onDeleteMarker
}: SceneInspectorProps) {
  return (
    <>
      <SettingsSection title="View">
        <ViewModeToggle viewMode={viewMode} onViewModeChange={onViewModeChange} variant="labeled" />
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
          <select value={typeof blendCurve === "string" ? blendCurve : "easeInOut"} onChange={(event) => onBlendCurveChange(event.target.value as VirtualCameraBlendCurve)}>
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

      {embeds.length > 0 ? (
        <SettingsSection title="Embeds">
          {embeds.map((embed) => (
            <div key={embed.id} style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <select
                  title="Which scene this window plays"
                  value={embed.sceneId}
                  onChange={(event) => onUpdateEmbed(embed.id, { sceneId: event.target.value })}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {embedScenes.map((scene) => (
                    <option key={scene.id} value={scene.id}>{scene.name}</option>
                  ))}
                </select>
                <span style={{ color: "rgba(232, 238, 245, 0.55)", fontSize: 11, flex: "0 0 auto" }}>
                  {embed.start.toFixed(1)}–{embed.end.toFixed(1)}s
                </span>
                <button className="pc-danger" title="Remove this embed clip" onClick={() => onDeleteEmbed(embed.id)}>×</button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 11, color: "rgba(232, 238, 245, 0.55)" }}>Offset</span>
                  <input type="number" min={0} step={0.25} value={embed.offset} title="Scene-local time at the window's start"
                    onChange={(event) => onUpdateEmbed(embed.id, { offset: Math.max(0, Number(event.target.value)) })} style={{ width: 64 }} />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 11, color: "rgba(232, 238, 245, 0.55)" }}>Blend</span>
                  <input type="number" min={0} step={0.25} value={embed.blendSeconds} title="Camera blend at the window's edges (0 = cut)"
                    onChange={(event) => onUpdateEmbed(embed.id, { blendSeconds: Math.max(0, Number(event.target.value)) })} style={{ width: 64 }} />
                </label>
              </div>
            </div>
          ))}
          <div style={{ fontSize: 11, color: "rgba(232, 238, 245, 0.55)", lineHeight: 1.45 }}>
            Scenes embedded in this scene's timeline (the "Scenes" lane creates and times them).
          </div>
        </SettingsSection>
      ) : null}

      {markers.length > 0 ? (
        <SettingsSection title="Markers">
          {markers.map((marker) => (
            <div key={marker.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <span style={{ color: "rgba(232, 238, 245, 0.55)", fontSize: 11, flex: "0 0 auto", width: 42 }}>
                {marker.time.toFixed(2)}s
              </span>
              <input
                type="text"
                value={marker.kind}
                aria-label="Marker kind"
                title="Marker kind — marker triggers can filter on it"
                onChange={(event) => onUpdateMarkerKind(marker.id, event.target.value)}
                style={{ flex: 1, minWidth: 0, boxSizing: "border-box" }}
              />
              <button className="pc-danger" title="Remove this marker" onClick={() => onDeleteMarker(marker.id)}>×</button>
            </div>
          ))}
          <div style={{ fontSize: 11, color: "rgba(232, 238, 245, 0.55)", lineHeight: 1.45 }}>
            Markers fire marker triggers when playback crosses them (never on scrub). The Markers lane creates and moves them.
          </div>
        </SettingsSection>
      ) : null}

      <SettingsSection title="Viewport">
        <CheckRow checked={debugPreview} onChange={onDebugPreviewChange}>Show camera PiP</CheckRow>
        <CheckRow checked={debugFrustum} onChange={onDebugFrustumChange}>Show camera frustum</CheckRow>
        <CheckRow checked={pathStyle === "rail"} onChange={(on) => onPathStyleChange(on ? "rail" : "line")}>Path as dolly rail</CheckRow>
        <div style={{ fontSize: 11, color: "rgba(232, 238, 245, 0.55)", lineHeight: 1.45 }}>
          Orbit: right-drag. Pan: middle-drag. Zoom: wheel.
        </div>
      </SettingsSection>
    </>
  );
}
