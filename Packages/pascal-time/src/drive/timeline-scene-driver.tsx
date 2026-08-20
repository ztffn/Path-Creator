// The one component a host mounts inside its R3F scene to make the transport real: it reads
// the shared transport every frame, advances the clock, and drives nodes and camera from the
// timeline in the scene document. In Pascal's editor it goes in `EditorProps.viewerSceneSlot`,
// which is how it shares the viewer's frame loop instead of racing it (§5.3), and it finds the
// mounted CameraControls through R3F's default-controls slot, so R9 holds with zero wiring.
// Runtime-safe: imports core and fiber, never @pascal-app/editor.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Euler, type Camera } from "three";
import { sceneRegistry, useScene } from "@pascal-app/core";
import { PATH_KIND } from "../plugin/kinds";
import type { Timeline, VirtualCameraDefinition } from "@huma/path-creator/core";
import { pascalTimeTransport } from "../transport/store";
import {
  emptyRig,
  readRig,
  readShotDefinitions,
  readStoredTimeline,
  readTimeline,
  type PascalRig
} from "../plugin/timeline-io";
import { pascalSceneBinding } from "../bind/scene-binding";
import { PascalNodeDriver } from "./node-driver";
import {
  PascalCameraDirector,
  pascalTargetContext,
  type CameraControlsLike,
  type CameraFrame
} from "./camera-director";

/** The evaluation inputs, rebuilt only when the document (or the subject) changes. */
interface EvaluationCache {
  timelineId: string;
  /** Identity of Pascal's nodes map when this was built. The store is immutable, so a changed
   *  map — any edit, undo or redo — is exactly the signal that a rebuild is due. */
  nodes: unknown;
  timeline: Timeline | null;
  vcams: Map<string, VirtualCameraDefinition>;
  /** The rails. Rebuilt on a document change AND on a rail transform — see `railSignature`. */
  rig: PascalRig;
  /** The rail world matrices this rig was baked from. */
  rails: string;
  durationSeconds: number;
  loop: boolean;
}

const looksLikeCameraControls = (candidate: unknown): candidate is CameraControlsLike =>
  typeof candidate === "object" &&
  candidate !== null &&
  typeof (candidate as CameraControlsLike).setLookAt === "function" &&
  typeof (candidate as CameraControlsLike).update === "function";

/** What "add shot from the current view" captures, in the shot node's own field shapes. */
export interface ViewportCameraPose {
  position: [number, number, number];
  /** Euler degrees, XYZ order — exactly what `ShotNode.rotationDeg` stores. */
  rotationDeg: [number, number, number];
  fov: number;
}

// The panel lives in the DOM and cannot reach into the R3F scene; the driver can. It refreshes
// this snapshot every frame (plain assignments, no re-renders), and the panel reads it at the
// moment the author presses "add shot from view".
let viewportCamera: ViewportCameraPose | null = null;
const RAD_TO_DEG = 180 / Math.PI;
const _captureEuler = new Euler();

/**
 * A camera's pose in the shot node's field shapes. The euler is derived from the QUATERNION in
 * explicit XYZ order rather than read off `camera.rotation` — a camera controller is free to
 * set a different rotation order, and components captured in one order and replayed in another
 * would frame a different view with no error anywhere.
 */
export function captureViewportPose(camera: Camera): ViewportCameraPose {
  _captureEuler.setFromQuaternion(camera.quaternion, "XYZ");
  return {
    position: [camera.position.x, camera.position.y, camera.position.z],
    rotationDeg: [
      _captureEuler.x * RAD_TO_DEG,
      _captureEuler.y * RAD_TO_DEG,
      _captureEuler.z * RAD_TO_DEG
    ],
    fov: (camera as { fov?: number }).fov ?? 50
  };
}

/** The viewport camera's pose as of the last driven frame, or null before the first frame. */
export function getViewportCameraPose(): ViewportCameraPose | null {
  return viewportCamera;
}

// What the director applied on the last driven frame. Same reason as the pose above: the panel
// is in the DOM and cannot reach into R3F, and the PiP overlay's chrome wants to name the shot
// that is actually in force rather than the one it guesses from the clock.
let lastCameraFrame: CameraFrame | null = null;

/** The camera frame the director last applied, or null when no shot was in force. */
export function getLastCameraFrame(): CameraFrame | null {
  return lastCameraFrame;
}

/**
 * A path node's world matrix, from the live object the registry hands back.
 *
 * This is how a path node's LOCAL points become the world-space path the library evaluates: the
 * reader folds this matrix in. Reading the live object rather than the node's stored position is
 * what makes a rail under a moved parent (a level, a building) come out in the right place —
 * `position` alone would ignore every transform above it.
 */
function pathWorldMatrix(id: string): { elements: ArrayLike<number> } | null {
  const object = sceneRegistry.nodes.get(id as never) as
    | { matrixWorld: { elements: ArrayLike<number> } }
    | undefined;
  return object ? { elements: object.matrixWorld.elements } : null;
}

/**
 * A signature of every rail's live world transform, so the rig re-bakes when one moves.
 *
 * Cheap enough per frame: a handful of rails times the four matrix elements that a translation,
 * rotation or scale must change. Sampling the whole matrix would be no more correct and this stays
 * a string comparison. What it must NOT do is rebuild the rig unconditionally — sampling a bezier
 * into a vertex path walks the curve, and doing that every frame for every rail is the cost this
 * signature exists to avoid.
 */
