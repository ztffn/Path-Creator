// Inspector: the contextual right-panel that renders the selected entity's editor,
// dispatching on selection.kind (scene/path/dolly/camera/target/object/audio) to the
// matching per-kind inspector component. Shows a titled panel header (kind + entity
// name) and an empty-state hint when nothing is selected. App resolves each entity
// and threads its focused prop group; this file only routes + frames them.
import type { ReactNode } from "react";
import type { Selection } from "./selection";
import { BG, BORDER, MUTED, labelStyle } from "./panel-theme";
import { SceneInspector, type SceneInspectorProps } from "./inspector-scene";
import { PathInspector, type PathInspectorProps } from "./inspector-path";
import { DollyInspector, type DollyInspectorProps } from "./inspector-dolly";
import { CameraInspector, type CameraInspectorProps } from "./inspector-camera";
import { TargetInspector, type TargetInspectorProps } from "./inspector-target";
import { ObjectInspector, type ObjectInspectorProps } from "./inspector-object";
import { AudioInspector, type AudioInspectorProps } from "./inspector-audio";
import { TriggerInspector, type TriggerInspectorProps } from "./inspector-trigger";

const KIND_LABEL: Record<NonNullable<Selection>["kind"], string> = {
  scene: "Scene",
  path: "Path",
  dolly: "Dolly",
  camera: "Camera",
  target: "Target",
  object: "Object",
  audio: "Audio",
  trigger: "Trigger"
};

export interface InspectorProps {
  selection: Selection;
  selectionName: string | null;
  scene: SceneInspectorProps;
  path: PathInspectorProps | null;
  dolly: DollyInspectorProps | null;
  camera: CameraInspectorProps | null;
  target: TargetInspectorProps | null;
  object: ObjectInspectorProps | null;
  audio: AudioInspectorProps | null;
  trigger: TriggerInspectorProps | null;
}

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div
      className="pc-panel"
      style={{
        width: "100%",
        boxSizing: "border-box",
        borderRadius: 0,
        background: BG,
        boxShadow: "0 24px 60px rgba(0, 0, 0, 0.45)",
        border: `1px solid ${BORDER}`,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden"
      }}
    >
      <header style={{ padding: "12px 14px", borderBottom: `1px solid ${BORDER}` }}>
        <div style={labelStyle}>{title}</div>
        {subtitle ? <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.02em", marginTop: 3 }}>{subtitle}</div> : null}
      </header>
      <div style={{ padding: 14, display: "grid", gap: 10 }}>{children}</div>
    </div>
  );
}

const MISSING = <div style={{ fontSize: 12, color: MUTED }}>This entity is no longer available.</div>;

export function Inspector(props: InspectorProps) {
  const { selection } = props;
  if (!selection) {
    return (
      <Shell title="Inspector">
        <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
          Select an entity in the hierarchy — or click a glyph in the viewport — to edit it here.
        </div>
      </Shell>
    );
  }

  const header = { title: KIND_LABEL[selection.kind], ...(props.selectionName ? { subtitle: props.selectionName } : {}) };
  switch (selection.kind) {
    case "scene":
      return <Shell {...header}><SceneInspector {...props.scene} /></Shell>;
    case "path":
      return <Shell {...header}>{props.path ? <PathInspector {...props.path} /> : MISSING}</Shell>;
    case "dolly":
      return <Shell {...header}>{props.dolly ? <DollyInspector {...props.dolly} /> : MISSING}</Shell>;
    case "camera":
      return <Shell {...header}>{props.camera ? <CameraInspector {...props.camera} /> : MISSING}</Shell>;
    case "target":
      return <Shell {...header}>{props.target ? <TargetInspector {...props.target} /> : MISSING}</Shell>;
    case "object":
      return <Shell {...header}>{props.object ? <ObjectInspector {...props.object} /> : MISSING}</Shell>;
    case "audio":
      return <Shell {...header}>{props.audio ? <AudioInspector {...props.audio} /> : MISSING}</Shell>;
    case "trigger":
      return <Shell {...header}>{props.trigger ? <TriggerInspector {...props.trigger} /> : MISSING}</Shell>;
  }
}
