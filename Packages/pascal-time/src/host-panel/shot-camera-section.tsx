// The selected shot's camera language (M1.8): the blend curve it takes over on, a FOV push
// across its window, and what it aims at. These are the parts of the language that have no
// declarative inspector field — a curve is not a field kind and a node reference is not a `ref`
// — so the panel owns them, mounting the library's own `EasingEditor` for the curves. Every
// gesture is ONE undo entry: the curve editor fires per pointer-move, so edits buffer and commit
// on pointerup, exactly as the track curve editor does.
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { useScene } from "@pascal-app/core";
import { useViewer } from "@pascal-app/editor";
import { EasingEditor, type EasingEditorTheme } from "@huma/path-creator/timeline-ui";
import type { Easing } from "@huma/path-creator/core";
import { updatePluginNode } from "../plugin/scene-ops";
import { SHOT_KIND } from "../plugin/kinds";
import { pascalTimeTransport } from "../transport/store";
import { NodeNumberField, styles, useNodeLabel } from "./panel-shared";
import { PipOverlay } from "./pip-overlay";

/** Matches the dock's palette so the two curve surfaces read as one system. */
const EASING_THEME: EasingEditorTheme = {
  background: "rgba(16, 17, 20, 0.6)",
  grid: "rgba(120, 128, 140, 0.22)",
  reference: "rgba(154, 163, 178, 0.3)",
  curve: "rgba(96, 165, 250, 0.95)",
  speed: "rgba(249, 115, 22, 0.5)",
  handle: "rgba(249, 115, 22, 0.9)",
  anchor: "rgba(230, 232, 238, 0.95)",
  text: "var(--sidebar-foreground, #ddd)"
};

/**
 * `EasingEditor` with per-gesture write batching.
 *
 * The editor is controlled and fires `onChange` on every pointer-move, so writing straight
 * through would put one undo entry per frame of a drag into Pascal's history. Edits buffer into a
 * draft and the pointerup — which pointer capture guarantees bubbles back through this wrapper —
 * commits exactly one. Keyboard-free by construction: every gesture in this editor is a pointer
 * gesture, and the preset dropdown fires with no pointer down, so it commits immediately.
 */
