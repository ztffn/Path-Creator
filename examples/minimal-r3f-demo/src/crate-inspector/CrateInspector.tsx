// Layered crate-stack inspector — a minimal prototype built on @huma/path-creator.
//
// Demonstrates the "inspect an object on stage" idea from the brainstorm:
//   * An ORBIT virtual camera bound to a target that is a REAL object in the
//     scene (not a decoupled point). The orbit target is a weighted *group* of
//     the actual crate meshes, so the vertical "pedestal" move rides a blend of
//     real world positions — TargetRegistry.resolveGroup does the interpolation.
//   * Manual override (the twin's OrbitControls model): LMB drag orbits azimuth/
//     elevation, wheel dollies in/out. Authored on the vcam `control`, stepped by
//     stepShotOverride — so the same rig works for phone IMU / gimbal / authored
//     playback later, they'd just feed the same override channel or targetLayer.
//   * Snap-to-layer pedestal: ▲/▼ (or Arrow keys) move a continuous `layerFloat`
//     that eases between crate layers — a floor-selector feel.
//
// Everything time-varying is resolved fresh each frame (pure functions of state),
// matching the package's determinism contract.

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid } from "@react-three/drei";
import * as THREE from "three";
import {
  registerObjectTarget,
  resolveVirtualCameraDefinition,
  stepShotOverride,
  applyVirtualCameraSnapshot,
  createRigBodyState,
  createOverrideInputAccumulator,
  type RigBodyState,
  type OverrideInputAccumulator
} from "@huma/path-creator/three";
import {
  TargetRegistry,
  type VirtualCameraDefinition,
  type TargetGroupMember
} from "@huma/path-creator/core";

const CRATE_COUNT = 6;
const CRATE_SIZE = 1.2; // cube edge; also the layer spacing
const ORBIT_RADIUS = 5.5;
const ORBIT_ELEVATION_DEG = 12;
const LAYER_EASE_RATE = 6; // higher = snappier pedestal

function crateY(i: number): number {
  return CRATE_SIZE / 2 + i * CRATE_SIZE;
}

/** The rig: drives the real R3F camera from an orbit vcam bound to live crates. */
function InspectorRig({
  registry,
  membersRef,
  targetLayerRef,
  layerFloatRef
}: {
  registry: TargetRegistry;
  membersRef: React.MutableRefObject<TargetGroupMember[]>;
  targetLayerRef: React.MutableRefObject<number>;
  layerFloatRef: React.MutableRefObject<number>;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  const rigState = useRef<RigBodyState>(createRigBodyState());
  const accum = useRef<OverrideInputAccumulator>(
    createOverrideInputAccumulator({
      orbitDegPerPixel: 0.4,
      dollyPerWheel: 0.01
    })
  );

  // The orbit vcam. Its target is the "focus" group (a blend of real crates).
  // control makes azimuth/elevation user-drivable and dolly free (wheel zoom).
  const definition = useMemo<VirtualCameraDefinition>(
    () => ({
      id: "crate-inspector",
      body: {
        type: "orbit",
        target: { targetId: "focus" },
        azimuthDeg: 30,
        elevationDeg: ORBIT_ELEVATION_DEG,
        radius: ORBIT_RADIUS,
        binding: "world"
      },
      aim: { type: "body" }, // orbit body already looks back at the focus point
      lens: { fov: 45 },
      control: {
        azimuth: { mode: "free" },
        elevation: { mode: "free" },
        dolly: { mode: "free" },
        minDistance: 2,
        maxDistance: 14
      }
    }),
    []
  );

  // Manual-override input: LMB drag → orbit, wheel → dolly.
  useEffect(() => {
    const el = gl.domElement;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      accum.current.orbit(e.clientX - lastX, e.clientY - lastY);
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      accum.current.dolly(e.deltaY);
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("wheel", onWheel);
    };
  }, [gl]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 30);

    // Pedestal: ease the continuous layer toward the selected integer layer,
    // then rebuild the focus group's weights from the two bracketing crates.
    const target = targetLayerRef.current;
    const cur = layerFloatRef.current;
    const alpha = 1 - Math.exp(-LAYER_EASE_RATE * dt);
    const next = cur + (target - cur) * alpha;
    layerFloatRef.current = Math.abs(next - target) < 1e-4 ? target : next;

    const f = layerFloatRef.current;
    const lower = Math.floor(f);
    const upper = Math.min(lower + 1, CRATE_COUNT - 1);
    const frac = f - lower;
    membersRef.current =
      lower === upper
        ? [{ targetId: `crate/${lower}`, weight: 1 }]
        : [
            { targetId: `crate/${lower}`, weight: 1 - frac },
            { targetId: `crate/${upper}`, weight: frac }
          ];

    // Resolve the coded shot, apply manual override, write to the real camera.
    const coded = resolveVirtualCameraDefinition(definition, {
      getTargetPosition: (id) => registry.resolve(id),
      getTargetOrientation: (id) => registry.resolveOrientation(id),
      elapsedSeconds: 0
    });
    if (!coded) return;

    const input = accum.current.drain() ?? undefined;
    const result = stepShotOverride(
      definition,
      coded,
      (id) => registry.resolve(id),
      rigState.current,
      input,
      dt
    );
    applyVirtualCameraSnapshot(camera, result.snapshot);
  });

  return null;
}

