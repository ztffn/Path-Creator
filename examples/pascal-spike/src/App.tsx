// Q2 harness, against the real Pascal viewer: drive a Pascal node's transform every frame
// from a path-creator track and measure whether anything writes over it. The probe mounts
// as a child of <Viewer>, so it shares Pascal's own frame loop rather than racing it from a
// separate rAF. Results are mirrored onto window.__spike so a headless browser can read the
// numbers without screenshots. Scope: throwaway spike harness — see README.md.
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Vector3, type Object3D } from "three";
import { Viewer } from "@pascal-app/viewer";
import { nodeRegistry, sceneRegistry, useScene } from "@pascal-app/core";
import { TransformTrackDirector } from "@huma/path-creator/three";
import type { TransformTrack } from "@huma/path-creator/core";
import { loadPascalBuiltins } from "./pascal-bootstrap";
import { pascalObjectBinding } from "./pascal-binding";

// `?pokeDriven` edits the node being driven, mid-playback — the one case that makes Pascal
// reapply its own position over ours. Off by default so the baseline measures the clean path.
const POKE_DRIVEN = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("pokeDriven");
const CYCLE_SECONDS = 6;
const LIFT_METRES = 3;

export interface SpikeReport {
  kinds: number;
  nodeIds: string[];
  registered: string[];
  target: string | null;
  frames: number;
  fps: number;
  driftWorst: number;
  driftLast: number;
  driftNonZeroFrames: number;
  undoDepth: number;
  dirtyNodes: number;
  probeMounted: boolean;
  driftFrames: number[];
  perturbedAt: number[];
  error: string | null;
}

const report: SpikeReport = {
  kinds: 0, nodeIds: [], registered: [], target: null, frames: 0, fps: 0,
  driftWorst: 0, driftLast: 0, driftNonZeroFrames: 0, undoDepth: 0, dirtyNodes: 0,
  probeMounted: false, driftFrames: [], perturbedAt: [], error: null
};
declare global { interface Window { __spike?: SpikeReport } }

function undoDepth(): number {
  // zundo hangs a `temporal` store off the zustand store; missing means Pascal changed how
  // history works, which is itself worth reporting rather than crashing the probe over.
  const temporal = (useScene as unknown as { temporal?: { getState(): { pastStates?: unknown[] } } }).temporal;
  return temporal?.getState().pastStates?.length ?? -1;
}

/** Rides Pascal's frame loop: read what the object holds, then write what the timeline says. */
function DriftProbe({ onReport }: { onReport: (r: SpikeReport) => void }) {
  useEffect(() => { report.probeMounted = true; }, []);
  const binding = useMemo(() => pascalObjectBinding(sceneRegistry), []);
  const director = useMemo(() => new TransformTrackDirector(), []);
  const written = useRef<Vector3 | null>(null);
  const basePose = useRef<Vector3 | null>(null);
  const targetId = useRef<string | null>(null);
  const elapsed = useRef(0);
  const started = useRef<number | null>(null);

  useFrame((_, delta) => {
    if (started.current === null) started.current = performance.now();

    // Pick whatever Pascal actually registered — the probe should not assume a scene shape.
    if (!targetId.current) {
      const nodes = useScene.getState().nodes;
      for (const id of sceneRegistry.nodes.keys()) {
        const kind = (nodes as Record<string, { type?: string } | undefined>)[id]?.type;
        if (kind && kind !== "site" && kind !== "building" && kind !== "level") {
          targetId.current = id;
          break;
        }
      }
      const object = targetId.current ? sceneRegistry.nodes.get(targetId.current) : null;
      if (object) basePose.current = object.position.clone();
      if (!targetId.current) return;
    }

    const object = sceneRegistry.nodes.get(targetId.current);
    if (!object || !basePose.current) return;

    // Read BEFORE writing. Anything that moved this object since our last write — Pascal
    // re-rendering the node from its own data, a system reapplying node position — lands here.
    if (written.current) {
      const drift = object.position.distanceTo(written.current);
      report.driftLast = drift;
      if (drift > 1e-9) {
        report.driftWorst = Math.max(report.driftWorst, drift);
        report.driftNonZeroFrames += 1;
        if (report.driftFrames.length < 40) report.driftFrames.push(report.frames);
      }
    }

    elapsed.current = (elapsed.current + delta) % CYCLE_SECONDS;
    const base = basePose.current;
    const tracks: TransformTrack[] = [{
      type: "transform", id: "probe-lift", objectId: targetId.current,
      position: [
        { time: 0, value: [base.x, base.y, base.z] },
        { time: CYCLE_SECONDS / 2, value: [base.x, base.y + LIFT_METRES, base.z] },
        { time: CYCLE_SECONDS, value: [base.x, base.y, base.z] }
      ]
    }];
    director.sync(binding, [{ tracks, time: elapsed.current }], true);
    written.current = object.position.clone();

    report.frames += 1;
    // An author does not hold still while the timeline plays. Poke Pascal's store mid-drive
    // — a node update forces the React commit that would reapply `position` from node data.
    if (report.frames === 200 || report.frames === 400 || report.frames === 600) {
      report.perturbedAt.push(report.frames);
      const scene = useScene.getState();
      const siteId = Object.values(scene.nodes).find((n) => (n as { type?: string }).type === "site") as { id: string } | undefined;
      if (siteId) scene.updateNode(siteId.id as never, { name: `poke-${report.frames}` } as never);
    }
    // Harder case, opt-in with ?pokeDriven: update the DRIVEN node itself mid-playback.
    if (POKE_DRIVEN && report.frames === 500) {
      report.perturbedAt.push(-500); // negative marks the driven-node poke
      useScene.getState().updateNode(targetId.current as never, { name: "driven-poke" } as never);
    }
    report.target = targetId.current;
    report.fps = report.frames / Math.max(1e-3, (performance.now() - started.current) / 1000);
    report.undoDepth = undoDepth();
    report.dirtyNodes = useScene.getState().dirtyNodes?.size ?? -1;
    report.registered = [...sceneRegistry.nodes.keys()];
    if (report.frames % 30 === 0) onReport({ ...report });
  });

  useEffect(() => () => director.sync(binding, [], false), [director, binding]);
  return null;
}

