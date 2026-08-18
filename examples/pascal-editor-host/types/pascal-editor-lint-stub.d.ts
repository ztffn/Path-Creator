// Purpose: Lint-only declaration stub for @pascal-app/editor. The published package is raw
// TSX that does not type-check under this workspace's tsc (missing lib types, one strict-mode
// error), so tsconfig.lint.json maps the package here and `pnpm lint` checks OUR files against
// this surface instead of descending into theirs. Next.js never reads tsconfig.lint.json, so
// runtime resolution still hits the real package. Add to this only what the app imports.
import type { ComponentType, ReactNode } from "react";

declare module "@pascal-app/editor" {
  export interface EditorProps {
    layoutVersion?: "v1" | "v2";
    projectId?: string | null;
    viewerSceneSlot?: ReactNode;
    extraSidebarPanels?: unknown[];
    onLoad?: () => Promise<unknown | null>;
    onSave?: (scene: unknown, options?: { keepalive?: boolean }) => Promise<void>;
  }
  export const Editor: ComponentType<EditorProps>;

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
  export function registerEditorHostPanel(panel: EditorHostPanel): void;
}
