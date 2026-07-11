import { useEffect, useMemo } from "react";
import { deserializeScene, serializeScene, type DemoScene } from "./scene-io";

export function usePersistedScene(storageKey: string): DemoScene | null {
  return useMemo(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? deserializeScene(raw) : null;
    } catch {
      return null;
    }
  }, [storageKey]);
}

export function useSceneAutosave(storageKey: string, scene: DemoScene): void {
  useEffect(() => {
    localStorage.setItem(storageKey, serializeScene(scene));
  }, [storageKey, scene]);
}

export function downloadScene(scene: DemoScene, filename = "scene.json"): void {
  const blob = new Blob([serializeScene(scene)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function readSceneFile(file: File): Promise<DemoScene> {
  return deserializeScene(await file.text());
}
