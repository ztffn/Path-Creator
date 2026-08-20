// The rails (M1.7): the paths an author draws, the carts that ride them, and the dolly runs that
// say when a cart is where. Creation happens here because a rail needs a starting shape and a
// place to put it — a new path is laid out in front of the viewport camera, so it appears where
// the author is looking rather than at the world origin. Point-level shaping is the viewport's
// job (the library's PathEditor, behind the "shape" toggle); this section owns the lifecycle.
"use client";

import { useMemo, type ReactNode } from "react";
import { useStore } from "zustand";
import { useScene } from "@pascal-app/core";
import { useViewer } from "@pascal-app/editor";
import {
  anchorCount,
  newDollyRun,
  starterRailPoints,
  withAppendedAnchor,
  type Point3
} from "../plugin/rails";
import { CART_KIND, PATH_KIND } from "../plugin/kinds";
import {
  buildCartNode,
  buildPathNode,
  buildShotNode,
  createPluginNode,
  deletePluginNode,
  updatePluginNode
} from "../plugin/scene-ops";
import { deleteTrack, putTrack, readRig, type StoredTimeline } from "../plugin/timeline-io";
import { cartTrackSpan } from "../plugin/retiming";
import type { PersistedTrack } from "../plugin/tracks";
import { getViewportCameraPose } from "../drive/timeline-scene-driver";
import { pascalTimeTransport } from "../transport/store";
import { formatSeconds, NodeNumberField, styles, useNodeLabel } from "./panel-shared";

type CartTrack = Extract<PersistedTrack, { type: "cart" }>;

export interface RailRow {
  id: string;
  name: string;
  anchors: number;
}

export interface CartRow {
  id: string;
  name: string;
  pathId: string;
  distance: number;
}

/** The scene's paths and carts, re-read whenever the document changes. */
function useRails(timelineId: string): { paths: RailRow[]; carts: CartRow[] } {
  const nodes = useScene((state) => state.nodes);
  return useMemo(() => {
    const paths: RailRow[] = [];
    const carts: CartRow[] = [];
    for (const [id, raw] of Object.entries(nodes)) {
      const node = raw as Record<string, unknown>;
      if (node.type === PATH_KIND) {
        paths.push({
          id,
          name: (node.name as string | undefined) ?? id,
          anchors: anchorCount((node.points as Point3[] | undefined) ?? [])
        });
      } else if (node.type === CART_KIND && node.timelineId === timelineId) {
        carts.push({
          id,
          name: (node.name as string | undefined) ?? id,
          pathId: (node.pathId as string | undefined) ?? "",
          distance: (node.distance as number | undefined) ?? 0
        });
      }
    }
    return { paths, carts };
  }, [nodes, timelineId]);
}

/**
 * Where a new rail goes: a segment laid out in front of the viewport camera, on the ground plane
 * under it. Placing it at the world origin instead would put most new rails somewhere the author
 * is not looking, which reads as "nothing happened".
 */
