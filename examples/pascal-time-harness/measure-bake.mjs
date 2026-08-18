// The bake measurement, load half: prove that a bundle which CANNOT resolve @pascal-app/nodes,
// @pascal-app/editor or next renders Pascal's baked artifact through Pascal's own GlbScene,
// rebuilds the id binding from extras.pascalId, and drives the baked column with a timeline
// track — scrub-exact and restore-exact. The not-resolvable claims are checked statically from
// this package's own resolver, not asserted from memory. Exits non-zero on any miss.
// Run with `pnpm --filter pascal-time-harness verify:bake` (the export half chains into it).
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const EPSILON = 1e-6;

let failed = 0;
const checks = [];
const check = (claim, ok, detail) => {
  checks.push([claim, ok, detail]);
  if (!ok) failed++;
};

// --- The dependency claim, statically. A resolver rooted HERE must not see the editor world.
const requireFromHarness = createRequire(join(HARNESS_DIR, "package.json"));
for (const banned of ["@pascal-app/nodes", "@pascal-app/editor", "next"]) {
  let resolved = null;
  try {
    resolved = requireFromHarness.resolve(banned);
  } catch {
    // unresolvable is exactly the claim
  }
  check(`the load context cannot resolve ${banned}`, resolved === null, resolved ?? "unresolvable");
}
// CONTROL: the resolver itself works — the packages the harness DOES use must resolve.
let controlResolved = false;
try {
  requireFromHarness.resolve("@pascal-app/viewer");
  controlResolved = true;
} catch {
  // leaves the control failed
}
check("CONTROL: the resolver resolves what IS a dependency (@pascal-app/viewer)", controlResolved, controlResolved);

if (!existsSync(join(HARNESS_DIR, "public/baked/scene.glb"))) {
  check(
    "the baked artifact exists (run pnpm --filter pascal-editor-host verify:bake first)",
    false,
    "public/baked/scene.glb missing"
  );
} else {
  const server = await createServer({ configFile: "./vite.config.ts", server: { port: 5187 } });
  await server.listen();
  const url = `http://localhost:${server.config.server.port}/?mode=bake`;

  const browser = await chromium.launch({
    channel: "chrome",
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding"
    ]
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(() => window.__bakeCheck?.phase === "released", null, {
      timeout: 120_000
    });
    const report = await page.evaluate(() => window.__bakeCheck);

    check(
      "GlbScene loaded the artifact and identity was rebuilt from extras.pascalId",
      report.identityCount > 0,
      `${report.identityCount} ids`
    );
    check("the tracked column resolved by node id", report.trackedResolved === true, report.trackedResolved);
    check(
      "CONTROL: a fabricated id does NOT resolve",
      report.bogusResolved === false,
      report.bogusResolved
    );
    check("the drive ran inside the viewer's frame loop", report.framesDriven > 60, report.framesDriven);
    check("the baked mesh moved under the track", report.movedDuringDrive === true, report.movedDuringDrive);
    check(
      "t=4 is the keyed pose exactly ([0,3,0])",
      report.positionAtFour &&
        Math.abs(report.positionAtFour[0]) < 1e-4 &&
        Math.abs(report.positionAtFour[1] - 3) < 1e-4 &&
        Math.abs(report.positionAtFour[2]) < 1e-4,
      JSON.stringify(report.positionAtFour)
    );
    check(
      "t=0 is the first key exactly ([0,0,0])",
      report.positionAtZero && Math.hypot(...report.positionAtZero) < 1e-4,
      JSON.stringify(report.positionAtZero)
    );
    check(
      "release restored the BAKED pose exactly",
      report.restoredOffsetMetres !== null && report.restoredOffsetMetres < EPSILON,
      `${report.restoredOffsetMetres} m`
    );
    check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join("|"));
  } catch (error) {
    check("the load half completed", false, String(error));
  } finally {
    await browser.close();
    await server.close();
  }
}

for (const [claim, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${claim}  [${detail}]`);
console.log(`\n${checks.length - failed}/${checks.length} load-half checks passed`);
process.exit(failed === 0 ? 0 : 1);
