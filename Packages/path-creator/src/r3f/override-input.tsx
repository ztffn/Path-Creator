// Manual-override capture surface (debrief: pivot-orbit override, promoted from
// the demo). A transparent DOM layer that OWNS pointer + wheel and maps the twin's
// OrbitControls scheme — LMB drag → orbit, RMB drag → pan, wheel → dolly — into an
// OverrideInputAccumulator the host drains each frame into the drive intent. Owning
// input here severs R3F's picking (which raycasts the editor camera, not the driven
// one) and preventDefaults the wheel so nothing leaks to controls or the page.
import { useEffect, useRef, type CSSProperties } from "react";
import type { OverrideInputAccumulator } from "../three";

export interface CameraOverrideSurfaceProps {
  /** Where gestures accumulate; the host drains it per frame (see createOverrideInputAccumulator). */
  accumulator: OverrideInputAccumulator;
  /** Full-viewport by default; pass a style to place/size it (e.g. over a PiP). */
  style?: CSSProperties;
  /** Stacking order; keep below the app's panels so they stay interactive. Default 8. */
  zIndex?: number;
}

const FULL_VIEWPORT: CSSProperties = { position: "fixed", inset: 0 };

export function CameraOverrideSurface({ accumulator, style, zIndex = 8 }: CameraOverrideSurfaceProps) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  // Native, non-passive wheel: React's onWheel is passive and can't preventDefault,
  // which is what stops page-scroll / control-zoom bleed-through.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      accumulator.dolly(event.deltaY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [accumulator]);

  return (
    <div
      ref={ref}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        dragging.current = true;
        last.current = { x: event.clientX, y: event.clientY };
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!dragging.current || !last.current) return;
        const dx = event.clientX - last.current.x;
        const dy = event.clientY - last.current.y;
        last.current = { x: event.clientX, y: event.clientY };
        // RMB (buttons bit 2) → pan the pivot; otherwise LMB → orbit.
        if ((event.buttons & 2) !== 0) accumulator.pan(dx, dy);
        else accumulator.orbit(dx, dy);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        last.current = null;
        (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
      }}
      style={{
        ...FULL_VIEWPORT,
        zIndex,
        cursor: "grab",
        background: "transparent",
        touchAction: "none",
        boxSizing: "border-box",
        ...style
      }}
    />
  );
}
