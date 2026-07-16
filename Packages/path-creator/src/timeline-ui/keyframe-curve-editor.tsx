// Multi-curve keyframe editor: plots one or more channels of keyframes (each key a
// time + component vector, e.g. position x/y/z) as real-unit curves over a per-channel
// value axis, with a synced playhead. Direct manipulation: drag a key (time + that
// component's value), double-click to add, double-click a point to delete, drag tangent
// handles to shape per-axis easing. Controlled and host-agnostic; shares curve-canvas's
// coordinate/scaling primitives (its time/value key shape needs its own edit reducers).
import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { axisEasing, clamp, easingToCurve, evaluateEasing, lerp, type Easing } from "../core";
import { ANCHOR_EPSILON, makeScale, type Axis } from "./curve-canvas";

/** One keyframe: a time plus a component vector (e.g. [x, y, z]), a shared easing into it, and optional per-component easing. */
export interface CurveChannelKey { time: number; value: number[]; easing?: Easing; easingAxes?: Easing[] }

const DEFAULT_OUT = { x: 1 / 3, y: 1 / 3 };
const DEFAULT_IN = { x: 2 / 3, y: 2 / 3 };
type Point = { x: number; y: number };

/** The out (first-anchor) and in (last-anchor) bezier control points of an easing, in its 0..1 space. */
function easingControls(e: Easing): { out: Point; in: Point } {
  const curve = easingToCurve(e);
  return { out: curve.keys[0]!.out ?? DEFAULT_OUT, in: curve.keys[curve.keys.length - 1]!.in ?? DEFAULT_IN };
}

/** Return `e` as a curve with one control point replaced (out = segment start tangent, in = segment end tangent). */
function withControl(e: Easing, side: "out" | "in", cp: Point): Easing {
  const curve = easingToCurve(e);
  const keys = curve.keys.map((k) => ({ ...k, ...(k.out && { out: { ...k.out } }), ...(k.in && { in: { ...k.in } }) }));
  if (side === "out") keys[0]!.out = cp;
  else keys[keys.length - 1]!.in = cp;
  return { type: "curve", keys, ...(curve.space && { space: curve.space }) };
}

/** Set component `c`'s easing on a key, seeding the other components from the shared easing. */
function setKeyAxisEasing(key: CurveChannelKey, c: number, e: Easing, componentCount: number): CurveChannelKey {
  const fallback = key.easing ?? "linear";
  const axes: Easing[] = key.easingAxes ? [...key.easingAxes] : Array.from({ length: componentCount }, () => fallback);
  axes[c] = e;
  return { ...key, easingAxes: axes };
}

/** A named set of keyframes with per-component colors (and optional labels). */
export interface CurveChannel {
  id: string;
  colors: string[];
  componentLabels?: string[];
  keys: CurveChannelKey[];
  onChange: (keys: CurveChannelKey[]) => void;
  /**
   * Whether per-component tangent handles are editable (default true). Set false for
   * channels the runtime does not ease per-axis (e.g. rotation, which slerps with a
   * single shared easing) — otherwise dragged tangents would be silently discarded.
   */
  tangents?: boolean;
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
      const amount = span > 0 ? evaluateEasing((t - a.time) / span, axisEasing(b, comp)) : 1;
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
  // The selected keyframe component reveals its tangent handles; a handle drag reshapes
  // the adjacent segment's per-component easing.
  const [selected, setSelected] = useState<{ channel: number; keyIndex: number; component: number } | null>(null);
  const [handleDrag, setHandleDrag] = useState<{ channel: number; keyIndex: number; component: number; side: "in" | "out" } | null>(null);
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
  // One value scale per channel, computed once per render and reused across every
  // sampled curve point, anchor and pointer mapping (avoids per-point re-fitting).
  const valueScales = channels.map((_, ci) => makeScale(axisFor(ci), height));
  const pyFor = (ci: number, value: number): number => height - valueScales[ci]!.toPx(value);

