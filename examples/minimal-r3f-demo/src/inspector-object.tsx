// Object inspector: identity + timeline tracks for the one selected activatable (a
// bindable "GameObject": the turbine, a demo prop, or an animated GLB). Reuses the
// Activation editor (visibility), the Transform editor (keyframed pos/rot/scale, any
// object), and — for a GLB carrying baked clips — the Animation editor. Each is
// scoped to the tracks bound to this object with a local "bind a new track"
// affordance; onChange emits only the changed ExtraTracks slice (merged at App level).
import { ActivationTracksEditor, AnimationTracksEditor, TransformTracksEditor, newActivationTrack, newAnimationTrack, newTransformTrack, type ObjectPose } from "./extra-tracks-panel";
import type { ActivatableInfo } from "./activatables";
import type { ExtraTracks } from "./extra-tracks";

export interface ObjectInspectorProps {
  objectId: string;
  objectName: string;
  extraTracks: ExtraTracks;
  activatables: ActivatableInfo[];
  onChange: (next: Partial<ExtraTracks>) => void;
  /** Live playhead time (s); forwarded to the transform editor's "key @ playhead". */
  getPlayhead?: () => number;
  /** Reads the object's live local transform, for "key pose @ playhead". */
  readObjectPose?: (objectId: string) => ObjectPose | null;
}

export function ObjectInspector({ objectId, objectName, extraTracks, activatables, onChange, getPlayhead, readObjectPose }: ObjectInspectorProps) {
  const bound = extraTracks.activationTracks.filter((track) => track.objectId === objectId);
  const others = extraTracks.activationTracks.filter((track) => track.objectId !== objectId);
  const clips = activatables.find((a) => a.id === objectId)?.clips ?? [];
  const boundAnim = extraTracks.animationTracks.filter((track) => track.objectId === objectId);
  const otherAnim = extraTracks.animationTracks.filter((track) => track.objectId !== objectId);
  const boundXf = extraTracks.transformTracks.filter((track) => track.objectId === objectId);
  const otherXf = extraTracks.transformTracks.filter((track) => track.objectId !== objectId);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 12, color: "#94a3b8" }}>
        {bound.length === 0
          ? "Not activated by any track — bind one to toggle its visibility over time."
          : `${bound.length} activation track${bound.length === 1 ? "" : "s"} bound to ${objectName}.`}
      </div>
      <ActivationTracksEditor
        activationTracks={bound}
        activatables={activatables}
        hideAdd
        onChange={(next) => onChange({ activationTracks: [...others, ...(next.activationTracks ?? bound)] })}
      />
      <button
        style={{ justifySelf: "start" }}
        onClick={() => onChange({ activationTracks: [...extraTracks.activationTracks, newActivationTrack(objectId)] })}
      >
        Add activation track
      </button>
      <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
        {boundXf.length === 0
          ? "Keyframe position / rotation / scale over time — no baked clip needed."
          : `${boundXf.length} transform track${boundXf.length === 1 ? "" : "s"} keying ${objectName}.`}
      </div>
      <TransformTracksEditor
        transformTracks={boundXf}
        activatables={activatables}
        hideAdd
        {...(getPlayhead && { getPlayhead })}
        {...(readObjectPose && { readObjectPose })}
        onChange={(next) => onChange({ transformTracks: [...otherXf, ...(next.transformTracks ?? boundXf)] })}
      />
      <button
        style={{ justifySelf: "start" }}
        onClick={() => onChange({ transformTracks: [...extraTracks.transformTracks, newTransformTrack(objectId)] })}
      >
        Add transform track
      </button>
      {clips.length > 0 ? (
        <>
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
            {boundAnim.length === 0
              ? `Baked clips: ${clips.join(", ")}. Bind an animation track to drive them from the timeline.`
              : `${boundAnim.length} animation track${boundAnim.length === 1 ? "" : "s"} driving ${objectName}.`}
          </div>
          <AnimationTracksEditor
            animationTracks={boundAnim}
            activatables={activatables}
            hideAdd
            onChange={(next) => onChange({ animationTracks: [...otherAnim, ...(next.animationTracks ?? boundAnim)] })}
          />
          <button
            style={{ justifySelf: "start" }}
            onClick={() => onChange({ animationTracks: [...extraTracks.animationTracks, newAnimationTrack(objectId)] })}
          >
            Add animation track
          </button>
        </>
      ) : null}
    </div>
  );
}