export default function App() {
  const [view, setView] = useState<SpikeReport>(report);

  useEffect(() => {
    try {
      const kinds = loadPascalBuiltins();
      report.kinds = kinds.length;
      const scene = useScene.getState();
      if (Object.keys(scene.nodes).length === 0) scene.loadScene();

      // Pascal's default scene is only site/building/level — no geometry to drive. Add a
      // column under the level: it is parametric, so it needs no catalog asset or GLB.
      const state = useScene.getState();
      const level = Object.values(state.nodes).find((n) => (n as { type?: string }).type === "level");
      const def = nodeRegistry.get("column");
      if (level && def && !Object.values(state.nodes).some((n) => (n as { type?: string }).type === "column")) {
        const levelId = (level as { id: string }).id;
        state.createNode(
          { ...(def.defaults?.() ?? {}), id: "spike_column_1", type: "column", parentId: levelId } as never,
          levelId as never
        );
      }
      report.nodeIds = Object.keys(useScene.getState().nodes);
      report.undoDepth = undoDepth();
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
    }
    window.__spike = report;
    setView({ ...report });
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Viewer>
        <DriftProbe onReport={(r) => { window.__spike = r; setView(r); }} />
      </Viewer>
      <pre style={{
        position: "absolute", top: 12, left: 12, margin: 0, padding: "10px 12px",
        borderRadius: 8, background: "rgba(16,20,26,0.86)", color: "#e6edf3",
        font: "11px/1.55 ui-monospace, SFMono-Regular, monospace", maxWidth: 460
      }}>
{`Q2 — does Pascal overwrite what the timeline writes?

kinds registered : ${view.kinds}
scene nodes      : ${view.nodeIds.length}
registered in 3D : ${view.registered.length}
driven node      : ${view.target ?? "—"}
frames           : ${view.frames}   fps: ${view.fps.toFixed(1)}
drift last       : ${view.driftLast.toExponential(2)}
drift worst      : ${view.driftWorst.toExponential(2)}
frames w/ drift  : ${view.driftNonZeroFrames}
undo depth       : ${view.undoDepth}
dirty nodes      : ${view.dirtyNodes}
probe mounted    : ${view.probeMounted}
drift at frames  : ${view.driftFrames.join(", ") || "—"}
perturbed at     : ${view.perturbedAt.join(", ") || "—"}
error            : ${view.error ?? "none"}`}
      </pre>
    </div>
  );
}
