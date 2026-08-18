// Purpose: Client-side registry bootstrap. Importing ../lib/bootstrap from a client component
// is what makes registration run in the BROWSER module graph — the server registers in its own
// module instance, unreachable from hydrated pages, so without this every NodeRenderer
// resolves to null on the client. Mounted from layout.tsx so every page gets the registry
// populated before its first <Editor> mounts. Mirrors pascalorg/editor's client-bootstrap.
"use client";

import "../lib/bootstrap";
import type { ReactNode } from "react";

export function ClientBootstrap({ children }: { children: ReactNode }) {
  return children;
}
