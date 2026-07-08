// The Edit/Play view-mode toggle, shared by the Hierarchy header (compact,
// icons-only) and the Scene inspector (labeled 2-up). Edit = editor camera in the
// main view + driven camera in the PiP; Play = driven camera fills the view and
// pilots on interaction (shortcut P). Active play is green, active edit is slate.
// One control so the two placements can't drift in colour or behaviour.
import { IconVideo, IconDirector } from "./icons";

const TITLE =
  "Edit: editor camera + controls in the main view, driven camera in the PiP. Play: driven camera fills the main view and all interaction pilots it. Shortcut: P";

export function ViewModeToggle({
  viewMode,
  onViewModeChange,
  variant
}: {
  viewMode: "edit" | "play";
  onViewModeChange: (mode: "edit" | "play") => void;
  variant: "icons" | "labeled";
}) {
  const labeled = variant === "labeled";
  return (
    <div
      role="group"
      aria-label="View mode"
      title={TITLE}
      style={labeled ? { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 } : { display: "flex", gap: 4 }}
    >
      {(["edit", "play"] as const).map((mode) => {
        const active = viewMode === mode;
        return (
          <button
            key={mode}
            onClick={() => onViewModeChange(mode)}
            title={mode === "play" ? "Play" : "Edit"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              padding: labeled ? "6px 8px" : "4px 8px",
              fontSize: 12,
              fontWeight: 700,
              textTransform: "capitalize",
              color: active ? "#0f172a" : "#cbd5e1",
              background: active
                ? mode === "play"
                  ? "rgba(34, 197, 94, 0.9)"
                  : "rgba(148, 163, 184, 0.9)"
                : labeled
                  ? "rgba(15, 23, 42, 0.6)"
                  : "transparent",
              border: `1px solid ${active ? "transparent" : "rgba(148, 163, 184, 0.25)"}`
            }}
          >
            {mode === "play" ? <IconVideo size={13} /> : <IconDirector size={13} />}
            {labeled ? (mode === "play" ? "Play" : "Edit") : null}
          </button>
        );
      })}
    </div>
  );
}