export function BufferedEasingEditor({
  value,
  onCommit,
  height = 132
}: {
  value: Easing;
  onCommit: (next: Easing) => void;
  height?: number;
}): ReactNode {
  const [draft, setDraft] = useState<Easing | null>(null);
  const draftRef = useRef<Easing | null>(null);
  const pointerDown = useRef(false);
  // `onCommit` is an inline arrow that closes over the SELECTED shot, so it changes identity on
  // every render. The unmount commit below must call the current one: a stale closure would write
  // a half-finished drag to whichever shot was selected when this editor first mounted.
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  // The committed value changed under the editor (our own commit, an undo, another writer):
  // drop a stale draft rather than letting it overwrite what is now in the document.
  useEffect(() => {
    draftRef.current = null;
    setDraft(null);
  }, [value]);

  const commit = (): void => {
    if (draftRef.current === null) return;
    const next = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    onCommitRef.current(next);
  };

  // A draft must not outlive the editor — closing the panel mid-drag would drop the edit.
  useEffect(() => () => commit(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      onPointerDownCapture={() => {
        pointerDown.current = true;
      }}
      onPointerUpCapture={() => {
        pointerDown.current = false;
        commit();
      }}
      onPointerCancelCapture={() => {
        pointerDown.current = false;
        commit();
      }}
    >
      <EasingEditor
        value={draft ?? value}
        height={height}
        theme={EASING_THEME}
        onChange={(next) => {
          if (pointerDown.current) {
            draftRef.current = next;
            setDraft(next);
          } else {
            draftRef.current = null;
            setDraft(null);
            onCommit(next);
          }
        }}
      />
    </div>
  );
}

/** The camera-language fields of one shot node, re-read whenever the document changes. */
interface ShotCameraFields {
  name: string;
  blendCurve: Easing;
  fov: number;
  animateFov: boolean;
  fovEnd: number;
  fovEasing: Easing;
  aimMode: string;
  aimTargetNodeId: string;
  composerEnabled: boolean;
  noiseEnabled: boolean;
}

function useShotCameraFields(shotId: string | null): ShotCameraFields | null {
  const nodes = useScene((state) => state.nodes);
  if (!shotId) return null;
  const node = (nodes as Record<string, Record<string, unknown>>)[shotId];
  if (!node || node.type !== SHOT_KIND) return null;
  return {
    name: (node.name as string | undefined) ?? shotId,
    blendCurve: (node.blendCurve as Easing | undefined) ?? "easeInOut",
    fov: (node.fov as number | undefined) ?? 50,
    animateFov: node.animateFov === true,
    fovEnd: (node.fovEnd as number | undefined) ?? 50,
    fovEasing: (node.fovEasing as Easing | undefined) ?? "easeInOut",
    aimMode: (node.aimMode as string | undefined) ?? "body",
    aimTargetNodeId: (node.aimTargetNodeId as string | undefined) ?? "",
    composerEnabled: node.composerEnabled === true,
    noiseEnabled: node.noiseEnabled === true
  };
}

type Facet = "blend" | "lens" | "aim";

/**
 * The camera language of whatever shot the viewport has selected.
 *
 * Keying off the VIEWPORT selection rather than a selection of its own is deliberate: the lane
 * dock already styles the selected shot from it, and the floating inspector already edits that
 * shot's declarative fields. One notion of "the shot being edited" across all three.
 */
export function ShotCameraSection({
  blocks
}: {
  /** The resolved spans, so the blend copy names the real overlap rather than a stored number. */
  blocks: Map<string, { start: number; end: number; blendSeconds: number }>;
}): ReactNode {
  const selectedId = useViewer((s) => s.selection.selectedIds[0] ?? null);
  const shot = useShotCameraFields(selectedId);
  const [facet, setFacet] = useState<Facet>("blend");
  const label = useNodeLabel();
  const viewportSelection = useViewer((s) => s.selection.selectedIds);
  const pipShotId = useStore(pascalTimeTransport, (state) => state.pipShotId);
  const block = selectedId ? blocks.get(selectedId) : undefined;

  if (!selectedId || !shot) {
    // The overlay still renders: a PiP left on while the author deselects the shot should keep
    // showing that shot rather than vanishing because the sidebar lost its subject.
    return (
      <>
        <div style={styles.muted} data-shot-camera="empty">
          Select a shot to shape its blend, lens and aim.
        </div>
        <PipOverlay />
      </>
    );
  }

  const set = (patch: Record<string, unknown>): void => updatePluginNode(selectedId, patch);

  // "Aim at the viewport selection" needs a candidate that is not the shot itself and not one of
  // this plugin's own nodes — aiming a shot at a cue frames a thing with no position.
  const candidate = viewportSelection.find(
    (id) => id !== selectedId && !id.startsWith("humatime_")
  );

  const pipOn = pipShotId === selectedId;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-shot-camera={selectedId}>
      <div style={styles.row}>
        <span style={styles.sectionTitle}>Camera · {shot.name}</span>
        <button
          style={{ ...styles.chip, ...(pipOn ? styles.chipOn : {}) }}
          type="button"
          aria-pressed={pipOn}
          aria-label={`Preview ${shot.name} in a picture-in-picture`}
          title="Show what this shot sees, in an inset, while you keep your working view"
          onClick={() => pascalTimeTransport.getState().setPipShot(pipOn ? null : selectedId)}
        >
          PiP
        </button>
        {(["blend", "lens", "aim"] as const).map((name) => (
          <button
            key={name}
            style={{ ...styles.chip, ...(facet === name ? styles.chipOn : {}) }}
            type="button"
            aria-pressed={facet === name}
            title={
              name === "blend"
                ? "Shape how this shot takes over from the previous one"
                : name === "lens"
                  ? "Animate the lens across this shot's window"
                  : "Choose what this shot looks at"
            }
            onClick={() => setFacet(name)}
          >
            {name}
          </button>
        ))}
      </div>

      {facet === "blend" ? (
        <>
          <div style={styles.muted}>
            {block && block.blendSeconds > 0
              ? `Overlaps the previous shot by ${block.blendSeconds.toFixed(2)}s — the curve shapes that hand-off. Drag the block's left edge on the lane to lengthen it.`
              : "A cut: this shot does not overlap the previous one, so there is no hand-off to shape yet. Drag its left edge back over the shot before it."}
          </div>
          <BufferedEasingEditor
            value={shot.blendCurve}
            onCommit={(blendCurve) => set({ blendCurve })}
          />
        </>
      ) : null}

      {facet === "lens" ? (
        <>
          <div style={styles.row}>
            <button
              style={{ ...styles.chip, ...(shot.animateFov ? styles.chipOn : {}) }}
              type="button"
              aria-pressed={shot.animateFov}
              title="Animate the field of view across this shot's window"
              onClick={() => set({ animateFov: !shot.animateFov })}
            >
              FOV push
            </button>
            <span style={{ ...styles.muted, fontSize: 11 }}>{shot.fov}° →</span>
            <NodeNumberField
              value={shot.fovEnd}
              label={`Shot ${shot.name} end field of view in degrees`}
              min={1}
              max={179}
              width={44}
              onCommit={(fovEnd) => set({ fovEnd })}
            />
            <span style={{ ...styles.muted, fontSize: 11 }}>°</span>
          </div>
          {shot.animateFov ? (
            <BufferedEasingEditor
              value={shot.fovEasing}
              onCommit={(fovEasing) => set({ fovEasing })}
            />
          ) : (
            <div style={styles.muted}>
              Off: the shot holds {shot.fov}° for its whole window.
            </div>
          )}
        </>
      ) : null}

      {facet === "aim" ? (
        <>
          <div style={styles.row}>
            {(["body", "track"] as const).map((mode) => (
              <button
                key={mode}
                style={{ ...styles.chip, ...(shot.aimMode === mode ? styles.chipOn : {}) }}
                type="button"
                aria-pressed={shot.aimMode === mode}
                title={
                  mode === "body"
                    ? "Look where the body points (a static shot's rotation, an orbit's centre)"
                    : "Look at a node, wherever it moves"
                }
                onClick={() => set({ aimMode: mode })}
              >
                {mode === "body" ? "body aim" : "track a node"}
              </button>
            ))}
          </div>
          {shot.aimMode === "track" ? (
            <>
              <div style={styles.row}>
                <button
                  style={{ ...styles.smallButton, opacity: candidate || shot.aimTargetNodeId ? 1 : 0.4 }}
                  type="button"
                  disabled={!candidate && !shot.aimTargetNodeId}
                  title={
                    candidate
                      ? `Aim at ${label(candidate)} (also selected in the viewport)`
                      : shot.aimTargetNodeId
                        ? `Aiming at ${label(shot.aimTargetNodeId)} — select another object too, to re-aim`
                        : "Select the object to watch in the viewport as well as this shot"
                  }
                  onClick={() => {
                    if (candidate) set({ aimTargetNodeId: candidate });
                  }}
                >
                  ◎ {shot.aimTargetNodeId ? label(shot.aimTargetNodeId) : "aim ⇐ sel"}
                </button>
                <button
                  style={{ ...styles.chip, ...(shot.composerEnabled ? styles.chipOn : {}) }}
                  type="button"
                  aria-pressed={shot.composerEnabled}
                  title="Damped framing: reframe only once the target leaves the dead zone"
                  onClick={() => set({ composerEnabled: !shot.composerEnabled })}
                >
                  composer
                </button>
              </div>
              <div style={styles.muted}>
                {shot.composerEnabled
                  ? "Damped: the zones and damping live in the inspector. Scrubbing stays exact — only playback damps."
                  : "Instant: the target sits dead centre every frame."}
              </div>
            </>
          ) : (
            <div style={styles.muted}>
              Body aim: a static shot looks along its rotation, an orbit shot looks at its centre.
            </div>
          )}
        </>
      ) : null}
      <PipOverlay />
    </div>
  );
}
