import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { placeOn } from "../../../../../shared/valley/routes.ts";
import type { Place } from "../../../../../shared/valley/routes.ts";
import { heightAt } from "../../../../../shared/valley/terrain.ts";
import type { ValleyPlan } from "../../../../../shared/valley/plan.ts";
import type { Trip } from "../../../../../shared/valley/trips.ts";
import type { Env, Kit } from "./kit.ts";

// Everything on the road, one draw per kind. A trip's whereabouts come from the time
// and its route alone, so a new reading of the same facts never makes anything jump.

const CAPACITY = { traffic: 160, check: 24, deploy: 24 } as const;
type Kind = keyof typeof CAPACITY;
const CAR_COLORS = [0xe4e6ea, 0xc9483f, 0x4a86c5, 0xe8bd47, 0xf4f4f0, 0xb7bcc3];
const FADE = 1.5; // how far from the ends of a route it grows and shrinks, to leave and arrive
const SEND_OVER_MS = 25_000; // checks are read in batches: sent out spread over this
const STILL_T = 20_000;
const PICK_RADIUS = 13;
const SENT_KEPT_MS = 10 * 60_000; // longer than any check stays in what's sent

function tinted(geometry: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const part = geometry.index ? geometry.toNonIndexed() : geometry;
  const tone = new THREE.Color(color);
  const count = part.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([tone.r, tone.g, tone.b], i * 3);
  part.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return part;
}
const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z);

// Shapes point along +z. White parts take the instance's colour.
const SHAPES: Record<Kind, () => THREE.BufferGeometry> = {
  traffic: () => mergeGeometries([tinted(box(0.17, 0.07, 0.38, 0, 0.02), 0xffffff), tinted(box(0.14, 0.06, 0.18, 0, 0.09, -0.02), 0x1b2128)])!,
  check: () => mergeGeometries([tinted(box(0.2, 0.15, 0.42, 0, 0.02), 0xffffff), tinted(box(0.165, 0.05, 0.1, 0, 0.1, 0.17), 0x1b2128), tinted(box(0.12, 0.03, 0.1, 0, 0.17), 0xf4f6f8)])!,
  deploy: () => mergeGeometries([tinted(box(0.25, 0.2, 0.5, 0, 0.03, -0.12), 0xffffff), tinted(box(0.24, 0.17, 0.2, 0, 0.03, 0.26), 0x39424c), tinted(box(0.19, 0.06, 0.02, 0, 0.12, 0.365), 0x9fc4dc)])!,
};

