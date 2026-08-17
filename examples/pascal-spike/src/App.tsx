// Q2 harness, against the real Pascal viewer: drive a Pascal node's transform every frame
// from a path-creator track and measure whether anything writes over it. The probe mounts
// as a child of <Viewer>, so it shares Pascal's own frame loop rather than racing it from a
// separate rAF. Results are mirrored onto window.__spike so a headless browser can read the
// numbers without screenshots. Scope: throwaway spike harness — see README.md.
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3, type Object3D } from "three";
import { Viewer } from "@pascal-app/viewer";
import { nodeRegistry, sceneRegistry, useScene } from "@pascal-app/core";
import { TransformTrackDirector } from "@huma/path-creator/three";
import type { TransformTrack } from "@huma/path-creator/core";
import { loadPascalBuiltins } from "./pascal-bootstrap";
import { pascalObjectBinding } from "./pascal-binding";
import { CameraProbe, type CameraMode, type CameraReport } from "./CameraProbe";
import { hotspotClicks } from "./hotspot-schema";
import { HOTSPOT_PLUGIN_ID } from "./hotspot-plugin";

// `?pokeDriven` edits the node being driven, mid-playback — the one case that makes Pascal
// reapply its own position over ours. Off by default so the baseline measures the clean path.
const POKE_DRIVEN = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("pokeDriven");
// Q3 mode: ?camera=solo | contested | cooperative. Absent = Q2 only.
const CAMERA_MODE = (typeof window !== "undefined"
  ? new URLSearchParams(window.location.search).get("camera")
  : null) as CameraMode | null;
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
  hotspotRegistered: boolean;
  hotspotRendered: boolean;
  hotspotDriven: boolean;
  hotspotClicks: number;
  driftFrames: number[];
  perturbedAt: number[];
  error: string | null;
}

const projectScratch = new Vector3();
const worldScratch = new Vector3();
const parentScratch = new Vector3();

const report: SpikeReport = {
  kinds: 0, nodeIds: [], registered: [], target: null, frames: 0, fps: 0,
  driftWorst: 0, driftLast: 0, driftNonZeroFrames: 0, undoDepth: 0, dirtyNodes: 0,
  probeMounted: false, hotspotRegistered: false, hotspotRendered: false,
  hotspotDriven: false, hotspotClicks: 0, driftFrames: [], perturbedAt: [], error: null
};
declare global { interface Window { __spike?: SpikeReport; __camera?: CameraReport } }

function undoDepth(): number {
  // zundo hangs a `temporal` store off the zustand store; missing means Pascal changed how
  // history works, which is itself worth reporting rather than crashing the probe over.
  const temporal = (useScene as unknown as { temporal?: { getState(): { pastStates?: unknown[] } } }).temporal;
  return temporal?.getState().pastStates?.length ?? -1;
}

