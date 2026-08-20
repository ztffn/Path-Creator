// Purpose: R3F-side camera instrumentation for measure.mjs — the DOM probe cannot reach the
// viewport camera or the mounted CameraControls. Exposes window.__cameraProbe: read the live
// camera pose (position, forward, fov), project a world point to canvas pixels (so a headless run
// can drive a real drag on a 3D handle), and drive the controls the way a user's orbit would land
// them (setLookAt + update). Mounted in viewerSceneSlot next to the scene driver, in every mode;
// it reads state and only writes through the controller, exactly as the user does.
"use client";

import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { Vector3 } from "three";

type CameraProbe = {
  pose(): { position: [number, number, number]; forward: [number, number, number]; fov: number };
  look(position: [number, number, number], target: [number, number, number]): boolean;
  /**
   * A world point in CANVAS pixels (origin top-left), or null when it is behind the camera.
   * This is what lets a headless run drive a real drag on a 3D handle: the handles are meshes in
   * the R3F scene, so a check has to be told where on screen they landed before it can click one.
   */
  project(point: [number, number, number]): { x: number; y: number } | null;
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
  const size = useThree((s) => s.size);

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
      project: (point) => {
        const ndc = new Vector3(point[0], point[1], point[2]).project(camera);
        if (ndc.z > 1) return null;
        return {
          x: ((ndc.x + 1) / 2) * size.width,
          y: ((1 - ndc.y) / 2) * size.height
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
  }, [camera, controls, size.height, size.width]);

  return null;
}
