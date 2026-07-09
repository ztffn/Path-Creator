// Reusable easing curve editor: a preset picker plus a full-control multi-anchor
// curve canvas (add/drag/delete points and cubic-bezier tangent handles) with a live
// speed overlay (the derivative — what the movement actually does). Controlled: takes
// an Easing value, emits the next one; knows nothing about carts or the demo. The
// block sparkline (block-series.tsx) is the read-only preview; this is the author UI.
import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  EASING_PRESETS,
  clamp,
  convertEasingCurveSpace,
  easingToCurve,
  evaluateEasing,
  isEasingCurve,
  lerp,
  sampleEasingCurve,
  sampleEasingDerivative,
  tangentHandles,
  type Easing,
  type EasingCurve,
  type EasingCurveKey,
  type EasingPreset,
  type EasingPoint,
  type TangentMode
} from "../core";

/** Minimal color surface so a host can match its panel; all optional. */
export interface EasingEditorTheme {
  background?: string;
  grid?: string;
  reference?: string;
  curve?: string;
  speed?: string;
  handle?: string;
  anchor?: string;
  text?: string;
}

const DEFAULT_THEME: Required<EasingEditorTheme> = {
  background: "rgba(15, 23, 42, 0.6)",
  grid: "rgba(148, 163, 184, 0.18)",
  reference: "rgba(148, 163, 184, 0.3)",
  curve: "rgba(249, 115, 22, 0.95)",
  speed: "rgba(56, 189, 248, 0.55)",
  handle: "rgba(56, 189, 248, 0.9)",
  anchor: "rgba(226, 232, 240, 0.95)",
  text: "#cbd5e1"
};

const LEGACY = new Set<EasingPreset>(["cut", "linear", "easeIn", "easeOut", "easeInOut", "hardIn", "hardOut"]);
const PRESET_NAMES = Object.keys(EASING_PRESETS) as EasingPreset[];
const STANDARD_PRESETS = PRESET_NAMES.filter((n) => !LEGACY.has(n));
const LEGACY_PRESETS = PRESET_NAMES.filter((n) => LEGACY.has(n));
const SAMPLES = 40;

// Effective control points: the explicit handle, or the default 1/3-chord point the
// evaluator uses when a handle is absent — so every anchor shows a grabbable handle.
const effOut = (keys: EasingCurveKey[], i: number): EasingPoint =>
  keys[i].out ?? { x: lerp(keys[i].x, keys[i + 1].x, 1 / 3), y: lerp(keys[i].y, keys[i + 1].y, 1 / 3) };
const effIn = (keys: EasingCurveKey[], i: number): EasingPoint =>
  keys[i].in ?? { x: lerp(keys[i - 1].x, keys[i].x, 2 / 3), y: lerp(keys[i - 1].y, keys[i].y, 2 / 3) };

const cloneKeys = (keys: EasingCurveKey[]): EasingCurveKey[] =>
  keys.map((k) => ({ ...k, ...(k.out && { out: { ...k.out } }), ...(k.in && { in: { ...k.in } }) }));

/**
 * Enforce an interior anchor's tangent mode by setting the handle opposite `refSide`
 * from the reference handle: "mirror" makes it the exact opposite, "aligned" keeps it
 * collinear at its own length. Opposite-x is clamped to its segment (curve must stay a
 * function of x), staying collinear by recomputing y. "free" leaves it untouched.
 */
function relink(keys: EasingCurveKey[], index: number, refSide: "out" | "in", mode: TangentMode): void {
  if (mode === "free") return;
  const key = keys[index];
  const prev = keys[index - 1];
  const next = keys[index + 1];
  if (!prev || !next) return;
  const eff = (side: "out" | "in"): EasingPoint => (side === "out" ? effOut(keys, index) : effIn(keys, index));
  const oppSide = refSide === "out" ? "in" : "out";
  const ref = eff(refSide);
  const oppLoX = oppSide === "out" ? key.x : prev.x;
  const oppHiX = oppSide === "out" ? next.x : key.x;
  const vx = ref.x - key.x;
  const vy = ref.y - key.y;
  let ox: number;
  let oy: number;
  if (mode === "mirror") {
    ox = -vx;
    oy = -vy;
  } else {
    const curr = eff(oppSide);
    const curLen = Math.hypot(curr.x - key.x, curr.y - key.y);
    const vlen = Math.hypot(vx, vy) || 1e-6;
    ox = (-vx / vlen) * curLen;
    oy = (-vy / vlen) * curLen;
  }
  const hx = key.x + ox;
  let hy = key.y + oy;
  const cx = clamp(hx, oppLoX, oppHiX);
  if (cx !== hx && Math.abs(ox) > 1e-9) hy = key.y + oy * ((cx - key.x) / ox);
  const opp = { x: cx, y: clamp(hy, -0.5, 1.5) };
  if (oppSide === "out") key.out = opp;
  else key.in = opp;
}

