// Audio inspector: editor for the one selected audio track. Reuses AudioTracksEditor
// scoped to just this track (add suppressed) — name, mute, gain, and its clips
// (source/start/duration) with add/delete. onChange re-merges the scoped track back
// into the full ExtraTracks (dropping it if the editor deleted it). The hierarchy
// owns the list + add-track affordance. Pure presentation via App handlers.
import { AudioTracksEditor } from "./extra-tracks-panel";
import type { AudioClip, AudioTrack, ExtraTracks } from "./extra-tracks";

export interface AudioInspectorProps {
  track: AudioTrack;
  extraTracks: ExtraTracks;
  onChange: (next: ExtraTracks) => void;
  onPreviewClip?: (clip: AudioClip, trackGain: number) => void;
  peaksFor?: (clip: AudioClip) => number[] | null;
}

export function AudioInspector({ track, extraTracks, onChange, onPreviewClip, peaksFor }: AudioInspectorProps) {
  return (
    <AudioTracksEditor
      activationTracks={extraTracks.activationTracks}
      audioTracks={[track]}
      hideAdd
      {...(onPreviewClip && { onPreviewClip })}
      {...(peaksFor && { peaksFor })}
      onChange={(next) => {
        const edited = next.audioTracks.find((t) => t.id === track.id);
        const merged = extraTracks.audioTracks.flatMap((t) => (t.id === track.id ? (edited ? [edited] : []) : [t]));
        onChange({ activationTracks: next.activationTracks, audioTracks: merged });
      }}
    />
  );
}
