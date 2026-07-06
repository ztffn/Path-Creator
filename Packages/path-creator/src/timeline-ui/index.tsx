// Shot track over a rig show, built on @xzdarcy/react-timeline-editor as a
// controlled shell (their playback engine is never used). Mirrors Cinemachine's
// Timeline model: ONE track holds every shot clip; overlap = crossfade (rendered
// as the blend zone), touch = cut, full containment is vetoed. Themable via the
// optional `theme` prop; quarantined by an error boundary so a crash can't kill
// the host canvas. The editor's CSS is injected at build time (tsup injectStyle).
import {
  Timeline as TimelineLaneEditor,
  type TimelineState
} from "@xzdarcy/react-timeline-editor";
import type { TimelineRow } from "@xzdarcy/timeline-engine";
import "@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css";
import {
  Component,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { seekTimelinePlayer, type TimelinePlayer } from "../timeline";

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
 * Flat color/font record for the inline styles and the @xzdarcy CSS overrides.
 * Values default to the original demo colors; overrides for the editor chrome
 * are applied as CSS custom properties on the root element.
 */
export interface TimelineLanesTheme {
  panelBackground?: string;
  panelBorder?: string;
  text?: string;
  mutedText?: string;
  subtleText?: string;
  fontFamily?: string;
  accent?: string;
  accentSoft?: string;
  shotFill?: string;
  shotSelectedFill?: string;
  shotBorder?: string;
  shotSelectedBorder?: string;
  moveFill?: string;
  moveSelectedFill?: string;
  moveBorder?: string;
  moveSelectedBorder?: string;
  moveText?: string;
  live?: string;
  idle?: string;
  errorText?: string;
  contextMenuBackground?: string;
}

const DEFAULT_THEME: Required<TimelineLanesTheme> = {
  panelBackground: "rgba(10, 16, 28, 0.92)",
  panelBorder: "rgba(148, 163, 184, 0.22)",
  text: "#f8fafc",
  mutedText: "#94a3b8",
  subtleText: "#64748b",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  accent: "rgba(249, 115, 22, 0.9)",
  accentSoft: "rgba(249, 115, 22, 0.22)",
  shotFill: "rgba(59, 130, 246, 0.35)",
  shotSelectedFill: "rgba(249, 115, 22, 0.45)",
  shotBorder: "rgba(148, 163, 184, 0.35)",
  shotSelectedBorder: "rgba(249, 115, 22, 0.9)",
  moveFill: "rgba(148, 163, 184, 0.16)",
  moveSelectedFill: "rgba(249, 115, 22, 0.22)",
  moveBorder: "rgba(148, 163, 184, 0.4)",
  moveSelectedBorder: "rgba(249, 115, 22, 0.7)",
  moveText: "#cbd5e1",
  live: "#22c55e",
  idle: "#64748b",
  errorText: "#fca5a5",
  contextMenuBackground: "rgba(10, 16, 28, 0.98)"
};

/**
 * Quarantines the third-party lane editor: a crash inside it must not
 * unmount the app (and with it the WebGL canvas).
 */
class LaneErrorBoundary extends Component<
  { children: ReactNode; errorColor: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div style={{ padding: 8, fontSize: 12, color: this.props.errorColor }}>
          Lane editor crashed — see console.
        </div>
      );
    }
    return this.props.children;
  }
}

export interface TimelineLanesProps {
  shots: LaneShot[];
  /** One lane per dolly (shown even with no runs, so you can add the first one). */
  dollies: { id: string; name: string }[];
  dollyMoves: LaneDollyMove[];
  selectedShotId: string | null;
  playerRef: { current: TimelinePlayer };
  duration: number;
  driving: boolean;
  theme?: TimelineLanesTheme;
  onShotTiming: (shotId: string, start: number, end: number) => void;
  onSelectShot: (shotId: string) => void;
  onSeek: (timeSeconds: number) => void;
  onTransport: () => void;
  onCreateShot: (kind: "capture" | "cart", timeSeconds: number) => void;
  onCreateDolly: () => void;
  onCreatePath: () => void;
  /** A dolly run block was dragged/resized (ids are the cart and run). */
  onDollyRunTiming: (cartId: string, runId: string, start: number, end: number) => void;
  onCreateDollyRun: (cartId: string, timeSeconds: number) => void;
}

