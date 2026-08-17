// The instrument. Mounts INSIDE Pascal's viewer so it shares that frame loop rather than
// racing it from a separate animation callback, drives the timeline every frame, and records
// what actually happened to Pascal's document while it did. Everything it learns lands on
// `window.__pascalTime` for a headless run to read — the verification standard here is a
// measured number, not an assertion. Scope: harness instrumentation.
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { nodeRegistry, sceneRegistry, useScene } from "@pascal-app/core";
import { useViewer } from "@pascal-app/viewer";
import { PascalNodeDriver, pascalSceneBinding, TIMELINE_KIND } from "@huma/pascal-time";
import {
  AUTHORED_POSITIONS,
  DRIVEN_ID,
  DURATION_SECONDS,
  harnessTimeline,
  HIDDEN_ID,
  STILL_ID,
  TIMELINE_NODE_ID
} from "./scene";
import { MARKER_KIND } from "./kinds";

export interface HarnessReport {
  /** Set once the probe has run at least one frame. */
  ready: boolean;
  phase: "driving" | "released" | "selected" | "deleted" | "undone" | "done";

  // --- M1.1: the kind exists and renders through Pascal's own dispatch.
  kindRegistered: boolean;
  registeredKindCount: number;
  timelineNodeInDocument: boolean;
  /** Present only because a renderer mounted and called useRegistry. This IS "it renders". */
  timelineNodeInSceneRegistry: boolean;
  markersInSceneRegistry: number;
  sceneRegistrySize: number;

  // --- M1.2: driving.
  frames: number;
  elapsedSeconds: number;
  fps: number;
  /** Frames where the pose we wrote last frame was not the pose we found this frame. */
  overwrittenFrames: number;
  worstDriftMetres: number;
  drivenY: number;
  hiddenVisible: boolean;
  /** The marker no track names. Must never move. */
  untouchedMarkerMoved: boolean;

  // --- M1.2: the cost to Pascal's document.
  undoDepthAtStart: number;
  undoDepthNow: number;
  dirtyCountAtStart: number;
  dirtyCountNow: number;

  // --- M1.2: restoration, filled in after release.
  restoredExactly: boolean | null;
  restoredOffsetMetres: number | null;

  // --- M1.1: select and delete, through the viewer rather than only the store.
  /** The viewer's own selection state accepted our plugin kind's node id. */
  selectionRoundTripped: boolean | null;
  /** The viewer resolved those ids to live objects — selection reached the scene, not just a list. */
  selectedObjectsResolved: number | null;
  /** After deleting, the renderer unmounted and took the object out of the registry. */
  deletedLeftRegistry: boolean | null;
  /** After undo, the renderer remounted and put it back. */
  undoRestoredToRegistry: boolean | null;
}

const EPSILON = 1e-4;

/** How long to drive before releasing, in seconds of wall clock. */
const DRIVE_SECONDS = 12;

/** Frames to let React commit a store change and mount or unmount the affected renderer. */
const SETTLE_FRAMES = 10;

declare global {
  interface Window {
    __pascalTime?: HarnessReport;
  }
}

