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
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { seekTimelinePlayer, type TimelinePlayer } from "../timeline";
import { BlockSeries, type BlockSeriesData } from "./block-series";
import { DEFAULT_MAX_VISIBLE_LANES, LANE_HEIGHT, laneLayout } from "./lane-layout";
import {
  extraClipKey,
  selectionForDrag,
  shiftClips,
  snapMoves,
  toggleSelection,
  type ExtraClipMove
} from "./clip-selection";
export {
  extraClipKey,
  parseExtraClipKey,
  rippleClips,
  selectionForDrag,
  shiftClips,
  snapMoves,
  toggleSelection,
  type ExtraClipMove,
  type ExtraClipRef
} from "./clip-selection";
export { DEFAULT_MAX_VISIBLE_LANES, LANE_HEIGHT, RULER_HEIGHT, laneLayout, type LaneCounts, type LaneLayout } from "./lane-layout";
export { BlockSeries, type BlockSeriesData, type BlockSeriesKind } from "./block-series";
export { EasingEditor, type EasingEditorTheme } from "./easing-editor";
export { KeyframeCurveEditor, type CurveChannel, type CurveChannelKey, type CurveKeySelection, type KeyframeCurveEditorTheme } from "./keyframe-curve-editor";

const SHOT_EFFECTS = {
  shot: { id: "shot", name: "Shot" },
  move: { id: "move", name: "Dolly move" },
  extra: { id: "extra", name: "Clip" }
};
/**
 * Default drag/resize quantum. A quarter second suits a camera show; a host timing a
 * sub-second animation passes its own through `snapSeconds`, or the grid cannot express
 * the values it is editing.
 */
const DEFAULT_SNAP_SECONDS = 0.25;
/** Below this the gesture is a click (seek), above it a rubber-band selection. */
const MARQUEE_THRESHOLD_PX = 4;

/** One row of the left rail for a host-defined lane (pinned or below). */
function extraLaneIcon(
  lane: ExtraLane,
  selectedLaneId: string | null,
  onSelectLane?: (laneId: string) => void
): ReactNode {
  return (
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
  );
}

