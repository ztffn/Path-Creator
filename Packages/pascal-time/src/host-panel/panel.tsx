// The timeline panel Pascal's editor mounts in its icon rail — M1.3's authoring surface,
// composed from the section files beside it: transport (with cue/shot markers), keyframe and
// visibility capture, the track list with curve and clip editors, cues, shots, and the selected
// shot's camera language (M1.8: blend curve, lens push, aim). It receives
// NO props (the host-panel contract renders <Panel /> bare); everything comes from stores — the
// scene document via useScene, playback via pascalTimeTransport. Every document write goes
// through timeline-io/scene-ops, batched per gesture, one undo entry each.
"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useViewer } from "@pascal-app/editor";
import {
  buildTimelineNode,
  createPluginNode
} from "../plugin/scene-ops";
import { installPascalTimeOnScene } from "../plugin/install";
import { pascalTimeTransport } from "../transport/store";
import { readShotBlocks } from "../plugin/timeline-io";
import { styles, useSceneTimelineId, useStoredTimeline } from "./panel-shared";
import { DurationField, TransportSection, type TimeMarker } from "./transport-section";
import { KeyingSection } from "./keying-section";
import { TracksSection } from "./tracks-section";
import { CuesSection, useCueRows } from "./cues-section";
import { ShotsSection, useShotRows } from "./shots-section";
import { RailsSection } from "./rails-section";
import { ShotCameraSection } from "./shot-camera-section";
import { LaneDock } from "./lane-dock";

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
  // Shared between the sidebar's detail editors and the lane dock: clicking a lane opens the
  // matching curve/clip editor here, and vice versa.
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  // The resolved spans, in one place: the shot list, the markers and the lane dock must agree on
  // what block a shot owns, and the span rule (authored end, else the legacy layout) lives in the
  // resolver rather than being re-derived by each of them.
  const blocks = useMemo(() => {
    const duration = stored?.durationSeconds ?? 0;
    return new Map(
      readShotBlocks(timelineId, duration).map((block) => [block.id, block] as const)
    );
    // `shots` changes with the document, which is exactly when a span can change.
  }, [timelineId, stored?.durationSeconds, shots]);
  if (!stored) return <EmptyState />;

  const markers: TimeMarker[] = [
    ...cues.map((cue): TimeMarker => ({ ...cue, kind: "cue" })),
    ...shots.map(
      (shot): TimeMarker => ({
        ...shot,
        kind: "shot",
        seekSeconds: Math.min(
          shot.timeSeconds + (blocks.get(shot.id)?.blendSeconds ?? 0),
          stored.durationSeconds
        )
      })
    )
  ];

  return (
    <div style={styles.root}>
      <div style={styles.row}>
        <div style={styles.title}>{stored.name}</div>
        <DurationField stored={stored} />
      </div>
      <TransportSection stored={stored} markers={markers} />
      <KeyingSection stored={stored} />
      <TracksSection
        stored={stored}
        selectedTrackId={selectedTrackId}
        onSelectTrack={setSelectedTrackId}
      />
      <CuesSection stored={stored} cues={cues} />
      <ShotsSection stored={stored} shots={shots} blocks={blocks} />
      <ShotCameraSection blocks={blocks} />
      <RailsSection stored={stored} />
      <div style={styles.muted}>
        {stored.tracks.length} track{stored.tracks.length === 1 ? "" : "s"}
        {stored.loop ? " · loops" : ""}
      </div>
      <LaneDock
        stored={stored}
        cues={cues}
        shots={shots}
        blocks={blocks}
        selectedTrackId={selectedTrackId}
        onSelectTrack={setSelectedTrackId}
      />
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

  // The author grabbing the viewport camera takes it from the director (R9: one owner per
  // frame — during a drag, the author is that owner). Without this, framing a new shot while
  // a shot is active is a fight the director wins every frame, and "add shot from view"
  // captures the fight instead of the framing. Play/seek reclaim the camera in the transport.
  useEffect(() => {
    return useViewer.subscribe((state, previous) => {
      if (state.inputDragging && !previous.inputDragging) {
        pascalTimeTransport.getState().userGrabbedCamera();
      }
    });
  }, []);

  if (!timelineId) return <EmptyState />;
  return <PanelBody timelineId={timelineId} />;
}