  function pointerTime(event: { clientX: number }): number {
    return sx.toValue(event.clientX - svgRef.current!.getBoundingClientRect().left);
  }
  function pointerValue(event: { clientY: number }, ci: number): number {
    const rect = svgRef.current!.getBoundingClientRect();
    return valueScales[ci]!.toValue(rect.height - (event.clientY - rect.top));
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>): void {
    if (!svgRef.current) return;
    if (handleDrag) { moveHandle(event); return; }
    if (!drag) return;
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

  // Reshape the segment adjacent to the dragged handle by writing its per-component
  // easing: an "out" handle at key i shapes segment i->i+1 (target key i+1); an "in"
  // handle at key i shapes segment i-1->i (target key i). The dragged point maps into
  // the segment's normalized easing space (x along time, y along the value delta).
  function moveHandle(event: ReactPointerEvent<SVGSVGElement>): void {
    const hd = handleDrag!;
    const channel = channels[hd.channel];
    if (!channel) return;
    const keys = channel.keys;
    const c = hd.component;
    const leftIndex = hd.side === "out" ? hd.keyIndex : hd.keyIndex - 1;
    const a = keys[leftIndex];
    const b = keys[leftIndex + 1];
    if (!a || !b) return;
    const targetIndex = leftIndex + 1; // segment easing lives on the later key
    const dt = b.time - a.time;
    const dv = (b.value[c] ?? 0) - (a.value[c] ?? 0);
    const cur = easingControls(axisEasing(b, c));
    const cpx = dt > 0 ? clamp((pointerTime(event) - a.time) / dt, 0, 1) : (hd.side === "out" ? cur.out.x : cur.in.x);
    const baseY = hd.side === "out" ? cur.out.y : cur.in.y;
    const cpy = Math.abs(dv) > 1e-9 ? (pointerValue(event, hd.channel) - (a.value[c] ?? 0)) / dv : baseY;
    const nextEasing = withControl(axisEasing(b, c), hd.side, { x: cpx, y: cpy });
    const componentCount = keys[0]?.value.length ?? channel.colors.length;
    channel.onChange(keys.map((k, i) => (i === targetIndex ? setKeyAxisEasing(b, c, nextEasing, componentCount) : k)));
  }

  function startDrag(target: { channel: number; keyIndex: number; component: number }, event: ReactPointerEvent<SVGElement>): void {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSelected(target);
    setDrag({ ...target, yAxis: fitChannelAxis(channels[target.channel]!) });
  }

  function startHandleDrag(target: { channel: number; keyIndex: number; component: number; side: "in" | "out" }, event: ReactPointerEvent<SVGElement>): void {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setHandleDrag(target);
  }

  function addKeyAt(event: ReactMouseEvent<SVGSVGElement>): void {
    if (channels.length === 0 || !svgRef.current) return;
    const time = clamp(pointerTime(event), timeStart, timeEnd);
    // Add to the channel whose curve is nearest the click (not always channel 0).
    const clickY = event.clientY - svgRef.current.getBoundingClientRect().top;
    let best = 0;
    let bestDist = Infinity;
    channels.forEach((ch, ci) => {
      ch.colors.forEach((_c, comp) => {
        const dist = Math.abs(pyFor(ci, sampleComponent(ch.keys, comp, time)) - clickY);
        if (dist < bestDist) { bestDist = dist; best = ci; }
      });
    });
    const channel = channels[best]!;
    // One key per time, matching core insertTransformKey — no duplicate-time keys.
    if (channel.keys.some((k) => Math.abs(k.time - time) < 1e-6)) return;
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
        onPointerUp={() => { setDrag(null); setHandleDrag(null); }}
        onPointerLeave={() => { setDrag(null); setHandleDrag(null); }}
        onDoubleClick={(e) => addKeyAt(e)}
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
        {(() => {
          if (!selected) return null;
          const ch = channels[selected.channel];
          const key = ch?.keys[selected.keyIndex];
          if (!ch || !key || ch.tangents === false) return null;
          const ci = selected.channel;
          const c = selected.component;
          const color = ch.colors[c] ?? t.anchor;
          const handles: { side: "in" | "out"; x: number; y: number }[] = [];
          if (selected.keyIndex < ch.keys.length - 1) {
            const b = ch.keys[selected.keyIndex + 1]!;
            const ctrl = easingControls(axisEasing(b, c)).out;
            handles.push({ side: "out", x: px(lerp(key.time, b.time, ctrl.x)), y: pyFor(ci, lerp(key.value[c] ?? 0, b.value[c] ?? 0, ctrl.y)) });
          }
          if (selected.keyIndex > 0) {
            const a = ch.keys[selected.keyIndex - 1]!;
            const ctrl = easingControls(axisEasing(key, c)).in;
            handles.push({ side: "in", x: px(lerp(a.time, key.time, ctrl.x)), y: pyFor(ci, lerp(a.value[c] ?? 0, key.value[c] ?? 0, ctrl.y)) });
          }
          const ax = px(key.time);
          const ay = pyFor(ci, key.value[c] ?? 0);
          return (
            <g>
              {handles.map((h) => (
                <g key={h.side}>
                  <line x1={ax} y1={ay} x2={h.x} y2={h.y} stroke={color} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  <circle cx={h.x} cy={h.y} r={3.5} fill={t.background} stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke"
                    style={{ cursor: "grab" }}
                    onPointerDown={(e) => startHandleDrag({ channel: ci, keyIndex: selected.keyIndex, component: c, side: h.side }, e)} />
                </g>
              ))}
            </g>
          );
        })()}
      </svg>
      <span style={{ color: "rgba(148,163,184,0.7)", fontSize: 10 }}>
        drag a point to move it · select a point for its tangent handles · double-click to add / delete
      </span>
    </div>
  );
}
