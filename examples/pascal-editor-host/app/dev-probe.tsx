// Purpose: Exposes the state a headless browser check needs on window.__editorProbe — registry
// sizes, the scene's timeline and transport, live object positions, undo depth, the camera blocks
// evaluation reads, the PiP's scissored pass (which the DOM cannot see), and a rAF beat as the
// control that fails when the instrument (the tab itself) stops running. injectDemoTrack
// authors a two-key lift track through the same putTrack seam the panel uses, so measure.mjs
// can prove driving before the keyframe-authoring UI exists. Reads stores, writes only via
// putTrack on request. measure.mjs depends on every field here — change them together.
"use client";

import { ColumnNode, nodeRegistry, sceneRegistry, useScene } from "@pascal-app/core";
import { useViewer } from "@pascal-app/viewer";
import { resolveVirtualCameraDefinition } from "@huma/path-creator/three";
import { Vector3 } from "three";
import {
  buildTimelineNode,
  createPluginNode,
  getPipFrame,
  getViewportCameraPose,
  installPascalTimeOnScene,
  pascalTimeTransport,
  putTrack,
  readCues,
  readShots,
  readStoredTimeline,
  readTimeline,
  TIMELINE_KIND,
  updatePluginNode,
  type PipFrameInfo,
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
  /** What the PiP's scissored pass last drew. Null when the PiP is off — the DOM cannot see it. */
  pipFrame: PipFrameInfo | null;
  transport: {
    time: number;
    playing: boolean;
    driving: boolean;
    preview: boolean;
    cameraFollow: boolean;
    pipShotId: string | null;
  };
  undoDepth: number;
  rafBeats: number;
  /**
   * Undo depth read LIVE, not from the 250 ms snapshot. A before/after pair taken from the
   * snapshot can straddle a single refresh and report a difference of zero for a write that did
   * happen — the counter is only meaningful when both reads are calls, not fields.
   */
  undoDepthNow(): number;
  findNodeIdByType(type: string): string | null;
  findNodeIdsByType(type: string): string[];
  /** Whether a shot's MARKER meshes render (hidden when the camera stands inside them). */
  markerShown(id: string): boolean | null;
  nodeField(id: string, field: string): unknown;
  objectPosition(id: string): [number, number, number] | null;
  objectVisible(id: string): boolean | null;
  injectDemoTrack(objectId: string): boolean;
  /** Author a real Pascal column under the level, as the wall tool would. */
  createTestColumn(id: string, position: [number, number, number]): boolean;
  /** Create the scene's timeline node directly — for measurement scripts, not authors. */
  createTimelineNode(): string;
  /** Bake the live scene through Pascal's own exportSceneToGlb; returns base64 GLB. */
  exportGlb(): Promise<string | null>;
  /** The resolved camera snapshot a shot produces at a time — what the PiP should be showing. */
  shotSnapshotAt(shotId: string, time: number): {
    position: [number, number, number];
    fov: number;
  } | null;
  /** The camera blocks evaluation actually reads — persisted, or synthesised from shot nodes. */
  cameraBlocks(): unknown[];
  /** Select a node the way a viewport click would — the Key button reads this. */
  selectNode(id: string): void;
  /** Select several, as a shift-click would. The aim affordance needs a shot AND its subject. */
  selectNodes(ids: string[]): void;
  /** Raise/clear the viewer's drag flag — the same signal a real camera orbit raises. */
  setInputDragging(dragging: boolean): void;
  /** Move a node's AUTHORED position (one updateNode — the gizmo's document write). */
  setNodePosition(id: string, position: [number, number, number]): void;
  /**
   * Patch arbitrary node fields as one updateNode. For fields whose only real UI is one of
   * Pascal's DRAG sliders, which a headless run cannot type into — the check asserts the group
   * reaches the real inspector, and uses this to exercise the value.
   */
  setNodeFields(id: string, patch: Record<string, unknown>): void;
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

const findNodeIdsByType = (type: string): string[] => {
  const ids: string[] = [];
  for (const [id, node] of Object.entries(useScene.getState().nodes)) {
    if ((node as { type?: string }).type === type) ids.push(id);
  }
  return ids;
};

const markerShown = (id: string): boolean | null =>
  sceneRegistry.nodes.get(id)?.children[0]?.visible ?? null;

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

const selectNodes = (ids: string[]): void => {
  useViewer.getState().setSelection({ selectedIds: ids as never });
};

const setInputDragging = (dragging: boolean): void => {
  useViewer.getState().setInputDragging(dragging);
};

const createTimelineNode = (): string => {
  const existing = findNodeIdByType(TIMELINE_KIND);
  if (existing) return existing;
  installPascalTimeOnScene();
  const node = buildTimelineNode({ name: "Timeline" });
  createPluginNode(node);
  return node.id as string;
};

/**
 * The bake, exactly as Pascal's own export menu runs it: find the viewer's `scene-renderer`
 * group (reachable by walking up from any registered object — the probe has no useThree) and
 * hand it with the node map to exportSceneToGlb. Base64 in 8K chunks; a spread over a whole
 * building's buffer would blow the call stack.
 */
const exportGlb = async (): Promise<string | null> => {
  const { exportSceneToGlb } = (await import("@pascal-app/editor")) as unknown as {
    exportSceneToGlb: (
      sceneGroup: unknown,
      nodes: unknown
    ) => Promise<ArrayBuffer>;
  };
  const anyObject = sceneRegistry.nodes.values().next().value;
  if (!anyObject) return null;
  let root = anyObject;
  while (root.parent) root = root.parent;
  const sceneGroup = root.getObjectByName("scene-renderer");
  if (!sceneGroup) return null;
  const buffer = await exportSceneToGlb(sceneGroup, useScene.getState().nodes);
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
};

const setNodePosition = (id: string, position: [number, number, number]): void => {
  updatePluginNode(id, { position });
};

const setNodeFields = (id: string, patch: Record<string, unknown>): void => {
  updatePluginNode(id, patch);
};

const undoDepthNow = (): number =>
  (useScene as unknown as { temporal: { getState(): { pastStates: unknown[] } } }).temporal
    .getState()
    .pastStates.length;

/**
 * The camera blocks the evaluator sees. A field authored on a shot NODE only bites if it reaches
 * the block, and the synthesis that carries it there is the part a UI check cannot otherwise see.
 */
const cameraBlocks = (): unknown[] => {
  const timelineId = findNodeIdByType(TIMELINE_KIND);
  if (!timelineId) return [];
  const track = readTimeline(timelineId)?.tracks.find((entry) => entry.type === "camera");
  return track && "blocks" in track ? (track.blocks as unknown[]) : [];
};

/**
 * A shot's resolved pose at a time, computed independently of the PiP's own render pass. The
 * measure compares the two: if the inset agreed with itself but not with the shot it names, the
 * PiP would be drawing something and still be wrong.
 */
const shotSnapshotAt = (
  shotId: string,
  time: number
): { position: [number, number, number]; fov: number } | null => {
  const timelineId = findNodeIdByType(TIMELINE_KIND);
  if (!timelineId) return null;
  const definition = readShots(timelineId).find((shot) => shot.id === shotId)?.definition;
  if (!definition) return null;
  const snapshot = resolveVirtualCameraDefinition(definition, {
    getTargetPosition: (targetId) => {
      const object = sceneRegistry.nodes.get(targetId as never);
      if (!object) return null;
      const world = new Vector3();
      object.getWorldPosition(world);
      return { x: world.x, y: world.y, z: world.z };
    },
    elapsedSeconds: time
  });
  if (!snapshot) return null;
  return {
    position: [snapshot.position.x, snapshot.position.y, snapshot.position.z],
    fov: snapshot.lens?.fov ?? 50
  };
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
        pipFrame: getPipFrame(),
        transport: {
          time: transport.time,
          playing: transport.playing,
          driving: transport.driving,
          preview: transport.preview,
          cameraFollow: transport.cameraFollow,
          pipShotId: transport.pipShotId
        },
        undoDepth: temporal.getState().pastStates.length,
        rafBeats,
        undoDepthNow,
        findNodeIdByType,
        findNodeIdsByType,
        markerShown,
        nodeField,
        objectPosition,
        objectVisible,
        injectDemoTrack,
        createTestColumn,
        createTimelineNode,
        exportGlb,
        shotSnapshotAt,
        cameraBlocks,
        selectNode,
        selectNodes,
        setInputDragging,
        setNodePosition,
        setNodeFields
      };
    }, 250);

    return () => {
      cancelAnimationFrame(rafHandle);
      clearInterval(interval);
    };
  }, []);

  return null;
}
