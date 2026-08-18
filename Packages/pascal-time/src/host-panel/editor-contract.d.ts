// The slice of @pascal-app/editor this package's type-check compiles against. The published
// editor is raw TSX that does not pass this workspace's compiler settings, so tsconfig `paths`
// resolves the package name to THIS file for tsc and dts generation — its top-level exports ARE
// the module surface. The BUILT JS still imports the real package (tsup externalizes peers
// before path resolution — asserted by test/host-panel.spec.ts). Mirrors src/lib/plugin-panels.ts
// at 1.0.0-beta.4; add only what host-panel actually uses.
import type { ComponentType } from "react";

export type IconRef =
  | { kind: "url"; src: string }
  | { kind: "iconify"; name: string }
  | { kind: "svg"; viewBox: string; path: string };

export type EditorHostPanel = {
  id: string;
  label: string;
  icon: IconRef;
  component: () => Promise<{ default: ComponentType }>;
  kinds?: readonly string[];
  workspaces?: readonly string[];
  pluginId?: string;
  description?: string;
  creator?: { name: string; url?: string };
  pluginUrl?: string;
  defaultInstalled?: boolean;
};

export declare const editorHostPanelRegistry: {
  getSnapshot(): EditorHostPanel[];
  panelForKind(kind: string): string | undefined;
};

export declare function registerEditorHostPanel(panel: EditorHostPanel): void;

// The slice of the viewer store the panel reads, through the editor's own re-export
// (`export { useViewer } from '@pascal-app/viewer'`), so the panel adds no viewer peer.
export interface ViewerSelectionSlice {
  selection: {
    selectedIds: string[];
  };
  setSelection(updates: Partial<{ selectedIds: string[] }>): void;
}

export declare const useViewer: (<T>(selector: (state: ViewerSelectionSlice) => T) => T) & {
  getState(): ViewerSelectionSlice;
};
