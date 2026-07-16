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
import { BlockSeries, type BlockSeriesData } from "./block-series";
export { BlockSeries, type BlockSeriesData, type BlockSeriesKind } from "./block-series";
export { EasingEditor, type EasingEditorTheme } from "./easing-editor";
export { KeyframeCurveEditor, type CurveChannel, type CurveChannelKey, type KeyframeCurveEditorTheme } from "./keyframe-curve-editor";

const SHOT_EFFECTS = {
  shot: { id: "shot", name: "Shot" },
  move: { id: "move", name: "Dolly move" },
  extra: { id: "extra", name: "Clip" }
};
const SNAP_SECONDS = 0.25;
// Cap the visible lane area so a tall show doesn't eat the editing viewport;
// beyond this the lane block scrolls vertically. RULER_HEIGHT must match where the
// embedded editor actually starts its first lane row (its time ruler + internal gap),
// so the left icon rail — pinned flex-end to the same total height — lines up row for
// row with the blocks. Measured against @xzdarcy/react-timeline-editor@1.0.0.
const MAX_VISIBLE_LANES = 3;
const RULER_HEIGHT = 42;
const LANE_HEIGHT = 36;

/** A clip block on a generic extra lane (activation, audio, …). */
export interface ExtraLaneClip {
  id: string;
  start: number;
  end: number;
  label?: string;
  /** Optional sparkline(s) drawn behind the label — e.g. a waveform plus a gain line. */
  series?: BlockSeriesData | BlockSeriesData[];
}

/**
 * A host-defined lane rendered alongside the shot/dolly lanes: its own row of
 * clip blocks the host can move/resize/create. Delete is left to the host (e.g.
 * a side-panel editor), mirroring how dolly moves are deleted off-lane.
 */
export interface ExtraLane {
  id: string;
  name: string;
  color: string;
  icon?: ReactNode;
  /** Render overlapping adjacent clips as interlocking crossfade wedges. */
  crossfade?: boolean;
  clips: ExtraLaneClip[];
}