function railSignature(): string {
  const nodes = useScene.getState().nodes as Record<string, { type?: string }>;
  let signature = "";
  for (const id of Object.keys(nodes)) {
    if (nodes[id]?.type !== PATH_KIND) continue;
    const matrix = pathWorldMatrix(id);
    if (!matrix) continue;
    const e = matrix.elements;
    signature += `${id}:${e[12]},${e[13]},${e[14]},${e[0]},${e[5]},${e[10]},${e[1]},${e[4]}|`;
  }
  return signature;
}

// Cart frames from the last driven frame, for the rail gizmos. Same reason as the pose above:
// the DOM and the renderers cannot reach into the director, and a cart's world position is
// DERIVED from t rather than stored, so there must be exactly one place it is computed.
let lastCartFrames: ReadonlyMap<string, CartFrameLike> = new Map();

/** Minimal shape of a cart frame, so a renderer can read one without importing the evaluator. */
export type CartFrameLike = {
  position: { x: number; y: number; z: number };
  forward: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  right: { x: number; y: number; z: number };
  distance: number;
  time: number;
};

/** Every cart's frame as of the last driven frame, keyed by cart node id. */
export function getCartFrames(): ReadonlyMap<string, CartFrameLike> {
  return lastCartFrames;
}

export function PascalTimeSceneDriver(): null {
  const driver = useMemo(() => new PascalNodeDriver(pascalSceneBinding()), []);
  const director = useMemo(() => new PascalCameraDirector(), []);
  const targets = useMemo(() => pascalTargetContext(sceneRegistry), []);
  const cache = useRef<EvaluationCache | null>(null);
  const wasDriving = useRef(false);

  // Unmounting while driving must not strand the scene mid-pose (R5).
  useEffect(
    () => () => {
      if (wasDriving.current) driver.release();
      wasDriving.current = false;
    },
    [driver]
  );

  useFrame((state, delta) => {
    viewportCamera = captureViewportPose(state.camera);

    const transport = pascalTimeTransport.getState();
    const timelineId = transport.timelineId;

    const releaseIfHolding = (): void => {
      if (!wasDriving.current) return;
      driver.release();
      wasDriving.current = false;
      lastCameraFrame = null;
      lastCartFrames = new Map();
    };

    if (!timelineId) {
      releaseIfHolding();
      return;
    }

    const nodes = useScene.getState().nodes;
    if (
      !cache.current ||
      cache.current.timelineId !== timelineId ||
      cache.current.nodes !== nodes
    ) {
      const stored = readStoredTimeline(timelineId);
      cache.current = {
        timelineId,
        nodes,
        timeline: stored ? readTimeline(timelineId) : null,
        vcams: readShotDefinitions(timelineId),
        rig: stored ? readRig(pathWorldMatrix) : emptyRig(),
        rails: railSignature(),
        durationSeconds: stored?.durationSeconds ?? 0,
        loop: stored?.loop ?? false
      };
    }

    // A rail's world matrix is NOT a document change, and it lags one behind it. Moving a path
    // node replaces the nodes map, but the live object's matrixWorld is only recomposed during the
    // render that follows — so a rig baked on the document-change frame captures the OLD transform
    // and, because the cache key was satisfied, never re-bakes. Measured: moving a rail left the
    // cart exactly where it was, permanently. So the transforms get their own signal.
    const rails = railSignature();
    if (cache.current.rails !== rails) {
      cache.current = { ...cache.current, rig: readRig(pathWorldMatrix), rails };
    }

    const { timeline, vcams, rig, durationSeconds, loop } = cache.current;
    if (!timeline) {
      releaseIfHolding();
      return;
    }

    if (transport.playing) transport.advance(delta, durationSeconds, loop);
    // Re-read: advance() may have moved the clock or stopped playback at the end this frame.
    const clock = pascalTimeTransport.getState();

    if (!clock.driving) {
      releaseIfHolding();
      return;
    }
    wasDriving.current = true;

    driver.sync(timeline, { time: clock.time, playing: clock.playing, driving: true });

    // The camera has exactly one owner per frame (R9) — and while the AUTHOR is that owner, the
    // director writes nothing. It still EVALUATES, because the rails keep moving and their
    // gizmos read the resolved cart frames; skipping the call entirely would freeze every cart
    // the moment an author started framing a shot, which is the camera rule leaking into object
    // driving. A transport action (play, seek, preview-on) reclaims the camera.
    const mounted = state.controls;
    lastCameraFrame = director.sync(state.camera, {
      timeline,
      vcams,
      time: clock.time,
      controls: looksLikeCameraControls(mounted) ? mounted : null,
      getTargetPosition: targets.getTargetPosition,
      rig,
      cameraFollow: clock.cameraFollow,
      // The composer damps from the previous frame, so it needs both of these. Everything else
      // in the director is a pure function of `time`.
      deltaSeconds: delta,
      playing: clock.playing
    });
    lastCartFrames = director.frames() as ReadonlyMap<string, CartFrameLike>;
  });

  return null;
}
