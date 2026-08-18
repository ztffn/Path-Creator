// The cue list: named moments on the clock, created at the playhead, renamed inline, retimed
// to the playhead or by typing, sought with one click, deleted with one. Every mutation is one
// store operation (create/update/delete a node), so every gesture is one undo entry — cues are
// scene nodes precisely so Pascal's own undo, naming and persistence do the heavy lifting.
// Names commit on blur; a cue's node id IS its cue id, so nothing here mints identifiers.
"use client";

import { useState, type ReactNode } from "react";
import { useStore } from "zustand";
import {
  buildCueNode,
  createPluginNode,
  deletePluginNode,
  updatePluginNode
} from "../plugin/scene-ops";
import { CUE_KIND } from "../plugin/kinds";
import type { StoredTimeline } from "../plugin/timeline-io";
import { pascalTimeTransport } from "../transport/store";
import { formatSeconds, styles, useKindNodes } from "./panel-shared";

export interface CueRow {
  id: string;
  name: string;
  timeSeconds: number;
}

/** The timeline's cues, reactively: nodes of the cue kind parented to this clock. */
export function useCueRows(timelineId: string): CueRow[] {
  return useKindNodes<CueRow>(CUE_KIND, (id, node) =>
    node.parentId === timelineId
      ? {
          id,
          name: (node.name as string | undefined) ?? id,
          timeSeconds: (node.timeSeconds as number | undefined) ?? 0
        }
      : null
  );
}

/** Inline rename; commits on blur/Enter as one node update. */
function CueNameField({ cue }: { cue: CueRow }): ReactNode {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      style={styles.textInput}
      value={text ?? cue.name}
      aria-label={`Cue name`}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (text !== null && text.trim() && text !== cue.name) {
          updatePluginNode(cue.id, { name: text.trim() });
        }
        setText(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function CuesSection({
  stored,
  cues
}: {
  stored: StoredTimeline;
  cues: CueRow[];
}): ReactNode {
  const time = useStore(pascalTimeTransport, (s) => s.time);
  const transport = pascalTimeTransport.getState();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={styles.row}>
        <span style={styles.sectionTitle}>Cues</span>
        <button
          style={styles.smallButton}
          type="button"
          title={`Add a cue at ${formatSeconds(time)} s`}
          onClick={() =>
            createPluginNode(
              buildCueNode({ name: `Cue ${cues.length + 1}`, timeSeconds: time }),
              stored.id
            )
          }
        >
          + cue @ {formatSeconds(time)} s
        </button>
      </div>
      {cues.map((cue) => (
        <div key={cue.id} style={styles.listRow}>
          <button
            style={styles.iconButton}
            type="button"
            aria-label={`Seek to cue ${cue.name}`}
            title={`Seek to ${formatSeconds(cue.timeSeconds)} s`}
            onClick={() => transport.seek(cue.timeSeconds)}
          >
            ◆
          </button>
          <CueNameField cue={cue} />
          <span style={{ ...styles.muted, fontSize: 11 }}>
            {formatSeconds(cue.timeSeconds)} s
          </span>
          <button
            style={styles.iconButton}
            type="button"
            aria-label={`Retime cue ${cue.name} to the playhead`}
            title={`Move this cue to ${formatSeconds(time)} s`}
            onClick={() => updatePluginNode(cue.id, { timeSeconds: time })}
          >
            ⌖
          </button>
          <button
            style={styles.iconButton}
            type="button"
            aria-label={`Delete cue ${cue.name}`}
            title="Delete this cue"
            onClick={() => deletePluginNode(cue.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
