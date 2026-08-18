// Purpose: Next config for the authoring-app dev loop (M1.3). @pascal-app/editor ships raw
// TSX with a `next >= 15` peer, so the host app must transpile it — plus core/viewer/three,
// which assume a bundler. The turbopack aliases pin react/three/fiber/drei to this app's own
// copies so the module graph holds one instance of each (three must be a singleton at runtime
// and at the type level; two react copies break hooks). Mirrors pascalorg/editor apps/editor.
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pascal's editor source does not type-check under this workspace's compiler settings
  // (see tsconfig.json here); our own files are covered by `pnpm lint` instead.
  typescript: {
    ignoreBuildErrors: true,
  },
  transpilePackages: [
    "three",
    "@pascal-app/viewer",
    "@pascal-app/core",
    "@pascal-app/editor",
  ],
  // The editor's chrome loads its icons through next/image. This is a local dev loop with
  // vendored assets, not a deployment — serve them as-is rather than running the optimizer,
  // which 400s on anything it has not been configured to allow.
  images: {
    unoptimized: true,
  },
  turbopack: {
    resolveAlias: {
      react: "./node_modules/react",
      "react-dom": "./node_modules/react-dom",
      three: "./node_modules/three",
      "@react-three/fiber": "./node_modules/@react-three/fiber",
      "@react-three/drei": "./node_modules/@react-three/drei",
    },
  },
};

export default nextConfig;
