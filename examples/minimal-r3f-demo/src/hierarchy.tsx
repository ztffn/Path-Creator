// Hierarchy / Outliner: the left panel listing every scene entity by kind (Scene,
// Paths, Dollies, Cameras, Targets, Objects, Audio) as selectable rows that drive the
// unified selection atom, plus per-group "add" affordances and a New/Import/Export
// footer. Selecting a row highlights the entity in the viewport and opens its Inspector
// on the right. Rename/delete live in the Inspector; this panel is navigation only.
import type { ReactNode } from "react";
import { isSelected, SCENE_ID, type EntityKind, type Selection } from "./selection";
import { Section as SettingsSection, BG, BORDER, MUTED } from "./panel-theme";
import { IconVideo, IconDirector, IconTrack, IconEye, IconVolume } from "./icons";

interface Entity {
  id: string;
  name: string;
}

interface CameraEntity extends Entity {
  live: boolean;
}

export interface HierarchyProps {
  viewMode: "edit" | "play";
  onViewModeChange: (mode: "edit" | "play") => void;
  selection: Selection;
  onSelect: (kind: EntityKind, id: string) => void;
  paths: Entity[];
  dollies: Entity[];
  cameras: CameraEntity[];
  targets: Entity[];
  objects: Entity[];
  audioTracks: Entity[];
  activePathId: string | null;
  onAddPath: () => void;
  onAddDolly: () => void;
  onCaptureCamera: () => void;
  onAddCartCamera: () => void;
  onAddOrbitCamera: () => void;
  onAddTarget: () => void;
  onAddAudioTrack: () => void;
  onNewScene: () => void;
  onImport: () => void;
  onExport: () => void;
}

function Row({
  selected,
  onSelect,
  icon,
  label,
  badge
}: {
  selected: boolean;
  onSelect: () => void;
  icon?: ReactNode;
  label: string;
  badge?: ReactNode;
}) {
  return (
    <button
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        height: "auto",
        padding: "6px 8px",
        justifyContent: "flex-start",
        fontSize: 12,
        textAlign: "left",
        border: `1px solid ${selected ? "rgba(249, 115, 22, 0.58)" : "transparent"}`,
        background: selected ? "rgba(249, 115, 22, 0.16)" : "transparent"
      }}
    >
      {icon ? <span style={{ display: "inline-flex", flex: "0 0 auto", color: MUTED }}>{icon}</span> : null}
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {badge ?? null}
    </button>
  );
}

const EmptyHint = ({ children }: { children: ReactNode }) => (
  <div style={{ fontSize: 11, color: MUTED, padding: "2px 8px" }}>{children}</div>
);

