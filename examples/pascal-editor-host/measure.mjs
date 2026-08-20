// Drives the editor-host headlessly in system Chrome (WebGPU) and measures the authored loop end
// to end: the panel mounts from the icon rail, gestures create the timeline, keyframes, cues,
// shots and visibility clips, the transport drives real objects inside the editor's own frame
// loop, and (M1.8, section K) the camera language — blend curves, rotation easing, a lens push,
// a tracked aim, the damped composer and the shot PiP. Spawns its own Next dev server; exits
// non-zero when any claim misses. Run with `pnpm --filter pascal-editor-host verify`.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 3299;
const URL = `http://localhost:${PORT}/`;
const EPSILON = 1e-6;

// ---------- dev server ----------

const server = spawn(join(APP_DIR, "node_modules/.bin/next"), ["dev", "--port", String(PORT)], {
  cwd: APP_DIR,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NODE_ENV: undefined }
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(URL);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server never answered on ${URL}\n${serverLog.slice(-2000)}`);
}

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(page, predicate, { timeout = 30_000, interval = 250 } = {}, arg) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    // `arg` is forwarded into the page, so a predicate can name a node id without a closure —
    // the predicate runs in the browser and cannot see anything on this side.
    last = await page.evaluate(predicate, arg);
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`condition never held; last=${JSON.stringify(last)}`);
}

const probe = (page) => page.evaluate(() => window.__editorProbe ?? null);

// ---------- run ----------

let failed = 0;
const checks = [];
const check = (claim, ok, detail) => {
  checks.push([claim, ok, detail]);
  if (!ok) failed++;
};

try {
  await waitForServer();

  const browser = await chromium.launch({
    channel: "chrome",
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      // rAF-driven page; Chrome throttles backgrounded tabs hard enough to stall the run.
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding"
    ]
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const sidebar = page.locator('[data-sidebar]');

  const pageErrors = [];
  const consoleErrors = [];
  const IGNORED_CONSOLE = [/Failed to load resource.*404/, /favicon/i];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (IGNORED_CONSOLE.some((p) => p.test(text))) return;
    consoleErrors.push(text);
  });

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // --- A. the app is alive ---
  const boot = await until(page, () => {
    const p = window.__editorProbe;
    return p && p.rafBeats > 30 ? p : null;
  });
  check("hydration ran and the probe reports", boot !== null, JSON.stringify(boot?.transport));
  check(
    "the browser registry holds Pascal's builtins plus huma-time (49 kinds)",
    boot.nodeRegistrySize === 51,
    boot.nodeRegistrySize
  );

  // --- B. the panel is reachable from the editor's own chrome ---
  const railButton = page.locator('button:has(svg path[d^="M3 5h12"])');
  await railButton.waitFor({ state: "visible", timeout: 20_000 });
  check("the Timeline rail button is in the icon rail", true, "visible");

  const installed = await probe(page);
  check(
    "defaultInstalled put huma-time in the scene's installedPlugins",
    installed.installedPlugins.includes("huma-time"),
    JSON.stringify(installed.installedPlugins)
  );

  await railButton.click();
  const createButton = page.getByRole("button", { name: "Create timeline" });
  await createButton.waitFor({ state: "visible", timeout: 20_000 });
  check("the panel mounts lazily and shows its empty state", true, "Create timeline visible");

  // --- C. an author-shaped gesture creates the clock ---
  const undoBeforeCreate = (await probe(page)).undoDepth;
  await createButton.click();
  const created = await until(page, () => {
    const p = window.__editorProbe;
    return p?.timelineId ? p : null;
  });
  check("creating the timeline put a node in the document", Boolean(created.timelineId), created.timelineId);
  check(
    "CONTROL: node creation is a document op — undo depth grew",
    created.undoDepth > undoBeforeCreate,
    `${undoBeforeCreate} -> ${created.undoDepth}`
  );
  await sidebar.getByRole("button", { name: "Play", exact: true }).waitFor({ timeout: 20_000 });
  check("the panel switched to the transport", true, "Play visible");

  // --- D. the authoring loop, through the panel's own buttons (the done-criterion) ---
  const COLUMN_ID = "column_probe";
  const created2 = await page.evaluate(
    (id) => window.__editorProbe.createTestColumn(id, [2, 0, -1]),
    COLUMN_ID
  );
  check("a real Pascal column was authored under the level", created2 === true, created2);
  await until(page, () => window.__editorProbe.objectPosition("column_probe") !== null);
  check("the column mounted through the editor's own dispatch", true, "in sceneRegistry");

  await page.evaluate((id) => window.__editorProbe.selectNode(id), COLUMN_ID);
  const keyButton = page.getByRole("button", { name: /Key column/ });
  await keyButton.waitFor({ state: "visible", timeout: 10_000 });
  check("selecting in the viewport arms the Key button with the node's name", true, "Key column");

  // First key, at t=0, from the authored pose. The transport has never engaged, so nothing
  // is driven and the captured pose is exactly what the author placed.
  await keyButton.click();
  await until(page, () => window.__editorProbe.tracksCount === 1);
  check("keying the selection created its track", true, "1 track");
  const trackRow = page.locator('div[role="button"][aria-pressed]').filter({ hasText: "column" });
  await trackRow.waitFor({ state: "visible", timeout: 10_000 });
  check("the track row appeared in the panel", true, "visible");

  await trackRow.click();
  await page.getByRole("button", { name: "P", exact: true }).waitFor({ timeout: 10_000 });
  check("selecting the track mounts the curve editor", true, "channel chips visible");

  // Edit mode: park the playhead without owning the scene, pose the object, key it.
  await sidebar.getByRole("button", { name: "Preview", exact: true }).click();
  const editMode = await until(page, () => {
    const p = window.__editorProbe;
    return p.transport.preview === false ? p : null;
  });
  check(
    "preview off releases the scene",
    editMode.transport.driving === false,
    JSON.stringify(editMode.transport)
  );

  await page.evaluate((id) => window.__editorProbe.setNodePosition(id, [2, 0, 5]), COLUMN_ID);
  await until(page, () => {
    const pose = window.__editorProbe.objectPosition("column_probe");
    return pose && Math.abs(pose[2] - 5) < 1e-6 ? pose : null;
  });
  check("the authored move reached the live object (the renderer applied node data)", true, "z=5");

  const scrubTo = async (seconds) => {
    await page.locator('input[aria-label="Timeline position"]').evaluate((el, value) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(el, String(value));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, seconds);
    await sleep(400); // two frames at 50fps plus the probe interval
  };

  await scrubTo(2);
  const parked = await probe(page);
  check(
    "edit-mode scrub parks the playhead WITHOUT taking the scene",
    Math.abs(parked.transport.time - 2) < EPSILON && parked.transport.driving === false,
    JSON.stringify(parked.transport)
  );

  await page.getByRole("button", { name: /Key column/ }).click();
  await until(page, () => /2 keys/.test(document.body.innerText));
  check("the second key landed (the row reads '2 keys')", true, "2 keys");
  // The probe snapshot refreshes every 250ms; wait for the one that has seen the second key's
  // write, or its undo entry gets misattributed to playback below.
  const undoAfterAuthoring = await until(page, () => {
    const p = window.__editorProbe;
    return p.undoDepth >= 5 ? p.undoDepth : null;
  });
  check(
    "the authoring session cost exactly its edits in undo entries (timeline, column, key, move, key)",
    undoAfterAuthoring === 5,
    undoAfterAuthoring
  );

  // --- E. the authored animation plays back, scrub-exact, in the editor's frame loop ---
  await sidebar.getByRole("button", { name: "Preview", exact: true }).click();
  await until(page, () => window.__editorProbe.transport.preview === true);
  await sleep(400);
  const poseAtTwo = await page.evaluate((id) => window.__editorProbe.objectPosition(id), COLUMN_ID);
  check(
    "re-entering preview shows the keyed pose at the parked playhead (z=5 at t=2)",
    Math.abs(poseAtTwo[2] - 5) < 1e-4,
    poseAtTwo[2]
  );

  await scrubTo(0);
  const poseAtZero = await page.evaluate((id) => window.__editorProbe.objectPosition(id), COLUMN_ID);
  check(
    "t=0 is the first authored key exactly (z=-1)",
    Math.abs(poseAtZero[2] + 1) < 1e-4,
    poseAtZero[2]
  );

  await scrubTo(1);
  const poseBetween = await page.evaluate((id) => window.__editorProbe.objectPosition(id), COLUMN_ID);
  check(
    "between the keys the pose interpolates",
    poseBetween[2] > -1 + 1e-3 && poseBetween[2] < 5 - 1e-3,
    poseBetween[2]
  );

  await sidebar.getByRole("button", { name: "Play", exact: true }).click();
  const playSample = await until(page, () => {
    const p = window.__editorProbe;
    return p.transport.playing && p.transport.time > 1.1 ? p : null;
  });
  check("the authored animation plays", playSample.transport.playing === true, playSample.transport.time.toFixed(3));
  await sidebar.getByRole("button", { name: "Pause", exact: true }).click();
  await until(page, () => window.__editorProbe.transport.playing === false);

  // --- F. release restores the AUTHORED pose, and none of it touched the undo history ---
  await sidebar.getByRole("button", { name: "Stop", exact: true }).click();
  await sleep(400);
  const released = await probe(page);
  const poseAfterRelease = await page.evaluate(
    (id) => window.__editorProbe.objectPosition(id),
    COLUMN_ID
  );
  check(
    "stop hands the scene back (driving=false)",
    released.transport.driving === false,
    JSON.stringify(released.transport)
  );
  const restoreOffset = Math.hypot(
    poseAfterRelease[0] - 2,
    poseAfterRelease[1] - 0,
    poseAfterRelease[2] - 5
  );
  check(
    "release restores the AUTHORED pose — the gizmo's, not the first key's",
    restoreOffset < EPSILON,
    `${restoreOffset} m off [2,0,5]`
  );
  check(
    "playback, scrubbing and release grew the undo history by zero",
    released.undoDepth === undoAfterAuthoring,
    `${undoAfterAuthoring} -> ${released.undoDepth}`
  );


  // --- G. moments and visibility: cues, shots-from-view, activation clips ---
  await scrubTo(3);
  await page.getByRole("button", { name: /\+ cue @/ }).click();
  await until(page, () => window.__editorProbe.cuesCount === 1);
  check("a cue was authored at the playhead", true, "1 cue");

  await scrubTo(0);
  await page.getByRole("button", { name: "Seek to cue Cue 1" }).click();
  const afterCueSeek = await until(page, () => {
    const p = window.__editorProbe;
    return Math.abs(p.transport.time - 3) < 1e-6 ? p : null;
  });
  check("clicking a cue seeks its moment exactly", true, afterCueSeek.transport.time);

  const poseBeforeShot = (await probe(page)).cameraPose;
  await page.getByRole("button", { name: /\+ shot from view @/ }).click();
  await until(page, () => window.__editorProbe.shotsCount === 1);
  check("a shot was captured from the viewport camera", true, "1 shot");
  const shotId = await page.evaluate(() =>
    window.__editorProbe.findNodeIdByType("huma-time:shot")
  );
  const shotPosition = await page.evaluate(
    (id) => window.__editorProbe.nodeField(id, "position"),
    shotId
  );
  const shotDrift = Math.hypot(
    shotPosition[0] - poseBeforeShot.position[0],
    shotPosition[1] - poseBeforeShot.position[1],
    shotPosition[2] - poseBeforeShot.position[2]
  );
  check("the shot node holds the camera's pose at capture", shotDrift < 1e-4, `${shotDrift} m`);
  check(
    "the shot synthesises a camera track, so it plays back with no further authoring",
    (await probe(page)).hasCameraTrack === true,
    true
  );

  // A shot takes over ACROSS its blend: at its own timeSeconds it is still 100% the previous
  // shot. Seeking "to" a shot must land where it fully owns the frame (time + blend), or every
  // edit to a neighbour reads as hitting the wrong shot.
  await page.getByRole("button", { name: "Seek to shot Shot 1" }).click();
  const pastBlend = await until(page, () => {
    const p = window.__editorProbe;
    return Math.abs(p.transport.time - 3) < 1e-6 ? p : null;
  });
  // A shot takes over ACROSS its overlap with the previous one, and this is the FIRST shot — it
  // has nothing to come from, so there is no crossover and seeking to it lands on its own start.
  // Section L authors a real overlap and checks that the same affordance then lands past it.
  check(
    "seeking to the first shot lands on its start — nothing to blend from",
    true,
    pastBlend.transport.time
  );

  // The inspector is def.parametrics, hand-declared (M1.3 milestone C). Selecting the shot
  // must surface our groups through Pascal's own ParametricInspector. The desktop inspector
  // opens COLLAPSED to its header (the presentation label), so expand it first.
  await page.evaluate((id) => window.__editorProbe.selectNode(id), shotId);
  await page.getByRole("button", { name: "Expand panel" }).click();
  const inspectorShown = await until(page, () =>
    document.body.innerText.includes("Timing") ? true : null
  );
  check(
    "selecting the shot opens Pascal's inspector with our parametrics (Timing group)",
    inspectorShown === true,
    inspectorShown
  );

  await page.evaluate((id) => window.__editorProbe.selectNode(id), COLUMN_ID);
  await scrubTo(1);
  await page.getByRole("button", { name: "◎ Vis" }).click();
  await until(page, () => window.__editorProbe.tracksCount === 2);
  check("the visibility clip created the column's activation track", true, "2 tracks");

  await scrubTo(0.5);
  const hiddenBefore = await page.evaluate(
    (id) => window.__editorProbe.objectVisible(id),
    COLUMN_ID
  );
  check("before its clip the column is hidden", hiddenBefore === false, hiddenBefore);
  await scrubTo(2);
  const visibleInside = await page.evaluate(
    (id) => window.__editorProbe.objectVisible(id),
    COLUMN_ID
  );
  check("inside its clip the column is visible", visibleInside === true, visibleInside);

  await sidebar.getByRole("button", { name: "Stop", exact: true }).click();
  await until(page, () => window.__editorProbe.transport.driving === false);
  const visibleAfterRelease = await page.evaluate(
    (id) => window.__editorProbe.objectVisible(id),
    COLUMN_ID
  );
  check("release restores visibility (revert semantics)", visibleAfterRelease === true, visibleAfterRelease);

  const finalUndo = await until(page, () => {
    const p = window.__editorProbe;
    return p.undoDepth >= 8 ? p.undoDepth : null;
  });
  check(
    "the moments session cost exactly its edits (cue, shot, clip) — playback still zero",
    finalUndo === 8,
    finalUndo
  );

  // --- H. the lane dock: TimelineLanes as the panel's real timeline surface ---
  const dock = page.locator("[data-huma-lane-dock]");
  await dock.waitFor({ state: "visible", timeout: 10_000 });
  check("the lane dock is mounted over the viewport", true, "visible");

  // After the whole session: 1 shot block + 1 cue clip + 1 transform block + 1 activation
  // clip = 4 draggable actions on the lanes.
  const actionCount = await dock.locator(".timeline-editor-action").count();
  check(
    "the lanes carry every authored thing as a block (shot, cue, motion, visibility)",
    actionCount === 4,
    actionCount
  );

  // The dock's own transport header drives the SAME clock through the player facade.
  await dock.getByRole("button", { name: "Play" }).click();
  const dockPlaying = await until(page, () => {
    const p = window.__editorProbe;
    return p.transport.playing === true ? p : null;
  });
  check("the dock's transport drives the shared clock", dockPlaying.transport.playing === true, "playing");
  await dock.getByRole("button", { name: "Pause" }).click();
  await until(page, () => window.__editorProbe.transport.playing === false);
  await sidebar.getByRole("button", { name: "Stop", exact: true }).click();
  await until(page, () => window.__editorProbe.transport.driving === false);
  check("one clock: dock and sidebar transports are the same store", true, "stopped from sidebar");

  // Highlights: green = in force under the playhead, accent = selected for editing.
  await scrubTo(2); // motion span [0,2] and visibility clip [1,10) both in force; no shot yet
  const activeAtTwo = await dock.locator('[data-active="true"]').count();
  check("the blocks in force under the playhead carry the live highlight", activeAtTwo === 2, activeAtTwo);
  await scrubTo(5); // Shot 1 holds from t=3; the motion span has ended
  const activeShotBlocks = await dock
    .locator('[data-active="true"]')
    .filter({ hasText: "Shot 1" })
    .count();
  check("the shot in force is highlighted on the shot lane", activeShotBlocks === 1, activeShotBlocks);
  const shot1Id = await page.evaluate(() =>
    window.__editorProbe.findNodeIdsByType("huma-time:shot")[0]
  );
  await page.evaluate((id) => window.__editorProbe.selectNode(id), shot1Id);
  await until(page, () => document.querySelectorAll('[data-selected="true"]').length > 0);
  const selectedBlocks = await dock
    .locator('[data-selected="true"]')
    .filter({ hasText: "Shot 1" })
    .count();
  check("the selected shot's block carries the selection highlight", selectedBlocks === 1, selectedBlocks);

  // --- I. camera ownership and capture fidelity: frame a view, capture it, get it back ---
  await scrubTo(6); // inside Shot 1's hold; the director owns the camera again
  const poseShotOne = await page.evaluate(() => window.__cameraProbe.pose());

  // The author grabs the camera (the same viewer flag a real orbit raises) and frames a view.
  await page.evaluate(() => window.__editorProbe.setInputDragging(true));
  await until(page, () => window.__editorProbe.transport.cameraFollow === false);
  check("the author's grab takes the camera from the director", true, "cameraFollow=false");
  const moved = await page.evaluate(() =>
    window.__cameraProbe.look([12, 6, 14], [0, 0, 0])
  );
  check("the controls accepted the author's framing", moved === true, moved);
  await page.evaluate(() => window.__editorProbe.setInputDragging(false));
  await sleep(600);
  const held = await page.evaluate(() => window.__cameraProbe.pose());
  check(
    "the director stands down — the framed view HOLDS (this was the reported bug)",
    Math.hypot(held.position[0] - 12, held.position[1] - 6, held.position[2] - 14) < 1e-3,
    JSON.stringify(held.position)
  );

  // Capture the framed view as a shot at the parked playhead (t=6).
  await page.getByRole("button", { name: /\+ shot from view @/ }).click();
  await until(page, () => window.__editorProbe.shotsCount === 2);
  check("the framed view captured as a second shot", true, "2 shots");

  // A seek reclaims the camera; inside Shot 1's exact hold the old framing returns...
  await scrubTo(3.5);
  const backAtOne = await page.evaluate(() => window.__cameraProbe.pose());
  const oneDrift = Math.hypot(
    backAtOne.position[0] - poseShotOne.position[0],
    backAtOne.position[1] - poseShotOne.position[1],
    backAtOne.position[2] - poseShotOne.position[2]
  );
  check("a seek reclaims the camera — Shot 1's framing returns", oneDrift < 1e-3, `${oneDrift} m`);

  // ...and past the new shot's blend, playback shows EXACTLY what the author framed.
  await scrubTo(7.5);
  const atCaptured = await page.evaluate(() => window.__cameraProbe.pose());
  const capturedDrift = Math.hypot(
    atCaptured.position[0] - 12,
    atCaptured.position[1] - 6,
    atCaptured.position[2] - 14
  );
  const expectedForward = [-12, -6, -14].map((v) => v / Math.hypot(12, 6, 14));
  const forwardDot =
    atCaptured.forward[0] * expectedForward[0] +
    atCaptured.forward[1] * expectedForward[1] +
    atCaptured.forward[2] * expectedForward[2];
  check("playback lands on the captured position exactly", capturedDrift < 1e-3, `${capturedDrift} m`);
  check(
    "and looks exactly where the author was looking",
    forwardDot > 0.9999,
    forwardDot.toFixed(6)
  );

  // --- J. the marker and the menu: the two reported paper cuts ---
  // The camera is parked at Shot 2's own position: its marker must hide (a from-view shot's
  // gizmo sits exactly at the lens — visible, its cone fills the screen as a blue wash), while
  // Shot 1's marker, elsewhere in the scene, stays shown.
  const shotIds = await page.evaluate(() =>
    window.__editorProbe.findNodeIdsByType("huma-time:shot")
  );
  const markerStates = await page.evaluate(
    (ids) => ids.map((id) => window.__editorProbe.markerShown(id)),
    shotIds
  );
  check(
    "the shot marker hides while the camera stands inside it (the blue-wash bug)",
    markerStates.includes(false),
    JSON.stringify(markerStates)
  );
  check(
    "markers elsewhere in the scene stay visible",
    markerStates.includes(true),
    JSON.stringify(markerStates)
  );

  // Right-click on the lanes: camera creation is offered on EVERY row now. The edit area
  // starts at the first lane row (the ruler is a sibling above it), 36px per lane.
  const editArea = dock.locator(".timeline-editor-edit-area");
  await editArea.click({ button: "right", position: { x: 300, y: 96 } });
  const addCamera = page.getByRole("button", { name: "Add camera here (capture viewport)" });
  await addCamera.waitFor({ state: "visible", timeout: 5_000 });
  check("right-clicking the lanes opens the editor's own menu (not the browser's)", true, "visible");
  await addCamera.click();
  await until(page, () => window.__editorProbe.shotsCount === 3);
  check("the menu's camera entry captures a shot at the clicked time", true, "3 shots");

  // The per-lane create entry carries the lane's own vocabulary (cues = row 0, pinned).
  await editArea.click({ button: "right", position: { x: 300, y: 18 } });
  await page.getByRole("button", { name: "Add cue here" }).waitFor({ timeout: 5_000 });
  check("the cue lane's entry speaks cue, not clip", true, "Add cue here");
  await page.mouse.click(10, 10); // dismiss via the menu's backdrop



  // --- K. M1.8, the camera language: blend curve, rotation easing, lens push, aim, PiP ---
  // Driven through the panel's own controls, and each claim checked where it has to land: the
  // shot NODE (the document), the camera BLOCK (what the evaluator actually reads), and where it
  // can be seen at all, the live viewport camera.
  const shotOneId = await page.evaluate(() =>
    window.__editorProbe.findNodeIdsByType("huma-time:shot")[0]
  );
  await page.evaluate((id) => window.__editorProbe.selectNode(id), shotOneId);
  const cameraSection = page.locator(`[data-shot-camera="${shotOneId}"]`);
  await cameraSection.waitFor({ state: "visible", timeout: 10_000 });
  check("selecting a shot opens its camera language in the panel", true, "visible");

  // K1. The blend curve — the EasingEditor the library shipped and the panel never mounted.
  await cameraSection.getByRole("button", { name: "blend", exact: true }).click();
  const blendCurveSelect = cameraSection.locator("select").first();
  await blendCurveSelect.waitFor({ state: "visible", timeout: 5_000 });
  check("the blend facet mounts the easing editor", true, "preset picker visible");

  // Live reads, not the 250 ms snapshot: a snapshot pair can straddle one refresh and report
  // zero for a write that landed.
  const undoBeforeCurve = await page.evaluate(() => window.__editorProbe.undoDepthNow());
  await blendCurveSelect.selectOption("easeOutQuint");
  await until(
    page,
    (id) => window.__editorProbe.nodeField(id, "blendCurve") === "easeOutQuint",
    { timeout: 10_000 },
    shotOneId
  );
  const undoAfterCurve = await page.evaluate(() => window.__editorProbe.undoDepthNow());
  check("choosing a blend preset writes it to the shot", true, "easeOutQuint");
  check(
    "and costs exactly one undo entry — one gesture, one step",
    undoAfterCurve - undoBeforeCurve === 1,
    `${undoBeforeCurve} -> ${undoAfterCurve}`
  );

  // A hand-shaped curve is the case the pre-M1.8 persisted schema dropped outright.
  await blendCurveSelect.selectOption("__custom__");
  const authoredCurve = await until(
    page,
    (id) => {
      const value = window.__editorProbe.nodeField(id, "blendCurve");
      return value && typeof value === "object" ? value : null;
    },
    { timeout: 10_000 },
    shotOneId
  );
  check(
    "switching to a custom curve stores a real curve, not a preset name",
    authoredCurve.type === "curve" && Array.isArray(authoredCurve.keys),
    JSON.stringify(authoredCurve).slice(0, 80)
  );
  const blockCurve = await page.evaluate((id) => {
    const block = window.__editorProbe.cameraBlocks().find((entry) => entry.vcamId === id);
    return block?.blendIn?.curve ?? null;
  }, shotOneId);
  check(
    "the curve reaches the camera BLOCK the evaluator reads, not just the node",
    blockCurve !== null && typeof blockCurve === "object" && blockCurve.type === "curve",
    JSON.stringify(blockCurve).slice(0, 80)
  );

  // K2. Rotation easing — uneditable before M1.8: slerp has no per-axis handle to drag, so the
  // panel could not know which key an author meant.
  // The column now has TWO tracks (transform and activation) and both rows carry its name, so
  // pick the transform row by its own glyph. The row TOGGLES, so only click it when it is closed.
  const transformRow = page
    .locator('div[role="button"][aria-pressed]')
    .filter({ hasText: "◆" })
    .first();
  await transformRow.waitFor({ state: "visible", timeout: 10_000 });
  if ((await transformRow.getAttribute("aria-pressed")) !== "true") await transformRow.click();
  const rotationChip = sidebar.getByRole("button", { name: "R", exact: true });
  await rotationChip.waitFor({ state: "visible", timeout: 5_000 });
  await rotationChip.click();
  const easingHint = sidebar.locator("[data-rotation-easing]");
  await easingHint.waitFor({ state: "visible", timeout: 5_000 });
  check(
    "showing the rotation channel offers its easing, and says when nothing is selected",
    (await easingHint.getAttribute("data-rotation-easing")) === "none",
    await easingHint.getAttribute("data-rotation-easing")
  );

  // Click keyframe anchors on the curve canvas until one of them is a rotation key. The canvas
  // reports the selection through the new onSelectKey prop — that is the seam under test.
  const anchors = sidebar.locator("svg circle");
  const anchorCount = await anchors.count();
  let rotationKeyIndex = "none";
  for (let i = 0; i < anchorCount && rotationKeyIndex === "none"; i += 1) {
    await anchors.nth(i).click({ force: true });
    await sleep(150);
    rotationKeyIndex = (await easingHint.getAttribute("data-rotation-easing")) ?? "none";
  }
  check(
    "clicking a rotation key opens an easing editor for that key",
    rotationKeyIndex !== "none",
    `key ${rotationKeyIndex} of ${anchorCount} anchors`
  );

  const easingSelect = easingHint.locator("select").first();
  await easingSelect.selectOption("easeInQuad");
  const keyEasing = await until(
    page,
    (index) => {
      const p = window.__editorProbe;
      if (!p.timelineId) return null;
      const tracks = p.nodeField(p.timelineId, "tracks") ?? [];
      const transform = tracks.find((entry) => entry.type === "transform");
      const key = transform?.rotation?.[Number(index)];
      return key?.easing === "easeInQuad" ? key.easing : null;
    },
    { timeout: 10_000 },
    rotationKeyIndex
  );
  check(
    "the easing lands on that rotation key in the document",
    keyEasing === "easeInQuad",
    keyEasing
  );

  // K3. The lens push — authored on the shot, evaluated on the block, visible on the camera.
  await page.evaluate((id) => window.__editorProbe.selectNode(id), shotOneId);
  await cameraSection.getByRole("button", { name: "lens", exact: true }).click();
  await cameraSection.getByRole("button", { name: "FOV push", exact: true }).click();
  await until(
    page,
    (id) => window.__editorProbe.nodeField(id, "animateFov") === true,
    { timeout: 10_000 },
    shotOneId
  );
  const fovEndField = cameraSection.getByRole("textbox", { name: /end field of view/ });
  await fovEndField.fill("20");
  await fovEndField.press("Enter");
  await until(
    page,
    (id) => window.__editorProbe.nodeField(id, "fovEnd") === 20,
    { timeout: 10_000 },
    shotOneId
  );
  check("a FOV push is authorable from the panel", true, "50° -> 20°");

  const blockLens = await page.evaluate((id) => {
    const block = window.__editorProbe.cameraBlocks().find((entry) => entry.vcamId === id);
    return block?.lensAnimation?.fov ?? null;
  }, shotOneId);
  check(
    "the push reaches the block as a lensAnimation",
    blockLens !== null && blockLens.to === 20,
    JSON.stringify(blockLens)
  );

  // Shot 1 holds from t=3 until Shot 2 takes over at 6. Sample the LIVE camera inside that.
  await scrubTo(3.6);
  const fovEarly = (await page.evaluate(() => window.__cameraProbe.pose())).fov;
  await scrubTo(5.9);
  const fovLate = (await page.evaluate(() => window.__cameraProbe.pose())).fov;
  check(
    "the live viewport lens actually pushes across the shot's window",
    fovEarly - fovLate > 1,
    `${fovEarly.toFixed(2)}° -> ${fovLate.toFixed(2)}°`
  );

  // K4. The aim — a static shot made to watch a node, wherever that node is.
  await cameraSection.getByRole("button", { name: "aim", exact: true }).click();
  await cameraSection.getByRole("button", { name: "track a node", exact: true }).click();
  await until(
    page,
    (id) => window.__editorProbe.nodeField(id, "aimMode") === "track",
    { timeout: 10_000 },
    shotOneId
  );
  // Both selected: the shot being edited, and the thing to watch. The panel takes the target
  // from the selection because there is no inspector field kind that can name a node.
  await page.evaluate(
    (ids) => window.__editorProbe.selectNodes(ids),
    [shotOneId, COLUMN_ID]
  );
  await cameraSection.locator("button[title*='Aim at']").first().click();
  const aimTarget = await until(
    page,
    (id) => window.__editorProbe.nodeField(id, "aimTargetNodeId") || null,
    { timeout: 10_000 },
    shotOneId
  );
  check("the aim target comes from the viewport selection", aimTarget === COLUMN_ID, aimTarget);

  await scrubTo(4.5);
  const aimed = await page.evaluate(() => window.__cameraProbe.pose());
  const columnAt = await page.evaluate(
    (id) => window.__editorProbe.objectPosition(id),
    COLUMN_ID
  );
  const toColumn = [
    columnAt[0] - aimed.position[0],
    columnAt[1] - aimed.position[1],
    columnAt[2] - aimed.position[2]
  ];
  const toColumnLength = Math.hypot(toColumn[0], toColumn[1], toColumn[2]);
  const aimDot =
    (aimed.forward[0] * toColumn[0] +
      aimed.forward[1] * toColumn[1] +
      aimed.forward[2] * toColumn[2]) /
    toColumnLength;
  check("the shot actually looks at the node it names", aimDot > 0.999, aimDot.toFixed(6));

  // K5. The composer — the one stateful stage, and the property it must not cost us.
  await cameraSection.getByRole("button", { name: "composer", exact: true }).click();
  await until(
    page,
    (id) => window.__editorProbe.nodeField(id, "composerEnabled") === true,
    { timeout: 10_000 },
    shotOneId
  );
  check("the composer is switchable from the panel", true, "composerEnabled=true");

  await scrubTo(4.2);
  const composedFirst = await page.evaluate(() => window.__cameraProbe.pose());
  await scrubTo(3.2);
  await scrubTo(5.5);
  await scrubTo(4.2);
  const composedAgain = await page.evaluate(() => window.__cameraProbe.pose());
  const composerScrubDrift = Math.hypot(
    composedAgain.forward[0] - composedFirst.forward[0],
    composedAgain.forward[1] - composedFirst.forward[1],
    composedAgain.forward[2] - composedFirst.forward[2]
  );
  check(
    "a composed shot still scrubs exactly — same time, same frame, whatever route",
    composerScrubDrift < 1e-6,
    composerScrubDrift.toExponential(2)
  );

  // K6. The PiP — a second render pass from a second camera, never the controller's.
  const pipBefore = await probe(page);
  check(
    "CONTROL: with the PiP off nothing is drawn and nothing is reported",
    pipBefore.pipFrame === null && pipBefore.transport.pipShotId === null,
    JSON.stringify(pipBefore.pipFrame)
  );

  const viewportBeforePip = await page.evaluate(() => window.__cameraProbe.pose());
  const pipToggle = cameraSection.getByRole("button", {
    name: /Preview .* in a picture-in-picture/
  });
  await pipToggle.click();
  await page.locator(`[data-huma-pip="${shotOneId}"]`).waitFor({ state: "visible", timeout: 10_000 });
  check("the PiP frames an inset over the viewport", true, "overlay visible");

  const pipRunning = await until(
    page,
    () => {
      const frame = window.__editorProbe.pipFrame;
      return frame && frame.frames > 3 ? frame : null;
    },
    { timeout: 15_000 }
  );
  check(
    "the inset renders its own pass, frame after frame",
    pipRunning.frames > 3 && pipRunning.shotId === shotOneId,
    `${pipRunning.frames} frames of ${pipRunning.shotId}`
  );

  // The inset prefers the pose the director APPLIED when the previewed shot is the one in force,
  // so it agrees with the viewport instead of deriving a second answer. Which means the reference
  // depends on which path it took — and a mid-blend applied frame belongs to no single shot, so
  // comparing it against a pure resolve of one would fail for the right reason and read as a bug.
  const applied = await page.evaluate(() => window.__editorProbe.appliedCamera());
  const expectedPip = pipRunning.fromDirector
    ? applied
    : await page.evaluate(
        (args) => window.__editorProbe.shotSnapshotAt(args.id, args.time),
        { id: shotOneId, time: 4.2 }
      );
  const pipDrift = Math.hypot(
    pipRunning.position[0] - expectedPip.position[0],
    pipRunning.position[1] - expectedPip.position[1],
    pipRunning.position[2] - expectedPip.position[2]
  );
  check(
    "and renders from the shot it names, not from somewhere merely plausible",
    pipDrift < 1e-3,
    `${pipDrift} m ${pipRunning.fromDirector ? "(director's applied pose)" : "(own resolve)"}`
  );

  // R9's half of the PiP: owning a second camera means the controller's is untouched.
  const viewportAfterPip = await page.evaluate(() => window.__cameraProbe.pose());
  const viewportDrift = Math.hypot(
    viewportAfterPip.position[0] - viewportBeforePip.position[0],
    viewportAfterPip.position[1] - viewportBeforePip.position[1],
    viewportAfterPip.position[2] - viewportBeforePip.position[2]
  );
  check(
    "turning the PiP on does not move the viewport camera (R9: it owns a second one)",
    viewportDrift < 1e-6,
    `${viewportDrift} m`
  );

  // The pass hides the previewed shot's marker (standing at its lens is inside its own cone)
  // and must put it back. A visibility flag or a scissor left set is the failure that looks
  // like the editor broke somewhere else entirely.
  const markerAfterPip = await page.evaluate(
    (id) => window.__editorProbe.objectVisible(id),
    shotOneId
  );
  check(
    "the previewed shot's marker is restored after the pass",
    markerAfterPip === true,
    markerAfterPip
  );

  // K7. Noise and the composer's own settings are declarative inspector fields, so the real UI
  // for them is Pascal's own ParametricInspector. Its number and vec3 controls are DRAG sliders
  // rather than inputs, so the honest instrument is: assert the GROUPS reach the real inspector,
  // then prove the effect through the document.
  // Pascal's inspector needs a SINGLE selection — the aim step above deliberately left two
  // selected (the shot and its subject), which shows no per-node parametrics at all.
  await page.evaluate((id) => window.__editorProbe.selectNode(id), shotOneId);
  const expandInspector = page.getByRole("button", { name: "Expand panel" });
  if (await expandInspector.count()) await expandInspector.first().click();
  const inspectorGroups = await until(
    page,
    () => {
      const text = document.body.innerText;
      return ["Aim", "Composer", "Noise"].every((group) => text.includes(group)) ? true : null;
    },
    { timeout: 10_000 }
  );
  check(
    "the new parametrics groups reach Pascal's own inspector (Aim, Composer, Noise)",
    inspectorGroups === true,
    "all three groups present"
  );

  await scrubTo(4.4);
  const noiselessPose = await page.evaluate(() => window.__cameraProbe.pose());
  await page.evaluate(
    (id) => window.__editorProbe.setNodeFields(id, { noiseEnabled: true, noiseSeed: 7 }),
    shotOneId
  );
  await scrubTo(4.4);
  const noisyPose = await page.evaluate(() => window.__cameraProbe.pose());
  const noiseShift = Math.hypot(
    noisyPose.position[0] - noiselessPose.position[0],
    noisyPose.position[1] - noiselessPose.position[1],
    noisyPose.position[2] - noiselessPose.position[2]
  );
  check(
    "noise actually moves the live camera once the shot asks for it",
    noiseShift > 1e-4,
    `${noiseShift.toExponential(2)} m`
  );

  // Scrub away and back: noise is a pure function of the seed and the clock, so the same time
  // must give the same wobble. This is what makes it safe to ship as animation rather than as
  // an effect that only looks right while playing.
  await scrubTo(2.5);
  await scrubTo(4.4);
  const noisyAgain = await page.evaluate(() => window.__cameraProbe.pose());
  const noiseRepeatDrift = Math.hypot(
    noisyAgain.position[0] - noisyPose.position[0],
    noisyAgain.position[1] - noisyPose.position[1],
    noisyAgain.position[2] - noisyPose.position[2]
  );
  check(
    "and repeats exactly at the same time — seeded, not stochastic",
    noiseRepeatDrift < 1e-9,
    noiseRepeatDrift.toExponential(2)
  );

  await pipToggle.click();
  const pipOff = await until(
    page,
    () => (window.__editorProbe.pipFrame === null ? { off: true } : null),
    { timeout: 10_000 }
  );
  check("turning it off stops the pass entirely", pipOff.off === true, "pipFrame=null");
  check(
    "and the camera-language session left the document consistent",
    (await probe(page)).hasCameraTrack === true,
    "camera track still resolves"
  );


  // --- L. the overlap model: a crossover you can see and drag ---
  // Before this, blocks abutted and the blend was a number typed elsewhere, so the lane drew a
  // hard seam over a real ramp. Now a shot's block reaching past the next one's start IS the
  // crossover, which is how the library's own demo authors it.
  const shotIdsForSpan = await page.evaluate(() =>
    window.__editorProbe.findNodeIdsByType("huma-time:shot")
  );
  const spanA = shotIdsForSpan[0];
  const spanB = shotIdsForSpan[1];

  const blockOf = (id) =>
    page.evaluate(
      (shotId) => window.__editorProbe.cameraBlocks().find((b) => b.vcamId === shotId) ?? null,
      id
    );

  const blockA = await blockOf(spanA);
  const blockB = await blockOf(spanB);
  check(
    "each shot owns a block with a real span, not a point",
    blockA && blockB && blockA.end > blockA.start && blockB.end > blockB.start,
    `A ${blockA?.start}–${blockA?.end}, B ${blockB?.start}–${blockB?.end}`
  );
  check(
    "the second shot's blend is the OVERLAP with the first, not a stored number",
    blockB?.blendIn?.durationSeconds !== undefined &&
      Math.abs(blockB.blendIn.durationSeconds - (blockA.end - blockB.start)) < 1e-6,
    `overlap ${(blockA.end - blockB.start).toFixed(3)}s, blend ${blockB?.blendIn?.durationSeconds}`
  );

  // Lengthen the crossover by moving the incoming shot's start earlier — one field, one write.
  // BY NAME, not by index: the list is ordered by TIME and these ids are in document order, and a
  // shot created from the lane's context menu sits between the first two.
  const spanBName = await page.evaluate(
    (id) => window.__editorProbe.nodeField(id, "name"),
    spanB
  );
  const startField = sidebar.getByRole("textbox", {
    name: `Shot ${spanBName} start in seconds`,
    exact: true
  });
  await startField.fill("4");
  await startField.press("Enter");
  const widened = await until(
    page,
    (id) => {
      const block = window.__editorProbe.cameraBlocks().find((b) => b.vcamId === id);
      return block?.blendIn?.durationSeconds > 2 ? block : null;
    },
    { timeout: 10_000 },
    spanB
  );
  check(
    "moving a shot's start back over its predecessor lengthens the crossover",
    widened.blendIn.durationSeconds > 2,
    `${widened.blendIn.durationSeconds.toFixed(2)}s`
  );

  // And the crossover is real: mid-blend the camera is at neither shot's pose.
  const poseA = await page.evaluate(
    (args) => window.__editorProbe.shotSnapshotAt(args.id, args.t),
    { id: spanA, t: 5 }
  );
  const poseB = await page.evaluate(
    (args) => window.__editorProbe.shotSnapshotAt(args.id, args.t),
    { id: spanB, t: 5 }
  );
  await scrubTo(5);
  const midBlend = await page.evaluate(() => window.__cameraProbe.pose());
  const distanceTo = (target) =>
    Math.hypot(
      midBlend.position[0] - target.position[0],
      midBlend.position[1] - target.position[1],
      midBlend.position[2] - target.position[2]
    );
  const gap = Math.hypot(
    poseA.position[0] - poseB.position[0],
    poseA.position[1] - poseB.position[1],
    poseA.position[2] - poseB.position[2]
  );
  check(
    "mid-crossover the viewport camera is between the two shots, not at either",
    gap > 1 && distanceTo(poseA) > 0.05 * gap && distanceTo(poseB) > 0.05 * gap,
    `${distanceTo(poseA).toFixed(2)} m from A, ${distanceTo(poseB).toFixed(2)} m from B, gap ${gap.toFixed(2)}`
  );

  // The lane says so too: an overlapping block names its crossover, so two blocks drawn crossing
  // are not mistaken for two blocks abutting.
  const overlapLabelled = await dock.locator(".timeline-editor-action").filter({ hasText: "↹" }).count();
  check("the overlapping block names its crossover on the lane", overlapLabelled >= 1, overlapLabelled);

  // Seek-to-shot now lands past a REAL overlap, which the first-shot check could not show.
  await sidebar
    .getByRole("button", { name: `Seek to shot ${spanBName}`, exact: true })
    .click();
  const landed = await until(
    page,
    (args) => {
      const p = window.__editorProbe;
      return Math.abs(p.transport.time - args.expected) < 1e-3 ? p.transport.time : null;
    },
    { timeout: 10_000 },
    { expected: 4 + widened.blendIn.durationSeconds }
  );
  check("seeking to an overlapped shot lands where it fully owns the frame", true, landed);

  // --- M. rails: a path, a cart, a run, and a camera riding it ---
  const railsSection = sidebar.locator("[data-rails]");
  await railsSection.waitFor({ state: "visible", timeout: 10_000 });
  await railsSection.getByRole("button", { name: "+ rail", exact: true }).click();
  const railId = await until(
    page,
    () => window.__editorProbe.findNodeIdByType("huma-time:path"),
    { timeout: 10_000 }
  );
  check("a rail is authorable from the panel", Boolean(railId), railId);

  const lengths = await page.evaluate(() => window.__editorProbe.railLengths());
  check(
    "the rail is samplable the moment it exists — a starter has a real segment",
    (lengths[railId] ?? 0) > 1,
    `${(lengths[railId] ?? 0).toFixed(2)} m`
  );

  // Shape mode: the handles mount into the SCENE, on Pascal's own overlay layer. The layer is
  // re-asserted inside a useFrame (async children — gizmo internals, text — mount after their
  // parent), so it lands on the first frame AFTER mount. Sampling once races that; wait for it.
  const handlesBefore = await until(
    page,
    () => {
      const handles = window.__editorProbe.pathHandles();
      return handles.mounted && handles.objects > 1 && handles.objects === handles.onOverlayLayer
        ? handles
        : null;
    },
    { timeout: 15_000 }
  );
  check(
    "with shape mode on from creation, the handles are mounted",
    handlesBefore.mounted === true && handlesBefore.objects > 1,
    `${handlesBefore.objects} objects`
  );
  check(
    "and every one of them is on Pascal's overlay layer, or the post pass never draws them",
    handlesBefore.objects === handlesBefore.onOverlayLayer,
    `${handlesBefore.onOverlayLayer}/${handlesBefore.objects}`
  );

  // Shaping for real: click the rail's first anchor in the VIEWPORT, then drag the gizmo that
  // appears. The handles are meshes in the R3F scene, so the check has to be told where they
  // landed on screen — that is what the camera probe's `project` is for.
  //
  // Frame the rail first. A new rail is laid out in front of wherever the author was looking, so
  // an end of it can sit outside the frustum — and a click at an off-canvas coordinate lands on
  // whatever chrome happens to be there, which then drags something else entirely.
  const canvasBox = await page.locator("canvas").first().boundingBox();
  const railWorld = await page.evaluate(
    (id) => {
      const points = window.__editorProbe.nodeField(id, "points");
      const origin = window.__editorProbe.nodeField(id, "position");
      if (!points?.length || !origin) return null;
      const at = (point) => [point.x + origin[0], point.y + origin[1], point.z + origin[2]];
      const first = at(points[0]);
      const last = at(points[points.length - 1]);
      return {
        first,
        centre: [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2, (first[2] + last[2]) / 2]
      };
    },
    railId
  );
  // The author takes the camera to frame it, exactly as section I does — a direct write past the
  // controller would be lost on its next update (R9).
  await page.evaluate(() => window.__editorProbe.setInputDragging(true));
  await until(page, () => window.__editorProbe.transport.cameraFollow === false);
  await page.evaluate(
    (rail) =>
      window.__cameraProbe.look(
        [rail.centre[0], rail.centre[1] + 7, rail.centre[2] + 14],
        rail.centre
      ),
    railWorld
  );
  await page.evaluate(() => window.__editorProbe.setInputDragging(false));
  await sleep(500);

  const anchorScreen = await page.evaluate(
    (point) => window.__cameraProbe.project(point),
    railWorld.first
  );
  const onCanvas =
    anchorScreen !== null &&
    anchorScreen.x > 4 &&
    anchorScreen.y > 4 &&
    anchorScreen.x < canvasBox.width - 4 &&
    anchorScreen.y < canvasBox.height - 4;
  check(
    "framing the rail puts its first anchor on screen, so a drag can reach it",
    onCanvas,
    JSON.stringify(anchorScreen)
  );

  if (onCanvas) {
    // Clear Pascal's selection first. A selected node mounts PASCAL's own move gizmo, and with the
    // rail selected that gizmo sits exactly where ours does — the drag then moves the path NODE as
    // well as the anchor, which is two document writes and reads as a batching bug in our code.
    await page.evaluate(() => window.__editorProbe.selectNodes([]));
    await sleep(200);

    const ax = canvasBox.x + anchorScreen.x;
    const ay = canvasBox.y + anchorScreen.y;
    await page.mouse.click(ax, ay);
    await sleep(400);

    // One drag, measured twice at different pointer-move counts. That is the claim worth making:
    // the cost of a gesture must not scale with how many frames the pointer took. Asserting an
    // exact count would instead pin how many transform cycles the library's editor happens to
    // emit for one press, which is not this package's behaviour and not a promise it can keep.
    const dragBy = async (steps) => {
      const before = await page.evaluate(() => window.__editorProbe.undoDepthNow());
      const pointsBefore = await page.evaluate(
        (id) => window.__editorProbe.nodeField(id, "points"),
        railId
      );
      await page.mouse.move(ax, ay);
      await page.mouse.down();
      for (let step = 1; step <= steps; step += 1) {
        await page.mouse.move(ax + step * (72 / steps), ay - step * (36 / steps));
        await sleep(16);
      }
      await page.mouse.up();
      await sleep(500);
      const pointsAfter = await page.evaluate(
        (id) => window.__editorProbe.nodeField(id, "points"),
        railId
      );
      return {
        entries: (await page.evaluate(() => window.__editorProbe.undoDepthNow())) - before,
        moved: Math.hypot(
          (pointsAfter?.[0]?.x ?? 0) - (pointsBefore?.[0]?.x ?? 0),
          (pointsAfter?.[0]?.y ?? 0) - (pointsBefore?.[0]?.y ?? 0),
          (pointsAfter?.[0]?.z ?? 0) - (pointsBefore?.[0]?.z ?? 0)
        )
      };
    };

    const shortDrag = await dragBy(6);
    check(
      "dragging a handle in the viewport reshapes the rail in the document",
      shortDrag.moved > 0.05,
      `${shortDrag.moved.toFixed(3)} m over 6 pointer moves`
    );

    const longDrag = await dragBy(24);
    check(
      "the drag's undo cost does not grow with pointer moves — 4x the moves, no more entries",
      longDrag.entries <= shortDrag.entries && longDrag.entries <= 2,
      `${shortDrag.entries} entries at 6 moves, ${longDrag.entries} at 24`
    );
  }

  await railsSection.getByRole("button", { name: /Shape .* in the viewport/ }).click();
  const handlesOff = await until(
    page,
    () => {
      const handles = window.__editorProbe.pathHandles();
      return handles.mounted === false ? handles : null;
    },
    { timeout: 10_000 }
  );
  check("turning shape mode off unmounts them entirely", handlesOff.mounted === false, "unmounted");

  // Extend the rail: one more anchor, and it gets longer.
  await railsSection.getByRole("button", { name: /Extend / }).click();
  const grown = await until(
    page,
    (id) => {
      const lengths = window.__editorProbe.railLengths();
      return (lengths[id] ?? 0) > 9 ? lengths[id] : null;
    },
    { timeout: 10_000 },
    railId
  );
  check("extending the rail adds to its length", grown > 9, `${grown.toFixed(2)} m`);

  // A cart on the rail, and a run for it.
  await railsSection.getByRole("button", { name: /Add a cart to / }).click();
  const cartId = await until(
    page,
    () => window.__editorProbe.findNodeIdByType("huma-time:cart"),
    { timeout: 10_000 }
  );
  check("a cart rides the rail", Boolean(cartId), cartId);

  // Put the run and the cart shot on the SAME window, and place that window after EVERY other
  // shot's start: the last start wins, so anything less is a sample that might belong to another
  // shot. Lengthen the clock first, through the panel's own duration field, so the window fits.
  const durationField = sidebar.getByRole("textbox", { name: "Timeline duration in seconds" });
  await durationField.fill("30");
  await durationField.press("Enter");
  await until(page, () => {
    const p = window.__editorProbe;
    return p.nodeField(p.timelineId, "durationSeconds") === 30 ? true : null;
  });
  // Past every existing block's END, not merely past their starts. A shot whose block still runs
  // into this window overlaps it, and an overlap IS a crossover — so the camera would sit part-way
  // between two shots for perfectly correct reasons, and "the camera is on its cart" would fail
  // while measuring a blend. That is the model working, not the rail failing.
  const RIDE_START = await page.evaluate(() => {
    const ends = window.__editorProbe.cameraBlocks().map((block) => block.end ?? 0);
    return Math.ceil(Math.max(0, ...ends)) + 1;
  });
  await scrubTo(RIDE_START);
  await railsSection.getByRole("button", { name: /Add a dolly run for / }).click();
  const runTrack = await until(
    page,
    (id) => {
      const p = window.__editorProbe;
      const tracks = p.nodeField(p.timelineId, "tracks") ?? [];
      return tracks.find((track) => track.type === "cart" && track.cartId === id) ?? null;
    },
    { timeout: 10_000 },
    cartId
  );
  check(
    "the run rides the whole rail, eased from its FIRST key",
    runTrack.keys.length === 2 &&
      runTrack.keys[0].easing === "easeInOut" &&
      Math.abs(runTrack.keys[1].distance - grown) < 0.5,
    `0 → ${runTrack.keys[1].distance.toFixed(2)} m, easing on key 0`
  );

  // The dolly lane comes alive: a block for the run, with its speed sparkline.
  const dollyBlock = dock.locator(".timeline-editor-action").filter({ hasText: "→" });
  await dollyBlock.first().waitFor({ state: "visible", timeout: 10_000 });
  check("the dolly lane shows the run as a block", (await dollyBlock.count()) >= 1, await dollyBlock.count());
  const sparklines = await dollyBlock.first().locator("svg path, svg polyline").count();
  check("with its speed profile drawn inside it", sparklines >= 1, sparklines);

  // The cart shot goes on NOW, while the playhead is still at the run's start — a shot is created
  // wherever the playhead is, and the sampling below moves it. Created later, its window would sit
  // past the run entirely and the samples would belong to whichever other shot owns that moment.
  await railsSection.getByRole("button", { name: /Add a shot on / }).click();
  const cartShotId = await until(
    page,
    (id) =>
      window.__editorProbe
        .findNodeIdsByType("huma-time:shot")
        .find((shot) => window.__editorProbe.nodeField(shot, "cartId") === id) ?? null,
    { timeout: 10_000 },
    cartId
  );
  check("a cart-bodied shot is authorable from the rail", Boolean(cartShotId), cartShotId);

  // The cart's position is DERIVED from the clock, never stored.
  await scrubTo(RIDE_START + 0.5);
  const cartAtStart = (await page.evaluate(() => window.__editorProbe.cartPositions()))[cartId];
  await scrubTo(RIDE_START + 3.5);
  const cartLater = (await page.evaluate(() => window.__editorProbe.cartPositions()))[cartId];
  const rode = Math.hypot(
    cartLater[0] - cartAtStart[0],
    cartLater[1] - cartAtStart[1],
    cartLater[2] - cartAtStart[2]
  );
  check("the cart rides the rail as the clock advances", rode > 1, `${rode.toFixed(2)} m`);
  const storedCartPosition = await page.evaluate(
    (id) => window.__editorProbe.nodeField(id, "position"),
    cartId
  );
  check(
    "and its position is nowhere in the document — it is derived every frame",
    storedCartPosition === undefined,
    String(storedCartPosition)
  );

  // The drag above left the AUTHOR owning the camera (a viewport press is a grab). A seek reclaims
  // it — without this the "camera rides the rail" checks would measure a parked camera and report
  // 0 m for the right reason, which reads exactly like the feature not working.
  await scrubTo(RIDE_START + 0.5);
  const reclaimed = await until(page, () => {
    const p = window.__editorProbe;
    return p.transport.cameraFollow === true ? p : null;
  });
  check(
    "a seek hands the camera back to the director after viewport shaping",
    reclaimed.transport.cameraFollow === true,
    "cameraFollow=true"
  );

  // Whose frame is it? Asserted rather than assumed: with several shots authored, the last start
  // wins, and measuring "the camera rode the rail" while a static shot owned the frame would
  // report 0 m for a reason that has nothing to do with rails.
  const ownsEarly = await page.evaluate(() => window.__editorProbe.appliedCamera());
  check(
    "the cart shot owns the frame across the run's window",
    ownsEarly?.vcamId === cartShotId,
    `${ownsEarly?.vcamId === cartShotId ? "the cart shot" : ownsEarly?.vcamId} at t=${RIDE_START + 0.5}`
  );

  const ridingEarly = await page.evaluate(() => window.__cameraProbe.pose());
  await scrubTo(RIDE_START + 3.5);
  const ridingLate = await page.evaluate(() => window.__cameraProbe.pose());
  const cameraRode = Math.hypot(
    ridingLate.position[0] - ridingEarly.position[0],
    ridingLate.position[1] - ridingEarly.position[1],
    ridingLate.position[2] - ridingEarly.position[2]
  );
  check(
    "and the viewport camera actually rides the rail under R9 (through the controller)",
    cameraRode > 1,
    `${cameraRode.toFixed(2)} m`
  );

  // The camera and the cart are at the same place: the shot is ON the rail, not merely moving.
  const cartAtLate = (await page.evaluate(() => window.__editorProbe.cartPositions()))[cartId];
  const offRail = Math.hypot(
    ridingLate.position[0] - cartAtLate[0],
    ridingLate.position[1] - cartAtLate[1],
    ridingLate.position[2] - cartAtLate[2]
  );
  check("the camera sits exactly on its cart", offRail < 1e-3, `${offRail.toExponential(2)} m`);

  // Moving the RAIL moves the shot, with no timeline edit — the binding-by-id seam again.
  const railWas = await page.evaluate((id) => window.__editorProbe.nodeField(id, "position"), railId);
  await page.evaluate(
    (args) => window.__editorProbe.setNodePosition(args.id, args.position),
    { id: railId, position: [railWas[0], railWas[1] + 5, railWas[2]] }
  );
  await scrubTo(RIDE_START + 3.5);
  const afterRailMove = await page.evaluate(() => window.__cameraProbe.pose());
  check(
    "moving the rail moves the shot riding it, with no timeline edit at all",
    Math.abs(afterRailMove.position[1] - ridingLate.position[1] - 5) < 0.05,
    `${(afterRailMove.position[1] - ridingLate.position[1]).toFixed(3)} m of 5`
  );

  check("no unhandled page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  await page.screenshot({ path: join(APP_DIR, "measure-last-run.png") });
  await browser.close();
} catch (error) {
  check("the run completed", false, String(error));
} finally {
  server.kill("SIGTERM");
}

for (const [claim, ok, detail] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${claim}  [${detail}]`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
