// The timeline panel Pascal's editor mounts in its icon rail — M1.3's authoring surface,
// composed from the section files beside it: transport (with cue/shot markers), keyframe and
// visibility capture, the track list with curve and clip editors, cues, and shots. It receives
// NO props (the host-panel contract renders <Panel /> bare); everything comes from stores — the
// scene document via useScene, playback via pascalTimeTransport. Every document write goes
// through timeline-io/scene-ops, batched per gesture, one undo entry each.
"use client";

import { useEffect, type ReactNode } from "react";
import {
  buildTimelineNode,
  createPluginNode
} from "../plugin/scene-ops";
import { installPascalTimeOnScene } from "../plugin/install";
import { pascalTimeTransport } from "../transport/store";
import { styles, useSceneTimelineId, useStoredTimeline } from "./panel-shared";
import { DurationField, TransportSection, type TimeMarker } from "./transport-section";
import { KeyingSection } from "./keying-section";
import { TracksSection } from "./tracks-section";
import { CuesSection, useCueRows } from "./cues-section";
import { ShotsSection, useShotRows } from "./shots-section";

function EmptyState(): ReactNode {
  return (
    <div style={styles.root}>
      <div style={styles.title}>Timeline</div>
      <p style={styles.muted}>
        This scene has no timeline yet. A timeline is the scene&apos;s clock — keyframes, cues
        and camera shots are all measured on it.
      </p>
      <button
        style={styles.button}
        type="button"
        onClick={() => {
          // One authored action: opt the scene into the plugin's kinds and place the clock.
          // Node creation is a document edit, so Pascal's undo owns it — Ctrl+Z removes it.
          installPascalTimeOnScene();
          createPluginNode(buildTimelineNode({ name: "Timeline" }));
        }}
      >
        Create timeline
      </button>
    </div>
  );
}

function PanelBody({ timelineId }: { timelineId: string }): ReactNode {
  const stored = useStoredTimeline(timelineId);
  const cues = useCueRows(timelineId);
  const shots = useShotRows(timelineId);
  if (!stored) return <EmptyState />;

  const markers: TimeMarker[] = [
    ...cues.map((cue): TimeMarker => ({ ...cue, kind: "cue" })),
    ...shots.map((shot): TimeMarker => ({ ...shot, kind: "shot" }))
  ];

  return (
    <div style={styles.root}>
      <div style={styles.row}>
        <div style={styles.title}>{stored.name}</div>
        <DurationField stored={stored} />
      </div>
      <TransportSection stored={stored} markers={markers} />
      <KeyingSection stored={stored} />
      <TracksSection stored={stored} />
      <CuesSection stored={stored} cues={cues} />
      <ShotsSection stored={stored} shots={shots} />
      <div style={styles.muted}>
        {stored.tracks.length} track{stored.tracks.length === 1 ? "" : "s"}
        {stored.loop ? " · loops" : ""}
      </div>
    </div>
  );
}

export default function TimelinePanel(): ReactNode {
  const timelineId = useSceneTimelineId();

  // Keep the shared transport pointed at the scene's clock. setTimeline is a no-op on the
  // same id, so this is safe to run on every document change.
  useEffect(() => {
    pascalTimeTransport.getState().setTimeline(timelineId);
  }, [timelineId]);

  if (!timelineId) return <EmptyState />;
  return <PanelBody timelineId={timelineId} />;
}
