// Tests for the mixdown's WAV encoding. The render itself needs Web Audio and is
// verified in the browser; what is checkable here is the container — a malformed
// header produces a file that opens nowhere, silently, which is the worst outcome
// for an export whose whole job is to be read by another tool.
import { describe, expect, it } from "vitest";
import { encodeWav } from "./audio-bake";

const fakeBuffer = (channels: number[][], sampleRate = 48000): AudioBuffer =>
  ({
    numberOfChannels: channels.length,
    length: channels[0]!.length,
    sampleRate,
    duration: channels[0]!.length / sampleRate,
    getChannelData: (c: number) => Float32Array.from(channels[c]!)
  }) as unknown as AudioBuffer;

async function readWav(blob: Blob) {
  const view = new DataView(await blob.arrayBuffer());
  const text = (at: number, len: number) =>
    String.fromCharCode(...Array.from({ length: len }, (_, i) => view.getUint8(at + i)));
  return {
    riff: text(0, 4),
    wave: text(8, 4),
    fmt: text(12, 4),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bits: view.getUint16(34, true),
    data: text(36, 4),
    dataBytes: view.getUint32(40, true),
    declaredSize: view.getUint32(4, true),
    totalBytes: view.byteLength,
    sampleAt: (i: number) => view.getInt16(44 + i * 2, true)
  };
}

describe("encodeWav", () => {
  it("writes a well-formed 16-bit PCM header whose sizes agree with the payload", async () => {
    const wav = await readWav(encodeWav(fakeBuffer([[0, 0.5], [0, -0.5]], 44100)));
    expect(wav.riff).toBe("RIFF");
    expect(wav.wave).toBe("WAVE");
    expect(wav.fmt).toBe("fmt ");
    expect(wav.data).toBe("data");
    expect(wav.format).toBe(1); // PCM
    expect(wav.bits).toBe(16);
    expect(wav.channels).toBe(2);
    expect(wav.sampleRate).toBe(44100);
    expect(wav.byteRate).toBe(44100 * 2 * 2);
    expect(wav.blockAlign).toBe(4);
    expect(wav.dataBytes).toBe(2 * 2 * 2); // 2 frames x 2 channels x 2 bytes
    expect(wav.declaredSize).toBe(wav.totalBytes - 8);
  });

  it("interleaves channels frame by frame", async () => {
    const wav = await readWav(encodeWav(fakeBuffer([[1, 0], [0, 1]])));
    expect(wav.sampleAt(0)).toBe(32767); // frame 0, left
    expect(wav.sampleAt(1)).toBe(0); // frame 0, right
    expect(wav.sampleAt(2)).toBe(0); // frame 1, left
    expect(wav.sampleAt(3)).toBe(32767); // frame 1, right
  });

  it("clamps an overloaded mix instead of wrapping it", async () => {
    // A summed mix can exceed unity. Wrapping would flip a loud peak to the opposite
    // rail and read as a click; clamping reads as the overload it actually is.
    const wav = await readWav(encodeWav(fakeBuffer([[2, -2]])));
    expect(wav.sampleAt(0)).toBe(32767);
    expect(wav.sampleAt(1)).toBe(-32768);
  });
});
