// The timeline panel Pascal's editor mounts in its icon rail — the authoring surface of M1.3.
// Transport (play/pause/stop/scrub + preview toggle), keyframe capture for the viewport
// selection, the track list, and the reused @huma/path-creator curve editor over the selected
// track. Every document write goes through timeline-io/scene-ops and is batched per GESTURE:
// the curve editor fires onChange per pointer-move, so edits buffer in a draft and commit as
// ONE putTrack on release — one undo entry per drag, never per frame. Receives no props.
"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import { useStore } from "zustand";
import { useScene } from "@pascal-app/core";
import { useViewer } from "@pascal-app/editor";
import {
  KeyframeCurveEditor,
  type CurveChannel,
  type CurveChannelKey
} from "@huma/path-creator/timeline-ui";
import { TIMELINE_KIND } from "../plugin/kinds";
import { buildTimelineNode, createPluginNode, updatePluginNode } from "../plugin/scene-ops";
import { installPascalTimeOnScene } from "../plugin/install";
import { captureTransformKey } from "../plugin/keying";
import {
  deleteTrack,
  putTrack,
  readStoredTimeline,
  type StoredTimeline
} from "../plugin/timeline-io";
import type { PersistedTrack } from "../plugin/tracks";
import { pascalTimeTransport } from "../transport/store";

type TransformPersistedTrack = Extract<PersistedTrack, { type: "transform" }>;
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

const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 14,
    fontSize: 13,
    color: "var(--sidebar-foreground, #ddd)"
  },
  title: { fontWeight: 600, fontSize: 13, flex: 1, minWidth: 0 },
  muted: { opacity: 0.55, fontSize: 12, lineHeight: 1.5 },
  row: { display: "flex", alignItems: "center", gap: 6 },
  button: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "5px 9px",
    borderRadius: 6,
    // Longhands, not the `border` shorthand: buttonActive overrides borderColor alone, and
    // React (correctly) warns when a shorthand and its longhand fight across rerenders.
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--sidebar-border, #444)",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap"
  },
  buttonActive: {
    background: "var(--sidebar-accent, rgba(249,115,22,0.18))",
    borderColor: "var(--primary, #f97316)"
  },
  time: {
    fontVariantNumeric: "tabular-nums",
    fontSize: 12,
    opacity: 0.85,
    marginLeft: "auto",
    whiteSpace: "nowrap"
  },
  scrubber: { width: "100%", accentColor: "var(--primary, #f97316)" },
  durationInput: {
    width: 56,
    padding: "3px 6px",
    borderRadius: 6,
    border: "1px solid var(--sidebar-border, #444)",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    fontSize: 12,
    textAlign: "right"
  },
  trackRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 8px",
    borderRadius: 6,
    cursor: "pointer",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent"
  },
  trackRowSelected: {
    background: "var(--sidebar-accent, rgba(249,115,22,0.12))",
    borderColor: "var(--sidebar-border, #444)"
  },
  trackName: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 12
  },
  iconButton: {
    border: "none",
    background: "transparent",
    color: "inherit",
    opacity: 0.5,
    cursor: "pointer",
    fontSize: 12,
    padding: "0 2px"
  },
  chip: {
    padding: "2px 7px",
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--sidebar-border, #444)",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    fontSize: 11,
    cursor: "pointer",
    opacity: 0.5
  },
  chipOn: { opacity: 1, borderColor: "var(--primary, #f97316)" }
} satisfies Record<string, CSSProperties>;

const formatSeconds = (value: number): string => value.toFixed(2);

/** The scene's timeline node id, reactively. First one wins; one clock per scene by design. */
function useSceneTimelineId(): string | null {
  const nodes = useScene((state) => state.nodes);
  return useMemo(() => {
    for (const [id, node] of Object.entries(nodes)) {
      if ((node as { type?: string }).type === TIMELINE_KIND) return id;
    }
    return null;
  }, [nodes]);
}

/** The stored timeline, re-read when the document changes (edits, undo, redo alike). */
function useStoredTimeline(timelineId: string | null): StoredTimeline | null {
  const nodes = useScene((state) => state.nodes);
  return useMemo(
    () => (timelineId ? readStoredTimeline(timelineId) : null),
    // `nodes` is the document-changed signal, not an input readStoredTimeline takes.
    [timelineId, nodes] // eslint-disable-line react-hooks/exhaustive-deps
  );
}

/** Display name for a node id: its authored name, its kind, or the raw id. */
function useNodeLabel(): (id: string) => string {
  const nodes = useScene((state) => state.nodes);
  return useMemo(
    () =>
      (id: string): string => {
        const node = nodes[id as keyof typeof nodes] as
          | { name?: string; type?: string }
          | undefined;
        return node?.name || node?.type || id;
      },
    [nodes]
  );
}

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

function fromEditorKeys(keys: CurveChannelKey[]): TransformPersistedTrack["position"] {
  return keys.map((key) => ({
    ...key,
    value: [key.value[0] ?? 0, key.value[1] ?? 0, key.value[2] ?? 0]
  })) as TransformPersistedTrack["position"];
}

// ---------- panel sections ----------

function EmptyState(): ReactNode {
  return (
    <div style={styles.root}>
      <div style={styles.title}>Timeline</div>
      <p style={styles.muted}>
        This scene has no timeline yet. A timeline is the scene&apos;s clock — keyframes, cues
        and camera shots are all measured on it.
      </p>
      <button
        style={styles.button}
        type="button"
        onClick={() => {
          // One authored action: opt the scene into the plugin's kinds and place the clock.
          // Node creation is a document edit, so Pascal's undo owns it — Ctrl+Z removes it.
          installPascalTimeOnScene();
          createPluginNode(buildTimelineNode({ name: "Timeline" }));
        }}
      >
        Create timeline
      </button>
    </div>
  );
}

