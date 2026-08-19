// The lane dock: path-creator's real TimelineLanes editor, docked over the viewport bottom
// while the timeline panel is open — the NLE-style surface the sidebar cannot be. Shots are a
// draggable shot lane (dragging the cut between two shots retimes BOTH in one undo entry),
// cues are a pinned lane of markers, every transform track is a lane whose block carries the
// motion sparkline and keyframe markers and retimes the whole track on drag/resize, and
// activation tracks are clip lanes. All writes stay one store operation per gesture. The lanes
// drive a TimelinePlayer; here that is a getter/setter facade over pascalTimeTransport.
"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useViewer } from "@pascal-app/editor";
import {
  TimelineLanes,
  type BlockSeriesData,
  type ExtraLane,
  type TimelineLanesTheme
} from "@huma/path-creator/timeline-ui";
import type { TimelinePlayer } from "@huma/path-creator/timeline";
import { transformComponentAt, type TransformKeyLike } from "@huma/path-creator/core";
import { getViewportCameraPose } from "../drive/timeline-scene-driver";
import { captureTransformKey, withActivationClip } from "../plugin/keying";
import { retimeTransformTrack, transformTrackSpan } from "../plugin/retiming";
import {
  buildCueNode,
  buildShotNode,
  createPluginNode,
  updatePluginNode,
  updatePluginNodes
} from "../plugin/scene-ops";
import {
  putTrack,
  readStoredTimeline,
  writeTracks,
  type StoredTimeline
} from "../plugin/timeline-io";
import type { PersistedTrack } from "../plugin/tracks";
import { pascalTimeTransport } from "../transport/store";
import { useNodeLabel } from "./panel-shared";
import type { CueRow } from "./cues-section";
import type { ShotRow } from "./shots-section";

type TransformTrack = Extract<PersistedTrack, { type: "transform" }>;
type ActivationTrack = Extract<PersistedTrack, { type: "activation" }>;

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
  accentSoft: "rgba(249, 115, 22, 0.22)"
};
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
  selectedTrackId,
  onSelectTrack
}: {
  stored: StoredTimeline;
  cues: CueRow[];
  shots: ShotRow[];
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

  const transformTracks = stored.tracks.filter(
    (track): track is TransformTrack => track.type === "transform"
  );
  const activationTracks = stored.tracks.filter(
    (track): track is ActivationTrack => track.type === "activation"
  );

  // Shot blocks: a shot holds from its own time to the next shot's (or the end). Dragging the
  // seam between two shots therefore retimes both — batched below into one undo entry.
  const orderedShots = [...shots].sort((a, b) => a.timeSeconds - b.timeSeconds);
  const laneShots = orderedShots.map((shot, index) => ({
    id: shot.id,
    name: shot.name,
    start: shot.timeSeconds,
    end: orderedShots[index + 1]?.timeSeconds ?? Math.max(stored.durationSeconds, shot.timeSeconds)
  }));

  const extraLanes: ExtraLane[] = [
    {
      id: CUES_LANE,
      name: "Cues",
      color: CUE_COLOR,
      icon: "◆",
      pinned: true,
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
        clips: span
          ? [
              {
                id: track.id,
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
      clips: track.clips.map((clip) => ({
        id: clip.id,
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
        body: "static",
        position: pose.position,
        rotationDeg: pose.rotationDeg,
        fov: pose.fov
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
        dollies={[]}
        dollyMoves={[]}
        extraLanes={extraLanes}
        selectedShotId={null}
        selectedLaneId={selectedTrackId ? TRACK_LANE(selectedTrackId) : null}
        playerRef={playerRef}
        duration={stored.durationSeconds}
        driving={pascalTimeTransport.getState().driving}
        // ~10 major ticks across the show, so a 10-second timeline fills the dock instead of
        // rendering as a sliver on the library's 5s-per-tick default.
        scaleSeconds={Math.max(0.5, Math.ceil(stored.durationSeconds / 10 / 0.5) * 0.5)}
        shotIcon="▲"
        onShotTiming={(shotId, start, end) => {
          // One gesture, one undo entry — even when the drag retimes the NEXT shot's cut too.
          const index = orderedShots.findIndex((shot) => shot.id === shotId);
          const current = orderedShots[index];
          const next = orderedShots[index + 1];
          if (!current) return;
          const updates: { id: string; data: Record<string, unknown> }[] = [];
          if (Math.abs(start - current.timeSeconds) > 1e-6) {
            updates.push({ id: shotId, data: { timeSeconds: start } });
          }
          if (next && Math.abs(end - next.timeSeconds) > 1e-6) {
            updates.push({ id: next.id, data: { timeSeconds: end } });
          }
          updatePluginNodes(updates);
        }}
        onSelectShot={(shotId) => {
          setSelection({ selectedIds: [shotId] });
          onSelectTrack(null);
        }}
        onSeek={(time) => pascalTimeTransport.getState().seek(time)}
        onTransport={() => undefined}
        onCreateShot={(_kind, time) => createShotFromView(time)}
        onCreateDolly={() => undefined}
        onCreatePath={() => undefined}
        onDollyRunTiming={() => undefined}
        onCreateDollyRun={() => undefined}
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
