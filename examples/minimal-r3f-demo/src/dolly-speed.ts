// Derives a dolly move's speed profile as a normalized 0..1 line series for the
// timeline block sparkline. Speed is the time-derivative of the move's easing curve
// (distance-vs-time), sampled via the same evaluateVirtualCameraBlendCurve the core
// timeline uses, then max-normalized to show the accel/decel shape within the block.
// Pure; safe to call from render. Demo scaffolding (mirrors the audio-peaks pattern).
import { evaluateEasing, type Easing } from "@huma/path-creator/core";
import type { BlockSeriesData } from "@huma/path-creator/timeline-ui";

export function dollyMoveSpeedSeries(easing: Easing = "linear", samples = 48): BlockSeriesData {
  const eps = 1e-3;
  const speed: number[] = [];
  let max = 0;
  for (let i = 0; i < samples; i++) {
    const a = i / (samples - 1);
    const lo = evaluateEasing(Math.max(0, a - eps), easing);
    const hi = evaluateEasing(Math.min(1, a + eps), easing);
    const v = Math.abs(hi - lo);
    speed.push(v);
    if (v > max) max = v;
  }
  return { kind: "line", points: max > 0 ? speed.map((v) => v / max) : speed.map(() => 0) };
}