/** Duration edits commit on blur/Enter as one node update — not per keystroke. */
function DurationField({ stored }: { stored: StoredTimeline }): ReactNode {
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
        style={styles.durationInput}
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

function Transport({ stored }: { stored: StoredTimeline }): ReactNode {
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

/** The keyframe-capture affordance: key the viewport selection's live pose at the playhead. */
function KeyButton({ stored }: { stored: StoredTimeline }): ReactNode {
  const selectedIds = useViewer((s) => s.selection.selectedIds);
  const time = useStore(pascalTimeTransport, (s) => s.time);
  const driving = useStore(pascalTimeTransport, (s) => s.driving);
  const label = useNodeLabel();
  const target = selectedIds[0] ?? null;
  // The timeline's own kinds have no pose to key; keying the clock would be a loop.
  const keyable = target !== null && !target.startsWith("humatime_");

  return (
    <div style={styles.row}>
      <button
        style={{ ...styles.button, opacity: keyable ? 1 : 0.4 }}
        type="button"
        disabled={!keyable}
        onClick={() => {
          if (target) captureTransformKey(stored.id, target, time);
        }}
        title={
          keyable
            ? `Key ${label(target)}'s current pose at ${formatSeconds(time)} s`
            : "Select an object in the viewport to key it"
        }
      >
        ◆ Key {keyable ? label(target) : "selection"} @ {formatSeconds(time)} s
      </button>
      {keyable && driving ? (
        <span style={{ ...styles.muted, fontSize: 11 }} title="The pose you see is the track's, not one you set. Turn Preview off to pose the object first.">
          driven pose
        </span>
      ) : null}
    </div>
  );
}

function TrackList({
  stored,
  selectedTrackId,
  onSelect
}: {
  stored: StoredTimeline;
  selectedTrackId: string | null;
  onSelect: (id: string | null) => void;
}): ReactNode {
  const label = useNodeLabel();
  const transformTracks = stored.tracks.filter(
    (track): track is TransformPersistedTrack => track.type === "transform"
  );
  if (transformTracks.length === 0) {
    return <div style={styles.muted}>No tracks yet — select an object and key its pose.</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {transformTracks.map((track) => {
        const selected = track.id === selectedTrackId;
        const keyCount = track.position?.length ?? 0;
        return (
          <div
            key={track.id}
            style={{ ...styles.trackRow, ...(selected ? styles.trackRowSelected : {}) }}
            onClick={() => onSelect(selected ? null : track.id)}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
          >
            <span style={styles.trackName}>{label(track.objectId)}</span>
            <span style={{ ...styles.muted, fontSize: 11 }}>
              {keyCount} key{keyCount === 1 ? "" : "s"}
            </span>
            <button
              style={styles.iconButton}
              type="button"
              aria-label={`Delete track for ${label(track.objectId)}`}
              title="Delete this track (one undo entry)"
              onClick={(event) => {
                event.stopPropagation();
                deleteTrack(stored.id, track.id);
                if (selected) onSelect(null);
              }}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The curve editor over one track, with per-gesture write batching. The editor is controlled
 * and fires onChange on every pointer move; committing each would flood Pascal's undo history
 * (its granularity is store operations). So while a pointer is down the edits land in a local
 * draft, and the pointerup — which pointer capture guarantees bubbles back through this
 * wrapper — commits the draft as one putTrack. Keyboard edits (Delete) commit immediately.
 */
function TrackCurves({
  stored,
  track
}: {
  stored: StoredTimeline;
  track: TransformPersistedTrack;
}): ReactNode {
  const time = useStore(pascalTimeTransport, (s) => s.time);
  const [draft, setDraft] = useState<TransformPersistedTrack | null>(null);
  const draftRef = useRef<TransformPersistedTrack | null>(null);
  const pointerDown = useRef(false);
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
    const next: TransformPersistedTrack = {
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

  return (
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
      />
    </div>
  );
}

export default function TimelinePanel(): ReactNode {
  const timelineId = useSceneTimelineId();
  const stored = useStoredTimeline(timelineId);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);

  // Keep the shared transport pointed at the scene's clock. setTimeline is a no-op on the
  // same id, so this is safe to run on every document change.
  useEffect(() => {
    pascalTimeTransport.getState().setTimeline(timelineId);
  }, [timelineId]);

  if (!timelineId || !stored) return <EmptyState />;

  const selectedTrack =
    stored.tracks.find(
      (track): track is TransformPersistedTrack =>
        track.type === "transform" && track.id === selectedTrackId
    ) ?? null;

  return (
    <div style={styles.root}>
      <div style={styles.row}>
        <div style={styles.title}>{stored.name}</div>
        <DurationField stored={stored} />
      </div>
      <Transport stored={stored} />
      <KeyButton stored={stored} />
      <TrackList
        stored={stored}
        selectedTrackId={selectedTrackId}
        onSelect={setSelectedTrackId}
      />
      {selectedTrack ? <TrackCurves stored={stored} track={selectedTrack} /> : null}
      <div style={styles.muted}>
        {stored.tracks.length} track{stored.tracks.length === 1 ? "" : "s"}
        {stored.loop ? " · loops" : ""}
      </div>
    </div>
  );
}
