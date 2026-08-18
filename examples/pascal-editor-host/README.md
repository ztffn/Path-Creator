<!--
Purpose: What examples/pascal-editor-host is (the M1.3 authoring dev loop — Pascal's real
editor in a minimal Next app with the huma-time plugin and timeline panel mounted), how to run
it, and what its two measurement scripts prove. Read before touching the app's config: every
odd-looking line (transpilePackages, the lint stub, vendored assets) exists because the
published editor is raw TSX with a Next peer. Scope: this example only.
-->

# pascal-editor-host

**Pascal's real editor, outside Pascal's repo, with time mounted.** A minimal Next 16 app that
mounts `@pascal-app/editor`'s `<Editor>` with the `@huma/pascal-time` plugin registered and the
timeline panel in the icon rail. This is the M1.3 dev loop — the plan's §0b authoring app in
miniature — and the browser proof that the whole authoring surface works.

```bash
pnpm --filter pascal-editor-host dev          # http://localhost:3000 (or --port)
pnpm --filter pascal-editor-host verify       # 39 browser checks: the full authored loop
pnpm --filter pascal-editor-host verify:bake  # the §0b bake measurement, both halves
```

## What `verify` measures (39 checks, system Chrome, WebGPU)

The full authoring loop **through the panel's real buttons**, not through APIs behind its back:
the panel registers and lazy-mounts from the rail; "Create timeline" is one undo entry; a real
parametric column is keyed at t=0; preview goes off, the column is moved (the gizmo's document
write) and keyed again at t=2 in edit mode; preview shows the keyed pose exactly; playback
interpolates; stop restores the authored pose to 0 m; cues author and seek exactly; a shot
captures the viewport camera to 0 m and synthesises a camera track; a visibility clip hides and
shows the column and reverts on release; selecting the shot opens Pascal's own inspector with
our parametrics; and the undo ledger holds exactly the authoring edits — playback, scrubbing
and release contribute zero.

## What `verify:bake` measures

Plan §0b, decision 2's evidence. The export half runs here (author, bake through Pascal's own
`exportSceneToGlb`, assert `extras.pascalId` + `kind` on the artifact itself), writes the
artifact into `../pascal-time-harness/public/baked/`, and chains the load half — which runs in
a bundle that provably cannot resolve `@pascal-app/nodes`, `@pascal-app/editor` or `next`, and
still renders and drives the baked scene. See the harness's `measure-bake.mjs`.

## Why the config looks the way it does

- **`transpilePackages` + react/three aliases** — the published editor is 438 raw `.tsx` files
  with a `next >= 15` peer; the host app compiles it, and three/react must stay singletons.
- **`app/globals.css` + `elevation.css`** — vendored from `pascalorg/editor` at the
  `@pascal-app/editor@1.0.0-beta.4` tag; the `@source` directives make Tailwind compile the
  editor's class names. Only the paths differ from upstream — keep the rest verbatim so a
  re-vendor is a clean diff.
- **`public/`** — the editor's chrome assets (icons, cursor, HDRI, sfx) from the same tag. The
  580-file item/material catalogs are deliberately absent; the cost is Items-panel thumbnails.
- **`tsconfig.lint.json` + `types/pascal-editor-lint-stub.d.ts`** — the editor's raw source
  does not pass this workspace's tsc, so lint checks OUR files against a hand-written contract
  while Next resolves the real package at runtime.
- **`app/dev-probe.tsx`** — instrumentation for the measure scripts, exposed on
  `window.__editorProbe`. It is mounted in every mode on purpose; it reads stores and only
  writes through the same seams the panel uses.
