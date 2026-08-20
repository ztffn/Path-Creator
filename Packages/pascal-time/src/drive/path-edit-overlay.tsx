// In-viewport rail shaping (M1.7): mounts the library's own `PathEditor` over the path the panel
// has in shape mode. Nothing about the editing UX is written here — the library has drag handles,
// midpoint normal gizmos and a rail style already; what this file owns is the two things a Pascal
// host must supply: the WebGPU-safe gizmo (drei's PivotControls uses fat lines and takes the
// WebGPU renderer down), and a write discipline that makes each drag exactly one undo entry.
import { useMemo, useRef, useState } from "react";
import { BezierPath, VertexPath, type Vec3 } from "@huma/path-creator/core";
import { PathEditor, TransformGizmo } from "@huma/path-creator/r3f";
import { sceneRegistry, useScene } from "@pascal-app/core";
import { Matrix4, Vector3 } from "three";
import { useStore } from "zustand";
import { useEditorHelpersVisible } from "@huma/path-creator/r3f";
import { PATH_KIND } from "../plugin/kinds";
import { updatePluginNode } from "../plugin/scene-ops";
import { pascalTimeTransport } from "../transport/store";

/**
 * Pascal's own editor-overlay layer, from `@pascal-app/viewer`'s `lib/layers`: "editor-only
 * overlays (gizmos, move handles, tool previews)", excluded from the depth/normal scene pass and
 * composited on top by a dedicated overlay pass.
 *
 * The rail handles MUST render here rather than on the library's own reserved helper layer, and
 * the reason is a silent failure: Pascal's post-processing pipeline builds the frame from passes
 * with FIXED layer sets (`scenePass.setLayers`, `overlayPass.setLayers`), so a subtree on any
 * other layer is in no pass and is never drawn — however the camera's mask is configured. With
 * post-processing disabled it renders fine, which is what makes it a trap rather than a bug.
 *
 * Declared here rather than imported so this entry keeps its dependency surface (core + fiber,
 * never `/viewer` or `/editor`); a spec pins it against the real export so drift is caught.
 */
export const PASCAL_OVERLAY_LAYER = 1;

/** Name of the group the rail handles live under, so a headless check can find them. */
export const PATH_EDIT_GROUP = "huma-path-edit";

const _world = new Matrix4();
const _inverse = new Matrix4();
const _point = new Vector3();

/** The node's world matrix from the live object, or identity before its renderer has mounted. */
function worldMatrixOf(pathId: string): Matrix4 {
  const object = sceneRegistry.nodes.get(pathId as never) as
    | { matrixWorld: Matrix4 }
    | undefined;
  return object ? _world.copy(object.matrixWorld) : _world.identity();
}

