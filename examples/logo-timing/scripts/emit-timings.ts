// Writes the default timing file the offline renderer reads. Run through vite-node so the
// workspace package resolves the same way the app does.
import { writeFileSync } from "node:fs";
import { DEFAULT_PIECES, TIMING_FORMAT_VERSION, timingJson } from "../src/logo-timing";

const out = process.argv[2];
if (!out) throw new Error("usage: npm run emit:timings -- <out.json>");
writeFileSync(out, `${timingJson(DEFAULT_PIECES)}\n`);
console.log(`wrote ${out} at version ${TIMING_FORMAT_VERSION}`);