const EXTRA_ID = (laneId: string, clipId: string): string => `x|${laneId}|${clipId}`;
const parseExtraId = (actionId: string): { laneId: string; clipId: string } | null => {
  if (!actionId.startsWith("x|")) return null;
  const sep = actionId.indexOf("|", 2);
  return sep < 0 ? null : { laneId: actionId.slice(2, sep), clipId: actionId.slice(sep + 1) };
};
const EXTRA_ROW = (laneId: string): string => `xrow|${laneId}`;

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
  /** Optional speed/transform sparkline drawn behind the label. */
  series?: BlockSeriesData;
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
  /** Left-rail icons; default to emoji when omitted. */
  shotIcon?: ReactNode;
  dollyIcon?: ReactNode;
  /** Host-defined lanes (activation, audio, …), each with its own clip blocks. */
  extraLanes?: ExtraLane[];
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
  /** An extra-lane clip was dragged/resized, or a lane double-clicked to add one. */
  onExtraClipTiming?: (laneId: string, clipId: string, start: number, end: number) => void;
  onCreateExtraClip?: (laneId: string, timeSeconds: number) => void;
  /** An extra lane was clicked (its rail icon or a clip) — report it for selection. */
  onSelectLane?: (laneId: string) => void;
  /** The currently-selected extra lane, highlighted in the rail (mirrors selectedShotId). */
  selectedLaneId?: string | null;
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
  shotIcon = "🎥",
  dollyIcon = "🛤",
  extraLanes = [],
  onShotTiming,
  onSelectShot,
  onSeek,
  onTransport,
  onCreateShot,
  onCreateDolly,
  onCreatePath,
  onDollyRunTiming,
  onCreateDollyRun,
  onExtraClipTiming,
  onCreateExtraClip,
  onSelectLane,
  selectedLaneId = null
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
    dollyMoves.map((move) => `${move.shotId}:${move.dollyId}:${move.start}:${move.end}`).join("|") +
    extraLanes
      .map((lane) => `${lane.id}:${lane.color}:${lane.clips.map((c) => `${c.id}@${c.start}-${c.end}`).join(",")}`)
      .join("|");
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
      })),
      ...extraLanes.map((lane) => ({
        id: EXTRA_ROW(lane.id),
        actions: lane.clips.map((clip) => ({
          id: EXTRA_ID(lane.id, clip.id),
          start: clip.start,
          end: clip.end,
          effectId: "extra",
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
  const moveSeries = new Map<string, BlockSeriesData>(
    dollyMoves.flatMap((move) => (move.series ? [[`move-${move.shotId}`, move.series] as [string, BlockSeriesData]] : []))
  );
  const extraActionStyle = new Map<string, { color: string; label: string; series?: BlockSeriesData | BlockSeriesData[]; fadeIn?: number; fadeOut?: number }>();
  for (const lane of extraLanes) {
    for (const clip of lane.clips)
      extraActionStyle.set(EXTRA_ID(lane.id, clip.id), {
        color: lane.color,
        label: clip.label ?? "",
        ...(clip.series && { series: clip.series })
      });
    if (lane.crossfade) {
      const ordered = [...lane.clips].sort((a, b) => a.start - b.start);
      for (let i = 1; i < ordered.length; i += 1) {
        const outgoing = ordered[i - 1];
        const incoming = ordered[i];
        if (!outgoing || !incoming) continue;
        const overlap = outgoing.end - incoming.start;
        if (overlap <= 0) continue;
        const outStyle = extraActionStyle.get(EXTRA_ID(lane.id, outgoing.id));
        const inStyle = extraActionStyle.get(EXTRA_ID(lane.id, incoming.id));
        if (outStyle) outStyle.fadeOut = Math.min(1, overlap / Math.max(1e-6, outgoing.end - outgoing.start));
        if (inStyle) inStyle.fadeIn = Math.min(1, overlap / Math.max(1e-6, incoming.end - incoming.start));
      }
    }
  }

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
          borderRadius: 0,
          background: t.panelBackground,
          color: t.text,
          fontFamily: t.fontFamily,
          border: `1px solid ${t.panelBorder}`,
          // Text selection anchors at mousedown; making the whole lane
          // non-selectable means grabbing the scrubber (or dragging a clip)
          // never starts a page-text selection that fights the drag.
          userSelect: "none",
          WebkitUserSelect: "none"
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
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 4,
              maxHeight: RULER_HEIGHT + MAX_VISIBLE_LANES * LANE_HEIGHT,
              overflowY: "auto",
              overflowX: "hidden"
            }}
          >
            <div
              style={{
                width: 22,
                flex: "0 0 auto",
                // Match the editor's full content height so the rail scrolls in
                // lockstep with the rows (the leading gap aligns with the ruler).
                height: RULER_HEIGHT + (1 + dollyLanes.length + extraLanes.length) * LANE_HEIGHT,
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-end",
                fontSize: 14,
                textAlign: "center"
              }}
            >
              <div style={{ height: 36, display: "flex", alignItems: "center", justifyContent: "center" }} title="Shot track">
                {shotIcon}
              </div>
              {dollyLanes.map(([dollyId, lane]) => (
                <div
                  key={dollyId}
                  style={{ height: 36, display: "flex", alignItems: "center", justifyContent: "center" }}
                  title={`${lane.name} moves`}
                >
                  {dollyIcon}
                </div>
              ))}
              {extraLanes.map((lane) => (
                <div
                  key={lane.id}
                  onClick={onSelectLane ? () => onSelectLane(lane.id) : undefined}
                  style={{
                    height: 36,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: onSelectLane ? "pointer" : "default",
                    background: lane.id === selectedLaneId ? "rgba(249, 115, 22, 0.18)" : "transparent",
                    boxShadow: lane.id === selectedLaneId ? "inset 2px 0 0 #f97316" : "none"
                  }}
                  title={lane.name}
                >
                  {lane.icon ?? "▮"}
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
          rowHeight={LANE_HEIGHT}
          autoScroll
          dragLine
          style={{ width: "100%", height: RULER_HEIGHT + (1 + dollyLanes.length + extraLanes.length) * LANE_HEIGHT }}
          onActionMoving={({ action, start, end }) =>
            // Only shot clips obey Cinemachine's no-containment rule; dolly runs + extra clips move freely.
            action.id.startsWith("move-") || action.id.startsWith("x|")
              ? undefined
              : wouldFullyContain(action.id, start, end) ? false : undefined
          }
          onActionResizing={({ action, start, end }) =>
            action.id.startsWith("move-") || action.id.startsWith("x|")
              ? undefined
              : wouldFullyContain(action.id, start, end) ? false : undefined
          }
          onClickRow={(_event, { time }) => onSeek(time)}
          onDoubleClickRow={(_event, { row, time }) => {
            if (row.id === "shot-track") onCreateShot("cart", time);
            else if (row.id.startsWith("dolly-")) onCreateDollyRun(row.id.slice(6), time);
            else if (row.id.startsWith("xrow|")) onCreateExtraClip?.(row.id.slice(5), time);
          }}
          onContextMenuRow={(event, { row, time }) => {
            event.preventDefault();
            if (row.id.startsWith("xrow|")) return; // extra lanes: create by double-click, delete off-lane
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
            if (row.id.startsWith("xrow|")) return;
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
                const extra = parseExtraId(action.id);
                if (extra) {
                  onExtraClipTiming?.(extra.laneId, extra.clipId, start, end);
                  continue;
                }
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
            // Shot clips select their shot; extra-lane clips select their lane; dolly
            // runs just seek (via the row).
            const extra = parseExtraId(action.id);
            if (extra) onSelectLane?.(extra.laneId);
            else if (!action.id.startsWith("move-")) onSelectShot(action.id);
          }}
          onClickTimeArea={(time) => {
            onSeek(time);
            return true;
          }}
          onCursorDrag={onSeek}
          getActionRender={(action) => {
            if (action.effectId === "extra") {
              const style = extraActionStyle.get(action.id);
              const fadeIn = (style?.fadeIn ?? 0) * 100;
              const fadeOut = (style?.fadeOut ?? 0) * 100;
              return (
                <div
                  style={{
                    position: "relative",
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    padding: "0 8px",
                    fontSize: 10,
                    color: "#e2e8f0",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    borderRadius: 4,
                    background: style?.color ?? "rgba(148,163,184,0.4)",
                    clipPath:
                      fadeIn > 0 || fadeOut > 0
                        ? `polygon(0 ${fadeIn > 0 ? "100%" : "0"}, ${fadeIn}% 0, ${100 - fadeOut}% 0, 100% ${fadeOut > 0 ? "100%" : "0"}, 0 100%)`
                        : undefined,
                    border: fadeIn > 0 || fadeOut > 0 ? "1px solid rgba(255,255,255,0.22)" : undefined
                  }}
                >
                  {style?.series
                    ? (Array.isArray(style.series) ? style.series : [style.series]).map((s, i) => (
                        <BlockSeries key={i} data={s} color="rgba(255,255,255,0.32)" />
                      ))
                    : null}
                  <span style={{ position: "relative", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {style?.label ?? ""}
                  </span>
                </div>
              );
            }
            if (action.effectId === "move") {
              const ownerSelected = action.id === `move-${selectedShotId}`;
              const series = moveSeries.get(action.id);
              return (
                <div
                  style={{
                    position: "relative",
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
                  {series ? <BlockSeries data={series} color={ownerSelected ? t.moveSelectedBorder : t.moveBorder} /> : null}
                  <span style={{ position: "relative", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {moveLabels.get(action.id) ?? "move"}
                  </span>
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
