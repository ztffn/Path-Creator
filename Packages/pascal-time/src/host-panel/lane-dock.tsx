// The lane dock: path-creator's real TimelineLanes editor, docked over the viewport bottom
// while the timeline panel is open — the NLE-style surface the sidebar cannot be. Shots are a
// draggable shot lane where a block OVERLAPPING its predecessor is the crossover between them,
// cues are a pinned lane of markers, every transform track is a lane whose block carries the
// motion sparkline and keyframe markers and retimes the whole track on drag/resize, and
// activation tracks are clip lanes. All writes stay one store operation per gesture. The lanes
// drive a TimelinePlayer; here that is a getter/setter facade over pascalTimeTransport.
"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { createPortal } from "react-dom";
import { useScene } from "@pascal-app/core";
import { useViewer } from "@pascal-app/editor";
import {
  TimelineLanes,
  type BlockSeriesData,
  type ExtraLane,
  type LaneDollyMove,
  type TimelineLanesTheme
} from "@huma/path-creator/timeline-ui";
import type { TimelinePlayer } from "@huma/path-creator/timeline";
import {
  sampleEasingDerivative,
  transformComponentAt,
  type Easing,
  type TransformKeyLike
} from "@huma/path-creator/core";
import { getViewportCameraPose } from "../drive/timeline-scene-driver";
import { captureTransformKey, withActivationClip } from "../plugin/keying";
import {
  cartTrackSpan,
  retimeCartTrack,
  retimeTransformTrack,
  transformTrackSpan
} from "../plugin/retiming";
import {
  buildCartNode,
  buildCueNode,
  buildPathNode,
  buildShotNode,
  createPluginNode,
  updatePluginNode
} from "../plugin/scene-ops";
import {
  putTrack,
  readRig,
  readStoredTimeline,
  writeTracks,
  type ShotBlock,
  type StoredTimeline
} from "../plugin/timeline-io";
import {
  dollyRunEasing,
  newDollyRun,
  starterRailPoints,
  type Point3
} from "../plugin/rails";
import { CART_KIND, PATH_KIND } from "../plugin/kinds";
import type { PersistedTrack } from "../plugin/tracks";
import { pascalTimeTransport } from "../transport/store";
import { useNodeLabel } from "./panel-shared";
import type { CueRow } from "./cues-section";
import type { ShotRow } from "./shots-section";

type TransformTrack = Extract<PersistedTrack, { type: "transform" }>;
type ActivationTrack = Extract<PersistedTrack, { type: "activation" }>;
type CartTrack = Extract<PersistedTrack, { type: "cart" }>;

const CUES_LANE = "cues";
const TRACK_LANE = (trackId: string): string => `track|${trackId}`;
const parseTrackLane = (laneId: string): string | null =>
  laneId.startsWith("track|") ? laneId.slice(6) : null;

/** A cue renders as a thin block; only its START is the cue's time. */
const CUE_BLOCK_SECONDS = 0.25;

// Matches the panel's palette: accent for cues, per-family hues for track lanes.
const THEME: TimelineLanesTheme = {
  panelBackground: "rgba(16, 17, 20, 0.94)",
  panelBorder: "rgba(120, 128, 140, 0.28)",
  text: "#e6e8ee",
  mutedText: "#9aa3b2",
  subtleText: "#6b7280",
  fontFamily: "inherit",
  accent: "rgba(249, 115, 22, 0.9)",
  accentSoft: "rgba(249, 115, 22, 0.22)",
  // State never changes a block's family hue: cameras are blue whether idle, selected or
  // active (selected = brighter blue; active = bright outline). Orange belongs to cues.
  shotFill: "rgba(96, 165, 250, 0.30)",
  shotSelectedFill: "rgba(96, 165, 250, 0.55)",
  shotBorder: "rgba(148, 163, 184, 0.35)",
  shotSelectedBorder: "rgba(148, 163, 184, 0.35)",
  activeBorder: "rgba(255, 255, 255, 0.85)"
};
/**
 * A dolly run's speed profile: the derivative of its easing, max-normalized — so the sparkline
 * shows the accel/decel SHAPE of the ride rather than its distance. Same primitive the demo's
 * dolly lanes use, and the derivative comes from the core sampler the evaluator itself uses, so
 * the graph cannot disagree with the motion.
 */
function dollySpeedSeries(easing: Easing): BlockSeriesData {
  const speed = sampleEasingDerivative(easing, 48).map(Math.abs);
  const max = Math.max(1e-6, ...speed);
  return { kind: "line", points: speed.map((value) => value / max) };
}

