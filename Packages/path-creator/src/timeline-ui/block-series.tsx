// A generic scalar-over-time sparkline drawn to fill any timeline block. Renders
// one SVG <path> in normalized coordinates with preserveAspectRatio="none", so the
// block's CSS width/height does the time/amplitude scaling — no px-per-second math,
// and it survives zoom for free. "envelope" draws a symmetric waveform fill from a
// [min,max,…] peak array; "line" draws a polyline from a 0..1 series; "markers" draws
// a diamond+stem at each 0..1 position (keyframe ticks). Knows nothing about audio;
// the host decides what the series means (audio peaks, dolly speed, transform keys…).
import { useMemo, type CSSProperties } from "react";

export type BlockSeriesKind = "envelope" | "line" | "markers";

export interface BlockSeriesData {
  kind: BlockSeriesKind;
  /** envelope: flat [min,max,min,max,…] in -1..1. line: values in 0..1. markers: positions in 0..1. */
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

/**
 * Keyframe ticks as HTML (not SVG): a full-height stem plus a centered diamond at
 * each 0..1 position. HTML keeps the diamond square — an SVG under
 * preserveAspectRatio="none" would shear it with the block's aspect ratio.
 */
function Markers({ points, paint }: { points: number[]; paint: string }) {
  return (
    <div style={FILL_STYLE}>
      {points.map((p, i) => {
        const left = `${r(Math.min(1, Math.max(0, p)) * 100)}%`;
        return (
          <div key={i}>
            <div style={{ position: "absolute", left, top: 0, bottom: 0, width: 1, background: paint, opacity: 0.5, transform: "translateX(-0.5px)" }} />
            <div style={{ position: "absolute", left, top: "50%", width: 6, height: 6, background: paint, transform: "translate(-50%, -50%) rotate(45deg)" }} />
          </div>
        );
      })}
    </div>
  );
}

export function BlockSeries({ data, color }: { data: BlockSeriesData; color: string }) {
  const { d, width } = useMemo(
    () => (data.kind === "envelope" ? envelopePath(data.points) : data.kind === "line" ? linePath(data.points) : { d: "", width: 1 }),
    [data]
  );
  const paint = data.color ?? color;
  if (data.kind === "markers") return data.points.length ? <Markers points={data.points} paint={paint} /> : null;
  if (!d) return null;
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
