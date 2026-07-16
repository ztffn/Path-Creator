// Multi-curve keyframe editor: plots one or more channels of keyframes (each key a
// time + component vector, e.g. position x/y/z) as real-unit curves over a per-channel
// value axis, with a synced playhead. Direct manipulation: drag a key (time + that
// component's value), double-click to add / delete, drag tangent handles that are real 2D
// cubic-bezier control points (shared core sampler, so the graph matches playback),
// shift-click / box-select for multi-key time-shifts, Delete to remove, optional snapping.
import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { clamp, lerp, transformComponentAt, type AxisTangent, type Easing } from "../core";
import { ANCHOR_EPSILON, makeScale, type Axis } from "./curve-canvas";

/** One keyframe: a time plus a component vector (e.g. [x, y, z]), a shared easing, and optional per-component bezier tangents. */
export interface CurveChannelKey { time: number; value: number[]; easing?: Easing; tangentsAxes?: (AxisTangent | undefined)[] }

type Offset = [number, number];

/** Straight (1/3-chord) out tangent offset from key `a` toward the next key `b`. */
function defaultOut(a: CurveChannelKey, b: CurveChannelKey, comp: number): Offset {
  return [(b.time - a.time) / 3, ((b.value[comp] ?? 0) - (a.value[comp] ?? 0)) / 3];
}
/** Straight (1/3-chord) in tangent offset for key `b` back toward the previous key `a` (the negated out tangent). */
function defaultIn(a: CurveChannelKey, b: CurveChannelKey, comp: number): Offset {
  const [dt, dv] = defaultOut(a, b, comp);
  return [-dt, -dv];
}
/** The stored tangent-handle offset (Δtime, Δvalue) for key `i` side `side`, or its straight default. */
function handleOffset(keys: CurveChannelKey[], i: number, side: "in" | "out", comp: number): Offset {
  const explicit = keys[i]?.tangentsAxes?.[comp]?.[side];
  if (explicit) return explicit;
  return side === "out" ? defaultOut(keys[i]!, keys[i + 1]!, comp) : defaultIn(keys[i - 1]!, keys[i]!, comp);
}
/** Return a copy of `key` with component `comp`'s tangent handle(s) merged from `patch`. */
function withTangents(key: CurveChannelKey, comp: number, patch: Partial<AxisTangent>, componentCount: number): CurveChannelKey {
  const axes: (AxisTangent | undefined)[] = key.tangentsAxes
    ? key.tangentsAxes.map((a) => (a ? { ...a } : undefined))
    : Array.from({ length: componentCount }, () => undefined);
  axes[comp] = { ...(axes[comp] ?? {}), ...patch };
  return { ...key, tangentsAxes: axes };
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
   * channels the runtime does not bezier per-axis (e.g. rotation, which slerps with a
   * single shared easing) — otherwise dragged tangents would be silently discarded.
   */
  tangents?: boolean;
  /**
   * SVG stroke-dasharray for this channel's curves (e.g. "5 4"). Lets sibling channels
   * that reuse the same per-axis colors (position/rotation/scale all red/green/blue) stay
   * distinguishable when shown together. Undefined = solid.
   */
  dash?: string;
  /** Short label shown in the value readout (e.g. "position"); falls back to id. */
  label?: string;
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

const SAMPLES = 64;
const PAD_FRACTION = 0.1;
const FIT_SAMPLES = 32;

/** Value of `keys` component `comp` at time `t` (shared with the runtime evaluator). */
const sampleComponent = (keys: CurveChannelKey[], comp: number, t: number): number => transformComponentAt(keys, comp, t);

/**
 * Auto-fit value range across one channel — including the sampled curve between keys, so
 * bezier bulges/overshoots stay on-screen — padded so curves don't touch the edges.
 */
function fitChannelAxis(channel: CurveChannel): Axis {
  let min = Infinity;
  let max = -Infinity;
  const acc = (v: number): void => { if (v < min) min = v; if (v > max) max = v; };
  const keys = channel.keys;
  for (const key of keys) for (const v of key.value) acc(v);
  if (keys.length >= 2) {
    const t0 = keys[0]!.time;
    const t1 = keys[keys.length - 1]!.time;
    const comps = keys[0]!.value.length;
    for (let c = 0; c < comps; c += 1) for (let i = 0; i <= FIT_SAMPLES; i += 1) acc(sampleComponent(keys, c, lerp(t0, t1, i / FIT_SAMPLES)));
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -1, max: 1 };
  if (max - min < 1e-9) return { min: min - 1, max: max + 1 };
  const pad = (max - min) * PAD_FRACTION;
  return { min: min - pad, max: max + pad };
}

/** A single-anchor drag; `multi` shifts all `orig` keys in time together, clamped to [dLo, dHi]. */
type Drag = { channel: number; keyIndex: number; component: number; yAxis: Axis; multi: boolean; startTime: number; orig: { i: number; time: number }[]; dLo: number; dHi: number };
type HandleDrag = { channel: number; keyIndex: number; component: number; side: "in" | "out"; yAxis: Axis };
/** The primary selection (drives tangent handles + readout): a specific component of one key. */
type Primary = { channelId: string; keyIndex: number; component: number };

export function KeyframeCurveEditor({
  channels,
  timeStart,
  timeEnd,
  playhead,
  height = 160,
  theme,
  snap
}: {
  channels: CurveChannel[];
  timeStart: number;
  timeEnd: number;
  playhead?: number;
  height?: number;
  theme?: KeyframeCurveEditorTheme;
  /** Snap step (seconds) for dragged / added key times; hold Alt to bypass. Undefined = no snapping. */
  snap?: number;
}) {
  const t = { ...DEFAULT_THEME, ...theme };
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(280);
  const [drag, setDrag] = useState<Drag | null>(null);
  // The selected keyframe component reveals its tangent handles; a handle drag reshapes
  // the adjacent segment(s) by writing this key's per-component cubic-bezier tangents.
  const [selected, setSelected] = useState<Primary | null>(null);
  // Multi-key selection, scoped to ONE channel (so every edit is a single channel.onChange
  // and never races the host's per-channel state). Keyed by channel id + key index so it
  // survives the `channels` array reindexing when the host toggles which channels show.
  const [selChannel, setSelChannel] = useState<string | null>(null);
  const [selKeys, setSelKeys] = useState<Set<number>>(new Set());
  const [handleDrag, setHandleDrag] = useState<HandleDrag | null>(null);
  // Box-select rectangle in svg-local pixels; `additive` keeps the prior selection.
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number; additive: boolean } | null>(null);
  // Hovered anchor, for the live readout (falls back to the primary selection).
  const [hover, setHover] = useState<Primary | null>(null);
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
  const axisFor = (ci: number): Axis => {
    if (drag && drag.channel === ci) return drag.yAxis;
    if (handleDrag && handleDrag.channel === ci) return handleDrag.yAxis;
    return fitChannelAxis(channels[ci]!);
  };
  // One value scale per channel, computed once per render and reused across every
  // sampled curve point, anchor and pointer mapping (avoids per-point re-fitting).
  const valueScales = channels.map((_, ci) => makeScale(axisFor(ci), height));
  const pyFor = (ci: number, value: number): number => height - valueScales[ci]!.toPx(value);
  const selCi = selChannel === null ? -1 : channels.findIndex((c) => c.id === selChannel);
  const isSelected = (ci: number, ki: number): boolean => ci === selCi && selKeys.has(ki);

  const snapTime = (time: number, alt: boolean): number => (snap && snap > 0 && !alt ? Math.round(time / snap) * snap : time);
  const svgPoint = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  function pointerTime(event: { clientX: number }): number {
    return sx.toValue(event.clientX - svgRef.current!.getBoundingClientRect().left);
  }
  function pointerValue(event: { clientY: number }, ci: number): number {
    const rect = svgRef.current!.getBoundingClientRect();
    return valueScales[ci]!.toValue(rect.height - (event.clientY - rect.top));
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>): void {
    if (!svgRef.current) return;
    if (box) { const p = svgPoint(event); setBox({ ...box, x1: p.x, y1: p.y }); return; }
    if (handleDrag) { moveHandle(event); return; }
    if (!drag) return;
    const channel = channels[drag.channel];
    if (!channel) return;
    const keys = channel.keys;
    if (drag.multi) {
      // Shift every selected key by one clamped time delta; values untouched (retiming).
      const delta = clamp(snapTime(pointerTime(event), event.altKey) - drag.startTime, drag.dLo, drag.dHi);
      const moved = new Map(drag.orig.map((o) => [o.i, o.time + delta]));
      channel.onChange(keys.map((k, i) => (moved.has(i) ? { ...k, time: moved.get(i)! } : k)));
      return;
    }
    const loT = drag.keyIndex > 0 ? keys[drag.keyIndex - 1]!.time + ANCHOR_EPSILON : timeStart;
    const hiT = drag.keyIndex < keys.length - 1 ? keys[drag.keyIndex + 1]!.time - ANCHOR_EPSILON : timeEnd;
    const nextTime = clamp(snapTime(pointerTime(event), event.altKey), loT, hiT);
    const nextValue = pointerValue(event, drag.channel);
    const next = keys.map((k, i) => {
      if (i !== drag.keyIndex) return k;
      const value = [...k.value];
      value[drag.component] = nextValue;
      return { ...k, time: nextTime, value };
    });
    channel.onChange(next);
  }

  // Reshape by writing key i's per-component cubic-bezier tangent handle: the "out" handle
  // shapes the segment to the next key, "in" the segment from the previous key. Handles are
  // real (time, value) control points; the drag offset is clamped inside its segment so the
  // curve stays a function of time. Interior keys keep aligned (G1) tangent continuity: the
  // opposite handle is rotated collinear at its OWN length (direction shared, not magnitude —
  // this is G1, not C1), rescaled if its time-clamp bites.
  function moveHandle(event: ReactPointerEvent<SVGSVGElement>): void {
    const hd = handleDrag!;
    const channel = channels[hd.channel];
    if (!channel) return;
    const keys = channel.keys;
    const i = hd.keyIndex;
    const c = hd.component;
    const key = keys[i];
    if (!key) return;
    const prev = keys[i - 1];
    const next = keys[i + 1];
    let dt = pointerTime(event) - key.time;
    const dv = pointerValue(event, hd.channel) - (key.value[c] ?? 0);
    if (hd.side === "out") { if (!next) return; dt = clamp(dt, 0, next.time - key.time); }
    else { if (!prev) return; dt = clamp(dt, prev.time - key.time, 0); }
    const patch: Partial<AxisTangent> = { [hd.side]: [dt, dv] as Offset };
    if (prev && next) {
      const opp = hd.side === "out" ? "in" : "out";
      const cur = handleOffset(keys, i, opp, c);
      const oppLen = Math.hypot(cur[0], cur[1]);
      const mag = Math.hypot(dt, dv) || 1e-6;
      const ox = -(dt / mag) * oppLen;
      let oy = -(dv / mag) * oppLen;
      const loDt = opp === "out" ? 0 : prev.time - key.time;
      const hiDt = opp === "out" ? next.time - key.time : 0;
      const cx = clamp(ox, loDt, hiDt);
      if (cx !== ox && Math.abs(ox) > 1e-9) oy = oy * (cx / ox);
      patch[opp] = [cx, oy];
    }
    const componentCount = keys[0]?.value.length ?? channel.colors.length;
    channel.onChange(keys.map((k, idx) => (idx === i ? withTangents(k, c, patch, componentCount) : k)));
  }

  // Allowed time-shift range for a multi-key drag: no selected key may cross a
  // non-selected neighbor (or the time bounds); selected neighbors move together.
  function multiDeltaBounds(ci: number, indices: number[]): { dLo: number; dHi: number } {
    const keys = channels[ci]!.keys;
    const sel = new Set(indices);
    let dLo = -Infinity;
    let dHi = Infinity;
    for (const i of indices) {
      const time = keys[i]!.time;
      if (i > 0 && !sel.has(i - 1)) dLo = Math.max(dLo, keys[i - 1]!.time + ANCHOR_EPSILON - time);
      else if (i === 0) dLo = Math.max(dLo, timeStart - time);
      if (i < keys.length - 1 && !sel.has(i + 1)) dHi = Math.min(dHi, keys[i + 1]!.time - ANCHOR_EPSILON - time);
      else if (i === keys.length - 1) dHi = Math.min(dHi, timeEnd - time);
    }
    return { dLo, dHi };
  }

  function startDrag(target: { channel: number; keyIndex: number; component: number }, event: ReactPointerEvent<SVGElement>): void {
    event.stopPropagation();
    svgRef.current?.focus?.();
    const id = channels[target.channel]!.id;
    const primary: Primary = { channelId: id, keyIndex: target.keyIndex, component: target.component };
    if (event.shiftKey) {
      // Toggle membership; switching channel resets the selection to the clicked channel.
      setSelChannel(id);
      setSelKeys((prev) => {
        const next = selChannel === id ? new Set(prev) : new Set<number>();
        if (next.has(target.keyIndex)) next.delete(target.keyIndex); else next.add(target.keyIndex);
        return next;
      });
      setSelected(primary);
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const alreadyMulti = selChannel === id && selKeys.has(target.keyIndex) && selKeys.size > 1;
    const indices = alreadyMulti ? [...selKeys] : [target.keyIndex];
    if (!alreadyMulti) { setSelChannel(id); setSelKeys(new Set([target.keyIndex])); }
    setSelected(primary);
    const bounds = multiDeltaBounds(target.channel, indices);
    setDrag({
      ...target,
      yAxis: fitChannelAxis(channels[target.channel]!),
      multi: indices.length > 1,
      startTime: snapTime(pointerTime(event), event.altKey),
      orig: indices.map((i) => ({ i, time: channels[target.channel]!.keys[i]!.time })),
      ...bounds
    });
  }

  function startHandleDrag(target: { channel: number; keyIndex: number; component: number; side: "in" | "out" }, event: ReactPointerEvent<SVGElement>): void {
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setHandleDrag({ ...target, yAxis: fitChannelAxis(channels[target.channel]!) });
  }

  // A press on empty canvas starts a box-select (shift keeps the prior selection).
  function onCanvasPointerDown(event: ReactPointerEvent<SVGSVGElement>): void {
    if (event.target !== svgRef.current) return;
    svgRef.current?.focus?.();
    const p = svgPoint(event);
    svgRef.current.setPointerCapture?.(event.pointerId);
    setBox({ x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: event.shiftKey });
    if (!event.shiftKey) { setSelChannel(null); setSelKeys(new Set()); setSelected(null); }
  }

  // Finalize a box-select: keep the channel with the most enclosed keys (single-channel
  // selection invariant); an anchor counts if any of its component dots is inside the box.
  function commitBox(): void {
    if (!box) return;
    const minX = Math.min(box.x0, box.x1);
    const maxX = Math.max(box.x0, box.x1);
    const minY = Math.min(box.y0, box.y1);
    const maxY = Math.max(box.y0, box.y1);
    const perChannel = new Map<string, Set<number>>();
    channels.forEach((ch, ci) => {
      ch.keys.forEach((key, ki) => {
        const inside = ch.colors.some((_c, comp) => {
          const cx = px(key.time);
          const cy = pyFor(ci, key.value[comp] ?? 0);
          return cx >= minX && cx <= maxX && cy >= minY && cy <= maxY;
        });
        if (inside) {
          if (!perChannel.has(ch.id)) perChannel.set(ch.id, new Set());
          perChannel.get(ch.id)!.add(ki);
        }
      });
    });
    let bestId: string | null = null;
    let best = new Set<number>();
    perChannel.forEach((set, id) => { if (set.size > best.size) { best = set; bestId = id; } });
    if (bestId) {
      if (box.additive && selChannel === bestId) setSelKeys((prev) => new Set([...prev, ...best]));
      else { setSelChannel(bestId); setSelKeys(best); }
    }
    setBox(null);
  }

  function endGesture(): void {
    if (box) { commitBox(); return; }
    setDrag(null);
    setHandleDrag(null);
  }

  function onKeyDown(event: ReactKeyboardEvent<SVGSVGElement>): void {
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    if (selCi < 0 || selKeys.size === 0) return;
    event.preventDefault();
    const channel = channels[selCi]!;
    channel.onChange(channel.keys.filter((_, i) => !selKeys.has(i)));
    setSelChannel(null);
    setSelKeys(new Set());
    setSelected(null);
  }

  function addKeyAt(event: ReactMouseEvent<SVGSVGElement>): void {
    if (channels.length === 0 || !svgRef.current) return;
    const time = clamp(snapTime(pointerTime(event), event.altKey), timeStart, timeEnd);
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
    const next = [...channel.keys, { time, value }].sort((a, b) => a.time - b.time);
    channel.onChange(next);
    // Select the new key so its readout / handles are immediately available.
    const newIndex = next.findIndex((k) => k.time === time);
    setSelChannel(channel.id);
    setSelKeys(new Set([newIndex]));
    setSelected({ channelId: channel.id, keyIndex: newIndex, component: 0 });
  }

  function removeKey(channelIndex: number, keyIndex: number): void {
    const channel = channels[channelIndex];
    if (!channel) return;
    channel.onChange(channel.keys.filter((_, i) => i !== keyIndex));
    // Deleting shifts every later index, so the index-based multi-selection is now stale —
    // clear it rather than leave Delete/highlight pointing at the wrong keyframes.
    setSelChannel(null);
    setSelKeys(new Set());
    setSelected(null);
  }

  const gridV = [0.25, 0.5, 0.75];
  // The readout tracks the hovered anchor, falling back to the primary selection.
  const readout = (() => {
    const target = hover ?? selected;
    if (!target) return null;
    const ci = channels.findIndex((c) => c.id === target.channelId);
    const key = channels[ci]?.keys[target.keyIndex];
    if (!key) return null;
    const ch = channels[ci]!;
    const labels = ch.componentLabels ?? key.value.map((_v, i) => `#${i}`);
    return {
      name: ch.label ?? ch.id,
      time: key.time,
      parts: key.value.map((v, i) => ({ label: labels[i] ?? `#${i}`, value: v, active: i === target.component }))
    };
  })();

  return (
    <div ref={wrapRef} style={{ width: "100%", color: t.text, fontSize: 11, position: "relative" }}>
      {readout ? (
        <div style={{ position: "absolute", top: 4, left: 6, pointerEvents: "none", fontSize: 10, fontVariantNumeric: "tabular-nums", background: "rgba(2,6,23,0.7)", padding: "2px 6px", borderRadius: 4, whiteSpace: "nowrap", zIndex: 1 }}>
          <span style={{ opacity: 0.7 }}>{readout.name}</span>
          <span style={{ margin: "0 6px" }}>t {readout.time.toFixed(2)}s</span>
          {readout.parts.map((p) => (
            <span key={p.label} style={{ marginRight: 6, opacity: p.active ? 1 : 0.55, fontWeight: p.active ? 600 : 400 }}>
              {p.label} {p.value.toFixed(2)}
            </span>
          ))}
        </div>
      ) : null}
      <svg
        ref={svgRef}
        tabIndex={0}
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ display: "block", background: t.background, borderRadius: 6, overflow: "visible", touchAction: "none", outline: "none" }}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerLeave={() => { endGesture(); setHover(null); }}
        onKeyDown={onKeyDown}
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
            return <path key={`${channel.id}-${comp}`} d={path.join("")} fill="none" stroke={color} strokeWidth={1.75} {...(channel.dash && { strokeDasharray: channel.dash })} vectorEffect="non-scaling-stroke" />;
          })
        )}
        {channels.map((channel, ci) =>
          channel.keys.map((key, ki) =>
            channel.colors.map((color, comp) => {
              const sel = isSelected(ci, ki);
              return (
                <circle
                  key={`${channel.id}-${ki}-${comp}`}
                  cx={px(key.time)}
                  cy={pyFor(ci, key.value[comp] ?? 0)}
                  r={sel ? 5 : 4}
                  fill={color}
                  stroke={sel ? t.playhead : t.anchor}
                  strokeWidth={sel ? 2 : 1}
                  vectorEffect="non-scaling-stroke"
                  style={{ cursor: "grab" }}
                  onPointerDown={(e) => startDrag({ channel: ci, keyIndex: ki, component: comp }, e)}
                  onPointerEnter={() => { if (!drag && !box && !handleDrag) setHover({ channelId: channel.id, keyIndex: ki, component: comp }); }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    removeKey(ci, ki);
                  }}
                />
              );
            })
          )
        )}
        {(() => {
          if (!selected || selKeys.size > 1) return null;
          const ci = channels.findIndex((c) => c.id === selected.channelId);
          const ch = channels[ci];
          const key = ch?.keys[selected.keyIndex];
          if (!ch || !key || ch.tangents === false) return null;
          const c = selected.component;
          const color = ch.colors[c] ?? t.anchor;
          const handles: { side: "in" | "out"; x: number; y: number }[] = [];
          // Clamp the handle's time into its segment for rendering — matching the sampler's
          // clamp in bezierComponent — so a handle whose neighbor later moved closer still
          // draws on the curve it controls instead of past the neighbor.
          if (selected.keyIndex < ch.keys.length - 1) {
            const next = ch.keys[selected.keyIndex + 1]!;
            const [dt, dv] = handleOffset(ch.keys, selected.keyIndex, "out", c);
            handles.push({ side: "out", x: px(clamp(key.time + dt, key.time, next.time)), y: pyFor(ci, (key.value[c] ?? 0) + dv) });
          }
          if (selected.keyIndex > 0) {
            const prev = ch.keys[selected.keyIndex - 1]!;
            const [dt, dv] = handleOffset(ch.keys, selected.keyIndex, "in", c);
            handles.push({ side: "in", x: px(clamp(key.time + dt, prev.time, key.time)), y: pyFor(ci, (key.value[c] ?? 0) + dv) });
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
        {box ? (
          <rect x={Math.min(box.x0, box.x1)} y={Math.min(box.y0, box.y1)} width={Math.abs(box.x1 - box.x0)} height={Math.abs(box.y1 - box.y0)}
            fill="rgba(249,115,22,0.1)" stroke={t.playhead} strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        ) : null}
      </svg>
      <span style={{ color: "rgba(148,163,184,0.7)", fontSize: 10 }}>
        drag to move · select a point for its curve handles · shift-click or box-select for many · Delete removes · double-click to add
      </span>
    </div>
  );
}
