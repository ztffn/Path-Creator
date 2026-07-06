// Reusable path visualization: renders a VertexPath as either a plain centre
// line or a Cinemachine-style dolly rail (two rails + cross-ties), with thick
// drei lines. Pure rendering, no editing chrome — so playback/runtime consumers
// (twin, elastiq) can show a path standalone, and PathEditor composes it for the
// active path. Rail geometry comes from buildDollyRailLines in /three.
import { useMemo } from "react";
import type { Vec3, VertexPath } from "../core";
import { buildDollyRailLines, type DollyRailOptions } from "../three";
import { RigLine } from "./rig-line";

export type PathVisualStyle = "line" | "rail";

/** The path's centre polyline as drei Line points. */
export function buildPathLinePoints(path: VertexPath): [number, number, number][] {
  const values: [number, number, number][] = [];
  for (let i = 0; i < path.numPoints; i += 1) {
    const p = path.getPoint(i);
    values.push([p.x, p.y, p.z]);
  }
  return values;
}

export interface PathVisualProps {
  vertexPath: VertexPath;
  /** Bump to recompute when the path mutates in place. */
  version?: number;
  style?: PathVisualStyle;
  /** Colour of the centre line ("line") or the two rails ("rail"). */
  color?: string;
  /** Cross-tie colour ("rail" only). */
  tieColor?: string;
  lineWidth?: number;
  tieWidth?: number;
  railOptions?: DollyRailOptions;
}

export function PathVisual({
  vertexPath,
  version,
  style = "rail",
  color = "#101828",
  tieColor = "#334155",
  lineWidth = 2,
  tieWidth = 2,
  railOptions
}: PathVisualProps) {
  const toPoints = (pts: Vec3[]): [number, number, number][] =>
    pts.map((p) => [p.x, p.y, p.z]);

  const railLines = useMemo(() => {
    if (style !== "rail") return null;
    const rail = buildDollyRailLines(vertexPath, railOptions ?? {});
    return { left: toPoints(rail.left), right: toPoints(rail.right), ties: toPoints(rail.ties) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vertexPath, version, style, railOptions]);

  const centrePoints = useMemo(
    () => (style === "rail" ? [] : buildPathLinePoints(vertexPath)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vertexPath, version, style]
  );

  if (railLines) {
    return (
      <>
        <RigLine points={railLines.left} color={color} lineWidth={lineWidth} />
        <RigLine points={railLines.right} color={color} lineWidth={lineWidth} />
        {railLines.ties.length >= 2 ? (
          <RigLine segments points={railLines.ties} color={tieColor} lineWidth={tieWidth} />
        ) : null}
      </>
    );
  }

  return <RigLine points={centrePoints} color={color} lineWidth={lineWidth} />;
}
