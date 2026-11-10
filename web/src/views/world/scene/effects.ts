import * as THREE from "three";
import { hash } from "../../../../../shared/valley/terrain.ts";
import type { Plot } from "../../../../../shared/world.ts";
import type { Animate, Env, Kit } from "./kit.ts";

// What's laid over a building to say how it stands, or what's being done to it. Each of
// these is a fact from the data: fog is not knowing, smoke is down, a crane is a deploy.

export const FLOOR_H = 0.36;

export function createEffects(kit: Kit, env: Env) {
  const { unit, cylinder, puff, glow, plain, mesh, sprite, own } = kit;

  function fogBank(group: THREE.Group, seed: string, top: number, spread: number, animate: Animate[]) {
    const color = env.dusk ? 0x9aabc0 : 0xe6ebef;
    for (let i = 0; i < 20; i++) {
      const s = sprite(puff, color, 1.5 + hash(seed, i + 40) * 1.5, env.dusk ? 0.62 : 0.8, false);
      const bx = (hash(seed, i + 50) - 0.5) * spread;
      const bz = (hash(seed, i + 60) - 0.5) * spread;
      const by = 0.1 + hash(seed, i + 70) * (top + 0.2);
      s.position.set(bx, by, bz);
      const speed = 0.00012 + hash(seed, i + 80) * 0.0001;
      animate.push((t) => {
        s.position.x = bx + env.inFront.x + Math.sin(t * speed + i) * 0.14;
        s.position.y = by + env.inFront.y;
        s.position.z = bz + env.inFront.z + Math.cos(t * speed * 0.8 + i) * 0.14;
      });
      group.add(s);
    }
  }

  function smoke(group: THREE.Group, seed: string, top: number, animate: Animate[]) {
    for (let i = 0; i < 9; i++) {
      const s = sprite(puff, env.dusk ? 0x33363b : 0x3a3c40, 0.5, 0.75, false);
      const phase = i / 9;
      animate.push((t) => {
        const life = (t * 0.00012 + phase) % 1;
        s.position.set(Math.sin(life * 6 + hash(seed, i)) * 0.12 + life * 0.5, top + life * 2.4, -life * 0.35);
        const size = 0.35 + life * 1.3;
        s.scale.set(size, size, size);
        s.material.opacity = 0.75 * (1 - life);
      });
      group.add(s);
    }
  }

  // A short mast in the middle of the sign's top edge, up to where its light goes, so the logo
  // and its light are read in one place. It stands on the line the sign turns round, so it
  // doesn't swing. The same steel as the turntable, so it's drawn with it. The light itself
  // is in lamps.ts.
  function antenna(group: THREE.Group, x: number, base: number, z: number, tip: number) {
    const steel = plain(0x565b62, 0.6, 0.5);
    const tall = tip - base;
    group.add(mesh(cylinder, steel, x, base, z, 0.05, 0.016, 0.05));
    group.add(mesh(cylinder, steel, x, base, z, 0.026, tall * 0.7, 0.026));
    group.add(mesh(cylinder, steel, x, base + tall * 0.7, z, 0.014, tall * 0.3, 0.014));
  }

  function groundRing(group: THREE.Group, color: THREE.Color, animate: Animate[]) {
    const geometry = own(new THREE.RingGeometry(0.93, 1, 56));
    geometry.rotateX(-Math.PI / 2);
    const material = own(new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    const ring = new THREE.Mesh(geometry, material);
    ring.position.y = 0.09;
    animate.push((t) => {
      const life = (t * 0.00045) % 1;
      const size = 1.2 + life * 0.9;
      ring.scale.set(size, 1, size);
      material.opacity = 0.9 * (1 - life);
    });
    group.add(ring);
  }

  function redGlow(group: THREE.Group, animate: Animate[]) {
    const light = sprite(glow, env.status.down, 3.4, env.dusk ? 0.32 : 0.22);
    animate.push(() => {
      light.position.copy(env.inFront);
      light.position.y += 0.5;
    });
    group.add(light);
  }

  // A deploy under way: a tower crane turning over the building.
  function crane(group: THREE.Group, top: number, animate: Animate[]) {
    const yellow = plain(0xe7b022, 0.55, 0.15);
    const x = -0.92;
    const z = 0.62;
    const height = top + 0.95;
    group.add(mesh(unit, plain(0x777a7d, 0.9), x, 0.05, z, 0.3, 0.05, 0.3));
    group.add(mesh(unit, yellow, x, 0.08, z, 0.09, height, 0.09));
    const head = new THREE.Group();
    head.position.set(x, 0.08 + height, z);
    head.add(mesh(unit, yellow, 0.72, 0, 0, 1.9, 0.07, 0.07, false));
    head.add(mesh(unit, plain(0x4d5157, 0.6, 0.3), -0.4, -0.08, 0, 0.26, 0.16, 0.14, false));
    const cable = mesh(unit, plain(0x222222), 1.25, -0.5, 0, 0.012, 0.5, 0.012, false);
    const load = mesh(unit, plain(env.status.info, 0.5, 0, env.status.info, 0.6), 1.25, -0.62, 0, 0.2, 0.12, 0.2, false);
    head.add(cable, load);
    animate.push((t) => {
      head.rotation.y = t * 0.00022 + 0.8;
      const drop = 0.32 + 0.22 * Math.sin(t * 0.0006);
      cable.scale.y = drop;
      cable.position.y = -drop;
      load.position.y = -drop - 0.12;
    });
    group.add(head);
  }

  // A push that didn't go live: its delivery is stopped at the door.
  function stoppedTruck(group: THREE.Group) {
    group.add(mesh(unit, plain(env.status.attention, 0.5, 0.1), 0.98, 0.08, 0.1, 0.2, 0.2, 0.46));
    group.add(mesh(unit, plain(0x2b3138, 0.4, 0.3), 0.98, 0.08, 0.45, 0.2, 0.14, 0.18));
    group.add(mesh(unit, plain(0x9fc4dc, 0.2, 0.4), 0.98, 0.16, 0.55, 0.17, 0.06, 0.01, false));
  }

  // Not live yet: a frame going up, a floor for each thing watched.
  function scaffold(group: THREE.Group, plot: Plot): number {
    const height = plot.floors * FLOOR_H + 0.1;
    const half = 0.68;
    const core = plain(0xa8a79f, 0.95);
    group.add(mesh(unit, core, 0, 0.05, 0, 1.1, height * 0.55, 1.1));
    for (let f = 1; f <= plot.floors; f++) group.add(mesh(unit, core, 0, 0.05 + f * FLOOR_H - 0.02, 0, 1.28, 0.03, 1.28));
    const pole = plain(env.status.info, 0.5, 0.4);
    for (const x of [-half, 0, half]) {
      for (const z of [-half, 0, half]) {
        if (x === 0 && z === 0) continue;
        group.add(mesh(unit, pole, x, 0.05, z, 0.025, height + 0.08, 0.025));
      }
    }
    for (let f = 1; f <= plot.floors; f++) {
      const y = 0.05 + f * FLOOR_H;
      for (const z of [-half, half]) group.add(mesh(unit, pole, 0, y, z, half * 2, 0.018, 0.018, false));
      for (const x of [-half, half]) group.add(mesh(unit, pole, x, y, 0, 0.018, 0.018, half * 2, false));
    }
    return height;
  }

  // Nothing to check: a fenced plot with its sign, and nothing claimed about it.
  function fencedPlot(group: THREE.Group) {
    const post = plain(0x8b7a62, 0.9);
    for (let i = -3; i <= 3; i++) {
      const p = i * 0.34;
      for (const [x, z] of [[p, -1.05], [p, 1.05], [-1.05, p], [1.05, p]] as const) group.add(mesh(unit, post, x, 0.02, z, 0.03, 0.16, 0.03));
    }
  }

  return { fogBank, smoke, antenna, groundRing, redGlow, crane, stoppedTruck, scaffold, fencedPlot };
}

export type Effects = ReturnType<typeof createEffects>;
