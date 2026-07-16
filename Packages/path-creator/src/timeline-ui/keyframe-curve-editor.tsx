// Multi-curve keyframe editor: plots one or more channels of keyframes (each key a
// time + component vector, e.g. position x/y/z) as real-unit curves over a shared
// value axis, with a synced playhead. Direct manipulation: drag a key (time + that
// component's value), double-click to add, double-click a point to delete. Controlled
// and host-agnostic; shares the curve-canvas coordinate/edit core with EasingEditor.
import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { clamp, evaluateEasing, lerp, type Easing } from "../core";
import { ANCHOR_EPSILON, makeScale, type Axis } from "./curve-canvas";

/** One keyframe: a time plus a component vector (e.g. [x, y, z]) and optional easing into it. */
export interface CurveChannelKey { time: number; value: number[]; easing?: Easing }

/** A named set of keyframes with per-component colors (and optional labels). */
export interface CurveChannel {
  id: string;
  colors: string[];
  componentLabels?: string[];
  keys: CurveChannelKey[];
  onChange: (keys: CurveChannelKey[]) => void;
}

export interface KeyframeCurveEditorTheme {
  background?: string;
  grid?: string;
  playhead?: string;
  anchor?: string;
  text?: string;
}

const DEFAULT_THEME: Required<KeyframeCurveEditorTheme> = {
  background: "rgba(15, 23, 42, 0.6)",
  grid: "rgba(148, 163, 184, 0.18)",
  playhead: "rgba(249, 115, 22, 0.9)",
  anchor: "rgba(226, 232, 240, 0.95)",
  text: "#cbd5e1"
};

const SAMPLES = 48;
const PAD_FRACTION = 0.1;

/** Value of `keys` component `comp` at time `t`: held before first / after last, eased-lerp between (matches the transform evaluator's per-key easing). */
function sampleComponent(keys: CurveChannelKey[], comp: number, t: number): number {
  if (keys.length === 0) return 0;
  if (t <= keys[0]!.time) return keys[0]!.value[comp] ?? 0;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t <= b.time) {
      const span = b.time - a.time;
      const amount = span > 0 ? evaluateEasing((t - a.time) / span, b.easing ?? "linear") : 1;
      return lerp(a.value[comp] ?? 0, b.value[comp] ?? 0, amount);
    }
  }
  return keys[keys.length - 1]!.value[comp] ?? 0;
}

/** Auto-fit value range across one channel's components, padded so curves don't touch the edges. */
function fitChannelAxis(channel: CurveChannel): Axis {
  let min = Infinity;
  let max = -Infinity;
  for (const key of channel.keys) {
    for (const v of key.value) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -1, max: 1 };
  if (max - min < 1e-9) return { min: min - 1, max: max + 1 };
  const pad = (max - min) * PAD_FRACTION;
  return { min: min - pad, max: max + pad };
}

type Drag = { channel: number; keyIndex: number; component: number; yAxis: Axis };

