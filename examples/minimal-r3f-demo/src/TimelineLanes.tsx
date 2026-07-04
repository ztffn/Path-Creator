// Spike: @xzdarcy/react-timeline-editor as a disposable, controlled lane UI
// over the demo's auto-built camera timeline. Blocks derive from per-shot
// durations; resizing a block writes the duration back; the cursor is slaved
// to our TimelinePlayer and their playback engine is never used. If this
// library fights React 19, replace with a custom ~300-line lane component.
import {
  Timeline as TimelineLaneEditor,
  type TimelineState
} from "@xzdarcy/react-timeline-editor";
import type { TimelineRow } from "@xzdarcy/timeline-engine";
import "@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css";
import { Component, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { Timeline, TimelinePlayer } from "@huma/path-creator/timeline";

/**
 * Quarantines the third-party lane editor: a crash inside it must not
 * unmount the app (and with it the WebGL canvas).
 */
class LaneErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div style={{ padding: 8, fontSize: 12, color: "#fca5a5" }}>
          Lane editor crashed — spike fail signal. See console.
        </div>
      );
    }
    return this.props.children;
  }
}

const SHOT_EFFECTS = { shot: { id: "shot", name: "Shot" } };

export function TimelineLanes({
  timeline,
  shotNames,
  playerRef,
  onShotDuration,
  onSeek
}: {
  timeline: Timeline;
  shotNames: Map<string, string>;
  playerRef: { current: TimelinePlayer };
  onShotDuration: (vcamId: string, durationSeconds: number) => void;
  onSeek: (timeSeconds: number) => void;
}) {
  const laneStateRef = useRef<TimelineState>(null);

  const editorData = useMemo<TimelineRow[]>(
    () =>
      timeline.tracks
        .filter((track) => track.type === "camera")
        .map((track) => ({
          id: track.id,
          actions: track.blocks.map((block) => ({
            id: block.vcamId,
            start: block.start,
            end: block.end,
            effectId: "shot",
            // Starts derive from the preceding shots' durations, so blocks
            // resize but don't move.
            movable: false,
            flexible: true
          }))
        })),
    [timeline]
  );

  // Slave the lane cursor to our player clock; their engine never runs.
  // setTime forceUpdates their tree, so only call it when the cursor
  // actually moved.
  useEffect(() => {
    let raf = 0;
    const sync = () => {
      const laneState = laneStateRef.current;
      if (laneState) {
        const time = Math.max(0, playerRef.current.time);
        if (Math.abs(laneState.getTime() - time) > 0.0005) {
          laneState.setTime(time);
        }
      }
      raf = requestAnimationFrame(sync);
    };
    raf = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(raf);
  }, [playerRef]);

  return (
    <LaneErrorBoundary>
      <div style={{ width: "100%", borderRadius: 8, overflow: "hidden" }}>
        <TimelineLaneEditor
        ref={laneStateRef}
        editorData={editorData}
        effects={SHOT_EFFECTS}
        scale={5}
        scaleWidth={110}
        scaleSplitCount={5}
        startLeft={12}
        rowHeight={36}
        autoScroll
        style={{ width: "100%", height: 90 }}
        onChange={(rows) => {
          const previous = new Map(
            editorData.flatMap((row) => row.actions.map((action) => [action.id, action]))
          );
          for (const row of rows) {
            for (const action of row.actions) {
              const before = previous.get(action.id);
              const duration = Math.max(0.5, action.end - action.start);
              if (!before || Math.abs(duration - (before.end - before.start)) > 1e-6) {
                onShotDuration(action.id, Math.round(duration * 4) / 4);
              }
            }
          }
        }}
        onClickTimeArea={(time) => {
          onSeek(time);
          return true;
        }}
        onCursorDrag={onSeek}
        getActionRender={(action) => (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              padding: "0 8px",
              fontSize: 11,
              color: "#e2e8f0",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis"
            }}
          >
            {shotNames.get(action.id) ?? action.id}
          </div>
        )}
        />
      </div>
    </LaneErrorBoundary>
  );
}
