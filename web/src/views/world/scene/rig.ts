import { riseAt } from "../../../../../shared/valley/lay.ts";
import * as THREE from "three";
import type { ValleyPlan } from "../../../../../shared/valley/plan.ts";
import type { World } from "../../../../../shared/world.ts";
import { FLOOR_H } from "./effects.ts";
import type { Env } from "./kit.ts";
import { glide } from "./zoomFeel.ts";

// The one camera and the one set of hands on it: what's being looked at, from how far,
// and every way of moving that. Drags, wheel, keys and following a van all come here.

const CAMERA_DIR = new THREE.Vector3(0.22, 0.62, 1.2).normalize(); // low enough to see the ranges beyond
const UP = new THREE.Vector3(0, 1, 0);
export const FOV = 38;
const FAR_ZOOM = 0.55; // out past the fit, to see the ranges
const NEAR_ZOOM = 3.5; // nearer than this, the camera is in among the models
const FOLLOW_ZOOM = 1.8;
const ABOVE_ZOOM = 0.55; // where it starts from on the way down out of the clouds
const EASE_PER_FRAME = 0.84;
const FRAME_MS = 1000 / 30;
const FIRST_STEP_MS = 1000 / 60; // starting from rest, however long it has been since the last frame
const STILL_SPEED = 0.00001; // of the zoom, per millisecond
// Where the buildings may come in the picture, top to bottom: the figures cover the top.
const TOP_LIMIT = 0.5;
const BOTTOM_LIMIT = -0.92;

export type RigDeps = {
  camera: THREE.PerspectiveCamera;
  env: Env;
  reservedRight(): number;
  redraw(): void;
};

