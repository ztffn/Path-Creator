// The capture affordances: key the viewport selection's pose at the playhead, or give it a
// visibility clip from the playhead to the end. Both read the LIVE selection through the
// editor's own useViewer re-export and write ONE batched track update — one undo entry per
// press. Keying while the scene is driven captures the driven pose (what you see); the hint
// nudges toward pose-then-key in edit mode, where the pose is the author's own.
"use client";

import { type ReactNode } from "react";
import { useStore } from "zustand";
import { useViewer } from "@pascal-app/editor";
import { captureTransformKey, withActivationClip } from "../plugin/keying";
import { readStoredTimeline, writeTracks, type StoredTimeline } from "../plugin/timeline-io";
import { pascalTimeTransport } from "../transport/store";
import { formatSeconds, styles, useNodeLabel } from "./panel-shared";

/** From the playhead to the end of the timeline — the author trims the end afterwards. */
function addVisibilityClip(stored: StoredTimeline, objectId: string, time: number): void {
  const fresh = readStoredTimeline(stored.id);
  if (!fresh) return;
  writeTracks(
    stored.id,
    withActivationClip(fresh.tracks, objectId, time, fresh.durationSeconds)
  );
}

export function KeyingSection({ stored }: { stored: StoredTimeline }): ReactNode {
  const selectedIds = useViewer((s) => s.selection.selectedIds);
  const time = useStore(pascalTimeTransport, (s) => s.time);
  const driving = useStore(pascalTimeTransport, (s) => s.driving);
  const label = useNodeLabel();
  const target = selectedIds[0] ?? null;
  // The timeline's own kinds have no pose to key; keying the clock would be a loop.
  const keyable = target !== null && !target.startsWith("humatime_");

  return (
    <div style={styles.row}>
      <button
        style={{ ...styles.button, opacity: keyable ? 1 : 0.4 }}
        type="button"
        disabled={!keyable}
        onClick={() => {
          if (target) captureTransformKey(stored.id, target, time);
        }}
        title={
          keyable
            ? `Key ${label(target)}'s current pose at ${formatSeconds(time)} s`
            : "Select an object in the viewport to key it"
        }
      >
        ◆ Key {keyable ? label(target) : "selection"} @ {formatSeconds(time)} s
      </button>
      <button
        style={{ ...styles.smallButton, opacity: keyable ? 1 : 0.4 }}
        type="button"
        disabled={!keyable}
        onClick={() => {
          if (target) addVisibilityClip(stored, target, time);
        }}
        title={
          keyable
            ? `Visible from ${formatSeconds(time)} s to the end — and hidden outside its clips. Trim the clip in the track below.`
            : "Select an object in the viewport first"
        }
      >
        ◎ Vis
      </button>
      {keyable && driving ? (
        <span
          style={{ ...styles.muted, fontSize: 11 }}
          title="The pose you see is the track's, not one you set. Turn Preview off to pose the object first."
        >
          driven pose
        </span>
      ) : null}
    </div>
  );
}