export function Probe() {
  const timeline = useMemo(() => harnessTimeline(), []);
  const driver = useMemo(() => new PascalNodeDriver(pascalSceneBinding()), []);
  const report = useRef<HarnessReport>({
    ready: false,
    phase: "driving",
    kindRegistered: false,
    registeredKindCount: 0,
    timelineNodeInDocument: false,
    timelineNodeInSceneRegistry: false,
    markersInSceneRegistry: 0,
    sceneRegistrySize: 0,
    frames: 0,
    elapsedSeconds: 0,
    fps: 0,
    overwrittenFrames: 0,
    worstDriftMetres: 0,
    drivenY: 0,
    hiddenVisible: false,
    untouchedMarkerMoved: false,
    undoDepthAtStart: 0,
    undoDepthNow: 0,
    dirtyCountAtStart: 0,
    dirtyCountNow: 0,
    restoredExactly: null,
    restoredOffsetMetres: null,
    selectionRoundTripped: null,
    selectedObjectsResolved: null,
    deletedLeftRegistry: null,
    undoRestoredToRegistry: null
  });

  /** Frames to wait after a store change so React can commit and renderers can (un)mount. */
  const settleFrames = useRef(0);

  /** What we wrote last frame, to detect Pascal overwriting it before the next one. */
  const expected = useRef<[number, number, number] | null>(null);
  const started = useRef(false);
  const clock = useRef(0);
  const wall = useRef(0);

  useEffect(() => {
    window.__pascalTime = report.current;
  }, []);

  useFrame((_, delta) => {
    const state = report.current;

    if (!started.current) {
      started.current = true;
      state.undoDepthAtStart = useScene.temporal.getState().pastStates.length;
      state.dirtyCountAtStart = useScene.getState().dirtyNodes.size;
    }

    // --- Did the pose we wrote last frame survive Pascal's render pass?
    const driven = sceneRegistry.nodes.get(DRIVEN_ID);
    if (driven && expected.current) {
      const drift = Math.hypot(
        driven.position.x - expected.current[0],
        driven.position.y - expected.current[1],
        driven.position.z - expected.current[2]
      );
      if (drift > EPSILON) {
        state.overwrittenFrames += 1;
        state.worstDriftMetres = Math.max(state.worstDriftMetres, drift);
      }
    }

    wall.current += delta;
    const releasing = wall.current >= DRIVE_SECONDS;

    if (!releasing) {
      // The clock wraps, so the drive covers the whole timeline repeatedly rather than
      // parking at the end where nothing changes and drift would read as zero for free.
      clock.current = (clock.current + delta) % DURATION_SECONDS;
      driver.sync(timeline, { time: clock.current, playing: true, driving: true });
      const after = sceneRegistry.nodes.get(DRIVEN_ID);
      expected.current = after ? [after.position.x, after.position.y, after.position.z] : null;
      state.phase = "driving";
    } else if (state.phase === "driving") {
      driver.release();
      expected.current = null;
      state.phase = "released";

      // Restoration: the object must be back where the author put it, not merely near it.
      const authored = AUTHORED_POSITIONS[DRIVEN_ID]!;
      const object = sceneRegistry.nodes.get(DRIVEN_ID);
      if (object) {
        const offset = Math.hypot(
          object.position.x - authored[0],
          object.position.y - authored[1],
          object.position.z - authored[2]
        );
        state.restoredOffsetMetres = offset;
        state.restoredExactly = offset < EPSILON;
      }
    } else if (state.phase === "released") {
      // Selection, through the viewer's own state — the thing Pascal's editor chrome reads.
      // Asserting `isRegistrySelectable` proves the kind declares the capability; this proves
      // the viewer actually accepts the node and resolves it to a live object in the scene.
      useViewer.getState().setSelection({ selectedIds: [TIMELINE_NODE_ID, DRIVEN_ID] });
      state.phase = "selected";
      settleFrames.current = 0;
    } else if (state.phase === "selected") {
      settleFrames.current += 1;
      if (settleFrames.current === SETTLE_FRAMES) {
        const selection = useViewer.getState().selection;
        state.selectionRoundTripped =
          selection.selectedIds.includes(TIMELINE_NODE_ID) &&
          selection.selectedIds.includes(DRIVEN_ID);
        state.selectedObjectsResolved = useViewer.getState().outliner.selectedObjects.length;

        // Delete through Pascal's store and let the renderer unmount on its own.
        useViewer.getState().resetSelection();
        useScene.getState().deleteNode(DRIVEN_ID as never);
        state.phase = "deleted";
        settleFrames.current = 0;
      }
    } else if (state.phase === "deleted") {
      settleFrames.current += 1;
      if (settleFrames.current === SETTLE_FRAMES) {
        // Registry absence is the render-level proof: `useRegistry`'s cleanup only runs when
        // the component actually unmounted, so this says the node left the scene, not just
        // the document.
        state.deletedLeftRegistry = !sceneRegistry.nodes.has(DRIVEN_ID);
        useScene.temporal.getState().undo();
        state.phase = "undone";
        settleFrames.current = 0;
      }
    } else if (state.phase === "undone") {
      settleFrames.current += 1;
      if (settleFrames.current === SETTLE_FRAMES) {
        state.undoRestoredToRegistry = sceneRegistry.nodes.has(DRIVEN_ID);
        state.phase = "done";
      }
    }

    // --- Sampling.
    state.frames += 1;
    state.elapsedSeconds = wall.current;
    state.fps = wall.current > 0 ? state.frames / wall.current : 0;

    state.kindRegistered = nodeRegistry.has(TIMELINE_KIND);
    state.registeredKindCount = Array.from(nodeRegistry.entries()).length;
    state.timelineNodeInDocument = Boolean(
      (useScene.getState().nodes as Record<string, unknown>)[TIMELINE_NODE_ID]
    );
    state.timelineNodeInSceneRegistry = sceneRegistry.nodes.has(TIMELINE_NODE_ID);
    state.markersInSceneRegistry = sceneRegistry.byType[MARKER_KIND]?.size ?? 0;
    state.sceneRegistrySize = sceneRegistry.nodes.size;

    state.drivenY = driven?.position.y ?? 0;
    state.hiddenVisible = sceneRegistry.nodes.get(HIDDEN_ID)?.visible ?? false;

    const still = sceneRegistry.nodes.get(STILL_ID);
    const stillAuthored = AUTHORED_POSITIONS[STILL_ID]!;
    state.untouchedMarkerMoved = still
      ? Math.hypot(
          still.position.x - stillAuthored[0],
          still.position.y - stillAuthored[1],
          still.position.z - stillAuthored[2]
        ) > EPSILON
      : false;

    state.undoDepthNow = useScene.temporal.getState().pastStates.length;
    state.dirtyCountNow = useScene.getState().dirtyNodes.size;
    state.ready = true;
  });

  return null;
}