export default function CrateInspector() {
  const registry = useMemo(() => new TargetRegistry(), []);
  const targetLayerRef = useRef(0);
  const layerFloatRef = useRef(0);
  const membersRef = useRef<TargetGroupMember[]>([{ targetId: "crate/0", weight: 1 }]);
  const [layerLabel, setLayerLabel] = useState(0);

  const changeLayer = (dir: number) => {
    const next = Math.max(0, Math.min(CRATE_COUNT - 1, targetLayerRef.current + dir));
    targetLayerRef.current = next;
    setLayerLabel(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp") changeLayer(1);
      else if (e.key === "ArrowDown") changeLayer(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0e1116" }}>
      <Canvas
        shadows
        camera={{ position: [6, 4, 6], fov: 45 }}
        style={{ touchAction: "none" }}
      >
        <hemisphereLight args={[0xffffff, 0x334455, 0.9]} />
        <directionalLight position={[6, 12, 8]} intensity={1.4} castShadow />
        <Grid
          args={[40, 40]}
          cellColor="#2a3340"
          sectionColor="#3a4657"
          position={[0, 0, 0]}
          infiniteGrid
          fadeDistance={40}
        />
        {/* a little surrounding "world" so the target clearly lives in a scene */}
        <mesh position={[4, 0.4, -3]} receiveShadow castShadow>
          <boxGeometry args={[0.8, 0.8, 0.8]} />
          <meshStandardMaterial color="#3b4a5a" />
        </mesh>
        <mesh position={[-4.5, 1, 2]} receiveShadow castShadow>
          <cylinderGeometry args={[0.4, 0.4, 2, 16]} />
          <meshStandardMaterial color="#3b4a5a" />
        </mesh>

        <CrateStackBridge
          registry={registry}
          membersRef={membersRef}
        />
        <InspectorRig
          registry={registry}
          membersRef={membersRef}
          targetLayerRef={targetLayerRef}
          layerFloatRef={layerFloatRef}
        />
      </Canvas>

      <Hud layer={layerLabel} onUp={() => changeLayer(1)} onDown={() => changeLayer(-1)} />
    </div>
  );
}

/** Stack + focus-target registration wired to the shared membersRef. */
function CrateStackBridge({
  registry,
  membersRef
}: {
  registry: TargetRegistry;
  membersRef: React.MutableRefObject<TargetGroupMember[]>;
}) {
  const crateRefs = useRef<Array<THREE.Mesh | null>>([]);

  useEffect(() => {
    const disposers: Array<() => void> = [];
    crateRefs.current.forEach((mesh, i) => {
      if (mesh) disposers.push(registerObjectTarget(registry, `crate/${i}`, mesh, `Crate ${i}`));
    });
    disposers.push(
      registry.register("focus", () => registry.resolveGroup(membersRef.current), "Focus")
    );
    return () => disposers.forEach((d) => d());
  }, [registry, membersRef]);

  return (
    <group>
      {Array.from({ length: CRATE_COUNT }, (_, i) => (
        <mesh
          key={i}
          ref={(m) => (crateRefs.current[i] = m)}
          position={[0, crateY(i), 0]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[CRATE_SIZE, CRATE_SIZE, CRATE_SIZE]} />
          <meshStandardMaterial
            color={new THREE.Color().setHSL(0.08, 0.5, 0.42 + (i % 2) * 0.06)}
            roughness={0.85}
          />
        </mesh>
      ))}
    </group>
  );
}

function Hud({
  layer,
  onUp,
  onDown
}: {
  layer: number;
  onUp: () => void;
  onDown: () => void;
}) {
  const btn: React.CSSProperties = {
    width: 44,
    height: 44,
    fontSize: 20,
    borderRadius: 8,
    border: "1px solid #3a4657",
    background: "#1b222c",
    color: "#e6edf3",
    cursor: "pointer"
  };
  return (
    <>
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          color: "#e6edf3",
          font: "13px/1.5 ui-sans-serif, system-ui, sans-serif",
          background: "rgba(20,26,34,0.8)",
          padding: "12px 14px",
          borderRadius: 10,
          maxWidth: 280
        }}
      >
        <strong>Crate-stack inspector</strong>
        <div style={{ opacity: 0.8, marginTop: 6 }}>
          Drag = orbit · Wheel = dolly · ▲/▼ or Arrow keys = climb layers
        </div>
        <div style={{ opacity: 0.8, marginTop: 6 }}>
          Orbit target is a live blend of the real crate meshes.
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          right: 20,
          top: "50%",
          transform: "translateY(-50%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10
        }}
      >
        <button style={btn} onClick={onUp} aria-label="Layer up">
          ▲
        </button>
        <div
          style={{
            color: "#e6edf3",
            font: "600 15px ui-sans-serif, system-ui",
            background: "#1b222c",
            border: "1px solid #3a4657",
            borderRadius: 8,
            padding: "8px 10px",
            minWidth: 44,
            textAlign: "center"
          }}
        >
          L{layer}
        </div>
        <button style={btn} onClick={onDown} aria-label="Layer down">
          ▼
        </button>
      </div>
    </>
  );
}
