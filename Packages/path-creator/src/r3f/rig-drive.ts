// The r3f wrapper over the framework-agnostic rig drivers: owns one useFrame
// and the shared RigDriveState, dispatching each frame to driveTimeline or
// driveActivation per a reactive intent. Keeps position + aim continuity across
// a timeline<->activation switch (shared brain + composer). Hosts read the
// returned refs to render the driven camera and draw overlays (composer target,
// lookahead velocity in state.composer.aim.smoothedVelocity).
import { useRef, type MutableRefObject } from "react";
import { useFrame } from "@react-three/fiber";
import type { Camera } from "three";
import {
  createRigDriveState,
  driveActivation,
  type RigActivationParams,
  type RigDriveResult,
  type RigDriveState
} from "../three";
import { driveTimeline, type RigTimelineParams } from "../timeline";

/**
 * What to drive this frame. `idle` holds the last pose (nothing drives the
 * camera); `timeline` plays the show; `activation` follows an explicit shot.
 * The camera is injected by the hook, so intents omit it.
 */
export type RigDriveIntent =
  | { mode: "idle" }
  | ({ mode: "timeline" } & Omit<RigTimelineParams, "camera">)
  | ({ mode: "activation" } & Omit<RigActivationParams, "camera">);

export interface UseRigDriveOptions {
  camera: Camera;
  intent: RigDriveIntent;
  /** When false, the frame is skipped entirely (state untouched). */
  enabled?: boolean;
  /** Runs after driving, for overlays/reporting; receives the shared state. */
  onFrame?: (result: RigDriveResult, state: RigDriveState, deltaSeconds: number) => void;
}

const IDLE_RESULT: RigDriveResult = {
  cameraSnapshot: null,
  activeVcamId: null,
  composerTarget: null,
  blendProgress: 1,
  blendDone: true
};

export function useRigDrive(options: UseRigDriveOptions): {
  state: MutableRefObject<RigDriveState>;
  result: MutableRefObject<RigDriveResult | null>;
} {
  const state = useRef<RigDriveState>(createRigDriveState());
  const result = useRef<RigDriveResult | null>(null);
  // useFrame reads the latest props through this ref, so per-frame inputs
  // (player time, cart frames, activation key) are never a render behind.
  const latest = useRef(options);
  latest.current = options;

  useFrame((_, deltaSeconds) => {
    const { camera, intent, enabled, onFrame } = latest.current;
    if (enabled === false) return;

    let driven: RigDriveResult;
    if (intent.mode === "timeline") {
      const { mode, ...params } = intent;
      driven = driveTimeline(state.current, { camera, ...params }, deltaSeconds);
    } else if (intent.mode === "activation") {
      const { mode, ...params } = intent;
      driven = driveActivation(state.current, { camera, ...params }, deltaSeconds);
    } else {
      // Idle: mirror the activation idle path so re-entry re-activates cleanly.
      state.current.composer.vcamId = null;
      state.current.activation = { key: null, vcamId: null };
      driven = { ...IDLE_RESULT, cameraSnapshot: state.current.brain.live ?? null };
    }

    result.current = driven;
    onFrame?.(driven, state.current, deltaSeconds);
  });

  return { state, result };
}
