// elastiq: an HTML deck that moves through a 3D scene. A presentation is ONE timeline, a slide
// is a named timestamp on it, and advancing rides the clock rather than cutting — so the camera,
// the models and the deck all follow from the same `t`. The look is a property of the document,
// not of the URL: a slide can open a technical chapter and the shell swaps under it.
// Scope: prototype. Built on Pascal's node infrastructure; the vocabulary and look are elastiq's.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
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
import {
  createCueTransport, createTimelinePlayer, currentCue, rideToCue, rideToNext,
  rideToPrevious, stepCueTransport
} from "@huma/path-creator/timeline";
import { hotspotClicks } from "./document/scene-kinds";
import {
  buildScene, PRESENTATION, renderModeAt, type RenderMode, type SlideCue
} from "./document/presentation";
import { PresentationScene } from "./render/scene-renderer";

interface Playhead {
  slide: string;
  time: number;
  mode: RenderMode;
}

/** Rides the clock, resolves the camera from it, and reports where the presentation is. */
function Director({ onFrame }: { onFrame: (state: Playhead) => void }) {
  const camera = useThree((state) => state.camera);
  const player = useMemo(() => createTimelinePlayer(), []);
  const transport = useMemo(() => createCueTransport(), []);
  const targets = useMemo(() => new TargetRegistry(), []);
  const bound = useRef(new Set<string>());

  // Next, previous and a marker click are one verb: ride the clock somewhere.
  const ride = useCallback(
    (direction: 1 | -1): SlideCue | null =>
      direction === 1
        ? rideToNext(transport, player, PRESENTATION.cues, { seconds: PRESENTATION.transitionSeconds })
        : rideToPrevious(transport, player, PRESENTATION.cues, { seconds: PRESENTATION.transitionSeconds }),
    [player, transport]
  );

  useEffect(() => {
    (window as unknown as { __elastiq?: { ride: (d: 1 | -1) => SlideCue | null } }).__elastiq = { ride };
  }, [ride]);

  useFrame((_, delta) => {
    // Late-bind targets: renderers register objects as they mount, so a shot's target may not
    // exist for the first frames. Binding by id makes that a non-event.
    for (const [id, object] of sceneRegistry.nodes) {
      if (!bound.current.has(id)) {
        bound.current.add(id);
        registerObjectTarget(targets, id, object, id);
      }
    }

    while (hotspotClicks.length) {
      const click = hotspotClicks.shift()!;
      rideToCue(transport, player, PRESENTATION.cues, click.action.cueId, {
        seconds: click.action.transitionSeconds
      });
    }

    stepCueTransport(transport, player, delta);
    const t = player.time;

    // The camera is the shot before t blended into the shot after it. No separate transition
    // system exists: the ride moves t, and this reads t.
    const context = {
      getTargetPosition: (id: string) => targets.resolve(id),
      getTargetOrientation: (id: string) => targets.resolveOrientation(id),
      elapsedSeconds: t
    };
    let from = PRESENTATION.shots[0]!;
    for (const shot of PRESENTATION.shots) if (shot.time <= t) from = shot;
    const to = PRESENTATION.shots.find((shot) => shot.time > t) ?? from;
    const span = to.time - from.time;
    const alpha = span > 0 ? Math.min(1, Math.max(0, (t - from.time) / span)) : 0;

    const a = resolveVirtualCameraDefinition(from.definition, context);
    const b = resolveVirtualCameraDefinition(to.definition, context);
    if (a && b) applyVirtualCameraSnapshot(camera, blendVirtualCameraSnapshots(a, b, alpha));
    else if (a) applyVirtualCameraSnapshot(camera, a);

    onFrame({
      slide: currentCue(PRESENTATION.cues, t)?.name ?? "—",
      time: t,
      mode: renderModeAt(PRESENTATION, t)
    });
  });

  return null;
}

/** The cinematic shell: environment lighting and contact shadows, room for bloom and depth of field. */
function PolishedStage({ children }: { children: React.ReactNode }) {
  return (
    <Canvas camera={{ position: [10, 6, 10], fov: 50 }} dpr={[1, 2]} shadows>
      <color args={["#0e1116"]} attach="background" />
      <Environment preset="city" />
      <directionalLight castShadow intensity={2.2} position={[6, 10, 6]} />
      <ambientLight intensity={0.35} />
      <ContactShadows blur={2.4} far={12} opacity={0.5} position={[0, 0.01, 0]} scale={30} />
      <PresentationScene />
      {children}
    </Canvas>
  );
}

/** The technical shell: screen-space GI, inked edges and outlines, for reading geometry. */
function ReadingStage({ children }: { children: React.ReactNode }) {
  return <Viewer>{children}</Viewer>;
}

export default function App() {
  const [playhead, setPlayhead] = useState<Playhead>({
    slide: "—", time: 0, mode: PRESENTATION.renderMode
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    buildScene(useScene.getState() as never, nodeRegistry);
    (window as unknown as { __scene?: unknown }).__scene = useScene;
    (window as unknown as { __registry?: unknown }).__registry = sceneRegistry;
    setReady(true);
  }, []);

  const go = (direction: 1 | -1) =>
    (window as unknown as { __elastiq?: { ride: (d: 1 | -1) => void } }).__elastiq?.ride(direction);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === " ") go(1);
      else if (event.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Swapping the shell remounts the canvas, so the director rides inside whichever is mounted.
  const Stage = playhead.mode === "reading" ? ReadingStage : PolishedStage;

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0e1116" }}>
      <Stage>{ready ? <Director onFrame={setPlayhead} /> : null}</Stage>

      {/* The deck. In the product this is the slide content; here it only shows that the HTML
          and the 3D stay in step, because both read the same clock. */}
      <div style={{
        position: "absolute", left: 40, bottom: 40, maxWidth: 460, padding: "18px 22px",
        borderRadius: 12, background: "rgba(14,17,22,0.82)", color: "#e6edf3",
        font: "14px/1.6 ui-sans-serif, system-ui, sans-serif"
      }}>
        <div style={{ opacity: 0.5, font: "11px/1 ui-monospace, monospace", letterSpacing: 1 }}>
          {PRESENTATION.name} · t = {playhead.time.toFixed(2)}s · {playhead.mode}
        </div>
        <div style={{ font: "600 22px/1.3 ui-sans-serif, system-ui", marginTop: 8 }}>{playhead.slide}</div>
        <div style={{ opacity: 0.7, marginTop: 8 }}>
          Slides are timestamps on one timeline. Advancing rides the clock, and the camera follows
          because it is a function of t. The look is a property of the slide — the centre subject
          opens a technical chapter and the shell swaps under it.
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
