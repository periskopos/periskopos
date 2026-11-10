import * as THREE from "three";
import { HILL_REACH, hillAt, hillRoad } from "../../../../../shared/valley/hill.ts";
import { bend, curveOf, RISE_FROM, RISE_TO, riseAt, streetSlope } from "../../../../../shared/valley/lay.ts";
import { MAIN_HALF, mainRoad, SPINE, STREET_HALF } from "../../../../../shared/valley/plan.ts";
import type { ValleyPlan } from "../../../../../shared/valley/plan.ts";
import { groundTone, hash, heightAt, landAt } from "../../../../../shared/valley/terrain.ts";
import { canvasTexture } from "./kit.ts";
import type { Kit } from "./kit.ts";

// The ground and the roads. Built once per plan: a change of state touches neither.

const GRID = 170; // squares a side; spaced closer together near the middle
const REACH = 520;
const FREEWAY_RUN = 400;
const ROAD_Y = 0.05;
const JUNCTION_Y = 0.062;
const RISE_ROW = 0.6; // how close together the ground's rows are on the rise, to follow it smoothly
const STREET_STEP = 1.1;
const RISE_TONE = 0.8; // how much of the rise the colour of the ground ignores: it's watered too
const HILL_RINGS = 44;
const HILL_ROUND = 150;
const HILL_LIFT = 0.015; // clear of the flat ground it stands on

// Road faces are one flat strip each, gathered into one mesh per surface.
class Strips {
  positions: number[] = [];
  uvs: number[] = [];
  index: number[] = [];

  add(x1: number, z1: number, x2: number, z2: number, half: number, perU: number, y1 = ROAD_Y, y2 = y1) {
    const length = Math.hypot(x2 - x1, z2 - z1) || 1;
    const nx = (-(z2 - z1) / length) * half;
    const nz = ((x2 - x1) / length) * half;
    const at = this.positions.length / 3;
    this.positions.push(x1 + nx, y1, z1 + nz, x1 - nx, y1, z1 - nz, x2 + nx, y2, z2 + nz, x2 - nx, y2, z2 - nz);
    const along = length / perU;
    this.uvs.push(0, 0, 1, 0, 0, along, 1, along);
    this.index.push(at, at + 2, at + 1, at + 1, at + 2, at + 3);
  }

  // One unbroken ribbon, for a road that curves and climbs.
  ribbon(points: { x: number; y: number; z: number; half?: number }[], half: number, perU: number) {
    let along = 0;
    points.forEach((p, i) => {
      const before = points[Math.max(0, i - 1)]!;
      const after = points[Math.min(points.length - 1, i + 1)]!;
      const length = Math.hypot(after.x - before.x, after.z - before.z) || 1;
      const nx = (-(after.z - before.z) / length) * (p.half ?? half);
      const nz = ((after.x - before.x) / length) * (p.half ?? half);
      if (i > 0) along += Math.hypot(p.x - before.x, p.z - before.z) / perU;
      const at = this.positions.length / 3;
      this.positions.push(p.x + nx, p.y, p.z + nz, p.x - nx, p.y, p.z - nz);
      this.uvs.push(0, along, 1, along);
      if (i > 0) this.index.push(at - 2, at, at - 1, at - 1, at, at + 1);
    });
  }

  // A sheet between two edges that run side by side.
  sheet(a: { x: number; y: number; z: number }[], b: { x: number; y: number; z: number }[]) {
    a.forEach((p, i) => {
      const q = b[i]!;
      const at = this.positions.length / 3;
      this.positions.push(p.x, p.y, p.z, q.x, q.y, q.z);
      this.uvs.push(0, i, 1, i);
      if (i > 0) this.index.push(at - 2, at, at - 1, at - 1, at, at + 1);
    });
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setIndex(this.index);
    g.computeVertexNormals();
    return g;
  }
}

// Along the curve, but keeping x as it is: the far ground has its columns set by distance.
const bendOnly = (x: number, v: number) => ({ x, z: v + curveOf(x) });

