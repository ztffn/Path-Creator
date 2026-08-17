// Q3: who owns the camera? Drives Pascal's viewer camera from a path-creator virtual camera
// and measures, each frame, whether anything moved it since our write — the same instrument
// Q2 used on a node. Three modes, because the answer differs by context: no controls (a
// published viewer), drei CameraControls mounted the way Pascal's editor mounts them, and the
// cooperative path that pushes our pose through those controls instead of past them.
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import { Vector3 } from "three";
import {
  applyVirtualCameraSnapshot,
  resolveVirtualCameraDefinition
} from "@huma/path-creator/three";
import type { VirtualCameraDefinition } from "@huma/path-creator/core";

export type CameraMode = "solo" | "contested" | "cooperative";

export interface CameraReport {
  mode: CameraMode;
  frames: number;
  driftWorst: number;
  driftLast: number;
  driftFrames: number;
  radiusHeld: number;
  error: string | null;
}

const ORBIT_TARGET = { x: 0, y: 1, z: 0 };
const ORBIT_RADIUS = 12;

/** An orbit shot that never stops moving, so a contest shows up immediately. */
const DEFINITION: VirtualCameraDefinition = {
  id: "q3-orbit",
  body: {
    type: "orbit",
    target: ORBIT_TARGET,
    azimuthDeg: 0,
    elevationDeg: 22,
    radius: ORBIT_RADIUS,
    binding: "world",
    autoOrbitDegPerSec: 45
  },
  aim: { type: "body" },
  lens: { fov: 50 }
};

export function CameraProbe({
  mode,
  onReport
}: {
  mode: CameraMode;
  onReport: (r: CameraReport) => void;
}) {
  const camera = useThree((s) => s.camera);
  const controls = useRef<CameraControls | null>(null);
  const written = useRef<Vector3 | null>(null);
  const elapsed = useRef(0);
  const target = useMemo(() => new Vector3(ORBIT_TARGET.x, ORBIT_TARGET.y, ORBIT_TARGET.z), []);
  const report = useRef<CameraReport>({
    mode, frames: 0, driftWorst: 0, driftLast: 0, driftFrames: 0, radiusHeld: 0, error: null
  });

  useEffect(() => { report.current = { ...report.current, mode }; }, [mode]);

  // Priority 1: run AFTER drei's CameraControls, which registers at the default priority.
  // Reading before our own previous write is what makes the drift number meaningful.
  useFrame((_, delta) => {
    const r = report.current;
    try {
      if (written.current) {
        const drift = camera.position.distanceTo(written.current);
        r.driftLast = drift;
        if (drift > 1e-9) {
          r.driftWorst = Math.max(r.driftWorst, drift);
          r.driftFrames += 1;
        }
        // Radius the camera ACTUALLY held coming into this frame — i.e. after anything else
        // had its say. Measuring it after our own write would just echo the authored value.
        r.radiusHeld = camera.position.distanceTo(target);
      }

      elapsed.current += delta;
      const coded = resolveVirtualCameraDefinition(DEFINITION, {
        getTargetPosition: () => null,
        getTargetOrientation: () => null,
        elapsedSeconds: elapsed.current
      });
      if (!coded) return;

      if (mode === "cooperative" && controls.current) {
        // Hand the pose to the controller instead of writing past it: the controller stays
        // the single owner of the camera and we become one more thing that sets its look-at.
        const p = coded.position;
        void controls.current.setLookAt(p.x, p.y, p.z, target.x, target.y, target.z, false);
        controls.current.update(0);
      } else {
        applyVirtualCameraSnapshot(camera, coded);
      }

      written.current = camera.position.clone();
      r.frames += 1;
      if (r.frames % 30 === 0) onReport({ ...r });
    } catch (error) {
      r.error = error instanceof Error ? error.message : String(error);
      onReport({ ...r });
    }
  }, 1);

  if (mode === "solo") return null;
  // Mounted exactly as Pascal's editor mounts it (`@react-three/drei` CameraControls).
  return <CameraControls ref={controls} makeDefault />;
}
