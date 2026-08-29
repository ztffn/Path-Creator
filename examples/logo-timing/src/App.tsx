// TimelineLanes driving something that is not a camera: one lane per animated element
// of an SVG logo intro, where a block's position is the element's delay and its width is
// how long it takes (or, for the two wordmarks, how fast the letters chase each other).
// The host owns the clock and the model; the component only reports drags. The export
// panel prints the edited timings back as source for the offline renderer.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  TimelineLanes,
  rippleClips,
  type ExtraClipMove,
  type ExtraLane
} from "@huma/path-creator/timeline-ui";
import { createTimelinePlayer } from "@huma/path-creator/timeline";
import { LogoStage, type LogoStageHandle } from "./logo-stage";
import {
  DEFAULT_PIECES,
  introEndSec,
  pieceBlock,
  retimePieces,
  timingJson,
  type LogoPiece
} from "./logo-timing";

/** A little air after the last piece so the settle is scrubbable. */
const TAIL_SECONDS = 1.5;
/** 10 ms: the intro's own numbers are 50-80 ms apart, so a coarser grid cannot hit them. */
const SNAP_SECONDS = 0.01;

const THEME = {
  panelBackground: "#12140e",
  panelBorder: "rgba(147, 127, 96, 0.35)",
  text: "#dbd5ca",
  mutedText: "#8b8a78",
  subtleText: "#6b6a5a",
  accent: "rgba(147, 127, 96, 0.9)",
  accentSoft: "rgba(147, 127, 96, 0.22)",
  activeBorder: "rgba(219, 213, 202, 0.9)"
};

export function App() {
  const [pieces, setPieces] = useState<LogoPiece[]>(DEFAULT_PIECES);
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(null);
  const [selectedClipKeys, setSelectedClipKeys] = useState<string[]>([]);
  const [showSource, setShowSource] = useState(false);
  const [playing, setPlaying] = useState(false);
  const stageRef = useRef<LogoStageHandle>(null);
  const playerRef = useRef(createTimelinePlayer({ loop: true }));

  const duration = useMemo(() => introEndSec(pieces) + TAIL_SECONDS, [pieces]);
  const durationRef = useRef(duration);
  durationRef.current = duration;

  // One rAF owns the clock AND the preview: the lane component slaves its own cursor to
  // playerRef, so advancing this record is the only thing that has to happen per frame.
  // `activeAt` is published back to React at a coarse rate purely so the block under the
  // playhead can light up — re-rendering the lanes every frame to move an outline would
  // be the most expensive thing on the page.
  const [activeAt, setActiveAt] = useState(0);
  useEffect(() => {
    let previous: number | null = null;
    let published = -1;
    let raf = 0;
    const frame = (now: number) => {
      const player = playerRef.current;
      if (player.playing && previous !== null) {
        player.time += ((now - previous) / 1000) * player.rate;
        if (player.time >= durationRef.current) player.time = player.loop ? 0 : durationRef.current;
      }
      previous = now;
      stageRef.current?.seek(player.time * 1000);
      if (Math.abs(player.time - published) > 0.05) {
        published = player.time;
        setActiveAt(player.time);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  const extraLanes = useMemo<ExtraLane[]>(
    () =>
      pieces.map((piece) => {
        const block = pieceBlock(piece);
        return {
          id: piece.id,
          name: piece.label,
          color: piece.color,
          icon: piece.icon,
          clips: [
            {
              id: "clip",
              start: block.start,
              end: block.end,
              label: piece.label,
              active: activeAt >= block.start && activeAt <= block.end
            }
          ]
        };
      }),
    [pieces, activeAt]
  );

  /** Insert or remove time at the playhead: everything starting after it shifts. */
  const ripple = (deltaSeconds: number) => {
    const clips: ExtraClipMove[] = pieces.map((piece) => ({
      laneId: piece.id,
      clipId: "clip",
      ...pieceBlock(piece)
    }));
    setPieces((current) => retimePieces(current, rippleClips(clips, playerRef.current.time, deltaSeconds)));
  };

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "#0b0c08",
        color: "#dbd5ca",
        fontFamily: "ui-sans-serif, system-ui, sans-serif"
      }}
    >
      <header style={{ padding: "10px 14px", display: "flex", alignItems: "baseline", gap: 12 }}>
        <strong style={{ letterSpacing: "0.18em", fontSize: 13 }}>LOGO TIMING</strong>
        <span style={{ fontSize: 12, color: "#8b8a78" }}>
          Drag a block to move it, an edge to retime it. Rubber-band or shift-click to select
          several; arrow keys nudge.
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={() => ripple(-0.1)} title="Pull everything after the playhead 100 ms earlier">
            &minus;100 ms after playhead
          </button>
          <button onClick={() => ripple(0.1)} title="Push everything after the playhead 100 ms later">
            +100 ms after playhead
          </button>
          <button onClick={() => setShowSource((open) => !open)}>
            {showSource ? "Hide JSON" : "Export timings"}
          </button>
          <button
            onClick={() => {
              // A real file, because the renderer reads one — copying JSON out of a <pre>
              // is the step where a timing quietly loses a digit.
              const url = URL.createObjectURL(
                new Blob([timingJson(pieces)], { type: "application/json" })
              );
              const link = document.createElement("a");
              link.href = url;
              link.download = "logo-timing.json";
              link.click();
              URL.revokeObjectURL(url);
            }}
            title="Save logo-timing.json for tools/logo-video/render-logo-intro.mjs"
          >
            Download JSON
          </button>
          <button
            onClick={() => {
              setPieces(DEFAULT_PIECES);
              setSelectedLaneId(null);
            }}
          >
            Reset
          </button>
        </span>
      </header>

      <LogoStage ref={stageRef} pieces={pieces} />

      {showSource && (
        <pre
          style={{
            margin: 0,
            padding: "10px 14px",
            maxHeight: 180,
            overflow: "auto",
            fontSize: 12,
            background: "#0f100b",
            borderTop: "1px solid rgba(147, 127, 96, 0.35)",
            color: "#c8c2b4"
          }}
        >
          {timingJson(pieces)}
        </pre>
      )}

      <TimelineLanes
        playerRef={playerRef}
        duration={duration}
        driving={playing}
        theme={THEME}
        extraLanes={extraLanes}
        selectedLaneId={selectedLaneId}
        onSelectLane={setSelectedLaneId}
        selectedClipKeys={selectedClipKeys}
        onSelectClips={setSelectedClipKeys}
        // The three props this use case needed the component to grow: no camera track,
        // every lane visible at once, and a grid fine enough to express 50 ms.
        showShotLane={false}
        maxVisibleLanes={pieces.length}
        snapSeconds={SNAP_SECONDS}
        scaleSeconds={0.5}
        showCartShotEntry={false}
        showDollyEntries={false}
        // One write per gesture, whether it moved one block or nine.
        onExtraClipsTiming={(moves) => setPieces((current) => retimePieces(current, moves))}
        onSeek={(time) => {
          playerRef.current.time = time;
        }}
        onTransport={() => setPlaying(playerRef.current.playing)}
      />
    </div>
  );
}
