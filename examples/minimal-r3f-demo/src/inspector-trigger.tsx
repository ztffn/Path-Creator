// Trigger inspector: editor for one selected trigger and its (1:1-authored)
// bound action — source kind + parameters (proximity target/radius/hysteresis,
// marker filter, click object), arm policy, action (playScene target/skippable,
// transport, show/hide), binding priority, plus a Simulate button that fires
// the bound actions without present mode. Pure presentation; App owns state.
import type { CSSProperties } from "react";
import type {
  ActionDefinition,
  TriggerArmPolicy,
  TriggerDefinition,
  TriggerSource
} from "@huma/path-creator/core";
import { MUTED } from "./panel-theme";

interface NamedEntity {
  id: string;
  name: string;
}

export interface TriggerInspectorProps {
  trigger: TriggerDefinition;
  /** The trigger's bound action (v1 authors 1:1 units), if any. */
  action: ActionDefinition | null;
  priority: number;
  /** Proximity/click candidates: declared targets + bindable objects. */
  entities: NamedEntity[];
  scenes: NamedEntity[];
  onUpdateTrigger: (patch: Partial<Omit<TriggerDefinition, "id">>) => void;
  onUpdateAction: (action: ActionDefinition) => void;
  onSetPriority: (priority: number) => void;
  onSimulate: () => void;
  onDelete: () => void;
}

const row: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "92px 1fr",
  alignItems: "center",
  gap: 8,
  fontSize: 12
};

