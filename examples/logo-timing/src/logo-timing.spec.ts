import { describe, expect, it } from "vitest";
import {
  DEFAULT_PIECES,
  MIN_PIECE_MS,
  introEndSec,
  pieceBlock,
  pieceSpanMs,
  replacePiece,
  retimePiece,
  retimePieces,
  timingFile,
  timingJson
} from "./logo-timing";

const piece = (id: string) => {
  const found = DEFAULT_PIECES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no piece ${id}`);
  return found;
};

describe("logo timing model", () => {
  it("reproduces the authored intro", () => {
    // Straight off distant_front_logo_intro.html: the dagger drops at 1050 for 450 ms,
    // so it lands at 1.5 s and the landing shake starts there.
    expect(pieceBlock(piece("dagger"))).toEqual({ start: 1.05, end: 1.5 });
    expect(piece("landing-shake").delayMs).toBe(1500);
    expect(introEndSec(DEFAULT_PIECES)).toBeCloseTo(3.51, 5);
  });

  it("spans a stagger from the first element's start to the last one's end", () => {
    const letters = piece("distant-letters");
    expect(letters.targets).toHaveLength(7);
    expect(pieceSpanMs(letters)).toBe(6 * 70 + 200);
  });

  it("ignores the looping idle glow when asking where the intro ends", () => {
    // The glow repeats forever; if it counted, the answer would be its nominal period.
    expect(piece("idle-glow").loop).toBe(true);
    expect(introEndSec(DEFAULT_PIECES)).toBeLessThan(pieceBlock(piece("idle-glow")).end);
  });

  it("moves a piece by its block start", () => {
    const moved = retimePiece(piece("dagger"), 2, 2.45);
    expect(moved.delayMs).toBe(2000);
    expect(moved.durationMs).toBe(450);
  });

  it("resizes a single-target piece by changing its duration", () => {
    expect(retimePiece(piece("dagger"), 1.05, 1.85).durationMs).toBe(800);
  });

  it("resizes a stagger by spreading the step, not by stretching each letter", () => {
    // The letter pop stays 200 ms; what a wider block buys is a slower chase.
    const spread = retimePiece(piece("distant-letters"), 2.19, 3.39);
    expect(spread.durationMs).toBe(200);
    expect(spread.stepMs).toBe(Math.round((1200 - 200) / 6));
    // The step is whole milliseconds, so the span lands within one rounding per gap
    // of what was dragged — 1202 here, not 1200.
    expect(Math.abs(pieceSpanMs(spread) - 1200)).toBeLessThanOrEqual(6);
  });

  it("collapses a stagger to simultaneous rather than to a negative step", () => {
    const squashed = retimePiece(piece("distant-letters"), 0, 0.1);
    expect(squashed.stepMs).toBe(0);
    expect(squashed.durationMs).toBeGreaterThanOrEqual(MIN_PIECE_MS);
  });

  it("refuses to resize a block below the clickable minimum", () => {
    expect(retimePiece(piece("dagger"), 1, 1).durationMs).toBe(MIN_PIECE_MS);
  });

  it("never lets a drag push a piece before zero", () => {
    expect(retimePiece(piece("dagger"), -3, -2.5).delayMs).toBe(0);
  });

  it("replaces one piece and leaves the rest identical", () => {
    const next = retimePiece(piece("flash"), 4, 4.4);
    const list = replacePiece(DEFAULT_PIECES, next);
    expect(list).toHaveLength(DEFAULT_PIECES.length);
    expect(list.find((p) => p.id === "flash")?.delayMs).toBe(4000);
    expect(list.find((p) => p.id === "dagger")).toBe(piece("dagger"));
  });

  it("exports a step only for pieces that have one", () => {
    const file = timingFile(DEFAULT_PIECES);
    expect(file.pieces.dagger).toEqual({ delay: 1050, duration: 450 });
    expect(file.pieces["distant-letters"]).toEqual({ delay: 2190, duration: 200, step: 70 });
  });

  it("serialises to valid JSON that round-trips", () => {
    // The printer this replaced emitted a `var T` literal with hyphenated ids as unquoted
    // keys, so its output did not parse at all. Parsing the export is the regression test.
    const parsed = JSON.parse(timingJson(DEFAULT_PIECES));
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.pieces)).toHaveLength(DEFAULT_PIECES.length);
    expect(parsed.pieces["impact-shake"].delay).toBe(550);
  });

  it("names every piece the renderer has to place", () => {
    // A piece missing from the file is a piece the renderer would fall back on, silently.
    const file = timingFile(DEFAULT_PIECES);
    for (const piece of DEFAULT_PIECES) expect(file.pieces[piece.id]).toBeDefined();
  });
});

describe("applying a whole gesture", () => {
  it("retimes every piece named by the moves and leaves the rest alone", () => {
    const next = retimePieces(DEFAULT_PIECES, [
      { laneId: "dagger", start: 2, end: 2.45 },
      { laneId: "flash", start: 4, end: 4.42 }
    ]);
    expect(next.find((p) => p.id === "dagger")?.delayMs).toBe(2000);
    expect(next.find((p) => p.id === "flash")?.delayMs).toBe(4000);
    expect(next.find((p) => p.id === "mountains")).toBe(piece("mountains"));
  });

  it("preserves a stagger's step when the whole block is shifted", () => {
    // A shift keeps the span, so the step it is solved from is unchanged. Only a RESIZE
    // is allowed to respread the letters.
    const block = pieceBlock(piece("distant-letters"));
    const [moved] = retimePieces(DEFAULT_PIECES, [
      { laneId: "distant-letters", start: block.start + 0.4, end: block.end + 0.4 }
    ]).filter((p) => p.id === "distant-letters");
    expect(moved?.stepMs).toBe(70);
    expect(moved?.durationMs).toBe(200);
    expect(moved?.delayMs).toBe(2590);
  });

  it("returns the same list when nothing moved", () => {
    expect(retimePieces(DEFAULT_PIECES, [])).toBe(DEFAULT_PIECES);
  });
});
