// The bake measurement, load half (plan §0b, decision 2's evidence): mount Pascal's own baked
// viewer surface (GlbScene) over the artifact the editor app exported, rebuild the id-to-object
// binding FROM THE ARTIFACT (extras.pascalId, exactly as §0b predicted: same resolver interface,
// different source), and drive the baked column with the manifest's transform track. This file
// runs in a bundle that cannot resolve /nodes, /editor or next — measure-bake.mjs proves that
// statically. Reached with `?mode=bake`; numbers land on window.__bakeCheck.
import { useEffect, useMemo, useRef, useState } from "react";
import { GlbScene, Viewer } from "@pascal-app/viewer";
import { useFrame, useThree } from "@react-three/fiber";
import type { Object3D } from "three";
import { createTimeline, type Timeline } from "@huma/path-creator/core";
import { PascalNodeDriver, pascalObjectBinding } from "@huma/pascal-time";

interface BakeManifest {
  trackedId: string;
  track: { type: "transform"; id: string; objectId: string; position: { time: number; value: [number, number, number] }[] };
  durationSeconds: number;
}

export interface BakeCheckReport {
  phase: "loading" | "driving" | "checked" | "released";
  identityCount: number;
  trackedResolved: boolean;
  bogusResolved: boolean;
  framesDriven: number;
  movedDuringDrive: boolean;
  positionAtFour: [number, number, number] | null;
  positionAtZero: [number, number, number] | null;
  restoredOffsetMetres: number | null;
}

declare global {
  interface Window {
    __bakeCheck?: BakeCheckReport;
  }
}

// Four seconds of wall clock: headless Chrome renders the first post-load seconds well under
// the 50fps cap (~20fps observed), and the check wants a drive measured in frames, not luck.
const DRIVE_SECONDS = 4;
const TRACK_WRAP_SECONDS = 4;

/**
 * The binding source for a baked scene: walk the loaded graph for extras.pascalId (three's
 * GLTFLoader lands glTF extras on userData). No sceneRegistry — that belongs to the live
 * parametric scene; a published presentation has only the artifact.
 */
function collectBakedIdentity(root: Object3D): Map<string, Object3D> {
  const map = new Map<string, Object3D>();
  root.traverse((object) => {
    const id = (object.userData as { pascalId?: string }).pascalId;
    if (id && !map.has(id)) map.set(id, object);
  });
  return map;
}

function BakeProbe({ manifest }: { manifest: BakeManifest }) {
  const scene = useThree((s) => s.scene);
  const timeline: Timeline = useMemo(
    () =>
      createTimeline({
        duration: manifest.durationSeconds,
        tracks: [manifest.track] as Timeline["tracks"]
      }),
    [manifest]
  );
  const state = useRef({
    map: new Map<string, Object3D>(),
    driver: null as PascalNodeDriver | null,
    bakedPose: null as [number, number, number] | null,
    poseDuringDrive: null as [number, number, number] | null,
    wall: 0,
    clock: 0,
    report: {
      phase: "loading",
      identityCount: 0,
      trackedResolved: false,
      bogusResolved: false,
      framesDriven: 0,
      movedDuringDrive: false,
      positionAtFour: null,
      positionAtZero: null,
      restoredOffsetMetres: null
    } as BakeCheckReport
  });

  useEffect(() => {
    window.__bakeCheck = state.current.report;
  }, []);

  useFrame((_, delta) => {
    const s = state.current;
    const report = s.report;

    if (report.phase === "loading") {
      // The GLB loads asynchronously inside GlbScene; rebuild until the subject appears.
      s.map = collectBakedIdentity(scene);
      report.identityCount = s.map.size;
      const tracked = s.map.get(manifest.trackedId);
      if (!tracked) return;
      report.trackedResolved = true;
      report.bogusResolved = s.map.has("no_such_node");
      s.bakedPose = [tracked.position.x, tracked.position.y, tracked.position.z];
      s.driver = new PascalNodeDriver(pascalObjectBinding({ nodes: s.map }));
      report.phase = "driving";
      return;
    }

    const tracked = s.map.get(manifest.trackedId);
    if (!tracked || !s.driver) return;

    if (report.phase === "driving") {
      s.wall += delta;
      s.clock = (s.clock + delta) % TRACK_WRAP_SECONDS;
      s.driver.sync(timeline, { time: s.clock, playing: true, driving: true });
      report.framesDriven += 1;
      if (!s.poseDuringDrive && s.clock > 1) {
        s.poseDuringDrive = [tracked.position.x, tracked.position.y, tracked.position.z];
        report.movedDuringDrive =
          Math.hypot(
            s.poseDuringDrive[0] - s.bakedPose![0],
            s.poseDuringDrive[1] - s.bakedPose![1],
            s.poseDuringDrive[2] - s.bakedPose![2]
          ) > 0.01;
      }
      if (s.wall < DRIVE_SECONDS) return;

      // Scrub-exact checkpoints: seek is a sync at a time, playing=false.
      s.driver.sync(timeline, { time: 4, playing: false, driving: true });
      report.positionAtFour = [tracked.position.x, tracked.position.y, tracked.position.z];
      s.driver.sync(timeline, { time: 0, playing: false, driving: true });
      report.positionAtZero = [tracked.position.x, tracked.position.y, tracked.position.z];
      report.phase = "checked";
      return;
    }

    if (report.phase === "checked") {
      s.driver.release();
      report.restoredOffsetMetres = Math.hypot(
        tracked.position.x - s.bakedPose![0],
        tracked.position.y - s.bakedPose![1],
        tracked.position.z - s.bakedPose![2]
      );
      report.phase = "released";
    }
  });

  return null;
}

export default function BakeApp() {
  const [manifest, setManifest] = useState<BakeManifest | null>(null);

  useEffect(() => {
    void fetch("/baked/manifest.json")
      .then((response) => response.json())
      .then(setManifest);
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0e1116" }}>
      <Viewer selectionManager="custom">
        <GlbScene url="/baked/scene.glb" />
        {manifest ? <BakeProbe manifest={manifest} /> : null}
      </Viewer>
      <div
        style={{
          position: "absolute",
          left: 24,
          top: 24,
          padding: "12px 16px",
          borderRadius: 10,
          background: "rgba(14,17,22,0.86)",
          color: "#e6edf3",
          font: "12px/1.7 ui-monospace, SFMono-Regular, monospace"
        }}
      >
        bake check — see window.__bakeCheck
      </div>
    </div>
  );
}
