// Purpose: Root layout for the authoring-app dev loop. Mounts ClientBootstrap so Pascal's
// builtin node kinds and the @huma/pascal-time kinds register on the client at module import
// time, before any page's <Editor> or <Viewer> renders — a kind registered later resolves
// every node to null on the first pass. Fonts are the system stacks; the CSS variables the
// editor's theme reads fall back through their stacks when the branded fonts are absent.
import type { ReactNode } from "react";
import { ClientBootstrap } from "./client-bootstrap";
import "./globals.css";

export const metadata = {
  title: "pascal-editor-host",
  description: "M1.3 dev loop — Pascal's editor with the huma-time plugin and timeline panel",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="font-sans">
        <ClientBootstrap>{children}</ClientBootstrap>
      </body>
    </html>
  );
}
