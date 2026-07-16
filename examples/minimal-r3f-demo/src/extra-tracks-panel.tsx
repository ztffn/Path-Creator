// Left-panel authoring editors for the Activation, Audio, and Animation timeline
// tracks, one exported component each (they live in separate collapsible sections).
// Follows the demo panel idiom: each track is a header row of controls, and clips
// are number-input rows (start/end) like the dolly-runs editor. Controlled — each
// calls onChange with only the ExtraTracks slice it owns (merged at the App level,
// so track kinds it doesn't touch survive). The bottom TimelineLanes plays/scrubs it.
import { useState, type CSSProperties } from "react";
import { EASING_PRESETS, type Easing, type EasingCurve } from "@huma/path-creator/core";
import { EasingEditor, KeyframeCurveEditor, type CurveChannelKey } from "@huma/path-creator/timeline-ui";
import { IconVolume } from "./icons";
import type { ActivatableInfo } from "./activatables";
import {
  insertTransformKey,
  upsertTransformKey,
  snapSeconds,
  type ActivationTrack,
  type AnimationClip,
  type AnimationTrack,
  type AudioClip,
  type AudioTrack,
  type ExtraTracks,
  type PostPlaybackState,
  type TransformKey,
  type TransformTrack
} from "./extra-tracks";

// All analytic easing presets (parity with the audio/lens editors); "cut" is a step, meaningless between keyframes.
const EASING_OPTIONS = (Object.keys(EASING_PRESETS) as Easing[]).filter((p) => p !== "cut");

/** Full-volume envelope shown when a clip has no gainCurve yet. */
const FLAT_VOLUME: EasingCurve = { type: "curve", keys: [{ x: 0, y: 1 }, { x: 1, y: 1 }] };

/** Bundled sample voices under public/audio; new clips cycle through these (any URL also works). */
export const SAMPLE_AUDIO = [
  "/audio/jarvis.mp3",
  "/audio/morganfreeman.mp3",
  "/audio/samjackson.mp3",
  "/audio/samaltman.mp3",
  "/audio/fireship.mp3",
  "/audio/linus.mp3"
];

export const uid = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/** A blank activation track bound to `objectId` (shared by the panel + object inspector). */
export const newActivationTrack = (objectId: string): ActivationTrack => ({ type: "activation", id: uid("act"), objectId, clips: [], postPlaybackState: "revert" });

/** A blank animation track bound to `objectId` (shared by the panel + object inspector). */
export const newAnimationTrack = (objectId: string): AnimationTrack => ({ type: "animation", id: uid("anim"), objectId, clips: [] });

/** A blank transform track bound to `objectId` (shared by the panel + object inspector). */
export const newTransformTrack = (objectId: string): TransformTrack => ({ type: "transform", id: uid("xf"), objectId });

const POST_PLAYBACK_LABELS: Record<PostPlaybackState, string> = {
  revert: "Revert",
  active: "Active",
  inactive: "Inactive",
  leaveAsIs: "Leave As Is"
};

const headerRow: CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 12 };
const clipRow: CSSProperties = { display: "flex", alignItems: "center", gap: 3, fontSize: 11, paddingLeft: 10 };
const numInput: CSSProperties = { width: 46 };
const addClipBtn: CSSProperties = { justifySelf: "start", marginLeft: 10 };
const iconBtn: CSSProperties = { padding: "0 8px", flex: "0 0 auto" };

export interface ActivationEditorProps {
  activationTracks: ActivationTrack[];
  activatables: ActivatableInfo[];
  onChange: (next: Partial<ExtraTracks>) => void;
  /** Suppress the "Add track" button when the editor is scoped inside an inspector. */
  hideAdd?: boolean;
}

