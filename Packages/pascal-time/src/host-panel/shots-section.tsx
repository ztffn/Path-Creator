// The shot list: cameras and the moments they take over. "+ shot from view" captures the
// viewport camera's pose (via the scene driver's per-frame snapshot — the DOM can't reach into
// R3F) as a static shot at the playhead; time and blend edit inline, committing on blur as one
// node update each. A shot is a spatial node, so it is created at the scene root where placed
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
import { formatSeconds, styles, useKindNodes, useNodeLabel } from "./panel-shared";

export interface ShotRow {
  id: string;
  name: string;
  timeSeconds: number;
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

/** One numeric field; commits on blur/Enter as one node update. */
function ShotNumberField({
  value,
  label,
  min,
  onCommit
}: {
  value: number;
  label: string;
  min: number;
  onCommit: (next: number) => void;
}): ReactNode {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      style={{ ...styles.numberInput, width: 44 }}
      value={text ?? String(value)}
      aria-label={label}
      inputMode="decimal"
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (text === null) return;
        const parsed = Number(text);
        if (Number.isFinite(parsed) && parsed >= min && parsed !== value) onCommit(parsed);
        setText(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function ShotsSection({
  stored,
  shots
}: {
  stored: StoredTimeline;
  shots: ShotRow[];
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
      {shots.map((shot) => (
        <div key={shot.id} style={styles.listRow}>
          <button
            style={styles.iconButton}
            type="button"
            aria-label={`Seek to shot ${shot.name}`}
            // A shot takes over ACROSS its blend: at timeSeconds it is still 100% the previous
            // shot. Land where this shot fully owns the frame, or a seek "to" it shows its
            // predecessor and every edit looks like it hit the wrong shot.
            title={`Seek to ${formatSeconds(Math.min(shot.timeSeconds + shot.blendSeconds, stored.durationSeconds))} s — where this shot fully owns the frame`}
            onClick={() =>
              transport.seek(Math.min(shot.timeSeconds + shot.blendSeconds, stored.durationSeconds))
            }
          >
            ▲
          </button>
          <span style={styles.rowName} title={`${shot.name} (${shot.body})`}>
            {shot.name}
          </span>
          <span style={{ ...styles.muted, fontSize: 11 }}>@</span>
          <ShotNumberField
            value={shot.timeSeconds}
            label={`Shot ${shot.name} time in seconds`}
            min={0}
            onCommit={(timeSeconds) => updatePluginNode(shot.id, { timeSeconds })}
          />
          <span style={{ ...styles.muted, fontSize: 11 }}>blend</span>
          <ShotNumberField
            value={shot.blendSeconds}
            label={`Shot ${shot.name} blend in seconds`}
            min={0}
            onCommit={(blendSeconds) => updatePluginNode(shot.id, { blendSeconds })}
          />
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
      ))}
    </div>
  );
}
