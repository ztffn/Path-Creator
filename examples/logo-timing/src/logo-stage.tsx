// The preview: the logo SVG with one PAUSED animation per target, seeked by the host's
// clock. Nothing here plays — the intro's own setTimeout schedule is replaced by a WAAPI
// `delay`, so the browser still does every interpolation but the timeline owns the time.
// Rebuilt whenever a piece is retimed, which is why building is one pure pass over the
// pieces rather than a set of effects that would each have to know what changed.
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import logoSvg from "./distant-front-logo.svg?raw";
import { type LogoPiece, type LogoTarget } from "./logo-timing";
import "./logo-stage.css";

/** The logo's own CSS sizes it at 480px; px-valued effects are authored against that. */
const AUTHORED_WIDTH = 480;

export interface LogoStageHandle {
  /** Put every animation at this time. Milliseconds from the top of the intro. */
  seek: (timeMs: number) => void;
}

/** Deterministic shake offsets — a re-render must not reshuffle the jitter. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function keyframesFor(piece: LogoPiece, target: LogoTarget, scale: number): Keyframe[] {
  const motion = piece.motion;
  const direction = target.direction ?? 1;
  switch (motion.type) {
    case "scaleIn":
      return [
        { opacity: 0, transform: `scale(${motion.from})` },
        { opacity: 1, transform: `scale(${motion.overshoot})`, offset: 0.82 },
        { opacity: 1, transform: "scale(1)" }
      ];
    case "slideX":
      return [
        { opacity: 0, transform: `translateX(${motion.fromPx * direction}px)` },
        { opacity: 1, transform: "translateX(0)" }
      ];
    case "dropIn":
      return [
        { opacity: 0, transform: `translateY(${motion.fromPx}px) scale(0.95)` },
        { opacity: 1, transform: `translateY(${motion.overshootPx}px)`, offset: 0.78 },
        { opacity: 1, transform: "translateY(0px) scale(1)" }
      ];
    case "pop":
      return [
        { opacity: 0, transform: `translateY(${motion.fromPx}px) scale(0.85)` },
        { opacity: 1, transform: "translateY(-3px) scale(1.02)", offset: 0.75 },
        { opacity: 1, transform: "translateY(0) scale(1)" }
      ];
    case "glint":
      return [
        { transform: "translate(36px,36px)", opacity: 0 },
        { transform: "translate(-6px,-6px)", opacity: 0.55, offset: 0.55 },
        { transform: "translate(-46px,-46px)", opacity: 0 }
      ];
    case "shake": {
      const random = seededRandom(piece.id.length * 7919 + motion.amountPx);
      const amount = motion.amountPx * scale;
      const frames: Keyframe[] = [{ transform: "translate(0px,0px)" }];
      for (let step = 1; step < 6; step += 1) {
        const x = (random() * 2 - 1) * amount;
        const y = (random() * 2 - 1) * amount * 0.5;
        frames.push({ transform: `translate(${x}px,${y}px)` });
      }
      frames.push({ transform: "translate(0px,0px)" });
      return frames;
    }
    case "pulse":
      return [
        { transform: "scale(1)" },
        { transform: `scale(${motion.scale})`, offset: 0.4 },
        { transform: "scale(1)" }
      ];
    case "flash":
      return [{ opacity: 0 }, { opacity: motion.peak, offset: 0.15 }, { opacity: 0 }];
    case "glow":
      return [
        { filter: `drop-shadow(0 0 ${motion.fromPx * scale}px rgba(147,127,96,.25))` },
        { filter: `drop-shadow(0 0 ${motion.toPx * scale}px rgba(147,127,96,.55))` }
      ];
  }
}

export const LogoStage = forwardRef<LogoStageHandle, { pieces: LogoPiece[] }>(
  function LogoStage({ pieces }, ref) {
    // The ref sits on the OUTER stage: #pulse and the two shake wrappers are ancestors
    // of the artwork, so a ref on the wrap could not find the elements they animate.
    const stageRef = useRef<HTMLDivElement>(null);
    const animationsRef = useRef<Animation[]>([]);
    const timeRef = useRef(0);

    useImperativeHandle(ref, () => ({
      seek(timeMs: number) {
        timeRef.current = timeMs;
        for (const animation of animationsRef.current) animation.currentTime = timeMs;
      }
    }));

    useEffect(() => {
      const root = stageRef.current;
      if (!root) return;
      // The artwork is injected here rather than through dangerouslySetInnerHTML because
      // React re-renders this component whenever the playhead publishes a new time, and a
      // re-rendered innerHTML subtree is a REPLACED subtree — every animation on an SVG
      // group silently disappears while the React-owned wrapper divs keep theirs, which
      // reads as "only the shakes work".
      const host = root.querySelector<HTMLDivElement>(".logo-stage__artwork");
      if (host && host.childElementCount === 0) host.innerHTML = logoSvg;
      for (const animation of animationsRef.current) animation.cancel();
      animationsRef.current = [];
      const scale = (root.querySelector("svg")?.clientWidth ?? AUTHORED_WIDTH) / AUTHORED_WIDTH;

      for (const piece of pieces) {
        piece.targets.forEach((target, index) => {
          const element = root.querySelector<SVGElement | HTMLElement>(`#${CSS.escape(target.id)}`);
          if (!element) return;
          const animation = element.animate(keyframesFor(piece, target, scale), {
            delay: piece.delayMs + index * piece.stepMs,
            duration: piece.durationMs,
            easing: piece.easing,
            // `both` is load-bearing: backwards fill is what holds a piece off-screen
            // before its delay, and forwards fill is what keeps it placed afterwards.
            fill: "both",
            ...(piece.loop ? { iterations: Infinity, direction: "alternate" as const } : {})
          });
          animation.pause();
          animationsRef.current.push(animation);
        });
      }
      // A rebuild must land on the frame the user is looking at, not back at zero.
      for (const animation of animationsRef.current) animation.currentTime = timeRef.current;

      return () => {
        for (const animation of animationsRef.current) animation.cancel();
        animationsRef.current = [];
      };
    }, [pieces]);

    return (
      <div className="logo-stage" ref={stageRef}>
        <div className="logo-stage__pulse" id="pulse">
          <div className="logo-stage__shake1" id="shake1">
            <div className="logo-stage__shake2" id="shake2">
              <div className="logo-stage__wrap">
                <div className="logo-stage__artwork" />
                <div className="logo-stage__flash" id="flash" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
);