export function Hierarchy(props: HierarchyProps) {
  const { selection, onSelect } = props;
  return (
    <div
      className="pc-panel"
      style={{
        width: 300,
        maxHeight: "calc(100vh - 24px)",
        display: "flex",
        flexDirection: "column",
        borderRadius: 0,
        boxShadow: "0 24px 60px rgba(0, 0, 0, 0.45)",
        border: `1px solid ${BORDER}`,
        background: BG,
        boxSizing: "border-box",
        overflow: "hidden"
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 12px", borderBottom: `1px solid ${BORDER}` }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.02em", flex: 1 }}>Hierarchy</div>
        <div role="group" aria-label="View mode" title="Edit / Play (P)" style={{ display: "flex", gap: 4 }}>
          {(["edit", "play"] as const).map((mode) => {
            const active = props.viewMode === mode;
            return (
              <button
                key={mode}
                onClick={() => props.onViewModeChange(mode)}
                title={mode === "play" ? "Play" : "Edit"}
                style={{
                  padding: "4px 8px",
                  color: active ? "#0f172a" : "#cbd5e1",
                  background: active ? (mode === "play" ? "rgba(34, 197, 94, 0.9)" : "rgba(148, 163, 184, 0.9)") : "transparent",
                  border: `1px solid ${active ? "transparent" : BORDER}`
                }}
              >
                {mode === "play" ? <IconVideo size={13} /> : <IconDirector size={13} />}
              </button>
            );
          })}
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 12px 12px" }}>
        <div style={{ marginTop: 10 }}>
          <Row selected={isSelected(selection, "scene", SCENE_ID)} onSelect={() => onSelect("scene", SCENE_ID)} label="Scene" />
        </div>

        <Group title="Paths" onAdd={props.onAddPath}>
          {props.paths.length === 0 ? <EmptyHint>No paths.</EmptyHint> : null}
          {props.paths.map((path) => (
            <Row
              key={path.id}
              selected={isSelected(selection, "path", path.id)}
              onSelect={() => onSelect("path", path.id)}
              label={path.name}
              badge={path.id === props.activePathId ? <ActiveBadge /> : undefined}
            />
          ))}
        </Group>

        <Group title="Dollies" onAdd={props.onAddDolly}>
          {props.dollies.length === 0 ? <EmptyHint>No dollies.</EmptyHint> : null}
          {props.dollies.map((dolly) => (
            <Row key={dolly.id} selected={isSelected(selection, "dolly", dolly.id)} onSelect={() => onSelect("dolly", dolly.id)} icon={<IconTrack size={13} />} label={dolly.name} />
          ))}
        </Group>

        <Group
          title="Cameras"
          add={
            <div style={{ display: "flex", gap: 4 }}>
              <button title="Add VCam from the current viewport" onClick={props.onCaptureCamera} style={addBtnStyle}>+ VCam</button>
              <button title="Add a cart VCam that rides a dolly" onClick={props.onAddCartCamera} style={addBtnStyle}>+ Cart</button>
              <button title="Add an orbit VCam" onClick={props.onAddOrbitCamera} style={addBtnStyle}>+ Orbit</button>
            </div>
          }
        >
          {props.cameras.length === 0 ? <EmptyHint>No cameras. Capture the viewport or add a cart/orbit vcam.</EmptyHint> : null}
          {props.cameras.map((camera) => (
            <Row
              key={camera.id}
              selected={isSelected(selection, "camera", camera.id)}
              onSelect={() => onSelect("camera", camera.id)}
              icon={<IconVideo size={13} />}
              label={camera.name}
              badge={camera.live ? <LiveBadge /> : undefined}
            />
          ))}
        </Group>

        <Group title="Targets" onAdd={props.onAddTarget}>
          {props.targets.length === 0 ? <EmptyHint>No targets.</EmptyHint> : null}
          {props.targets.map((target) => (
            <Row key={target.id} selected={isSelected(selection, "target", target.id)} onSelect={() => onSelect("target", target.id)} label={target.name} />
          ))}
        </Group>

        <Group title="Objects">
          {props.objects.length === 0 ? <EmptyHint>No bindable objects.</EmptyHint> : null}
          {props.objects.map((object) => (
            <Row key={object.id} selected={isSelected(selection, "object", object.id)} onSelect={() => onSelect("object", object.id)} label={object.name} />
          ))}
        </Group>

        <Group title="Audio" onAdd={props.onAddAudioTrack}>
          {props.audioTracks.length === 0 ? <EmptyHint>No audio tracks.</EmptyHint> : null}
          {props.audioTracks.map((track) => (
            <Row key={track.id} selected={isSelected(selection, "audio", track.id)} onSelect={() => onSelect("audio", track.id)} icon={<IconVolume size={13} />} label={track.name} />
          ))}
        </Group>
      </div>

      <footer style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 12px", borderTop: `1px solid ${BORDER}` }}>
        <button className="pc-danger" onClick={props.onNewScene}>New</button>
        <button onClick={props.onImport}>Import</button>
        <button onClick={props.onExport}>Export</button>
      </footer>
    </div>
  );
}

const addBtnStyle = { height: 22, padding: "0 6px", fontSize: 10 };

function ActiveBadge() {
  return <span style={{ fontSize: 9, color: "#38bdf8", letterSpacing: "0.08em", flex: "0 0 auto" }}>EDIT</span>;
}

function LiveBadge() {
  return <span style={{ width: 7, height: 7, borderRadius: 999, background: "#22c55e", flex: "0 0 auto" }} />;
}

function Group({ title, onAdd, add, children }: { title: string; onAdd?: () => void; add?: ReactNode; children: ReactNode }) {
  return (
    <SettingsSection title={title}>
      <div style={{ display: "grid", gap: 1 }}>{children}</div>
      {add ?? (onAdd ? <button style={{ justifySelf: "start", marginTop: 4 }} onClick={onAdd}>+ Add</button> : null)}
    </SettingsSection>
  );
}
