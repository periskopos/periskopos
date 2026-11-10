import { pictureSize, watchWorldPerf } from "../perf.ts";
import * as THREE from "three";
import { planKey, valleyPlan } from "../../../../../shared/valley/plan.ts";
import type { ValleyPlan } from "../../../../../shared/valley/plan.ts";
import type { Trip } from "../../../../../shared/valley/trips.ts";
import { campusSize, carsFor, duskAt, newPace, paceAfter } from "../../../../../shared/world.ts";
import type { AntennaLight, Plot, Utility, World } from "../../../../../shared/world.ts";
import { createAnnouncer } from "./announce.ts";
import { createAtmosphere } from "./atmosphere.ts";
import { createBuildings } from "./buildings.ts";
import { growDelay, NO_GROWTH } from "../../../../../shared/valley/growth.ts";
import type { Growth } from "../../../../../shared/valley/growth.ts";
import { createDish } from "./dish.ts";
import { createGrowth } from "./growth.ts";
import type { Dish } from "./dish.ts";
import { createEffects } from "./effects.ts";
import { createKit } from "./kit.ts";
import type { Animate, Disposable, Env, Status } from "./kit.ts";
import { createLamps } from "./lamps.ts";
import type { Lamp } from "./lamps.ts";
import { createLand } from "./land.ts";
import { createLinks } from "./links.ts";
import { createPlaces } from "./places.ts";
import { createPointer } from "./pointer.ts";
import { createRig, FOV } from "./rig.ts";
import { createSigns } from "./signs.ts";
import type { SceneOptions, Selection, Sky, Standing, WorldScene } from "./types.ts";
import { createVehicles } from "./vehicles.ts";

export type { Selection, Sky, WorldScene } from "./types.ts";

// The World view's picture: your own valley. It decides nothing about what's true: it
// draws the World it's given (see shared/world.ts), and the only things that move are
// things that data says are happening. This file only wires the parts together. Loaded on
// its own, only when the World page is opened.

// Periskopos stays open all day, so the picture is frugal: smooth while it's being moved,
// calm while it's being looked at, barely ticking while another window has the focus,
// and stopped when it can't be seen.
const FRAME_MS = 1000 / 30;
const IDLE_MS = 1000 / 20; // nobody's touched it for a while
const IDLE_AFTER_MS = 15_000;
const MOVING_MS = 1000 / 120; // following a drag or a zoom: every refresh, up to here
const STEADY_MS = 1000 / 60; // what a frame is judged against, on any screen
const UNFOCUSED_MS = 1000 / 6;
const STILL_T = 20_000; // the moment a still picture shows
const FOCUS_ZOOM = 1.8;

// What each level of detail draws: the most picture pixels to a screen pixel.
const DETAIL = [{ pixels: 2 }, { pixels: 1.5 }, { pixels: 1 }, { pixels: 0.75 }] as const;

