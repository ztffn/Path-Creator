import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import {
  BezierPath,
  ControlMode,
  EndOfPathInstruction,
  PathSpace,
  TargetRegistry,
  VertexPath,
  createPathCart,
  sampleCartFrame,
  type CartFrame,
  sampleEasingCurve,
  type ComposerSettings,
  type Easing,
  type EasingCurve,
  type ActionDefinition,
  type RigCartDefinition,
  type RigPathDefinition,
  type SceneClip,
  type SerializedBezierPath,
  type TriggerBinding,
  type TriggerDefinition,
  type Vec3
} from "@huma/path-creator/core";
import {
  CameraOverrideSurface,
  CartGizmo,
  CartVcamGlyphRig,
  EditorHelpers,
  OrbitVcamGlyphRig,
  PathEditor,
  PointTargets,
  VirtualCameraGlyph,
  getSuggestedNextAnchor,
  normalizeAnchorScales,
  useEditorHelpersVisible,
  useRegisteredTargets,
  useRigDrive,
  type RigDriveIntent
} from "@huma/path-creator/r3f";
import {
  captureVirtualCameraSnapshot,
  registerObjectTarget,
  createOverrideInputAccumulator,
  type OverrideInputAccumulator,
  type VirtualCameraBlendCurve,
  type VirtualCameraDefinition,
  type VirtualCameraLens,
  type VirtualCameraSnapshot
} from "@huma/path-creator/three";
import {
  createTimelinePlayer,
  seekTimelinePlayer,
  type Timeline,
  type TimelinePlayer,
} from "@huma/path-creator/timeline";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { TimelineLanes } from "@huma/path-creator/timeline-ui";
import {
  buildShowTimeline,
  contentFromScene,
  sceneFromStory,
  EMPTY_INTERACTIONS,
  EMPTY_SCENE_CONTENT,
  type DemoInteractions,
  type DemoScene,
  type DemoSceneContent,
  type DemoStory
} from "./scene-io";
import {
  Activatable,
  ActivatablesProvider,
  ActivatablesRegistry,
  useActivatables,
  useActivatablesRegistry
} from "./activatables";
import { GltfActivatable } from "./gltf-activatable";
import {
  EMPTY_DESIRED,
  EMPTY_EXTRA_TRACKS,
  evaluateAudio,
  resizeAudioClip,
  maxClipEnd,
  snapSeconds,
  transformBlock,
  transformKeyTimes,
  insertTransformKey,
  normalizeExtraTracks,
  hasExtraTracks,
  type ActivationTrack,
  type AnimationTrack,
  type AudioTrack,
  type ExtraTracks,
  type TransformKey,
  type TransformTrack
} from "./extra-tracks";
import { AudioTrackPlayer } from "./audio-player";
import { clipPeaks } from "./audio-peaks";
import { dollyMoveSpeedSeries } from "./dolly-speed";
import { DollyPreviewChrome } from "./camera-pip";
import { DemoSceneViewport, type VirtualCameraActivation } from "./demo-scene-viewport";
import { downloadStory, readStoryFile, usePersistedStory, useStoryAutosave } from "./scene-storage";
import { Hierarchy } from "./hierarchy";
import { Inspector } from "./inspector";
import { panelGlobalCss, BG, BORDER, MUTED, TEXT, FAINT, SANS } from "./panel-theme";
import { IconEye, IconVideo, IconTrack, IconVolume } from "./icons";
import { isSelected, selectedIdOf, type EntityKind, type Selection } from "./selection";
import {
  DEFAULT_COMPOSER_SETTINGS,
  expandNoisePreset,
  hasActiveOverrideAxis,
  makeDolly,
  ORBIT_DEFAULTS,
  DEFAULT_DOLLY_EASING,
  ORBIT_INTERACTIVE_CONTROL,
  toVcamView,
  vcamDefFromView,
  type FovAnimation,
  type DemoShotPatch,
  type DemoVirtualCamera,
  type DollyRun,
  type EditorVcam,
  type SceneTarget,
  type ShotTiming
} from "./vcam-model";
import {
  CameraHelper,
  Color,
  MOUSE,
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  Vector3,
  type Group
} from "three";

const STORAGE_KEY = "path-creator:minimal-demo:path";
const SHOW_STORAGE_KEY = "path-creator:minimal-demo:show";
// The scene is persisted as a portable RigDocument; the two keys above are only
// read for one-time migration of shows saved before this format.
const SCENE_STORAGE_KEY = "path-creator:minimal-demo:scene";
// Legacy standalone extra-track storage, read only for one-time migration.
const EXTRA_STORAGE_KEY = "path-creator:minimal-demo:tracks";
// Bundled sample voices under public/audio (pretend-uploaded assets); new audio
// clips cycle through these so the waveform preview has real content to draw.
const SAMPLE_AUDIO = ["/audio/jarvis.mp3", "/audio/morganfreeman.mp3", "/audio/samjackson.mp3", "/audio/samaltman.mp3", "/audio/fireship.mp3", "/audio/linus.mp3"];
// Speed sparklines vary per move (each run authors its own easing). Cache only preset
// strings (a small fixed set); custom curves change on every edit, so caching them would
// grow unbounded for no benefit — compute those fresh (cheap: ~49 samples).
// Sample a clip's volume envelope (raw 0..1 value) into the block's gain overlay line.
function gainLinePoints(curve: EasingCurve, samples = 24): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= samples; i++) pts.push(Math.min(1, Math.max(0, sampleEasingCurve(curve, i / samples))));
  return pts;
}
const speedSeriesCache = new Map<string, ReturnType<typeof dollyMoveSpeedSeries>>();
function speedSeriesFor(easing: Easing): ReturnType<typeof dollyMoveSpeedSeries> {
  if (typeof easing !== "string") return dollyMoveSpeedSeries(easing);
  let series = speedSeriesCache.get(easing);
  if (!series) {
    series = dollyMoveSpeedSeries(easing);
    speedSeriesCache.set(easing, series);
  }
  return series;
}

// Legacy loader for extra tracks saved under their own key (pre-portability). Read
// once at mount to migrate; new writes ride inside the scene document instead.
function loadExtraTracks(): ExtraTracks {
  try {
    const raw = localStorage.getItem(EXTRA_STORAGE_KEY);
    if (!raw) return EMPTY_EXTRA_TRACKS;
    return normalizeExtraTracks(JSON.parse(raw));
  } catch {
    return EMPTY_EXTRA_TRACKS;
  }
}

// Correlation keys tying cart-bodied vcams to the demo rail; a rename must
// touch nothing else.
// A production can run several dollies, all riding the demo's one rail;
// cameras mount a dolly via their cart body's cartId.
const FALLBACK_PATH_ID = "path-1";
const FALLBACK_DOLLY: RigCartDefinition = makeDolly({ id: "dolly-1", name: "Dolly 1", pathId: FALLBACK_PATH_ID });
const INITIAL_DOLLIES: RigCartDefinition[] = [FALLBACK_DOLLY];

// Fallbacks for a vcam whose sidecar entry is missing (shouldn't happen, but
// keeps the derived view total). Stable identities, so hoisted out of render.
const DEFAULT_EDITOR_VCAM: EditorVcam = { noisePreset: "off", composerSettings: DEFAULT_COMPOSER_SETTINGS };
const DEFAULT_SHOT_TIMING: ShotTiming = { start: 0, end: 5 };

// A new path starts as a simple two-anchor segment (start → stop); the user
// builds from there with Add Anchor / Insert Midpoint.
function createDefaultBezier(): BezierPath {
  return new BezierPath(
    [
      { x: -1.5, y: 0, z: 0 },
      { x: 1.5, y: 0, z: 0 }
    ],
    {
      space: PathSpace.XYZ,
      controlMode: ControlMode.Automatic
    }
  );
}

const INITIAL_POINT_TARGETS: SceneTarget[] = [
  { id: "target-1", name: "Target 1", type: "point", position: { x: 3.3, y: 0.8, z: 0 }, visibleInRender: true },
  { id: "target-2", name: "Target 2", type: "point", position: { x: 1.95, y: 1.15, z: 0.78 }, visibleInRender: true },
  // Seeded cart-mounted, to demonstrate a moving aim point authored as data.
  { id: "target-3", name: "Target 3", type: "cart", cartId: FALLBACK_DOLLY.id, visibleInRender: true }
];

// A stored target from any era: the current tagged union, or the legacy flat
// shape (no `type`, a nullable cartId, an always-present position).
type StoredTarget = {
  id: string;
  name?: string;
  type?: "point" | "cart";
  position?: Vec3;
  cartId?: string | null;
  visibleInRender?: boolean;
};

/** Migrates a stored target to the package's point/cart union. */
function toSceneTarget(raw: StoredTarget): SceneTarget {
  const visibleInRender = raw.visibleInRender ?? true;
  const named = raw.name !== undefined ? { name: raw.name } : {};
  const mounted = raw.type === "cart" || (raw.type === undefined && raw.cartId);
  return mounted
    ? { id: raw.id, ...named, type: "cart", cartId: raw.cartId ?? "", visibleInRender }
    : { id: raw.id, ...named, type: "point", position: raw.position ?? { x: 0, y: 0, z: 0 }, visibleInRender };
}

