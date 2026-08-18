// Purpose: PostCSS pipeline for the authoring-app dev loop — Tailwind v4 via the official
// PostCSS plugin, exactly as pascalorg/editor's apps/editor does it. The editor package's UI
// is styled with Tailwind utility classes compiled by the HOST app (its raw TSX is scanned
// through the @source directives in app/globals.css), so without this plugin the editor
// renders unstyled. Scope: build tooling only; no runtime code.
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
