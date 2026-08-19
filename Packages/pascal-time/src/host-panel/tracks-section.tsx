// The track list and the per-track editors: transform tracks open the reused keyframe curve
// editor, activation tracks open a clip editor (start/end per clip, add at playhead, delete).
// The write discipline is the section's whole reason to exist as one file: the curve editor
// fires onChange per pointer-move, so edits buffer in a draft and the pointerup — which pointer
// capture guarantees bubbles back through the wrapper — commits ONE putTrack; number inputs
// commit on blur. One gesture, one undo entry, always. Rotation keys also get an easing editor
// (M1.8): slerp has no per-axis tangents to drag, so that curve has no on-canvas handle.
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import {
  KeyframeCurveEditor,
  type CurveChannel,
  type CurveChannelKey,
  type CurveKeySelection
} from "@huma/path-creator/timeline-ui";
import type { Easing } from "@huma/path-creator/core";
import { deleteTrack, putTrack, type StoredTimeline } from "../plugin/timeline-io";
import type { PersistedTrack } from "../plugin/tracks";
import { pascalTimeTransport } from "../transport/store";
import { formatSeconds, styles, useNodeLabel } from "./panel-shared";
import { BufferedEasingEditor } from "./shot-camera-section";

type TransformTrack = Extract<PersistedTrack, { type: "transform" }>;
type ActivationTrack = Extract<PersistedTrack, { type: "activation" }>;
type ObjectTrack = TransformTrack | ActivationTrack;
type TransformChannelName = "position" | "rotation" | "scale";

const CHANNELS: {
  name: TransformChannelName;
  label: string;
  dash?: string;
  tangents: boolean;
}[] = [
  { name: "position", label: "P", tangents: true },
  // Rotation slerps with one shared easing — tangent handles would be silently discarded.
  { name: "rotation", label: "R", dash: "2 3", tangents: false },
  { name: "scale", label: "S", dash: "6 3", tangents: true }
];
const AXIS_COLORS = ["#f87171", "#4ade80", "#60a5fa"];

// ---------- persisted keys <-> curve editor keys ----------
// Structurally identical; the persisted schema is deliberately wider on `easing` (zod infers
// plain string for presets) and stores JSON's `null` where the editor uses undefined holes.

function toEditorKeys(keys: readonly Record<string, unknown>[] | undefined): CurveChannelKey[] {
  return (keys ?? []).map((key) => {
    const tangents = key.tangentsAxes as ({ in?: unknown; out?: unknown } | null)[] | undefined;
    return {
      ...key,
      tangentsAxes: tangents?.map((axis) => axis ?? undefined)
    } as CurveChannelKey;
  });
}

function fromEditorKeys(keys: CurveChannelKey[]): TransformTrack["position"] {
  return keys.map((key) => ({
    ...key,
    value: [key.value[0] ?? 0, key.value[1] ?? 0, key.value[2] ?? 0]
  })) as TransformTrack["position"];
}

/**
 * The curve editor over one transform track, with per-gesture write batching (see the file
 * header). Keyboard edits (Delete) arrive with no pointer down and commit immediately.
 */
