// The authored fixture: one timeline node from @huma/pascal-time, three markers from this
// harness's own plugin, and the timeline that drives them. Nodes are created as roots —
// `parentId` is optional and nothing in Pascal validates parent kinds, so the architectural
// site/building/level hierarchy is simply unused. Idempotent, because strict mode mounts twice.
// Scope: harness fixture. Ids here are the contract with the timeline below.
import { nodeRegistry, useScene } from "@pascal-app/core";
import { buildCueNode, buildTimelineNode, PASCAL_TIME_PLUGIN_ID } from "@huma/pascal-time";
import { createTimeline, type Timeline } from "@huma/path-creator/core";
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
 * The timeline. A transform track lifts and returns one marker, an activation track reveals
 * another for a window, and the third is named by nothing — so "did the drive touch only what
 * it should" is measurable rather than assumed.
 */
export function harnessTimeline(): Timeline {
  const [x, y, z] = AUTHORED_POSITIONS[DRIVEN_ID]!;
  return createTimeline({
    duration: DURATION_SECONDS,
    tracks: [
      {
        type: "transform",
        id: "lift",
        objectId: DRIVEN_ID,
        position: [
          { time: 0, value: [x, y, z] },
          { time: 4, value: [x, y + 3, z] },
          { time: 8, value: [x, y, z] }
        ]
      },
      {
        type: "activation",
        id: "reveal",
        objectId: HIDDEN_ID,
        clips: [{ id: "window", start: 2, end: 6 }],
        postPlaybackState: "revert"
      }
    ]
  });
}

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
        durationSeconds: DURATION_SECONDS
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
