// Offline mixdown of a scene's audio tracks to a single WAV. Renders through the SAME
// graph builder the live preview uses, so the exported file is what you auditioned —
// that equivalence is the reason the bake exists in this shape rather than as its own
// renderer. Sources are decoded and stretched up front because an OfflineAudioContext
// cannot wait mid-render. Demo scaffolding, with a promotion path to the package.
import { audioClipSpeeds, type AudioTrack } from "@huma/path-creator/core";
import { buildAudioGraph, audioTracksEnd } from "./audio-graph";
import { stretchAudioBuffer } from "./audio-stretch";
import { synthesizeTone } from "./audio-player";
import { saveBlob } from "./scene-storage";

const DEFAULT_SAMPLE_RATE = 48000;
const MIXDOWN_CHANNELS = 2;
/** Keeps a silent tail rather than clipping a reverb or release at the last sample. */
const TAIL_SECONDS = 0.25;

const key = (src: string, stretch: number): string => (stretch === 1 ? src : `${src}@${stretch}`);

/**
 * Decode every source the tracks reference, pre-stretching the variants that need it.
 * Keyed by (src, stretch) exactly as the graph builder asks for them.
 */
async function prepareBuffers(
  context: BaseAudioContext,
  tracks: readonly AudioTrack[]
): Promise<Map<string, AudioBuffer>> {
  const wanted = new Map<string, { src: string; stretch: number }>();
  for (const track of tracks) {
    if (track.mute) continue;
    for (const clip of track.clips) {
      const { stretch } = audioClipSpeeds(clip);
      wanted.set(key(clip.src, stretch), { src: clip.src, stretch });
    }
  }

  const decoded = new Map<string, AudioBuffer>();
  const sources = new Map<string, Promise<AudioBuffer>>();
  const decode = (src: string): Promise<AudioBuffer> => {
    const existing = sources.get(src);
    if (existing) return existing;
    const pending = src.startsWith("tone:")
      ? Promise.resolve(synthesizeTone(context, Number(src.slice(5)) || 440))
      : fetch(src).then((r) => r.arrayBuffer()).then((b) => context.decodeAudioData(b));
    sources.set(src, pending);
    return pending;
  };

  await Promise.all([...wanted].map(async ([id, { src, stretch }]) => {
    try {
      decoded.set(id, stretchAudioBuffer(context, await decode(src), stretch));
    } catch (error) {
      console.warn(`[bake] skipping ${src}`, error);
    }
  }));
  return decoded;
}

/**
 * Render the tracks to one buffer. `duration` defaults to the last moment any clip is
 * still sounding, so a mixdown is never longer than its content.
 */
export async function renderAudioMixdown(
  tracks: readonly AudioTrack[],
  options: { duration?: number; sampleRate?: number } = {}
): Promise<AudioBuffer> {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const duration = (options.duration ?? audioTracksEnd(tracks)) + TAIL_SECONDS;
  if (duration <= TAIL_SECONDS) throw new Error("Nothing to bake: no audio clips on this scene.");

  // A short scratch context decodes and stretches; the render context is sized to the
  // result, which cannot be known until the decode is done.
  const scratch = new OfflineAudioContext(1, 1, sampleRate);
  const buffers = await prepareBuffers(scratch, tracks);

  const context = new OfflineAudioContext(MIXDOWN_CHANNELS, Math.ceil(duration * sampleRate), sampleRate);
  buildAudioGraph(context, [{ tracks, time: 0 }], {
    originContextTime: 0,
    getBuffer: (src, stretch) => buffers.get(key(src, stretch)) ?? null,
    destination: context.destination
  });
  return context.startRendering();
}

/** Encode a rendered buffer as 16-bit PCM WAV — the format every tool reads. */
export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = 44 + frames * channels * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, bytes - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, frames * channels * 2, true);

  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let at = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      // Clamp before scaling: a summed mix can exceed unity, and wrapping that would
      // turn an overload into a click rather than the clip you can hear and fix.
      const sample = Math.max(-1, Math.min(1, data[c]![i]!));
      view.setInt16(at, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      at += 2;
    }
  }
  return new Blob([view], { type: "audio/wav" });
}

/** Render and save the mixdown for these tracks. */
export async function downloadAudioMixdown(
  tracks: readonly AudioTrack[],
  filename = "mixdown.wav",
  options: { duration?: number } = {}
): Promise<void> {
  const rendered = await renderAudioMixdown(tracks, options);
  saveBlob(encodeWav(rendered), filename);
}
