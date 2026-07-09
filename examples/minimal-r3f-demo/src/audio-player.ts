// Web Audio reconciler for the demo's 2D Audio tracks. Given the per-frame desired
// audio state (from evaluateAudio) it starts/stops/gains AudioBufferSourceNodes so
// playback matches the timeline, and resyncs when the source drifts from the clock
// (a scrub-then-play). Buffers are decoded once per src and cached; `tone:<freq>`
// synthesizes a sine buffer so the demo needs no bundled asset. Demo scaffolding.
import { sampleEasingCurve } from "@huma/path-creator/core";
import type { AudioClip, DesiredAudio } from "./extra-tracks";

const RESYNC_TOLERANCE_SECONDS = 0.3;
const TONE_BUFFER_SECONDS = 60;

interface ActiveClip {
  src: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** ctx.currentTime when the source started, and the buffer offset it started at. */
  startedAtContextTime: number;
  startedOffset: number;
  loop: boolean;
}

export class AudioTrackPlayer {
  private context: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Set<string>();
  private active = new Map<string, ActiveClip>();
  private preview: { source: AudioBufferSourceNode; gain: GainNode } | null = null;

  /** Resume the AudioContext from a user gesture (autoplay policy). Call on Play. */
  resume(): void {
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") void ctx.resume();
  }

  /**
   * Play one clip once from the inspector, applying its volume envelope (level × gainCurve)
   * as scheduled gain automation, so you can hear the fade you drew. Stops any prior preview.
   */
  async previewClip(clip: AudioClip, trackGain: number): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state !== "running") await ctx.resume();
    let buffer = this.buffers.get(clip.src);
    if (!buffer) {
      buffer = await this.loadBuffer(clip.src);
      this.buffers.set(clip.src, buffer);
    }
    this.stopPreview();
    const offset = Math.max(0, clip.offset ?? 0);
    const dur = Math.max(0.05, Math.min(clip.duration, buffer.duration - offset));
    const base = (clip.gain ?? 1) * trackGain;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    source.connect(gain).connect(ctx.destination);
    if (clip.gainCurve) {
      const n = 64;
      const curve = new Float32Array(n + 1);
      for (let i = 0; i <= n; i++) curve[i] = base * Math.min(1, Math.max(0, sampleEasingCurve(clip.gainCurve, i / n)));
      gain.gain.setValueCurveAtTime(curve, ctx.currentTime, dur);
    } else {
      gain.gain.value = base;
    }
    const node = { source, gain };
    source.onended = () => {
      if (this.preview === node) {
        gain.disconnect();
        this.preview = null;
      }
    };
    source.start(0, offset);
    source.stop(ctx.currentTime + dur);
    this.preview = node;
  }

  private stopPreview(): void {
    if (!this.preview) return;
    this.preview.source.onended = null;
    try {
      this.preview.source.stop();
    } catch {
      /* already stopped */
    }
    this.preview.source.disconnect();
    this.preview.gain.disconnect();
    this.preview = null;
  }

  /**
   * Reconcile actual playback to `desired` (clipId -> DesiredAudio). When not live
   * (paused/scrubbing) all nodes are stopped so audio is silent outside forward play.
   */
  reconcile(desired: ReadonlyMap<string, DesiredAudio>, live: boolean): void {
    if (!live) {
      this.stopAll();
      return;
    }
    const ctx = this.ensureContext();
    if (ctx.state !== "running") {
      void ctx.resume();
      this.stopAll();
      return;
    }

    // Stop clips no longer desired.
    for (const [clipId, clip] of this.active) {
      if (!desired.has(clipId)) {
        this.stopClip(clipId, clip);
      }
    }

    for (const [clipId, want] of desired) {
      const buffer = this.getBuffer(want.src);
      if (!buffer) continue; // still decoding; start once ready

      const current = this.active.get(clipId);
      if (!current) {
        this.startClip(ctx, clipId, buffer, want);
        continue;
      }
      current.gain.gain.value = want.gain;
      current.loop = want.loop;
      current.source.loop = want.loop;
      // Resync if the source has drifted from the timeline (e.g. after a seek).
      const played = ctx.currentTime - current.startedAtContextTime + current.startedOffset;
      const expected = want.loop ? want.offset % buffer.duration : want.offset;
      if (current.src !== want.src || Math.abs(played - expected) > RESYNC_TOLERANCE_SECONDS) {
        this.stopClip(clipId, current);
        this.startClip(ctx, clipId, buffer, want);
      }
    }
  }

  dispose(): void {
    this.stopPreview();
    this.stopAll();
    void this.context?.close();
    this.context = null;
  }

  private startClip(ctx: AudioContext, clipId: string, buffer: AudioBuffer, want: DesiredAudio): void {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = want.loop;
    const gain = ctx.createGain();
    gain.gain.value = want.gain;
    source.connect(gain).connect(ctx.destination);
    const offset = want.loop ? want.offset % buffer.duration : Math.min(want.offset, buffer.duration);
    const clip: ActiveClip = {
      src: want.src,
      source,
      gain,
      startedAtContextTime: ctx.currentTime,
      startedOffset: offset,
      loop: want.loop
    };
    source.onended = () => {
      if (this.active.get(clipId) === clip) this.active.delete(clipId);
    };
    source.start(0, Math.max(0, offset));
    this.active.set(clipId, clip);
  }

  private stopClip(clipId: string, clip: ActiveClip): void {
    clip.source.onended = null;
    try {
      clip.source.stop();
    } catch {
      /* already stopped */
    }
    clip.source.disconnect();
    clip.gain.disconnect();
    this.active.delete(clipId);
  }

  private stopAll(): void {
    for (const [clipId, clip] of [...this.active]) this.stopClip(clipId, clip);
  }

  private ensureContext(): AudioContext {
    if (!this.context) this.context = new AudioContext();
    return this.context;
  }

  private getBuffer(src: string): AudioBuffer | null {
    const cached = this.buffers.get(src);
    if (cached) return cached;
    if (!this.loading.has(src)) {
      this.loading.add(src);
      void this.loadBuffer(src)
        .then((buffer) => this.buffers.set(src, buffer))
        .catch((error) => console.warn(`[audio] failed to load ${src}`, error))
        .finally(() => this.loading.delete(src));
    }
    return null;
  }

  private async loadBuffer(src: string): Promise<AudioBuffer> {
    const ctx = this.ensureContext();
    if (src.startsWith("tone:")) {
      const freq = Number(src.slice(5)) || 440;
      return this.synthesizeTone(ctx, freq);
    }
    const response = await fetch(src);
    const arrayBuffer = await response.arrayBuffer();
    return ctx.decodeAudioData(arrayBuffer);
  }

  /** A gentle looping sine tone, so the demo has audio with zero bundled assets. */
  private synthesizeTone(ctx: BaseAudioContext, freq: number): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * TONE_BUFFER_SECONDS);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    const omega = (2 * Math.PI * freq) / ctx.sampleRate;
    for (let i = 0; i < length; i++) data[i] = Math.sin(omega * i) * 0.2;
    return buffer;
  }
}
