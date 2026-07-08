// Target inspector: editor for the one selected aim target. Lifts the former
// "Targets" per-row body — name, mount (static, or ride a dolly), and render
// visibility (the eye hides it from the render while it stays an aim point).
// Scoped to a single target; the hierarchy owns the list + add affordance.
// Pure presentation, driven by App handlers.
import type { RigCartDefinition } from "@huma/path-creator/core";
import { IconEye, IconEyeOff } from "./icons";
import { TEXT, MUTED } from "./panel-theme";
import type { SceneTarget } from "./vcam-model";

export interface TargetInspectorProps {
  target: SceneTarget;
  dollies: RigCartDefinition[];
  onRename: (name: string) => void;
  onSetMount: (cartId: string | null) => void;
  onToggleVisible: () => void;
  onDelete: () => void;
}

export function TargetInspector({ target, dollies, onRename, onSetMount, onToggleVisible, onDelete }: TargetInspectorProps) {
  const visible = target.visibleInRender ?? true;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
        <input
          type="text"
          value={target.name ?? ""}
          aria-label="Target name"
          onChange={(event) => onRename(event.target.value)}
          style={{ flex: 1, minWidth: 0, boxSizing: "border-box" }}
        />
        <button
          title={visible ? "Visible in render — click to hide (invisible aim point)" : "Hidden in render — click to show"}
          aria-label={visible ? "Hide target in render" : "Show target in render"}
          onClick={onToggleVisible}
          style={{ width: 28, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 0, color: visible ? TEXT : MUTED }}
        >
          {visible ? <IconEye size={15} /> : <IconEyeOff size={15} />}
        </button>
        <button className="pc-danger" onClick={onDelete}>Del</button>
      </div>

      <label style={{ display: "grid", gridTemplateColumns: "92px 1fr", alignItems: "center", gap: 8, fontSize: 12 }}>
        <span>Mount</span>
        <select
          title="Mount: static, or ride a dolly"
          value={target.type === "cart" ? target.cartId : ""}
          onChange={(event) => onSetMount(event.target.value || null)}
        >
          <option value="">Static</option>
          {dollies.map((dolly) => (
            <option key={dolly.id} value={dolly.id}>
              {dolly.name}
            </option>
          ))}
        </select>
      </label>

      <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.45 }}>
        A vcam aim can track any target. Static targets drag to place; mount one on a dolly to ride the rail.
      </div>
    </div>
  );
}