function NumberField({ label, value, min, step, onChange }: {
  label: string; value: number; min?: number; step?: number; onChange: (value: number) => void;
}) {
  return (
    <label style={row}>
      <span>{label}</span>
      <input
        type="number"
        value={value}
        {...(min !== undefined && { min })}
        step={step ?? 0.5}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function TriggerInspector(props: TriggerInspectorProps) {
  const { trigger, action } = props;
  const source = trigger.source;
  const armType = trigger.arm.type;

  const setSource = (next: TriggerSource): void => props.onUpdateTrigger({ source: next });
  const setSourceType = (type: TriggerSource["type"]): void => {
    if (type === source.type) return;
    const entityId = props.entities[0]?.id ?? "";
    if (type === "proximity") setSource({ type, targetId: entityId, radius: 3, hysteresis: 1 });
    else if (type === "click") setSource({ type, objectId: entityId });
    else setSource({ type: "marker" });
  };
  const setArm = (type: TriggerArmPolicy["type"]): void => {
    props.onUpdateTrigger({ arm: type === "cooldown" ? { type, seconds: 5 } : { type } });
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
        <input
          type="text"
          value={trigger.name ?? ""}
          aria-label="Trigger name"
          onChange={(event) => props.onUpdateTrigger({ name: event.target.value })}
          style={{ flex: 1, minWidth: 0, boxSizing: "border-box" }}
        />
        <button title="Fire this trigger's bound actions now (works in Edit mode)" onClick={props.onSimulate}>
          Simulate
        </button>
        <button className="pc-danger" onClick={props.onDelete}>Del</button>
      </div>

      <label style={row}>
        <span>Source</span>
        <select value={source.type} onChange={(event) => setSourceType(event.target.value as TriggerSource["type"])}>
          <option value="proximity">Proximity</option>
          <option value="marker">Marker</option>
          <option value="click">Click</option>
        </select>
      </label>

      {source.type === "proximity" ? (
        <>
          <label style={row}>
            <span>Near</span>
            <select value={source.targetId} onChange={(event) => setSource({ ...source, targetId: event.target.value })}>
              {props.entities.map((entity) => (
                <option key={entity.id} value={entity.id}>{entity.name}</option>
              ))}
            </select>
          </label>
          <NumberField label="Radius" value={source.radius} min={0} onChange={(radius) => setSource({ ...source, radius })} />
          <NumberField
            label="Hysteresis"
            value={source.hysteresis ?? 0}
            min={0}
            onChange={(hysteresis) => setSource({ ...source, hysteresis })}
          />
        </>
      ) : null}

      {source.type === "marker" ? (
        <label style={row}>
          <span>Event kind</span>
          <input
            type="text"
            value={source.eventKind ?? ""}
            placeholder="any"
            onChange={(event) => {
              const { eventKind: _drop, ...rest } = source;
              setSource(event.target.value ? { ...rest, eventKind: event.target.value } : rest);
            }}
          />
        </label>
      ) : null}

      {source.type === "click" ? (
        <label style={row}>
          <span>Object</span>
          <select value={source.objectId} onChange={(event) => setSource({ ...source, objectId: event.target.value })}>
            {props.entities.map((entity) => (
              <option key={entity.id} value={entity.id}>{entity.name}</option>
            ))}
          </select>
        </label>
      ) : null}

      <label style={row}>
        <span>Re-arm</span>
        <select value={armType} onChange={(event) => setArm(event.target.value as TriggerArmPolicy["type"])}>
          <option value="rearm-on-exit">On exit</option>
          <option value="once">Once</option>
          <option value="every-time">Every time</option>
          <option value="cooldown">Cooldown</option>
        </select>
      </label>
      {trigger.arm.type === "cooldown" ? (
        <NumberField
          label="Cooldown (s)"
          value={trigger.arm.seconds}
          min={0}
          onChange={(seconds) => props.onUpdateTrigger({ arm: { type: "cooldown", seconds } })}
        />
      ) : null}

      <label style={row}>
        <span>Action</span>
        <select
          value={action?.type ?? "playScene"}
          onChange={(event) => {
            const type = event.target.value as ActionDefinition["type"];
            const id = action?.id ?? `act-${trigger.id}`;
            if (type === "playScene") {
              props.onUpdateAction({ id, type, sceneId: props.scenes[0]?.id ?? "", skippable: true });
            } else if (type === "transport") {
              props.onUpdateAction({ id, type, op: "play" });
            } else {
              props.onUpdateAction({ id, type, objectId: props.entities[0]?.id ?? "", active: true });
            }
          }}
        >
          <option value="playScene">Play scene</option>
          <option value="transport">Transport</option>
          <option value="setActive">Show/Hide</option>
        </select>
      </label>

      {action?.type === "playScene" ? (
        <>
          <label style={row}>
            <span>Scene</span>
            <select value={action.sceneId} onChange={(event) => props.onUpdateAction({ ...action, sceneId: event.target.value })}>
              {props.scenes.map((scene) => (
                <option key={scene.id} value={scene.id}>{scene.name}</option>
              ))}
            </select>
          </label>
          <label style={row}>
            <span>Skippable</span>
            <input
              type="checkbox"
              checked={action.skippable ?? true}
              onChange={(event) => props.onUpdateAction({ ...action, skippable: event.target.checked })}
              style={{ justifySelf: "start" }}
            />
          </label>
        </>
      ) : null}

      {action?.type === "transport" ? (
        <label style={row}>
          <span>Op</span>
          <select
            value={action.op}
            onChange={(event) => props.onUpdateAction({ ...action, op: event.target.value as "play" | "pause" | "seek" })}
          >
            <option value="play">Play</option>
            <option value="pause">Pause</option>
            <option value="seek">Seek to 0</option>
          </select>
        </label>
      ) : null}

      {action?.type === "setActive" ? (
        <>
          <label style={row}>
            <span>Object</span>
            <select value={action.objectId} onChange={(event) => props.onUpdateAction({ ...action, objectId: event.target.value })}>
              {props.entities.map((entity) => (
                <option key={entity.id} value={entity.id}>{entity.name}</option>
              ))}
            </select>
          </label>
          <label style={row}>
            <span>Show</span>
            <input
              type="checkbox"
              checked={action.active}
              onChange={(event) => props.onUpdateAction({ ...action, active: event.target.checked })}
              style={{ justifySelf: "start" }}
            />
          </label>
        </>
      ) : null}

      <NumberField label="Priority" value={props.priority} step={1} onChange={props.onSetPriority} />

      <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.45 }}>
        Triggers fire in Play mode only (scrubbing never fires them). Simulate previews the bound actions from Edit mode.
      </div>
    </div>
  );
}
