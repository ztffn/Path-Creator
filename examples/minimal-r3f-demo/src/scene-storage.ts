// Story persistence for the demo: localStorage autosave/load hooks and the
// import/export file affordances, all in terms of the portable RigDocument
// story serialization from scene-io (shared pools + N scenes + entry marker).
// Legacy single-timeline saves load through the same path via the package's
// version-gated migration.
import { useEffect, useMemo } from "react";
import { deserializeStory, serializeStory, type DemoStory } from "./scene-io";

export function usePersistedStory(storageKey: string): DemoStory | null {
  return useMemo(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? deserializeStory(raw) : null;
    } catch {
      return null;
    }
  }, [storageKey]);
}

export function useStoryAutosave(storageKey: string, story: DemoStory): void {
  useEffect(() => {
    localStorage.setItem(storageKey, serializeStory(story));
  }, [storageKey, story]);
}

export function downloadStory(story: DemoStory, filename = "scene.json"): void {
  const blob = new Blob([serializeStory(story)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function readStoryFile(file: File): Promise<DemoStory> {
  return deserializeStory(await file.text());
}
