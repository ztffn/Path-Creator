// The instrument. Mounts INSIDE Pascal's viewer so it shares that frame loop rather than
// racing it from a separate animation callback, drives the timeline every frame, and records
// what actually happened to Pascal's document while it did. Everything it learns lands on
// `window.__pascalTime` for a headless run to read — the verification standard here is a
// measured number, not an assertion. Scope: harness instrumentation.
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { nodeRegistry, sceneRegistry, useScene } from "@pascal-app/core";
import { useViewer } from "@pascal-app/viewer";
import {
  PascalCameraDirector,
  PascalNodeDriver,
  pascalSceneBinding,
  pascalTargetContext,
  readCues,
  readShots,
  readStoredTimeline,
  readTimeline,
  resolveShotAt,
  TIMELINE_KIND,
  type CameraControlsLike
} from "@huma/pascal-time";
import {
  createCueTransport, createTimelinePlayer, rideToCue, stepCueTransport
} from "@huma/path-creator/timeline";
import {
  AUTHORED_POSITIONS,
  DRIVEN_ID,
  DURATION_SECONDS,
  HIDDEN_ID,
  PEAK_Y,
  STILL_ID,
  TIMELINE_NODE_ID
} from "./scene";
import { MARKER_KIND } from "./kinds";

export interface HarnessReport {
  /** Set once the probe has run at least one frame. */
  ready: boolean;
  phase: "driving" | "released" | "cued" | "camera" | "selected" | "deleted" | "undone" | "done";

  // --- M1.1: the kind exists and renders through Pascal's own dispatch.
  kindRegistered: boolean;
  registeredKindCount: number;
  timelineNodeInDocument: boolean;
  /** Present only because a renderer mounted and called useRegistry. This IS "it renders". */
  timelineNodeInSceneRegistry: boolean;
  markersInSceneRegistry: number;
  sceneRegistrySize: number;
  /** Nodes in the scene document. Larger than the registry: non-spatial kinds mount nothing. */
  nodesInDocument: number;

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

  // --- M1.5: cues authored as Pascal nodes, navigated by the timeline.
  /** Cues read back out of the scene document — authored, not hard-coded here. */
  cuesInDocument: number;
  /** Where the ride finished. Must be the cue's time exactly, not near it. */
  cueLandedTime: number | null;
  /** Where the driven marker was when it landed. The ride moves t; everything else follows. */
  cueLandedDrivenY: number | null;
  /** Frames the ride took, so "it landed" cannot be a single-frame snap that skipped the ease. */
  cueRideFrames: number | null;

  // --- M1.6: the timeline came out of the scene document, versioned.
  timelineReadFromDocument: boolean;
  tracksInDocument: number;
  trackPayloadVersion: number | null;

