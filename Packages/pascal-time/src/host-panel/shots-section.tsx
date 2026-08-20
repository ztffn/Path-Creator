// The shot list: cameras and the blocks of time they own. "+ shot from view" captures the
// viewport camera's pose (via the scene driver's per-frame snapshot — the DOM can't reach into
// R3F) as a static shot starting at the playhead; start and end edit inline, committing on blur
// as one node update each. Reaching past the next shot's start is what authors a crossover. A shot is a spatial node, so it is created at the scene root where placed
// things live, and deleting or renaming it is Pascal's ordinary node lifecycle. Orbit shots
// author through the inspector (parametrics), not here — this list owns timing and creation.
"use client";

import { useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { useViewer } from "@pascal-app/editor";
import { getViewportCameraPose } from "../drive/timeline-scene-driver";
import {
  buildShotNode,
  createPluginNode,
  deletePluginNode,
  updatePluginNode
} from "../plugin/scene-ops";
import { SHOT_KIND } from "../plugin/kinds";
import type { StoredTimeline } from "../plugin/timeline-io";
import { pascalTimeTransport } from "../transport/store";
import { formatSeconds, NodeNumberField, styles, useKindNodes, useNodeLabel } from "./panel-shared";

/** A captured shot owns this much time by default — long enough to see, short enough to drag. */
const DEFAULT_SHOT_SECONDS = 4;

export interface ShotRow {
  id: string;
  name: string;
  timeSeconds: number;
  /** Block end as AUTHORED. 0 (or <= start) means unset; the resolver fills it in. */
  endSeconds: number;
  /** Legacy blend duration, kept only so the resolver can reconstruct a span without one. */
  blendSeconds: number;
  body: string;
  targetNodeId: string;
}

/** The timeline's shots, reactively: nodes of the shot kind naming this clock. */
export function useShotRows(timelineId: string): ShotRow[] {
  return useKindNodes<ShotRow>(SHOT_KIND, (id, node) =>
    node.timelineId === timelineId
      ? {
          id,
          name: (node.name as string | undefined) ?? id,
          timeSeconds: (node.timeSeconds as number | undefined) ?? 0,
          endSeconds: (node.endSeconds as number | undefined) ?? 0,
          blendSeconds: (node.blendSeconds as number | undefined) ?? 0,
          body: (node.body as string | undefined) ?? "static",
          targetNodeId: (node.targetNodeId as string | undefined) ?? ""
        }
      : null
  );
}

/**
 * The orbit target has no declarative inspector field (there is no free-text field kind, and
 * `ref` filters by one node kind, which a camera target is not). So the panel owns it, with
 * the affordance an author actually wants: click the thing to frame, press the button.
 */
function OrbitTargetButton({ shot }: { shot: ShotRow }): ReactNode {
  const selectedIds = useViewer((s) => s.selection.selectedIds);
  const label = useNodeLabel();
  const candidate = selectedIds[0] ?? null;
  const usable = candidate !== null && candidate !== shot.id && !candidate.startsWith("humatime_");

  return (
    <button
      style={{ ...styles.smallButton, opacity: usable || shot.targetNodeId ? 1 : 0.4 }}
      type="button"
      disabled={!usable && !shot.targetNodeId}
      title={
        usable
          ? `Orbit ${label(candidate)} (the viewport selection)`
          : shot.targetNodeId
            ? `Orbiting ${label(shot.targetNodeId)} — select another object to retarget`
            : "Select the object to orbit in the viewport first"
      }
      onClick={() => {
        if (usable) updatePluginNode(shot.id, { targetNodeId: candidate });
      }}
    >
      ⊚ {shot.targetNodeId ? label(shot.targetNodeId) : "target ⇐ sel"}
    </button>
  );
}

export function ShotsSection({
  stored,
  shots,
  blocks
}: {
  stored: StoredTimeline;
  shots: ShotRow[];
  /** The resolved spans, so a row shows the block it actually owns rather than its raw fields. */
  blocks: Map<string, { start: number; end: number; blendSeconds: number }>;
}): ReactNode {
  const time = useStore(pascalTimeTransport, (s) => s.time);
  const transport = pascalTimeTransport.getState();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={styles.row}>
        <span style={styles.sectionTitle}>Shots</span>
        <button
          style={styles.smallButton}
          type="button"
          title={`Capture the current viewport camera as a shot taking over at ${formatSeconds(time)} s`}
          onClick={() => {
            const pose = getViewportCameraPose();
            if (!pose) return; // no frame has run yet — nothing to capture
            createPluginNode(
              buildShotNode({
                name: `Shot ${shots.length + 1}`,
                timelineId: stored.id,
                timeSeconds: time,
                body: "static",
                endSeconds: time + DEFAULT_SHOT_SECONDS,
                position: pose.position,
                rotationDeg: pose.rotationDeg,
                fov: pose.fov
              })
            );
          }}
        >
          + shot from view @ {formatSeconds(time)} s
        </button>
      </div>
      {shots.map((shot) => {
        const block = blocks.get(shot.id);
        const landsAt = Math.min(
          shot.timeSeconds + (block?.blendSeconds ?? 0),
          stored.durationSeconds
        );
        return (
        <div key={shot.id} style={styles.listRow}>
          <button
            style={styles.iconButton}
            type="button"
            aria-label={`Seek to shot ${shot.name}`}
            // A shot takes over ACROSS its overlap with the previous one: at its own start it is
            // still 100% the predecessor. Land where this shot fully owns the frame, or a seek
            // "to" it shows the shot before and every edit looks like it hit the wrong one.
            title={`Seek to ${formatSeconds(landsAt)} s — where this shot fully owns the frame`}
            onClick={() => transport.seek(landsAt)}
          >
            ▲
          </button>
          <span style={styles.rowName} title={`${shot.name} (${shot.body})`}>
            {shot.name}
          </span>
          <span style={{ ...styles.muted, fontSize: 11 }}>@</span>
          <NodeNumberField
            value={shot.timeSeconds}
            label={`Shot ${shot.name} start in seconds`}
            min={0}
            width={44}
            onCommit={(timeSeconds) => updatePluginNode(shot.id, { timeSeconds })}
          />
          <span style={{ ...styles.muted, fontSize: 11 }}>to</span>
          <NodeNumberField
            value={block?.end ?? shot.timeSeconds}
            label={`Shot ${shot.name} end in seconds`}
            min={0}
            width={44}
            // Editing the end is editing the crossover: past the next shot's start, the excess
            // IS the blend. Committing the RESOLVED end when the field was never authored keeps
            // the number the author sees and the number they change the same one.
            onCommit={(endSeconds) => updatePluginNode(shot.id, { endSeconds })}
          />
          {block && block.blendSeconds > 0 ? (
            <span
              style={{ ...styles.muted, fontSize: 11 }}
              title="Overlap with the previous shot — this is the crossover"
            >
              ↹{formatSeconds(block.blendSeconds)}
            </span>
          ) : null}
          {shot.body === "orbit" ? <OrbitTargetButton shot={shot} /> : null}
          <button
            style={styles.iconButton}
            type="button"
            aria-label={`Delete shot ${shot.name}`}
            title="Delete this shot"
            onClick={() => deletePluginNode(shot.id)}
          >
            ✕
          </button>
        </div>
        );
      })}
    </div>
  );
}
