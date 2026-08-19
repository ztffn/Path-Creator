// The DOM chrome over the picture-in-picture: a framed border and the name of the shot it shows.
// The pixels inside come from a scissored render pass in the viewer's frame loop (drive/camera-
// pip.tsx), which the DOM cannot draw into or see — so this only frames it, and derives its box
// from the SAME pipRect the renderer uses so the two can never drift. Portalled to the body,
// pointer-transparent, and positioned off the live canvas rect because the author can resize.
"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { pipRect } from "../drive/camera-pip";
import { pascalTimeTransport } from "../transport/store";
import { useNodeLabel } from "./panel-shared";

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The PiP's box in DOM coordinates, from the canvas's live rect. Null until a canvas exists. */
function measurePipBox(): Box | null {
  const canvas = document.querySelector("canvas");
  if (!canvas) return null;
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width < 1 || bounds.height < 1) return null;
  const rect = pipRect(bounds.width, bounds.height);
  return {
    // The renderer's scissor origin is the canvas's BOTTOM-left; the DOM's is its top-left.
    top: bounds.top + (bounds.height - (rect.y + rect.height)),
    left: bounds.left + rect.x,
    width: rect.width,
    height: rect.height
  };
}

export function PipOverlay(): ReactNode {
  const pipShotId = useStore(pascalTimeTransport, (state) => state.pipShotId);
  const label = useNodeLabel();
  const [box, setBox] = useState<Box | null>(null);

  useEffect(() => {
    if (!pipShotId) {
      setBox(null);
      return;
    }
    const measure = (): void => setBox(measurePipBox());
    measure();
    // Layout, not a hot path — the same interval-plus-resize the lane dock uses to track the
    // sidebar's draggable edge, for the same reason: nothing emits an event when it changes.
    const interval = window.setInterval(measure, 400);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("resize", measure);
    };
  }, [pipShotId]);

  if (!pipShotId || !box) return null;

  return createPortal(
    <div
      data-huma-pip={pipShotId}
      style={{
        position: "fixed",
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
        zIndex: 29, // under the lane dock (30), over the viewport
        pointerEvents: "none",
        borderWidth: 2,
        borderStyle: "solid",
        borderColor: "rgba(230, 232, 238, 0.9)",
        borderRadius: 4,
        boxSizing: "border-box",
        boxShadow: "0 8px 30px rgba(0,0,0,0.4)"
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 6,
          left: 6,
          padding: "2px 6px",
          borderRadius: 4,
          background: "rgba(16, 17, 20, 0.78)",
          color: "#e6e8ee",
          fontSize: 11,
          fontWeight: 600,
          whiteSpace: "nowrap"
        }}
      >
        {label(pipShotId)}
      </span>
    </div>,
    document.body
  );
}
