// Purpose: Exposes the state a headless browser check needs on window.__editorProbe — registry
// sizes, the scene's timeline and transport, live object positions, undo depth, and a rAF beat
// as the control that fails when the instrument (the tab itself) stops running. injectDemoTrack
// authors a two-key lift track through the same putTrack seam the panel uses, so measure.mjs
// can prove driving before the keyframe-authoring UI exists. Reads stores, writes only via
// putTrack on request. measure.mjs depends on every field here — change them together.
"use client";

import { ColumnNode, nodeRegistry, sceneRegistry, useScene } from "@pascal-app/core";
import { useViewer } from "@pascal-app/viewer";
import {
  createPluginNode,
  getViewportCameraPose,
  pascalTimeTransport,
  putTrack,
  readCues,
  readShots,
  readStoredTimeline,
  readTimeline,
  TIMELINE_KIND,
  updatePluginNode,
  type ViewportCameraPose
} from "@huma/pascal-time";
import { useEffect } from "react";

type EditorProbe = {
  nodeRegistrySize: number;
  sceneNodeCount: number;
  sceneRegistrySize: number;
  installedPlugins: readonly string[];
  timelineId: string | null;
  tracksCount: number | null;
  cuesCount: number;
  shotsCount: number;
  /** Whether evaluation sees a camera track (persisted or synthesised from shot nodes). */
  hasCameraTrack: boolean;
  cameraPose: ViewportCameraPose | null;
  transport: { time: number; playing: boolean; driving: boolean; preview: boolean };
  undoDepth: number;
  rafBeats: number;
  findNodeIdByType(type: string): string | null;
  nodeField(id: string, field: string): unknown;
  objectPosition(id: string): [number, number, number] | null;
  objectVisible(id: string): boolean | null;
  injectDemoTrack(objectId: string): boolean;
  /** Author a real Pascal column under the level, as the wall tool would. */
  createTestColumn(id: string, position: [number, number, number]): boolean;
  /** Select a node the way a viewport click would — the Key button reads this. */
  selectNode(id: string): void;
  /** Move a node's AUTHORED position (one updateNode — the gizmo's document write). */
  setNodePosition(id: string, position: [number, number, number]): void;
};

declare global {
  interface Window {
    __editorProbe?: EditorProbe;
  }
}

const findNodeIdByType = (type: string): string | null => {
  for (const [id, node] of Object.entries(useScene.getState().nodes)) {
    if ((node as { type?: string }).type === type) return id;
  }
  return null;
};

const objectPosition = (id: string): [number, number, number] | null => {
  const object = sceneRegistry.nodes.get(id);
  return object ? [object.position.x, object.position.y, object.position.z] : null;
};

const objectVisible = (id: string): boolean | null =>
  sceneRegistry.nodes.get(id)?.visible ?? null;

const nodeField = (id: string, field: string): unknown =>
  (useScene.getState().nodes as Record<string, Record<string, unknown>>)[id]?.[field];

/** A two-key lift over the scene's clock, written through the panel's own persistence seam. */
const injectDemoTrack = (objectId: string): boolean => {
  const timelineId = findNodeIdByType(TIMELINE_KIND);
  if (!timelineId) return false;
  putTrack(timelineId, {
    type: "transform",
    id: `probe_lift_${objectId}`,
    objectId,
    position: [
      { time: 0, value: [0, 0, 0] },
      { time: 4, value: [0, 3, 0] }
    ]
  });
  return true;
};

const createTestColumn = (id: string, position: [number, number, number]): boolean => {
  const levelId = findNodeIdByType("level");
  if (!levelId) return false;
  const column = ColumnNode.parse({ id, type: "column", parentId: levelId, position });
  createPluginNode(column as never, levelId);
  return true;
};

const selectNode = (id: string): void => {
  useViewer.getState().setSelection({ selectedIds: [id] as never });
};

const setNodePosition = (id: string, position: [number, number, number]): void => {
  updatePluginNode(id, { position });
};

export function DevProbe() {
  useEffect(() => {
    let rafBeats = 0;
    let rafHandle = 0;
    const beat = () => {
      rafBeats += 1;
      rafHandle = requestAnimationFrame(beat);
    };
    rafHandle = requestAnimationFrame(beat);

    const interval = setInterval(() => {
      const transport = pascalTimeTransport.getState();
      const temporal = (
        useScene as unknown as {
          temporal: { getState(): { pastStates: unknown[] } };
        }
      ).temporal;
      const timelineId = findNodeIdByType(TIMELINE_KIND);
      window.__editorProbe = {
        nodeRegistrySize: Array.from(nodeRegistry.entries()).length,
        sceneNodeCount: Object.keys(useScene.getState().nodes).length,
        sceneRegistrySize: sceneRegistry.nodes.size,
        installedPlugins: useScene.getState().installedPlugins,
        timelineId,
        tracksCount: timelineId ? (readStoredTimeline(timelineId)?.tracks.length ?? null) : null,
        cuesCount: timelineId ? readCues(timelineId).length : 0,
        shotsCount: timelineId ? readShots(timelineId).length : 0,
        hasCameraTrack: timelineId
          ? (readTimeline(timelineId)?.tracks.some((track) => track.type === "camera") ?? false)
          : false,
        cameraPose: getViewportCameraPose(),
        transport: {
          time: transport.time,
          playing: transport.playing,
          driving: transport.driving,
          preview: transport.preview
        },
        undoDepth: temporal.getState().pastStates.length,
        rafBeats,
        findNodeIdByType,
        nodeField,
        objectPosition,
        objectVisible,
        injectDemoTrack,
        createTestColumn,
        selectNode,
        setNodePosition
      };
    }, 250);

    return () => {
      cancelAnimationFrame(rafHandle);
      clearInterval(interval);
    };
  }, []);

  return null;
}