/** Rides Pascal's frame loop: read what the object holds, then write what the timeline says. */
function DriftProbe({ onReport }: { onReport: (r: SpikeReport) => void }) {
  useEffect(() => { report.probeMounted = true; }, []);
  const camera = useThree((st) => st.camera);
  const size = useThree((st) => st.size);
  // Pascal's <ViewerCamera> is a drei camera with a position and no target, so with no camera
  // controls mounted it looks down -Z and the scene sits out of frame. Aiming it is legitimate
  // here: with no controller mounted the time layer owns the camera (integration design R9).
  useEffect(() => { camera.lookAt(0, 1, 0); camera.updateMatrixWorld(); }, [camera]);
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
    report.hotspotRendered = sceneRegistry.nodes.has("spike_hotspot_1");
    // Project the hotspot to screen so a headless driver can click it exactly rather than
    // sweeping the canvas and hoping.
    const hs = sceneRegistry.nodes.get("spike_hotspot_1");
    if (hs) {
      const v = hs.getWorldPosition(projectScratch).project(camera);
      (window as unknown as { __hotspotScreen?: unknown }).__hotspotScreen = {
        x: (v.x * 0.5 + 0.5) * size.width,
        y: (-v.y * 0.5 + 0.5) * size.height,
        local: hs.position.toArray(),
        world: hs.getWorldPosition(worldScratch).toArray(),
        parent: hs.parent?.name || hs.parent?.type || null,
        parentWorldY: hs.parent ? hs.parent.getWorldPosition(parentScratch).y : null
      };
    }
    report.hotspotClicks = hotspotClicks.length;
    // Drive the plugin-contributed node with a track, exactly as for a built-in kind.
    const hotspot = sceneRegistry.nodes.get("spike_hotspot_1");
    if (hotspot) {
      const before = hotspot.position.y;
      director.sync(binding, [{ tracks: [{
        type: "transform", id: "hotspot-bob", objectId: "spike_hotspot_1",
        position: [
          { time: 0, value: [3, 1.5, 0] },
          { time: CYCLE_SECONDS / 2, value: [3, 2.5, 0] },
          { time: CYCLE_SECONDS, value: [3, 1.5, 0] }
        ]
      }], time: elapsed.current }], true);
      if (Math.abs(hotspot.position.y - before) > 1e-9 || hotspot.position.y !== 1.5) {
        report.hotspotDriven = true;
      }
    }
    if (report.frames % 30 === 0) onReport({ ...report });
  });

  useEffect(() => () => director.sync(binding, [], false), [director, binding]);
  return null;
}

export default function App() {
  const [view, setView] = useState<SpikeReport>(report);
  const [cam, setCam] = useState<CameraReport | null>(null);

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
      // Q4: place a hotspot from the third-party plugin, parented to the site. A hotspot has
      // no building and no level, which is the hierarchy objection — see whether it survives.
      const site = Object.values(useScene.getState().nodes).find(
        (n) => (n as { type?: string }).type === "site"
      ) as { id: string } | undefined;
      const hotspotDef = nodeRegistry.get("huma:hotspot");
      report.hotspotRegistered = Boolean(hotspotDef);
      // A namespaced plugin kind is gated per project: unless its plugin id is installed,
      // NodeRenderer refuses it. Built-in kinds skip the gate.
      useScene.getState().setInstalledPlugins([HOTSPOT_PLUGIN_ID], { explicit: true });
      if (site && hotspotDef && !useScene.getState().nodes["spike_hotspot_1" as never]) {
        useScene.getState().createNode(
          {
            ...(hotspotDef.defaults?.() ?? {}),
            id: "spike_hotspot_1", type: "huma:hotspot", parentId: site.id,
            position: [3, 1.5, 0], label: "Inspect the column",
            action: { type: "seek", seconds: 2.5 }
          } as never,
          site.id as never
        );
      }
      report.nodeIds = Object.keys(useScene.getState().nodes);
      report.undoDepth = undoDepth();
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
    }
    // Diagnostics hook for the headless driver.
    (window as unknown as { __scene?: unknown }).__scene = useScene;
    window.__spike = report;
    setView({ ...report });
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Viewer>
        <DriftProbe onReport={(r) => { window.__spike = r; setView(r); }} />
        {CAMERA_MODE ? (
          <CameraProbe mode={CAMERA_MODE} onReport={(r) => { window.__camera = r; setCam(r); }} />
        ) : null}
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

Q4 — hotspot as a Pascal plugin node kind
registered kind  : ${view.hotspotRegistered}
rendered in 3D   : ${view.hotspotRendered}
driven by track  : ${view.hotspotDriven}
clicks captured  : ${view.hotspotClicks}
error            : ${view.error ?? "none"}
${cam ? `
Q3 — who owns the camera?   mode: ${cam.mode}
frames           : ${cam.frames}
drift last       : ${cam.driftLast.toExponential(2)}
drift worst      : ${cam.driftWorst.toExponential(2)}
frames w/ drift  : ${cam.driftFrames}
orbit radius     : ${cam.radiusHeld.toFixed(3)}  (authored 12.000)
camera error     : ${cam.error ?? "none"}` : ""}`}
      </pre>
    </div>
  );
}
