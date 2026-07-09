// Derives a dolly move's speed profile as a normalized 0..1 line series for the
// timeline block sparkline. Speed is the time-derivative of the move's easing, sampled
// via the core sampleEasingDerivative helper (shared with the space converter and the
// editor overlay), then max-normalized to show the accel/decel shape within the block.
// Pure; safe to call from render. Demo scaffolding (mirrors the audio-peaks pattern).
import { sampleEasingDerivative, type Easing } from "@huma/path-creator/core";
import type { BlockSeriesData } from "@huma/path-creator/timeline-ui";

export function dollyMoveSpeedSeries(easing: Easing = "linear", samples = 48): BlockSeriesData {
  const speed = sampleEasingDerivative(easing, samples).map(Math.abs);
  const max = Math.max(1e-6, ...speed);
  return { kind: "line", points: speed.map((v) => v / max) };
}
