// The r3f entry over the framework-agnostic rig drivers: holds the shared
// RigDriveState in a ref and returns a drive(camera, intent, dt) step the host
// calls inside its own useFrame, dispatching to driveTimeline or driveActivation.
// One shared brain + composer means position and aim continuity survive a
// timeline<->activation switch. Returning a step (not owning useFrame) lets a
// host interleave its own per-frame work (cart parking, overlays) around drive.
import { useCallback, useRef, type MutableRefObject } from "react";
import type { Camera } from "three";
import {
  createRigDriveState,
  driveActivation,
  type RigActivationParams,
  type RigDriveResult,
  type RigDriveState,
  type VirtualCameraSnapshot
} from "../three";
import { driveTimeline, type RigTimelineParams } from "../timeline";

/**
 * What to drive this frame. `idle` holds the last pose (nothing drives the
 * camera); `timeline` plays the show; `activation` follows an explicit shot.
 * The camera is passed to drive(), so intents omit it.
 */
export type RigDriveIntent =
  | { mode: "idle" }
  | ({ mode: "timeline" } & Omit<RigTimelineParams, "camera">)
  | ({ mode: "activation" } & Omit<RigActivationParams, "camera">);

const IDLE_RESULT: RigDriveResult = {
  cameraSnapshot: null,
  activeVcamId: null,
  composerTarget: null,
  blendProgress: 1,
  blendDone: true
};

export function useRigDrive(initial?: VirtualCameraSnapshot): {
  state: MutableRefObject<RigDriveState>;
  drive: (camera: Camera, intent: RigDriveIntent, deltaSeconds: number) => RigDriveResult;
} {
  const state = useRef<RigDriveState>(createRigDriveState(initial));

  const drive = useCallback(
    (camera: Camera, intent: RigDriveIntent, deltaSeconds: number): RigDriveResult => {
      if (intent.mode === "timeline") {
        const { mode, ...params } = intent;
        return driveTimeline(state.current, { camera, ...params }, deltaSeconds);
      }
      if (intent.mode === "activation") {
        const { mode, ...params } = intent;
        return driveActivation(state.current, { camera, ...params }, deltaSeconds);
      }
      // Idle: mirror the activation idle path so re-entry re-activates cleanly.
      state.current.composer.vcamId = null;
      state.current.activation = { key: null, vcamId: null };
      return { ...IDLE_RESULT, cameraSnapshot: state.current.brain.live ?? null };
    },
    []
  );

  return { state, drive };
}
