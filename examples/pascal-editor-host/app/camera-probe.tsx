// Purpose: R3F-side camera instrumentation for measure.mjs — the DOM probe cannot reach the
// viewport camera or the mounted CameraControls. Exposes window.__cameraProbe: read the live
// camera pose (position, forward, fov) and drive the controls the way a user's orbit would
// land them (setLookAt + update). Mounted in viewerSceneSlot next to the scene driver, in
// every mode; it reads state and only writes through the controller, exactly as the user does.
"use client";

import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { Vector3 } from "three";

type CameraProbe = {
  pose(): { position: [number, number, number]; forward: [number, number, number]; fov: number };
  look(position: [number, number, number], target: [number, number, number]): boolean;
};

declare global {
  interface Window {
    __cameraProbe?: CameraProbe;
  }
}

const forward = new Vector3();

export function CameraProbeBridge() {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls);

  useEffect(() => {
    window.__cameraProbe = {
      pose: () => {
        forward.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
        return {
          position: [camera.position.x, camera.position.y, camera.position.z],
          forward: [forward.x, forward.y, forward.z],
          fov: (camera as { fov?: number }).fov ?? 50
        };
      },
      look: (position, target) => {
        const c = controls as {
          setLookAt?: (...args: (number | boolean)[]) => unknown;
          update?: (delta: number) => unknown;
        } | null;
        if (!c?.setLookAt || !c.update) return false;
        c.setLookAt(...position, ...target, false);
        c.update(0);
        return true;
      }
    };
  }, [camera, controls]);

  return null;
}
