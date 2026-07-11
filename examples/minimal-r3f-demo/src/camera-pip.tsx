import { useFrame, useThree } from "@react-three/fiber";
import type { ComposerSettings } from "@huma/path-creator/core";
import { CameraHelper, Color, PerspectiveCamera } from "three";

const DOLLY_PIP_ASPECT = 16 / 9;
const DOLLY_PIP_MARGIN = 16;

function getComposerZones(settings: ComposerSettings) {
  return {
    deadZone: { width: settings.deadWidth, height: settings.deadHeight },
    softZone: { width: settings.softWidth, height: settings.softHeight }
  };
}

const PIP_NO_SIGNAL_COLOR = new Color("#0a101c");
const _pipClearScratch = new Color();

export function DollyCameraPip({
  camera: dollyCamera,
  frustumHelper,
  hasSource,
  playMode,
  showPip
}: {
  camera: PerspectiveCamera;
  frustumHelper: CameraHelper;
  hasSource: boolean;
  /** Play: the driven camera fills the main viewport, editor drops to the PiP. */
  playMode: boolean;
  /** Whether to draw the small inset at all ("Show camera PiP"). */
  showPip: boolean;
}) {
  const { gl, scene, size } = useThree();

  useFrame(({ camera: editorCamera }) => {
    // Play mode promotes the driven camera to the main viewport (only when one
    // actually drives it). The inset then shows the editor camera.
    const play = playMode && hasSource;
    const mainCamera = play ? dollyCamera : editorCamera;
    const pipCamera = play ? editorCamera : dollyCamera;

    // Full-viewport render. Hide the frustum helper while looking THROUGH the
    // dolly camera (you're inside its own frustum).
    gl.setScissorTest(false);
    gl.setViewport(0, 0, size.width, size.height);
    const hideFrustumMain = mainCamera === dollyCamera;
    if (hideFrustumMain) frustumHelper.visible = false;
    gl.render(scene, mainCamera);
    if (hideFrustumMain) frustumHelper.visible = true;

    if (!showPip) return; // Play mode with the inset hidden: main render only.

    // PiP scissor region (bottom-right).
    const width = Math.min(360, Math.max(220, size.width * 0.28));
    const height = width / DOLLY_PIP_ASPECT;
    const x = Math.max(DOLLY_PIP_MARGIN, size.width - width - DOLLY_PIP_MARGIN);
    const y = DOLLY_PIP_MARGIN;

    gl.clearDepth();
    gl.setScissorTest(true);
    gl.setScissor(x, y, width, height);
    gl.setViewport(x, y, width, height);
    const pipIsDolly = pipCamera === dollyCamera;
    if (pipIsDolly && !hasSource) {
      // No camera drives the PiP: paint a dark "no signal" panel instead of a
      // view from an undriven camera.
      const prevColor = gl.getClearColor(_pipClearScratch);
      const prevAlpha = gl.getClearAlpha();
      gl.setClearColor(PIP_NO_SIGNAL_COLOR, 1);
      gl.clear(true, true, false);
      gl.setClearColor(prevColor, prevAlpha);
    } else {
      if (pipIsDolly) frustumHelper.visible = false;
      gl.render(scene, pipCamera);
      if (pipIsDolly) frustumHelper.visible = true;
    }
    gl.setScissorTest(false);
    gl.setViewport(0, 0, size.width, size.height);
  }, 1);

  return null;
}