export function createRig({ camera, env, reservedRight, redraw }: RigDeps) {
  const view = { zoom: 1, zoomSpeed: 0, target: new THREE.Vector3(), goalZoom: 1, goalTarget: new THREE.Vector3(), base: 40, goalBase: 40, reserve: 0, angle: 0, goalAngle: 0 };
  let width = 1;
  let height = 1;
  let plan: ValleyPlan | null = null;
  let world: World | null = null;
  let following = false;
  let moved = false; // dragged away from the overview by hand, so it isn't pulled back
  let lastT = 0;
  let resting = true;

  function apply() {
    const distance = view.base / view.zoom;
    env.camDir.copy(CAMERA_DIR).applyAxisAngle(UP, view.angle);
    env.inFront.copy(env.camDir).multiplyScalar(1.8);
    camera.position.copy(view.target).addScaledVector(env.camDir, distance);
    camera.lookAt(view.target);
    camera.aspect = width / height;
    if (view.reserve > 0.5) camera.setViewOffset(width, height, view.reserve / 2, 0, width, height);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  // The nearest the camera can be with everything built in the frame, beside whatever
  // the side panel covers. The land round it is only there to be seen past.
  function fit() {
    const center = new THREE.Vector3();
    if (!plan || !world) return { center, distance: 40 };
    const { minX, maxX, minZ, maxZ, watcher } = plan;
    center.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    const dir = CAMERA_DIR.clone().applyAxisAngle(UP, view.goalAngle);
    const around = (x: number, z: number, reach: number) => {
      const y = riseAt(x, z);
      return [[x - reach, y, z - reach], [x + reach, y, z - reach], [x - reach, y, z + reach], [x + reach, y, z + reach]];
    };
    const points = [
      ...world.plots.flatMap((p) => around(p.x, p.y, 2.6)),
      ...world.utilities.flatMap((u) => around(u.x, u.y, 2.4)),
      ...world.plots.map((p) => [p.x, p.floors * FLOOR_H * 2 + 2.6, p.y]), // the tallest roofs, their signs and labels
      ...world.utilities.map((u) => [u.x, 5 + riseAt(u.x, u.y), u.y]),
      [watcher.x, 6 + riseAt(watcher.x, watcher.y), watcher.y],
    ].map(([x, y, z]) => new THREE.Vector3(x!, y!, z!));
    // On a tall, narrow window the ends of the row may run off the sides: it can be dragged.
    const usable = Math.max(0.3, (width - reservedRight()) / width) * (width / height < 0.75 ? 1.45 : 1);
    const trial = camera.clone();
    trial.clearViewOffset();
    trial.aspect = width / height;
    trial.updateProjectionMatrix();
    const seenFrom = (distance: number) => {
      trial.position.copy(center).addScaledVector(dir, distance);
      trial.lookAt(center);
      trial.updateMatrixWorld();
      return points.map((p) => p.clone().project(trial));
    };
    const search = () => {
      let low = 6;
      let high = 700;
      for (let i = 0; i < 26; i++) {
        const mid = (low + high) / 2;
        if (seenFrom(mid).every((n) => Math.abs(n.x) <= usable * 0.97 && n.y <= TOP_LIMIT && n.y >= BOTTOM_LIMIT)) high = mid;
        else low = mid;
      }
      return high;
    };
    let distance = search();
    // It isn't symmetrical in the picture: centre what's seen, then come as near again
    // as that allows. Twice, as coming nearer changes the perspective.
    for (let pass = 0; pass < 2; pass++) {
      const seen = seenFrom(distance);
      const midX = (Math.min(...seen.map((n) => n.x)) + Math.max(...seen.map((n) => n.x))) / 2;
      const midY = (Math.min(...seen.map((n) => n.y)) + Math.max(...seen.map((n) => n.y))) / 2 - (TOP_LIMIT + BOTTOM_LIMIT) / 2;
      const half = distance * Math.tan((FOV * Math.PI) / 360);
      center.addScaledVector(new THREE.Vector3(dir.z, 0, -dir.x).normalize(), midX * half * trial.aspect);
      center.addScaledVector(new THREE.Vector3(-dir.x, 0, -dir.z).normalize(), (midY * half) / Math.max(0.3, dir.y));
      distance = search();
    }
    return { center, distance };
  }

  function refit(snap: boolean) {
    const { center, distance } = fit();
    view.goalBase = distance;
    view.goalZoom = 1;
    view.goalTarget.copy(center);
    following = false;
    moved = false;
    if (snap) {
      view.base = distance;
      view.angle = view.goalAngle;
      view.reserve = reservedRight();
      view.zoom = 1;
      view.zoomSpeed = 0;
      view.target.copy(center);
    }
  }

  // Keeps the overview in frame if that's what's being looked at, as room changes.
  const overview = () => view.goalZoom <= 1.01;
  function reframe() {
    if (!overview() || moved) return;
    const zoom = view.goalZoom;
    refit(false);
    view.goalZoom = zoom;
  }

  function panBy(dx: number, dy: number, from: THREE.Vector3) {
    following = false;
    moved = true;
    const span = (2 * (view.base / view.zoom) * Math.tan((FOV * Math.PI) / 360)) / height;
    const right = new THREE.Vector3(env.camDir.z, 0, -env.camDir.x).normalize();
    const forward = new THREE.Vector3(-env.camDir.x, 0, -env.camDir.z).normalize();
    const lift = 1 / Math.max(0.3, env.camDir.y);
    const next = from.clone().addScaledVector(right, -dx * span).addScaledVector(forward, dy * span * lift);
    if (plan) {
      const room = 14;
      next.x = Math.max(plan.minX - room, Math.min(plan.maxX + room, next.x));
      next.z = Math.max(plan.minZ - room, Math.min(plan.maxZ + room, next.z));
    }
    view.goalTarget.copy(next);
  }

  const settling = () => Math.abs(view.goalZoom - view.zoom) > 0.002 || Math.abs(view.zoomSpeed) > STILL_SPEED || Math.abs(view.goalBase - view.base) > 0.02 || Math.abs(view.goalAngle - view.angle) > 0.002 || Math.abs(reservedRight() - view.reserve) > 0.5 || view.target.distanceToSquared(view.goalTarget) > 0.0004;

  return {
    setPlace(nextPlan: ValleyPlan, nextWorld: World) {
      plan = nextPlan;
      world = nextWorld;
    },
    setSize(w: number, h: number) {
      width = w;
      height = h;
    },
    size: () => ({ width, height }),
    refit,
    reframe,
    atOverview: () => overview() && !moved,
    // What's built changed under a view that's been moved: how far the fit is changes,
    // and what's being looked at doesn't.
    rebase() {
      view.goalBase = fit().distance;
    },
    panBy,
    goal: () => view.goalTarget,
    nudge(dx: number, dy: number) {
      panBy(dx, dy, view.goalTarget.clone());
      redraw();
    },
    zoomBy(factor: number) {
      const wasOverview = overview();
      view.goalZoom = Math.max(FAR_ZOOM, Math.min(NEAR_ZOOM, view.goalZoom * factor));
      if (overview() && !wasOverview) reframe(); // only on arriving: a trackpad sends dozens of these
      redraw();
    },
    zoomLevel: () => view.goalZoom,
    zoomRoom: () => ({ nearer: view.goalZoom < NEAR_ZOOM - 0.001, farther: view.goalZoom > FAR_ZOOM + 0.001 }),
    // From higher up, to where it was going to be anyway: where it ends up is unchanged.
    descend() {
      view.zoom = Math.min(view.zoom, ABOVE_ZOOM);
      view.zoomSpeed = 0;
      redraw();
    },
    turn(quarters: number) {
      view.goalAngle += (quarters * Math.PI) / 2;
      reframe();
      redraw();
    },
    lookAt(where: THREE.Vector3, zoom: number) {
      following = false;
      moved = false;
      view.goalZoom = Math.max(view.goalZoom, zoom);
      view.goalTarget.copy(where);
      redraw();
    },
    // Stays with something that moves, until a drag or another choice lets go of it.
    follow: () => {
      following = true;
      view.goalZoom = Math.max(view.goalZoom, FOLLOW_ZOOM);
    },
    stopFollowing: () => {
      following = false;
    },
    isFollowing: () => following,
    chase(where: THREE.Vector3) {
      view.goalTarget.copy(where);
    },
    settling,
    distance: () => view.base / view.zoom,
    frame(t: number) {
      const reserve = reservedRight();
      if (t === 0) {
        view.zoom = view.goalZoom;
        view.zoomSpeed = 0;
        view.base = view.goalBase;
        view.reserve = reserve;
        view.angle = view.goalAngle;
        view.target.copy(view.goalTarget);
      } else {
        const ms = resting ? FIRST_STEP_MS : Math.min(120, t - lastT);
        const ease = 1 - Math.pow(EASE_PER_FRAME, ms / FRAME_MS);
        // By ratio, not difference: each step in or out looks the same size wherever you are.
        const zoom = glide(Math.log(view.zoom), Math.log(view.goalZoom), view.zoomSpeed, ms);
        view.zoom = Math.exp(zoom.at);
        view.zoomSpeed = zoom.speed;
        view.base += (view.goalBase - view.base) * ease;
        view.reserve += (reserve - view.reserve) * ease;
        view.angle += (view.goalAngle - view.angle) * ease;
        view.target.lerp(view.goalTarget, ease);
      }
      lastT = t;
      resting = !settling();
      apply();
    },
  };
}

export type Rig = ReturnType<typeof createRig>;
