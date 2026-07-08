// Left-panel authoring editors for the Activation and Audio timeline tracks, one
// exported component each (they live in separate collapsible sections). Follows the
// demo panel idiom: each track is a header row of controls, and clips are
// number-input rows (start/end) like the dolly-runs editor. Controlled — each calls
// onChange with the full next ExtraTracks. The bottom TimelineLanes plays/scrubs it.
import type { CSSProperties } from "react";
import { IconVolume } from "./icons";
import type { ActivatableInfo } from "./activatables";
import {
  snapSeconds,
  type ActivationTrack,
  type AudioTrack,
  type ExtraTracks,
  type PostPlaybackState
} from "./extra-tracks";

const uid = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

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
  audioTracks: AudioTrack[];
  activatables: ActivatableInfo[];
  onChange: (next: ExtraTracks) => void;
}

export function ActivationTracksEditor({ activationTracks, audioTracks, activatables, onChange }: ActivationEditorProps) {
  const emit = (next: ActivationTrack[]): void => onChange({ activationTracks: next, audioTracks });
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
      <button
        disabled={activatables.length === 0}
        onClick={() => emit([...activationTracks, { id: uid("act"), objectId: activatables[0]?.id ?? "", clips: [], postPlaybackState: "revert" }])}
      >
        Add Activation Track
      </button>
    </div>
  );
}

export interface AudioEditorProps {
  activationTracks: ActivationTrack[];
  audioTracks: AudioTrack[];
  onChange: (next: ExtraTracks) => void;
}

export function AudioTracksEditor({ activationTracks, audioTracks, onChange }: AudioEditorProps) {
  const emit = (next: AudioTrack[]): void => onChange({ activationTracks, audioTracks: next });
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
            <div key={clip.id} style={clipRow}>
              <input type="text" title="clip source (URL or tone:<freq>)" value={clip.src} style={{ flex: 1 }}
                onChange={(e) => patch(track.id, { clips: track.clips.map((c) => (c.id === clip.id ? { ...c, src: e.target.value } : c)) })} />
              <input type="number" title="start (s)" value={clip.start} step={0.25} style={numInput}
                onChange={(e) => patch(track.id, { clips: track.clips.map((c) => (c.id === clip.id ? { ...c, start: snapSeconds(Number(e.target.value)) } : c)) })} />
              <input type="number" title="duration (s)" value={clip.duration} min={0.25} step={0.25} style={numInput}
                onChange={(e) => patch(track.id, { clips: track.clips.map((c) => (c.id === clip.id ? { ...c, duration: Math.max(0.25, Number(e.target.value)) } : c)) })} />
              <button className="pc-danger" style={iconBtn} title="Delete clip" onClick={() => patch(track.id, { clips: track.clips.filter((c) => c.id !== clip.id) })}>
                ×
              </button>
            </div>
          ))}
          <button style={addClipBtn} onClick={() => patch(track.id, { clips: [...track.clips, { id: uid("clip"), src: "tone:440", start: 0, duration: 4, gain: 1 }] })}>
            + clip
          </button>
        </div>
      ))}
      <button onClick={() => emit([...audioTracks, { id: uid("aud"), name: `Audio ${audioTracks.length + 1}`, clips: [], gain: 1 }])}>
        Add Audio Track
      </button>
    </div>
  );
}
