// The intro as DATA: one record per timed piece, with the SVG element ids it drives
// and a motion descriptor the stage turns into keyframes. Pure — no DOM, no React —
// so drag/resize semantics and the source export are unit-testable, and so the lane
// editor edits a value rather than reaching into the animation. Spans are seconds
// because TimelineLanes speaks seconds; the piece records are milliseconds like the CSS.

/** A target element, and which way a mirrored motion travels for it. */
export interface LogoTarget {
  id: string;
  /** -1 mirrors a horizontal motion, so one lane can drive a symmetric pair. */
  direction?: 1 | -1;
}

export type LogoMotion =
  | { type: "scaleIn"; from: number; overshoot: number }
  | { type: "slideX"; fromPx: number }
  | { type: "dropIn"; fromPx: number; overshootPx: number }
  | { type: "pop"; fromPx: number }
  | { type: "glint" }
  | { type: "shake"; amountPx: number }
  | { type: "pulse"; scale: number }
  | { type: "flash"; peak: number }
  | { type: "glow"; fromPx: number; toPx: number };

export interface LogoPiece {
  id: string;
  label: string;
  icon: string;
  color: string;
  targets: LogoTarget[];
  /** Milliseconds from the top of the intro to the FIRST target's start. */
  delayMs: number;
  /** Milliseconds ONE target takes. For a stagger this is per element, not the run. */
  durationMs: number;
  /** Milliseconds between successive targets. Zero when the targets move together. */
  stepMs: number;
  easing: string;
  motion: LogoMotion;
  /** Repeats forever from its delay (the idle glow), so its block end is nominal. */
  loop?: boolean;
}

/** Shortest a piece can be dragged down to — below this a block is unclickable. */
export const MIN_PIECE_MS = 40;

/**
 * The intro exactly as authored in distant_front_logo_intro.html. Every number here
 * is a setTimeout delay or an animation duration from that file; this table is the
 * thing the editor edits and prints back.
 */
export const DEFAULT_PIECES: LogoPiece[] = [
  {
    id: "mountains",
    label: "Mountains",
    icon: "▲",
    color: "rgba(92, 90, 62, 0.75)",
    targets: [{ id: "mountains" }],
    delayMs: 0,
    durationMs: 560,
    stepMs: 0,
    easing: "cubic-bezier(.2,.8,.3,1.05)",
    motion: { type: "scaleIn", from: 0.25, overshoot: 1.06 }
  },
  {
    id: "impact-shake",
    label: "Impact shake",
    icon: "≋",
    color: "rgba(148, 163, 184, 0.45)",
    targets: [{ id: "shake1" }],
    delayMs: 550,
    durationMs: 220,
    stepMs: 0,
    easing: "linear",
    motion: { type: "shake", amountPx: 5 }
  },
  {
    id: "shading",
    label: "Ridge shading",
    icon: "◤",
    color: "rgba(147, 126, 95, 0.7)",
    targets: [
      { id: "shade-left", direction: -1 },
      { id: "shade-right", direction: 1 }
    ],
    delayMs: 650,
    durationMs: 340,
    stepMs: 0,
    easing: "cubic-bezier(.22,.61,.36,1)",
    motion: { type: "slideX", fromPx: 220 }
  },
  {
    id: "dagger",
    label: "Dagger",
    icon: "🗡",
    color: "rgba(219, 213, 202, 0.65)",
    targets: [{ id: "dagger" }],
    delayMs: 1050,
    durationMs: 450,
    stepMs: 0,
    easing: "cubic-bezier(.16,1,.3,1)",
    motion: { type: "dropIn", fromPx: 230, overshootPx: -16 }
  },
  {
    id: "landing-shake",
    label: "Landing shake",
    icon: "≋",
    color: "rgba(148, 163, 184, 0.45)",
    targets: [{ id: "shake2" }],
    delayMs: 1500,
    durationMs: 150,
    stepMs: 0,
    easing: "linear",
    motion: { type: "shake", amountPx: 3 }
  },
  {
    id: "glint",
    label: "Blade glint",
    icon: "✦",
    color: "rgba(255, 255, 255, 0.55)",
    targets: [{ id: "blade-glint" }],
    delayMs: 1880,
    durationMs: 260,
    stepMs: 0,
    easing: "ease-out",
    motion: { type: "glint" }
  },
  {
    id: "wings",
    label: "Wings",
    icon: "≡",
    color: "rgba(147, 127, 96, 0.7)",
    targets: [
      { id: "wing-left", direction: -1 },
      { id: "wing-right", direction: 1 }
    ],
    delayMs: 2140,
    durationMs: 300,
    stepMs: 0,
    easing: "cubic-bezier(.22,.61,.36,1)",
    motion: { type: "slideX", fromPx: 240 }
  },
  {
    id: "distant-letters",
    label: "DISTANT",
    icon: "D",
    color: "rgba(219, 213, 202, 0.6)",
    targets: [
      { id: "d-D" }, { id: "d-I" }, { id: "d-S" }, { id: "d-T1" },
      { id: "d-A" }, { id: "d-N" }, { id: "d-T2" }
    ],
    delayMs: 2190,
    durationMs: 200,
    stepMs: 70,
    easing: "ease-out",
    motion: { type: "pop", fromPx: 22 }
  },
  {
    id: "front-letters",
    label: "FRONT",
    icon: "F",
    color: "rgba(92, 90, 61, 0.8)",
    targets: [{ id: "f-F" }, { id: "f-R" }, { id: "f-O" }, { id: "f-N" }, { id: "f-T" }],
    delayMs: 2490,
    durationMs: 200,
    stepMs: 80,
    easing: "ease-out",
    motion: { type: "pop", fromPx: 18 }
  },
  {
    id: "pulse",
    label: "Stinger pulse",
    icon: "◎",
    color: "rgba(249, 115, 22, 0.5)",
    targets: [{ id: "pulse" }],
    delayMs: 3090,
    durationMs: 340,
    stepMs: 0,
    easing: "ease-out",
    motion: { type: "pulse", scale: 1.045 }
  },
  {
    id: "flash",
    label: "Flash",
    icon: "✷",
    color: "rgba(230, 225, 210, 0.6)",
    targets: [{ id: "flash" }],
    delayMs: 3090,
    durationMs: 420,
    stepMs: 0,
    easing: "ease-out",
    motion: { type: "flash", peak: 0.55 }
  },
  {
    id: "idle-glow",
    label: "Idle glow",
    icon: "☼",
    color: "rgba(147, 127, 96, 0.45)",
    targets: [{ id: "logoSvg" }],
    delayMs: 3540,
    durationMs: 3200,
    stepMs: 0,
    easing: "ease-in-out",
    motion: { type: "glow", fromPx: 6, toPx: 22 },
    loop: true
  }
];

