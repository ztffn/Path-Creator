// P0.3 WebGPU validation surface (see GEOSPATIAL-INTEGRATION-DEBRIEF.md): the full
// PathEditor under three's WebGPURenderer with the WebGPU-safe gizmo (TransformGizmo)
// injected. Proves the editor renders, selects (click any anchor OR control point),
// and edits (drag the gizmo) with no device loss. ControlMode.Free so control points
// are draggable; a visible theme so the rail reads on the dark background. Anchor
// labels + midpoint pivot are gated off on WebGPU inside PathEditor (RigLabel is a
// ROADMAP follow-up).
import { Canvas, extend, type Catalogue } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useMemo, useState } from "react";
import * as THREE from "three/webgpu";
import { BezierPath, ControlMode, PathSpace, VertexPath, type Vec3 } from "@huma/path-creator/core";
import { PathEditor, TransformGizmo, useEditorHelpersVisible } from "@huma/path-creator/r3f";

// `three/webgpu` IS a catalogue of three constructors, but its namespace type does not
// structurally satisfy R3F's `Catalogue` (it also carries non-constructor exports), so the
// cast names the shape R3F wants rather than erasing it to `Record<string, unknown>` — which
// matches neither `extend` overload and was only ever accepted because nothing typechecked here.
extend(THREE as unknown as Catalogue);

// Bright rail/handles so the editor reads on the dark canvas (the default theme's
// near-black rail is invisible here — a consumer supplies its own theme).
const THEME = {
  rail: "#38bdf8",
  tie: "#0ea5e9",
  activeLine: "#38bdf8",
  controlLine: "#94a3b8",
  anchor: "#f97316",
  anchorSelected: "#fde047",
  handle: "#22c55e",
  handleSelected: "#fde047"
};

function Scene() {
  // PathEditor renders its visuals on the reserved EditorHelpers layer; the
  // viewport camera must enable it or the editor renders to nothing.
  useEditorHelpersVisible();

  const bezier = useMemo(
    () =>
      new BezierPath(
        [
          { x: -2, y: 0, z: 0 },
          { x: -0.7, y: 0.5, z: 1.2 },
          { x: 0.7, y: 0.5, z: 1.2 },
          { x: 2, y: 0, z: 0 }
        ],
        { space: PathSpace.XYZ, controlMode: ControlMode.Free }
      ),
    []
  );
  const [pathVersion, setPathVersion] = useState(0);
  const vertexPath = useMemo(
    () => new VertexPath(bezier, { spacing: 0.05 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bezier, pathVersion]
  );

  const [selectedHandleIndex, setSelectedHandleIndex] = useState<number | null>(0);
  const [selectedMidpointIndex, setSelectedMidpointIndex] = useState<number | null>(null);

  return (
    <>
      <ambientLight intensity={0.7} />
      <directionalLight position={[3, 4, 2]} intensity={1} />
      <PathEditor
        bezierPath={bezier}
        vertexPath={vertexPath}
        pathVersion={pathVersion}
        pathStyle="rail"
        theme={THEME}
        gizmo={TransformGizmo}
        selectedHandleIndex={selectedHandleIndex}
        selectedMidpointIndex={selectedMidpointIndex}
        onSelectHandle={setSelectedHandleIndex}
        onSelectMidpoint={setSelectedMidpointIndex}
        onMovePoint={(index: number, point: Vec3) => {
          bezier.movePoint(index, point);
          setPathVersion((v) => v + 1);
        }}
      />
    </>
  );
}

export function App() {
  return (
    <Canvas
      camera={{ position: [0, 2.5, 4], fov: 45 }}
      gl={async (props) => {
        const renderer = new THREE.WebGPURenderer(
          props as ConstructorParameters<typeof THREE.WebGPURenderer>[0]
        );
        await renderer.init();
        return renderer;
      }}
    >
      <color attach="background" args={["#0a101c"]} />
      <Scene />
      <OrbitControls makeDefault />
    </Canvas>
  );
}
