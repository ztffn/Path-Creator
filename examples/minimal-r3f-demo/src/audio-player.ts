// Web Audio playback for the demo's 2D Audio tracks. Schedules one buffer source per
// clip at its exact context time through the shared graph builder — the same builder
// the offline mixdown uses, so what you audition and what you export cannot diverge.
// Reschedules only when what should be heard changes (play, seek, edit, a late decode)
// instead of reconciling every frame. `tone:<freq>` synthesizes a sine buffer so the
// demo needs no bundled asset. Demo scaffolding.
import type { AudioClip, AudioTrack } from "@huma/path-creator/core";
import { buildAudioGraph, type AudioGraphLayer, type ScheduledClip } from "./audio-graph";
import { stretchAudioBuffer } from "./audio-stretch";

const TONE_BUFFER_SECONDS = 60;
// A seek is a discontinuity in the drive clock, not drift: the scheduler does not drift,
// so anything past a few frames of slack means the playhead was moved (or the timeline
// looped) and the schedule has to be rebuilt.
const SEEK_EPSILON_SECONDS = 0.05;

interface ScheduleAnchor {
  contextTime: number;
  driveTime: number;
  signature: string;
}

/**
 * Everything about the layers that changes what gets scheduled. Rebuilt each frame and
 * compared: the per-frame `.filter()` upstream allocates fresh track arrays, so
 * reference identity cannot be used and content is what's left. A handful of clips
 * makes this trivial next to the render work happening alongside it.
 */
function scheduleSignature(layers: readonly AudioGraphLayer[], driveTime: number): string {
  const parts: string[] = [];
  for (const layer of layers) {
    parts.push((layer.time - driveTime).toFixed(4));
    for (const track of layer.tracks) {
      parts.push(track.id, track.mute ? "m" : "", String(track.gain ?? 1));
      for (const clip of track.clips) {
        parts.push(
          clip.id, clip.src, String(clip.start), String(clip.duration), String(clip.offset ?? 0),
          String(clip.gain ?? 1), String(clip.rate ?? 1), String(clip.stretch ?? 1),
          clip.loop ? "L" : "", clip.gainCurve ? JSON.stringify(clip.gainCurve) : ""
        );
      }
    }
  }
  return parts.join(",");
}

export class AudioTrackPlayer {
  private context: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Set<string>();
  private scheduled: ScheduledClip[] = [];
  private anchor: ScheduleAnchor | null = null;
  private preview: ScheduledClip[] = [];

  /** Resume the AudioContext from a user gesture (autoplay policy). Call on Play. */
  resume(): void {
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") void ctx.resume();
  }

  /**
   * Follow the timeline. Called every frame, but only rebuilds the schedule when what
   * should be heard actually changed — the clip edit, the seek, the decode that just
   * landed. Silent whenever `live` is false, matching the forward-play-only contract.
   */
  sync(layers: readonly AudioGraphLayer[], driveTime: number, live: boolean): void {
    if (!live) {
      this.stopScheduled();
      return;
    }
    const ctx = this.ensureContext();
    if (ctx.state !== "running") {
      void ctx.resume();
      this.stopScheduled();
      return;
    }
    this.stopPreview(); // timeline audio takes over from an inspector preview

    const signature = scheduleSignature(layers, driveTime);
    if (this.anchor) {
      const expected = this.anchor.driveTime + (ctx.currentTime - this.anchor.contextTime);
      const continuous = Math.abs(driveTime - expected) <= SEEK_EPSILON_SECONDS;
      if (continuous && this.anchor.signature === signature) return;
    }

    this.stopScheduled();
    this.scheduled = buildAudioGraph(ctx, layers, {
      originContextTime: ctx.currentTime,
      getBuffer: (src, stretch) => this.getBuffer(src, stretch),
      destination: ctx.destination,
      // A source still decoding drops out of this schedule; the decode invalidates the
      // anchor when it lands so the next frame picks it up.
      onMissing: () => undefined
    });
    this.anchor = { contextTime: ctx.currentTime, driveTime, signature };
  }