export function ActivationTracksEditor({ activationTracks, activatables, onChange, hideAdd = false }: ActivationEditorProps) {
  const emit = (next: ActivationTrack[]): void => onChange({ activationTracks: next });
  const patch = (id: string, p: Partial<ActivationTrack>): void => emit(activationTracks.map((t) => (t.id === id ? { ...t, ...p } : t)));

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {activationTracks.map((track) => (
        <div key={track.id} style={{ display: "grid", gap: 3 }}>
          <div style={headerRow}>
            <select style={{ flex: 1 }} value={track.objectId} title="Bound object" onChange={(e) => patch(track.id, { objectId: e.target.value })}>
              {activatables.length === 0 ? <option value="">(no objects)</option> : null}
              {activatables.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <select value={track.postPlaybackState} title="Post-Playback State" onChange={(e) => patch(track.id, { postPlaybackState: e.target.value as PostPlaybackState })}>
              {(Object.keys(POST_PLAYBACK_LABELS) as PostPlaybackState[]).map((state) => (
                <option key={state} value={state}>
                  {POST_PLAYBACK_LABELS[state]}
                </option>
              ))}
            </select>
            <button className="pc-danger" style={iconBtn} title="Delete track" onClick={() => emit(activationTracks.filter((t) => t.id !== track.id))}>
              ×
            </button>
          </div>
          {track.clips.map((clip) => (
            <div key={clip.id} style={clipRow}>
              <span style={{ width: 30, color: "rgba(232,238,245,0.34)" }}>clip</span>
              <input type="number" title="start (s)" value={clip.start} step={0.25} style={numInput}
                onChange={(e) => patch(track.id, { clips: track.clips.map((c) => (c.id === clip.id ? { ...c, start: snapSeconds(Number(e.target.value)) } : c)) })} />
              <input type="number" title="end (s)" value={clip.end} step={0.25} style={numInput}
                onChange={(e) => patch(track.id, { clips: track.clips.map((c) => (c.id === clip.id ? { ...c, end: snapSeconds(Number(e.target.value)) } : c)) })} />
              <button className="pc-danger" style={iconBtn} title="Delete clip" onClick={() => patch(track.id, { clips: track.clips.filter((c) => c.id !== clip.id) })}>
                ×
              </button>
            </div>
          ))}
          <button style={addClipBtn} onClick={() => patch(track.id, { clips: [...track.clips, { id: uid("clip"), start: 0, end: 2 }] })}>
            + clip
          </button>
        </div>
      ))}
      {hideAdd ? null : (
        <button
          disabled={activatables.length === 0}
          onClick={() => emit([...activationTracks, newActivationTrack(activatables[0]?.id ?? "")])}
        >
          Add Activation Track
        </button>
      )}
    </div>
  );
}

export interface AudioEditorProps {
  audioTracks: AudioTrack[];
  onChange: (next: Partial<ExtraTracks>) => void;
  /** Suppress the "Add track" button when the editor is scoped inside an inspector. */
  hideAdd?: boolean;
  /** Play one clip once (with its volume envelope) from the inspector. */
  onPreviewClip?: (clip: AudioClip, trackGain: number) => void;
  /** Waveform peaks for a clip's played window (flat [min,max,…], -1..1); null while decoding. */
  peaksFor?: (clip: AudioClip) => number[] | null;
}

