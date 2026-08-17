// The harness shell: Pascal's real `<Viewer>` with our probe mounted as a child, so the drive
// shares Pascal's frame loop instead of racing it. The on-screen panel is for a human watching;
// the numbers that matter are on `window.__pascalTime`, which `measure.mjs` reads headlessly.
// Nothing here is product code — this exists to make M1.1 and M1.2 measurable.
// Scope: harness shell.
import { useEffect, useState } from "react";
import { Viewer } from "@pascal-app/viewer";
import { buildHarnessScene } from "./scene";
import { Probe, type HarnessReport } from "./probe";

export default function App() {
  const [ready, setReady] = useState(false);
  const [report, setReport] = useState<HarnessReport | null>(null);

  useEffect(() => {
    buildHarnessScene();
    setReady(true);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (window.__pascalTime) setReport({ ...window.__pascalTime });
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0e1116" }}>
      <Viewer>{ready ? <Probe /> : null}</Viewer>

      <div
        style={{
          position: "absolute",
          left: 24,
          top: 24,
          padding: "16px 20px",
          borderRadius: 10,
          background: "rgba(14,17,22,0.86)",
          color: "#e6edf3",
          font: "12px/1.7 ui-monospace, SFMono-Regular, monospace",
          minWidth: 380
        }}
      >
        <div style={{ font: "600 13px/1.4 ui-sans-serif, system-ui", marginBottom: 8 }}>
          pascal-time harness
        </div>
        {report ? (
          <>
            <Row label="phase" value={report.phase} />
            <Row label="kind registered" value={String(report.kindRegistered)} />
            <Row label="registered kinds" value={String(report.registeredKindCount)} />
            <Row label="clock node in registry" value={String(report.timelineNodeInSceneRegistry)} />
            <Row label="markers in registry" value={String(report.markersInSceneRegistry)} />
            <Row label="frames" value={String(report.frames)} />
            <Row label="fps" value={report.fps.toFixed(1)} />
            <Row label="overwritten frames" value={String(report.overwrittenFrames)} />
            <Row label="worst drift (m)" value={report.worstDriftMetres.toFixed(4)} />
            <Row label="driven y" value={report.drivenY.toFixed(3)} />
            <Row label="hidden visible" value={String(report.hiddenVisible)} />
            <Row label="untouched marker moved" value={String(report.untouchedMarkerMoved)} />
            <Row
              label="undo depth"
              value={`${report.undoDepthAtStart} → ${report.undoDepthNow}`}
            />
            <Row
              label="dirty nodes"
              value={`${report.dirtyCountAtStart} → ${report.dirtyCountNow}`}
            />
            <Row
              label="restored on release"
              value={
                report.restoredExactly === null
                  ? "—"
                  : `${report.restoredExactly} (${report.restoredOffsetMetres?.toFixed(5)} m)`
              }
            />
          </>
        ) : (
          <div style={{ opacity: 0.6 }}>waiting for the first frame…</div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 24 }}>
      <span style={{ opacity: 0.55 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
