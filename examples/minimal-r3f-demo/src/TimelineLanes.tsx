// Shot track over the demo show, built on @xzdarcy/react-timeline-editor as
// a controlled shell (their playback engine is never used). Mirrors
// Cinemachine's Timeline model: ONE track holds every shot clip; overlap =
// crossfade (rendered as the blend zone), touch = cut, later start blends in,
// full containment is vetoed. Clicking a clip selects its vcam. Quarantined
// by an error boundary so a crash can't kill the canvas.
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
    () => [
      {
        id: "shot-track",
        actions: shots.map((shot) => ({
          id: shot.id,
          start: shot.start,
          end: shot.end,
          effectId: "shot",
          movable: true,
          flexible: true
        }))
      }
    ],
    // timingKey covers everything this memo reads except names, which render
    // via the shots prop directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timingKey]
  );

  // Blend zones: fraction of each clip's width overlapped by the previous
  // clip (in start order), Cinemachine's blend-in region.
  const blendInFractions = useMemo(() => {
    const ordered = [...shots].sort((a, b) => a.start - b.start);
    const fractions = new Map<string, number>();
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1];
      const shot = ordered[i];
      if (!previous || !shot) continue;
      const overlap = previous.end - shot.start;
      const span = shot.end - shot.start;
      if (overlap > 0 && span > 0) {
        fractions.set(shot.id, Math.min(1, overlap / span));
      }
    }
    return fractions;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timingKey]);

  // Cinemachine's Mix mode defines blends only for partial overlap; veto
  // drags/resizes that would fully contain another clip (or be contained).
  const wouldFullyContain = (id: string, start: number, end: number): boolean =>
    shots.some(
      (other) =>
        other.id !== id &&
        ((start <= other.start && end >= other.end) ||
          (other.start <= start && other.end >= end))
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
          rowHeight={36}
          autoScroll
          dragLine
          style={{ width: "100%", height: 84 }}
          onActionMoving={({ action, start, end }) =>
            wouldFullyContain(action.id, start, end) ? false : undefined
          }
          onActionResizing={({ action, start, end }) =>
            wouldFullyContain(action.id, start, end) ? false : undefined
          }
          onClickRow={(_event, { time }) => onSeek(time)}
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
          getActionRender={(action) => {
            const selected = action.id === selectedShotId;
            const blendIn = blendInFractions.get(action.id) ?? 0;
            const base = selected ? "rgba(249, 115, 22, 0.45)" : "rgba(59, 130, 246, 0.35)";
            return (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: blendIn > 0.5 ? "flex-end" : "flex-start",
                  padding: "0 8px",
                  fontSize: 11,
                  color: "#e2e8f0",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  borderRadius: 4,
                  // The leading blend zone gets Unity's linear-cross look via
                  // a diagonal wedge; the rest is the flat clip color.
                  background:
                    blendIn > 0
                      ? `linear-gradient(to bottom right, transparent 49.5%, ${base} 50.5%) 0 0 / ${
                          blendIn * 100
                        }% 100% no-repeat, linear-gradient(${base}, ${base}) ${
                          blendIn * 100
                        }% 0 / ${(1 - blendIn) * 100}% 100% no-repeat`
                      : base,
                  border: selected
                    ? "1px solid rgba(249, 115, 22, 0.9)"
                    : "1px solid rgba(148, 163, 184, 0.35)"
                }}
              >
                {shotNames.get(action.id) ?? action.id}
              </div>
            );
          }}
        />
      </div>
    </LaneErrorBoundary>
  );
}