  /**
   * Play one clip once from the inspector, through the same builder the timeline uses,
   * so an auditioned clip sounds exactly as it will in place (minus its neighbours'
   * crossfades, which is what previewing one clip means).
   */
  async previewClip(clip: AudioClip, trackGain: number): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state !== "running") await ctx.resume();
    await this.loadInto(clip.src, 1);
    this.stopPreview();
    const track: AudioTrack = { type: "audio", id: "preview", clips: [clip], gain: trackGain };
    this.preview = buildAudioGraph(ctx, [{ tracks: [track], time: clip.start }], {
      originContextTime: ctx.currentTime,
      getBuffer: (src, stretch) => this.buffers.get(bufferKey(src, stretch)) ?? null,
      destination: ctx.destination
    });
  }

  dispose(): void {
    this.stopPreview();
    this.stopScheduled();
    void this.context?.close();
    this.context = null;
  }

  private stopScheduled(): void {
    if (this.scheduled.length) stopClips(this.scheduled);
    this.scheduled = [];
    this.anchor = null;
  }

  private stopPreview(): void {
    if (!this.preview.length) return;
    stopClips(this.preview);
    this.preview = [];
  }

  private ensureContext(): AudioContext {
    if (!this.context) this.context = new AudioContext();
    return this.context;
  }

  /**
   * A decoded buffer, or null while it decodes. `stretch` keys the cache because a
   * pitch-preserving stretch produces a different buffer for the same source; until the
   * offline stretcher exists only the unstretched variant is ever produced.
   */
  private getBuffer(src: string, stretch: number): AudioBuffer | null {
    const key = bufferKey(src, stretch);
    const cached = this.buffers.get(key);
    if (cached) return cached;
    if (!this.loading.has(key)) {
      void this.loadInto(src, stretch).catch((error) => console.warn(`[audio] failed to load ${src}`, error));
    }
    return null;
  }

  private async loadInto(src: string, stretch: number): Promise<AudioBuffer> {
    const key = bufferKey(src, stretch);
    const cached = this.buffers.get(key);
    if (cached) return cached;
    this.loading.add(key);
    try {
      const source = this.buffers.get(src) ?? (await this.loadBuffer(src));
      this.buffers.set(src, source);
      // Stretch here too, with the same function the bake uses. Skipping it would leave
      // preview playing a stretched clip at its original length while the export played
      // it correctly — the exact divergence the shared graph exists to prevent.
      const buffer = stretchAudioBuffer(this.ensureContext(), source, stretch);
      this.buffers.set(key, buffer);
      // A clip that was skipped for want of this buffer must get scheduled now.
      this.anchor = null;
      return buffer;
    } finally {
      this.loading.delete(key);
    }
  }

  private async loadBuffer(src: string): Promise<AudioBuffer> {
    const ctx = this.ensureContext();
    if (src.startsWith("tone:")) return synthesizeTone(ctx, Number(src.slice(5)) || 440);
    const response = await fetch(src);
    return ctx.decodeAudioData(await response.arrayBuffer());
  }
}

const bufferKey = (src: string, stretch: number): string => (stretch === 1 ? src : `${src}@${stretch}`);

function stopClips(clips: readonly ScheduledClip[]): void {
  for (const { source, gain } of clips) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* already stopped */
    }
    source.disconnect();
    gain.disconnect();
  }
}

/** A gentle looping sine tone, so the demo has audio with zero bundled assets. */
export function synthesizeTone(ctx: BaseAudioContext, freq: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * TONE_BUFFER_SECONDS);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const omega = (2 * Math.PI * freq) / ctx.sampleRate;
  for (let i = 0; i < length; i++) data[i] = Math.sin(omega * i) * 0.2;
  return buffer;
}
