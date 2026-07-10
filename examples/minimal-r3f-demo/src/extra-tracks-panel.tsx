// Left-panel authoring editors for the Activation, Audio, and Animation timeline
// tracks, one exported component each (they live in separate collapsible sections).
// Follows the demo panel idiom: each track is a header row of controls, and clips
// are number-input rows (start/end) like the dolly-runs editor. Controlled — each
// calls onChange with only the ExtraTracks slice it owns (merged at the App level,
// so track kinds it doesn't touch survive). The bottom TimelineLanes plays/scrubs it.
import type { CSSProperties } from "react";
import type { Easing, EasingCurve } from "@huma/path-creator/core";
import { EasingEditor } from "@huma/path-creator/timeline-ui";
import { IconVolume } from "./icons";
import type { ActivatableInfo } from "./activatables";
import {
  snapSeconds,
  type ActivationTrack,
  type AnimationClip,
  type AnimationTrack,
  type AudioClip,
  type AudioTrack,
  type ExtraTracks,
  type PostPlaybackState
} from "./extra-tracks";

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
export const newActivationTrack = (objectId: string): ActivationTrack => ({ id: uid("act"), objectId, clips: [], postPlaybackState: "revert" });

/** A blank animation track bound to `objectId` (shared by the panel + object inspector). */
export const newAnimationTrack = (objectId: string): AnimationTrack => ({ id: uid("anim"), objectId, clips: [] });

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
        <button onClick={() => emit([...audioTracks, { id: uid("aud"), name: `Audio ${audioTracks.length + 1}`, clips: [], gain: 1 }])}>
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