  // --- M1.4: shots drive the viewport camera, with a real controller mounted.
  shotsInDocument: number;
  /** Frames the camera did NOT hold the pose the shot resolved to. R9's whole point. */
  cameraContestedFrames: number;
  cameraWorstErrorMetres: number;
  cameraFramesChecked: number;
  /** Shots actually seen while sweeping the clock — a blend that never ran proves nothing. */
  shotsSeen: number;
  /** The orbit shot frames a node by id; this is the distance it actually held from it. */
  orbitRadiusHeld: number | null;

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

/** Seconds to sweep the clock across the shot list, long enough to cross the blend. */
const CAMERA_SWEEP_SECONDS = 9;

/** A camera holding its shot should be exact; this only absorbs float noise. */
const CAMERA_EPSILON = 1e-3;

declare global {
  interface Window {
    __pascalTime?: HarnessReport;
  }
}

export function Probe({ controls }: { controls: { current: CameraControlsLike | null } }) {
  const camera = useThree((state) => state.camera);
  const cameraDirector = useMemo(() => new PascalCameraDirector(), []);
  const cameraClock = useRef(0);
  const seenShots = useRef(new Set<string>());
  // Read out of the scene document, not built here. If persistence is broken this is null and
  // every driving check below fails loudly rather than passing against a hard-coded fixture.
  const timeline = useMemo(() => readTimeline(TIMELINE_NODE_ID), []);
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
    nodesInDocument: 0,
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
    timelineReadFromDocument: false,
    tracksInDocument: 0,
    trackPayloadVersion: null,
    shotsInDocument: 0,
    cameraContestedFrames: 0,
    cameraWorstErrorMetres: 0,
    cameraFramesChecked: 0,
    shotsSeen: 0,
    orbitRadiusHeld: null,
    cuesInDocument: 0,
    cueLandedTime: null,
    cueLandedDrivenY: null,
    cueRideFrames: null,
    selectionRoundTripped: null,
    selectedObjectsResolved: null,
    deletedLeftRegistry: null,
    undoRestoredToRegistry: null
  });

  /** Frames to wait after a store change so React can commit and renderers can (un)mount. */
  const settleFrames = useRef(0);

  /** The cue ride's own clock and transport, held across frames like the driver. */
  const cuePlayer = useRef(createTimelinePlayer());
  const cueTransport = useRef(createCueTransport());

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
    if (!timeline) return; // persistence failed; leave the report unfinished rather than lie

    if (!started.current) {
      started.current = true;
      state.undoDepthAtStart = useScene.temporal.getState().pastStates.length;
      state.dirtyCountAtStart = useScene.getState().dirtyNodes.size;
      const stored = readStoredTimeline(TIMELINE_NODE_ID);
      state.timelineReadFromDocument = stored !== null;
      state.tracksInDocument = stored?.tracks.length ?? 0;
      state.trackPayloadVersion = stored ? stored.storedVersion : null;
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
      // Ride to a named cue the AUTHOR placed in the scene document — read back out of Pascal,
      // not declared here. The claim being tested is not "the clock reached 4"; it is that the
      // scene looks like that moment, which is checked against the marker's pose below.
      cuePlayer.current.time = 0;
      rideToCue(cueTransport.current, cuePlayer.current, readCues(TIMELINE_NODE_ID), "cue_peak", {
        seconds: 1.5,
        easing: "easeInOut"
      });
      state.cuesInDocument = readCues(TIMELINE_NODE_ID).length;
      state.cueRideFrames = 0;
      state.phase = "cued";
    } else if (state.phase === "cued") {
      state.cueRideFrames = (state.cueRideFrames ?? 0) + 1;
      const riding = stepCueTransport(cueTransport.current, cuePlayer.current, delta);
      // The ride owns the clock; the driver reads it. No separate transition system exists.
      driver.sync(timeline, {
        time: cuePlayer.current.time,
        playing: false,
        driving: true
      });
      if (!riding) {
        // Read the pose BEFORE releasing: release restores the object, and the whole claim is
        // about where the scene was at the cue.
        state.cueLandedTime = cuePlayer.current.time;
        state.cueLandedDrivenY = sceneRegistry.nodes.get(DRIVEN_ID)?.position.y ?? null;
        driver.release();
        cameraClock.current = 0;
        state.shotsInDocument = readShots(TIMELINE_NODE_ID).length;
        state.phase = "camera";
      }
    } else if (state.phase === "camera") {
      // Sweep the clock across the shot list with a REAL camera-controls mounted. R9 says the
      // controller owns the camera and the time layer feeds it, so the check is whether the
      // camera actually holds the pose the shot resolved to — the spike's contested mode lost
      // 1229 frames of 1230 here, and parked on a different shot entirely.
      cameraClock.current += delta;
      const shots = readShots(TIMELINE_NODE_ID);
      const targetContext = pascalTargetContext(sceneRegistry);
      const resolved = cameraDirector.sync(camera, shots, cameraClock.current, {
        controls: controls.current,
        context: targetContext
      });

      if (resolved) {
        seenShots.current.add(resolved.shot.id);
        state.shotsSeen = seenShots.current.size;
        const wanted = resolved.snapshot.position;
        const error = Math.hypot(
          camera.position.x - wanted.x,
          camera.position.y - wanted.y,
          camera.position.z - wanted.z
        );
        state.cameraFramesChecked += 1;
        if (error > CAMERA_EPSILON) {
          state.cameraContestedFrames += 1;
          state.cameraWorstErrorMetres = Math.max(state.cameraWorstErrorMetres, error);
        }
        // While the orbit shot is live, record how far the camera actually sat from the node
        // it frames. Authored radius is 5; a contested camera settles somewhere else entirely.
        if (resolved.shot.definition.body.type === "orbit" && resolved.alpha >= 1) {
          const subject = sceneRegistry.nodes.get(DRIVEN_ID);
          if (subject) {
            state.orbitRadiusHeld = camera.position.distanceTo(subject.position);
          }
        }
      }

      if (cameraClock.current >= CAMERA_SWEEP_SECONDS) {
        // Selection, through the viewer's own state — the thing Pascal's editor chrome reads.
        // Asserting `isRegistrySelectable` proves the kind declares the capability; this proves
        // the viewer actually accepts the node and resolves it to a live object in the scene.
        useViewer.getState().setSelection({ selectedIds: [TIMELINE_NODE_ID, DRIVEN_ID] });
        state.phase = "selected";
        settleFrames.current = 0;
      }
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
    state.nodesInDocument = Object.keys(useScene.getState().nodes).length;

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
