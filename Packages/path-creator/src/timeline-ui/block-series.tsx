// A generic scalar-over-time sparkline drawn to fill any timeline block. Renders
// one SVG <path> in normalized coordinates with preserveAspectRatio="none", so the
// block's CSS width/height does the time/amplitude scaling — no px-per-second math,
// and it survives zoom for free. "envelope" draws a symmetric waveform fill from a
// [min,max,…] peak array; "line" draws a polyline from a 0..1 series. Knows nothing
// about audio; the host decides what the series means (audio peaks, dolly speed, …).
import { useMemo, type CSSProperties } from "react";

export type BlockSeriesKind = "envelope" | "line";

export interface BlockSeriesData {
  kind: BlockSeriesKind;
  /** envelope: flat [min,max,min,max,…] in -1..1. line: values in 0..1. */
  points: number[];
  /** Overrides the `color` prop — lets stacked series (e.g. waveform + gain) differ. */
  color?: string;
}

const FILL_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  pointerEvents: "none"
};

const r = (n: number): number => Math.round(n * 100) / 100;

/** Symmetric filled path around the vertical centerline (the waveform look). */
function envelopePath(points: number[]): { d: string; width: number } {
  const n = Math.floor(points.length / 2);
  if (n < 1) return { d: "", width: 1 };
  const width = Math.max(1, n - 1);
  const top: string[] = [];
  const bottom: string[] = [];
  for (let i = 0; i < n; i++) {
    const min = points[i * 2];
    const max = points[i * 2 + 1];
    top.push(`${i === 0 ? "M" : "L"}${r(i)},${r(50 - max * 50)}`);
    bottom.push(`L${r(n - 1 - i)},${r(50 - points[(n - 1 - i) * 2] * 50)}`);
  }
  return { d: `${top.join("")}${bottom.join("")}Z`, width };
}

/** Open polyline of a 0..1 series (1 = top). */
function linePath(points: number[]): { d: string; width: number } {
  if (points.length < 1) return { d: "", width: 1 };
  const width = Math.max(1, points.length - 1);
  const d = points.map((v, i) => `${i === 0 ? "M" : "L"}${r(i)},${r(100 - v * 100)}`).join("");
  return { d, width };
}

export function BlockSeries({ data, color }: { data: BlockSeriesData; color: string }) {
  const { d, width } = useMemo(
    () => (data.kind === "envelope" ? envelopePath(data.points) : linePath(data.points)),
    [data]
  );
  if (!d) return null;
  const paint = data.color ?? color;
  return (
    <svg viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" style={FILL_STYLE}>
      {data.kind === "envelope" ? (
        <path d={d} fill={paint} />
      ) : (
        <path d={d} fill="none" stroke={paint} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}
