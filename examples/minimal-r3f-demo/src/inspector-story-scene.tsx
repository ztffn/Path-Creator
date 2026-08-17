// Story-scene inspector: editor for one scene of the story — rename, play it
// live, flag it as the entry/master scene, see its derived duration, and delete
// it (delete cascades: embed clips in other scenes and trigger units playing it
// are removed by App). Selecting a scene row in the hierarchy also opens it for
// editing; this panel manages the scene's identity. Pure presentation.
import { MUTED } from "./panel-theme";

export interface StorySceneInspectorProps {
  name: string;
  isEntry: boolean;
  /** Derived from content (shots/clips/embeds/markers); empty scenes fall back to 5s. */
  duration: number;
  canDelete: boolean;
  onRename: (name: string) => void;
  onSetEntry: () => void;
  onPlay: () => void;
  onDelete: () => void;
}

export function StorySceneInspector(props: StorySceneInspectorProps) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
        <input
          type="text"
          value={props.name}
          aria-label="Scene name"
          onChange={(event) => props.onRename(event.target.value)}
          style={{ flex: 1, minWidth: 0, boxSizing: "border-box" }}
        />
        <button title="Play this scene live (blends the camera in and back)" onClick={props.onPlay}>▶</button>
        <button
          className="pc-danger"
          title={props.canDelete ? "Delete this scene (removes embeds and triggers using it)" : "The story needs at least one scene"}
          disabled={!props.canDelete}
          onClick={props.onDelete}
        >
          Del
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
        <span style={{ color: MUTED }}>Duration {props.duration.toFixed(1)}s (derived from content)</span>
      </div>

      {props.isEntry ? (
        <div style={{ fontSize: 11, color: "#a78bfa", letterSpacing: "0.06em" }}>ENTRY SCENE</div>
      ) : (
        <button style={{ justifySelf: "start" }} title="Make this the story's entry/master scene" onClick={props.onSetEntry}>
          Set as entry
        </button>
      )}

      <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.45 }}>
        The entry scene is the master the timeline panel edits by default; other scenes stack into it via the Scenes lane or play live via ▶ and triggers.
      </div>
    </div>
  );
}
