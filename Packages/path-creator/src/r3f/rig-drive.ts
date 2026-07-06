// Thin r3f wrapper over the framework-agnostic driveRig (in /timeline). Holds the
// shared RigDriveState in a ref and returns a drive(camera, intent, dt) step the
// host calls inside its own useFrame. All dispatch (idle/timeline/activation) lives
// in driveRig so a non-r3f runtime can drive the rig identically; returning a step
// (not owning useFrame) lets a host interleave its own per-frame work around drive.
import { useCallback, useRef, type MutableRefObject } from "react";
import type { Camera } from "three";
import {
  createRigDriveState,
  type RigDriveResult,
  type RigDriveState,
  type VirtualCameraSnapshot
} from "../three";
import { driveRig, type RigDriveIntent } from "../timeline";

// Re-exported so consumers can keep importing the intent type from /r3f.
export type { RigDriveIntent };

export function useRigDrive(initial?: VirtualCameraSnapshot): {
  state: MutableRefObject<RigDriveState>;
  drive: (camera: Camera, intent: RigDriveIntent, deltaSeconds: number) => RigDriveResult;
} {
  const state = useRef<RigDriveState>(createRigDriveState(initial));

  const drive = useCallback(
    (camera: Camera, intent: RigDriveIntent, deltaSeconds: number): RigDriveResult =>
      driveRig(state.current, camera, intent, deltaSeconds),
    []
  );

  return { state, drive };
}
