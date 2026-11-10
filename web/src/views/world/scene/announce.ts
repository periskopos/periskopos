import * as THREE from "three";
import type { Env } from "./kit.ts";

// The moment a place changes: it settles into its new state, and rings go out from it in
// that state's colour. Something new comes up out of the ground, or says so in rings while
// a campus's own growth brings it up. Only a real change sets any of it off.

const ANNOUNCE_MS = 3000;
const RISE_MS = 3500;

type Announcement = { start: number; group: THREE.Group; base: number; from: number; span: number; rings: THREE.Mesh[]; material: THREE.MeshBasicMaterial; geometry: THREE.RingGeometry };

export function createAnnouncer(scene: THREE.Scene, env: Env) {
  let live: Announcement[] = [];

  function start(group: THREE.Group, color: THREE.Color, from: number, span: number) {
    const geometry = new THREE.RingGeometry(0.965, 1, 72);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const rings = [0, 1, 2].map(() => {
      const ring = new THREE.Mesh(geometry, material);
      ring.position.set(group.position.x, group.position.y + 0.12, group.position.z);
      scene.add(ring);
      return ring;
    });
    live.push({ start: performance.now(), group, base: group.scale.y, from, span, rings, material, geometry });
  }

  const colorOf = (look: string) =>
    look === "lit" || look === "ok" ? env.status.up : look === "warning" || look === "maintenance" ? env.status.attention : look === "dark" || look === "trouble" ? env.status.down : look === "scaffold" ? env.status.info : env.status.unknown;

  return {
    changed: (group: THREE.Group, look: string) => start(group, colorOf(look), 0.82, ANNOUNCE_MS),
    arrived: (group: THREE.Group, look: string) => start(group, colorOf(look), 0.02, RISE_MS),
    rising: (group: THREE.Group, look: string) => start(group, colorOf(look), 1, RISE_MS),
    busy: () => live.length > 0,
    tick(t: number) {
      live = live.filter((a) => {
        const age = (t - a.start) / a.span;
        const settled = Math.min(1, Math.max(0, age * 3));
        a.group.scale.y = a.base * (a.from + (1 - a.from) * (1 - Math.pow(1 - settled, 3)));
        a.rings.forEach((ring, i) => {
          const life = Math.min(1, Math.max(0, age * 1.5 - i * 0.22));
          const size = 2.5 + life * 7;
          ring.scale.set(size, 1, size);
          ring.visible = life > 0 && life < 1;
        });
        a.material.opacity = 0.95 * (1 - Math.min(1, age));
        if (age < 1) return true;
        for (const ring of a.rings) scene.remove(ring);
        a.material.dispose();
        a.geometry.dispose();
        a.group.scale.y = a.base;
        return false;
      });
    },
  };
}
