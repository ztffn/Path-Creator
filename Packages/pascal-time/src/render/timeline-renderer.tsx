// Renderer for the `huma-time:timeline` kind. The clock has no geometry, so this mounts an
// empty group and registers it under the node id — registration is the point, not the visual:
// `useRegistry` is what puts an object into `sceneRegistry.nodes`, which is the map the time
// layer's ObjectBindingResolver reads. Default export and lazy import are required by Pascal's
// renderer dispatch; a direct component reference is dropped without a warning.
import { useRef } from "react";
import { useRegistry } from "@pascal-app/core";
import type { Object3D } from "three";
import { TIMELINE_KIND, type TimelineNodeType } from "../plugin/kinds";

export default function TimelineRenderer({ node }: { node: TimelineNodeType }) {
  const ref = useRef<Object3D>(null!);
  useRegistry(node.id, TIMELINE_KIND, ref);

  return <group name={node.name ?? node.id} ref={ref} visible={node.visible !== false} />;
}
