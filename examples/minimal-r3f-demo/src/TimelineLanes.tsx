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
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { seekTimelinePlayer, type TimelinePlayer } from "@huma/path-creator/timeline";

const SHOT_EFFECTS = {
  shot: { id: "shot", name: "Shot" },
  move: { id: "move", name: "Dolly move" }
};
const SNAP_SECONDS = 0.25;

export interface LaneShot {
  id: string;
  name: string;
  start: number;
  end: number;
}

export interface LaneDollyMove {
  /** Shot that owns this move (clicking the move selects it). */
  shotId: string;
  dollyId: string;
  dollyName: string;
  start: number;
  end: number;
  label: string;
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
  dollyMoves,
  selectedShotId,
  playerRef,
  duration,
  driving,
  onShotTiming,
  onSelectShot,
  onSeek,
  onTransport,
  onCreateShot,
  onCreateDolly,
  onCreatePath
}: {
  shots: LaneShot[];
  dollyMoves: LaneDollyMove[];
  selectedShotId: string | null;
  playerRef: { current: TimelinePlayer };
  duration: number;
  driving: boolean;
  onShotTiming: (shotId: string, start: number, end: number) => void;
  onSelectShot: (shotId: string) => void;
  onSeek: (timeSeconds: number) => void;
  onTransport: () => void;
  onCreateShot: (kind: "capture" | "cart", timeSeconds: number) => void;
  onCreateDolly: () => void;
  onCreatePath: () => void;
}) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    time: number;
    onShotTrack: boolean;
  } | null>(null);
  const laneStateRef = useRef<TimelineState>(null);
  const [playing, setPlaying] = useState(false);
  const timeLabelRef = useRef<HTMLSpanElement>(null);

  const timingKey =
    shots.map((shot) => `${shot.id}:${shot.start}:${shot.end}`).join("|") +
    dollyMoves.map((move) => `${move.shotId}:${move.dollyId}:${move.start}:${move.end}`).join("|");
  const dollyLanes = useMemo(() => {
    const lanes = new Map<string, { name: string; moves: LaneDollyMove[] }>();
    for (const move of dollyMoves) {
      const lane = lanes.get(move.dollyId) ?? { name: move.dollyName, moves: [] };
      lane.moves.push(move);
      lanes.set(move.dollyId, lane);
    }
    return [...lanes.entries()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timingKey]);
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
      },
      // Dolly lanes visualize the per-shot rail moves; they are owned by
      // their shots, so the lane blocks are read-only.
      ...dollyLanes.map(([dollyId, lane]) => ({
        id: `dolly-${dollyId}`,
        actions: lane.moves.map((move) => ({
          id: `move-${move.shotId}`,
          start: move.start,
          end: move.end,
          effectId: "move",
          movable: false,
          flexible: false
        }))
      }))
    ],
    // timingKey covers everything this memo reads except names, which render
    // via the shots prop directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timingKey]
  );
  const moveLabels = new Map(dollyMoves.map((move) => [`move-${move.shotId}`, move.label]));

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

  // One rAF loop slaves the lane cursor to our player clock (setTime
  // forceUpdates their tree, so only when the cursor actually moved) and
  // keeps the transport header's time/playing state fresh.
  useEffect(() => {
    let raf = 0;
    const sync = () => {
      const player = playerRef.current;
      const laneState = laneStateRef.current;
      if (laneState) {
        const time = Math.max(0, player.time);
        if (Math.abs(laneState.getTime() - time) > 0.0005) {
          laneState.setTime(time);
        }
      }
      if (timeLabelRef.current) {
        timeLabelRef.current.textContent = `${player.time.toFixed(1)}s`;
      }
      setPlaying(player.playing);
      raf = requestAnimationFrame(sync);
    };
    raf = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(raf);
  }, [playerRef]);

  const shotNames = new Map(shots.map((shot) => [shot.id, shot.name]));

  return (
    <LaneErrorBoundary>
      <div
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: 10,
          borderRadius: 8,
          background: "rgba(10, 16, 28, 0.92)",
          color: "#f8fafc",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          border: "1px solid rgba(148, 163, 184, 0.22)"
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            marginBottom: shots.length > 0 ? 8 : 0
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 800 }}>Timeline</span>
          {shots.length > 0 ? (
            <>
              <button
                onClick={() => {
                  const player = playerRef.current;
                  if (!player.playing && player.time >= duration) {
                    seekTimelinePlayer(player, 0);
                  }
                  player.playing = !player.playing;
                  onTransport();
                }}
              >
                {playing ? "Pause" : "Play"}
              </button>
              <select
                defaultValue="1"
                title="Playback rate"
                onChange={(event) => {
                  playerRef.current.rate = Number(event.target.value);
                }}
              >
                <option value="0.5">0.5x</option>
                <option value="1">1x</option>
                <option value="2">2x</option>
              </select>
              <span ref={timeLabelRef} style={{ marginLeft: "auto", color: "#94a3b8" }}>
                0.0s
              </span>
              <span style={{ color: "#64748b" }}>/ {duration.toFixed(0)}s</span>
              <span style={{ fontSize: 11, color: driving ? "#22c55e" : "#64748b" }}>
                {driving ? "● PiP" : "○ PiP"}
              </span>
            </>
          ) : (
            <span style={{ marginLeft: "auto", fontSize: 11, color: "#94a3b8" }}>
              Add vcams to build the show
            </span>
          )}
        </div>

        {(
          <div style={{ display: "flex", alignItems: "stretch", gap: 4 }}>
            <div
              style={{
                width: 22,
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-end",
                fontSize: 14,
                textAlign: "center"
              }}
            >
              <div style={{ height: 36, lineHeight: "36px" }} title="Shot track">
                🎥
              </div>
              {dollyLanes.map(([dollyId, lane]) => (
                <div
                  key={dollyId}
                  style={{ height: 36, lineHeight: "36px" }}
                  title={`${lane.name} moves`}
                >
                  🛤
                </div>
              ))}
            </div>
            <div style={{ flex: 1, minWidth: 0, borderRadius: 6, overflow: "hidden" }}>
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
          style={{ width: "100%", height: 48 + (1 + dollyLanes.length) * 36 }}
          onActionMoving={({ action, start, end }) =>
            wouldFullyContain(action.id, start, end) ? false : undefined
          }
          onActionResizing={({ action, start, end }) =>
            wouldFullyContain(action.id, start, end) ? false : undefined
          }
          onClickRow={(_event, { time }) => onSeek(time)}
          onDoubleClickRow={(_event, { row, time }) => {
            if (row.id === "shot-track") onCreateShot("cart", time);
          }}
          onContextMenuRow={(event, { row, time }) => {
            event.preventDefault();
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              time,
              onShotTrack: row.id === "shot-track"
            });
          }}
          onContextMenuAction={(event, { row, time }) => {
            event.preventDefault();
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              time,
              onShotTrack: row.id === "shot-track"
            });
          }}
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
          onClickAction={(_event, { action }) =>
            onSelectShot(action.id.startsWith("move-") ? action.id.slice(5) : action.id)
          }
          onClickTimeArea={(time) => {
            onSeek(time);
            return true;
          }}
          onCursorDrag={onSeek}
          getActionRender={(action) => {
            if (action.effectId === "move") {
              const ownerSelected = action.id === `move-${selectedShotId}`;
              return (
                <div
                  style={{
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    padding: "0 8px",
                    fontSize: 10,
                    color: "#cbd5e1",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    borderRadius: 4,
                    background: ownerSelected ? "rgba(249, 115, 22, 0.22)" : "rgba(148, 163, 184, 0.16)",
                    border: `1px dashed ${
                      ownerSelected ? "rgba(249, 115, 22, 0.7)" : "rgba(148, 163, 184, 0.4)"
                    }`
                  }}
                >
                  {moveLabels.get(action.id) ?? "move"}
                </div>
              );
            }
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
          </div>
        )}


        {contextMenu ? (
          <div
            style={{ position: "fixed", inset: 0, zIndex: 30 }}
            onClick={() => setContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu(null);
            }}
          >
            <div
              style={{
                position: "fixed",
                left: contextMenu.x,
                top: contextMenu.y,
                display: "grid",
                minWidth: 200,
                padding: 4,
                borderRadius: 6,
                background: "rgba(10, 16, 28, 0.98)",
                border: "1px solid rgba(148, 163, 184, 0.22)",
                fontSize: 12,
                zIndex: 31
              }}
              onClick={(event) => event.stopPropagation()}
            >
              {contextMenu.onShotTrack ? (
                <>
                  <button
                    style={{ textAlign: "left" }}
                    onClick={() => {
                      onCreateShot("capture", contextMenu.time);
                      setContextMenu(null);
                    }}
                  >
                    Add camera here (capture viewport)
                  </button>
                  <button
                    style={{ textAlign: "left" }}
                    onClick={() => {
                      onCreateShot("cart", contextMenu.time);
                      setContextMenu(null);
                    }}
                  >
                    Add cart camera here
                  </button>
                  <div
                    style={{
                      height: 1,
                      margin: "4px 0",
                      background: "rgba(148, 163, 184, 0.18)"
                    }}
                  />
                </>
              ) : null}
              <button
                style={{ textAlign: "left" }}
                onClick={() => {
                  onCreateDolly();
                  setContextMenu(null);
                }}
              >
                Add dolly
              </button>
              <button
                style={{ textAlign: "left" }}
                onClick={() => {
                  onCreatePath();
                  setContextMenu(null);
                }}
              >
                Add path
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </LaneErrorBoundary>
  );
}