export function PascalTimePathEditOverlay(): React.ReactElement | null {
  const pathId = useStore(pascalTimeTransport, (state) => state.pathEditId);
  const nodes = useScene((state) => state.nodes);
  const [selectedHandle, setSelectedHandle] = useState<number | null>(null);
  const [selectedMidpoint, setSelectedMidpoint] = useState<number | null>(null);
  /**
   * The in-flight drag. `PathEditor` reports a move per pointer-move, so writing straight through
   * would put one undo entry per frame of a drag into Pascal's history. Points buffer here and the
   * gizmo's own transforming edge commits ONE `updateNode` — the same discipline the curve editors
   * keep, arrived at through a different callback.
   */
  const draft = useRef<Vec3[] | null>(null);

  // Enable Pascal's overlay layer on the camera and the raycaster for as long as we are shaping.
  // The library's hook restores the prior state rather than disabling unconditionally, which
  // matters here specifically: Pascal already has this layer on for its OWN gizmo picking, and
  // turning it off on unmount would break the editor's move handles.
  useEditorHelpersVisible(true, PASCAL_OVERLAY_LAYER);

  const node = pathId
    ? ((nodes as Record<string, Record<string, unknown>>)[pathId] as
        | Record<string, unknown>
        | undefined)
    : undefined;
  const localPoints = (node?.points as Vec3[] | undefined) ?? [];

  // The editor works in WORLD space, because the gizmo and the ray it is dragged against are in
  // world space. The node stores LOCAL points, so the bake happens on the way in and the inverse
  // on the way out — exactly the same transform the rig reader applies, in both directions.
  const built = useMemo(() => {
    if (!pathId || !node || node.type !== PATH_KIND || localPoints.length < 4) return null;
    const matrix = worldMatrixOf(pathId).clone();
    const worldPoints = localPoints.map((point) => {
      _point.set(point.x, point.y, point.z).applyMatrix4(matrix);
      return { x: _point.x, y: _point.y, z: _point.z };
    });
    try {
      const bezier = BezierPath.fromJSON({
        points: worldPoints,
        perAnchorNormalsAngle: (node.perAnchorNormalsAngle as number[] | undefined) ?? [],
        isClosed: (node.isClosed as boolean | undefined) ?? false,
        space: (node.space as never) ?? ("xyz" as never),
        controlMode: (node.controlMode as never) ?? ("automatic" as never),
        autoControlLength: (node.autoControlLength as number | undefined) ?? 0.3,
        flipNormals: (node.flipNormals as boolean | undefined) ?? false,
        globalNormalsAngle: (node.globalNormalsAngle as number | undefined) ?? 0
      });
      const vertexPath = new VertexPath(bezier, {
        maxAngleError: (node.maxAngleError as number | undefined) ?? 0.3,
        minVertexDistance: (node.minVertexDistance as number | undefined) ?? 0.01
      });
      return { bezier, vertexPath, matrix };
    } catch {
      // A point list mid-edit can be a shape BezierPath rejects; draw no handles rather than
      // tearing the viewport down.
      return null;
    }
    // `nodes` identity is the document-changed signal; the point list is what actually matters.
  }, [pathId, node, localPoints]);

  if (!pathId || !built) return null;

  /** World point -> the node's local space, which is how the document stores it. */
  const toLocal = (point: Vec3): Vec3 => {
    _inverse.copy(built.matrix).invert();
    _point.set(point.x, point.y, point.z).applyMatrix4(_inverse);
    return { x: _point.x, y: _point.y, z: _point.z };
  };

  const movePoint = (index: number, worldPoint: Vec3): void => {
    // Move it on the live BezierPath first, then read the WHOLE list back. In automatic control
    // mode `movePoint` also recomputes the neighbouring CONTROL points (and ignores a direct move
    // of one), so replacing just the dragged index would persist a shape the editor is not
    // showing. Mutating the working copy the useMemo built is safe; the node's stored array —
    // which Pascal's undo snapshot aliases — is only ever replaced, never touched.
    built.bezier.movePoint(index, worldPoint);
    draft.current = built.bezier.toJSON().points.map(toLocal);
  };

  const commit = (transforming: boolean): void => {
    if (transforming || !draft.current) return;
    const points = draft.current;
    draft.current = null;
    updatePluginNode(pathId, { points });
  };

  return (
    // Named so a headless check can find the handles and count them: the editor draws into the
    // R3F scene, which the DOM cannot see at all, and "the overlay mounted" is otherwise only
    // observable by looking at pixels.
    <group name={PATH_EDIT_GROUP}>
    <PathEditor
      bezierPath={built.bezier}
      vertexPath={built.vertexPath}
      // The point count is what changes the editor's own structure; a drag reshapes in place.
      pathVersion={localPoints.length}
      selectedHandleIndex={selectedHandle}
      selectedMidpointIndex={selectedMidpoint}
      // drei's PivotControls draws fat lines, which three's WebGPU backend cannot auto-map — it
      // loses the device. The library ships this fork for exactly this host.
      gizmo={TransformGizmo}
      useWorldSpaceGizmo
      pathStyle="rail"
      helpersLayer={PASCAL_OVERLAY_LAYER}
      onSelectHandle={setSelectedHandle}
      onSelectMidpoint={setSelectedMidpoint}
      onMovePoint={movePoint}
      onTransformingChange={commit}
      onClearSelection={() => {
        setSelectedHandle(null);
        setSelectedMidpoint(null);
      }}
    />
    </group>
  );
}