export function AudioTracksEditor({ audioTracks, onChange, hideAdd = false, onPreviewClip, peaksFor }: AudioEditorProps) {
  const emit = (next: AudioTrack[]): void => onChange({ audioTracks: next });
  const patch = (id: string, p: Partial<AudioTrack>): void => emit(audioTracks.map((t) => (t.id === id ? { ...t, ...p } : t)));

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {audioTracks.map((track) => (
        <div key={track.id} style={{ display: "grid", gap: 3 }}>
          <div style={headerRow}>
            <input type="text" value={track.name ?? ""} aria-label="Audio track name" style={{ flex: 1 }} onChange={(e) => patch(track.id, { name: e.target.value })} />
            <button style={iconBtn} title={track.mute ? "Unmute" : "Mute"} onClick={() => patch(track.id, { mute: !track.mute })}>
              <IconVolume size={14} style={{ opacity: track.mute ? 0.35 : 1 }} />
            </button>
            <input type="range" min={0} max={1} step={0.05} value={track.gain ?? 1} title="Track gain" style={{ width: 60 }} onChange={(e) => patch(track.id, { gain: Number(e.target.value) })} />
            <button className="pc-danger" style={iconBtn} title="Delete track" onClick={() => emit(audioTracks.filter((t) => t.id !== track.id))}>
              ×
            </button>
          </div>
          {track.clips.map((clip) => (
            <div key={clip.id} style={{ display: "grid", gap: 4, paddingTop: 4, borderTop: "1px solid rgba(148,163,184,0.12)" }}>
              <div style={clipRow}>
                <input type="text" title="clip source (URL or tone:<freq>)" value={clip.src} style={{ flex: 1 }}
                  onChange={(e) => patch(track.id, { clips: track.clips.map((c) => (c.id === clip.id ? { ...c, src: e.target.value } : c)) })} />
                <input type="number" title="start (s)" value={clip.start} step={0.25} style={numInput}
                  onChange={(e) => patch(track.id, { clips: track.clips.map((c) => (c.id === clip.id ? { ...c, start: snapSeconds(Number(e.target.value)) } : c)) })} />
                <input type="number" title="duration (s)" value={clip.duration} min={0.25} step={0.25} style={numInput}
                  onChange={(e) => patch(track.id, { clips: track.clips.map((c) => (c.id === clip.id ? { ...c, duration: Math.max(0.25, Number(e.target.value)) } : c)) })} />
                {onPreviewClip ? (
                  <button style={iconBtn} title="Preview clip" onClick={() => onPreviewClip(clip, track.gain ?? 1)}>
                    ▶
                  </button>
                ) : null}
                <button className="pc-danger" style={iconBtn} title="Delete clip" onClick={() => patch(track.id, { clips: track.clips.filter((c) => c.id !== clip.id) })}>
                  ×
                </button>
              </div>
              <div style={{ paddingLeft: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "rgba(232,238,245,0.34)" }}>
                  <span>volume</span>
                  <input type="range" min={0} max={1} step={0.05} value={clip.gain ?? 1} title="Clip level (the curve shapes this over time)" style={{ flex: 1 }}
                    onChange={(e) => patch(track.id, { clips: track.clips.map((c) => (c.id === clip.id ? { ...c, gain: Number(e.target.value) } : c)) })} />
                  <span>{(clip.gain ?? 1).toFixed(2)}</span>
                </div>
                <EasingEditor
                  mode="value"
                  height={90}
                  {...(() => {
                    const bd = peaksFor?.(clip);
                    return bd ? { backdrop: bd } : {};
                  })()}
                  value={clip.gainCurve ?? FLAT_VOLUME}
                  onChange={(gainCurve: Easing) =>
                    patch(track.id, { clips: track.clips.map((c) => (c.id === clip.id ? { ...c, gainCurve: gainCurve as EasingCurve } : c)) })
                  }
                />
              </div>
            </div>
          ))}
          <button style={addClipBtn} onClick={() => patch(track.id, { clips: [...track.clips, { id: uid("clip"), src: SAMPLE_AUDIO[track.clips.length % SAMPLE_AUDIO.length]!, start: 0, duration: 4, gain: 1 }] })}>
            + clip
          </button>
        </div>
      ))}
      {hideAdd ? null : (
        <button onClick={() => emit([...audioTracks, { type: "audio", id: uid("aud"), name: `Audio ${audioTracks.length + 1}`, clips: [], gain: 1 }])}>
          Add Audio Track
        </button>
      )}
    </div>
  );
}