export function TimelineLanes({
  shots,
  dollies,
  dollyMoves,
  selectedShotId,
  playerRef,
  duration,
  driving,
  theme,
  onShotTiming,
  onSelectShot,
  onSeek,
  onTransport,
  onCreateShot,
  onCreateDolly,
  onCreatePath,
  onDollyRunTiming,
  onCreateDollyRun
}: TimelineLanesProps) {
  const t: Required<TimelineLanesTheme> = { ...DEFAULT_THEME, ...theme };
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    time: number;
    onShotTrack: boolean;
    dollyId?: string;
  } | null>(null);
  const laneStateRef = useRef<TimelineState>(null);
  const [playing, setPlaying] = useState(false);
  const timeLabelRef = useRef<HTMLSpanElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Clamp the context menu into the viewport (the lane sits at the bottom, so a
  // menu placed at the click point would open off-screen). Runs before paint.
  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (!menu || !contextMenu) return;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(contextMenu.x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(contextMenu.y, window.innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }, [contextMenu]);

  const timingKey =
    shots.map((shot) => `${shot.id}:${shot.start}:${shot.end}`).join("|") +
    dollies.map((dolly) => `${dolly.id}:${dolly.name}`).join(",") +
    dollyMoves.map((move) => `${move.shotId}:${move.dollyId}:${move.start}:${move.end}`).join("|");
  // One lane per dolly (even with no runs), so the lane is always there to
  // double-click / right-click for the first run.
  const dollyLanes = useMemo(
    () =>
      dollies.map(
        (dolly) =>
          [dolly.id, { name: dolly.name, moves: dollyMoves.filter((move) => move.dollyId === dolly.id) }] as const
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timingKey]
  );
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
          movable: true,
          flexible: true
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
    <LaneErrorBoundary errorColor={t.errorText}>
      <div
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: 10,
          borderRadius: 8,
          background: t.panelBackground,
          color: t.text,
          fontFamily: t.fontFamily,
          border: `1px solid ${t.panelBorder}`
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            marginBottom: duration > 0 ? 8 : 0
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 800 }}>Timeline</span>
          {duration > 0 ? (
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
              <span ref={timeLabelRef} style={{ marginLeft: "auto", color: t.mutedText }}>
                0.0s
              </span>
              <span style={{ color: t.subtleText }}>/ {duration.toFixed(0)}s</span>
              <span style={{ fontSize: 11, color: driving ? t.live : t.idle }}>
                {driving ? "● PiP" : "○ PiP"}
              </span>
            </>
          ) : (
            <span style={{ marginLeft: "auto", fontSize: 11, color: t.mutedText }}>
              Add a shot or a dolly move to build the show
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
            // Only shot clips obey Cinemachine's no-containment rule; dolly runs move freely.
            action.id.startsWith("move-") ? undefined : wouldFullyContain(action.id, start, end) ? false : undefined
          }
          onActionResizing={({ action, start, end }) =>
            action.id.startsWith("move-") ? undefined : wouldFullyContain(action.id, start, end) ? false : undefined
          }
          onClickRow={(_event, { time }) => onSeek(time)}
          onDoubleClickRow={(_event, { row, time }) => {
            if (row.id === "shot-track") onCreateShot("cart", time);
            else if (row.id.startsWith("dolly-")) onCreateDollyRun(row.id.slice(6), time);
          }}
          onContextMenuRow={(event, { row, time }) => {
            event.preventDefault();
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              time,
              onShotTrack: row.id === "shot-track",
              ...(row.id.startsWith("dolly-") && { dollyId: row.id.slice(6) })
            });
          }}
          onContextMenuAction={(event, { row, time }) => {
            event.preventDefault();
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              time,
              onShotTrack: row.id === "shot-track",
              ...(row.id.startsWith("dolly-") && { dollyId: row.id.slice(6) })
            });
          }}
          onChange={(rows) => {
            for (const row of rows) {
              const cartId = row.id.startsWith("dolly-") ? row.id.slice(6) : null;
              for (const action of row.actions) {
                const start = Math.max(0, Math.round(action.start / SNAP_SECONDS) * SNAP_SECONDS);
                const end = Math.max(start + SNAP_SECONDS, Math.round(action.end / SNAP_SECONDS) * SNAP_SECONDS);
                if (cartId && action.id.startsWith("move-")) {
                  const move = dollyMoves.find((m) => `move-${m.shotId}` === action.id);
                  if (move && (Math.abs(start - move.start) > 1e-6 || Math.abs(end - move.end) > 1e-6)) {
                    onDollyRunTiming(cartId, action.id.slice(5), start, end);
                  }
                  continue;
                }
                const shot = shots.find((item) => item.id === action.id);
                if (shot && (Math.abs(start - shot.start) > 1e-6 || Math.abs(end - shot.end) > 1e-6)) {
                  onShotTiming(action.id, start, end);
                }
              }
            }
          }}
          onClickAction={(_event, { action }) => {
            // Dolly runs (move-*) aren't shots; clicking one just seeks (via the row).
            if (!action.id.startsWith("move-")) onSelectShot(action.id);
          }}
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
                    color: t.moveText,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    borderRadius: 4,
                    background: ownerSelected ? t.moveSelectedFill : t.moveFill,
                    border: `1px dashed ${ownerSelected ? t.moveSelectedBorder : t.moveBorder}`
                  }}
                >
                  {moveLabels.get(action.id) ?? "move"}
                </div>
              );
            }
            const selected = action.id === selectedShotId;
            const blendIn = blendInFractions.get(action.id) ?? 0;
            const base = selected ? t.shotSelectedFill : t.shotFill;
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
                    ? `1px solid ${t.shotSelectedBorder}`
                    : `1px solid ${t.shotBorder}`
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
              ref={contextMenuRef}
              style={{
                position: "fixed",
                left: contextMenu.x,
                top: contextMenu.y,
                display: "grid",
                minWidth: 200,
                padding: 4,
                borderRadius: 6,
                background: t.contextMenuBackground,
                border: `1px solid ${t.panelBorder}`,
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
                      background: t.panelBorder
                    }}
                  />
                </>
              ) : null}
              {contextMenu.dollyId ? (
                <>
                  <button
                    style={{ textAlign: "left" }}
                    onClick={() => {
                      if (contextMenu.dollyId) onCreateDollyRun(contextMenu.dollyId, contextMenu.time);
                      setContextMenu(null);
                    }}
                  >
                    Add dolly move here
                  </button>
                  <div style={{ height: 1, margin: "4px 0", background: t.panelBorder }} />
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