type DragTarget = { kind: "anchor" | "out" | "in"; index: number };

/** Flat full-value curve — the reset/seed for a "value" (automation) editor. */
const FLAT_ONE: EasingCurve = { type: "curve", keys: [{ x: 0, y: 1 }, { x: 1, y: 1 }] };

export function EasingEditor({
  value,
  onChange,
  theme,
  height = 150,
  mode = "easing",
  backdrop
}: {
  value: Easing;
  onChange: (next: Easing) => void;
  theme?: EasingEditorTheme;
  /** Canvas height in px; width fills the container. */
  height?: number;
  /**
   * "easing" (default): interpolation curve — position endpoints pinned to 0/1, a
   * position/speed toggle, and a derivative overlay. "value": a raw automation curve
   * (e.g. a volume envelope) — free endpoints, no toggle/overlay, value read directly.
   */
  mode?: "easing" | "value";
  /** Optional faint waveform drawn behind the curve (flat [min,max,…] peaks in -1..1). */
  backdrop?: number[];
}) {
  const valueMode = mode === "value";
  const t = { ...DEFAULT_THEME, ...theme };
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragTarget | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [width, setWidth] = useState(240);
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
  const px = (x: number): number => x * width;
  const py = (y: number): number => height - y * height;
  // Volume/automation stays within [0,1]; easing curves allow mild over/undershoot.
  const yLo = valueMode ? 0 : -0.5;
  const yHi = valueMode ? 1 : 1.5;

  // The editable working curve (only when the value is a custom curve; presets preview).
  const editing = isEasingCurve(value) ? value : null;
  const speedMode = editing?.space === "speed";

  // Solid = the curve being edited (raw geometry). Dashed = the derived other graph:
  // in position mode the speed (derivative); in speed mode the resulting position.
  const editablePath: string[] = [];
  const overlayPath: string[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const x = i / SAMPLES;
    const solidY = editing ? sampleEasingCurve(editing, x) : evaluateEasing(x, value);
    editablePath.push(`${i === 0 ? "M" : "L"}${px(x).toFixed(2)},${py(solidY).toFixed(2)}`);
  }
  // Value mode has no derived overlay. Otherwise: position mode shows the speed
  // (normalized derivative); speed mode shows the resulting position (already 0..1).
  if (valueMode) {
    // no overlay
  } else if (speedMode) {
    for (let i = 0; i <= SAMPLES; i++) {
      const x = i / SAMPLES;
      overlayPath.push(`${i === 0 ? "M" : "L"}${px(x).toFixed(2)},${py(evaluateEasing(x, value)).toFixed(2)}`);
    }
  } else {
    const deriv = sampleEasingDerivative(value, SAMPLES).map(Math.abs);
    const max = Math.max(1e-6, ...deriv);
    deriv.forEach((d, i) => overlayPath.push(`${i === 0 ? "M" : "L"}${px(i / SAMPLES).toFixed(2)},${py(d / max).toFixed(2)}`));
  }

  // Optional waveform backdrop: a faint centered envelope (peaks in -1..1), so a volume
  // curve can be drawn against the audio it shapes.
  let backdropD = "";
  if (backdrop && backdrop.length >= 4) {
    const n = Math.floor(backdrop.length / 2);
    const top: string[] = [];
    const bottom: string[] = [];
    for (let i = 0; i < n; i++) {
      const x = n > 1 ? i / (n - 1) : 0;
      top.push(`${i === 0 ? "M" : "L"}${px(x).toFixed(2)},${py(0.5 + backdrop[i * 2 + 1] * 0.45).toFixed(2)}`);
      const j = n - 1 - i;
      bottom.push(`L${px((n > 1 ? j / (n - 1) : 0)).toFixed(2)},${py(0.5 + backdrop[j * 2] * 0.45).toFixed(2)}`);
    }
    backdropD = `${top.join("")}${bottom.join("")}Z`;
  }

  function commit(keys: EasingCurveKey[]): void {
    onChange({ type: "curve", keys, ...(editing?.space && { space: editing.space }) });
  }

  function setSpace(target: "position" | "speed"): void {
    if (!editing || (editing.space ?? "position") === target) return;
    setSelected(null);
    onChange(convertEasingCurveSpace(editing, target));
  }

  function pointerToNorm(event: { clientX: number; clientY: number }): EasingPoint {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: 1 - (event.clientY - rect.top) / rect.height };
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>): void {
    if (!drag || !editing || !svgRef.current) return;
    const p = pointerToNorm(event);
    const keys = cloneKeys(editing.keys);
    const key = keys[drag.index];
    if (drag.kind === "anchor") {
      const isFirst = drag.index === 0;
      const isLast = drag.index === keys.length - 1;
      const isEnd = isFirst || isLast;
      const nx = isFirst ? 0 : isLast ? 1 : clamp(p.x, keys[drag.index - 1].x + 1e-3, keys[drag.index + 1].x - 1e-3);
      // Easing position endpoints are pinned to (0,0)/(1,1): easing must map 0->0 and 1->1
      // or the cart stops short of the next key and the segment snaps. Speed space (integral
      // normalized) and value mode (raw automation, e.g. volume fades) leave endpoints free.
      const ny = isEnd && !speedMode && !valueMode ? (isFirst ? 0 : 1) : clamp(p.y, yLo, yHi);
      const dx = nx - key.x;
      const dy = ny - key.y;
      key.x = nx;
      key.y = ny;
      if (key.out) key.out = { x: key.out.x + dx, y: key.out.y + dy };
      if (key.in) key.in = { x: key.in.x + dx, y: key.in.y + dy };
    } else {
      const side = drag.kind;
      const loX = side === "out" ? key.x : keys[drag.index - 1]!.x;
      const hiX = side === "out" ? keys[drag.index + 1]!.x : key.x;
      const h = { x: clamp(p.x, loX, hiX), y: clamp(p.y, yLo, yHi) };
      if (side === "out") key.out = h;
      else key.in = h;
      if (drag.index > 0 && drag.index < keys.length - 1) relink(keys, drag.index, side, key.tangent ?? "aligned");
    }
    commit(keys);
  }

  function startDrag(target: DragTarget, event: ReactPointerEvent<SVGElement>): void {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSelected(target.index);
    setDrag(target);
  }

  function addAnchorAt(event: ReactMouseEvent<SVGSVGElement>): void {
    if (!editing) return;
    const p = pointerToNorm(event);
    const nx = clamp(p.x, 1e-3, 1 - 1e-3);
    const ny = clamp(p.y, -0.5, 1.5);
    // Seed smooth tangent handles from the local slope through the bracketing anchors,
    // so a fresh point has grabbable control points and isn't a hard corner.
    const sorted = [...editing.keys].sort((a, b) => a.x - b.x);
    let lo = sorted[0];
    let hi = sorted[sorted.length - 1];
    for (let i = 0; i + 1 < sorted.length; i++) {
      if (sorted[i].x <= nx && nx <= sorted[i + 1].x) {
        lo = sorted[i];
        hi = sorted[i + 1];
        break;
      }
    }
    const key: EasingCurveKey = { x: nx, y: ny, ...tangentHandles({ x: nx, y: ny }, lo, hi) };
    setSelected(editing.keys.filter((k) => k.x < nx).length);
    commit([...editing.keys, key].sort((a, b) => a.x - b.x));
  }

  function removeAnchor(index: number): void {
    if (!editing || index <= 0 || index >= editing.keys.length - 1) return;
    setSelected(null);
    commit(editing.keys.filter((_, i) => i !== index));
  }

  function setTangentMode(mode: TangentMode): void {
    if (!editing || selected === null || selected <= 0 || selected >= editing.keys.length - 1) return;
    const keys = cloneKeys(editing.keys);
    keys[selected].tangent = mode;
    relink(keys, selected, "out", mode);
    commit(keys);
  }

  const selectValue = editing ? "__custom__" : (value as string);
  const interiorSelected = editing !== null && selected !== null && selected > 0 && selected < editing.keys.length - 1;
  const selMode: TangentMode = (interiorSelected && editing!.keys[selected!].tangent) || "aligned";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, color: t.text, fontSize: 11 }}>
      {valueMode ? null : (
        <select
          value={selectValue}
          onChange={(e) => onChange(e.target.value === "__custom__" ? easingToCurve(value) : (e.target.value as EasingPreset))}
          style={{ fontSize: 11 }}
        >
          <optgroup label="Standard">
            {STANDARD_PRESETS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </optgroup>
          <optgroup label="Legacy">
            {LEGACY_PRESETS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </optgroup>
          <option value="__custom__">custom (curve)</option>
        </select>
      )}

      {editing && !valueMode ? (
        <div style={{ display: "flex", gap: 4 }}>
          {(["position", "speed"] as const).map((s) => {
            const active = (editing.space ?? "position") === s;
            return (
              <button
                key={s}
                onClick={() => setSpace(s)}
                style={{
                  flex: 1,
                  fontSize: 10,
                  padding: "2px 0",
                  background: active ? t.curve : "transparent",
                  color: active ? "#0b1220" : t.text,
                  border: `1px solid ${active ? t.curve : t.grid}`,
                  borderRadius: 4,
                  cursor: "pointer"
                }}
              >
                edit {s}
              </button>
            );
          })}
        </div>
      ) : null}

      <div ref={wrapRef} style={{ width: "100%" }}>
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
        onDoubleClick={(e) => addAnchorAt(e)}
      >
        {backdropD ? <path d={backdropD} fill="rgba(255,255,255,0.1)" /> : null}
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g} stroke={t.grid} strokeWidth={1} vectorEffect="non-scaling-stroke">
            <line x1={px(g)} y1={0} x2={px(g)} y2={height} />
            <line x1={0} y1={py(g)} x2={width} y2={py(g)} />
          </g>
        ))}
        <line x1={0} y1={height} x2={width} y2={0} stroke={t.reference} strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        {/* Dashed = the derived other graph (speed in position mode, position in speed mode). */}
        <path d={overlayPath.join("")} fill="none" stroke={t.speed} strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        <path d={editablePath.join("")} fill="none" stroke={t.curve} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {editing
          ? editing.keys.map((key, i) => {
              const isFirst = i === 0;
              const isLast = i === editing.keys.length - 1;
              const showHandles = i === selected;
              const handles: [DragTarget["kind"], EasingPoint][] = [];
              if (showHandles && !isLast) handles.push(["out", effOut(editing.keys, i)]);
              if (showHandles && !isFirst) handles.push(["in", effIn(editing.keys, i)]);
              return (
                <g key={i}>
                  {handles.map(([kind, h]) => (
                    <g key={kind}>
                      <line x1={px(key.x)} y1={py(key.y)} x2={px(h.x)} y2={py(h.y)} stroke={t.handle} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                      <circle cx={px(h.x)} cy={py(h.y)} r={3.5} fill={t.handle} style={{ cursor: "grab" }} onPointerDown={(e) => startDrag({ kind, index: i }, e)} />
                    </g>
                  ))}
                  <circle
                    cx={px(key.x)}
                    cy={py(key.y)}
                    r={5}
                    fill={t.anchor}
                    stroke={showHandles ? t.curve : "none"}
                    strokeWidth={showHandles ? 1.5 : 0}
                    vectorEffect="non-scaling-stroke"
                    style={{ cursor: isFirst || isLast ? "ns-resize" : "grab" }}
                    onPointerDown={(e) => startDrag({ kind: "anchor", index: i }, e)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      removeAnchor(i);
                    }}
                  />
                </g>
              );
            })
          : null}
      </svg>
      </div>

      {editing ? (
        <>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {(["free", "aligned", "mirror"] as const).map((m) => {
              const active = interiorSelected && selMode === m;
              return (
                <button
                  key={m}
                  title={`Tangent handles: ${m}`}
                  onClick={() => setTangentMode(m)}
                  disabled={!interiorSelected}
                  style={{
                    flex: 1,
                    fontSize: 10,
                    padding: "2px 0",
                    background: active ? t.handle : "transparent",
                    color: active ? "#0b1220" : t.text,
                    border: `1px solid ${active ? t.handle : t.grid}`,
                    borderRadius: 4,
                    opacity: interiorSelected ? 1 : 0.5,
                    cursor: interiorSelected ? "pointer" : "default"
                  }}
                >
                  {m === "aligned" ? "align" : m}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={() => interiorSelected && removeAnchor(selected!)} disabled={!interiorSelected} style={{ flex: 1, fontSize: 10, padding: "2px 0", opacity: interiorSelected ? 1 : 0.5 }}>
              remove point
            </button>
            <button onClick={() => onChange(valueMode ? FLAT_ONE : "linear")} style={{ flex: 1, fontSize: 10, padding: "2px 0" }}>
              reset
            </button>
          </div>
          <span style={{ color: "rgba(148,163,184,0.7)", fontSize: 10 }}>
            double-click to add a point{valueMode ? "" : ` · dashed = ${speedMode ? "position" : "speed"}`}
          </span>
        </>
      ) : null}
    </div>
  );
}
