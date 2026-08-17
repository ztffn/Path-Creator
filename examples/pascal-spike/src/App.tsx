// The product spine in miniature: a Pascal-owned scene of GLBs and hotspots, cues that act as
// slides, and a camera that RIDES the clock between them rather than cutting. Pressing next
// animates t; everything downstream follows, because the timeline is a pure function of t.
// Nothing here knows about walls or buildings — Pascal supplies the node infrastructure, this
// app supplies the vocabulary. Scope: prototype; see README.md for what it is demonstrating.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Canvas } from "@react-three/fiber";
import { ContactShadows, Environment } from "@react-three/drei";
import { Viewer } from "@pascal-app/viewer";
import { nodeRegistry, sceneRegistry, useScene } from "@pascal-app/core";
import {
  applyVirtualCameraSnapshot,
  blendVirtualCameraSnapshots,
  registerObjectTarget,
  resolveVirtualCameraDefinition
} from "@huma/path-creator/three";
import { TargetRegistry } from "@huma/path-creator/core";
import { createTimelinePlayer } from "@huma/path-creator/timeline";
import {
  createCueTransport, currentCue, rideTo, rideToNext, rideToPrevious, stepCueTransport, type Cue
} from "./cues";
import { hotspotClicks } from "./scene-kinds";
import { PresentationScene } from "./scene-renderer";
import { buildPresentationScene, CUES, SHOTS, TRANSITION_SECONDS } from "./presentation-scene";

// Two shells over ONE document. `?mode=reading` mounts Pascal's WebGPU viewer — SSGI, inked
// edges, merged outlines, tuned for reading geometry clearly. Anything else mounts our own
// canvas — HDRI environment, contact shadows, and whatever cinematic post the product wants.
// The scene, the node kinds, their renderers and the timeline are identical in both; only the
// shell around them differs, which is the whole reason the document is renderer-agnostic.
const MODE = (typeof window !== "undefined"
  ? new URLSearchParams(window.location.search).get("mode")
  : null) === "reading" ? "reading" : "polished";

function CameraDirector({ onSlide }: { onSlide: (name: string, t: number) => void }) {
  const camera = useThree((s) => s.camera);
  const player = useMemo(() => createTimelinePlayer(), []);
  const transport = useMemo(() => createCueTransport(), []);
  const targets = useMemo(() => new TargetRegistry(), []);
  const bound = useRef(new Set<string>());

  // Next, previous and a hotspot click are the same verb: ride the clock somewhere.
  const ride = useCallback(
    (dir: 1 | -1): Cue | null =>
      dir === 1
        ? rideToNext(transport, player, CUES, { seconds: TRANSITION_SECONDS })
        : rideToPrevious(transport, player, CUES, { seconds: TRANSITION_SECONDS }),
    [player, transport]
  );

  useEffect(() => {
    (window as unknown as { __ride?: (d: 1 | -1) => Cue | null }).__ride = ride;
  }, [ride]);

  useFrame((_, delta) => {
    // Late-bind targets: Pascal's renderers register objects as they mount, so a shot's target
    // may not exist for the first frames. Binding by id makes that a non-event.
    for (const [id, object] of sceneRegistry.nodes) {
      if (!bound.current.has(id)) {
        bound.current.add(id);
        registerObjectTarget(targets, id, object, id);
      }
    }

    while (hotspotClicks.length) {
      const click = hotspotClicks.shift()!;
      const target = CUES.find((c) => c.id === click.action.cueId);
      if (target) rideTo(transport, player, target.time, { seconds: click.action.transitionSeconds });
    }

    stepCueTransport(transport, player, delta);
    const t = player.time;

    // The camera is the shot before t blended into the shot after it, by how far between they
    // are. No separate transition system: the ride moves t, and this reads t.
    const context = {
      getTargetPosition: (id: string) => targets.resolve(id),
      getTargetOrientation: (id: string) => targets.resolveOrientation(id),
      elapsedSeconds: t
    };
    let from = SHOTS[0]!;
    for (const shot of SHOTS) if (shot.time <= t) from = shot;
    const to = SHOTS.find((shot) => shot.time > t) ?? from;
    const span = to.time - from.time;
    const alpha = span > 0 ? Math.min(1, Math.max(0, (t - from.time) / span)) : 0;

    const a = resolveVirtualCameraDefinition(from.definition, context);
    const b = resolveVirtualCameraDefinition(to.definition, context);
    if (a && b) applyVirtualCameraSnapshot(camera, blendVirtualCameraSnapshots(a, b, alpha));
    else if (a) applyVirtualCameraSnapshot(camera, a);

    onSlide(currentCue(CUES, t)?.name ?? "—", t);
  });

  return null;
}