// Next "Target N" that doesn't collide with an existing trailing number, so
// names stay stable after deletes.
function nextTargetName(current: SceneTarget[]): string {
  const highest = current.reduce((max, t) => {
    const match = /(\d+)$/.exec(t.name ?? "");
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `Target ${highest + 1}`;
}

export function App() {
  // The story is a portable RigDocument (schema v7: N scenes + entry marker).
  // Load it if present; otherwise migrate a pre-format show once (read here,
  // rewritten in the new format on first save). The editor's working states hold
  // the ENTRY scene's content initially; other scenes stay in sceneContents.
  const loadedStory = usePersistedStory(SCENE_STORAGE_KEY);
  const loadedScene = useMemo(
    () =>
      loadedStory
        ? sceneFromStory(loadedStory, loadedStory.entrySceneId ?? loadedStory.scenes[0]!.id) ??
          sceneFromStory(loadedStory, loadedStory.scenes[0]!.id)
        : null,
    [loadedStory]
  );

  const [bezierPath, setBezierPath] = useState<BezierPath | null>(() => {
    if (loadedScene) {
      const active =
        loadedScene.paths.find((path) => path.id === loadedScene.activePathId) ?? loadedScene.paths[0];
      return active ? BezierPath.fromJSON(active.bezier) : null;
    }
    try {
      const rawShow = localStorage.getItem(SHOW_STORAGE_KEY);
      if (rawShow) {
        const parsedShow = JSON.parse(rawShow) as {
          paths?: RigPathDefinition[];
          activePathId?: string;
        };
        // An explicit paths array (incl. empty) is authoritative: no editable
        // path is a valid state, so don't fall through to the legacy seed.
        if (Array.isArray(parsedShow.paths)) {
          const active =
            parsedShow.paths.find((path) => path.id === parsedShow.activePathId) ??
            parsedShow.paths[0];
          return active ? BezierPath.fromJSON(active.bezier) : null;
        }
      }
    } catch {
      // fall through to the legacy single-path key
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultBezier();

    try {
      const parsed = JSON.parse(raw) as SerializedBezierPath;
      return BezierPath.fromJSON(parsed);
    } catch {
      return createDefaultBezier();
    }
  });

  const [pathVersion, setPathVersion] = useState(0);
  const [debugPreview, setDebugPreview] = useState(true);
  const [debugFrustum, setDebugFrustum] = useState(true);
  // Edit vs Play mode. Edit: the editor camera owns the main viewport with
  // OrbitControls + helpers; the driven "viewer" camera previews in the PiP.
  // Play: the driven camera owns the main viewport (clean, no helpers) and all
  // interaction pilots it (editor OrbitControls are off); the editor drops to the
  // PiP. One switch flips the render camera, the controls, AND the input surface.
  const [viewMode, setViewMode] = useState<"edit" | "play">("edit");
  const playMode = viewMode === "play";
  // The vcam actually driving the PiP this frame — reported by the drive loop. In
  // timeline playback the active shot changes over time, so this is the truth for
  // the PiP label and for deciding whether the viewport can pilot an orbit shot.
  const [activeDrivenVcamId, setActiveDrivenVcamId] = useState<string | null>(null);

  // Quick toggle: press "P" to flip Edit <-> Play (ignored while typing in a field).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "p" && event.key !== "P") return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        return;
      }
      setViewMode((mode) => (mode === "edit" ? "play" : "edit"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const targetRegistry = useMemo(() => new TargetRegistry(), []);
  const activatablesRegistry = useMemo(() => new ActivatablesRegistry(), []);
  const audioPlayer = useMemo(() => new AudioTrackPlayer(), []);
  const activatables = useActivatables(activatablesRegistry);
  // Extra tracks ride inside the scene document now; seed from there, falling back to
  // the legacy per-key sidecar once (older autosaves). Persisted via the scene autosave.
  const [extraTracks, setExtraTracks] = useState<ExtraTracks>(() =>
    loadedScene && hasExtraTracks(loadedScene.extraTracks) ? loadedScene.extraTracks : loadExtraTracks()
  );
  // Per-vcam FOV animation, keyed by vcam id. Part of the portable scene (persisted
  // as CameraBlock.lensAnimation via the scene autosave), so no separate sidecar key.
  const [fovAnimations, setFovAnimations] = useState<Record<string, FovAnimation>>(
    () => loadedScene?.fovAnimations ?? {}
  );
  const setFovAnimation = (vcamId: string, anim: FovAnimation | null): void => {
    setFovAnimations((prev) => {
      const next = { ...prev };
      if (anim) next[vcamId] = anim;
      else delete next[vcamId];
      return next;
    });
  };
  useEffect(() => {
    const unlock = () => audioPlayer.resume();
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, [audioPlayer]);
  useEffect(() => () => audioPlayer.dispose(), [audioPlayer]);
  // DEV-only oracle handle: lets the Playwright verification read a bound object's
  // visibility and drive the timeline clock without brittle UI scripting. Stripped
  // from production builds (import.meta.env.DEV is false there).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __demo?: Record<string, unknown> };
    // Merge (don't replace): the viewport registers its own oracle keys (e.g.
    // brainPose) on this object from a child effect that runs before this one.
    w.__demo = {
      ...w.__demo,
      isVisible: (id: string) => activatablesRegistry.resolve(id)?.visible ?? null,
      player: timelinePlayerRef.current,
      setExtraTracks,
      setFovAnimation,
      enterTimeline: () => setPipDriver("timeline"),
      leaveTimeline: () => setPipDriver("shots"),
      playScene: (id: string) => setPlaySceneRequest({ key: Date.now(), sceneId: id }),
      activeSceneId: () => liveSceneRef.current,
      simulateTrigger: (id: string) => setSimulateTriggerRequest({ key: Date.now(), triggerId: id }),
      selectObject: (id: string) => select("object", id),
      clipsOf: (id: string) => activatablesRegistry.resolveAnimation(id)?.clips ?? null,
      readPose: (id: string) => readObjectPose(id),
      // Pose signature over every node's world position + orientation, so a different
      // applied clip time yields a different number — proves the mixer wrote a pose.
      poseHash: (id: string) => {
        const object = activatablesRegistry.resolve(id);
        if (!object) return null;
        object.updateWorldMatrix(true, true);
        const p = new Vector3();
        const q = new Quaternion();
        let hash = 0;
        let i = 0;
        object.traverse((node) => {
          node.getWorldPosition(p);
          node.getWorldQuaternion(q);
          i += 1;
          hash += (p.x + p.y * 1.7 + p.z * 2.3 + q.x + q.y * 1.3 + q.z * 1.7 + q.w * 2.1) * i;
        });
        return hash;
      }
    };
  }, [activatablesRegistry]);
  // Live cart frames, shared by Scene (writer) and PointTargets/glyphs (readers).
  const dollyFramesRef = useRef<Map<string, CartFrame>>(new Map());
  // Manual-override input: the capture surface accumulates, the drive loop drains.
  const overrideAcc = useMemo(() => createOverrideInputAccumulator(), []);
  // Clear any gesture left in the accumulator when entering Play, so a delta from a
  // prior Play session can't jump the camera on this session's first drive frame.
  useEffect(() => {
    if (playMode) overrideAcc.drain();
  }, [playMode, overrideAcc]);
  // Composer overlay markers on the PiP, driven imperatively from Scene's frame loop.
  const dollyTargetMarkerRef = useRef<HTMLDivElement | null>(null);
  const dollyTargetLineRef = useRef<SVGLineElement | null>(null);
  const lookaheadMarkerRef = useRef<HTMLDivElement | null>(null);
  const lookaheadLineRef = useRef<SVGLineElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const registeredTargets = useRegisteredTargets(targetRegistry);
  const [pipDriver, setPipDriver] = useState<"shots" | "timeline">("shots");
  const timelinePlayerRef = useRef<TimelinePlayer>(createTimelinePlayer());
  // The show (dollies, shots, mounts, moves) survives reloads like the spline.
  const storedShow = useMemo(() => {
    try {
      const raw = localStorage.getItem(SHOW_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as
        | Partial<DemoVirtualCamera>[]
        | {
            dollies?: Partial<RigCartDefinition>[];
            vcams?: Partial<DemoVirtualCamera>[];
            paths?: RigPathDefinition[];
            activePathId?: string;
            pointTargets?: StoredTarget[];
          };
      return Array.isArray(parsed) ? { vcams: parsed } : parsed;
    } catch {
      return null;
    }
  }, []);
  const [pointTargets, setPointTargets] = useState<SceneTarget[]>(
    () => loadedScene?.targets ?? storedShow?.pointTargets?.map(toSceneTarget) ?? INITIAL_POINT_TARGETS
  );
  // Unified single-selection atom (engine-style). Old per-type ids are derived
  // from it so existing panels keep working during the phased refactor.
  const [selection, setSelection] = useState<Selection>(null);
  const selectedPointTargetId = selectedIdOf(selection, "target");

  // The one selection funnel: sets the atom, clears path sub-selection for
  // non-path kinds, and parks playback when a camera shot is selected.
  function select(kind: EntityKind, id: string | null): void {
    setSelection(id === null ? null : { kind, id });
    if (id === null) return;
    if (kind !== "path") {
      setSelectedHandleIndex(null);
      setSelectedMidpointIndex(null);
    }
    if (kind === "camera") {
      setPipDriver("shots");
      timelinePlayerRef.current.playing = false;
    }
  }

  function selectPointTarget(id: string | null): void {
    select("target", id);
  }

  // Hierarchy row → selection. A path row also becomes the editable path (loads
  // its geometry + anchor sub-selection); every other kind just sets the atom.
  function selectFromHierarchy(kind: EntityKind, id: string): void {
    if (kind === "path") switchPath(id);
    select(kind, id);
  }

  function addPointTarget(): void {
    const id = `target-${Date.now()}`;
    setPointTargets((current) => [
      ...current,
      { id, name: nextTargetName(current), type: "point", position: { x: 2.4, y: 0.8, z: 0 }, visibleInRender: true }
    ]);
    selectPointTarget(id);
  }

  // Toggle static/cart: mounting drops the fixed position (the cart drives it);
  // unmounting parks the target at its current world position so it doesn't jump.
  function setPointTargetMount(id: string, cartId: string | null): void {
    setPointTargets((current) =>
      current.map((t) => {
        if (t.id !== id) return t;
        const named = t.name !== undefined ? { name: t.name } : {};
        const visibleInRender = t.visibleInRender ?? true;
        if (cartId) return { id: t.id, ...named, type: "cart", cartId, visibleInRender };
        const parked = targetRegistry.resolve(id) ?? (t.type === "point" ? t.position : { x: 0, y: 0, z: 0 });
        return { id: t.id, ...named, type: "point", position: parked, visibleInRender };
      })
    );
  }

  function deletePointTarget(id: string): void {
    setPointTargets((current) => current.filter((t) => t.id !== id));
    if (isSelected(selection, "target", id)) setSelection(null);
  }

  function movePointTarget(id: string, position: Vec3): void {
    setPointTargets((current) =>
      current.map((t) => (t.id === id && t.type === "point" ? { ...t, position } : t))
    );
  }

  function renamePointTarget(id: string, name: string): void {
    setPointTargets((current) => current.map((t) => (t.id === id ? { ...t, name } : t)));
  }

  function togglePointTargetVisible(id: string): void {
    setPointTargets((current) =>
      current.map((t) => (t.id === id ? { ...t, visibleInRender: !(t.visibleInRender ?? true) } : t))
    );
  }

  const [dollies, setDollies] = useState<RigCartDefinition[]>(() =>
    loadedScene?.dollies ??
    (storedShow?.dollies ?? INITIAL_DOLLIES).map((dolly) => {
      // Legacy saves used `endOfPath`; the package cart uses `endOfPathInstruction`.
      const legacy = dolly as Partial<RigCartDefinition> & { endOfPath?: EndOfPathInstruction };
      return makeDolly({
        id: legacy.id ?? FALLBACK_DOLLY.id,
        name: legacy.name ?? "Dolly",
        pathId: legacy.pathId ?? storedShow?.paths?.[0]?.id ?? FALLBACK_PATH_ID,
        endOfPathInstruction: legacy.endOfPathInstruction ?? legacy.endOfPath ?? EndOfPathInstruction.Loop
      });
    })
  );

  function updateDolly(id: string, patch: Partial<RigCartDefinition>): void {
    setDollies((current) =>
      current.map((dolly) => (dolly.id === id ? { ...dolly, ...patch } : dolly))
    );
  }

  const [paths, setPaths] = useState<RigPathDefinition[]>(
    () =>
      loadedScene?.paths ??
      storedShow?.paths ?? [{ id: FALLBACK_PATH_ID, name: "Path 1", bezier: createDefaultBezier().toJSON() }]
  );
  const [activePathId, setActivePathId] = useState<string | null>(
    () => loadedScene?.activePathId ?? storedShow?.activePathId ?? paths[0]?.id ?? null
  );
  // Keep the active path's serialization current so switching/saving is lossless.
  useEffect(() => {
    if (!bezierPath || !activePathId) return;
    setPaths((current) =>
      current.map((path) =>
        path.id === activePathId ? { ...path, bezier: bezierPath.toJSON() } : path
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bezierPath, pathVersion]);

  function switchPath(id: string): void {
    const target = paths.find((path) => path.id === id);
    if (!target || id === activePathId) return;
    setActivePathId(id);
    setSelection({ kind: "path", id });
    setBezierPath(BezierPath.fromJSON(target.bezier));
    setSelectedHandleIndex(null);
    setSelectedMidpointIndex(null);
    setPathVersion((version) => version + 1);
  }

  function renamePath(id: string, name: string): void {
    setPaths((current) => current.map((path) => (path.id === id ? { ...path, name } : path)));
  }

  function addPath(): void {
    const id = `path-${Date.now()}`;
    const bezier = createDefaultBezier();
    setPaths((current) => [
      ...current,
      { id, name: `Path ${current.length + 1}`, bezier: bezier.toJSON() }
    ]);
    // First path in an empty world becomes the editable one immediately.
    if (activePathId === null) {
      setActivePathId(id);
      setBezierPath(bezier);
      setSelectedHandleIndex(0);
      setSelectedMidpointIndex(null);
      setPathVersion((version) => version + 1);
    }
  }

  function deletePath(id: string): void {
    const remaining = paths.filter((path) => path.id !== id);
    setPaths(remaining);
    if (isSelected(selection, "path", id)) {
      setSelection(remaining[0] ? { kind: "path", id: remaining[0].id } : null);
    }
    if (id === activePathId) {
      // Deleting the editable path: activate whatever remains, or clear the
      // editor entirely (empty world is valid).
      const fallback = remaining[0] ?? null;
      setActivePathId(fallback?.id ?? null);
      setBezierPath(fallback ? BezierPath.fromJSON(fallback.bezier) : null);
      setSelectedHandleIndex(fallback ? 0 : null);
      setSelectedMidpointIndex(null);
      setPathVersion((version) => version + 1);
    }
    // Repoint dollies off the deleted rail when another remains; otherwise the
    // dangling reference is tolerated (the dolly simply produces no frame).
    const repoint = remaining[0]?.id;
    if (repoint) {
      setDollies((current) =>
        current.map((dolly) => (dolly.pathId === id ? { ...dolly, pathId: repoint } : dolly))
      );
    }
  }
  const defaultDollyId = dollies[0]?.id ?? FALLBACK_DOLLY.id;
  // Migrate the stored flat "view" shape into defaulted views, then split into
  // the authoritative model (real defs + editor/timing sidecars). Fields absent
  // in older saves fall back to defaults; composer settings merge over the
  // default so saves predating a field stay valid.
  const initialShots = useMemo<DemoVirtualCamera[]>(
    () =>
      (storedShow?.vcams ?? []).map((vcam, index) => {
        const base = {
          cartId: storedShow?.dollies?.[0]?.id ?? FALLBACK_DOLLY.id,
          cartOffset: { x: 0, y: 0, z: 0 },
          trackTargetId: null,
          noisePreset: "off" as const,
          dutchDeg: 0,
          shotStart: index * 5,
          shotEnd: index * 5 + 5,
          ...vcam
        } as DemoVirtualCamera;
        return { ...base, composerSettings: { ...DEFAULT_COMPOSER_SETTINGS, ...base.composerSettings } };
      }),
    // storedShow is read once; this is the initial-load migration only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const [vcamDefs, setVcamDefs] = useState<VirtualCameraDefinition[]>(() =>
    loadedScene?.vcamDefs ??
    initialShots.map((view) =>
      vcamDefFromView(view, { noisePreset: view.noisePreset, composerSettings: view.composerSettings })
    )
  );
  const [editorVcams, setEditorVcams] = useState<Record<string, EditorVcam>>(() =>
    loadedScene?.editorVcams ??
    Object.fromEntries(
      initialShots.map((view) => [view.id, { noisePreset: view.noisePreset, composerSettings: view.composerSettings }])
    )
  );
  const [shotTiming, setShotTiming] = useState<Record<string, ShotTiming>>(() =>
    loadedScene?.shotTiming ??
    Object.fromEntries(initialShots.map((view) => [view.id, { start: view.shotStart, end: view.shotEnd }]))
  );
  // Per-dolly run-blocks. From a loaded document (F1+ saves hydrate these from
  // the cart tracks); pre-format shows start empty and re-author dolly moves.
  const [dollyRuns, setDollyRuns] = useState<Record<string, DollyRun[]>>(() => loadedScene?.dollyRuns ?? {});
  // Deterministic embeds: other scenes played inside this scene's time windows.
  const [sceneClips, setSceneClips] = useState<SceneClip[]>(() => loadedScene?.sceneClips ?? []);
  // The story's scene list. The ACTIVE scene's authoritative content lives in the
  // five working states (shotTiming/dollyRuns/fovAnimations/extraTracks/sceneClips);
  // its entry here goes stale while editing and is refreshed on switch and in currentStory.
  const [sceneContents, setSceneContents] = useState<DemoSceneContent[]>(
    () => loadedStory?.scenes ?? [{ id: "show", name: "Show", ...EMPTY_SCENE_CONTENT }]
  );
  const [activeSceneId, setActiveSceneId] = useState<string>(
    () => loadedStory?.entrySceneId ?? loadedStory?.scenes[0]?.id ?? "show"
  );
  const [entrySceneId, setEntrySceneId] = useState<string | null>(
    () => loadedStory?.entrySceneId ?? loadedStory?.scenes[0]?.id ?? "show"
  );
  // A queued live scene invocation for the drive loop (activation-request style).
  const [playSceneRequest, setPlaySceneRequest] = useState<{ key: number; sceneId: string } | null>(null);
  // The scene the runtime is playing right now (reported by the drive loop); ref
  // mirror keeps the DEV oracle closure fresh.
  const [liveSceneId, setLiveSceneId] = useState<string | null>(null);
  const liveSceneRef = useRef<string | null>(null);
  const onActiveSceneChange = (sceneId: string | null): void => {
    liveSceneRef.current = sceneId;
    setLiveSceneId(sceneId);
  };
  function requestPlayScene(sceneId: string): void {
    setPlaySceneRequest({ key: Date.now(), sceneId });
  }
  const [stopSceneRequest, setStopSceneRequest] = useState<{ key: number } | null>(null);
  function requestStopScene(): void {
    setStopSceneRequest({ key: Date.now() });
  }
  // The reactive interaction layer (document-level): triggers + actions +
  // bindings, edited as 1:1 units, persisted in the schema's n:m shape.
  const [interactions, setInteractions] = useState<DemoInteractions>(
    () => loadedStory?.interactions ?? EMPTY_INTERACTIONS
  );
  const [simulateTriggerRequest, setSimulateTriggerRequest] = useState<{ key: number; triggerId: string } | null>(null);
  function simulateTrigger(triggerId: string): void {
    setSimulateTriggerRequest({ key: Date.now(), triggerId });
  }
  // Transport verbs a fired trigger requests; play routes the PiP to the timeline.
  function handleTransportTrigger(op: "play" | "pause" | "seek", time?: number): void {
    if (op === "seek") seekTimelinePlayer(timelinePlayerRef.current, time ?? 0);
    else if (op === "play") {
      setPipDriver("timeline");
      timelinePlayerRef.current.playing = true;
    } else timelinePlayerRef.current.playing = false;
  }
  // The UI-facing view is a pure projection of the authoritative model.
  const virtualCameras = useMemo<DemoVirtualCamera[]>(
    () =>
      vcamDefs.map((def) =>
        toVcamView(def, editorVcams[def.id] ?? DEFAULT_EDITOR_VCAM, shotTiming[def.id] ?? DEFAULT_SHOT_TIMING)
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vcamDefs, editorVcams, shotTiming]
  );
  // The active scene's working set (pools + content), the shape the panels edit.
  const currentScene = useMemo<DemoScene>(() => ({
    paths,
    activePathId,
    dollies,
    vcamDefs,
    editorVcams,
    shotTiming,
    dollyRuns,
    fovAnimations,
    targets: pointTargets,
    extraTracks,
    sceneClips
  }), [paths, activePathId, dollies, vcamDefs, editorVcams, shotTiming, dollyRuns, fovAnimations, pointTargets, extraTracks, sceneClips]);
  // Persist the whole story as a portable RigDocument: every scene's content,
  // with the active scene's list entry refreshed from the live working states.
  const currentStory = useMemo<DemoStory>(() => ({
    paths,
    activePathId,
    dollies,
    vcamDefs,
    editorVcams,
    targets: pointTargets,
    scenes: sceneContents.map((content) =>
      content.id === activeSceneId ? contentFromScene(currentScene, content.id, content.name) : content
    ),
    entrySceneId,
    interactions
  }), [currentScene, sceneContents, activeSceneId, entrySceneId, paths, activePathId, dollies, vcamDefs, editorVcams, pointTargets, interactions]);
  useStoryAutosave(SCENE_STORAGE_KEY, currentStory);

  // Replaces the whole editing state from a loaded/parsed story (opens its entry scene).
  function applyStory(story: DemoStory): void {
    const entryId = story.entrySceneId ?? story.scenes[0]?.id ?? "show";
    const scene =
      sceneFromStory(story, entryId) ??
      (story.scenes[0] ? sceneFromStory(story, story.scenes[0].id) : null);
    const active = story.paths.find((path) => path.id === story.activePathId) ?? story.paths[0] ?? null;
    setPaths(story.paths);
    setActivePathId(active?.id ?? null);
    setBezierPath(active ? BezierPath.fromJSON(active.bezier) : null);
    setDollies(story.dollies);
    setVcamDefs(story.vcamDefs);
    setEditorVcams(story.editorVcams);
    setPointTargets(story.targets);
    setShotTiming(scene?.shotTiming ?? {});
    setDollyRuns(scene?.dollyRuns ?? {});
    setFovAnimations(scene?.fovAnimations ?? {});
    setExtraTracks(scene?.extraTracks ?? EMPTY_EXTRA_TRACKS);
    setSceneClips(scene?.sceneClips ?? []);
    setSceneContents(story.scenes.length > 0 ? story.scenes : [{ id: entryId, name: "Show", ...EMPTY_SCENE_CONTENT }]);
    setActiveSceneId(scene ? entryId : story.scenes[0]?.id ?? entryId);
    setEntrySceneId(entryId);
    setInteractions(story.interactions);
    setSelection(null);
    setSelectedMidpointIndex(null);
    setSelectedHandleIndex(active ? 0 : null);
    setPathVersion((version) => version + 1);
  }

  // Scene switching: fold the live working states back into the list, then load
  // the target's content — one pass per state so no functional update reads stale
  // sibling state (the known multi-channel hazard).
  function switchScene(sceneId: string): void {
    if (sceneId === activeSceneId) return;
    const target = sceneContents.find((content) => content.id === sceneId);
    if (!target) return;
    setSceneContents((prev) =>
      prev.map((content) =>
        content.id === activeSceneId ? contentFromScene(currentScene, content.id, content.name) : content
      )
    );
    setShotTiming(target.shotTiming);
    setDollyRuns(target.dollyRuns);
    setFovAnimations(target.fovAnimations);
    setExtraTracks(target.extraTracks);
    setSceneClips(target.sceneClips);
    setActiveSceneId(sceneId);
    setSelection(null);
    timelinePlayerRef.current.playing = false;
    seekTimelinePlayer(timelinePlayerRef.current, 0);
  }

  // A new scene starts empty (no camera participation => invoking it leaves the
  // user's camera alone until shots are added) and opens for editing.
  function addScene(): void {
    const id = `scene-${Date.now().toString(36)}`;
    const name = `Scene ${sceneContents.length + 1}`;
    setSceneContents((prev) => [
      ...prev.map((content) =>
        content.id === activeSceneId ? contentFromScene(currentScene, content.id, content.name) : content
      ),
      { id, name, ...EMPTY_SCENE_CONTENT }
    ]);
    setShotTiming({});
    setDollyRuns({});
    setFovAnimations({});
    setExtraTracks(EMPTY_EXTRA_TRACKS);
    setSceneClips([]);
    setActiveSceneId(id);
    setSelection(null);
    timelinePlayerRef.current.playing = false;
    seekTimelinePlayer(timelinePlayerRef.current, 0);
  }

  // Trigger authoring: 1:1 trigger+action+binding units over the n:m schema.
  function addTrigger(): void {
    const suffix = Date.now().toString(36);
    const entityId = activatables[0]?.id ?? pointTargets[0]?.id ?? "";
    const sceneId = sceneContents.find((content) => content.id !== activeSceneId)?.id ?? activeSceneId;
    const trigger: TriggerDefinition = {
      id: `trig-${suffix}`,
      name: `Trigger ${interactions.triggers.length + 1}`,
      source: { type: "proximity", targetId: entityId, radius: 3, hysteresis: 1 },
      arm: { type: "rearm-on-exit" }
    };
    const action: ActionDefinition = { id: `act-${suffix}`, type: "playScene", sceneId, skippable: true };
    const binding: TriggerBinding = { id: `bind-${suffix}`, triggerId: trigger.id, actionId: action.id };
    setInteractions((prev) => ({
      triggers: [...prev.triggers, trigger],
      actions: [...prev.actions, action],
      bindings: [...prev.bindings, binding]
    }));
    select("trigger", trigger.id);
  }

  function updateTrigger(triggerId: string, patch: Partial<Omit<TriggerDefinition, "id">>): void {
    setInteractions((prev) => ({
      ...prev,
      triggers: prev.triggers.map((trigger) => (trigger.id === triggerId ? { ...trigger, ...patch } : trigger))
    }));
  }

  // Replaces (or creates) the action bound to this trigger, keeping the binding.
  function updateTriggerAction(triggerId: string, action: ActionDefinition): void {
    setInteractions((prev) => {
      const binding = prev.bindings.find((candidate) => candidate.triggerId === triggerId);
      if (!binding) {
        return {
          ...prev,
          actions: [...prev.actions, action],
          bindings: [...prev.bindings, { id: `bind-${triggerId}`, triggerId, actionId: action.id }]
        };
      }
      return {
        ...prev,
        actions: prev.actions.some((candidate) => candidate.id === binding.actionId)
          ? prev.actions.map((candidate) => (candidate.id === binding.actionId ? { ...action, id: binding.actionId } : candidate))
          : [...prev.actions, { ...action, id: binding.actionId }]
      };
    });
  }

  function setTriggerPriority(triggerId: string, priority: number): void {
    setInteractions((prev) => ({
      ...prev,
      bindings: prev.bindings.map((binding) =>
        binding.triggerId === triggerId ? { ...binding, priority } : binding
      )
    }));
  }

  function deleteTrigger(triggerId: string): void {
    setInteractions((prev) => {
      const boundActionIds = new Set(
        prev.bindings.filter((binding) => binding.triggerId === triggerId).map((binding) => binding.actionId)
      );
      const stillBound = new Set(
        prev.bindings.filter((binding) => binding.triggerId !== triggerId).map((binding) => binding.actionId)
      );
      return {
        triggers: prev.triggers.filter((trigger) => trigger.id !== triggerId),
        actions: prev.actions.filter((action) => !boundActionIds.has(action.id) || stillBound.has(action.id)),
        bindings: prev.bindings.filter((binding) => binding.triggerId !== triggerId)
      };
    });
    if (isSelected(selection, "trigger", triggerId)) setSelection(null);
  }

  function exportScene(): void {
    downloadStory(currentStory);
  }

  function importSceneFile(file: File): void {
    readStoryFile(file)
      .then(applyStory)
      .catch((error: unknown) => console.error("Scene import failed", error));
  }

  function newScene(): void {
    const path: RigPathDefinition = {
      id: `path-${Date.now()}`,
      name: "Path 1",
      bezier: createDefaultBezier().toJSON()
    };
    applyStory({
      paths: [path],
      activePathId: path.id,
      dollies: [makeDolly({ id: "dolly-1", name: "Dolly 1", pathId: path.id })],
      vcamDefs: [],
      editorVcams: {},
      targets: [],
      scenes: [{ id: "show", name: "Show", ...EMPTY_SCENE_CONTENT }],
      entrySceneId: "show",
      interactions: EMPTY_INTERACTIONS
    });
  }

  // Dolly run-block authoring (per cartId). A new run parks-continues from the
  // previous run's end so it doesn't teleport; the default duration is 3s.
  function addDollyRun(cartId: string, start: number): void {
    setDollyRuns((current) => {
      const runs = current[cartId] ?? [];
      // Positions are normalized 0..1 along the path. Continue from where the last
      // run parked, and traverse to the far end so a fresh move covers the rail.
      const from = runs.reduce((last, run) => (run.end <= start ? run.toT : last), 0);
      const run: DollyRun = {
        id: `run-${cartId}-${Date.now()}`,
        start,
        end: start + 3,
        fromT: from,
        toT: from < 0.5 ? 1 : 0,
        easing: DEFAULT_DOLLY_EASING
      };
      return { ...current, [cartId]: [...runs, run].sort((a, b) => a.start - b.start) };
    });
  }

  function updateDollyRun(cartId: string, runId: string, patch: Partial<DollyRun>): void {
    setDollyRuns((current) => ({
      ...current,
      [cartId]: (current[cartId] ?? [])
        .map((run) => (run.id === runId ? { ...run, ...patch } : run))
        .sort((a, b) => a.start - b.start)
    }));
  }

  function deleteDollyRun(cartId: string, runId: string): void {
    setDollyRuns((current) => {
      const runs = (current[cartId] ?? []).filter((run) => run.id !== runId);
      const next = { ...current };
      if (runs.length > 0) next[cartId] = runs;
      else delete next[cartId];
      return next;
    });
  }

  function addDolly(): void {
    const id = `dolly-${Date.now()}`;
    setDollies((current) => [...current, makeDolly({ id, name: `Dolly ${current.length + 1}`, pathId: activePathId ?? paths[0]?.id ?? "" })]);
  }

  function deleteDolly(id: string): void {
    setDollies((current) => {
      const next = current.filter((dolly) => dolly.id !== id);
      // Remount cameras off the deleted dolly onto whatever remains; with no
      // dolly left the reference dangles (a cart vcam then produces no frame).
      const remount = next[0]?.id;
      if (remount) {
        setVcamDefs((defs) =>
          defs.map((def) =>
            def.body.type === "cart" && def.body.cartId === id
              ? { ...def, body: { ...def.body, cartId: remount } }
              : def
          )
        );
      }
      return next;
    });
  }
  const selectedVirtualCameraId = selectedIdOf(selection, "camera");
  const [virtualCameraCaptureRequest, setVirtualCameraCaptureRequest] = useState(0);
  const [virtualCameraActivation, setVirtualCameraActivation] =
    useState<VirtualCameraActivation | null>(null);
  const [virtualCameraBlendCurve, setVirtualCameraBlendCurve] =
    useState<VirtualCameraBlendCurve>("easeInOut");
  const [virtualCameraBlendDuration, setVirtualCameraBlendDuration] = useState(1.2);
  const [virtualCameraTransitionProgress, setVirtualCameraTransitionProgress] = useState(1);
  const [useWorldSpaceGizmo, setUseWorldSpaceGizmo] = useState(false);
  // Bumped when a lazily-decoded waveform finishes, so audio clips repaint with peaks.
  const [, setPeaksTick] = useState(0);
  const [pathStyle, setPathStyle] = useState<"line" | "rail">("rail");
  const [isTransforming, setIsTransforming] = useState(false);
  // Reads a bound object's live local transform (rotation in Euler degrees) for "key pose".
  const readObjectPose = (objectId: string) => {
    const object = activatablesRegistry.resolve(objectId);
    if (!object) return null;
    const k = 180 / Math.PI;
    return {
      position: [object.position.x, object.position.y, object.position.z] as [number, number, number],
      rotation: [object.rotation.x * k, object.rotation.y * k, object.rotation.z * k] as [number, number, number],
      scale: [object.scale.x, object.scale.y, object.scale.z] as [number, number, number]
    };
  };
  const [selectedHandleIndex, setSelectedHandleIndex] = useState<number | null>(0);
  const [selectedMidpointIndex, setSelectedMidpointIndex] = useState<number | null>(null);
  const [anchorScales, setAnchorScales] = useState<number[]>(
    () => (bezierPath ? new Array(bezierPath.numAnchorPoints).fill(1) : [])
  );

  const vertexPath = useMemo(
    () => (bezierPath ? new VertexPath(bezierPath, { spacing: 0.03 }) : null),
    [bezierPath, pathVersion]
  );
  const vertexPaths = useMemo(
    () =>
      new Map(
        paths.map((path) => [
          path.id,
          path.id === activePathId && vertexPath
            ? vertexPath
            : new VertexPath(BezierPath.fromJSON(path.bezier), { spacing: 0.05 })
        ])
      ),
    [paths, activePathId, vertexPath]
  );
  const selectedAnchorScaleForUi =
    selectedHandleIndex !== null && selectedHandleIndex % 3 === 0
      ? anchorScales[Math.floor(selectedHandleIndex / 3)] ?? 1
      : null;
  const selectedVirtualCamera = selectedVirtualCameraId
    ? virtualCameras.find((camera) => camera.id === selectedVirtualCameraId) ?? null
    : null;
  // Key the show only on timing/run fields so gizmo drags (offset/pose edits at
  // pointer rate) don't rebuild the timeline object every frame — the lane
  // editor treats a new editorData as a full re-init.
  const shotTimingKey = virtualCameras
    .map((vcam) => `${vcam.id}:${vcam.shotStart}:${vcam.shotEnd}:${vcam.cartId}`)
    .join("|");
  const dollyRunKey = Object.entries(dollyRuns)
    .map(
      ([cartId, runs]) =>
        `${cartId}:${runs
          .map((r) => `${r.start},${r.end},${r.fromT},${r.toT},${typeof r.easing === "string" ? r.easing : JSON.stringify(r.easing ?? "")}`)
          .join(";")}`
    )
    .join("|");
  const fovAnimKey = JSON.stringify(fovAnimations);
  // The show timeline is authored data (blocks + cart-track keys), built by the
  // shared scene-io helper — the same build used to assemble the saved document.
  // Keyed on timing/runs so gizmo drags (which change vcamDefs) don't rebuild it.
  // Latest clip end across activation/audio tracks: the show must run long enough
  // to cover object-only content (the core Timeline drives the player clock).
  const extraDuration = useMemo(() => maxClipEnd(extraTracks), [extraTracks]);
  // Built whenever there's ANY content — cameras, dolly moves, activation/audio
  // clips, OR scene embeds — so an object-only (or audio-only) show still plays.
  const hasTimelineContent =
    vcamDefs.length > 0 || Object.values(dollyRuns).some((runs) => runs.length > 0) || extraDuration > 0 ||
    sceneClips.length > 0;
  const sceneClipsKey = JSON.stringify(sceneClips);
  const demoTimeline = useMemo(() => {
    if (!hasTimelineContent) return null;
    const base = buildShowTimeline(
      vcamDefs,
      shotTiming,
      dollyRuns,
      (cartId) => {
        const dolly = dollies.find((d) => d.id === cartId);
        return (dolly && vertexPaths.get(dolly.pathId)?.length) || 1;
      },
      fovAnimations,
      EMPTY_EXTRA_TRACKS,
      sceneClips
    );
    // Extend the live clock to cover media/object clips that outlast camera/cart content.
    return { ...base, duration: Math.max(base.duration, extraDuration) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotTimingKey, dollyRunKey, fovAnimKey, extraDuration, sceneClipsKey]);
  // Every scene as a playable runtime timeline (extra tracks embedded), for the
  // active-scene runtime's playScene branch. The active scene reads the live
  // working states; the rest read their stored content.
  const storyScenes = useMemo(() => {
    const cartLength = (cartId: string): number => {
      const dolly = dollies.find((d) => d.id === cartId);
      return (dolly && vertexPaths.get(dolly.pathId)?.length) || 1;
    };
    const map = new Map<string, Timeline>();
    for (const content of sceneContents) {
      const live =
        content.id === activeSceneId
          ? { shotTiming, dollyRuns, fovAnimations, extraTracks, sceneClips }
          : content;
      map.set(
        content.id,
        buildShowTimeline(vcamDefs, live.shotTiming, live.dollyRuns, cartLength, live.fovAnimations, live.extraTracks, live.sceneClips, {
          id: content.id,
          ...(content.name !== undefined && { name: content.name })
        })
      );
    }
    return map;
  }, [sceneContents, activeSceneId, shotTiming, dollyRuns, fovAnimations, extraTracks, sceneClips, vcamDefs, dollies, vertexPaths]);
  const liveSceneName = liveSceneId
    ? sceneContents.find((content) => content.id === liveSceneId)?.name ?? liveSceneId
    : null;
  const timelineActive = pipDriver === "timeline" && demoTimeline != null;
  // The rig preview only has a source while an editable path drives it; with
  // no timeline/shot/selection and no path, the PiP shows "no output".
  const hasPipSource = Boolean(timelineActive || virtualCameraActivation || selectedVirtualCamera || liveSceneId);
  // The vcam actually driving the PiP this frame (reported by the drive loop);
  // during timeline playback this is the active block's shot, which changes over
  // time — so the label names the real camera instead of an opaque "Timeline".
  const activeDrivenVcam = activeDrivenVcamId
    ? virtualCameras.find((camera) => camera.id === activeDrivenVcamId) ?? null
    : null;
  const pipLabel = liveSceneName
    ? `▶ ${liveSceneName}`
    : timelineActive
      ? activeDrivenVcam
        ? `▶ ${activeDrivenVcam.name}`
        : "Timeline (gap)"
      : virtualCameraActivation
        ? activeDrivenVcam?.name ?? "Brain Camera"
        : selectedVirtualCamera
          ? selectedVirtualCamera.name
          : "No output";
  // Composer zone overlay reflects the previewed vcam (selected or activated).
  const activatedVcam = virtualCameraActivation
    ? virtualCameras.find((camera) => camera.id === virtualCameraActivation.toId) ?? null
    : null;
  const composerChromeVcam = selectedVirtualCamera ?? activatedVcam;
  const composerChromeActive = Boolean(composerChromeVcam?.trackTargetId);
  const composerChromeSettings = composerChromeVcam?.composerSettings ?? DEFAULT_COMPOSER_SETTINGS;
  // Play mode drops a viewport input surface over the whole 3D view whenever a
  // camera drives it (edit-mode authoring uses gizmos/sliders, not viewport drag).
  const showPlayInput = playMode && hasPipSource;

  function getActiveAnchorPointIndex(path: BezierPath): number | null {
    if (selectedHandleIndex === null) return null;
    if (selectedHandleIndex < 0 || selectedHandleIndex >= path.numPoints) return null;
    const mod = selectedHandleIndex % 3;
    if (mod === 0) return selectedHandleIndex;
    if (mod === 1) return selectedHandleIndex - 1;
    return selectedHandleIndex + 1;
  }

  function mutatePath(mutator: (path: BezierPath) => void): void {
    if (!bezierPath) return;
    mutator(bezierPath);
    setAnchorScales((prev) => normalizeAnchorScales(bezierPath.numAnchorPoints, prev));
    setPathVersion((v) => v + 1);
  }

  function rotateMidpointNormal(segmentIndex: number, deltaDegrees: number): void {
    mutatePath((path) => {
      const a = segmentIndex;
      const b = path.isClosed ? (segmentIndex + 1) % path.numAnchorPoints : segmentIndex + 1;
      if (a < 0 || b < 0 || a >= path.numAnchorPoints || b >= path.numAnchorPoints) return;
      path.setAnchorNormalAngle(a, path.getAnchorNormalAngle(a) + deltaDegrees * 0.5);
      path.setAnchorNormalAngle(b, path.getAnchorNormalAngle(b) + deltaDegrees * 0.5);
    });
  }

  function addAnchor(): void {
    mutatePath((path) => {
      if (path.isClosed) {
        path.setClosed(false);
      }
      const suggestedAnchor = getSuggestedNextAnchor(path);
      path.addSegmentToEnd(suggestedAnchor);
      setSelectedHandleIndex(path.numPoints - 1);
      setSelectedMidpointIndex(null);
    });
  }

  function insertAnchorAtSelectedSegment(): void {
    mutatePath((path) => {
      const activeAnchorPointIndex = getActiveAnchorPointIndex(path);
      if (activeAnchorPointIndex === null) return;

      let segmentIndex = Math.floor(activeAnchorPointIndex / 3);
      if (!path.isClosed && segmentIndex >= path.numSegments) {
        segmentIndex = Math.max(0, path.numSegments - 1);
      } else if (path.isClosed) {
        segmentIndex %= path.numSegments;
      }

      const newAnchorIndex = path.splitSegment(segmentIndex, 0.5);
      setSelectedHandleIndex(newAnchorIndex);
      setSelectedMidpointIndex(null);
    });
  }

  function deleteSelectedAnchor(): void {
    mutatePath((path) => {
      const activeAnchorPointIndex = getActiveAnchorPointIndex(path);
      if (activeAnchorPointIndex === null) return;
      const deleted = path.deleteAnchor(activeAnchorPointIndex);
      if (!deleted) return;
      const fallback = Math.max(0, Math.min(activeAnchorPointIndex, path.numPoints - 1));
      setSelectedHandleIndex(fallback);
      setSelectedMidpointIndex(null);
    });
  }

  function savePath(): void {
    if (!bezierPath) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bezierPath.toJSON()));
  }

  function loadPath(): void {
    if (!activePathId) return;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as SerializedBezierPath;
      const loaded = BezierPath.fromJSON(parsed);
      setBezierPath(loaded);
      setAnchorScales(new Array(loaded.numAnchorPoints).fill(1));
      setSelectedHandleIndex(0);
      setSelectedMidpointIndex(null);
      setPathVersion((v) => v + 1);
    } catch {
      // keep current path if local storage is invalid
    }
  }

  function resetPath(): void {
    if (!activePathId) return;
    const reset = createDefaultBezier();
    setBezierPath(reset);
    setAnchorScales(new Array(reset.numAnchorPoints).fill(1));
    setSelectedHandleIndex(0);
    setSelectedMidpointIndex(null);
    setPathVersion((v) => v + 1);
  }

  const pendingShotTimeRef = useRef<number | null>(null);

  function captureVirtualCamera(): void {
    setVirtualCameraCaptureRequest((request) => request + 1);
  }

  function addDemoVcam(
    bodyType: DemoVirtualCamera["bodyType"],
    namePrefix: string,
    snapshot: Omit<VirtualCameraSnapshot, "name" | "settings">,
    startTime?: number | null
  ): void {
    const id = `vcam-${Date.now()}-${virtualCameras.length + 1}`;
    const name = `${namePrefix} ${virtualCameras.length + 1}`;
    const shotStart =
      startTime ?? virtualCameras.reduce((end, vcam) => Math.max(end, vcam.shotEnd), 0);
    const editor: EditorVcam = { noisePreset: "off", composerSettings: DEFAULT_COMPOSER_SETTINGS };
    const def =
      bodyType === "cart"
        ? ({
            id,
            name,
            body: { type: "cart", cartId: defaultDollyId, positionOffset: { x: 0, y: 0, z: 0 } },
            ...(snapshot.lens && { lens: snapshot.lens })
          } as VirtualCameraDefinition)
        : bodyType === "orbit"
          ? ({
              id,
              name,
              body: {
                type: "orbit",
                target: registeredTargets[0]?.id
                  ? { targetId: registeredTargets[0].id }
                  : { x: 0, y: 0, z: 0 },
                azimuthDeg: ORBIT_DEFAULTS.orbitAzimuthDeg,
                elevationDeg: ORBIT_DEFAULTS.orbitElevationDeg,
                radius: ORBIT_DEFAULTS.orbitRadius,
                binding: ORBIT_DEFAULTS.orbitBinding
              },
              control: ORBIT_INTERACTIVE_CONTROL,
              ...(snapshot.lens && { lens: snapshot.lens })
            } as VirtualCameraDefinition)
          : ({
              id,
              name,
              body: { type: "static", position: snapshot.position, quaternion: snapshot.quaternion },
              ...(snapshot.lens && { lens: snapshot.lens })
            } as VirtualCameraDefinition);
    select("camera", id);
    setVcamDefs((current) => [...current, def]);
    setEditorVcams((current) => ({ ...current, [id]: editor }));
    setShotTiming((current) => ({
      ...current,
      [id]: { start: shotStart, end: shotStart + 5 }
    }));
  }

  function addCapturedVirtualCamera(snapshot: VirtualCameraSnapshot): void {
    addDemoVcam("static", "VCam", snapshot, pendingShotTimeRef.current);
    pendingShotTimeRef.current = null;
  }

  function addCartVirtualCamera(startTime?: number | null): void {
    // Guard: this is wired to button onClick in places, which passes the event.
    const start = typeof startTime === "number" ? startTime : null;
    addDemoVcam(
      "cart",
      "Cart VCam",
      {
        position: { x: 0, y: 0, z: 0 },
        quaternion: { x: 0, y: 0, z: 0, w: 1 },
        lens: { fov: 45 }
      },
      start
    );
  }

  function addOrbitVirtualCamera(startTime?: number | null): void {
    const start = typeof startTime === "number" ? startTime : null;
    addDemoVcam(
      "orbit",
      "Orbit VCam",
      {
        position: { x: 0, y: 0, z: 0 },
        quaternion: { x: 0, y: 0, z: 0, w: 1 },
        lens: { fov: 45 }
      },
      start
    );
  }

  function activateVirtualCamera(id: string): void {
    const camera = virtualCameras.find((item) => item.id === id);
    if (!camera) return;

    const durationSeconds = virtualCameraBlendCurve === "cut" ? 0 : virtualCameraBlendDuration;
    selectVirtualCamera(id);
    setVirtualCameraTransitionProgress(durationSeconds <= 0 ? 1 : 0);
    setVirtualCameraActivation({
      key: Date.now(),
      toId: id,
      durationSeconds,
      curve: virtualCameraBlendCurve
    });
  }

  // Routes a shot-panel patch onto the authoritative model: timing to the
  // shotTiming sidecar, noise preset to the editor sidecar (+ expanded onto the
  // definition), and aim/dutch/cart fields onto the definition itself.
  function updateVirtualCameraShot(id: string, patch: DemoShotPatch): void {
    if (patch.shotStart !== undefined || patch.shotEnd !== undefined) {
      setShotTiming((current) => {
        const prev = current[id] ?? DEFAULT_SHOT_TIMING;
        return {
          ...current,
          [id]: { start: patch.shotStart ?? prev.start, end: patch.shotEnd ?? prev.end }
        };
      });
    }
    if (patch.noisePreset !== undefined) {
      const preset = patch.noisePreset;
      setEditorVcams((current) => ({
        ...current,
        [id]: { ...(current[id] ?? DEFAULT_EDITOR_VCAM), noisePreset: preset }
      }));
    }
    // Every definition-shaped field (noise expansion, aim, dutch, cart) in one
    // pass over vcamDefs; the editor-sidecar write above stays separate.
    const orbitPatched =
      patch.orbitTargetId !== undefined ||
      patch.orbitAzimuthDeg !== undefined ||
      patch.orbitElevationDeg !== undefined ||
      patch.orbitRadius !== undefined ||
      patch.orbitBinding !== undefined ||
      patch.orbitAutoDegPerSec !== undefined;
    if (
      patch.noisePreset !== undefined ||
      patch.trackTargetId !== undefined ||
      patch.dutchDeg !== undefined ||
      patch.lens !== undefined ||
      patch.cartId !== undefined ||
      patch.cartOffset !== undefined ||
      patch.overrideControl !== undefined ||
      orbitPatched
    ) {
      setVcamDefs((current) =>
        current.map((def) => {
          if (def.id !== id) return def;
          const next: VirtualCameraDefinition = { ...def };
          if (patch.noisePreset !== undefined) {
            const noise = expandNoisePreset(patch.noisePreset);
            if (noise) next.noise = noise;
            else delete next.noise;
          }
          if (patch.trackTargetId !== undefined) {
            if (patch.trackTargetId) {
              next.aim = {
                type: "track",
                target: { targetId: patch.trackTargetId },
                settings: editorVcams[id]?.composerSettings ?? DEFAULT_COMPOSER_SETTINGS
              };
            } else {
              delete next.aim;
            }
          }
          if (patch.lens !== undefined || patch.dutchDeg !== undefined) {
            // Merge authored lens fields; null clears a field back to inherited
            // (absent), never zeroed. Dutch folds in with its own 0-clears sentinel.
            const lens = { ...next.lens };
            const updates: Partial<Record<keyof VirtualCameraLens, number | null | undefined>> = {
              ...patch.lens,
              ...(patch.dutchDeg !== undefined && { dutchDeg: patch.dutchDeg === 0 ? null : patch.dutchDeg })
            };
            for (const [key, value] of Object.entries(updates) as [keyof VirtualCameraLens, number | null | undefined][]) {
              if (value === undefined) continue;
              if (value === null) delete lens[key];
              else lens[key] = value;
            }
            if (Object.keys(lens).length > 0) next.lens = lens;
            else delete next.lens;
          }
          if (patch.cartId !== undefined && next.body.type === "cart") {
            next.body = { ...next.body, cartId: patch.cartId };
          }
          if (patch.cartOffset !== undefined && next.body.type === "cart") {
            next.body = { ...next.body, positionOffset: patch.cartOffset };
          }
          if (orbitPatched && next.body.type === "orbit") {
            const body = { ...next.body };
            if (patch.orbitTargetId !== undefined) {
              body.target = patch.orbitTargetId
                ? { targetId: patch.orbitTargetId }
                : { x: 0, y: 0, z: 0 };
            }
            if (patch.orbitAzimuthDeg !== undefined) body.azimuthDeg = patch.orbitAzimuthDeg;
            if (patch.orbitElevationDeg !== undefined) body.elevationDeg = patch.orbitElevationDeg;
            if (patch.orbitRadius !== undefined) body.radius = patch.orbitRadius;
            if (patch.orbitBinding !== undefined) body.binding = patch.orbitBinding;
            if (patch.orbitAutoDegPerSec !== undefined) {
              if (patch.orbitAutoDegPerSec === 0) delete body.autoOrbitDegPerSec;
              else body.autoOrbitDegPerSec = patch.orbitAutoDegPerSec;
            }
            next.body = body;
          }
          // Manual override lives at the definition level (any body). Attach it only
          // when an axis is pilotable, so all-locked shots keep the package fast-path.
          if (patch.overrideControl !== undefined) {
            if (hasActiveOverrideAxis(patch.overrideControl)) next.control = patch.overrideControl;
            else delete next.control;
          }
          return next;
        })
      );
    }
  }

  function updateVirtualCameraComposer(id: string, settings: ComposerSettings): void {
    setEditorVcams((current) => ({
      ...current,
      [id]: { ...(current[id] ?? DEFAULT_EDITOR_VCAM), composerSettings: settings }
    }));
    setVcamDefs((current) =>
      current.map((def) =>
        def.id === id && def.aim?.type === "track"
          ? { ...def, aim: { ...def.aim, settings } }
          : def
      )
    );
  }

  function deleteVirtualCamera(id: string): void {
    setVcamDefs((current) => current.filter((def) => def.id !== id));
    setEditorVcams((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setShotTiming((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setFovAnimation(id, null);
    if (isSelected(selection, "camera", id)) {
      setSelection(null);
    }
    if (virtualCameraActivation?.toId === id) {
      releaseVirtualCamera();
    }
  }

  function releaseVirtualCamera(): void {
    setVirtualCameraActivation(null);
    setVirtualCameraTransitionProgress(1);
  }

  function selectVirtualCamera(id: string | null): void {
    select("camera", id);
  }

  function updateVirtualCameraSnapshot(id: string, snapshot: VirtualCameraSnapshot): void {
    setVcamDefs((current) =>
      current.map((def) => {
        if (def.id !== id || def.body.type !== "static") return def;
        const next: VirtualCameraDefinition = {
          ...def,
          body: { type: "static", position: snapshot.position, quaternion: snapshot.quaternion }
        };
        if (snapshot.lens && Object.keys(snapshot.lens).length > 0) next.lens = { ...snapshot.lens };
        else delete next.lens;
        return next;
      })
    );
    if (virtualCameraActivation?.toId === id) {
      releaseVirtualCamera();
    }
  }

  // Activation + audio + animation tracks as timeline lanes (alongside shot/dolly
  // lanes). Lane id encodes the kind (act:/aud:/anim:) + track id; clip create/move
  // routes back into extraTracks. Delete stays in the side-panel editors, like dolly moves.
  const newClipId = (): string => `clip-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  // Hierarchy "add audio track" affordance; the clip/gain/mute edits live in the
  // Audio inspector, so a fresh track starts empty and selects itself.
  function addAudioTrack(): void {
    const id = `aud-${Date.now().toString(36)}`;
    setExtraTracks((prev) => ({
      ...prev,
      audioTracks: [...prev.audioTracks, { type: "audio", id, name: `Audio ${prev.audioTracks.length + 1}`, clips: [], gain: 1 }]
    }));
    select("audio", id);
  }
  // Padding (s) so a short/zero-span or keyless transform track still shows a
  // visible, grabbable block rather than an invisible far-left sliver.
  const TRANSFORM_MIN_WIDTH = 2;
  const sceneNameOf = (sceneId: string): string =>
    sceneContents.find((content) => content.id === sceneId)?.name ?? sceneId;
  const extraLanes = [
    // Scene embeds: other scenes played inside this scene's time windows. Shown
    // once the story has scenes to embed; click creates a clip (cycling through
    // the other scenes), drag/resize adjusts the window.
    ...(sceneContents.length > 1 || sceneClips.length > 0
      ? [{
          id: "scn:embeds",
          name: "Scenes",
          color: "rgba(249, 115, 22, 0.6)",
          icon: <IconVideo size={14} />,
          clips: sceneClips.map((clip) => ({
            id: clip.id,
            start: clip.start,
            end: clip.end,
            label: sceneNameOf(clip.sceneId)
          }))
        }]
      : []),
    ...extraTracks.activationTracks.map((track) => ({
      id: `act:${track.id}`,
      name: activatables.find((a) => a.id === track.objectId)?.name ?? track.objectId ?? "Activation",
      color: "rgba(56, 189, 248, 0.6)",
      icon: <IconEye size={14} />,
      clips: track.clips.map((c) => ({ id: c.id, start: c.start, end: c.end }))
    })),
    ...extraTracks.audioTracks.map((track) => ({
      id: `aud:${track.id}`,
      name: track.name ?? "Audio",
      color: "rgba(167, 139, 250, 0.6)",
      icon: <IconVolume size={14} />,
      crossfade: true,
      clips: track.clips.map((c) => {
        const peaks = clipPeaks(c.src, c.offset ?? 0, c.duration, () => setPeaksTick((t) => t + 1));
        // Waveform (envelope) with the volume envelope (line) drawn over it, DAW-style.
        const series = [
          ...(peaks ? [{ kind: "envelope" as const, points: peaks }] : []),
          ...(c.gainCurve ? [{ kind: "line" as const, points: gainLinePoints(c.gainCurve), color: "rgba(56,189,248,0.95)" }] : [])
        ];
        return {
          id: c.id,
          start: c.start,
          end: c.start + c.duration,
          label: c.src,
          ...(series.length > 0 && { series })
        };
      })
    })),
    ...extraTracks.animationTracks.map((track) => ({
      id: `anim:${track.id}`,
      name: activatables.find((a) => a.id === track.objectId)?.name ?? track.objectId ?? "Animation",
      color: "rgba(52, 211, 153, 0.6)",
      icon: <IconVideo size={14} />,
      crossfade: true,
      clips: track.clips.map((c) => ({ id: c.id, start: c.start, end: c.end, label: c.clipName }))
    })),
    ...extraTracks.transformTracks.map((track) => {
      const label = [track.position && "P", track.rotation && "R", track.scale && "S"].filter(Boolean).join("/");
      const block = transformBlock(track, TRANSFORM_MIN_WIDTH);
      return {
        id: `xf:${track.id}`,
        name: activatables.find((a) => a.id === track.objectId)?.name ?? track.objectId ?? "Motion",
        color: "rgba(251, 191, 36, 0.6)",
        icon: <IconTrack size={14} />,
        // One block per track: a faint value line per channel plus a diamond marker per
        // key. Short/zero-span tracks are padded to TRANSFORM_MIN_WIDTH so they stay
        // visible and grabbable; drag the body to shift all keys. A keyless track draws
        // a faint placeholder block so the lane reads as an empty, clickable target.
        clips: block
          ? [{ id: track.id, start: block.start, end: block.end, ...(label && { label }), series: block.series }]
          : [{ id: track.id, start: 0, end: TRANSFORM_MIN_WIDTH, label: "no keys — ◆ key pose", series: [{ kind: "markers" as const, points: [0], color: "rgba(255,255,255,0.28)" }] }]
      };
    })
  ];
  // Lane ids are `<kind>:<trackId>`; the track id is everything after the first colon
  // (avoids per-kind slice-length magic numbers that must be hand-kept in sync).
  const laneTrackId = (laneId: string): string => laneId.slice(laneId.indexOf(":") + 1);
  // Timeline lane ↔ selection sync. Clicking an activation lane selects its bound
  // object; an audio lane selects its track. The reverse drives the lane highlight.
  const selectLaneEntity = (laneId: string): void => {
    if (laneId.startsWith("act:")) {
      const track = extraTracks.activationTracks.find((t) => t.id === laneTrackId(laneId));
      if (track?.objectId) select("object", track.objectId);
    } else if (laneId.startsWith("aud:")) {
      select("audio", laneTrackId(laneId));
    } else if (laneId.startsWith("anim:")) {
      const track = extraTracks.animationTracks.find((t) => t.id === laneTrackId(laneId));
      if (track?.objectId) select("object", track.objectId);
    } else if (laneId.startsWith("xf:")) {
      const track = extraTracks.transformTracks.find((t) => t.id === laneTrackId(laneId));
      if (track?.objectId) select("object", track.objectId);
    }
  };
  const selectedLaneId =
    selection?.kind === "audio"
      ? `aud:${selection.id}`
      : selection?.kind === "object"
        ? (() => {
            const act = extraTracks.activationTracks.find((t) => t.objectId === selection.id);
            if (act) return `act:${act.id}`;
            const anim = extraTracks.animationTracks.find((t) => t.objectId === selection.id);
            if (anim) return `anim:${anim.id}`;
            const xf = extraTracks.transformTracks.find((t) => t.objectId === selection.id);
            return xf ? `xf:${xf.id}` : null;
          })()
        : null;
  const setExtraClip = (laneId: string, clipId: string, start: number, end: number): void => {
    if (laneId.startsWith("scn:")) {
      setSceneClips((prev) => prev.map((clip) => (clip.id === clipId ? { ...clip, start, end } : clip)));
    } else if (laneId.startsWith("act:")) {
      const trackId = laneTrackId(laneId);
      setExtraTracks((prev) => ({
        ...prev,
        activationTracks: prev.activationTracks.map((t) =>
          t.id === trackId ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, start, end } : c)) } : t
        )
      }));
    } else if (laneId.startsWith("aud:")) {
      const trackId = laneTrackId(laneId);
      setExtraTracks((prev) => ({
        ...prev,
        audioTracks: prev.audioTracks.map((t) =>
          t.id === trackId ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? resizeAudioClip(c, start, end) : c)) } : t
        )
      }));
    } else if (laneId.startsWith("anim:")) {
      const trackId = laneTrackId(laneId);
      setExtraTracks((prev) => ({
        ...prev,
        animationTracks: prev.animationTracks.map((t) =>
          t.id === trackId ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, start, end } : c)) } : t
        )
      }));
    } else if (laneId.startsWith("xf:")) {
      // One block per track; dragging the body shifts every key (across channels) by
      // the same delta, preserving spacing. clipId is the track id; resize (end change
      // with start fixed) yields a zero delta, so it's inert. Keys never go below 0.
      const trackId = laneTrackId(laneId);
      setExtraTracks((prev) => ({
        ...prev,
        transformTracks: prev.transformTracks.map((t) => {
          if (t.id !== trackId) return t;
          const times = transformKeyTimes(t);
          if (!times.length) return t;
          const delta = Math.max(snapSeconds(start) - Math.min(...times), -Math.min(...times));
          if (Math.abs(delta) < 1e-6) return t;
          const shift = (keys?: TransformKey[]) => keys?.map((k) => ({ ...k, time: k.time + delta }));
          return {
            ...t,
            ...(t.position && { position: shift(t.position)! }),
            ...(t.rotation && { rotation: shift(t.rotation)! }),
            ...(t.scale && { scale: shift(t.scale)! })
          };
        })
      }));
    }
  };
  const addExtraClip = (laneId: string, time: number): void => {
    const start = Math.max(0, Math.round(time * 4) / 4);
    if (laneId.startsWith("scn:")) {
      // Cycle through the OTHER scenes; the window defaults to the target's
      // duration (min 1s) so a fresh embed plays the whole scene.
      const others = sceneContents.filter((content) => content.id !== activeSceneId);
      const target = others[sceneClips.length % Math.max(1, others.length)];
      if (!target) return;
      const length = Math.max(1, storyScenes.get(target.id)?.duration ?? 5);
      setSceneClips((prev) => [
        ...prev,
        { id: newClipId(), sceneId: target.id, start, end: start + length }
      ].sort((a, b) => a.start - b.start));
      return;
    }
    if (laneId.startsWith("act:")) {
      const trackId = laneTrackId(laneId);
      setExtraTracks((prev) => ({
        ...prev,
        activationTracks: prev.activationTracks.map((t) =>
          t.id === trackId ? { ...t, clips: [...t.clips, { id: newClipId(), start, end: start + 2 }] } : t
        )
      }));
    } else if (laneId.startsWith("aud:")) {
      const trackId = laneTrackId(laneId);
      setExtraTracks((prev) => ({
        ...prev,
        audioTracks: prev.audioTracks.map((t) =>
          t.id === trackId
            ? { ...t, clips: [...t.clips, { id: newClipId(), src: SAMPLE_AUDIO[t.clips.length % SAMPLE_AUDIO.length]!, start, duration: 4, gain: 1 }] }
            : t
        )
      }));
    } else if (laneId.startsWith("anim:")) {
      const trackId = laneTrackId(laneId);
      setExtraTracks((prev) => ({
        ...prev,
        animationTracks: prev.animationTracks.map((t) => {
          if (t.id !== trackId) return t;
          const names = activatables.find((a) => a.id === t.objectId)?.clips ?? [];
          return { ...t, clips: [...t.clips, { id: newClipId(), clipName: names[0] ?? "", start, end: start + 2 }] };
        })
      }));
    } else if (laneId.startsWith("xf:")) {
      // Click inserts a keyframe (holding the current value) into each existing channel;
      // a channel-less track seeds a position key AT THE OBJECT'S CURRENT POSITION (not
      // the origin) so playback doesn't snap it to world zero.
      const trackId = laneTrackId(laneId);
      setExtraTracks((prev) => ({
        ...prev,
        transformTracks: prev.transformTracks.map((t) => {
          if (t.id !== trackId) return t;
          const pose = readObjectPose(t.objectId);
          if (!t.position && !t.rotation && !t.scale) return { ...t, position: [{ time: start, value: pose?.position ?? [0, 0, 0] }] };
          return {
            ...t,
            ...(t.position && { position: insertTransformKey(t.position, start, pose?.position ?? [0, 0, 0]) }),
            ...(t.rotation && { rotation: insertTransformKey(t.rotation, start, pose?.rotation ?? [0, 0, 0]) }),
            ...(t.scale && { scale: insertTransformKey(t.scale, start, pose?.scale ?? [1, 1, 1]) })
          };
        })
      }));
    }
  };

  // Inspector prop groups — resolve the selected entity per kind (null when absent)
  // and its display name for the panel header. selectedVirtualCamera is derived above.
  const selectedDolly = dollies.find((dolly) => dolly.id === selectedIdOf(selection, "dolly")) ?? null;
  const selectedTargetEntity = pointTargets.find((target) => target.id === selectedPointTargetId) ?? null;
  const selectedPathDef = paths.find((path) => path.id === selectedIdOf(selection, "path")) ?? null;
  const selectedObject = activatables.find((object) => object.id === selectedIdOf(selection, "object")) ?? null;
  const selectedAudioTrack = extraTracks.audioTracks.find((track) => track.id === selectedIdOf(selection, "audio")) ?? null;
  const selectedTrigger = interactions.triggers.find((trigger) => trigger.id === selectedIdOf(selection, "trigger")) ?? null;
  const selectedTriggerBinding = selectedTrigger
    ? interactions.bindings.find((binding) => binding.triggerId === selectedTrigger.id) ?? null
    : null;
  const selectedTriggerAction = selectedTriggerBinding
    ? interactions.actions.find((action) => action.id === selectedTriggerBinding.actionId) ?? null
    : null;
  const selectionName: string | null = !selection
    ? null
    : {
        scene: "Scene",
        path: selectedPathDef?.name,
        dolly: selectedDolly?.name,
        camera: selectedVirtualCamera?.name,
        target: selectedTargetEntity?.name,
        object: selectedObject?.name,
        audio: selectedAudioTrack?.name,
        trigger: selectedTrigger?.name
      }[selection.kind] ?? null;

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <style>{panelGlobalCss}</style>

      <div style={{ position: "fixed", top: 12, left: 12, zIndex: 10 }}>
        <Hierarchy
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          selection={selection}
          onSelect={selectFromHierarchy}
          scenes={sceneContents.map((content) => ({ id: content.id, name: content.name ?? content.id }))}
          activeSceneId={activeSceneId}
          entrySceneId={entrySceneId}
          liveSceneId={liveSceneId}
          onSelectScene={switchScene}
          onAddScene={addScene}
          onPlayScene={requestPlayScene}
          onStopScene={requestStopScene}
          triggers={interactions.triggers.map((trigger) => ({ id: trigger.id, name: trigger.name ?? trigger.id }))}
          onAddTrigger={addTrigger}
          paths={paths.map((path) => ({ id: path.id, name: path.name ?? path.id }))}
          dollies={dollies.map((dolly) => ({ id: dolly.id, name: dolly.name ?? dolly.id }))}
          cameras={virtualCameras.map((camera) => ({
            id: camera.id,
            name: camera.name,
            live: camera.id === (virtualCameraActivation?.toId ?? null)
          }))}
          targets={pointTargets.map((target) => ({ id: target.id, name: target.name ?? target.id }))}
          objects={activatables}
          audioTracks={extraTracks.audioTracks.map((track) => ({ id: track.id, name: track.name ?? "Audio" }))}
          activePathId={activePathId}
          onAddPath={addPath}
          onAddDolly={addDolly}
          onCaptureCamera={captureVirtualCamera}
          onAddCartCamera={() => addCartVirtualCamera()}
          onAddOrbitCamera={() => addOrbitVirtualCamera()}
          onAddTarget={addPointTarget}
          onAddAudioTrack={addAudioTrack}
          onNewScene={newScene}
          onImport={() => importInputRef.current?.click()}
          onExport={exportScene}
        />
        <input
          ref={importInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) importSceneFile(file);
            event.currentTarget.value = "";
          }}
        />
      </div>

      <div
        style={{
          position: "fixed",
          top: 12,
          right: 12,
          zIndex: 11,
          width: 360,
          maxHeight: debugPreview ? "calc(100vh - 260px)" : "calc(100vh - 24px)",
          overflowY: "auto",
          display: "grid",
          gap: 10,
          fontFamily: "ui-sans-serif, system-ui, sans-serif"
        }}
      >
        <Inspector
          selection={selection}
          selectionName={selectionName}
          scene={{
            viewMode,
            onViewModeChange: setViewMode,
            debugPreview,
            onDebugPreviewChange: setDebugPreview,
            debugFrustum,
            onDebugFrustumChange: setDebugFrustum,
            pathStyle,
            onPathStyleChange: setPathStyle,
            blendCurve: virtualCameraBlendCurve,
            onBlendCurveChange: setVirtualCameraBlendCurve,
            blendDuration: virtualCameraBlendDuration,
            onBlendDurationChange: setVirtualCameraBlendDuration,
            transitionProgress: virtualCameraTransitionProgress,
            liveCameraName: virtualCameraActivation
              ? virtualCameras.find((camera) => camera.id === virtualCameraActivation.toId)?.name ?? "Camera"
              : null,
            onRelease: releaseVirtualCamera,
            embeds: sceneClips.map((clip) => ({
              id: clip.id,
              sceneName: sceneNameOf(clip.sceneId),
              start: clip.start,
              end: clip.end
            })),
            onDeleteEmbed: (clipId) => setSceneClips((prev) => prev.filter((clip) => clip.id !== clipId))
          }}
          path={
            selectedPathDef
              ? {
                  name: selectedPathDef.name ?? selectedPathDef.id,
                  onRename: (name) => renamePath(selectedPathDef.id, name),
                  onDelete: () => deletePath(selectedPathDef.id),
                  bezierPath: selectedPathDef.id === activePathId ? bezierPath : null,
                  useWorldSpaceGizmo,
                  onWorldSpaceGizmoChange: setUseWorldSpaceGizmo,
                  selectedAnchorScale: selectedAnchorScaleForUi,
                  onAddAnchor: addAnchor,
                  onInsertMidpoint: insertAnchorAtSelectedSegment,
                  onDeleteAnchor: deleteSelectedAnchor,
                  onAutoSmooth: () => mutatePath((p) => { p.autoSmooth(); }),
                  onToggleClosed: () => mutatePath((p) => p.setClosed(!p.isClosed)),
                  onReset: resetPath,
                  onSave: savePath,
                  onLoad: loadPath,
                  onControlModeChange: (mode) => mutatePath((p) => p.setControlMode(mode))
                }
              : null
          }
          dolly={
            selectedDolly
              ? {
                  dolly: selectedDolly,
                  paths,
                  runs: dollyRuns[selectedDolly.id] ?? [],
                  onUpdate: (patch) => updateDolly(selectedDolly.id, patch),
                  onDelete: () => deleteDolly(selectedDolly.id),
                  onUpdateRun: (runId, patch) => updateDollyRun(selectedDolly.id, runId, patch),
                  onAddRun: () => addDollyRun(selectedDolly.id, 0),
                  onDeleteRun: (runId) => deleteDollyRun(selectedDolly.id, runId)
                }
              : null
          }
          camera={
            selectedVirtualCamera
              ? {
                  camera: selectedVirtualCamera,
                  isActive: selectedVirtualCamera.id === (virtualCameraActivation?.toId ?? null),
                  trackTargets: registeredTargets,
                  dollies,
                  onActivate: () => activateVirtualCamera(selectedVirtualCamera.id),
                  onDelete: () => deleteVirtualCamera(selectedVirtualCamera.id),
                  onUpdateShot: (patch) => updateVirtualCameraShot(selectedVirtualCamera.id, patch),
                  onUpdateComposer: (settings) => updateVirtualCameraComposer(selectedVirtualCamera.id, settings),
                  fovAnimation: fovAnimations[selectedVirtualCamera.id] ?? null,
                  onFovAnimationChange: (anim) => setFovAnimation(selectedVirtualCamera.id, anim)
                }
              : null
          }
          target={
            selectedTargetEntity
              ? {
                  target: selectedTargetEntity,
                  dollies,
                  onRename: (name) => renamePointTarget(selectedTargetEntity.id, name),
                  onSetMount: (cartId) => setPointTargetMount(selectedTargetEntity.id, cartId),
                  onToggleVisible: () => togglePointTargetVisible(selectedTargetEntity.id),
                  onDelete: () => deletePointTarget(selectedTargetEntity.id)
                }
              : null
          }
          object={
            selectedObject
              ? { objectId: selectedObject.id, objectName: selectedObject.name, extraTracks, activatables, getPlayhead: () => timelinePlayerRef.current.time, readObjectPose, onChange: (next) => setExtraTracks((prev) => ({ ...prev, ...next })) }
              : null
          }
          audio={
            selectedAudioTrack
              ? {
                  track: selectedAudioTrack,
                  extraTracks,
                  onChange: (next) => setExtraTracks((prev) => ({ ...prev, ...next })),
                  onPreviewClip: (clip, trackGain) => void audioPlayer.previewClip(clip, trackGain),
                  peaksFor: (clip) => clipPeaks(clip.src, clip.offset ?? 0, clip.duration, () => setPeaksTick((t) => t + 1))
                }
              : null
          }
          trigger={
            selectedTrigger
              ? {
                  trigger: selectedTrigger,
                  action: selectedTriggerAction,
                  priority: selectedTriggerBinding?.priority ?? 0,
                  entities: [
                    ...activatables.map((object) => ({ id: object.id, name: object.name })),
                    ...pointTargets.map((target) => ({ id: target.id, name: target.name ?? target.id }))
                  ],
                  scenes: sceneContents.map((content) => ({ id: content.id, name: content.name ?? content.id })),
                  onUpdateTrigger: (patch) => updateTrigger(selectedTrigger.id, patch),
                  onUpdateAction: (action) => updateTriggerAction(selectedTrigger.id, action),
                  onSetPriority: (priority) => setTriggerPriority(selectedTrigger.id, priority),
                  onSimulate: () => simulateTrigger(selectedTrigger.id),
                  onDelete: () => deleteTrigger(selectedTrigger.id)
                }
              : null
          }
        />
      </div>
      <div
        className="pc-controls"
        style={{
          position: "fixed",
          bottom: 12,
          left: 404,
          right: 404,
          zIndex: 9
        }}
      >
        <TimelineLanes
          theme={{ panelBackground: BG, panelBorder: BORDER, text: TEXT, mutedText: MUTED, subtleText: FAINT, fontFamily: SANS }}
          shotIcon={<IconVideo size={15} />}
          dollyIcon={<IconTrack size={15} />}
          extraLanes={extraLanes}
          onExtraClipTiming={setExtraClip}
          onCreateExtraClip={addExtraClip}
          shots={virtualCameras
            // Only vcams participating in the ACTIVE scene (they have a timing
            // entry here); the vcam pool itself is story-shared.
            .filter((vcam) => shotTiming[vcam.id])
            .map((vcam) => ({
              id: vcam.id,
              name: vcam.name,
              start: vcam.shotStart,
              end: vcam.shotEnd
            }))}
          dollies={dollies.map((dolly) => ({ id: dolly.id, name: dolly.name ?? dolly.id }))}
          dollyMoves={Object.entries(dollyRuns).flatMap(([cartId, runs]) =>
            runs.map((run) => ({
              shotId: run.id,
              dollyId: cartId,
              dollyName: dollies.find((dolly) => dolly.id === cartId)?.name ?? cartId,
              start: run.start,
              end: run.end,
              label: `${run.fromT.toFixed(1)} → ${run.toT.toFixed(1)}`,
              // Speed profile only when the move actually travels; reflects the run's easing.
              ...(run.fromT !== run.toT && { series: speedSeriesFor(run.easing ?? DEFAULT_DOLLY_EASING) })
            }))
          )}
          selectedShotId={selectedVirtualCameraId}
          selectedLaneId={selectedLaneId}
          onSelectLane={selectLaneEntity}
          playerRef={timelinePlayerRef}
          duration={demoTimeline?.duration ?? 0}
          driving={timelineActive}
          onShotTiming={(vcamId, shotStart, shotEnd) =>
            updateVirtualCameraShot(vcamId, { shotStart, shotEnd })
          }
          onDollyRunTiming={(cartId, runId, start, end) =>
            updateDollyRun(cartId, runId, { start, end })
          }
          onCreateDollyRun={(cartId, time) => addDollyRun(cartId, Math.max(0, Math.round(time * 4) / 4))}
          onSelectShot={selectVirtualCamera}
          onSeek={(time) => {
            // Grabbing the playhead takes control back: stop any live scene branch.
            if (liveSceneRef.current) requestStopScene();
            seekTimelinePlayer(timelinePlayerRef.current, time);
            setPipDriver("timeline");
          }}
          onTransport={() => {
            if (liveSceneRef.current) requestStopScene();
            setPipDriver("timeline");
          }}
          onCreateShot={(kind, time) => {
            const snapped = Math.max(0, Math.round(time * 4) / 4);
            if (kind === "cart") {
              addCartVirtualCamera(snapped);
            } else {
              pendingShotTimeRef.current = snapped;
              captureVirtualCamera();
            }
          }}
          onCreateDolly={addDolly}
          onCreatePath={addPath}
        />
      </div>
      {debugPreview ? (
        <DollyPreviewChrome
          label={pipLabel}
          hasSource={hasPipSource}
          composerActive={composerChromeActive}
          composerSettings={composerChromeSettings}
          targetMarkerRef={dollyTargetMarkerRef}
          targetLineRef={dollyTargetLineRef}
          lookaheadMarkerRef={lookaheadMarkerRef}
          lookaheadLineRef={lookaheadLineRef}
        />
      ) : null}
      {showPlayInput ? <CameraOverrideSurface accumulator={overrideAcc} /> : null}

      <Canvas style={{ width: "100%", height: "100%" }} camera={{ position: [0, 0, 6], fov: 45 }}>
        <color attach="background" args={["#f8fafc"]} />
        <OrbitControls
          makeDefault
          enabled={!isTransforming && (!playMode || !hasPipSource)}
          enableDamping
          dampingFactor={0.08}
          mouseButtons={{ MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE }}
        />
        <ActivatablesProvider registry={activatablesRegistry}>
        <DemoSceneViewport
          bezierPath={bezierPath}
          vertexPath={vertexPath}
          targetRegistry={targetRegistry}
          overrideAcc={overrideAcc}
          dollyFramesRef={dollyFramesRef}
          dollies={dollies}
          vertexPaths={vertexPaths}
          activeTimeline={timelineActive ? demoTimeline : null}
          timelinePlayerRef={timelinePlayerRef}
          storyScenes={storyScenes}
          activeEditingSceneId={activeSceneId}
          playSceneRequest={playSceneRequest}
          stopSceneRequest={stopSceneRequest}
          onActiveSceneChange={onActiveSceneChange}
          interactions={interactions}
          simulateTriggerRequest={simulateTriggerRequest}
          onTransportTrigger={handleTransportTrigger}
          activationTracks={extraTracks.activationTracks}
          audioTracks={extraTracks.audioTracks}
          animationTracks={extraTracks.animationTracks}
          transformTracks={extraTracks.transformTracks}
          audioPlayer={audioPlayer}
          selection={selection}
          onSelectEntity={select}
          pathVersion={pathVersion}
          debugPreview={debugPreview}
          playMode={playMode}
          debugFrustum={debugFrustum}
          pathStyle={pathStyle}
          selectedHandleIndex={selectedHandleIndex}
          selectedMidpointIndex={selectedMidpointIndex}
          anchorScales={anchorScales}
          useWorldSpaceGizmo={useWorldSpaceGizmo}
          isTransforming={isTransforming}
          onSelectHandle={(idx) => {
            setSelectedHandleIndex(idx);
            if (idx !== null) {
              setSelectedMidpointIndex(null);
              if (activePathId) setSelection({ kind: "path", id: activePathId });
            }
          }}
          onSelectMidpoint={(idx) => {
            setSelectedMidpointIndex(idx);
            if (idx !== null) {
              setSelectedHandleIndex(null);
              if (activePathId) setSelection({ kind: "path", id: activePathId });
            }
          }}
          onTransformingChange={setIsTransforming}
          onRotateMidpointNormal={rotateMidpointNormal}
          dollyTargetMarkerRef={dollyTargetMarkerRef}
          dollyTargetLineRef={dollyTargetLineRef}
          lookaheadMarkerRef={lookaheadMarkerRef}
          lookaheadLineRef={lookaheadLineRef}
          virtualCameraCaptureRequest={virtualCameraCaptureRequest}
          virtualCameraActivation={virtualCameraActivation}
          virtualCameras={virtualCameras}
          vcamDefs={vcamDefs}
          selectedVirtualCameraId={selectedVirtualCameraId}
          onVirtualCameraCaptured={addCapturedVirtualCamera}
          onActiveVcamChange={setActiveDrivenVcamId}
          onVirtualCameraResolved={({ progress }) => {
            setVirtualCameraTransitionProgress(progress);
          }}
          onSelectVirtualCamera={selectVirtualCamera}
          onUpdateVirtualCameraSnapshot={updateVirtualCameraSnapshot}
          onUpdateCartOffset={(id, cartOffset) => updateVirtualCameraShot(id, { cartOffset })}
          onUpdateOrbitParams={(id, params) =>
            updateVirtualCameraShot(id, {
              orbitAzimuthDeg: params.azimuthDeg,
              orbitElevationDeg: params.elevationDeg,
              orbitRadius: params.radius
            })
          }
          onSetAnchorScale={(anchorIndex, scale) => {
            if (!bezierPath) return;
            setAnchorScales((prev) => {
              const next = normalizeAnchorScales(bezierPath.numAnchorPoints, prev);
              if (anchorIndex >= 0 && anchorIndex < next.length) next[anchorIndex] = scale;
              return next;
            });
          }}
          onMovePoint={(index, point) => {
            mutatePath((path) => path.movePoint(index, point));
          }}
        />
        <PointTargets
          targets={pointTargets}
          registry={targetRegistry}
          framesRef={dollyFramesRef}
          selectedId={selectedPointTargetId}
          onSelect={selectPointTarget}
          onMove={movePointTarget}
          onTransformingChange={setIsTransforming}
        />
        </ActivatablesProvider>
      </Canvas>
    </div>
  );
}