export function createWorldScene(host: HTMLElement, options: SceneOptions): WorldScene | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "low-power" });
  } catch {
    return null; // no WebGL here: the page says so, and its list of apps still works
  }
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false; // shadows are redrawn when something built changes, not every frame
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.className = "world-gl";
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);

  const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  const themeQuery = matchMedia("(prefers-color-scheme: dark)");
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 2, 1100);

  const tokens = (): Status => {
    const css = getComputedStyle(document.documentElement);
    const token = (n: string) => new THREE.Color(css.getPropertyValue(`--color-${n}`).trim() || "#888888");
    return { down: token("world-down"), attention: token("world-attention"), info: token("world-info"), up: token("world-up"), unknown: token("world-unknown"), focus: token("border-focus") };
  };
  let skyMode: Sky = options.sky;
  const duskNow = () => (skyMode === "theme" ? themeQuery.matches : duskAt(new Date().getHours()));
  const env: Env = { dusk: duskNow(), status: tokens(), camDir: new THREE.Vector3(1, 1, 1).normalize(), inFront: new THREE.Vector3(), stopped: false, redraw };

  const kit = createKit();
  const atmosphere = createAtmosphere(scene, renderer);
  const land = createLand(kit);
  const dishes = createDish(kit);
  const effects = createEffects(kit, env);
  const places = createPlaces(kit, env, createBuildings(kit, env), effects, createSigns(kit, env));
  const vehicles = createVehicles(kit, env, scene);
  const links = createLinks(kit, env);
  const lamps = createLamps(kit, env);
  const announcer = createAnnouncer(scene, env);
  const rig = createRig({ camera, env, reservedRight: options.reservedRight, redraw });

  const growth = createGrowth({
    standing: (id) => built.get(id)?.group,
    redrawShadows: () => atmosphere.redrawShadows(),
    finished() {
      relight();
      rebuildOverlays();
    },
  });

  const landGroup = new THREE.Group();
  const things = new THREE.Group();
  scene.add(landGroup, things, links.group, lamps.group);

  const selectionRing = (() => {
    const geometry = kit.keep(new THREE.RingGeometry(0.94, 1, 64));
    geometry.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(geometry, kit.keep(new THREE.MeshBasicMaterial({ color: env.status.focus, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false })));
    ring.visible = false;
    scene.add(ring);
    return ring;
  })();

  // ── What's standing, kept in step with the World ──────────────────────

  type Placed = { group: THREE.Group; animate: Animate[]; owned: Set<Disposable>; key: string; look: string };
  const built = new Map<string, Placed>();
  let world: World = { plots: [], utilities: [], watcher: { x: 0, y: 0, turn: 0 }, watching: false, stopped: false, failed: false };
  let plan: ValleyPlan = valleyPlan(world);
  let landKey = "";
  let landOwned = new Set<Disposable>();
  let dish: Dish | null = null;
  let selected: Selection = null;
  let announcing = true;
  let firstSync = true;
  let grown: Growth = NO_GROWTH;

  // The dirty flags: each of these says what its part was last built from.
  // The signs' screens are tinted in the theme's status colours: a new theme rebuilds them.
  const palette = () => (["up", "attention", "down", "info"] as const).map((tone) => env.status[tone].getHexString()).join(",");
  const plotKey = (p: Plot) => `${p.look}|${p.floors}|${p.work}|${p.x},${p.y}|${env.dusk}|${p.icon ?? ""}|${p.name}|${campusSize(p)}|${carsFor(p)}|${palette()}`;
  const utilityKey = (u: Utility) => `${u.look}|${u.x},${u.y}|${env.dusk}|${palette()}`;

  function buildLand() {
    kit.free(landOwned);
    landGroup.clear();
    const { owned } = kit.scope(() => {
      landGroup.add(land.ground(plan), land.hill(plan), land.roads(plan));
      dish = dishes.build(plan);
      landGroup.add(dish.group);
    });
    landOwned = owned;
    applyDetail();
    atmosphere.frameShadows(plan);
  }

  function sync() {
    plan = valleyPlan(world);
    rig.setPlace(plan, world);
    const nextLand = planKey(plan);
    const landChanged = nextLand !== landKey;
    if (landChanged) {
      landKey = nextLand;
      buildLand();
    }
    let changed = landChanged;
    const wanted = new Set<string>();
    const place = (id: string, key: string, look: string, make: () => { group: THREE.Group; animate: Animate[] }) => {
      wanted.add(id);
      const had = built.get(id);
      if (had?.key === key) return;
      changed = true;
      if (had) {
        things.remove(had.group);
        kit.free(had.owned);
      }
      const { value, owned } = kit.scope(make);
      built.set(id, { ...value, owned, key, look });
      things.add(value.group);
      if (!animated()) return;
      // Something really grown says so even when the rest of this update goes unannounced.
      const rises = grown.plots.get(id.replace(/^app:/, ""))?.rise && id.startsWith("app:") && value.group.userData.rising;
      if (rises) announcer.rising(value.group, look);
      else if (!announcing) return;
      else if (had && had.look !== look) announcer.changed(value.group, look);
      else if (!had && !firstSync) announcer.arrived(value.group, look); // you really added something
    };
    for (const p of world.plots) place(`app:${p.slug}`, plotKey(p), p.look, () => places.campus(p));
    for (const u of world.utilities) place(`provider:${u.id}`, utilityKey(u), u.look, () => places.plant(u));
    for (const [id, b] of built) {
      if (wanted.has(id)) continue;
      changed = true;
      things.remove(b.group);
      kit.free(b.owned);
      built.delete(id);
    }
    if (animated()) [...grown.plots].forEach(([slug, growing], i) => growth.begin(`app:${slug}`, growing, growDelay(i)));
    dish?.setWatching(world.watching);
    relight();
    rebuildOverlays();
    if (landChanged) {
      // The first look is simply there; after that, the view moves back as the land grows.
      if (rig.atOverview()) rig.refit(firstSync || !animated());
      else rig.rebase();
    }
    if (changed) atmosphere.redrawShadows();
    if (world.plots.length > 0 || !firstSync) firstSync = false;
    redraw();
  }

  // Lights are on, and lines joined, only on what's standing: not on what's still coming up.
  function relight() {
    const lit: Lamp[] = [];
    for (const [id, b] of built) {
      const light = b.group.userData.light as AntennaLight;
      if (light && !growth.isGrowing(id)) lit.push({ id, at: b.group.userData.antenna as THREE.Vector3, light });
    }
    lamps.set(lit);
  }

  function standing(kind: Standing, id: string): { group: THREE.Group } | undefined {
    if (kind === "tower") return dish ? { group: dish.group } : undefined;
    return built.get(`${kind}:${id}`);
  }

  function rebuildOverlays() {
    links.rebuild(world, selected, (id) => (growth.isGrowing(id) ? undefined : built.get(id)?.group));
    const target = selected && selected.kind !== "trip" ? standing(selected.kind, selected.id) : undefined;
    selectionRing.visible = Boolean(target);
    if (!target) return;
    const onHill = selected?.kind === "tower";
    selectionRing.position.set(target.group.position.x, onHill ? (dish?.base ?? 0) + 0.06 : target.group.position.y + 0.1, target.group.position.z);
    selectionRing.scale.setScalar(onHill ? 1.8 : 3.3);
  }

  // ── Frames ────────────────────────────────────────────────────────────

  const animated = () => !motionQuery.matches && !document.hidden;
  let frame = 0;
  let lastFrame = 0;
  const chasing = new THREE.Vector3();

  function render(t: number) {
    if (selected?.kind === "trip" && rig.isFollowing()) {
      if (vehicles.positionOf(selected.id, chasing)) rig.chase(chasing);
      else if (!vehicles.has(selected.id)) rig.stopFollowing(); // it's gone home
    }
    rig.frame(t);
    growth.tick(t);
    atmosphere.followCamera(rig.distance(), camera.position);
    const at = t === 0 ? STILL_T : t;
    for (const b of built.values()) for (const animate of b.animate) animate(at);
    links.tick(at);
    lamps.tick(t);
    dish?.tick(t);
    vehicles.tick(t);
    announcer.tick(t || performance.now());
    if (selectionRing.visible && t) selectionRing.rotation.y = t * 0.0002;
    renderer.render(scene, camera);
    perf.pictured();
    options.onFrame();
  }

  // Fewer pixels when this machine can't keep up. A fast one never
  // leaves the top level, and looks the same as ever.
  let pace = newPace(performance.now());
  let lastActive = performance.now();
  let lastBudget = FRAME_MS;
  const wake = () => {
    lastActive = performance.now();
  };
  // The browser all but stops drawing a window that's out of sight, which isn't a slow
  // computer: the gap that ends when it comes back doesn't count.
  const onVisibility = () => {
    lastBudget = UNFOCUSED_MS;
    redraw();
  };
  // Sizing the canvas wipes it, so only when it really changes: says whether it did, and
  // then the picture has to be drawn again straight away, or the window shows a blank.
  const drawnSize = new THREE.Vector2();
  function applyDetail(): boolean {
    const detail = DETAIL[pace.level]!;
    canvas.dataset.detail = String(pace.level);
    const { width, height } = rig.size();
    const ratio = Math.min(window.devicePixelRatio || 1, detail.pixels);
    renderer.getSize(drawnSize);
    const resized = ratio !== renderer.getPixelRatio() || drawnSize.x !== width || drawnSize.y !== height;
    if (resized) {
      renderer.setPixelRatio(ratio);
      renderer.setSize(width, height, false);
    }
    return resized;
  }

  function loop(now: number) {
    frame = 0;
    if (env.stopped || !animated()) return;
    const moving = pointer.dragging() || rig.settling() || rig.isFollowing() || growth.busy();
    if (moving || announcer.busy()) lastActive = now;
    const budget = pointer.dragging() ? MOVING_MS : !document.hasFocus() ? UNFOCUSED_MS : moving ? MOVING_MS : now - lastActive < IDLE_AFTER_MS ? FRAME_MS : IDLE_MS;
    // A frame or two early, rather than always a frame late on a screen whose refresh
    // doesn't divide evenly: the same time, without the slip.
    const gap = now - lastFrame;
    if (gap >= budget - 1) {
      // In motion, evenly spaced matters more: whole refreshes, never one here and two there.
      lastFrame = budget === MOVING_MS || gap >= budget * 2 ? now : now - Math.max(0, gap - budget);
      const drawing = performance.now();
      render(now);
      // A gap that began while it was idling or in the background was slow on purpose.
      const keepingUp = (budget: number) => budget === FRAME_MS || budget === MOVING_MS;
      perf.frame(gap, performance.now() - drawing, !document.hidden && keepingUp(budget) && keepingUp(lastBudget));
      lastBudget = budget;
      const next = paceAfter(pace, gap, Math.max(budget, STEADY_MS), now);
      const dropped = next.level !== pace.level;
      pace = next;
      if (dropped) perf.level(pace.level);
      if (dropped && applyDetail()) render(now);
    }
    frame = requestAnimationFrame(loop);
  }

  function redraw() {
    if (env.stopped) return;
    if (animated()) {
      if (!frame) frame = requestAnimationFrame(loop);
    } else {
      render(0);
    }
  }

  // ── Hands on it ───────────────────────────────────────────────────────

  const pointer = createPointer({
    canvas,
    camera,
    rig,
    pickables: () => (dish ? [things, dish.group] : [things]),
    tripAt: (x, y) => {
      const { width, height } = rig.size();
      return vehicles.pickAt(x, y, camera, width, height);
    },
    onSelect: options.onSelect,
    onHover: options.onHover,
    redraw,
  });

  const onTheme = () => {
    env.dusk = duskNow();
    env.status = tokens();
    atmosphere.setDusk(env.dusk);
    atmosphere.frameShadows(plan);
    sync();
  };

  // A GPU reset or sleep can take the picture away. three.js rebuilds what it holds when
  // the context comes back; shadows are the one thing it won't redraw itself.
  const onLost = (event: Event) => {
    event.preventDefault();
    perf.lost();
    options.onGraphics(true);
  };
  const onRestored = () => {
    atmosphere.redrawShadows();
    options.onGraphics(false);
    redraw();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  for (const kind of ["pointermove", "pointerdown", "wheel"] as const) canvas.addEventListener(kind, wake, { passive: true });
  document.addEventListener("keydown", wake);
  document.addEventListener("visibilitychange", onVisibility);
  motionQuery.addEventListener("change", redraw);
  themeQuery.addEventListener("change", onTheme);
  // The clock's sky turns when the hour does.
  const skyTimer = setInterval(() => {
    if (duskNow() !== env.dusk) onTheme();
  }, 60_000);

  const sizes = new ResizeObserver(() => {
    const box = host.getBoundingClientRect();
    rig.setSize(Math.max(1, box.width), Math.max(1, box.height));
    const resized = applyDetail();
    if (rig.atOverview()) rig.refit(true);
    else rig.rebase();
    if (resized && animated() && !env.stopped) render(performance.now());
    redraw();
  });
  sizes.observe(host);

  atmosphere.setDusk(env.dusk);

  const projected = new THREE.Vector3();
  // What to aim at: halfway up it, so its roof and its name stay in the picture.
  const middleOf = (group: THREE.Group) => projected.set(group.position.x, (group.position.y + (group.userData.top as number)) / 2, group.position.z);

  // Last, once nothing above can throw: its timer is only stopped by destroy, which a scene
  // that failed to build never gets.
  const perf = watchWorldPerf(renderer.getContext(), () => {
    const { width, height } = rig.size();
    return pictureSize(renderer.info.render.calls, renderer.info.render.triangles, renderer.getPixelRatio(), width, height);
  });

  return {
    update(next, say = true, nextGrown = NO_GROWTH) {
      world = next;
      announcing = say;
      grown = nextGrown;
      sync();
      announcing = true;
      grown = NO_GROWTH;
    },
    setTrips(trips: Trip[]) {
      vehicles.setTrips(trips, plan, performance.now(), world.watching);
      redraw();
    },
    select(next) {
      selected = next;
      rig.stopFollowing();
      rebuildOverlays();
      if (next?.kind === "trip") rig.follow();
      else if (next) {
        const target = standing(next.kind, next.id);
        if (target && next.kind === "tower") rig.lookAt(middleOf(target.group), FOCUS_ZOOM);
        else if (target && rig.zoomLevel() > 1.01) rig.lookAt(middleOf(target.group), rig.zoomLevel());
      }
      // The panel opening or closing changes how much room there is.
      rig.reframe();
      redraw();
    },
    zoomBy: rig.zoomBy,
    turn: rig.turn,
    zoomLevel: rig.zoomLevel,
    zoomRoom: rig.zoomRoom,
    descend() {
      if (animated()) rig.descend();
    },
    nudge: rig.nudge,
    setSky(mode) {
      skyMode = mode;
      onTheme();
    },
    focusOn(kind, id) {
      const target = standing(kind, id);
      if (target) rig.lookAt(middleOf(target.group), FOCUS_ZOOM);
    },
    resetView() {
      rig.refit(false);
      redraw();
    },
    anchor(kind, id) {
      const target = standing(kind, id);
      if (!target) return null;
      projected.set(target.group.position.x, (target.group.userData.top as number) + 0.1, target.group.position.z);
      if (kind === "tower") projected.y = target.group.userData.top as number;
      projected.project(camera);
      if (projected.z > 1) return null;
      const { width, height } = rig.size();
      return { x: ((projected.x + 1) / 2) * width, y: ((1 - projected.y) / 2) * height };
    },
    radarView() {
      const right = new THREE.Vector2(env.camDir.z, -env.camDir.x).normalize();
      const forward = new THREE.Vector2(-env.camDir.x, -env.camDir.z).normalize();
      return { right: [right.x, right.y], forward: [forward.x, forward.y], beam: dish?.yaw() ?? null };
    },
    destroy() {
      perf.stop();
      env.stopped = true;
      cancelAnimationFrame(frame);
      sizes.disconnect();
      pointer.destroy();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      for (const kind of ["pointermove", "pointerdown", "wheel"] as const) canvas.removeEventListener(kind, wake);
      document.removeEventListener("keydown", wake);
      document.removeEventListener("visibilitychange", onVisibility);
      motionQuery.removeEventListener("change", redraw);
      themeQuery.removeEventListener("change", onTheme);
      clearInterval(skyTimer);
      vehicles.dispose();
      atmosphere.dispose();
      kit.disposeAll();
      renderer.dispose();
      // Otherwise the graphics memory is held until the page's next clean-up, if then.
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