export default function App() {
  const [slide, setSlide] = useState({ name: "—", t: 0 });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    buildPresentationScene(useScene.getState() as never, nodeRegistry);
    // Diagnostics for the headless driver: what Pascal holds vs what actually rendered.
    (window as unknown as { __scene?: unknown }).__scene = useScene;
    (window as unknown as { __registry?: unknown }).__registry = sceneRegistry;
    setReady(true);
  }, []);

  const go = (dir: 1 | -1) => (window as unknown as { __ride?: (d: 1 | -1) => void }).__ride?.(dir);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === " ") go(1);
      else if (event.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0e1116" }}>
      {MODE === "reading" ? (
        // Pascal's viewer renders the same document through its own dispatch, using the very
        // same node renderers our plugin ships. It brings the shell: WebGPU, SSGI, outlines.
        <Viewer>{ready ? <CameraDirector onSlide={(name, t) => setSlide({ name, t })} /> : null}</Viewer>
      ) : (
        <Canvas camera={{ position: [10, 6, 10], fov: 50 }} dpr={[1, 2]} shadows>
          <color args={["#0e1116"]} attach="background" />
          <Environment preset="city" />
          <directionalLight castShadow intensity={2.2} position={[6, 10, 6]} />
          <ambientLight intensity={0.35} />
          <ContactShadows blur={2.4} far={12} opacity={0.5} position={[0, 0.01, 0]} scale={30} />
          <PresentationScene />
          {ready ? <CameraDirector onSlide={(name, t) => setSlide({ name, t })} /> : null}
        </Canvas>
      )}

      {/* The HTML layer. In the product this is the slide deck; here it only proves the two
          halves stay in step, because both read the same clock. */}
      <div style={{
        position: "absolute", left: 40, bottom: 40, maxWidth: 460, padding: "18px 22px",
        borderRadius: 12, background: "rgba(14,17,22,0.82)", color: "#e6edf3",
        font: "14px/1.6 ui-sans-serif, system-ui, sans-serif"
      }}>
        <div style={{ opacity: 0.5, font: "11px/1 ui-monospace, monospace", letterSpacing: 1 }}>
          t = {slide.t.toFixed(2)}s
        </div>
        <div style={{ font: "600 22px/1.3 ui-sans-serif, system-ui", marginTop: 8 }}>{slide.name}</div>
        <div style={{ opacity: 0.7, marginTop: 8 }}>
          Slides are timestamps on one timeline. Next does not cut — it rides the clock, and the
          camera follows because it is a function of t. Click a marker to jump to its slide.
        </div>
        <div style={{ opacity: 0.45, marginTop: 6, font: "11px ui-monospace, monospace" }}>
          shell: {MODE} · {MODE === "polished" ? "?mode=reading for Pascal's viewer" : "drop ?mode for the polished shell"}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button onClick={() => go(-1)} style={btn}>← Prev</button>
          <button onClick={() => go(1)} style={btn}>Next →</button>
        </div>
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "8px 14px", borderRadius: 8, border: "1px solid #3a4657",
  background: "#1b222c", color: "#e6edf3", cursor: "pointer", font: "13px ui-sans-serif, system-ui"
};
