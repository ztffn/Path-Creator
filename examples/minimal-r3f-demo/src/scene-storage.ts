// Story persistence for the demo: localStorage autosave/load hooks and the
// import/export file affordances, all in terms of the portable RigDocument
// story serialization from scene-io (shared pools + N scenes + entry marker).
// Legacy single-timeline saves load through the same path via the package's
// version-gated migration. Also owns `saveBlob`, the one download affordance
// every export here goes through (the story JSON and the audio mixdown WAV).
import { useEffect, useMemo, useRef } from "react";
import { deserializeStory, serializeStory, type DemoStory } from "./scene-io";

// Long enough that a gizmo or clip drag writes once at the end instead of every frame,
// short enough that a crash loses nothing an author would notice.
const AUTOSAVE_DEBOUNCE_MS = 500;

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

/**
 * Mirrors the story into localStorage. Takes the ALREADY-serialized snapshot, because the
 * caller needs the same string for its undo stack and serializing the whole document twice
 * per state change is the expensive half of a gizmo drag. Debounced so a drag writes once
 * on settle rather than every frame, flushed on page hide so the debounce loses nothing,
 * and guarded so a full quota cannot throw out of the effect and unmount the app.
 */
export function useStoryAutosave(storageKey: string, snapshot: string): void {
  const latest = useRef(snapshot);
  latest.current = snapshot;
  useEffect(() => {
    const write = (): void => {
      try {
        localStorage.setItem(storageKey, latest.current);
      } catch (error) {
        console.warn("[storage] autosave failed", error);
      }
    };
    const timer = setTimeout(write, AUTOSAVE_DEBOUNCE_MS);
    window.addEventListener("pagehide", write);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", write);
    };
  }, [storageKey, snapshot]);
}

export function downloadStory(story: DemoStory, filename = "scene.json"): void {
  saveBlob(new Blob([serializeStory(story)], { type: "application/json" }), filename);
}

/**
 * Hands a blob to the browser as a download. Firefox and Safari start fetching the object
 * URL asynchronously, so revoking it in the same tick can kill the download before it has
 * read a byte — the revoke waits a turn instead.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function readStoryFile(file: File): Promise<DemoStory> {
  return deserializeStory(await file.text());
}
