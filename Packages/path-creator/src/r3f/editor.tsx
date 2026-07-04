// React Three Fiber layer for edit/play separation: <EditorHelpers> keeps a
// subtree exclusively on the reserved editor-helpers layer (re-asserted per
// frame so async-created children like troika text and gizmo internals are
// covered), and useEditorHelpersVisible flags the default camera as an
// editing viewport. Playback/vcam cameras stay on layer 0 and see content only.
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Layers, type Group } from "three";
import { EDITOR_HELPERS_LAYER } from "../three";

/**
 * Wraps editor-only visuals. Everything inside renders exclusively on the
 * helper layer, so only cameras that enabled it (editing viewports) see it.
 * useEditorHelpersVisible also enables the layer on the event raycaster,
 * which defaults to layer 0 — helpers are only interactive in edit mode.
 */
export function EditorHelpers({
  layer = EDITOR_HELPERS_LAYER,
  children
}: {
  layer?: number;
  children?: ReactNode;
}) {
  const groupRef = useRef<Group>(null);
  const mask = useMemo(() => {
    const layers = new Layers();
    layers.set(layer);
    return layers.mask;
  }, [layer]);

  useFrame(() => {
    const root = groupRef.current;
    if (!root) return;
    root.traverse((object) => {
      if (object.layers.mask !== mask) object.layers.mask = mask;
    });
  });

  return <group ref={groupRef}>{children}</group>;
}

/**
 * Marks the default (viewport) camera as an editing camera for the
 * component's lifetime; pass visible=false to preview play mode without
 * unmounting anything.
 */
export function useEditorHelpersVisible(visible = true, layer = EDITOR_HELPERS_LAYER): void {
  const camera = useThree((state) => state.camera);
  const raycaster = useThree((state) => state.raycaster);
  useEffect(() => {
    if (!visible) return;
    camera.layers.enable(layer);
    raycaster.layers.enable(layer);
    return () => {
      camera.layers.disable(layer);
      raycaster.layers.disable(layer);
    };
  }, [camera, layer, raycaster, visible]);
}
