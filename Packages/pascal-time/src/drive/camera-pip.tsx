// Picture-in-picture: a second scissored pass showing what the selected shot sees, while the
// author keeps their working view (M1.8). It never touches the viewport camera — R9 says one
// owner per frame, and the owner is the editor's controller — so it renders from a camera of its
// own. It runs at useFrame priority 2, AFTER Pascal's post-processing pass at priority 1, which
// is the only place a second draw can land on top of a composited frame. Runtime-safe: fiber and
// core only, never @pascal-app/editor.
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { PerspectiveCamera, type Object3D } from "three";
import { sceneRegistry } from "@pascal-app/core";
import { resolveVirtualCameraDefinition } from "@huma/path-creator/three";
import type { VirtualCameraSnapshot } from "@huma/path-creator/core";
import { pascalTimeTransport } from "../transport/store";
import { readShotDefinitions } from "../plugin/timeline-io";
import { pascalTargetContext } from "./camera-director";
import { getLastCameraFrame } from "./timeline-scene-driver";

/** 16:9, top-right, clear of the lane dock at the bottom and Pascal's own bottom toolbar. */
const PIP_ASPECT = 16 / 9;
const PIP_MARGIN = 16;
const PIP_MIN_WIDTH = 220;
const PIP_MAX_WIDTH = 360;
const PIP_WIDTH_FRACTION = 0.28;

/**
 * The PiP's rect in CSS pixels, with the origin at the canvas's BOTTOM-left — which is the origin
 * the renderer's scissor and viewport use, not the DOM's. Exported so a DOM overlay can draw its
 * chrome over exactly the same box.
 */
export function pipRect(width: number, height: number): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const w = Math.min(PIP_MAX_WIDTH, Math.max(PIP_MIN_WIDTH, width * PIP_WIDTH_FRACTION));
  const h = w / PIP_ASPECT;
  return {
    x: Math.max(PIP_MARGIN, width - w - PIP_MARGIN),
    y: Math.max(PIP_MARGIN, height - h - PIP_MARGIN),
    width: w,
    height: h
  };
}

/** What the last PiP frame did. The DOM cannot see a scissored draw; a measure has to be told. */
export interface PipFrameInfo {
  shotId: string;
  frames: number;
  position: [number, number, number];
  fov: number;
  /** Whether the pose came from the director's applied frame rather than a fresh resolve. */
  fromDirector: boolean;
}

let pipFrame: PipFrameInfo | null = null;

/** The PiP's last rendered frame, or null when the PiP is off or the shot resolves to nothing. */
export function getPipFrame(): PipFrameInfo | null {
  return pipFrame;
}

/**
 * The renderer slice this needs. Declared structurally because Pascal's viewer is WebGPU: the
 * scissor/viewport/clear calls are the same on `WebGPURenderer` and `WebGLRenderer`, but the two
 * do not share a published type, and importing three's WebGPU entry here would drag its whole
 * node material graph into a runtime bundle for four method signatures.
 */
interface ScissorRenderer {
  setScissorTest(enable: boolean): void;
  setScissor(x: number, y: number, width: number, height: number): void;
  setViewport(x: number, y: number, width: number, height: number): void;
  clearDepth?(): void;
  render(scene: object, camera: object): unknown;
}

export function PascalTimeCameraPip(): null {
  const gl = useThree((state) => state.gl) as unknown as ScissorRenderer;
  const scene = useThree((state) => state.scene);
  const size = useThree((state) => state.size);
  const pipCamera = useMemo(() => new PerspectiveCamera(50, PIP_ASPECT, 0.1, 5000), []);
  const targets = useMemo(() => pascalTargetContext(sceneRegistry), []);

  // Leaving the PiP mounted-but-off must not leave a stale reading behind for a probe to read.
  useEffect(() => () => {
    pipFrame = null;
  }, []);

  useFrame(() => {
    const transport = pascalTimeTransport.getState();
    const shotId = transport.pipShotId;
    if (!shotId || !transport.timelineId || size.width < 1 || size.height < 1) {
      pipFrame = null;
      return;
    }

    // Prefer what the director actually APPLIED, when the previewed shot is the one in force:
    // that pose has been through the blend and the composer, so the inset agrees with the
    // viewport instead of showing a second, differently-derived answer for the same shot.
    const applied = getLastCameraFrame();
    let snapshot: VirtualCameraSnapshot | null =
      applied && applied.vcamId === shotId ? applied.snapshot : null;
    const fromDirector = snapshot !== null;

    if (!snapshot) {
      const definition = readShotDefinitions(transport.timelineId).get(shotId);
      if (!definition) {
        pipFrame = null;
        return;
      }
      snapshot = resolveVirtualCameraDefinition(definition, {
        getTargetPosition: targets.getTargetPosition,
        elapsedSeconds: transport.time
      });
    }
    if (!snapshot) {
      pipFrame = null;
      return;
    }

    pipCamera.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
    pipCamera.quaternion.set(
      snapshot.quaternion.x,
      snapshot.quaternion.y,
      snapshot.quaternion.z,
      snapshot.quaternion.w
    );
    const fov = snapshot.lens?.fov ?? 50;
    if (pipCamera.fov !== fov) {
      pipCamera.fov = fov;
    }
    // The inset is 16:9 regardless of the canvas, so its aspect is fixed rather than borrowed.
    pipCamera.aspect = PIP_ASPECT;
    pipCamera.updateProjectionMatrix();
    pipCamera.updateMatrixWorld(true);

    // Standing at the shot's lens puts the author inside the shot's own marker geometry — a
    // screen-filling wash of its material colour, which is the same trap the shot renderer's
    // proximity rule solves for the main camera. Hide the whole registered group for this pass
    // only and restore whatever it was: nothing reads `visible` in between, so activation and
    // selection semantics are untouched.
    const marker = sceneRegistry.nodes.get(shotId as never) as Object3D | undefined;
    const markerWasVisible = marker?.visible;
    if (marker) marker.visible = false;

    const rect = pipRect(size.width, size.height);
    try {
      gl.setScissorTest(true);
      gl.setScissor(rect.x, rect.y, rect.width, rect.height);
      gl.setViewport(rect.x, rect.y, rect.width, rect.height);
      // Clear depth inside the scissor only, or the main pass's depth buffer occludes the inset.
      gl.clearDepth?.();
      gl.render(scene, pipCamera);
    } finally {
      // Restoring is not optional: a scissor left on clips the NEXT frame's main render to this
      // corner, and the failure looks like the whole editor went blank.
      gl.setScissorTest(false);
      gl.setViewport(0, 0, size.width, size.height);
      if (marker && markerWasVisible !== undefined) marker.visible = markerWasVisible;
    }

    pipFrame = {
      shotId,
      frames: (pipFrame?.shotId === shotId ? pipFrame.frames : 0) + 1,
      position: [snapshot.position.x, snapshot.position.y, snapshot.position.z],
      fov,
      fromDirector
    };
  }, 2);

  return null;
}
