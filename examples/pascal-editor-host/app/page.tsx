// Purpose: The one page of the dev loop — mounts @pascal-app/editor's <Editor> full-screen,
// v1 layout, persisting to localStorage (the default when onLoad/onSave are omitted). This is
// the surface M1.3's timeline panel is developed against: the panel registers itself through
// registerEditorHostPanel and appears in the editor's own icon rail, so nothing here names it.
// The scene driver rides in viewerSceneSlot — inside the editor's R3F frame loop, per §5.3.
"use client";

import { Editor } from "@pascal-app/editor";
import { PascalTimeSceneDriver } from "@huma/pascal-time";
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
            <CameraProbeBridge />
          </>
        }
      />
    </div>
  );
}
