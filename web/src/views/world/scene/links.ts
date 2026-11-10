import * as THREE from "three";
import type { World } from "../../../../../shared/world.ts";
import type { Animate, Disposable, Env, Kit } from "./kit.ts";
import type { Selection } from "./types.ts";

// The lines between antennas: each is a real dependency of an app on a provider. Every one
// is always there as a thin line, one draw for the lot, grey where the provider hasn't been
// read. What's in trouble, or being looked at, stands out over it as a solid tube.

const STEPS = 18;

export function createLinks(kit: Kit, env: Env) {
  const { own, scope, free, sprite, glow } = kit;
  const group = new THREE.Group();
  let owned = new Set<Disposable>();
  let thinOwned = new Set<Disposable>();
  let thin: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
  let thinKey = "";
  let animate: Animate[] = [];

  function arc(from: THREE.Vector3, to: THREE.Vector3) {
    const peak = from.clone().lerp(to, 0.5);
    peak.y = Math.max(from.y, to.y) + 0.8 + from.distanceTo(to) * 0.05;
    return new THREE.QuadraticBezierCurve3(from, peak, to);
  }

  function rebuild(world: World, selected: Selection, standing: (id: string) => THREE.Object3D | undefined) {
    free(owned);
    if (thin) group.remove(thin);
    group.clear();
    if (thin) group.add(thin);
    animate = [];
    const lines: { curve: THREE.QuadraticBezierCurve3; look: string }[] = [];
    owned = scope(() => {
      for (const u of world.utilities) {
        const from = standing(`provider:${u.id}`)?.userData.antenna as THREE.Vector3 | undefined;
        if (!from || u.look === "past") continue;
        for (const dep of u.apps) {
          const plot = world.plots.find((p) => p.slug === dep.slug);
          const to = standing(`app:${dep.slug}`)?.userData.antenna as THREE.Vector3 | undefined;
          if (!plot || !to) continue;
          const curve = arc(from, to);
          lines.push({ curve, look: u.look });
          const near = (selected?.kind === "app" && selected.id === plot.slug) || (selected?.kind === "provider" && selected.id === u.id);
          const bad = u.look === "trouble";
          if (!near && !bad && u.look !== "maintenance") continue;
          const color = bad ? env.status.down : u.look === "maintenance" ? env.status.info : u.look === "unknown" ? env.status.unknown : env.status.focus;
          group.add(new THREE.Mesh(own(new THREE.TubeGeometry(curve, 40, near || bad ? 0.036 : 0.024, 6)), own(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: near || bad ? 0.95 : 0.55 }))));
          // A line only carries anything while its provider is known to be fine.
          if (near && u.look === "ok" && plot.moving) {
            for (let i = 0; i < 3; i++) {
              const dot = sprite(glow, env.status.focus, 0.6, 1);
              group.add(dot);
              animate.push((t) => {
                curve.getPointAt((t * 0.00028 + i / 3) % 1, dot.position);
              });
            }
          }
        }
      }
    }).owned;
    drawThin(lines);
    // The more of them there are, the fainter: a crowded valley's lines are a haze, not a mess.
    if (thin) thin.material.opacity = (env.dusk ? 0.75 : 0.6) * (selected ? 0.5 : 1) * Math.max(0.28, Math.min(1, 30 / lines.length));
  }

  function drawThin(lines: { curve: THREE.QuadraticBezierCurve3; look: string }[]) {
    const key = `${env.dusk}|${lines.map((l) => `${l.look}:${l.curve.v0.toArray()}:${l.curve.v2.toArray()}`).join(";")}`;
    if (key === thinKey) return;
    thinKey = key;
    if (thin) group.remove(thin);
    free(thinOwned);
    thin = null;
    if (lines.length === 0) return;
    thinOwned = scope(() => {
      const places = new Float32Array(lines.length * STEPS * 6);
      const colors = new Float32Array(lines.length * STEPS * 6);
      const here = new THREE.Vector3();
      const next = new THREE.Vector3();
      lines.forEach(({ curve, look }, l) => {
        const tone = look === "unknown" ? env.status.unknown : look === "trouble" ? env.status.down : look === "maintenance" ? env.status.info : env.status.focus;
        for (let s = 0; s < STEPS; s++) {
          curve.getPoint(s / STEPS, here);
          curve.getPoint((s + 1) / STEPS, next);
          const at = (l * STEPS + s) * 6;
          places.set([here.x, here.y, here.z, next.x, next.y, next.z], at);
          colors.set([tone.r, tone.g, tone.b, tone.r, tone.g, tone.b], at);
        }
      });
      const geometry = own(new THREE.BufferGeometry());
      geometry.setAttribute("position", new THREE.BufferAttribute(places, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      thin = new THREE.LineSegments(geometry, own(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false, toneMapped: false })));
      group.add(thin);
    }).owned;
  }

  return {
    group,
    rebuild,
    tick(t: number) {
      for (const a of animate) a(t);
    },
  };
}
