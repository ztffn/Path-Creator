// Camera inspector: the per-shot editor for the one selected virtual camera. Lifts
// the former "Shots" per-row body — Go/activate + delete, track-aim target, the
// screen composer (RigSettingsPanel), cart dolly binding or orbit params by body
// type, and the per-axis manual-control modes. Scoped to a single camera; the
// hierarchy owns the list + add affordances. Pure presentation via App handlers.
import { useState, type CSSProperties } from "react";
import type { CameraOverrideAxisMode, ComposerSettings, RegisteredTarget, RigCartDefinition } from "@huma/path-creator/core";
import type { VirtualCameraSnapshot } from "@huma/path-creator/three";
import { CollapsibleGroup, MUTED } from "./panel-theme";
import { NumberSlider, RigSettingsPanel } from "./rig-settings-panel";
import { DEFAULT_COMPOSER_SETTINGS, type DemoShotPatch, type DemoVirtualCamera } from "./vcam-model";

// Authorable lens fields (dutch stays in the Composer). Each is optional on the
// vcam's lens: unchecked = inherited (absent), checked = an explicit override
// seeded from `seed`. Physical ranges, unlike the normalized curves elsewhere.
const LENS_FIELDS = [
  { key: "fov", label: "FOV", min: 10, max: 120, step: 1, unit: "°", seed: 45 },
  { key: "zoom", label: "Zoom", min: 0.1, max: 5, step: 0.05, seed: 1 },
  { key: "near", label: "Near", min: 0.01, max: 10, step: 0.01, seed: 0.1 },
  { key: "far", label: "Far", min: 1, max: 1000, step: 1, seed: 100 }
] as const;

function getSnapshotLabel(snapshot: VirtualCameraSnapshot): string {
  const lens = snapshot.lens?.fov ? `${snapshot.lens.fov.toFixed(0)}deg` : "lens";
  return `${snapshot.position.x.toFixed(1)}, ${snapshot.position.y.toFixed(1)}, ${snapshot.position.z.toFixed(1)} - ${lens}`;
}

function rowLabelStyle(columns: string): CSSProperties {
  return { display: "grid", gridTemplateColumns: columns, alignItems: "center", gap: 6, fontSize: 11, color: "#94a3b8" };
}

export interface CameraInspectorProps {
  camera: DemoVirtualCamera;
  isActive: boolean;
  trackTargets: RegisteredTarget[];
  dollies: RigCartDefinition[];
  onActivate: () => void;
  onDelete: () => void;
  onUpdateShot: (patch: DemoShotPatch) => void;
  onUpdateComposer: (settings: ComposerSettings) => void;
}