/** Set or clear an optional numeric clip field (blank input clears it → native/default). */
function setClipOpt(clip: AnimationClip, key: "clipStart" | "clipEnd", raw: string): AnimationClip {
  const next = { ...clip };
  if (raw === "") delete next[key];
  else next[key] = Number(raw);
  return next;
}

export interface AnimationEditorProps {
  animationTracks: AnimationTrack[];
  activatables: ActivatableInfo[];
  onChange: (next: Partial<ExtraTracks>) => void;
  /** Suppress the "Add track" button when the editor is scoped inside an inspector. */
  hideAdd?: boolean;
}

export function AnimationTracksEditor({ animationTracks, activatables, onChange, hideAdd = false }: AnimationEditorProps) {
  // Only GLB models expose baked clips; primitives can't back an animation track.
  const models = activatables.filter((a) => a.clips && a.clips.length > 0);
  const clipsFor = (objectId: string): string[] => models.find((m) => m.id === objectId)?.clips ?? [];
  const emit = (next: AnimationTrack[]): void => onChange({ animationTracks: next });
  const patch = (id: string, p: Partial<AnimationTrack>): void => emit(animationTracks.map((t) => (t.id === id ? { ...t, ...p } : t)));
  const patchClip = (trackId: string, clipId: string, update: (c: AnimationClip) => AnimationClip): void => {
    const track = animationTracks.find((t) => t.id === trackId);
    if (track) patch(trackId, { clips: track.clips.map((c) => (c.id === clipId ? update(c) : c)) });
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {animationTracks.map((track) => {
        const names = clipsFor(track.objectId);
        return (
          <div key={track.id} style={{ display: "grid", gap: 3 }}>
            <div style={headerRow}>
              <select style={{ flex: 1 }} value={track.objectId} title="Bound model" onChange={(e) => patch(track.id, { objectId: e.target.value })}>
                {models.length === 0 ? <option value="">(no animated models)</option> : null}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <button className="pc-danger" style={iconBtn} title="Delete track" onClick={() => emit(animationTracks.filter((t) => t.id !== track.id))}>
                ×
              </button>
            </div>
            {track.clips.map((clip) => (
              <div key={clip.id} style={clipRow}>
                <select value={clip.clipName} title="Baked clip" style={{ width: 74 }}
                  onChange={(e) => patchClip(track.id, clip.id, (c) => ({ ...c, clipName: e.target.value }))}>
                  {names.length === 0 ? <option value="">(none)</option> : null}
                  {names.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <input type="number" title="start (s)" value={clip.start} step={0.25} style={numInput}
                  onChange={(e) => patchClip(track.id, clip.id, (c) => ({ ...c, start: snapSeconds(Number(e.target.value)) }))} />
                <input type="number" title="end (s)" value={clip.end} step={0.25} style={numInput}
                  onChange={(e) => patchClip(track.id, clip.id, (c) => ({ ...c, end: snapSeconds(Number(e.target.value)) }))} />
                <input type="number" title="clip in (s) — retime start; blank = 0" placeholder="in" value={clip.clipStart ?? ""} step={0.1} style={numInput}
                  onChange={(e) => patchClip(track.id, clip.id, (c) => setClipOpt(c, "clipStart", e.target.value))} />
                <input type="number" title="clip out (s) — retime end; blank = native speed" placeholder="native" value={clip.clipEnd ?? ""} step={0.1} style={numInput}
                  onChange={(e) => patchClip(track.id, clip.id, (c) => setClipOpt(c, "clipEnd", e.target.value))} />
                <select value={clip.loop ?? "loop"} title="Past the clip end: loop it, or hold the last frame" style={{ width: 58 }}
                  onChange={(e) => patchClip(track.id, clip.id, (c) => ({ ...c, loop: e.target.value as "loop" | "once" }))}>
                  <option value="loop">loop</option>
                  <option value="once">once</option>
                </select>
                <button className="pc-danger" style={iconBtn} title="Delete clip" onClick={() => patch(track.id, { clips: track.clips.filter((c) => c.id !== clip.id) })}>
                  ×
                </button>
              </div>
            ))}
            <button style={addClipBtn} onClick={() => patch(track.id, { clips: [...track.clips, { id: uid("clip"), clipName: names[0] ?? "", start: 0, end: 2 }] })}>
              + clip
            </button>
          </div>
        );
      })}
      {hideAdd ? null : (
        <button disabled={models.length === 0} onClick={() => emit([...animationTracks, newAnimationTrack(models[0]?.id ?? "")])}>
          Add Animation Track
        </button>
      )}
    </div>
  );
}

// One source of truth per transform channel: label, default key value (rotation in
// degrees, scale identity, position origin), and the number-input step.
const CHANNELS: { key: "position" | "rotation" | "scale"; label: string; defaultValue: [number, number, number]; step: number }[] = [
  { key: "position", label: "position", defaultValue: [0, 0, 0], step: 0.5 },
  { key: "rotation", label: "rotation °", defaultValue: [0, 0, 0], step: 15 },
  { key: "scale", label: "scale", defaultValue: [1, 1, 1], step: 0.1 }
];

// Per-axis curve colors (x = red, y = green, z = blue), matching the timeline block
// sparkline so the two views read as the same data. Used for every channel; the
// channel toggles isolate which of position/rotation/scale is on-screen.
const AXIS_COLORS = ["rgba(248,113,113,0.9)", "rgba(74,222,128,0.9)", "rgba(96,165,250,0.9)"];
// Accent per channel for its toggle chip border.
const CHANNEL_ACCENT: Record<"position" | "rotation" | "scale", string> = { position: "#60a5fa", rotation: "#34d399", scale: "#fbbf24" };

/** Coerce the generic curve-editor keys back into the track's [x,y,z] TransformKey shape. */
const toTransformKeys = (keys: CurveChannelKey[]): TransformKey[] =>
  keys.map((k) => ({
    time: k.time,
    value: [k.value[0] ?? 0, k.value[1] ?? 0, k.value[2] ?? 0] as [number, number, number],
    ...(k.easing !== undefined && { easing: k.easing }),
    ...(k.easingAxes && { easingAxes: [k.easingAxes[0] ?? "linear", k.easingAxes[1] ?? "linear", k.easingAxes[2] ?? "linear"] as [Easing, Easing, Easing] })
  }));

/** A bound object's live local transform (rotation in Euler degrees), for "key pose". */
export interface ObjectPose {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface TransformEditorProps {
  transformTracks: TransformTrack[];
  activatables: ActivatableInfo[];
  onChange: (next: Partial<ExtraTracks>) => void;
  /** Suppress the "Add track" button when the editor is scoped inside an inspector. */
  hideAdd?: boolean;
  /** Live playhead time (s); enables a "key @ playhead" button that snapshots the held value there. */
  getPlayhead?: () => number;
  /** Reads the object's live transform (posed via the viewport gizmo), for "key pose @ playhead". */
  readObjectPose?: (objectId: string) => ObjectPose | null;
}

export function TransformTracksEditor({ transformTracks, activatables, onChange, hideAdd = false, getPlayhead, readObjectPose }: TransformEditorProps) {
  // Which tracks have their raw per-axis number tables expanded. Default collapsed:
  // the primary flow is "◆ key pose @ playhead"; the tables are the fine-tune escape hatch.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string): void => setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  // Which channels are drawn in each track's curve graph. Absent => default to the
  // first keyed channel (position when present); toggles add/remove the rest.
  const [shownChannels, setShownChannels] = useState<Record<string, Set<string>>>({});
  const shownFor = (trackId: string, keyed: string[]): Set<string> => shownChannels[trackId] ?? new Set(keyed.slice(0, 1));
  const toggleChannel = (trackId: string, key: string, keyed: string[]): void =>
    setShownChannels((prev) => {
      const cur = new Set(prev[trackId] ?? shownFor(trackId, keyed));
      if (cur.has(key)) cur.delete(key); else cur.add(key);
      return { ...prev, [trackId]: cur };
    });
  const emit = (next: TransformTrack[]): void => onChange({ transformTracks: next });
  const patch = (id: string, p: Partial<TransformTrack>): void => emit(transformTracks.map((t) => (t.id === id ? { ...t, ...p } : t)));
  // Snapshot the gizmo-posed transform at the playhead — into the channels the track
  // already keys (so it doesn't inject rotation/scale a sibling track may be driving),
  // or all three when the track is still empty.
  const keyPose = (track: TransformTrack): void => {
    if (!readObjectPose || !getPlayhead) return;
    const pose = readObjectPose(track.objectId);
    if (!pose) return;
    const t = snapSeconds(getPlayhead());
    const empty = !track.position && !track.rotation && !track.scale;
    patch(track.id, {
      ...((track.position || empty) && { position: upsertTransformKey(track.position, t, pose.position) }),
      ...((track.rotation || empty) && { rotation: upsertTransformKey(track.rotation, t, pose.rotation) }),
      ...((track.scale || empty) && { scale: upsertTransformKey(track.scale, t, pose.scale) })
    });
  };
  const setChannel = (track: TransformTrack, channel: "position" | "rotation" | "scale", keys: TransformKey[]): void =>
    patch(track.id, { [channel]: [...keys].sort((a, b) => a.time - b.time) });

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {transformTracks.map((track) => {
        const allTimes = [...new Set([...(track.position ?? []), ...(track.rotation ?? []), ...(track.scale ?? [])].map((k) => k.time))].sort((a, b) => a - b);
        const isExpanded = expanded.has(track.id);
        return (
        <div key={track.id} style={{ display: "grid", gap: 4 }}>
          <div style={headerRow}>
            <select style={{ flex: 1 }} value={track.objectId} title="Bound object" onChange={(e) => patch(track.id, { objectId: e.target.value })}>
              {activatables.length === 0 ? <option value="">(no objects)</option> : null}
              {activatables.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <button className="pc-danger" style={iconBtn} title="Delete track" onClick={() => emit(transformTracks.filter((t) => t.id !== track.id))}>
              ×
            </button>
          </div>
          {readObjectPose && getPlayhead ? (
            <button style={{ justifySelf: "start" }} title="Snapshot the object's current position, rotation and scale as keyframes at the playhead" onClick={() => keyPose(track)}>
              ◆ Key pose @ playhead
            </button>
          ) : null}
          {(() => {
            const keyed = CHANNELS.filter((c) => (track[c.key]?.length ?? 0) > 0);
            if (keyed.length === 0) return null;
            const keyedKeys = keyed.map((c) => c.key);
            const shownSet = shownFor(track.id, keyedKeys);
            const shown = keyed.filter((c) => shownSet.has(c.key));
            const times = keyed.flatMap((c) => (track[c.key] ?? []).map((k) => k.time));
            const end = Math.max(2, Math.max(0, ...times) + 2, (getPlayhead?.() ?? 0) + 1);
            return (
              <>
                {keyed.length > 1 ? (
                  <div style={{ display: "flex", gap: 4, paddingLeft: 10 }}>
                    {keyed.map((c) => {
                      const on = shownSet.has(c.key);
                      return (
                        <button key={c.key} title={`Show/hide ${c.key} curves`} onClick={() => toggleChannel(track.id, c.key, keyedKeys)}
                          style={{ fontSize: 10, padding: "1px 7px", opacity: on ? 1 : 0.4, border: `1px solid ${CHANNEL_ACCENT[c.key]}`, borderRadius: 4, background: "transparent", color: "inherit", cursor: "pointer" }}>
                          {c.key}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                <KeyframeCurveEditor
                  channels={shown.map((c) => ({
                    id: `${track.id}-${c.key}`,
                    colors: AXIS_COLORS,
                    componentLabels: ["x", "y", "z"],
                    keys: track[c.key] ?? [],
                    onChange: (next) => setChannel(track, c.key, toTransformKeys(next))
                  }))}
                  timeStart={0}
                  timeEnd={end}
                  {...(getPlayhead && { playhead: getPlayhead() })}
                  height={150}
                />
              </>
            );
          })()}
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "rgba(232,238,245,0.42)", paddingLeft: 10 }}>
            <span>{allTimes.length ? `keys: ${allTimes.map((t) => `${t.toFixed(1)}s`).join(", ")}` : "no keys yet — use ◆ Key pose (or expand to add manually)"}</span>
            <button style={{ marginLeft: "auto", ...iconBtn }} title="Show/hide the per-axis keyframe values" onClick={() => toggleExpanded(track.id)}>
              {isExpanded ? "edit values ▴" : "edit values ▾"}
            </button>
          </div>
          {isExpanded ? CHANNELS.map(({ key, label, defaultValue, step }) => {
            const keys = track[key] ?? [];
            // Seed a new key from the object's CURRENT value for this channel (so it
            // doesn't snap to origin/unit-scale on playback — the group carries the
            // object's placement, e.g. the Fox's 0.025 scale); fall back to the default.
            const seed = (): [number, number, number] => readObjectPose?.(track.objectId)?.[key] ?? defaultValue;
            const addKey = (): void => {
              const at = keys.length ? snapSeconds(Math.max(...keys.map((k) => k.time)) + 1) : 0;
              setChannel(track, key, [...keys, { time: at, value: [...seed()] }]);
            };
            return (
              <div key={key} style={{ display: "grid", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "rgba(232,238,245,0.42)", paddingLeft: 10 }}>
                  <span style={{ width: 58 }}>{label}</span>
                  <button style={iconBtn} onClick={addKey}>
                    + key
                  </button>
                  {getPlayhead ? (
                    <button style={iconBtn} title="Key the held value at the playhead" onClick={() => setChannel(track, key, insertTransformKey(keys, snapSeconds(getPlayhead()), seed()))}>
                      ◆ now
                    </button>
                  ) : null}
                </div>
                {keys.map((keyframe, i) => (
                  <div key={i} style={clipRow}>
                    <input type="number" title="time (s)" value={keyframe.time} step={0.25} style={numInput}
                      onChange={(e) => setChannel(track, key, keys.map((k, j) => (j === i ? { ...k, time: snapSeconds(Number(e.target.value)) } : k)))} />
                    {[0, 1, 2].map((axis) => (
                      <input key={axis} type="number" title={["x", "y", "z"][axis]} value={keyframe.value[axis]} step={step} style={numInput}
                        onChange={(e) => setChannel(track, key, keys.map((k, j) => {
                          if (j !== i) return k;
                          const value: [number, number, number] = [...k.value];
                          value[axis] = Number(e.target.value);
                          return { ...k, value };
                        }))} />
                    ))}
                    <select value={typeof keyframe.easing === "string" ? keyframe.easing : "linear"} title="easing into this key" style={{ width: 92 }}
                      onChange={(e) => setChannel(track, key, keys.map((k, j) => (j === i ? { ...k, easing: e.target.value as Easing } : k)))}>
                      {EASING_OPTIONS.map((p) => (
                        <option key={p as string} value={p as string}>
                          {p as string}
                        </option>
                      ))}
                    </select>
                    <button className="pc-danger" style={iconBtn} title="Delete key" onClick={() => setChannel(track, key, keys.filter((_, j) => j !== i))}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            );
          }) : null}
        </div>
        );
      })}
      {hideAdd ? null : (
        <button disabled={activatables.length === 0} onClick={() => emit([...transformTracks, newTransformTrack(activatables[0]?.id ?? "")])}>
          Add Motion Track
        </button>
      )}
    </div>
  );
}
