// The one component a host mounts inside its R3F scene to make the transport real: it reads
// the shared transport every frame, advances the clock, and drives nodes and camera from the
// timeline in the scene document. In Pascal's editor it goes in `EditorProps.viewerSceneSlot`,
// which is how it shares the viewer's frame loop instead of racing it (§5.3), and it finds the
// mounted CameraControls through R3F's default-controls slot, so R9 holds with zero wiring.
// Runtime-safe: imports core and fiber, never @pascal-app/editor.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { sceneRegistry, useScene } from "@pascal-app/core";
import type { Timeline, VirtualCameraDefinition } from "@huma/path-creator/core";
import { pascalTimeTransport } from "../transport/store";
import { readShotDefinitions, readStoredTimeline, readTimeline } from "../plugin/timeline-io";
import { pascalSceneBinding } from "../bind/scene-binding";
import { PascalNodeDriver } from "./node-driver";
import {
  PascalCameraDirector,
  pascalTargetContext,
  type CameraControlsLike
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
    const transport = pascalTimeTransport.getState();
    const timelineId = transport.timelineId;

    const releaseIfHolding = (): void => {
      if (!wasDriving.current) return;
      driver.release();
      wasDriving.current = false;
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

    const mounted = state.controls;
    director.sync(state.camera, {
      timeline,
      vcams,
      time: clock.time,
      controls: looksLikeCameraControls(mounted) ? mounted : null,
      getTargetPosition: targets.getTargetPosition
    });
  });

  return null;
}
