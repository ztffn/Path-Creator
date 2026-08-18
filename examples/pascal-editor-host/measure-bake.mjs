// The bake measurement, export half (plan §0b, decision 2's evidence): author a real Pascal
// column + a timeline track in the editor app, bake through Pascal's own exportSceneToGlb, and
// assert ON THE ARTIFACT that node identity survived (glTF extras carry pascalId + kind). The
// artifact and a manifest land in pascal-time-harness/public/baked/, and the harness's own
// verify:bake — chained at the end — proves the load half in a bundle that provably cannot
// resolve /nodes, /editor or next. Run with `pnpm --filter pascal-editor-host verify:bake`.
import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_BAKED_DIR = join(APP_DIR, "../pascal-time-harness/public/baked");
const PORT = 3399;
const URL = `http://localhost:${PORT}/`;
const COLUMN_ID = "column_bake";

const server = spawn(join(APP_DIR, "node_modules/.bin/next"), ["dev", "--port", String(PORT)], {
  cwd: APP_DIR,
  stdio: ["ignore", "pipe", "pipe"]
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(URL)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`dev server never answered\n${serverLog.slice(-2000)}`);
}

let failed = 0;
const checks = [];
const check = (claim, ok, detail) => {
  checks.push([claim, ok, detail]);
  if (!ok) failed++;
};

/** The JSON chunk of a GLB, per the binary glTF container spec. */
function glbJson(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== 0x46546c67) throw new Error("not a GLB (bad magic)");
  const jsonLength = view.getUint32(12, true);
  const jsonType = view.getUint32(16, true);
  if (jsonType !== 0x4e4f534a) throw new Error("first GLB chunk is not JSON");
  return JSON.parse(Buffer.from(buffer.buffer, buffer.byteOffset + 20, jsonLength).toString("utf8"));
}

try {
  await waitForServer();
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
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // Author: clock, a real parametric column, a two-key lift track bound to it.
  await page.waitForFunction(() => Boolean(window.__editorProbe), null, { timeout: 60_000 });
  await page.waitForFunction(() => window.__editorProbe.rafBeats > 30);
  const timelineId = await page.evaluate(() => window.__editorProbe.createTimelineNode());
  await page.evaluate((id) => window.__editorProbe.createTestColumn(id, [2, 0, -1]), COLUMN_ID);
  await page.waitForFunction(
    (id) => window.__editorProbe.objectPosition(id) !== null,
    COLUMN_ID
  );
  await page.evaluate((id) => window.__editorProbe.injectDemoTrack(id), COLUMN_ID);
  check("authored: clock, column, track", Boolean(timelineId), timelineId);

  // Bake through Pascal's own exporter.
  const base64 = await page.evaluate(() => window.__editorProbe.exportGlb());
  check("exportSceneToGlb produced an artifact", typeof base64 === "string", typeof base64);
  const glb = Buffer.from(base64, "base64");
  check("the artifact is non-trivial", glb.byteLength > 5_000, `${glb.byteLength} bytes`);

  // Identity on the artifact itself — not on anything in memory.
  const json = glbJson(glb);
  const extras = (json.nodes ?? []).map((n) => n.extras).filter(Boolean);
  const columnEntry = extras.find((e) => e.pascalId === COLUMN_ID);
  check(
    "the baked glTF stamps the column's node id into extras.pascalId",
    Boolean(columnEntry),
    JSON.stringify(columnEntry)
  );
  check("and its kind", columnEntry?.kind === "column", columnEntry?.kind);
  // CONTROL: identity is selective, not decorative — a fabricated id must be absent.
  check(
    "CONTROL: no fabricated id appears in the artifact",
    !extras.some((e) => e.pascalId === "no_such_node"),
    "absent"
  );

  check("no page errors during export", pageErrors.length === 0, pageErrors.slice(0, 2).join("|"));

  // Hand the artifact (and what the load half needs to know) to the viewer-only harness.
  mkdirSync(HARNESS_BAKED_DIR, { recursive: true });
  writeFileSync(join(HARNESS_BAKED_DIR, "scene.glb"), glb);
  writeFileSync(
    join(HARNESS_BAKED_DIR, "manifest.json"),
    JSON.stringify(
      {
        purpose: "M1.3 bake measurement fixture — regenerate with pnpm --filter pascal-editor-host verify:bake",
        exportedAt: "authored by measure-bake.mjs",
        trackedId: COLUMN_ID,
        track: {
          type: "transform",
          id: `probe_lift_${COLUMN_ID}`,
          objectId: COLUMN_ID,
          position: [
            { time: 0, value: [0, 0, 0] },
            { time: 4, value: [0, 3, 0] }
          ]
        },
        durationSeconds: 10
      },
      null,
      2
    )
  );
  await browser.close();
} catch (error) {
  check("the export half completed", false, String(error));
} finally {
  server.kill("SIGTERM");
}

for (const [claim, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${claim}  [${detail}]`);
if (failed > 0) {
  console.log(`\n${checks.length - failed}/${checks.length} export checks passed — not chaining the load half`);
  process.exit(1);
}
console.log(`\n${checks.length}/${checks.length} export checks passed — running the load half in the viewer-only harness`);

const loadHalf = spawnSync("pnpm", ["--filter", "pascal-time-harness", "verify:bake"], {
  cwd: APP_DIR,
  stdio: "inherit"
});
process.exit(loadHalf.status ?? 1);
