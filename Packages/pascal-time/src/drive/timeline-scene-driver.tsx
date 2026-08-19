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
import type { Timeline, VirtualCameraDefinition } from "@huma/path-creator/core";
import { pascalTimeTransport } from "../transport/store";
import { readShotDefinitions, readStoredTimeline, readTimeline } from "../plugin/timeline-io";
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
        durationSeconds: stored?.durationSeconds ?? 0,
        loop: stored?.loop ?? false
      };
    }
    const { timeline, vcams, durationSeconds, loop } = cache.current;
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

    // The camera has exactly one owner per frame (R9) — and while the AUTHOR is that owner,
    // the director stands down entirely. Without this, framing a new shot is a fight the
    // director wins every frame, and "add shot from view" captures the fight instead of the
    // view. A transport action (play, seek, preview-on) reclaims the camera.
    if (!clock.cameraFollow) {
      lastCameraFrame = null;
      return;
    }

    const mounted = state.controls;
    lastCameraFrame = director.sync(state.camera, {
      timeline,
      vcams,
      time: clock.time,
      controls: looksLikeCameraControls(mounted) ? mounted : null,
      getTargetPosition: targets.getTargetPosition,
      // The composer damps from the previous frame, so it needs both of these. Everything else
      // in the director is a pure function of `time`.
      deltaSeconds: delta,
      playing: clock.playing
    });
  });

  return null;
}
