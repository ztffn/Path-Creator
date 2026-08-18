// Shared plumbing for the timeline panel's sections: the inline style vocabulary (host CSS
// variables so the panel reads as Pascal chrome, longhand borders because React warns when a
// shorthand fights a longhand override across rerenders), and the reactive document hooks —
// the scene's timeline id, its stored payload, and node display names. Every hook subscribes
// to useScene's nodes map, whose identity changes on ANY edit, undo or redo — that is the
// document-changed signal the whole panel re-reads on. Scope: host-panel internals only.
import { useMemo, type CSSProperties } from "react";
import { useScene } from "@pascal-app/core";
import { TIMELINE_KIND } from "../plugin/kinds";
import { readStoredTimeline, type StoredTimeline } from "../plugin/timeline-io";

export const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 14,
    fontSize: 13,
    color: "var(--sidebar-foreground, #ddd)"
  },
  title: { fontWeight: 600, fontSize: 13, flex: 1, minWidth: 0 },
  sectionTitle: { fontWeight: 600, fontSize: 12, opacity: 0.8, flex: 1 },
  muted: { opacity: 0.55, fontSize: 12, lineHeight: 1.5 },
  row: { display: "flex", alignItems: "center", gap: 6 },
  button: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "5px 9px",
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--sidebar-border, #444)",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap"
  },
  buttonActive: {
    background: "var(--sidebar-accent, rgba(249,115,22,0.18))",
    borderColor: "var(--primary, #f97316)"
  },
  smallButton: {
    padding: "2px 7px",
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--sidebar-border, #444)",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    fontSize: 11,
    cursor: "pointer",
    whiteSpace: "nowrap"
  },
  time: {
    fontVariantNumeric: "tabular-nums",
    fontSize: 12,
    opacity: 0.85,
    marginLeft: "auto",
    whiteSpace: "nowrap"
  },
  scrubber: { width: "100%", accentColor: "var(--primary, #f97316)" },
  numberInput: {
    width: 52,
    padding: "3px 6px",
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--sidebar-border, #444)",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    fontSize: 12,
    textAlign: "right"
  },
  textInput: {
    flex: 1,
    minWidth: 0,
    padding: "3px 6px",
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    fontSize: 12
  },
  listRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 6px",
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent"
  },
  listRowSelected: {
    background: "var(--sidebar-accent, rgba(249,115,22,0.12))",
    borderColor: "var(--sidebar-border, #444)"
  },
  rowName: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 12
  },
  iconButton: {
    border: "none",
    background: "transparent",
    color: "inherit",
    opacity: 0.5,
    cursor: "pointer",
    fontSize: 12,
    padding: "0 2px"
  },
  chip: {
    padding: "2px 7px",
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--sidebar-border, #444)",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    fontSize: 11,
    cursor: "pointer",
    opacity: 0.5
  },
  chipOn: { opacity: 1, borderColor: "var(--primary, #f97316)" }
} satisfies Record<string, CSSProperties>;

export const formatSeconds = (value: number): string => value.toFixed(2);

/** The scene's timeline node id, reactively. First one wins; one clock per scene by design. */
export function useSceneTimelineId(): string | null {
  const nodes = useScene((state) => state.nodes);
  return useMemo(() => {
    for (const [id, node] of Object.entries(nodes)) {
      if ((node as { type?: string }).type === TIMELINE_KIND) return id;
    }
    return null;
  }, [nodes]);
}

/** The stored timeline, re-read when the document changes (edits, undo, redo alike). */
export function useStoredTimeline(timelineId: string | null): StoredTimeline | null {
  const nodes = useScene((state) => state.nodes);
  return useMemo(
    () => (timelineId ? readStoredTimeline(timelineId) : null),
    // `nodes` is the document-changed signal, not an input readStoredTimeline takes.
    [timelineId, nodes] // eslint-disable-line react-hooks/exhaustive-deps
  );
}

/** Display name for a node id: its authored name, its kind, or the raw id. */
export function useNodeLabel(): (id: string) => string {
  const nodes = useScene((state) => state.nodes);
  return useMemo(
    () =>
      (id: string): string => {
        const node = nodes[id as keyof typeof nodes] as
          | { name?: string; type?: string }
          | undefined;
        return node?.name || node?.type || id;
      },
    [nodes]
  );
}

/** Nodes of one plugin kind, scanned reactively out of the document and sorted by time. */
export function useKindNodes<T extends { id: string; timeSeconds: number }>(
  kind: string,
  accept: (id: string, node: Record<string, unknown>) => T | null
): T[] {
  const nodes = useScene((state) => state.nodes);
  return useMemo(() => {
    const out: T[] = [];
    for (const [id, node] of Object.entries(nodes)) {
      const record = node as Record<string, unknown>;
      if (record.type !== kind) continue;
      const mapped = accept(id, record);
      if (mapped) out.push(mapped);
    }
    out.sort((a, b) => a.timeSeconds - b.timeSeconds);
    return out;
    // `accept` is a mapper the callers declare inline; keying on it would loop every render.
  }, [nodes, kind]); // eslint-disable-line react-hooks/exhaustive-deps
}