/** A clip block on a generic extra lane (activation, audio, …). */
export interface ExtraLaneClip {
  id: string;
  start: number;
  end: number;
  label?: string;
  /** The clip currently in force under the playhead — rendered with a live outline. */
  active?: boolean;
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
  /** Render this lane ABOVE the shot/dolly lanes instead of below them. */
  pinned?: boolean;
  /** Context-menu label for creating on this lane (default "Add clip here"). */
  createLabel?: string;
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
  /** Outline for the block in force under the playhead. A bright neutral, not a new hue —
   *  the block's family color says what it is; the outline says it is what you are seeing. */
  activeBorder?: string;
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
  activeBorder: "rgba(255, 255, 255, 0.85)",
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
  /** Camera shots. Omit for a host that only uses extra lanes. */
  shots?: LaneShot[];
  /** One lane per dolly (shown even with no runs, so you can add the first one). */
  dollies?: { id: string; name: string }[];
  dollyMoves?: LaneDollyMove[];
  selectedShotId?: string | null;
  playerRef: { current: TimelinePlayer };
  duration: number;
  driving: boolean;
  theme?: TimelineLanesTheme;
  /** Left-rail icons; default to emoji when omitted. */
  shotIcon?: ReactNode;
  dollyIcon?: ReactNode;
  /** Host-defined lanes (activation, audio, …), each with its own clip blocks. */
  extraLanes?: ExtraLane[];
  /**
   * Quantum that drag and resize snap to, and the shortest a clip can be resized to
   * (default 0.25). Sub-second work — element timings on a title animation, say —
   * needs a smaller one; the ruler is unaffected.
   */
  snapSeconds?: number;
  /**
   * Seconds per major ruler tick (default 5). A short show on a wide host reads as a sliver
   * under the default; pass ~duration/10 to fill the width. Snapping is unaffected.
   */
  scaleSeconds?: number;
  /** Show the "Add cart camera here" context entry (default true). Meaningless without rails. */
  showCartShotEntry?: boolean;
  /** Show the "Add dolly" / "Add path" context entries (default true). */
  showDollyEntries?: boolean;
  /**
   * Render the shot track (default true). A host whose show is entirely extra lanes —
   * one per animated element, say — would otherwise carry a permanently empty row.
   */
  showShotLane?: boolean;
  /**
   * Lanes visible before the lane area scrolls (default 3). The cap protects a 3D
   * editing viewport from a tall show; a host that owns the whole panel raises it.
   * Note the embedded editor's time ruler scrolls away with the rows once the cap
   * is exceeded, so prefer sizing this to the lane count over scrolling.
   */
  maxVisibleLanes?: number;
  /** The shot in force under the playhead — its block gets a live outline. */
  activeShotId?: string | null;
  onShotTiming?: (shotId: string, start: number, end: number) => void;
  onSelectShot?: (shotId: string) => void;
  onSeek: (timeSeconds: number) => void;
  onTransport: () => void;
  onCreateShot?: (kind: "capture" | "cart", timeSeconds: number) => void;
  onCreateDolly?: () => void;
  onCreatePath?: () => void;
  /** A dolly run block was dragged/resized (ids are the cart and run). */
  onDollyRunTiming?: (cartId: string, runId: string, start: number, end: number) => void;
  onCreateDollyRun?: (cartId: string, timeSeconds: number) => void;
  /** An extra-lane clip was dragged/resized, or a lane double-clicked to add one. */
  onExtraClipTiming?: (laneId: string, clipId: string, start: number, end: number) => void;
  /** An extra-lane clip was vertically dropped onto another extra lane. */
  onExtraClipLaneChange?: (fromLaneId: string, toLaneId: string, clipId: string, start: number, end: number) => void;
  onCreateExtraClip?: (laneId: string, timeSeconds: number) => void;
  /** An extra lane was clicked (its rail icon or a clip) — report it for selection. */
  onSelectLane?: (laneId: string) => void;
  /** The currently-selected extra lane, highlighted in the rail (mirrors selectedShotId). */
  selectedLaneId?: string | null;
  /**
   * Clips selected for editing, as `extraClipKey(laneId, clipId)`. Dragging any member
   * moves the whole set by one delta, and the arrow keys nudge it. Independent of
   * `selectedLaneId`, which is about which lane the host's side panel is describing.
   */
  selectedClipKeys?: readonly string[];
  /** The selection changed — from a click, a shift-click, or Escape (an empty array). */
  onSelectClips?: (keys: string[]) => void;
  /**
   * One or more extra-lane clips were retimed by a single gesture. Prefer this over
   * `onExtraClipTiming`: a multi-clip drag has to reach the host as ONE write, or the
   * intermediate states are undo steps nobody performed. When provided it receives
   * single-clip moves too, and `onExtraClipTiming` is not called.
   */
  onExtraClipsTiming?: (moves: ExtraClipMove[]) => void;
  /** Nudge step for the arrow keys (default: `snapSeconds`). Shift multiplies by ten. */
  nudgeSeconds?: number;
}