function starterPointsFromView(): Point3[] {
  const pose = getViewportCameraPose();
  if (!pose) return starterRailPoints({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  const [px, py, pz] = pose.position;
  // The camera's forward from its euler is more than this needs; a rail laid across the view is
  // the more useful default anyway, so use the ground-projected right vector.
  const yaw = (pose.rotationDeg[1] * Math.PI) / 180;
  const forward = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
  const ahead = 6;
  const origin = { x: px + forward.x * ahead, y: Math.max(0, py - 1.5), z: pz + forward.z * ahead };
  // Across the view, so the whole rail is visible rather than receding to a point.
  return starterRailPoints(origin, { x: forward.z, y: 0, z: -forward.x }, 8);
}

export function RailsSection({ stored }: { stored: StoredTimeline }): ReactNode {
  const { paths, carts } = useRails(stored.id);
  const label = useNodeLabel();
  const time = useStore(pascalTimeTransport, (s) => s.time);
  const pathEditId = useStore(pascalTimeTransport, (s) => s.pathEditId);
  const selectedIds = useViewer((s) => s.selection.selectedIds);
  const setSelection = useViewer((s) => s.setSelection);

  const cartTracks = new Map(
    stored.tracks
      .filter((track): track is CartTrack => track.type === "cart")
      .map((track) => [track.cartId, track])
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-rails="">
      <div style={styles.row}>
        <span style={styles.sectionTitle}>Rails</span>
        <button
          style={styles.smallButton}
          type="button"
          title="Draw a rail in front of the viewport camera"
          onClick={() => {
            const node = buildPathNode({
              name: `Rail ${paths.length + 1}`,
              points: starterPointsFromView()
            });
            createPluginNode(node);
            // Straight into shaping it: an author who just made a rail wants its handles.
            pascalTimeTransport.getState().setPathEdit(node.id as string);
          }}
        >
          + rail
        </button>
      </div>

      {paths.length === 0 ? (
        <div style={styles.muted}>
          No rails yet. A rail is a path a cart rides — add one, shape it in the viewport, then put
          a cart on it.
        </div>
      ) : null}

      {paths.map((path) => {
        const shaping = pathEditId === path.id;
        return (
          <div key={path.id} style={styles.listRow}>
            <span style={{ ...styles.muted, fontSize: 11 }}>╱</span>
            <span style={styles.rowName} title={`${path.name} · ${path.anchors} anchors`}>
              {path.name}
            </span>
            <span style={{ ...styles.muted, fontSize: 11 }}>
              {path.anchors} pt{path.anchors === 1 ? "" : "s"}
            </span>
            <button
              style={{ ...styles.chip, ...(shaping ? styles.chipOn : {}) }}
              type="button"
              aria-pressed={shaping}
              aria-label={`Shape ${path.name} in the viewport`}
              title="Show this rail's handles in the viewport and drag them"
              onClick={() =>
                pascalTimeTransport.getState().setPathEdit(shaping ? null : path.id)
              }
            >
              shape
            </button>
            <button
              style={styles.smallButton}
              type="button"
              aria-label={`Extend ${path.name}`}
              title="Add an anchor, continuing the rail's own direction"
              onClick={() => {
                const node = useScene.getState().nodes[path.id as never] as
                  | Record<string, unknown>
                  | undefined;
                const points = (node?.points as Point3[] | undefined) ?? [];
                if (points.length < 4) return;
                // Continue past the end by roughly the last segment's own length, so one press
                // is a visible extension rather than a point on top of the last anchor.
                const last = points[points.length - 1]!;
                const previous = points[points.length - 4] ?? last;
                const step = {
                  x: last.x - previous.x,
                  y: last.y - previous.y,
                  z: last.z - previous.z
                };
                const magnitude = Math.hypot(step.x, step.y, step.z) || 1;
                const target = {
                  x: last.x + (step.x / magnitude) * 4,
                  y: last.y + (step.y / magnitude) * 4,
                  z: last.z + (step.z / magnitude) * 4
                };
                updatePluginNode(path.id, { points: withAppendedAnchor(points, target) });
              }}
            >
              + pt
            </button>
            <button
              style={styles.smallButton}
              type="button"
              aria-label={`Add a cart to ${path.name}`}
              title="Put a cart on this rail"
              onClick={() =>
                createPluginNode(
                  buildCartNode({
                    name: `Cart ${carts.length + 1}`,
                    timelineId: stored.id,
                    pathId: path.id
                  })
                )
              }
            >
              + cart
            </button>
            <button
              style={styles.iconButton}
              type="button"
              aria-label={`Delete rail ${path.name}`}
              title="Delete this rail. Carts on it stop resolving until they name another."
              onClick={() => {
                if (shaping) pascalTimeTransport.getState().setPathEdit(null);
                deletePluginNode(path.id);
              }}
            >
              ✕
            </button>
          </div>
        );
      })}

      {carts.map((cart) => {
        const run = cartTracks.get(cart.id);
        const span = run ? cartTrackSpan(run) : null;
        return (
          <div key={cart.id} style={{ ...styles.listRow, paddingLeft: 16 }}>
            <span style={{ ...styles.muted, fontSize: 11 }}>◍</span>
            <span style={styles.rowName} title={`${cart.name} on ${label(cart.pathId)}`}>
              {cart.name}
            </span>
            <span style={{ ...styles.muted, fontSize: 11 }}>@</span>
            <NodeNumberField
              value={cart.distance}
              label={`Cart ${cart.name} resting distance in metres`}
              width={44}
              onCommit={(distance) => updatePluginNode(cart.id, { distance })}
            />
            <span style={{ ...styles.muted, fontSize: 11 }}>m</span>
            {span ? (
              <span style={{ ...styles.muted, fontSize: 11 }} title="This cart's dolly run">
                run {formatSeconds(span.start)}–{formatSeconds(span.end)}s
              </span>
            ) : (
              <button
                style={styles.smallButton}
                type="button"
                aria-label={`Add a dolly run for ${cart.name}`}
                title="Ride the whole rail from the playhead"
                onClick={() => {
                  const rail = readRig().paths.get(cart.pathId);
                  if (!rail) return;
                  putTrack(stored.id, newDollyRun(cart.id, rail.length, time));
                }}
              >
                + run
              </button>
            )}
            <button
              style={styles.smallButton}
              type="button"
              aria-label={`Add a shot on ${cart.name}`}
              title="A camera riding this cart, taking over at the playhead"
              onClick={() => {
                const node = buildShotNode({
                  name: `Shot on ${cart.name}`,
                  timelineId: stored.id,
                  timeSeconds: time,
                  // A real span, so the new shot is draggable at both edges immediately and its
                  // crossover is whatever the author drags it into.
                  endSeconds: time + 4,
                  body: "cart",
                  cartId: cart.id
                });
                createPluginNode(node);
                setSelection({ selectedIds: [node.id as string] });
              }}
            >
              + shot
            </button>
            <button
              style={styles.iconButton}
              type="button"
              aria-label={`Delete cart ${cart.name}`}
              title="Delete this cart and its dolly run"
              onClick={() => {
                if (run) deleteTrack(stored.id, run.id);
                deletePluginNode(cart.id);
              }}
            >
              ✕
            </button>
          </div>
        );
      })}

      {pathEditId ? (
        <div style={styles.muted}>
          Shaping {label(pathEditId)} — drag an anchor or a handle in the viewport. Each drag is
          one undo step.
          {selectedIds.length > 1 ? " Select one node to keep the handles readable." : ""}
        </div>
      ) : null}
    </div>
  );
}