export function CameraInspector({ camera, isActive, trackTargets, dollies, onActivate, onDelete, onUpdateShot, onUpdateComposer }: CameraInspectorProps) {
  const [composerOpen, setComposerOpen] = useState(false);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 11, color: "#94a3b8", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {camera.bodyType === "cart" ? "rides the rail cart" : getSnapshotLabel(camera.snapshot)}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6 }}>
        <button onClick={onActivate}>{isActive ? "Reapply" : "Go"}</button>
        <button className="pc-danger" onClick={onDelete}>Del</button>
      </div>

      <label style={rowLabelStyle("48px 1fr")}>
        <span>Track</span>
        <select value={camera.trackTargetId ?? ""} onChange={(event) => onUpdateShot({ trackTargetId: event.target.value || null })}>
          <option value="">Body aim (none)</option>
          {trackTargets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.name}
            </option>
          ))}
        </select>
      </label>

      <CollapsibleGroup title="Lens">
        {LENS_FIELDS.map((field) => {
          const value = camera.snapshot.lens?.[field.key];
          const enabled = value !== undefined;
          return (
            <div key={field.key} style={{ display: "grid", gap: 4 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => onUpdateShot({ lens: { [field.key]: event.target.checked ? field.seed : null } })}
                />
                {enabled ? null : (
                  <>
                    <span>{field.label}</span>
                    <span style={{ color: MUTED, fontSize: 11 }}>inherited</span>
                  </>
                )}
              </label>
              {enabled ? (
                <NumberSlider
                  label={field.label}
                  value={value ?? field.seed}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  {...("unit" in field && field.unit ? { unit: field.unit } : {})}
                  onChange={(next) => onUpdateShot({ lens: { [field.key]: next } })}
                />
              ) : null}
            </div>
          );
        })}
        {/* Dutch (roll) is a lens field too, but has a valid 0 (= level), so it's a
            plain slider — no inherit toggle. */}
        <NumberSlider label="Dutch" value={camera.dutchDeg} min={-45} max={45} step={1} unit="°" onChange={(deg) => onUpdateShot({ dutchDeg: deg })} />
      </CollapsibleGroup>

      <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
        <button style={{ fontSize: 11, textAlign: "left" }} onClick={() => setComposerOpen((o) => !o)}>
          {composerOpen ? "▾ Composer settings" : "▸ Composer settings"}
        </button>
        {composerOpen ? (
          <RigSettingsPanel
            settings={camera.composerSettings}
            noisePreset={camera.noisePreset}
            onChange={(settings) => onUpdateComposer(settings)}
            onNoisePresetChange={(noisePreset) => onUpdateShot({ noisePreset })}
            onClose={() => setComposerOpen(false)}
            onReset={() => onUpdateComposer(DEFAULT_COMPOSER_SETTINGS)}
          />
        ) : null}
      </div>

      {camera.bodyType === "cart" ? (
        <label style={rowLabelStyle("48px 1fr")} title="Which dolly this camera rides; the dolly's motion is authored on its timeline lane">
          <span>Dolly</span>
          <select value={camera.cartId} onChange={(event) => onUpdateShot({ cartId: event.target.value })}>
            {dollies.map((dolly) => (
              <option key={dolly.id} value={dolly.id}>
                {dolly.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {camera.bodyType === "orbit" ? (
        <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
          <label style={rowLabelStyle("64px 1fr")} title="The target this camera orbits">
            <span>Orbit</span>
            <select value={camera.orbitTargetId} onChange={(event) => onUpdateShot({ orbitTargetId: event.target.value })}>
              <option value="">(fixed origin)</option>
              {trackTargets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name}
                </option>
              ))}
            </select>
          </label>
          <label
            style={rowLabelStyle("64px 1fr")}
            title="World: compass-anchored (ignores target rotation). LockYaw: follows target heading, level horizon. Lock: welds to target (rolls with it)."
          >
            <span>Binding</span>
            <select
              value={camera.orbitBinding}
              onChange={(event) => onUpdateShot({ orbitBinding: event.target.value as DemoVirtualCamera["orbitBinding"] })}
            >
              <option value="world">World (compass-anchored)</option>
              <option value="lockYaw">Lock yaw (level horizon)</option>
              <option value="lock">Lock (welded)</option>
            </select>
          </label>
          <label style={rowLabelStyle("64px 1fr")}>
            <span>Azimuth</span>
            <input type="range" min={-180} max={180} step={1} value={camera.orbitAzimuthDeg}
              onChange={(event) => onUpdateShot({ orbitAzimuthDeg: Number(event.target.value) })} />
          </label>
          <label style={rowLabelStyle("64px 1fr")}>
            <span>Elevation</span>
            <input type="range" min={-80} max={80} step={1} value={camera.orbitElevationDeg}
              onChange={(event) => onUpdateShot({ orbitElevationDeg: Number(event.target.value) })} />
          </label>
          <label style={rowLabelStyle("64px 1fr")}>
            <span>Radius</span>
            <input type="range" min={0.5} max={20} step={0.1} value={camera.orbitRadius}
              onChange={(event) => onUpdateShot({ orbitRadius: Number(event.target.value) })} />
          </label>
          <label style={rowLabelStyle("64px 1fr")} title="Auto-orbit rate in degrees/second (0 holds a static angle)">
            <span>Spin °/s</span>
            <input type="range" min={-90} max={90} step={1} value={camera.orbitAutoDegPerSec}
              onChange={(event) => onUpdateShot({ orbitAutoDegPerSec: Number(event.target.value) })} />
          </label>
        </div>
      ) : null}

      <div
        style={{ display: "grid", gap: 6, minWidth: 0 }}
        title="How each axis responds to live piloting (drag/scroll the PiP while this shot is active)"
      >
        <CollapsibleGroup title="Manual control · LMB orbit / RMB pan / wheel dolly">
          {(["azimuth", "elevation", "pan", "dolly"] as const).map((axis) => (
            <label key={axis} style={rowLabelStyle("64px 1fr")}>
              <span style={{ textTransform: "capitalize" }}>{axis}</span>
              <select
                value={camera.overrideControl[axis]?.mode ?? "locked"}
                onChange={(event) =>
                  onUpdateShot({
                    overrideControl: {
                      ...camera.overrideControl,
                      [axis]:
                        event.target.value === "recenter"
                          ? { mode: "recenter", recenterWait: 1.5, recenterTime: 1 }
                          : { mode: event.target.value as CameraOverrideAxisMode }
                    }
                  })
                }
              >
                <option value="locked">Locked (coded only)</option>
                <option value="free">Free (override, holds)</option>
                <option value="recenter">Recenter (override, eases back)</option>
              </select>
            </label>
          ))}
        </CollapsibleGroup>
      </div>
    </div>
  );
}
