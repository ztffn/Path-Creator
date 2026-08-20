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
  /** Playback rate. Scales `advance`'s deltas only — scrubbing and seeking are rate-blind. */
  rate: number;
  /**
   * Whether the camera director follows the timeline. The AUTHOR grabbing the camera (orbiting
   * to frame a new shot) takes ownership — the director stands down so the framing is not a
   * per-frame fight it always wins — and the next transport intent (play, seek, preview-on)
   * reclaims it: diverge, then snap back on advance. Object driving is unaffected.
   */
  cameraFollow: boolean;
  /**
   * The shot the picture-in-picture previews, or null when the PiP is off (M1.8).
   *
   * Ephemeral like everything else here, and that is the point: the PiP is a way of LOOKING at
   * the scene, not a fact about it, so turning it on must not touch the document or Pascal's
   * undo. It also has to live in this store rather than in the panel's React state, because the
   * two halves are in different entries — the panel (DOM) chooses the shot, the renderer (R3F)
   * draws it, and this store is the only thing they share.
   */
  pipShotId: string | null;
  /**
   * The path node whose control points are editable in the viewport, or null (M1.7).
   *
   * Ephemeral for the same reason as the PiP: which rail an author is shaping is a mode they are
   * in, not a fact about the scene, so entering it must not touch the document or Pascal's undo.
   * The panel sets it and the viewport overlay reads it — and they live in different package
   * entries, so this store is the only thing they share.
   */
  pathEditId: string | null;
  /** Point the transport at a timeline. Resets the clock; a new subject is a new session. */
  setTimeline(id: string | null): void;
  play(): void;
  pause(): void;
  /** Scrub. In preview it takes ownership of the scene; in edit mode it only parks the clock. */
  seek(time: number): void;
  setPreview(on: boolean): void;
  setRate(rate: number): void;
  /** The author took the camera (started a viewport drag). The director stands down. */
  userGrabbedCamera(): void;
  /** Preview a shot in the PiP, or null to turn it off. Never writes to the document. */
  setPipShot(shotId: string | null): void;
  /** Edit a path's control points in the viewport, or null to stop. Never writes the document. */
  setPathEdit(pathId: string | null): void;
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
  rate: 1,
  cameraFollow: true,
  pipShotId: null,
  pathEditId: null,

  setTimeline: (id) => {
    if (get().timelineId === id) return;
    set({
      timelineId: id,
      time: 0,
      playing: false,
      driving: false,
      preview: true,
      cameraFollow: true,
      // A new clock is a new session: an id from the old scene names nothing here.
      pipShotId: null,
      pathEditId: null
    });
  },

  play: () => {
    if (!get().timelineId) return;
    // Play IS a preview — pressing it in edit mode is the author asking to watch. It also
    // reclaims the camera from an author's grab: the ride takes over on advance.
    set({ playing: true, driving: true, preview: true, cameraFollow: true });
  },

  pause: () => set({ playing: false }),

  seek: (time) => {
    if (!get().timelineId) return;
    set({
      time: Math.max(0, time),
      cameraFollow: true,
      ...(get().preview ? { driving: true } : {})
    });
  },

  setPreview: (on) => {
    if (on === get().preview) return;
    // Leaving preview releases the scene; entering it re-takes ownership at the parked time.
    if (on) {
      set({ preview: true, cameraFollow: true, ...(get().timelineId ? { driving: true } : {}) });
    } else {
      set({ preview: false, driving: false, playing: false });
    }
  },

  userGrabbedCamera: () => set({ cameraFollow: false }),

  setPipShot: (shotId) => set({ pipShotId: shotId }),

  setPathEdit: (pathId) => set({ pathEditId: pathId }),

  release: () => set({ playing: false, driving: false }),

  setRate: (rate) => {
    if (Number.isFinite(rate) && rate > 0) set({ rate });
  },

  advance: (delta, duration, loop) => {
    const state = get();
    if (!state.playing) return;
    if (duration <= 0) {
      set({ time: 0, playing: false });
      return;
    }
    const next = state.time + delta * state.rate;
    if (next < duration) {
      set({ time: next });
    } else if (loop) {
      set({ time: next % duration });
    } else {
      set({ time: duration, playing: false });
    }
  }
}));
