// Renderer for the `huma-time:path` kind — the rail an author draws. It samples the node's own
// bezier into a polyline and draws it through the library's `RigLine`, which picks a WebGL fat
// line or a WebGPU-safe thin one by backend; a drei <Line> here would take Pascal's WebGPU
// renderer down with a device loss. Points are LOCAL, so the line rides the node's own group and
// Pascal's move gizmo drags the whole rail for free. Scope: one kind's geometry.
import { useMemo, useRef } from "react";
import { useRegistry } from "@pascal-app/core";
import type { Object3D } from "three";
import { BezierPath, VertexPath } from "@huma/path-creator/core";
import { RigLine } from "@huma/path-creator/r3f";
import { PATH_KIND, type PathNodeType } from "../plugin/kinds";

const RAIL_COLOR = "#7c8ba1";
/** An anchor every 3 points, matching how `BezierPath` interleaves anchors and controls. */
const ANCHOR_STRIDE = 3;
const ANCHOR_COLOR = "#f97316";

export default function PathRenderer({ node }: { node: PathNodeType }) {
  const ref = useRef<Object3D>(null!);
  useRegistry(node.id, PATH_KIND, ref);

  // Sampling is the expensive half, so it is keyed on what actually changes the shape. A
  // rebuild per frame would re-walk the curve for a rail nobody touched.
  const points = useMemo<[number, number, number][]>(() => {
    if (node.points.length < 4) return [];
    try {
      const bezier = BezierPath.fromJSON({
        points: node.points,
        perAnchorNormalsAngle: node.perAnchorNormalsAngle,
        isClosed: node.isClosed,
        space: node.space as never,
        controlMode: node.controlMode as never,
        autoControlLength: node.autoControlLength,
        flipNormals: node.flipNormals,
        globalNormalsAngle: node.globalNormalsAngle
      });
      const vertexPath = new VertexPath(bezier, {
        maxAngleError: node.maxAngleError,
        minVertexDistance: node.minVertexDistance,
        ...(node.spacing ? { spacing: node.spacing } : {})
      });
      return vertexPath.localPoints.map((p) => [p.x, p.y, p.z] as [number, number, number]);
    } catch {
      // Mid-draw the point list can be a shape BezierPath rejects. A rail that cannot be
      // sampled yet draws nothing rather than tearing the viewport down.
      return [];
    }
  }, [
    node.points,
    node.perAnchorNormalsAngle,
    node.isClosed,
    node.space,
    node.controlMode,
    node.autoControlLength,
    node.flipNormals,
    node.globalNormalsAngle,
    node.maxAngleError,
    node.minVertexDistance,
    node.spacing
  ]);

  // Anchors get a small solid marker so a rail reads as editable even when nothing is selected,
  // and so a single-point path (before it has a segment) is still visible in the viewport.
  const anchors = useMemo(
    () => node.points.filter((_, index) => index % ANCHOR_STRIDE === 0),
    [node.points]
  );

  return (
    <group name={node.name ?? node.id} position={node.position} ref={ref} visible={node.visible !== false}>
      {points.length >= 2 ? <RigLine points={points} color={RAIL_COLOR} lineWidth={2} /> : null}
      {anchors.map((point, index) => (
        <mesh key={index} position={[point.x, point.y, point.z]}>
          {/* Constant geometry args for the mesh's whole lifetime: swapping them mid-frame
              disposes and recreates GPU buffers, which three's WebGPU backend mishandles. */}
          <sphereGeometry args={[0.09, 10, 8]} />
          <meshStandardMaterial color={ANCHOR_COLOR} roughness={0.4} />
        </mesh>
      ))}
    </group>
  );
}
