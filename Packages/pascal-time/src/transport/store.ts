// The playback transport: one store both halves of the plugin share. The panel (DOM, host-panel
// entry) writes intent — play, pause, seek, release; the scene driver (R3F, runtime entry) reads
// it every frame, advances the clock, and drives. It is deliberately EPHEMERAL state: nothing
// here touches the scene document, which is why scrubbing and playback leave Pascal's undo
// history alone by construction. One instance per module graph; tsup code-splitting keeps the
// two entries importing the same chunk rather than two copies (a silent two-store failure mode).
import { createStore } from "zustand/vanilla";

export interface PascalTimeTransportState {
  /** The timeline node this transport conducts, or null when the scene has none. */
  timelineId: string | null;
  /** Timeline seconds. Evaluation is a pure function of this (R7). */
  time: number;
  /** Whether the clock is advancing. Pausing keeps the scene held at `time`. */
  playing: boolean;
  /**
   * Whether the timeline owns the scene. Going false is not "pause" — it is "give the objects
   * back": the driver restores every touched object to its pre-drive pose (R5).
   */
  driving: boolean;
  /**
   * Whether scrubbing previews the animation (drives the scene). OFF is edit mode: the
   * playhead parks at a time WITHOUT owning the scene, so the author can pose an already-
   * tracked object with Pascal's own tools and key it — posing a driven object is a fight
   * the driver always wins (R4). Play always previews; turning preview off releases.
   */
  preview: boolean;
  /** Point the transport at a timeline. Resets the clock; a new subject is a new session. */
  setTimeline(id: string | null): void;
  play(): void;
  pause(): void;
  /** Scrub. In preview it takes ownership of the scene; in edit mode it only parks the clock. */
  seek(time: number): void;
  setPreview(on: boolean): void;
  /** Stop and hand the scene back. The clock keeps its position for a later re-engage. */
  release(): void;
  /**
   * Advance the clock by one frame. Called by the scene driver, not the panel, so there is
   * exactly one clock owner per frame. At the end: loop wraps, otherwise playback stops AT the
   * duration — `playing` goes false on that exact frame, which is the signal the activation
   * director reads as "playback finished" rather than "scrubbed to the end".
   */
  advance(delta: number, duration: number, loop: boolean): void;
}

export const pascalTimeTransport = createStore<PascalTimeTransportState>()((set, get) => ({
  timelineId: null,
  time: 0,
  playing: false,
  driving: false,
  preview: true,

  setTimeline: (id) => {
    if (get().timelineId === id) return;
    set({ timelineId: id, time: 0, playing: false, driving: false, preview: true });
  },

  play: () => {
    if (!get().timelineId) return;
    // Play IS a preview — pressing it in edit mode is the author asking to watch.
    set({ playing: true, driving: true, preview: true });
  },

  pause: () => set({ playing: false }),

  seek: (time) => {
    if (!get().timelineId) return;
    set({ time: Math.max(0, time), ...(get().preview ? { driving: true } : {}) });
  },

  setPreview: (on) => {
    if (on === get().preview) return;
    // Leaving preview releases the scene; entering it re-takes ownership at the parked time.
    if (on) {
      set({ preview: true, ...(get().timelineId ? { driving: true } : {}) });
    } else {
      set({ preview: false, driving: false, playing: false });
    }
  },

  release: () => set({ playing: false, driving: false }),

  advance: (delta, duration, loop) => {
    const state = get();
    if (!state.playing) return;
    if (duration <= 0) {
      set({ time: 0, playing: false });
      return;
    }
    const next = state.time + delta;
    if (next < duration) {
      set({ time: next });
    } else if (loop) {
      set({ time: next % duration });
    } else {
      set({ time: duration, playing: false });
    }
  }
}));
