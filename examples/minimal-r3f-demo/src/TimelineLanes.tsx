// Lane editor over the demo show, built on @xzdarcy/react-timeline-editor as
// a controlled shell (their playback engine is never used). One lane per
// shot; blocks move and resize freely and write start/end back; overlapping
// the previous shot IS the crossfade control; clicking a block selects its
// vcam. Quarantined by an error boundary so a crash can't kill the canvas.
import {
  Timeline as TimelineLaneEditor,
  type TimelineState
} from "@xzdarcy/react-timeline-editor";
import type { TimelineRow } from "@xzdarcy/timeline-engine";
import "@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css";
import { Component, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { TimelinePlayer } from "@huma/path-creator/timeline";

const SHOT_EFFECTS = { shot: { id: "shot", name: "Shot" } };
const SNAP_SECONDS = 0.25;

export interface LaneShot {
  id: string;
  name: string;
  start: number;
  end: number;
}

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
          Lane editor crashed — see console.
        </div>
      );
    }
    return this.props.children;
  }
}

export function TimelineLanes({
  shots,
  selectedShotId,
  playerRef,
  onShotTiming,
  onSelectShot,
  onSeek
}: {
  shots: LaneShot[];
  selectedShotId: string | null;
  playerRef: { current: TimelinePlayer };
  onShotTiming: (shotId: string, start: number, end: number) => void;
  onSelectShot: (shotId: string) => void;
  onSeek: (timeSeconds: number) => void;
}) {
  const laneStateRef = useRef<TimelineState>(null);

  const timingKey = shots.map((shot) => `${shot.id}:${shot.start}:${shot.end}`).join("|");
  const editorData = useMemo<TimelineRow[]>(
    () =>
      shots.map((shot) => ({
        id: shot.id,
        actions: [
          {
            id: shot.id,
            start: shot.start,
            end: shot.end,
            effectId: "shot",
            movable: true,
            flexible: true
          }
        ]
      })),
    // timingKey covers everything this memo reads except names, which render
    // via the shots prop directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timingKey]
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

  const shotNames = new Map(shots.map((shot) => [shot.id, shot.name]));

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
          rowHeight={30}
          autoScroll
          dragLine
          style={{ width: "100%", height: Math.min(220, 42 + shots.length * 30) }}
          onChange={(rows) => {
            for (const row of rows) {
              for (const action of row.actions) {
                const shot = shots.find((item) => item.id === action.id);
                if (!shot) continue;
                const start = Math.max(0, Math.round(action.start / SNAP_SECONDS) * SNAP_SECONDS);
                const end = Math.max(
                  start + SNAP_SECONDS,
                  Math.round(action.end / SNAP_SECONDS) * SNAP_SECONDS
                );
                if (Math.abs(start - shot.start) > 1e-6 || Math.abs(end - shot.end) > 1e-6) {
                  onShotTiming(action.id, start, end);
                }
              }
            }
          }}
          onClickAction={(_event, { action }) => onSelectShot(action.id)}
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
                textOverflow: "ellipsis",
                borderRadius: 4,
                background:
                  action.id === selectedShotId ? "rgba(249, 115, 22, 0.45)" : "rgba(59, 130, 246, 0.35)",
                border:
                  action.id === selectedShotId
                    ? "1px solid rgba(249, 115, 22, 0.9)"
                    : "1px solid rgba(148, 163, 184, 0.35)"
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