export function TimelineLanes({
  shots = [],
  dollies = [],
  dollyMoves = [],
  selectedShotId = null,
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
  onExtraClipLaneChange,
  onCreateExtraClip,
  onSelectLane,
  selectedLaneId = null,
  selectedClipKeys = [],
  onSelectClips,
  onExtraClipsTiming,
  nudgeSeconds,
  scaleSeconds = 5,
  snapSeconds = DEFAULT_SNAP_SECONDS,
  showCartShotEntry = true,
  showDollyEntries = true,
  showShotLane = true,
  maxVisibleLanes = DEFAULT_MAX_VISIBLE_LANES,
  activeShotId = null
}: TimelineLanesProps) {
  const t: Required<TimelineLanesTheme> = { ...DEFAULT_THEME, ...theme };
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    time: number;
    onShotTrack: boolean;
    dollyId?: string;
    laneId?: string;
  } | null>(null);
  const laneStateRef = useRef<TimelineState>(null);
  const pointerYRef = useRef<number | null>(null);
  const dragStartLaneRef = useRef<string | null>(null);
  // The move gesture in flight: which clip is under the cursor, where it started, and
  // the set the drag acts on. Captured at MoveStart because by the time onChange runs
  // the editor has already reported the new position and the delta is unrecoverable.
  const moveGestureRef = useRef<{ key: string; originalStart: number; keys: string[] } | null>(null);
  // A drag ends in a click on the block that was dragged. Left alone that click reads as
  // "select just this one" and collapses the set the user was moving, so a group can be
  // dragged exactly once. Holds the action id whose next click must not change selection;
  // cleared by the next mousedown, so a swallowed click cannot outlive its gesture.
  const suppressClickSelectRef = useRef<string | null>(null);
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});
  const panelCleanupRef = useRef<(() => void) | null>(null);
  const laneAreaRef = useRef<HTMLDivElement>(null);
  // The rubber band, in coordinates local to the lane area. Null when not banding —
  // a mousedown does not start one until the pointer has travelled far enough to be a
  // drag rather than a click, or every scrub on empty track would clear the selection.
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const timeLabelRef = useRef<HTMLSpanElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const rememberPointer = (event: MouseEvent) => { pointerYRef.current = event.clientY; };
    document.addEventListener("mousemove", rememberPointer);
    return () => document.removeEventListener("mousemove", rememberPointer);
  }, []);

  const extraLaneAtPointer = (): string | null => {
    const target = laneStateRef.current?.target;
    const pointerY = pointerYRef.current;
    if (!target || pointerY === null) return null;
    const area = target.querySelector<HTMLElement>(".timeline-editor-edit-area");
    const grid = area?.querySelector<HTMLElement>(".ReactVirtualized__Grid");
    if (!area || !grid) return null;
    const index = Math.floor((pointerY - area.getBoundingClientRect().top + grid.scrollTop) / LANE_HEIGHT);
    const row = editorData[index];
    return row?.id.startsWith("xrow|") ? row.id.slice(5) : null;
  };

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
  // Pinned extra lanes render above the shot/dolly lanes (e.g. a Scenes lane
  // that structures the whole show); the rest sit below as before.
  const pinnedLanes = extraLanes.filter((lane) => lane.pinned);
  const unpinnedLanes = extraLanes.filter((lane) => !lane.pinned);
  const layout = laneLayout({
    shotLane: showShotLane,
    dollyLanes: dollyLanes.length,
    extraLanes: extraLanes.length,
    maxVisibleLanes
  });
  const editorData = useMemo<TimelineRow[]>(
    () => {
      const extraRow = (lane: ExtraLane): TimelineRow => ({
        id: EXTRA_ROW(lane.id),
        actions: lane.clips.map((clip) => ({
          id: EXTRA_ID(lane.id, clip.id),
          start: clip.start,
          end: clip.end,
          effectId: "extra",
          movable: true,
          flexible: true
        }))
      });
      return [
        ...pinnedLanes.map(extraRow),
        ...(showShotLane
          ? [
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
            ]
          : []),
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
        ...unpinnedLanes.map(extraRow)
      ];
    },
    // timingKey covers everything this memo reads except names, which render
    // via the shots prop directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timingKey]
  );
  const moveLabels = new Map(dollyMoves.map((move) => [`move-${move.shotId}`, move.label]));
  const moveSeries = new Map<string, BlockSeriesData>(
    dollyMoves.flatMap((move) => (move.series ? [[`move-${move.shotId}`, move.series] as [string, BlockSeriesData]] : []))
  );
  const selectedKeys = new Set(selectedClipKeys);
  // Where every extra clip currently sits, so a multi-move can be built from the props
  // rather than from whatever the editor's own row data happens to hold mid-gesture.
  const clipPositions = new Map<string, ExtraClipMove>();
  for (const lane of extraLanes)
    for (const clip of lane.clips)
      clipPositions.set(extraClipKey(lane.id, clip.id), {
        laneId: lane.id,
        clipId: clip.id,
        start: clip.start,
        end: clip.end
      });

  /** Report a retime, as one write, through whichever callback the host supplied. */
  const emitMoves = (moves: ExtraClipMove[]): void => {
    if (moves.length === 0) return;
    if (onExtraClipsTiming) onExtraClipsTiming(moves);
    else for (const move of moves) onExtraClipTiming?.(move.laneId, move.clipId, move.start, move.end);
  };

  /** Shift the whole selection, used by the arrow keys. */
  const nudgeSelection = (deltaSeconds: number): void => {
    const moves = [...selectedKeys]
      .map((key) => clipPositions.get(key))
      .filter((move): move is ExtraClipMove => move !== undefined);
    if (moves.length > 0) emitMoves(snapMoves(shiftClips(moves, deltaSeconds), snapSeconds));
  };

  // Rebuilt every render so it closes over the current selection and clip positions; the
  // listener registered below is stable and calls through this ref.
  keyHandlerRef.current = (event: KeyboardEvent) => {
    if (selectedKeys.size === 0) return;
    if (event.key === "Escape") {
      onSelectClips?.([]);
      return;
    }
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (direction === 0) return;
    // Both, and in this order: the grid would otherwise scroll horizontally as well.
    event.preventDefault();
    event.stopPropagation();
    nudgeSelection(direction * (nudgeSeconds ?? snapSeconds) * (event.shiftKey ? 10 : 1));
  };

  /**
   * A CALLBACK ref, not `useRef` plus an empty-dependency effect. StrictMode's simulated
   * remount detaches refs around the effect re-run, so the effect can find a null node and
   * return having attached nothing — leaving the arrow keys dead until the next reload.
   * Attaching where the node itself arrives cannot race that.
   */
  const attachPanel = useCallback((node: HTMLDivElement | null) => {
    panelCleanupRef.current?.();
    panelCleanupRef.current = null;
    if (!node) return;
    const listener = (event: KeyboardEvent) => keyHandlerRef.current(event);
    // Capture phase: the embedded editor's virtualized grid takes focus and would
    // otherwise consume the arrow keys before they reach an ancestor.
    node.addEventListener("keydown", listener, { capture: true });
    panelCleanupRef.current = () => node.removeEventListener("keydown", listener, { capture: true });
  }, []);

  const extraActionStyle = new Map<string, { color: string; label: string; series?: BlockSeriesData | BlockSeriesData[]; fadeIn?: number; fadeOut?: number; active?: boolean; laneSelected?: boolean; clipSelected?: boolean }>();
  for (const lane of extraLanes) {
    for (const clip of lane.clips)
      extraActionStyle.set(EXTRA_ID(lane.id, clip.id), {
        color: lane.color,
        label: clip.label ?? "",
        active: clip.active === true,
        laneSelected: lane.id === selectedLaneId,
        clipSelected: selectedKeys.has(extraClipKey(lane.id, clip.id)),
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
          WebkitUserSelect: "none",
          outline: "none"
        }}
        // Focusable so the arrow keys can nudge a selection. The panel takes focus on
        // mousedown anyway, so selecting a clip and then nudging it needs no extra click.
        // The listener itself is native and CAPTURE phase (see the effect below), because
        // the embedded editor's virtualized grid takes focus and swallows arrow keys.
        tabIndex={0}
        ref={attachPanel}
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
              maxHeight: layout.maxHeight,
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
                height: layout.contentHeight,
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-end",
                fontSize: 14,
                textAlign: "center"
              }}
            >
              {pinnedLanes.map((lane) => extraLaneIcon(lane, selectedLaneId, onSelectLane))}
              {showShotLane && (
                <div style={{ height: 36, display: "flex", alignItems: "center", justifyContent: "center" }} title="Shot track">
                  {shotIcon}
                </div>
              )}
              {dollyLanes.map(([dollyId, lane]) => (
                <div
                  key={dollyId}
                  style={{ height: 36, display: "flex", alignItems: "center", justifyContent: "center" }}
                  title={`${lane.name} moves`}
                >
                  {dollyIcon}
                </div>
              ))}
              {unpinnedLanes.map((lane) => extraLaneIcon(lane, selectedLaneId, onSelectLane))}
            </div>
            <div
              ref={laneAreaRef}
              style={{ flex: 1, minWidth: 0, borderRadius: 6, overflow: "hidden", position: "relative" }}
              onMouseDown={(event) => {
                suppressClickSelectRef.current = null;
                if (event.button !== 0) return;
                // Never start on a clip (that is a drag) or on the ruler (that is a scrub).
                const target = event.target as HTMLElement;
                if (target.closest("[data-clip-key]") || target.closest(".timeline-editor-time-area")) return;
                const area = laneAreaRef.current;
                if (!area) return;
                const bounds = area.getBoundingClientRect();
                const origin = { x: event.clientX, y: event.clientY };
                const additive = event.shiftKey || event.metaKey || event.ctrlKey;
                let banding = false;

                const move = (moveEvent: MouseEvent) => {
                  if (
                    !banding &&
                    Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) <= MARQUEE_THRESHOLD_PX
                  ) {
                    return;
                  }
                  banding = true;
                  setMarquee({
                    x0: origin.x - bounds.left,
                    y0: origin.y - bounds.top,
                    x1: moveEvent.clientX - bounds.left,
                    y1: moveEvent.clientY - bounds.top
                  });
                };

                const up = (upEvent: MouseEvent) => {
                  window.removeEventListener("mousemove", move);
                  window.removeEventListener("mouseup", up);
                  setMarquee(null);
                  if (!banding) {
                    // A plain click on empty track: seek (the editor's own job) and drop
                    // the selection, which is what every NLE does and what makes the set
                    // clearable without depending on where focus happens to be.
                    if (!additive) onSelectClips?.([]);
                    return;
                  }
                  // Hit-test the RENDERED blocks rather than reprojecting time to pixels:
                  // the editor owns a horizontal scroll of its own, so any arithmetic here
                  // would silently disagree with it the moment the show is scrolled.
                  const box = {
                    left: Math.min(origin.x, upEvent.clientX),
                    right: Math.max(origin.x, upEvent.clientX),
                    top: Math.min(origin.y, upEvent.clientY),
                    bottom: Math.max(origin.y, upEvent.clientY)
                  };
                  const hits: string[] = [];
                  area.querySelectorAll<HTMLElement>("[data-clip-key]").forEach((element) => {
                    const rect = element.getBoundingClientRect();
                    if (
                      rect.right >= box.left &&
                      rect.left <= box.right &&
                      rect.bottom >= box.top &&
                      rect.top <= box.bottom
                    ) {
                      const key = element.dataset.clipKey;
                      if (key) hits.push(key);
                    }
                  });
                  onSelectClips?.(
                    additive ? [...new Set([...selectedClipKeys, ...hits])] : hits
                  );
                  // The band ends in a click the editor would read as a scrub back to
                  // wherever the pointer stopped; swallow exactly that one.
                  area.addEventListener("click", (clickEvent) => clickEvent.stopPropagation(), {
                    capture: true,
                    once: true
                  });
                };

                window.addEventListener("mousemove", move);
                window.addEventListener("mouseup", up);
              }}
            >
              {marquee && (
                <div
                  style={{
                    position: "absolute",
                    pointerEvents: "none",
                    zIndex: 5,
                    left: Math.min(marquee.x0, marquee.x1),
                    top: Math.min(marquee.y0, marquee.y1),
                    width: Math.abs(marquee.x1 - marquee.x0),
                    height: Math.abs(marquee.y1 - marquee.y0),
                    border: `1px solid ${t.accent}`,
                    background: t.accentSoft,
                    borderRadius: 2
                  }}
                />
              )}
              <TimelineLaneEditor
          ref={laneStateRef}
          editorData={editorData}
          effects={SHOT_EFFECTS}
          scale={scaleSeconds}
          scaleWidth={110}
          scaleSplitCount={5}
          startLeft={12}
          rowHeight={LANE_HEIGHT}
          autoScroll
          dragLine
          style={{ width: "100%", height: layout.contentHeight }}
          onActionMoving={({ action, start, end }) =>
            // Only shot clips obey Cinemachine's no-containment rule; dolly runs + extra clips move freely.
            action.id.startsWith("move-") || action.id.startsWith("x|")
              ? undefined
              : wouldFullyContain(action.id, start, end) ? false : undefined
          }
          onActionMoveStart={({ action }) => {
            dragStartLaneRef.current = extraLaneAtPointer();
            const current = clipPositions.get(action.id);
            moveGestureRef.current = current
              ? { key: action.id, originalStart: current.start, keys: selectionForDrag(selectedClipKeys, action.id) }
              : null;
          }}
          onActionMoveEnd={({ action, start, end }) => {
            const extra = parseExtraId(action.id);
            const targetLane = extraLaneAtPointer();
            const startLane = dragStartLaneRef.current;
            dragStartLaneRef.current = null;
            // Compare against the row the pointer STARTED in, not the clip's own lane: a
            // grab near a clip's top edge puts the cursor in the row above, so a purely
            // horizontal drag would otherwise read as a lane change and move the clip.
            if (!extra || !targetLane || targetLane === startLane || targetLane === extra.laneId) return;
            // Snap the start, then carry the original duration across. Re-snapping the end
            // independently would resize any clip whose length is not a whole number of
            // snap steps — an imported audio clip, say — as a side effect of moving it.
            const snappedStart = Math.max(0, Math.round(start / snapSeconds) * snapSeconds);
            onExtraClipLaneChange?.(extra.laneId, targetLane, extra.clipId, snappedStart, snappedStart + Math.max(snapSeconds, end - start));
          }}
          onActionResizeStart={() => { moveGestureRef.current = null; }}
          onActionResizing={({ action, start, end }) =>
            action.id.startsWith("move-") || action.id.startsWith("x|")
              ? undefined
              : wouldFullyContain(action.id, start, end) ? false : undefined
          }
          onClickRow={(_event, { time }) => onSeek(time)}
          onDoubleClickRow={(_event, { row, time }) => {
            if (row.id === "shot-track") onCreateShot?.("cart", time);
            else if (row.id.startsWith("dolly-")) onCreateDollyRun?.(row.id.slice(6), time);
            else if (row.id.startsWith("xrow|")) onCreateExtraClip?.(row.id.slice(5), time);
          }}
          onContextMenuRow={(event, { row, time }) => {
            event.preventDefault();
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              time,
              onShotTrack: row.id === "shot-track",
              ...(row.id.startsWith("dolly-") && { dollyId: row.id.slice(6) }),
              ...(row.id.startsWith("xrow|") && { laneId: row.id.slice(5) })
            });
          }}
          onContextMenuAction={(event, { row, time }) => {
            event.preventDefault();
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              time,
              onShotTrack: row.id === "shot-track",
              ...(row.id.startsWith("dolly-") && { dollyId: row.id.slice(6) }),
              ...(row.id.startsWith("xrow|") && { laneId: row.id.slice(5) })
            });
          }}
          onChange={(rows) => {
            const extraChanges: ExtraClipMove[] = [];
            for (const row of rows) {
              const cartId = row.id.startsWith("dolly-") ? row.id.slice(6) : null;
              for (const action of row.actions) {
                const start = Math.max(0, Math.round(action.start / snapSeconds) * snapSeconds);
                const end = Math.max(start + snapSeconds, Math.round(action.end / snapSeconds) * snapSeconds);
                const extra = parseExtraId(action.id);
                if (extra) {
                  extraChanges.push({ laneId: extra.laneId, clipId: extra.clipId, start, end });
                  continue;
                }
                if (cartId && action.id.startsWith("move-")) {
                  const move = dollyMoves.find((m) => `move-${m.shotId}` === action.id);
                  if (move && (Math.abs(start - move.start) > 1e-6 || Math.abs(end - move.end) > 1e-6)) {
                    onDollyRunTiming?.(cartId, action.id.slice(5), start, end);
                  }
                  continue;
                }
                const shot = shots.find((item) => item.id === action.id);
                if (shot && (Math.abs(start - shot.start) > 1e-6 || Math.abs(end - shot.end) > 1e-6)) {
                  onShotTiming?.(action.id, start, end);
                }
              }
            }
            const gesture = moveGestureRef.current;
            moveGestureRef.current = null;
            if (gesture) suppressClickSelectRef.current = gesture.key;
            // A drag on a member of a multi-selection moves the whole set by ONE delta,
            // taken from the clip actually under the cursor. The other members are shifted
            // from their own current positions rather than from the editor's row data,
            // which only ever reflects the clip being dragged.
            if (gesture && gesture.keys.length > 1) {
              const dragged = extraChanges.find(
                (change) => extraClipKey(change.laneId, change.clipId) === gesture.key
              );
              if (dragged) {
                const moving = gesture.keys
                  .map((key) => clipPositions.get(key))
                  .filter((clip): clip is ExtraClipMove => clip !== undefined);
                emitMoves(snapMoves(shiftClips(moving, dragged.start - gesture.originalStart), snapSeconds));
                return;
              }
            }
            emitMoves(extraChanges);
          }}
          onClickAction={(event, { action }) => {
            // Shot clips select their shot; extra-lane clips select their lane; dolly
            // runs just seek (via the row).
            const extra = parseExtraId(action.id);
            if (extra) {
              onSelectLane?.(extra.laneId);
              if (suppressClickSelectRef.current === action.id) {
                suppressClickSelectRef.current = null;
                return;
              }
              // Shift or meta adds to the set; a plain click replaces it. Both are the
              // platform conventions, and `onClickAction` is the only place the modifier
              // state is available at all.
              onSelectClips?.(
                toggleSelection(selectedClipKeys, action.id, event.shiftKey || event.metaKey || event.ctrlKey)
              );
            } else if (!action.id.startsWith("move-")) onSelectShot?.(action.id);
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
                  data-clip-key={action.id}
                  data-active={style?.active ? "true" : undefined}
                  data-clip-selected={style?.clipSelected ? "true" : undefined}
                  data-selected={style?.clipSelected || style?.laneSelected ? "true" : undefined}
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
                    // One treatment per state, and they stack: the accent ring says "in the
                    // selection", the inner white outline says "in force under the playhead",
                    // brightness says "this lane is what the side panel is describing".
                    boxShadow:
                      [
                        style?.clipSelected ? `inset 0 0 0 2px ${t.accent}` : null,
                        style?.active ? `inset 0 0 0 ${style?.clipSelected ? 4 : 2}px ${t.activeBorder}` : null
                      ]
                        .filter(Boolean)
                        .join(", ") || undefined,
                    filter: style?.laneSelected || style?.clipSelected ? "brightness(1.4)" : undefined,
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
            const isActive = action.id === activeShotId;
            const blendIn = blendInFractions.get(action.id) ?? 0;
            const base = selected ? t.shotSelectedFill : t.shotFill;
            return (
              <div
                data-active={isActive ? "true" : undefined}
                data-selected={selected ? "true" : undefined}
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
                  // Live beats selected: the bright outline says "this is what you are
                  // seeing"; the selected fill/border below say "this is what you are editing".
                  boxShadow: isActive ? `inset 0 0 0 2px ${t.activeBorder}` : undefined,
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
              {/* Camera creation acts at a TIME, not a lane — offered on every row. */}
              <button
                style={{ textAlign: "left" }}
                onClick={() => {
                  onCreateShot?.("capture", contextMenu.time);
                  setContextMenu(null);
                }}
              >
                Add camera here (capture viewport)
              </button>
              {showCartShotEntry ? (
                <button
                  style={{ textAlign: "left" }}
                  onClick={() => {
                    onCreateShot?.("cart", contextMenu.time);
                    setContextMenu(null);
                  }}
                >
                  Add cart camera here
                </button>
              ) : null}
              {contextMenu.laneId && onCreateExtraClip ? (
                <button
                  style={{ textAlign: "left" }}
                  onClick={() => {
                    if (contextMenu.laneId) onCreateExtraClip(contextMenu.laneId, contextMenu.time);
                    setContextMenu(null);
                  }}
                >
                  {extraLanes.find((lane) => lane.id === contextMenu.laneId)?.createLabel ??
                    "Add clip here"}
                </button>
              ) : null}
              {contextMenu.dollyId ? (
                <button
                  style={{ textAlign: "left" }}
                  onClick={() => {
                    if (contextMenu.dollyId) onCreateDollyRun?.(contextMenu.dollyId, contextMenu.time);
                    setContextMenu(null);
                  }}
                >
                  Add dolly move here
                </button>
              ) : null}
              {showDollyEntries ? (
                <>
                  <div style={{ height: 1, margin: "4px 0", background: t.panelBorder }} />
                  <button
                    style={{ textAlign: "left" }}
                    onClick={() => {
                      onCreateDolly?.();
                      setContextMenu(null);
                    }}
                  >
                    Add dolly
                  </button>
                  <button
                    style={{ textAlign: "left" }}
                    onClick={() => {
                      onCreatePath?.();
                      setContextMenu(null);
                    }}
                  >
                    Add path
                  </button>
                </>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </LaneErrorBoundary>
  );
}