const CUE_COLOR = "rgba(249, 115, 22, 0.55)";
const TRANSFORM_COLOR = "rgba(96, 165, 250, 0.38)";
const ACTIVATION_COLOR = "rgba(45, 212, 191, 0.35)";

/**
 * The block's inside: the position-magnitude curve sampled through the SAME evaluator playback
 * uses (so the graph cannot lie about the motion), plus a marker per keyframe.
 */
function transformSeries(track: TransformTrack): BlockSeriesData[] | undefined {
  // The persisted schema is deliberately wider than the evaluator's key type (zod infers
  // plain string for easing presets); the shapes are runtime-identical. Same cast the panel's
  // curve editor makes.
  const keys = (track.position ?? []) as unknown as TransformKeyLike[];
  const span = transformTrackSpan(track);
  if (!span || keys.length < 2 || span.end - span.start < 1e-9) return undefined;
  const range = span.end - span.start;
  const samples: number[] = [];
  for (let i = 0; i <= 32; i += 1) {
    const t = span.start + (range * i) / 32;
    samples.push(
      Math.hypot(
        transformComponentAt(keys, 0, t),
        transformComponentAt(keys, 1, t),
        transformComponentAt(keys, 2, t)
      )
    );
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const line: BlockSeriesData = {
    kind: "line",
    points: samples.map((v) => (max > min ? (v - min) / (max - min) : 0.5))
  };
  const markers: BlockSeriesData = {
    kind: "markers",
    points: keys.map((key) => (key.time - span.start) / range),
    color: "rgba(230, 232, 238, 0.9)"
  };
  return [line, markers];
}

/** The lanes drive a mutable TimelinePlayer; this facade routes it into the transport store. */
function usePlayerFacade(): { current: TimelinePlayer } {
  return useMemo(() => {
    const player: TimelinePlayer = {
      get time() {
        return pascalTimeTransport.getState().time;
      },
      set time(value: number) {
        pascalTimeTransport.getState().seek(value);
      },
      get playing() {
        return pascalTimeTransport.getState().playing;
      },
      set playing(value: boolean) {
        const transport = pascalTimeTransport.getState();
        if (value) transport.play();
        else transport.pause();
      },
      get rate() {
        return pascalTimeTransport.getState().rate;
      },
      set rate(value: number) {
        pascalTimeTransport.getState().setRate(value);
      },
      // The clock's loop lives on the timeline node and the driver reads it from the document;
      // the lanes never toggle it, so the facade pins it false rather than pretending.
      loop: false
    };
    return { current: player };
  }, []);
}

export function LaneDock({
  stored,
  cues,
  shots,
  blocks,
  selectedTrackId,
  onSelectTrack
}: {
  stored: StoredTimeline;
  cues: CueRow[];
  shots: ShotRow[];
  /** The resolved spans. The lane draws these, so an overlap is visible as an overlap. */
  blocks: Map<string, ShotBlock>;
  selectedTrackId: string | null;
  onSelectTrack: (trackId: string | null) => void;
}): ReactNode {
  const label = useNodeLabel();
  const playerRef = usePlayerFacade();
  const [mounted, setMounted] = useState(false);
  // The dock sits to the right of Pascal's sidebar, whose width the author can drag; measure
  // its edge rather than hardcoding it. Interval + resize listener — layout, not a hot path.
  const [leftPx, setLeftPx] = useState(360);
  const setSelection = useViewer((s) => s.setSelection);

  useEffect(() => {
    setMounted(true);
    const measure = (): void => {
      const sidebar = document.querySelector("[data-sidebar]");
      const right = sidebar?.getBoundingClientRect().right;
      setLeftPx(right && right > 0 ? Math.round(right) + 12 : 360);
    };
    measure();
    const interval = window.setInterval(measure, 400);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("resize", measure);
    };
  }, []);

  // What the viewport has selected drives the shot lane's selected styling — the lane and the
  // floating inspector always agree on which shot is "the one being edited".
  const viewportSelectedId = useViewer((s) => s.selection.selectedIds[0] ?? null);
  const selectedShotId = shots.some((shot) => shot.id === viewportSelectedId)
    ? viewportSelectedId
    : null;

  // The blocks in force under the playhead, as a signature string so React re-renders only
  // when an ACTIVE SET boundary is crossed — never per animation frame.
  const activeSignature = useStore(pascalTimeTransport, (state) => {
    if (!state.driving) return "";
    const t = state.time;
    const parts: string[] = [];
    const holder = [...shots]
      .sort((a, b) => a.timeSeconds - b.timeSeconds)
      .filter((shot) => shot.timeSeconds <= t)
      .pop();
    if (holder) parts.push(`s:${holder.id}`);
    for (const track of stored.tracks) {
      if (track.type === "transform") {
        const span = transformTrackSpan(track);
        if (span && t >= span.start && t <= span.end) parts.push(`t:${track.id}`);
      } else if (track.type === "activation") {
        for (const clip of track.clips) {
          if (t >= clip.start && t < clip.end) parts.push(`a:${track.id}:${clip.id}`);
        }
      }
    }
    return parts.join("|");
  });
  const activeIds = useMemo(
    () => new Set(activeSignature.split("|").filter(Boolean)),
    [activeSignature]
  );
  const activeShotId =
    [...activeIds].find((id) => id.startsWith("s:"))?.slice(2) ?? null;

  // The rails, for the dolly lanes. Carts come from the document (they are nodes); their runs
  // come from the persisted payload (they are tracks) — which is why one lane needs both.
  const cartNodes = useScene((state) => state.nodes);
  const carts = useMemo(() => {
    const out: { id: string; name: string; pathId: string }[] = [];
    for (const [id, raw] of Object.entries(cartNodes)) {
      const node = raw as Record<string, unknown>;
      if (node.type !== CART_KIND) continue;
      if (node.timelineId !== stored.id) continue;
      out.push({
        id,
        name: (node.name as string | undefined) ?? id,
        pathId: (node.pathId as string | undefined) ?? ""
      });
    }
    return out;
  }, [cartNodes, stored.id]);

  const cartTracks = stored.tracks.filter(
    (track): track is CartTrack => track.type === "cart"
  );

  const laneDollies = carts.map((cart) => ({ id: cart.id, name: cart.name }));
  const laneDollyMoves: LaneDollyMove[] = cartTracks.flatMap((track) => {
    const span = cartTrackSpan(track);
    const cart = carts.find((entry) => entry.id === track.cartId);
    if (!span || !cart) return [];
    const from = track.keys[0]?.distance ?? 0;
    const to = track.keys[track.keys.length - 1]?.distance ?? from;
    const travels = Math.abs(to - from) > 1e-6;
    return [
      {
        // The lane calls this `shotId` but uses it as the RUN's id — it is what comes back to
        // `onDollyRunTiming` as `runId`, so the track's own id is what belongs here.
        shotId: track.id,
        dollyId: cart.id,
        dollyName: cart.name,
        start: span.start,
        end: span.end,
        label: `${from.toFixed(1)} → ${to.toFixed(1)} m`,
        // A run that does not travel has no speed shape to draw.
        // The persisted schema is deliberately wider on `easing` (zod infers plain string for a
        // preset name); the shapes are runtime-identical. Same cast the curve editors make.
        ...(travels
          ? { series: dollySpeedSeries((dollyRunEasing(track) ?? "linear") as Easing) }
          : {})
      }
    ];
  });

  const transformTracks = stored.tracks.filter(
    (track): track is TransformTrack => track.type === "transform"
  );
  const activationTracks = stored.tracks.filter(
    (track): track is ActivationTrack => track.type === "activation"
  );

  // Shot blocks are the RESOLVED spans, which is what makes the crossover visible: a shot whose
  // block reaches past the next one's start overlaps it, and that overlap IS the blend. Before
  // this the lane drew abutting blocks and a hand-off had no representation at all — the seam
  // looked like a cut whatever the blend said.
  const orderedShots = [...shots].sort((a, b) => a.timeSeconds - b.timeSeconds);
  const laneShots = orderedShots.map((shot) => {
    const block = blocks.get(shot.id);
    const start = block?.start ?? shot.timeSeconds;
    const end = block?.end ?? Math.max(stored.durationSeconds, start);
    const overlap = block?.blendSeconds ?? 0;
    return {
      id: shot.id,
      // The overlap is worth saying in the block, because two adjacent blocks on one lane read as
      // abutting at a glance even when they are drawn crossing.
      name: overlap > 0.01 ? `${shot.name} ↹${overlap.toFixed(1)}s` : shot.name,
      start,
      end
    };
  });

  const extraLanes: ExtraLane[] = [
    {
      id: CUES_LANE,
      name: "Cues",
      color: CUE_COLOR,
      icon: "◆",
      pinned: true,
      createLabel: "Add cue here",
      clips: cues.map((cue) => ({
        id: cue.id,
        start: cue.timeSeconds,
        end: cue.timeSeconds + CUE_BLOCK_SECONDS,
        label: cue.name
      }))
    },
    ...transformTracks.map((track): ExtraLane => {
      const span = transformTrackSpan(track);
      const keyCount = track.position?.length ?? 0;
      const series = transformSeries(track);
      return {
        id: TRACK_LANE(track.id),
        name: label(track.objectId),
        color: TRANSFORM_COLOR,
        icon: "◆",
        createLabel: "Key current pose here",
        clips: span
          ? [
              {
                id: track.id,
                active: activeIds.has(`t:${track.id}`),
                start: span.start,
                // A single-key track still needs a grabbable block.
                end: Math.max(span.end, span.start + CUE_BLOCK_SECONDS),
                label: `${label(track.objectId)} · ${keyCount} key${keyCount === 1 ? "" : "s"}`,
                ...(series ? { series } : {})
              }
            ]
          : []
      };
    }),
    ...activationTracks.map((track): ExtraLane => ({
      id: TRACK_LANE(track.id),
      name: label(track.objectId),
      color: ACTIVATION_COLOR,
      icon: "◎",
      createLabel: "Add visibility clip here",
      clips: track.clips.map((clip) => ({
        id: clip.id,
        active: activeIds.has(`a:${track.id}:${clip.id}`),
        start: clip.start,
        end: clip.end,
        label: `${label(track.objectId)} · visible`
      }))
    }))
  ];

  const handleExtraClipTiming = (laneId: string, clipId: string, start: number, end: number): void => {
    if (laneId === CUES_LANE) {
      // Only the start is meaningful — the block length is presentation.
      updatePluginNode(clipId, { timeSeconds: start });
      return;
    }
    const trackId = parseTrackLane(laneId);
    if (!trackId) return;
    const fresh = readStoredTimeline(stored.id);
    const track = fresh?.tracks.find((entry) => "id" in entry && entry.id === trackId);
    if (!track) return;
    if (track.type === "transform") {
      putTrack(stored.id, retimeTransformTrack(track, start, end));
    } else if (track.type === "activation") {
      putTrack(stored.id, {
        ...track,
        clips: track.clips
          .map((clip) => (clip.id === clipId ? { ...clip, start, end } : clip))
          .sort((a, b) => a.start - b.start)
      });
    }
  };

  const handleCreateExtraClip = (laneId: string, time: number): void => {
    if (laneId === CUES_LANE) {
      createPluginNode(
        buildCueNode({ name: `Cue ${cues.length + 1}`, timeSeconds: Math.max(0, time) }),
        stored.id
      );
      return;
    }
    const trackId = parseTrackLane(laneId);
    if (!trackId) return;
    const fresh = readStoredTimeline(stored.id);
    const track = fresh?.tracks.find((entry) => "id" in entry && entry.id === trackId);
    if (!track) return;
    if (track.type === "transform") {
      // Double-click on a motion lane keys the object's CURRENT pose at that moment.
      captureTransformKey(stored.id, track.objectId, Math.max(0, time));
    } else if (track.type === "activation") {
      writeTracks(
        stored.id,
        withActivationClip(
          fresh!.tracks,
          track.objectId,
          Math.max(0, time),
          Math.min(stored.durationSeconds, Math.max(0, time) + 2)
        )
      );
    }
  };

  const createShotFromView = (time: number): void => {
    const pose = getViewportCameraPose();
    if (!pose) return;
    createPluginNode(
      buildShotNode({
        name: `Shot ${shots.length + 1}`,
        timelineId: stored.id,
        timeSeconds: Math.max(0, time),
        // A block with a real span, so the new shot is draggable at both edges immediately.
        endSeconds: Math.max(0, time) + 4,
        body: "static",
        position: pose.position,
        rotationDeg: pose.rotationDeg,
        fov: pose.fov
      })
    );
  };

  /** A rail laid across the view, so a new one appears where the author is looking. */
  const createRail = (): string | null => {
    const pose = getViewportCameraPose();
    const points: Point3[] = pose
      ? (() => {
          const yaw = (pose.rotationDeg[1] * Math.PI) / 180;
          const forward = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
          return starterRailPoints(
            {
              x: pose.position[0] + forward.x * 6,
              y: Math.max(0, pose.position[1] - 1.5),
              z: pose.position[2] + forward.z * 6
            },
            { x: forward.z, y: 0, z: -forward.x },
            8
          );
        })()
      : starterRailPoints({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 8);
    const node = buildPathNode({ name: "Rail", points });
    createPluginNode(node);
    return node.id as string;
  };

  /** A cart on the newest rail — creating one first if the scene has none. */
  const createCart = (): void => {
    const existing = Object.entries(cartNodes)
      .filter(([, raw]) => (raw as { type?: string }).type === PATH_KIND)
      .map(([id]) => id);
    const pathId = existing[existing.length - 1] ?? createRail();
    if (!pathId) return;
    createPluginNode(
      buildCartNode({ name: `Cart ${carts.length + 1}`, timelineId: stored.id, pathId })
    );
  };

  /** A camera riding the newest cart, taking over at `time`. */
  const createCartShot = (time: number): void => {
    const cart = carts[carts.length - 1];
    if (!cart) return;
    createPluginNode(
      buildShotNode({
        name: `Shot on ${cart.name}`,
        timelineId: stored.id,
        timeSeconds: Math.max(0, time),
        endSeconds: Math.max(0, time) + 4,
        body: "cart",
        cartId: cart.id
      })
    );
  };

  if (!mounted) return null;

  return createPortal(
    <div
      data-huma-lane-dock=""
      style={{
        position: "fixed",
        left: leftPx,
        right: 12,
        bottom: 84, // clear of Pascal's own bottom action toolbar
        zIndex: 30,
        borderRadius: 10,
        overflow: "hidden",
        boxShadow: "0 8px 30px rgba(0,0,0,0.4)"
      }}
    >
      <TimelineLanes
        theme={THEME}
        shots={laneShots}
        dollies={laneDollies}
        dollyMoves={laneDollyMoves}
        extraLanes={extraLanes}
        selectedShotId={selectedShotId}
        activeShotId={activeShotId}
        selectedLaneId={selectedTrackId ? TRACK_LANE(selectedTrackId) : null}
        playerRef={playerRef}
        duration={stored.durationSeconds}
        driving={pascalTimeTransport.getState().driving}
        // ~10 major ticks across the show, so a 10-second timeline fills the dock instead of
        // rendering as a sliver on the library's 5s-per-tick default.
        scaleSeconds={Math.max(0.5, Math.ceil(stored.durationSeconds / 10 / 0.5) * 0.5)}
        // M1.7 gave this host rails, so both entries are live: a cart camera is a real shot body
        // and dolly/path creation is a real gesture here.
        showCartShotEntry={carts.length > 0}
        showDollyEntries
        shotIcon="▲"
        onShotTiming={(shotId, start, end) => {
          // The dragged shot alone, and BOTH its edges. Retiming the neighbour — which is what
          // this did while blocks abutted — is exactly what made an overlap impossible: pushing
          // one block over the next just pushed the next along in front of it. One shot, one
          // updateNode, one undo entry, and the crossover is whatever the spans say it is.
          const current = orderedShots.find((shot) => shot.id === shotId);
          if (!current) return;
          const block = blocks.get(shotId);
          const data: Record<string, unknown> = {};
          if (Math.abs(start - current.timeSeconds) > 1e-6) data.timeSeconds = Math.max(0, start);
          if (Math.abs(end - (block?.end ?? 0)) > 1e-6) data.endSeconds = Math.max(0, end);
          if (Object.keys(data).length > 0) updatePluginNode(shotId, data);
        }}
        onSelectShot={(shotId) => {
          setSelection({ selectedIds: [shotId] });
          onSelectTrack(null);
        }}
        onSeek={(time) => pascalTimeTransport.getState().seek(time)}
        onTransport={() => undefined}
        onCreateShot={(kind, time) => {
          if (kind === "cart") createCartShot(time);
          else createShotFromView(time);
        }}
        onCreateDolly={createCart}
        onCreatePath={createRail}
        onDollyRunTiming={(_cartId, runId, start, end) => {
          const fresh = readStoredTimeline(stored.id);
          const track = fresh?.tracks.find(
            (entry): entry is CartTrack => entry.type === "cart" && entry.id === runId
          );
          if (!track) return;
          putTrack(stored.id, retimeCartTrack(track, start, end));
        }}
        onCreateDollyRun={(cartId, time) => {
          const cart = carts.find((entry) => entry.id === cartId);
          const rail = cart ? readRig().paths.get(cart.pathId) : undefined;
          if (!rail) return;
          putTrack(stored.id, newDollyRun(cartId, rail.length, Math.max(0, time)));
        }}
        onExtraClipTiming={handleExtraClipTiming}
        onCreateExtraClip={handleCreateExtraClip}
        onSelectLane={(laneId) => {
          const trackId = parseTrackLane(laneId);
          if (trackId) onSelectTrack(trackId);
        }}
      />
    </div>,
    document.body
  );
}
