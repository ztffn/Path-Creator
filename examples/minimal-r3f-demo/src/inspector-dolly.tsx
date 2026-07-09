// Dolly inspector: editor for the one selected dolly (rail cart). Lifts the former
// "Dollies" per-row body — name, which path it rides, end-of-rail behaviour,
// free-run speed, and the list of timeline "moves" (each eases fromT→toT over
// [start,end]) with add/delete. Scoped to a single dolly; the hierarchy owns the
// list + add-dolly affordance. Pure presentation, driven by App handlers.
import { EndOfPathInstruction, type RigCartDefinition, type RigPathDefinition } from "@huma/path-creator/core";
import { EasingEditor } from "@huma/path-creator/timeline-ui";
import { MUTED } from "./panel-theme";
import type { DollyRun } from "./vcam-model";

export interface DollyInspectorProps {
  dolly: RigCartDefinition;
  paths: RigPathDefinition[];
  runs: DollyRun[];
  onUpdate: (patch: Partial<RigCartDefinition>) => void;
  onDelete: () => void;
  onUpdateRun: (runId: string, patch: Partial<DollyRun>) => void;
  onAddRun: () => void;
  onDeleteRun: (runId: string) => void;
}

export function DollyInspector({ dolly, paths, runs, onUpdate, onDelete, onUpdateRun, onAddRun, onDeleteRun }: DollyInspectorProps) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
        <input
          type="text"
          value={dolly.name ?? ""}
          aria-label="Dolly name"
          onChange={(event) => onUpdate({ name: event.target.value })}
          style={{ flex: 1, minWidth: 0, boxSizing: "border-box" }}
        />
        <button className="pc-danger" onClick={onDelete}>Del</button>
      </div>

      <label style={{ display: "grid", gridTemplateColumns: "92px 1fr", alignItems: "center", gap: 8, fontSize: 12 }}>
        <span>Path</span>
        <select title="Which path this dolly rides" value={dolly.pathId} onChange={(event) => onUpdate({ pathId: event.target.value })}>
          {paths.map((path) => (
            <option key={path.id} value={path.id}>
              {path.name}
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: "grid", gridTemplateColumns: "92px 1fr", alignItems: "center", gap: 8, fontSize: 12 }}>
        <span>End of rail</span>
        <select
          title="End-of-rail behavior for this dolly"
          value={dolly.endOfPathInstruction}
          onChange={(event) => onUpdate({ endOfPathInstruction: event.target.value as EndOfPathInstruction })}
        >
          <option value={EndOfPathInstruction.Loop}>Loop</option>
          <option value={EndOfPathInstruction.Reverse}>Ping-pong</option>
          <option value={EndOfPathInstruction.Stop}>Stop</option>
        </select>
      </label>

      {/* Per-dolly free-run speed (used where a dolly has no move keyframes). */}
      <label style={{ display: "grid", gridTemplateColumns: "92px 1fr 26px", alignItems: "center", gap: 8, fontSize: 12 }}>
        <span>Speed</span>
        <input
          type="range"
          min={0.2}
          max={3}
          step={0.1}
          value={dolly.speed}
          title="Free-run speed for this dolly"
          onChange={(event) => onUpdate({ speed: Number(event.target.value) })}
        />
        <span style={{ textAlign: "right", color: MUTED }}>{dolly.speed.toFixed(1)}</span>
      </label>

      {/* Dolly moves: over [start,end] the dolly eases from→to (distance) with a speed curve. */}
      {runs.map((run) => (
        <div key={run.id} style={{ display: "grid", gap: 4, padding: "4px 0", borderTop: "1px solid rgba(148,163,184,0.15)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 11, color: "#94a3b8" }}>
            <span style={{ width: 30 }}>move</span>
            <input type="number" title="start (s)" value={run.start} step={0.25} style={{ width: 46 }}
              onChange={(event) => onUpdateRun(run.id, { start: Number(event.target.value) })} />
            <input type="number" title="end (s)" value={run.end} step={0.25} style={{ width: 46 }}
              onChange={(event) => onUpdateRun(run.id, { end: Number(event.target.value) })} />
            <input type="number" title="from (0–1 along path)" value={run.fromT} min={0} max={1} step={0.05} style={{ width: 46 }}
              onChange={(event) => onUpdateRun(run.id, { fromT: Number(event.target.value) })} />
            <span>→</span>
            <input type="number" title="to (0–1 along path)" value={run.toT} min={0} max={1} step={0.05} style={{ width: 46 }}
              onChange={(event) => onUpdateRun(run.id, { toT: Number(event.target.value) })} />
            <button className="pc-danger" title="Delete move" onClick={() => onDeleteRun(run.id)}>×</button>
          </div>
          <div style={{ paddingLeft: 30 }}>
            <EasingEditor value={run.easing ?? "linear"} onChange={(easing) => onUpdateRun(run.id, { easing })} height={150} />
          </div>
        </div>
      ))}
      <button style={{ fontSize: 11, justifySelf: "start" }} onClick={onAddRun}>+ move</button>
    </div>
  );
}