// The PiP overlay chrome: the composer zone overview (dead/soft/hard) plus the
// tracked-target and lookahead markers, drawn over the camera view that
// DollyCameraPip renders into this region. With no source it's a slate "no
// output" panel; the zones/markers only show when a composer vcam drives the PiP.
export function DollyPreviewChrome({
  label,
  hasSource,
  composerActive,
  composerSettings,
  targetMarkerRef,
  targetLineRef,
  lookaheadMarkerRef,
  lookaheadLineRef
}: {
  label: string;
  hasSource: boolean;
  composerActive: boolean;
  composerSettings: ComposerSettings;
  targetMarkerRef: { current: HTMLDivElement | null };
  targetLineRef: { current: SVGLineElement | null };
  lookaheadMarkerRef: { current: HTMLDivElement | null };
  lookaheadLineRef: { current: SVGLineElement | null };
}) {
  const zones = getComposerZones(composerSettings);
  const labelChip = (
    <div
      style={{
        position: "absolute",
        top: 8,
        left: 8,
        padding: "3px 7px",
        borderRadius: 4,
        background: "rgba(15, 23, 42, 0.72)",
        color: hasSource ? "#f8fafc" : "#64748b",
        fontSize: 11,
        fontWeight: 700,
        fontFamily: "ui-sans-serif, system-ui, sans-serif"
      }}
    >
      {label}
    </div>
  );

  return (
    <div
      style={{
        position: "fixed",
        right: DOLLY_PIP_MARGIN,
        bottom: DOLLY_PIP_MARGIN,
        zIndex: 9,
        width: "min(360px, max(220px, 28vw))",
        aspectRatio: "16 / 9",
        pointerEvents: "none",
        border: `2px solid ${hasSource ? "rgba(248, 250, 252, 0.92)" : "rgba(148, 163, 184, 0.35)"}`,
        boxShadow: "0 18px 44px rgba(15, 23, 42, 0.28)",
        background: hasSource ? "transparent" : "rgba(10, 16, 28, 0.55)",
        boxSizing: "border-box"
      }}
    >
      {composerActive ? (
        <>
          <DollyPipZone
            width={zones.softZone.width}
            height={zones.softZone.height}
            centerX={composerSettings.screenX}
            centerY={composerSettings.screenY}
            color="rgba(6, 182, 212, 0.78)"
            fill="rgba(6, 182, 212, 0.035)"
          />
          <DollyPipZone
            width={zones.deadZone.width}
            height={zones.deadZone.height}
            centerX={composerSettings.screenX}
            centerY={composerSettings.screenY}
            color="rgba(249, 115, 22, 0.92)"
            fill="rgba(249, 115, 22, 0.04)"
          />
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}
          >
            <line ref={targetLineRef} x1="50" y1="50" x2="50" y2="50" stroke="rgba(6, 182, 212, 0.72)" strokeWidth="0.55" vectorEffect="non-scaling-stroke" />
            <line ref={lookaheadLineRef} x1="50" y1="50" x2="50" y2="50" stroke="rgba(250, 204, 21, 0)" strokeWidth="0.55" strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
          </svg>
          <div
            ref={targetMarkerRef}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 14,
              height: 14,
              transform: "translate(-50%, -50%)",
              borderRadius: 999,
              background: "#06b6d4",
              border: "2px solid rgba(248, 250, 252, 0.95)",
              boxShadow: "0 0 0 4px rgba(6, 182, 212, 0.22), 0 0 18px rgba(6, 182, 212, 0.85)",
              boxSizing: "border-box"
            }}
          />
          <div
            ref={lookaheadMarkerRef}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 10,
              height: 10,
              transform: "translate(-50%, -50%) rotate(45deg)",
              background: "rgba(250, 204, 21, 0)",
              border: "2px solid rgba(250, 204, 21, 0)",
              boxShadow: "0 0 0 3px rgba(250, 204, 21, 0)",
              boxSizing: "border-box"
            }}
          />
        </>
      ) : null}
      {labelChip}
    </div>
  );
}

export function updateDollyTargetOverlay(
  marker: HTMLDivElement | null,
  line: SVGLineElement | null,
  x: number,
  y: number,
  visible: boolean,
  kind: "target" | "lookahead" = "target"
): void {
  const clampedX = Math.max(0.02, Math.min(0.98, x));
  const clampedY = Math.max(0.02, Math.min(0.98, y));
  const xPercent = clampedX * 100;
  const yPercent = clampedY * 100;

  if (marker) {
    marker.style.left = `${xPercent}%`;
    marker.style.top = `${yPercent}%`;
    if (kind === "lookahead") {
      marker.style.opacity = visible ? "1" : "0";
      marker.style.background = visible ? "rgba(250, 204, 21, 0.95)" : "rgba(250, 204, 21, 0)";
      marker.style.borderColor = visible ? "rgba(15, 23, 42, 0.8)" : "rgba(250, 204, 21, 0)";
      marker.style.boxShadow = visible
        ? "0 0 0 3px rgba(250, 204, 21, 0.24), 0 0 16px rgba(250, 204, 21, 0.75)"
        : "0 0 0 3px rgba(250, 204, 21, 0)";
    } else {
      marker.style.opacity = visible ? "1" : "0.42";
      marker.style.background = visible ? "#06b6d4" : "rgba(6, 182, 212, 0.42)";
      marker.style.boxShadow = visible
        ? "0 0 0 4px rgba(6, 182, 212, 0.22), 0 0 18px rgba(6, 182, 212, 0.85)"
        : "0 0 0 4px rgba(6, 182, 212, 0.12)";
    }
  }

  if (line) {
    line.setAttribute("x2", xPercent.toFixed(3));
    line.setAttribute("y2", yPercent.toFixed(3));
    line.setAttribute(
      "stroke",
      kind === "lookahead"
        ? visible ? "rgba(250, 204, 21, 0.72)" : "rgba(250, 204, 21, 0)"
        : visible ? "rgba(6, 182, 212, 0.72)" : "rgba(6, 182, 212, 0.3)"
    );
  }
}

function DollyPipZone({
  width,
  height,
  centerX,
  centerY,
  color,
  fill
}: {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  color: string;
  fill: string;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: `${50 + centerX * 100}%`,
        top: `${50 - centerY * 100}%`,
        width: `${width * 100}%`,
        height: `${height * 100}%`,
        transform: "translate(-50%, -50%)",
        border: `1.5px solid ${color}`,
        background: fill,
        boxSizing: "border-box"
      }}
    />
  );
}