export function createLand(kit: Kit) {
  const { keep, own, cached, plain } = kit;

  const grainMap = keep(
    canvasTexture(256, (c, s) => {
      c.fillStyle = "#ffffff";
      c.fillRect(0, 0, s, s);
      for (let i = 0; i < 2600; i++) {
        c.fillStyle = hash("grain", i) > 0.5 ? "rgba(70,62,30,0.09)" : "rgba(255,245,205,0.11)";
        const r = 0.5 + hash("grain", i + 7000) * 2.2;
        c.fillRect(hash("grain", i + 1000) * s, hash("grain", i + 2000) * s, r, r * (0.6 + hash("grain", i + 3000)));
      }
    }),
  );
  const streetMap = keep(
    canvasTexture(128, (c, s) => {
      c.fillStyle = "#66686b";
      c.fillRect(0, 0, s, s);
      c.fillStyle = "#b9b6aa";
      c.fillRect(0, 0, s * 0.07, s);
      c.fillRect(s * 0.93, 0, s * 0.07, s);
      c.fillStyle = "#e7dfb4";
      c.fillRect(s * 0.485, 0, s * 0.03, s * 0.5);
    }),
  );
  const freewayMap = keep(
    canvasTexture(256, (c, s) => {
      c.fillStyle = "#5e6064";
      c.fillRect(0, 0, s, s);
      c.fillStyle = "#b3b0a5"; // the median
      c.fillRect(s * 0.47, 0, s * 0.06, s);
      c.fillStyle = "#e9e6da";
      for (const edge of [0.03, 0.44, 0.56, 0.97]) c.fillRect(s * edge - 1, 0, 2, s);
      for (const lane of [0.235, 0.765]) c.fillRect(s * lane - 1, 0, 2, s * 0.45);
    }),
  );
  const junctionTone = plain(0x66686b, 0.95);

  function ground(plan: ValleyPlan): THREE.Mesh {
    const side = GRID + 1;
    const midX = (plan.minX + plan.maxX) / 2;
    const midZ = (plan.minZ + plan.maxZ) / 2;
    const warp = (u: number) => Math.sign(u) * Math.pow(Math.abs(u), 2) * REACH;
    // Rows run along the curve, and there are many more of them up the rise, so it's smooth
    // there and the road up it stays on the ground.
    const rows = Array.from({ length: side }, (_, j) => midZ + warp((j / GRID) * 2 - 1)).filter((v) => v < RISE_TO || v > RISE_FROM);
    for (let v = RISE_TO; v <= RISE_FROM + 0.001; v += RISE_ROW) rows.push(v);
    rows.sort((a, b) => a - b);
    const lines = rows.length;
    const positions = new Float32Array(lines * side * 3);
    const colors = new Float32Array(lines * side * 3);
    const uvs = new Float32Array(lines * side * 2);
    for (let j = 0; j < lines; j++) {
      for (let i = 0; i < side; i++) {
        const { x, z } = bendOnly(midX + warp((i / GRID) * 2 - 1) * 1.3, rows[j]!);
        const y = landAt(plan, x, z);
        const at = j * side + i;
        positions.set([x, y, z], at * 3);
        colors.set(groundTone(y - riseAt(x, z) * RISE_TONE, x, z), at * 3);
        uvs.set([x / 9, z / 9], at * 2);
      }
    }
    const index = new Uint32Array((lines - 1) * GRID * 6);
    let n = 0;
    for (let j = 0; j < lines - 1; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = j * side + i;
        const b = a + 1;
        const c = a + side;
        const d = c + 1;
        index.set([a, c, b, b, c, d], n);
        n += 6;
      }
    }
    const geometry = own(new THREE.BufferGeometry());
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.computeVertexNormals();
    const material = cached("ground", () => new THREE.MeshStandardMaterial({ map: grainMap, vertexColors: true, roughness: 1 }));
    const m = new THREE.Mesh(geometry, material);
    m.receiveShadow = true;
    return m;
  }

  // The dish's hill: rings round it, close enough together to carry the shelf of its road.
  function hill(plan: ValleyPlan): THREE.Mesh {
    const { x: cx, y: cz } = plan.watcher;
    const side = HILL_ROUND + 1;
    const count = (HILL_RINGS + 1) * side;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    for (let j = 0; j <= HILL_RINGS; j++) {
      const r = (j / HILL_RINGS) * HILL_REACH;
      for (let i = 0; i <= HILL_ROUND; i++) {
        const a = (i / HILL_ROUND) * Math.PI * 2;
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r;
        const y = hillAt(plan.watcher, x, z);
        const rise = riseAt(x, z);
        const at = j * side + i;
        positions.set([x, y + rise + HILL_LIFT, z], at * 3);
        colors.set(groundTone(y + rise * (1 - RISE_TONE), x, z), at * 3);
        uvs.set([x / 9, z / 9], at * 2);
      }
    }
    const index = new Uint32Array(HILL_RINGS * HILL_ROUND * 6);
    let n = 0;
    for (let j = 0; j < HILL_RINGS; j++) {
      for (let i = 0; i < HILL_ROUND; i++) {
        const a = j * side + i;
        const b = a + 1;
        const c = a + side;
        const d = c + 1;
        index.set([a, b, c, b, d, c], n);
        n += 6;
      }
    }
    const geometry = own(new THREE.BufferGeometry());
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.computeVertexNormals();
    const m = new THREE.Mesh(geometry, cached("ground", () => new THREE.MeshStandardMaterial({ map: grainMap, vertexColors: true, roughness: 1 })));
    m.receiveShadow = true;
    m.castShadow = true;
    return m;
  }

  function roads(plan: ValleyPlan): THREE.Group {
    const group = new THREE.Group();
    const streetM = cached("street", () => new THREE.MeshStandardMaterial({ map: streetMap, roughness: 0.95 }));
    const freewayM = cached("freeway", () => new THREE.MeshStandardMaterial({ map: freewayMap, roughness: 0.95 }));

    const freeway = new Strips();
    freeway.ribbon(mainRoad(plan, FREEWAY_RUN).map(({ u, half }) => ({ ...bend(u, 0), y: ROAD_Y, half })), 1, 5);
    group.add(new THREE.Mesh(own(freeway.geometry()), freewayM));

    const onGround = (u: number, v: number, lift: number) => {
      const { x, z } = bend(u, v);
      return { x, z, y: heightAt(plan, x, z) + lift };
    };
    const streets = new Strips();
    for (const r of plan.roads) {
      const steps = Math.max(1, Math.ceil(Math.hypot(r.x2 - r.x1, r.z2 - r.z1) / STREET_STEP));
      streets.ribbon(Array.from({ length: steps + 1 }, (_, i) => onGround(r.x1 + ((r.x2 - r.x1) * i) / steps, r.z1 + ((r.z2 - r.z1) * i) / steps, ROAD_Y)), STREET_HALF, 1.4);
    }
    streets.ribbon(hillRoad(plan.watcher).map((p) => ({ x: p.x, y: p.y + riseAt(p.x, p.z) + ROAD_Y + HILL_LIFT, z: p.z })), STREET_HALF, 1.4);
    group.add(new THREE.Mesh(own(streets.geometry()), streetM));

    // The services' zone is paved, so it reads as a place of its own.
    if (plan.services) {
      const { minU, maxU, minV, maxV } = plan.services;
      const yard = new Strips();
      const steps = Math.ceil((maxU - minU) / STREET_STEP);
      const edge = (v: number) => Array.from({ length: steps + 1 }, (_, i) => onGround(minU + ((maxU - minU) * i) / steps, v, 0.012));
      yard.sheet(edge(maxV), edge(minV));
      group.add(new THREE.Mesh(own(yard.geometry()), plain(0x9a988c, 1)));
    }

    // Plain asphalt where roads cross, so no markings run through a junction.
    const junctions = new Strips();
    const patch = (u: number, v: number, half: number) => {
      const at = onGround(u, v, JUNCTION_Y);
      const slope = streetSlope(at.x);
      const dx = STREET_HALF / Math.hypot(1, slope);
      junctions.add(at.x - dx, at.z - dx * slope, at.x + dx, at.z + dx * slope, half, 1, at.y);
    };
    for (const j of plan.junctions) patch(j.u, j.v, STREET_HALF);
    patch(SPINE, 0, MAIN_HALF); // where the spine leaves the main road
    group.add(new THREE.Mesh(own(junctions.geometry()), junctionTone));
    for (const child of group.children) child.receiveShadow = true;
    return group;
  }

  return { ground, hill, roads };
}

export type Land = ReturnType<typeof createLand>;
