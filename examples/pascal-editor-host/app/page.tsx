// Purpose: The one page of the dev loop — mounts @pascal-app/editor's <Editor> full-screen,
// v1 layout, persisting to localStorage (the default when onLoad/onSave are omitted). This is
// the surface M1.3's timeline panel is developed against: the panel registers itself through
// registerEditorHostPanel and appears in the editor's own icon rail, so nothing here names it.
// The scene driver and the shot PiP ride in viewerSceneSlot — inside the editor's R3F frame
// loop, per §5.3 — which is also the only place a second render pass can order itself.
"use client";

import { Editor } from "@pascal-app/editor";
import { PascalTimeCameraPip, PascalTimeSceneDriver } from "@huma/pascal-time";
import { CameraProbeBridge } from "./camera-probe";
import { DevProbe } from "./dev-probe";

const PROJECT_ID = "pascal-editor-host";

export default function Home() {
  return (
    <div className="relative h-screen w-screen">
      <DevProbe />
      <Editor
        projectId={PROJECT_ID}
        viewerSceneSlot={
          <>
            <PascalTimeSceneDriver />
            {/* After the driver, so the inset renders from the pose the director just applied.
                It draws at useFrame priority 2 — behind Pascal's post pass at 1. */}
            <PascalTimeCameraPip />
            <CameraProbeBridge />
          </>
        }
      />
    </div>
  );
}
