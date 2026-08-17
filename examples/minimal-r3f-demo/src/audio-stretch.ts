// Pitch-preserving time stretch (WSOLA) for the audio bake. Pure DSP over a
// Float32Array so it is testable without Web Audio, and offline-only by nature —
// this is why stretch is affordable at all: the bake renders ahead of time, so the
// cost never lands in the playback path. WSOLA rather than a phase vocoder because it
// keeps transients intact, and transients are the material this exists for.

/** Periodic Hann window; at 50% overlap successive windows sum to exactly 1. */
function hann(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

/**
 * Best alignment for the next grain: the offset near `target` whose head most closely
 * continues the waveform the previous grain ended on. Searching this rather than cutting
 * at a fixed hop is the whole trick — it keeps successive grains phase-aligned, which is
 * what stops the stretch from sounding metallic.
 */
function bestOffset(
  input: Float32Array,
  target: number,
  reference: number,
  overlap: number,
  tolerance: number,
  maxStart: number
): number {
  let best = Math.min(Math.max(target, 0), maxStart);
  if (reference < 0 || reference + overlap > input.length) return best;
  let bestScore = -Infinity;
  const from = Math.max(0, target - tolerance);
  const to = Math.min(maxStart, target + tolerance);
  for (let start = from; start <= to; start += 1) {
    let score = 0;
    for (let i = 0; i < overlap; i += 4) score += input[start + i]! * input[reference + i]!;
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
  }
  return best;
}

/**
 * Resample `input` in time without moving its pitch. `factor` is a speed multiplier
 * matching AudioClip.stretch — 2 returns something half as long, 0.5 twice as long.
 * Returns the input untouched at factor 1.
 */
export function wsolaStretch(input: Float32Array, factor: number, sampleRate: number): Float32Array {
  if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 1e-6) return input;
  const frame = Math.max(256, Math.round(sampleRate * 0.04));
  if (input.length <= frame * 2) return input;

  const synthesisHop = frame >> 1;
  const analysisHop = synthesisHop * factor;
  const overlap = frame - synthesisHop;
  const tolerance = synthesisHop >> 1;
  const maxStart = input.length - frame;
  const window = hann(frame);

  const outputLength = Math.max(1, Math.round(input.length / factor));
  const output = new Float32Array(outputLength + frame);

  let reference = -1;
  for (let k = 0; ; k += 1) {
    const target = Math.round(k * analysisHop);
    if (target > maxStart) break;
    const start = k === 0 ? 0 : bestOffset(input, target, reference, overlap, tolerance, maxStart);
    const at = k * synthesisHop;
    if (at >= outputLength) break;
    for (let i = 0; i < frame; i += 1) output[at + i] = output[at + i]! + input[start + i]! * window[i]!;
    reference = start + synthesisHop;
  }

  // slice, not subarray: the caller keeps this, and a view would pin the oversized
  // overlap-add buffer alive for the life of the stretched clip.
  return output.slice(0, outputLength);
}

/** Apply `wsolaStretch` to every channel of a buffer, into a new buffer on `context`. */
export function stretchAudioBuffer(context: BaseAudioContext, buffer: AudioBuffer, factor: number): AudioBuffer {
  if (Math.abs(factor - 1) < 1e-6) return buffer;
  const channels: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    channels.push(new Float32Array(wsolaStretch(buffer.getChannelData(c), factor, buffer.sampleRate)));
  }
  const length = Math.max(1, channels[0]?.length ?? 1);
  const out = context.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
  for (let c = 0; c < channels.length; c += 1) out.copyToChannel(channels[c]!, c);
  return out;
}