export function createVehicles(kit: Kit, env: Env, scene: THREE.Scene) {
  const { keep } = kit;
  const body = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.25 }));
  const lampMaterial = keep(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
  const lampShape = keep(mergeGeometries([tinted(box(0.14, 0.02, 0.01, 0, 0.05, 0.195), 0xfff1c9), tinted(box(0.14, 0.02, 0.01, 0, 0.05, -0.195), 0xff3a2a)])!);

  const pools = (Object.keys(CAPACITY) as Kind[]).reduce(
    (all, kind) => {
      const m = new THREE.InstancedMesh(keep(SHAPES[kind]()), body, CAPACITY[kind]);
      const lamps = new THREE.InstancedMesh(lampShape, lampMaterial, CAPACITY[kind]);
      lamps.instanceMatrix = m.instanceMatrix; // the lamps go where the bodies go
      m.frustumCulled = lamps.frustumCulled = false;
      m.count = lamps.count = 0;
      m.setColorAt(0, new THREE.Color(0xffffff));
      scene.add(m, lamps);
      all[kind] = { mesh: m, lamps };
      return all;
    },
    {} as Record<Kind, { mesh: THREE.InstancedMesh; lamps: THREE.InstancedMesh }>,
  );

  type Running = { trip: Trip; start: number; x: number; y: number; z: number; shown: boolean };
  const running = new Map<string, Running>();
  const sent = new Map<string, number>(); // a check is sent out once, however often it's read
  let plan: ValleyPlan | null = null;
  const place: Place = { x: 0, z: 0, heading: 0 };
  const matrix = new THREE.Matrix4();
  const at = new THREE.Vector3();
  const size = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3(1, 0, 0);
  const tilt = new THREE.Quaternion();
  const color = new THREE.Color();

  function colorOf(trip: Trip): THREE.Color {
    if (trip.facts.kind === "deploy") return env.status.info;
    if (trip.facts.kind === "check") return trip.facts.state === "up" ? env.status.up : trip.facts.state === "down" ? env.status.down : env.status.unknown;
    return color.setHex(CAR_COLORS[Math.floor(trip.seed * 1000) % CAR_COLORS.length]!);
  }

  function setTrips(trips: Trip[], nextPlan: ValleyPlan, now: number, watching: boolean) {
    plan = nextPlan;
    const wanted = new Set(trips.map((t) => t.id));
    for (const [id, at] of sent) if (now - at > SENT_KEPT_MS) sent.delete(id);
    // A van already out finishes its round, unless nothing is being watched any more.
    for (const [id, r] of running) if ((!r.trip.once || !watching) && !wanted.has(id)) running.delete(id);
    for (const trip of trips) {
      const had = running.get(trip.id);
      if (had) {
        had.trip = trip; // the same trip: a road may have moved, the time hasn't
        continue;
      }
      if (trip.once && sent.has(trip.id)) continue;
      if (trip.once) sent.set(trip.id, now);
      running.set(trip.id, { trip, start: now + (trip.once ? trip.seed * SEND_OVER_MS : 0), x: 0, y: 0, z: 0, shown: false });
    }
  }

  // Which way along its route a trip is, at this moment, and how far.
  function along(r: Running, t: number): { s: number; back: boolean } | null {
    const { route, speed, seed, once } = r.trip;
    const run = route.length;
    if (once) {
      const gone = ((t - r.start) / 1000) * speed;
      if (gone < 0) return null;
      if (gone > run * 2) return null;
      return gone <= run ? { s: gone, back: false } : { s: run * 2 - gone, back: true };
    }
    const gone = (t / 1000) * speed + seed * run * 2;
    const phase = gone % (run * 2);
    return phase <= run ? { s: phase, back: false } : { s: run * 2 - phase, back: true };
  }

  function tick(time: number) {
    const still = time === 0;
    const t = still ? STILL_T : time;
    const counts: Record<Kind, number> = { traffic: 0, check: 0, deploy: 0 };
    for (const [id, r] of running) {
      r.shown = false;
      const kind = r.trip.facts.kind;
      if (still && r.trip.once) {
        running.delete(id); // reduced motion: the check isn't acted out
        continue;
      }
      const where = along(r, t);
      if (!where) {
        if (r.trip.once && t > r.start) running.delete(id);
        continue;
      }
      const slot = counts[kind];
      if (slot >= CAPACITY[kind]) continue;
      placeOn(r.trip.route, where.s, where.back, place);
      const ends = Math.min(where.s, r.trip.route.length - where.s) / FADE;
      const scale = Math.min(1, Math.max(0.001, ends));
      r.x = place.x;
      r.z = place.z;
      const ground = plan ? heightAt(plan, place.x, place.z) : 0;
      r.y = ground + 0.05;
      r.shown = true;
      turn.setFromAxisAngle(up, place.heading);
      if (plan && ground > 0.01) {
        // On the hill: nose up or down with the slope.
        const dx = Math.sin(place.heading) * 0.4;
        const dz = Math.cos(place.heading) * 0.4;
        turn.multiply(tilt.setFromAxisAngle(side, -Math.atan2(heightAt(plan, r.x + dx, r.z + dz) - heightAt(plan, r.x - dx, r.z - dz), 0.8)));
      }
      matrix.compose(at.set(r.x, r.y, r.z), turn, size.setScalar(scale * (kind === "traffic" ? 1.5 : 1.7)));
      const pool = pools[kind];
      pool.mesh.setMatrixAt(slot, matrix);
      pool.mesh.setColorAt(slot, colorOf(r.trip));
      counts[kind] = slot + 1;
    }
    for (const kind of Object.keys(pools) as Kind[]) {
      const { mesh, lamps } = pools[kind];
      mesh.count = lamps.count = counts[kind];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      lamps.visible = env.dusk && counts[kind] > 0;
    }
  }

  const screen = new THREE.Vector3();

  return {
    setTrips,
    tick,
    // Vehicles are small: the nearest one to the pointer, within reach of a fingertip.
    pickAt(x: number, y: number, camera: THREE.Camera, width: number, height: number): { id: string; distance: number } | null {
      let best: { id: string; distance: number } | null = null;
      let nearest = PICK_RADIUS;
      for (const [id, r] of running) {
        if (!r.shown) continue;
        screen.set(r.x, r.y, r.z).project(camera);
        if (screen.z > 1) continue;
        const d = Math.hypot(((screen.x + 1) / 2) * width - x, ((1 - screen.y) / 2) * height - y);
        if (d < nearest) {
          nearest = d;
          best = { id, distance: camera.position.distanceTo(at.set(r.x, r.y, r.z)) };
        }
      }
      return best;
    },
    positionOf(id: string, into: THREE.Vector3): boolean {
      const r = running.get(id);
      if (!r?.shown) return false;
      into.set(r.x, r.y, r.z);
      return true;
    },
    has: (id: string) => running.has(id),
    dispose() {
      for (const { mesh, lamps } of Object.values(pools)) {
        mesh.dispose();
        lamps.dispose();
      }
    },
  };
}

export type Vehicles = ReturnType<typeof createVehicles>;
