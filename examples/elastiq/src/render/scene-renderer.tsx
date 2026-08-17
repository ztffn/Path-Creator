// Our own dispatch over Pascal's scene document — the thing that makes Pascal's VIEWER
// optional. It reads the node store, renders the kinds we contributed with our own components,
// and nothing else. Pascal's own NodeRenderer is about forty lines doing the same job plus the
// install gate and its lazy-module contract; reimplementing it buys back the renderer, the
// frame loop, the camera and the entire look. Scope: prototype presentation renderer.
import { useScene } from "@pascal-app/core";
import type { ModelNodeType, HotspotNodeType } from "../document/scene-kinds";
import ModelRenderer from "./model-renderer";
import HotspotRenderer from "./hotspot-renderer";

type AnySceneNode = { id: string; type: string; visible?: boolean };

/**
 * Renders every node of a kind we own. Pascal's structural kinds (site, building, level) carry
 * no geometry for this product, so they are simply skipped — the hierarchy still exists in the
 * document for organising and parenting, it just has no visual counterpart here.
 */
export function PresentationScene() {
  const nodes = useScene((state) => state.nodes) as Record<string, AnySceneNode>;

  return (
    <>
      {Object.values(nodes).map((node) => {
        if (node.type === "elastiq:model") {
          return <ModelRenderer key={node.id} node={node as unknown as ModelNodeType} />;
        }
        if (node.type === "elastiq:hotspot") {
          return <HotspotRenderer key={node.id} node={node as unknown as HotspotNodeType} />;
        }
        return null;
      })}
    </>
  );
}