export function KeyframeCurveEditor({
  channels,
  timeStart,
  timeEnd,
  playhead,
  height = 160,
  theme
}: {
  channels: CurveChannel[];
  timeStart: number;
  timeEnd: number;
  playhead?: number;
  height?: number;
  theme?: KeyframeCurveEditorTheme;
}) {
  const t = { ...DEFAULT_THEME, ...theme };
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(280);
  const [drag, setDrag] = useState<Drag | null>(null);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width ?? 0;
      if (cw > 0) setWidth(cw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const xAxis: Axis = { min: timeStart, max: timeEnd || timeStart + 1 };
  const sx = makeScale(xAxis, width);
  const px = (time: number): number => sx.toPx(time);
  // Each channel normalizes to its OWN value range — position (metres), rotation
  // (degrees) and scale (factors) share no meaningful axis. A drag freezes the dragged
  // channel's range so its curves don't rescale under the cursor.
  const axisFor = (ci: number): Axis => (drag && drag.channel === ci ? drag.yAxis : fitChannelAxis(channels[ci]!));
  const pyFor = (ci: number, value: number): number => height - makeScale(axisFor(ci), height).toPx(value);

  function pointerTime(event: { clientX: number }): number {
    return sx.toValue(event.clientX - svgRef.current!.getBoundingClientRect().left);
  }
  function pointerValue(event: { clientY: number }, ci: number): number {
    const rect = svgRef.current!.getBoundingClientRect();
    return makeScale(axisFor(ci), height).toValue(rect.height - (event.clientY - rect.top));
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>): void {
    if (!drag || !svgRef.current) return;
    const channel = channels[drag.channel];
    if (!channel) return;
    const keys = channel.keys;
    const loT = drag.keyIndex > 0 ? keys[drag.keyIndex - 1]!.time + ANCHOR_EPSILON : timeStart;
    const hiT = drag.keyIndex < keys.length - 1 ? keys[drag.keyIndex + 1]!.time - ANCHOR_EPSILON : timeEnd;
    const nextTime = clamp(pointerTime(event), loT, hiT);
    const nextValue = pointerValue(event, drag.channel);
    const next = keys.map((k, i) => {
      if (i !== drag.keyIndex) return k;
      const value = [...k.value];
      value[drag.component] = nextValue;
      return { ...k, time: nextTime, value };
    });
    channel.onChange(next);
  }

  function startDrag(target: { channel: number; keyIndex: number; component: number }, event: ReactPointerEvent<SVGElement>): void {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ ...target, yAxis: fitChannelAxis(channels[target.channel]!) });
  }

  function addKeyAt(channelIndex: number, event: ReactMouseEvent<SVGSVGElement>): void {
    const channel = channels[channelIndex];
    if (!channel) return;
    const time = clamp(pointerTime(event), timeStart, timeEnd);
    const componentCount = channel.keys[0]?.value.length ?? channel.colors.length;
    // Seed the new key from the current curve at this time, so adding never jumps the motion.
    const value = Array.from({ length: componentCount }, (_c, comp) => sampleComponent(channel.keys, comp, time));
    channel.onChange([...channel.keys, { time, value }].sort((a, b) => a.time - b.time));
  }

  function removeKey(channelIndex: number, keyIndex: number): void {
    const channel = channels[channelIndex];
    if (!channel) return;
    channel.onChange(channel.keys.filter((_, i) => i !== keyIndex));
  }

  const gridV = [0.25, 0.5, 0.75];
  return (
    <div ref={wrapRef} style={{ width: "100%", color: t.text, fontSize: 11 }}>
      <svg
        ref={svgRef}
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ display: "block", background: t.background, borderRadius: 6, overflow: "visible", touchAction: "none" }}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
        onDoubleClick={(e) => addKeyAt(0, e)}
      >
        {gridV.map((g) => (
          <line key={g} x1={px(lerp(xAxis.min, xAxis.max, g))} y1={0} x2={px(lerp(xAxis.min, xAxis.max, g))} y2={height} stroke={t.grid} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke={t.grid} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {playhead !== undefined && playhead >= xAxis.min && playhead <= xAxis.max ? (
          <line x1={px(playhead)} y1={0} x2={px(playhead)} y2={height} stroke={t.playhead} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        ) : null}
        {channels.map((channel, ci) =>
          channel.colors.map((color, comp) => {
            const path: string[] = [];
            for (let i = 0; i <= SAMPLES; i += 1) {
              const time = lerp(xAxis.min, xAxis.max, i / SAMPLES);
              path.push(`${i === 0 ? "M" : "L"}${px(time).toFixed(2)},${pyFor(ci, sampleComponent(channel.keys, comp, time)).toFixed(2)}`);
            }
            return <path key={`${channel.id}-${comp}`} d={path.join("")} fill="none" stroke={color} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />;
          })
        )}
        {channels.map((channel, ci) =>
          channel.keys.map((key, ki) =>
            channel.colors.map((color, comp) => (
              <circle
                key={`${channel.id}-${ki}-${comp}`}
                cx={px(key.time)}
                cy={pyFor(ci, key.value[comp] ?? 0)}
                r={4}
                fill={color}
                stroke={t.anchor}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: "grab" }}
                onPointerDown={(e) => startDrag({ channel: ci, keyIndex: ki, component: comp }, e)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  removeKey(ci, ki);
                }}
              />
            ))
          )
        )}
      </svg>
      <span style={{ color: "rgba(148,163,184,0.7)", fontSize: 10 }}>
        drag a point to move it · double-click to add · double-click a point to delete
      </span>
    </div>
  );
}
