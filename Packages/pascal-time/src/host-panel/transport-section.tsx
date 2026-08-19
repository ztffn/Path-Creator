// The panel's transport: play/pause/stop, the preview/edit toggle, the duration field, and the
// scrubber with cue/shot markers laid over it. Preview is the one concept an author has to
// learn — ON, scrubbing shows the animation (the timeline owns the scene); OFF, the playhead
// parks so tracked objects can be posed with Pascal's own tools and then keyed. Duration edits
// commit on blur as one node update. Markers seek on click; they never move nodes themselves.
"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { useStore } from "zustand";
import { updatePluginNode } from "../plugin/scene-ops";
import type { StoredTimeline } from "../plugin/timeline-io";
import { pascalTimeTransport } from "../transport/store";
import { formatSeconds, styles } from "./panel-shared";

export interface TimeMarker {
  id: string;
  name: string;
  timeSeconds: number;
  kind: "cue" | "shot";
  /** Where clicking lands. Shots seek past their blend — at timeSeconds they are still 100%
   *  the previous shot; cues seek their exact moment. Defaults to timeSeconds. */
  seekSeconds?: number;
}

/** Duration edits commit on blur/Enter as one node update — not per keystroke. */
export function DurationField({ stored }: { stored: StoredTimeline }): ReactNode {
  const [text, setText] = useState<string | null>(null);
  const commit = (): void => {
    if (text === null) return;
    const parsed = Number(text);
    if (Number.isFinite(parsed) && parsed > 0 && parsed !== stored.durationSeconds) {
      updatePluginNode(stored.id, { durationSeconds: parsed });
    }
    setText(null);
  };
  return (
    <label style={{ ...styles.row, gap: 4 }} title="Timeline duration in seconds">
      <input
        style={styles.numberInput}
        value={text ?? String(stored.durationSeconds)}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
        inputMode="decimal"
        aria-label="Timeline duration in seconds"
      />
      <span style={styles.muted}>s</span>
    </label>
  );
}

const markerStyle = (marker: TimeMarker, duration: number): CSSProperties => ({
  position: "absolute",
  left: `${duration > 0 ? (Math.min(marker.timeSeconds, duration) / duration) * 100 : 0}%`,
  transform: "translateX(-50%)",
  cursor: "pointer",
  fontSize: 9,
  lineHeight: "10px",
  color:
    marker.kind === "cue" ? "var(--primary, #f97316)" : "var(--sidebar-foreground, #94a3b8)",
  background: "transparent",
  border: "none",
  padding: 0
});

/** The cue/shot strip above the scrubber. Click a marker to seek to its moment. */
function MarkerStrip({
  markers,
  duration
}: {
  markers: TimeMarker[];
  duration: number;
}): ReactNode {
  if (markers.length === 0) return null;
  return (
    <div style={{ position: "relative", height: 10, margin: "0 2px" }}>
      {markers.map((marker) => (
        <button
          key={marker.id}
          type="button"
          style={markerStyle(marker, duration)}
          title={`${marker.kind} "${marker.name}" @ ${formatSeconds(marker.timeSeconds)} s — click to seek`}
          aria-label={`${marker.kind} marker ${marker.name}`}
          onClick={() => pascalTimeTransport.getState().seek(marker.seekSeconds ?? marker.timeSeconds)}
        >
          {marker.kind === "cue" ? "◆" : "▲"}
        </button>
      ))}
    </div>
  );
}

export function TransportSection({
  stored,
  markers
}: {
  stored: StoredTimeline;
  markers: TimeMarker[];
}): ReactNode {
  const time = useStore(pascalTimeTransport, (s) => s.time);
  const playing = useStore(pascalTimeTransport, (s) => s.playing);
  const driving = useStore(pascalTimeTransport, (s) => s.driving);
  const preview = useStore(pascalTimeTransport, (s) => s.preview);
  const transport = pascalTimeTransport.getState();

  return (
    <>
      <div style={styles.row}>
        <button
          style={styles.button}
          type="button"
          onClick={() => (playing ? transport.pause() : transport.play())}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button
          style={{ ...styles.button, opacity: driving ? 1 : 0.4 }}
          type="button"
          disabled={!driving}
          onClick={() => transport.release()}
          title="Stop driving and hand every object back to its authored pose"
        >
          Stop
        </button>
        <button
          style={{ ...styles.button, ...(preview ? styles.buttonActive : {}) }}
          type="button"
          aria-pressed={preview}
          onClick={() => transport.setPreview(!preview)}
          title="Preview on: scrubbing shows the animation. Preview off (edit mode): the playhead parks without driving, so you can pose tracked objects and key them."
        >
          Preview
        </button>
        <span style={styles.time}>
          {formatSeconds(time)} / {formatSeconds(stored.durationSeconds)} s
        </span>
      </div>
      <MarkerStrip markers={markers} duration={stored.durationSeconds} />
      <input
        style={styles.scrubber}
        type="range"
        min={0}
        max={stored.durationSeconds}
        step={0.01}
        value={Math.min(time, stored.durationSeconds)}
        onChange={(event) => transport.seek(Number(event.target.value))}
        aria-label="Timeline position"
      />
    </>
  );
}
