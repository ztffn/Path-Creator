// Drives the harness headlessly in real Chrome and reports what it measured. Pascal's viewer
// is WebGPU, which Chromium's bundled build does not support well enough to trust, so this
// uses the system Chrome channel with WebGPU explicitly enabled. Exits non-zero when a
// measurement misses its bound, so it can gate a build rather than just print numbers.
// Scope: the M1.1 + M1.2 browser proof. Run with `pnpm --filter pascal-time-harness verify`.
import { createServer } from "vite";
import { chromium } from "playwright";

const DRIVE_TIMEOUT_MS = 180_000;

/** Each check is a claim from the milestone, with the number that would falsify it. */
function evaluate(report) {
  return [
    ["M1.1 kind is registered", report.kindRegistered === true, report.kindRegistered],
    [
      "M1.1 clock node renders through Pascal's dispatch (it is in sceneRegistry)",
      report.timelineNodeInSceneRegistry === true,
      report.timelineNodeInSceneRegistry
    ],
    [
      "M1.1 all three markers render",
      report.markersInSceneRegistry === 3,
      report.markersInSceneRegistry
    ],
    ["M1.2 the drive actually ran", report.frames > 200, report.frames],
    [
      "M1.2 our writes survive Pascal's render pass (<= 1 frame lost, the mount)",
      report.overwrittenFrames <= 1,
      report.overwrittenFrames
    ],
    [
      "M1.2 a marker no track names never moved",
      report.untouchedMarkerMoved === false,
      report.untouchedMarkerMoved
    ],
    [
      "M1.2 driving grew Pascal's undo history by zero",
      report.undoDepthNow - report.undoDepthAtStart === 0,
      report.undoDepthNow - report.undoDepthAtStart
    ],
    [
      "M1.2 driving grew Pascal's dirty-node set by zero",
      report.dirtyCountNow - report.dirtyCountAtStart === 0,
      report.dirtyCountNow - report.dirtyCountAtStart
    ],
    [
      "M1.2 the pre-drive pose came back exactly on release",
      report.restoredExactly === true,
      `${report.restoredExactly} (${report.restoredOffsetMetres} m)`
    ],
    [
      "M1.1 the viewer's selection state accepts the plugin kind",
      report.selectionRoundTripped === true,
      report.selectionRoundTripped
    ],
    [
      "M1.1 selection resolved to live objects in the scene",
      report.selectedObjectsResolved > 0,
      report.selectedObjectsResolved
    ],
    [
      "M1.1 delete unmounted the renderer and cleared the registry entry",
      report.deletedLeftRegistry === true,
      report.deletedLeftRegistry
    ],
    [
      "M1.1 undo remounted it and put the object back",
      report.undoRestoredToRegistry === true,
      report.undoRestoredToRegistry
    ]
  ];
}

const server = await createServer({ configFile: "./vite.config.ts", server: { port: 5183 } });
await server.listen();
const url = `http://localhost:${server.config.server.port}`;

const browser = await chromium.launch({
  channel: "chrome",
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    // The probe advances on requestAnimationFrame, which Chrome throttles hard for pages it
    // considers backgrounded or occluded — headless included. Without these the run is flaky:
    // it completed four times and then stalled at 60s with the page loaded and no errors.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding"
  ]
});
const page = await browser.newPage();

// Chrome requests /favicon.ico on its own and the dev server has none, producing one console
// error on every run that says only "Failed to load resource" and names no URL. Verified as
// exactly that (curl on the dev server: /favicon.ico 404, / 200). Filtered so a real error
// stands out instead of being one line of noise among expected noise.
const IGNORED_CONSOLE = [/Failed to load resource.*404/];
const consoleErrors = [];
page.on("console", (message) => {
  const text = message.text();
  if (message.type() !== "error") return;
  if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return;
  consoleErrors.push(text);
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));
// A bare "Failed to load resource" console line names no URL, which makes an incidental 404
// indistinguishable from a missing asset the scene actually needed. Record the URL too.
const failedRequests = [];
page.on("response", (response) => {
  if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
});

let exitCode = 0;
try {
  await page.goto(url, { waitUntil: "load" });

  // Wait for the probe to finish driving and release, not merely to start.
  await page.waitForFunction(() => window.__pascalTime?.phase === "done", null, {
    timeout: DRIVE_TIMEOUT_MS,
    polling: 250
  });

  const report = await page.evaluate(() => window.__pascalTime);

  console.log("\n  pascal-time harness — measured in system Chrome on WebGPU\n");
  console.log(`  frames sampled            ${report.frames}`);
  console.log(`  sustained rate            ${report.fps.toFixed(1)} fps`);
  console.log(`  registered node kinds     ${report.registeredKindCount}`);
  console.log(`  objects in sceneRegistry  ${report.sceneRegistrySize}`);
  console.log(`  frames our write was lost ${report.overwrittenFrames}`);
  console.log(`  worst drift               ${report.worstDriftMetres.toFixed(5)} m`);
  console.log(
    `  undo depth                ${report.undoDepthAtStart} -> ${report.undoDepthNow}`
  );
  console.log(
    `  dirty nodes               ${report.dirtyCountAtStart} -> ${report.dirtyCountNow}`
  );
  console.log(
    `  restored on release       ${report.restoredExactly} (${report.restoredOffsetMetres} m)`
  );
  console.log(`  selection resolved to     ${report.selectedObjectsResolved} object(s)`);
  console.log(
    `  delete / undo in registry ${report.deletedLeftRegistry ? "left" : "STAYED"} / ${report.undoRestoredToRegistry ? "returned" : "MISSING"}\n`
  );

  for (const [claim, passed, measured] of evaluate(report)) {
    console.log(`  ${passed ? "PASS" : "FAIL"}  ${claim}  [${measured}]`);
    if (!passed) exitCode = 1;
  }

  if (consoleErrors.length > 0) {
    console.log(`\n  ${consoleErrors.length} console error(s):`);
    for (const error of consoleErrors.slice(0, 10)) console.log(`    ${error}`);
  }
  if (failedRequests.length > 0) {
    console.log(`\n  ${failedRequests.length} failed request(s):`);
    for (const request of failedRequests.slice(0, 10)) console.log(`    ${request}`);
  }
  console.log("");
} catch (error) {
  // A bare timeout says nothing about why. Report whatever the probe reached, so a stalled
  // frame loop is distinguishable from a page that never booted.
  const partial = await page.evaluate(() => window.__pascalTime ?? null).catch(() => null);
  console.error("\n  harness failed to produce a report:", error);
  if (partial) {
    console.error(
      `  probe reached: phase=${partial.phase} frames=${partial.frames} ` +
        `elapsed=${partial.elapsedSeconds?.toFixed?.(1)}s fps=${partial.fps?.toFixed?.(1)}`
    );
  } else {
    console.error("  probe never initialised — the page did not reach its first frame.");
  }
  if (consoleErrors.length > 0) {
    console.error("  console errors:");
    for (const message of consoleErrors.slice(0, 20)) console.error(`    ${message}`);
  }
  exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}

process.exit(exitCode);
