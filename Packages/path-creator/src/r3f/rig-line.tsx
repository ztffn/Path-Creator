// Renderer-safe line primitive. drei's <Line> (fat LineMaterial from
// three-stdlib) is WebGL-only and crashes three's WebGPU node renderer
// (LineMaterial has no node auto-map -> device loss). RigLine picks by backend:
// WebGL -> drei fat line (thick); WebGPU -> core LineBasicMaterial (thin, but
// auto-maps and never crashes). All package line rendering routes through here,
// so node-material thickness on WebGPU (see ROADMAP) is a one-file follow-up.
import { Line } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useMemo } from "react";

export interface RigLineProps {
  points: ReadonlyArray<[number, number, number]>;
  color?: string;
  lineWidth?: number;
  /** Treat points as endpoint pairs (disconnected segments) rather than a polyline. */
  segments?: boolean;
  dashed?: boolean;
  dashSize?: number;
  gapSize?: number;
}

function isWebGPURenderer(gl: unknown): boolean {
  return Boolean((gl as { isWebGPURenderer?: boolean } | null)?.isWebGPURenderer);
}

export function RigLine({
  points,
  color = "#ffffff",
  lineWidth = 1,
  segments = false,
  dashed = false,
  dashSize,
  gapSize
}: RigLineProps) {
  const gl = useThree((state) => state.gl);
  const flat = useMemo(() => {
    const array = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i += 1) {
      array[i * 3] = points[i][0];
      array[i * 3 + 1] = points[i][1];
      array[i * 3 + 2] = points[i][2];
    }
    return array;
  }, [points]);

  if (points.length < 2) return null;

  // WebGL: drei's fat line (the only place the package touches drei for lines).
  if (!isWebGPURenderer(gl)) {
    return (
      <Line
        points={points as [number, number, number][]}
        color={color}
        lineWidth={lineWidth}
        segments={segments}
        dashed={dashed}
        {...(dashSize !== undefined && { dashSize })}
        {...(gapSize !== undefined && { gapSize })}
      />
    );
  }

  // WebGPU (or any non-WebGL backend): thin core line. LineBasicMaterial
  // auto-maps to a node material, so no LineMaterial incompatibility. Thickness
  // and dashing are dropped here until the node-material upgrade (ROADMAP).
  const geometry = (
    <bufferGeometry>
      <bufferAttribute attach="attributes-position" args={[flat, 3]} count={points.length} />
    </bufferGeometry>
  );
  return segments ? (
    <lineSegments>
      {geometry}
      <lineBasicMaterial color={color} />
    </lineSegments>
  ) : (
    <line>
      {geometry}
      <lineBasicMaterial color={color} />
    </line>
  );
}