/** Milliseconds from a piece's start to the moment its LAST target finishes. */
export function pieceSpanMs(piece: LogoPiece): number {
  const trailing = Math.max(0, piece.targets.length - 1) * piece.stepMs;
  return trailing + piece.durationMs;
}

/** The block a lane draws for this piece, in seconds. */
export function pieceBlock(piece: LogoPiece): { start: number; end: number } {
  return { start: piece.delayMs / 1000, end: (piece.delayMs + pieceSpanMs(piece)) / 1000 };
}

/**
 * Apply a lane drag or resize. Moving sets the delay. Resizing keeps each element's
 * own duration and spreads the STAGGER across the new span — which is the control you
 * actually want on a wordmark: how fast the letters chase each other, not how long one
 * letter takes. A piece with a single target has no stagger, so the span is its duration.
 */
export function retimePiece(piece: LogoPiece, startSec: number, endSec: number): LogoPiece {
  const delayMs = Math.max(0, Math.round(startSec * 1000));
  const spanMs = Math.max(MIN_PIECE_MS, Math.round((endSec - startSec) * 1000));
  const gaps = piece.targets.length - 1;
  if (gaps <= 0) return { ...piece, delayMs, durationMs: spanMs };
  const durationMs = Math.min(piece.durationMs, spanMs);
  return { ...piece, delayMs, durationMs, stepMs: Math.max(0, Math.round((spanMs - durationMs) / gaps)) };
}

export function replacePiece(pieces: LogoPiece[], next: LogoPiece): LogoPiece[] {
  return pieces.map((piece) => (piece.id === next.id ? next : piece));
}

/**
 * Apply a whole gesture's worth of retimes in one pass. A multi-clip drag has to land as
 * ONE update: applied one at a time it would be several undo steps for a single gesture,
 * and each intermediate list would briefly describe a show nobody asked for.
 */
export function retimePieces(
  pieces: LogoPiece[],
  moves: readonly { laneId: string; start: number; end: number }[]
): LogoPiece[] {
  if (moves.length === 0) return pieces;
  const byLane = new Map(moves.map((move) => [move.laneId, move]));
  return pieces.map((piece) => {
    const move = byLane.get(piece.id);
    return move ? retimePiece(piece, move.start, move.end) : piece;
  });
}

/** When the last non-looping piece finishes, in seconds. */
export function introEndSec(pieces: LogoPiece[]): number {
  return pieces
    .filter((piece) => !piece.loop)
    .reduce((latest, piece) => Math.max(latest, pieceBlock(piece).end), 0);
}

/**
 * The timing table as pasteable source for the renderer's `T` constants
 * (tools/logo-video/render-logo-intro.mjs in the distantfront project). Emitting the
 * numbers the renderer already names is the whole point of the round trip — a table
 * that needed hand-translation would just be a second place to make a mistake.
 */
export function timingSource(pieces: LogoPiece[]): string {
  const rows = pieces.flatMap((piece) => {
    const entries = [`    ${piece.id}: { delay: ${piece.delayMs}, duration: ${piece.durationMs}`];
    if (piece.stepMs > 0) entries.push(`, step: ${piece.stepMs}`);
    entries.push(" }");
    return entries.join("");
  });
  return `  var T = {\n${rows.join(",\n")}\n  };`;
}
