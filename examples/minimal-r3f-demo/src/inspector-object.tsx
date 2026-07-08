// Object inspector: identity + activation timeline for the one selected activatable
// (a bindable "GameObject": the turbine or a demo prop). Reuses ActivationTracksEditor
// scoped to just the tracks bound to this object (add suppressed), plus a local
// "bind a new activation track to this object" affordance. onChange re-merges the
// scoped subset back into the full ExtraTracks. Pure presentation via App handlers.
import { ActivationTracksEditor } from "./extra-tracks-panel";
import type { ActivatableInfo } from "./activatables";
import type { ExtraTracks } from "./extra-tracks";

const uid = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

export interface ObjectInspectorProps {
  objectId: string;
  objectName: string;
  extraTracks: ExtraTracks;
  activatables: ActivatableInfo[];
  onChange: (next: ExtraTracks) => void;
}

export function ObjectInspector({ objectId, objectName, extraTracks, activatables, onChange }: ObjectInspectorProps) {
  const bound = extraTracks.activationTracks.filter((track) => track.objectId === objectId);
  const others = extraTracks.activationTracks.filter((track) => track.objectId !== objectId);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 12, color: "#94a3b8" }}>
        {bound.length === 0
          ? "Not activated by any track — bind one to toggle its visibility over time."
          : `${bound.length} activation track${bound.length === 1 ? "" : "s"} bound to ${objectName}.`}
      </div>
      <ActivationTracksEditor
        activationTracks={bound}
        audioTracks={extraTracks.audioTracks}
        activatables={activatables}
        hideAdd
        onChange={(next) => onChange({ activationTracks: [...others, ...next.activationTracks], audioTracks: next.audioTracks })}
      />
      <button
        style={{ justifySelf: "start" }}
        onClick={() =>
          onChange({
            activationTracks: [...extraTracks.activationTracks, { id: uid("act"), objectId, clips: [], postPlaybackState: "revert" }],
            audioTracks: extraTracks.audioTracks
          })
        }
      >
        Add activation track
      </button>
    </div>
  );
}
