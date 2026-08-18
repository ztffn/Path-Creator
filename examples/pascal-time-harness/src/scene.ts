// The authored fixture: one timeline node from @huma/pascal-time, three markers from this
// harness's own plugin, and the timeline that drives them. Nodes are created as roots —
// `parentId` is optional and nothing in Pascal validates parent kinds, so the architectural
// site/building/level hierarchy is simply unused. Idempotent, because strict mode mounts twice.
// Scope: harness fixture. Ids here are the contract with the timeline below.
import { nodeRegistry, useScene } from "@pascal-app/core";
import {
  buildCueNode, buildShotNode, buildTimelineNode, PASCAL_TIME_PLUGIN_ID, type PersistedTrack
} from "@huma/pascal-time";
import { HARNESS_PLUGIN_ID, MARKER_KIND } from "./kinds";

export const TIMELINE_NODE_ID = "humatime_clock";
export const DRIVEN_ID = "marker_driven";
export const HIDDEN_ID = "marker_hidden";
export const STILL_ID = "marker_still";

/** Where the author placed each marker. Restoration is measured against exactly these. */
export const AUTHORED_POSITIONS: Record<string, [number, number, number]> = {
  [DRIVEN_ID]: [-2, 0.4, 0],
  [HIDDEN_ID]: [0, 0.4, 0],
  [STILL_ID]: [2, 0.4, 0]
};

export const DURATION_SECONDS = 8;

/**
 * Named moments on that clock, authored as Pascal nodes. `peak` is the interesting one: the
 * transform track has the driven marker at the top of its arc at t=4, so riding to `peak` is a
 * falsifiable claim — the scene must look like that moment, not merely arrive at that number.
 */
export const CUES: Array<{ id: string; name: string; time: number }> = [
  { id: "cue_start", name: "Start", time: 0 },
  { id: "cue_peak", name: "Peak", time: 4 },
  { id: "cue_return", name: "Return", time: DURATION_SECONDS }
];

/** Where the driven marker sits at `cue_peak`, per the track below. The ride must reproduce it. */
export const PEAK_Y = 3.4;

/**
 * Two shots. `wide` is static; `close` orbits the driven marker BY NODE ID, which is the seam
 * paying for itself — the shot frames the subject wherever the subject is, with no timeline
 * edit. `close` blends in over 2 seconds, so a cut and a blend are the same code path with
 * different numbers.
 */
export const SHOTS = [
  {
    id: "shot_wide",
    name: "Wide",
    timeSeconds: 0,
    blendSeconds: 0,
    body: "static" as const,
    position: [0, 4, 14] as [number, number, number],
    rotationDeg: [-8, 0, 0] as [number, number, number],
    fov: 50
  },
  {
    id: "shot_close",
    name: "Close on the driven marker",
    timeSeconds: 4,
    blendSeconds: 2,
    body: "orbit" as const,
    targetNodeId: DRIVEN_ID,
    azimuthDeg: 35,
    elevationDeg: 14,
    radius: 5,
    fov: 38
  }
];

/**
 * The tracks, authored as document data. Before M1.6 this was a `Timeline` built in code at
 * drive time; now it is persisted on the timeline node and the probe reads it back out, which
 * is the only way "the timeline lives in the scene document" is actually demonstrated rather
 * than asserted. A transform track lifts and returns one marker, an activation track reveals
 * another for a window, and the third marker is named by nothing — so "the drive touched only
 * what it should" stays measurable.
 */
export const HARNESS_TRACKS: PersistedTrack[] = [
  {
    type: "transform",
    id: "track_lift",
    objectId: DRIVEN_ID,
    position: [
      { time: 0, value: [-2, 0.4, 0] },
      { time: 4, value: [-2, 3.4, 0] },
      { time: 8, value: [-2, 0.4, 0] }
    ]
  },
  {
    type: "activation",
    id: "track_reveal",
    objectId: HIDDEN_ID,
    clips: [{ id: "window", start: 2, end: 6 }],
    postPlaybackState: "revert"
  }
];

interface SceneStoreLike {
  nodes: Record<string, unknown>;
  createNode: (node: unknown, parentId?: unknown) => void;
}

/** Builds the scene. Both plugins must already be registered — see `main.tsx`. */
export function buildHarnessScene(): void {
  const store = useScene.getState();

  // A namespaced kind is gated per project; without BOTH plugin ids installed, Pascal's
  // renderer refuses the nodes and the scene stays empty with nothing explaining why.
  store.setInstalledPlugins([PASCAL_TIME_PLUGIN_ID, HARNESS_PLUGIN_ID], { explicit: true });

  const scene = store as unknown as SceneStoreLike;
  if (!scene.nodes[TIMELINE_NODE_ID]) {
    scene.createNode(
      buildTimelineNode({
        id: TIMELINE_NODE_ID,
        name: "Harness clock",
        durationSeconds: DURATION_SECONDS,
        tracks: HARNESS_TRACKS
      })
    );
  }

  for (const cue of CUES) {
    if (scene.nodes[cue.id]) continue;
    scene.createNode(
      buildCueNode({
        id: cue.id,
        name: cue.name,
        parentId: TIMELINE_NODE_ID,
        timeSeconds: cue.time
      })
    );
  }

  for (const shot of SHOTS) {
    if (scene.nodes[shot.id]) continue;
    scene.createNode(buildShotNode({ ...shot, timelineId: TIMELINE_NODE_ID }));
  }

  const markerDefaults = nodeRegistry.get(MARKER_KIND)?.defaults();
  if (!markerDefaults) return;

  for (const [id, position] of Object.entries(AUTHORED_POSITIONS)) {
    if (scene.nodes[id]) continue;
    scene.createNode({
      ...markerDefaults,
      id,
      type: MARKER_KIND,
      name: id,
      position,
      color: id === DRIVEN_ID ? "#38bdf8" : id === HIDDEN_ID ? "#f97316" : "#94a3b8"
    });
  }
}