function TrackCurves({
  stored,
  track
}: {
  stored: StoredTimeline;
  track: TransformTrack;
}): ReactNode {
  const time = useStore(pascalTimeTransport, (s) => s.time);
  const [draft, setDraft] = useState<TransformTrack | null>(null);
  const draftRef = useRef<TransformTrack | null>(null);
  const pointerDown = useRef(false);
  // Which key the canvas has selected. Rotation slerps with one shared `easing` per key and the
  // canvas deliberately disables tangent handles there, so that curve is only editable if the
  // panel knows which key is selected — which is what `onSelectKey` reports.
  const [selectedKey, setSelectedKey] = useState<CurveKeySelection | null>(null);
  const [shown, setShown] = useState<Record<TransformChannelName, boolean>>({
    position: true,
    rotation: false,
    scale: false
  });

  // The document changed under the editor (undo, another writer): drop a stale draft.
  useEffect(() => {
    draftRef.current = null;
    setDraft(null);
  }, [track]);

  const current = draft ?? track;

  const commit = (): void => {
    if (!draftRef.current) return;
    putTrack(stored.id, draftRef.current);
    draftRef.current = null;
    setDraft(null);
  };

  const applyChannel = (name: TransformChannelName, keys: CurveChannelKey[]): void => {
    const next: TransformTrack = {
      ...(draftRef.current ?? track),
      [name]: fromEditorKeys(keys)
    };
    if (pointerDown.current) {
      draftRef.current = next;
      setDraft(next);
    } else {
      draftRef.current = null;
      setDraft(null);
      putTrack(stored.id, next);
    }
  };

  // A draft must not outlive the editor (panel switch mid-drag would silently drop the edit).
  useEffect(() => () => commit(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const channels: CurveChannel[] = CHANNELS.filter((c) => shown[c.name]).map((c) => ({
    id: c.name,
    label: c.name,
    colors: AXIS_COLORS,
    componentLabels: ["x", "y", "z"],
    keys: toEditorKeys(current[c.name]),
    tangents: c.tangents,
    ...(c.dash ? { dash: c.dash } : {}),
    onChange: (keys) => applyChannel(c.name, keys)
  }));

  // The rotation key whose easing is editable right now: the canvas's selection, if it is on the
  // rotation channel and still exists (an undo can shorten the track under a live selection).
  const rotationKeys = current.rotation ?? [];
  const easingKeyIndex =
    selectedKey?.channelId === "rotation" && selectedKey.keyIndex < rotationKeys.length
      ? selectedKey.keyIndex
      : null;

  const commitRotationEasing = (keyIndex: number, easing: Easing): void => {
    // Reads the COMMITTED track, not the draft: an easing edit and a curve drag cannot overlap
    // (the drag's pointerup commits first), and spreading a draft here would persist a pose the
    // author was still moving.
    const keys = track.rotation ?? [];
    putTrack(stored.id, {
      ...track,
      rotation: keys.map((key, i) =>
        i === keyIndex ? { ...key, easing } : key
      ) as TransformTrack["rotation"]
    });
  };

  return (
    <>
      <div
        onPointerDownCapture={() => {
          pointerDown.current = true;
        }}
        onPointerUpCapture={() => {
          pointerDown.current = false;
          commit();
        }}
        onPointerCancelCapture={() => {
          pointerDown.current = false;
          commit();
        }}
      >
        <div style={{ ...styles.row, marginBottom: 6 }}>
          {CHANNELS.map((c) => (
            <button
              key={c.name}
              style={{ ...styles.chip, ...(shown[c.name] ? styles.chipOn : {}) }}
              type="button"
              aria-pressed={shown[c.name]}
              title={`Show the ${c.name} channel`}
              onClick={() => setShown((s) => ({ ...s, [c.name]: !s[c.name] }))}
            >
              {c.label}
            </button>
          ))}
          <span style={{ ...styles.muted, fontSize: 11, marginLeft: "auto" }}>
            drag key · dbl-click add/del
          </span>
        </div>
        <KeyframeCurveEditor
          channels={channels}
          timeStart={0}
          timeEnd={stored.durationSeconds}
          playhead={time}
          height={150}
          snap={0.05}
          onSelectKey={setSelectedKey}
        />
      </div>
      {/* Outside the wrapper above on purpose: this editor batches its own gesture, and nesting
          it would run both commit paths on one pointerup. */}
      {shown.rotation ? (
        <div style={{ marginTop: 6 }} data-rotation-easing={easingKeyIndex ?? "none"}>
          {easingKeyIndex === null ? (
            <span style={styles.muted}>
              Select a rotation key to shape how it slerps in.
            </span>
          ) : (
            <>
              <span style={styles.muted}>
                Rotation key {easingKeyIndex + 1} at{" "}
                {formatSeconds(rotationKeys[easingKeyIndex]!.time)} s — easing into this key.
              </span>
              <BufferedEasingEditor
                value={(rotationKeys[easingKeyIndex]!.easing as Easing | undefined) ?? "linear"}
                height={120}
                onCommit={(easing) => commitRotationEasing(easingKeyIndex, easing)}
              />
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

/** One start/end field. Commits on blur/Enter as one whole-track write. */
function ClipTimeField({
  value,
  label,
  onCommit
}: {
  value: number;
  label: string;
  onCommit: (next: number) => void;
}): ReactNode {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      style={styles.numberInput}
      value={text ?? String(value)}
      aria-label={label}
      inputMode="decimal"
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (text === null) return;
        const parsed = Number(text);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed !== value) onCommit(parsed);
        setText(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
      }}
    />
  );
}

/** The activation track's clips: visible inside a clip, hidden outside all of them. */
function ClipEditor({
  stored,
  track
}: {
  stored: StoredTimeline;
  track: ActivationTrack;
}): ReactNode {
  const time = useStore(pascalTimeTransport, (s) => s.time);

  const writeClips = (clips: ActivationTrack["clips"]): void => {
    putTrack(stored.id, { ...track, clips: [...clips].sort((a, b) => a.start - b.start) });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {track.clips.map((clip) => (
        <div key={clip.id} style={styles.listRow}>
          <span style={{ ...styles.muted, fontSize: 11 }}>visible</span>
          <ClipTimeField
            value={clip.start}
            label="Clip start seconds"
            onCommit={(start) =>
              writeClips(track.clips.map((c) => (c.id === clip.id ? { ...c, start } : c)))
            }
          />
          <span style={{ ...styles.muted, fontSize: 11 }}>to</span>
          <ClipTimeField
            value={clip.end}
            label="Clip end seconds"
            onCommit={(end) =>
              writeClips(track.clips.map((c) => (c.id === clip.id ? { ...c, end } : c)))
            }
          />
          <span style={{ ...styles.muted, fontSize: 11 }}>s</span>
          <button
            style={{ ...styles.iconButton, marginLeft: "auto" }}
            type="button"
            aria-label="Delete clip"
            title="Delete this clip"
            onClick={() => writeClips(track.clips.filter((c) => c.id !== clip.id))}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        style={styles.smallButton}
        type="button"
        onClick={() => {
          const taken = new Set(track.clips.map((c) => c.id));
          let id = `clip_${track.clips.length + 1}`;
          for (let n = track.clips.length + 2; taken.has(id); n += 1) id = `clip_${n}`;
          writeClips([...track.clips, { id, start: time, end: stored.durationSeconds }]);
        }}
      >
        + clip @ {formatSeconds(time)} s
      </button>
    </div>
  );
}

export function TracksSection({
  stored,
  selectedTrackId,
  onSelectTrack
}: {
  stored: StoredTimeline;
  selectedTrackId: string | null;
  onSelectTrack: (id: string | null) => void;
}): ReactNode {
  const label = useNodeLabel();

  const objectTracks = stored.tracks.filter(
    (track): track is ObjectTrack =>
      track.type === "transform" || track.type === "activation"
  );
  const selected = objectTracks.find((track) => track.id === selectedTrackId) ?? null;

  if (objectTracks.length === 0) {
    return <div style={styles.muted}>No tracks yet — select an object and key its pose.</div>;
  }

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {objectTracks.map((track) => {
          const isSelected = track.id === selectedTrackId;
          const detail =
            track.type === "transform"
              ? `${track.position?.length ?? 0} key${(track.position?.length ?? 0) === 1 ? "" : "s"}`
              : `${track.clips.length} clip${track.clips.length === 1 ? "" : "s"}`;
          return (
            <div
              key={track.id}
              style={{ ...styles.listRow, ...(isSelected ? styles.listRowSelected : {}), cursor: "pointer" }}
              onClick={() => onSelectTrack(isSelected ? null : track.id)}
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
            >
              <span style={{ ...styles.muted, fontSize: 11 }}>
                {track.type === "transform" ? "◆" : "◎"}
              </span>
              <span style={styles.rowName}>{label(track.objectId)}</span>
              <span style={{ ...styles.muted, fontSize: 11 }}>{detail}</span>
              <button
                style={styles.iconButton}
                type="button"
                aria-label={`Delete track for ${label(track.objectId)}`}
                title="Delete this track (one undo entry)"
                onClick={(event) => {
                  event.stopPropagation();
                  deleteTrack(stored.id, track.id);
                  if (isSelected) onSelectTrack(null);
                }}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
      {selected?.type === "transform" ? <TrackCurves stored={stored} track={selected} /> : null}
      {selected?.type === "activation" ? <ClipEditor stored={stored} track={selected} /> : null}
    </>
  );
}
