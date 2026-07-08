// Path inspector: the editing controls for the active editable path, shown when a
// path row is selected. Merges the former standalone "Path Editing" section —
// anchor add/insert/delete, auto-smooth, open/close, reset, save/load, world-space
// gizmo toggle, control mode, and the selected-anchor scale readout. Anchor
// sub-selection stays in App; this only surfaces + drives it. Pure presentation.
import { BezierPath, ControlMode } from "@huma/path-creator/core";

export interface PathInspectorProps {
  name: string;
  onRename: (name: string) => void;
  onDelete: () => void;
  bezierPath: BezierPath | null;
  useWorldSpaceGizmo: boolean;
  onWorldSpaceGizmoChange: (value: boolean) => void;
  selectedAnchorScale: number | null;
  onAddAnchor: () => void;
  onInsertMidpoint: () => void;
  onDeleteAnchor: () => void;
  onAutoSmooth: () => void;
  onToggleClosed: () => void;
  onReset: () => void;
  onSave: () => void;
  onLoad: () => void;
  onControlModeChange: (mode: ControlMode) => void;
}

export function PathInspector({
  name,
  onRename,
  onDelete,
  bezierPath,
  useWorldSpaceGizmo,
  onWorldSpaceGizmoChange,
  selectedAnchorScale,
  onAddAnchor,
  onInsertMidpoint,
  onDeleteAnchor,
  onAutoSmooth,
  onToggleClosed,
  onReset,
  onSave,
  onLoad,
  onControlModeChange
}: PathInspectorProps) {
  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
      <input
        type="text"
        value={name}
        aria-label="Path name"
        onChange={(event) => onRename(event.target.value)}
        style={{ flex: 1, minWidth: 0, boxSizing: "border-box" }}
      />
      <button className="pc-danger" onClick={onDelete}>Del</button>
    </div>
  );
  if (!bezierPath) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        {header}
        <div style={{ fontSize: 12, color: "#94a3b8" }}>
          This path is not the editable one. Select it to load it into the viewport.
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {header}
      {selectedAnchorScale !== null ? (
        <div style={{ fontSize: 12, color: "#e2e8f0" }}>
          Selected anchor scale: {selectedAnchorScale.toFixed(2)}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>
          Select an anchor to move, rotate, or scale it.
        </div>
      )}

      <label style={{ display: "block", fontSize: 12 }}>
        <input type="checkbox" checked={useWorldSpaceGizmo} onChange={(e) => onWorldSpaceGizmoChange(e.target.checked)} />
        <span style={{ marginLeft: 6 }}>World-space gizmo</span>
      </label>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <button onClick={onAddAnchor}>Add Anchor</button>
        <button onClick={onInsertMidpoint}>Insert Midpoint</button>
        <button onClick={onDeleteAnchor}>Delete Anchor</button>
        <button onClick={onAutoSmooth}>Auto Smooth</button>
        <button onClick={onToggleClosed}>{bezierPath.isClosed ? "Open Path" : "Close Path"}</button>
        <button onClick={onReset}>Reset Path</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <button onClick={onSave}>Save Path</button>
        <button onClick={onLoad}>Load Path</button>
      </div>

      <label style={{ display: "grid", gridTemplateColumns: "112px 1fr", alignItems: "center", gap: 8, fontSize: 12 }}>
        <span>Control Mode</span>
        <select value={bezierPath.controlMode} onChange={(e) => onControlModeChange(e.target.value as ControlMode)}>
          <option value={ControlMode.Automatic}>Automatic</option>
          <option value={ControlMode.Free}>Free</option>
          <option value={ControlMode.Aligned}>Aligned</option>
          <option value={ControlMode.Mirrored}>Mirrored</option>
        </select>
      </label>
    </div>
  );
}
