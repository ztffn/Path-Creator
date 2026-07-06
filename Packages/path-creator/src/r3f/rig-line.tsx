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
  /** Bump when `points` mutate to the SAME length. On WebGPU a same-size buffer's
   *  new contents don't re-upload, so the line goes stale (e.g. rail ties lagging
   *  a drag); a changed version forces a fresh geometry. */
  version?: number;
}

function isWebGPURenderer(gl: unknown): boolean {
  return Boolean((gl as { isWebGPURenderer?: boolean } | null)?.isWebGPURenderer);
}

/** True when the R3F canvas runs three's WebGPU renderer (vs WebGL). */
export function useIsWebGPURenderer(): boolean {
  return isWebGPURenderer(useThree((state) => state.gl));
}

export function RigLine({
  points,
  color = "#ffffff",
  lineWidth = 1,
  segments = false,
  dashed = false,
  dashSize,
  gapSize,
  version
}: RigLineProps) {
  const gl = useThree((state) => state.gl);

  if (points.length < 2) return null;

  // WebGPU (or any non-WebGL backend): thin core line — no drei, no LineMaterial.
  if (isWebGPURenderer(gl)) {
    return <ThinLine points={points} color={color} segments={segments} {...(version !== undefined && { version })} />;
  }

  // WebGL: drei's fat line (the only place the package touches drei for lines).
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

// LineBasicMaterial auto-maps to a node material on WebGPU, so no LineMaterial
// incompatibility. Thickness and dashing are dropped here until the node-material
// upgrade (ROADMAP). Its own component so the Float32Array is built only on the
// WebGPU backend, not wasted on every WebGL render.
function ThinLine({
  points,
  color,
  segments,
  version
}: {
  points: ReadonlyArray<[number, number, number]>;
  color: string;
  segments: boolean;
  version?: number;
}) {
  const flat = useMemo(() => {
    const array = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i += 1) {
      array[i * 3] = points[i][0];
      array[i * 3 + 1] = points[i][1];
      array[i * 3 + 2] = points[i][2];
    }
    return array;
  }, [points]);

  const geometry = (
    <bufferGeometry>
      <bufferAttribute attach="attributes-position" args={[flat, 3]} count={points.length} />
    </bufferGeometry>
  );
  // Remount on either a vertex-count change OR a content-version bump. WebGPU
  // won't reallocate a grown buffer in place ("requires a larger buffer" → device
  // loss), and won't re-upload a same-size buffer's new contents (stale geometry,
  // e.g. rail ties lagging a drag). A fresh element sidesteps both. Key is stable
  // while nothing changes, so idle/playback never remounts.
  const key = `${version ?? 0}-${points.length}`;
  return segments ? (
    <lineSegments key={key}>
      {geometry}
      <lineBasicMaterial color={color} />
    </lineSegments>
  ) : (
    <line key={key}>
      {geometry}
      <lineBasicMaterial color={color} />
    </line>
  );
}
