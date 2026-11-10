import * as THREE from "three";
import { hash } from "../../../../../shared/valley/terrain.ts";
import type { AntennaLight } from "../../../../../shared/world.ts";
import type { Env, Kit } from "./kit.ts";

// The lights on the antennas, all of them one draw for the lit point and one for its glow.
// A light says what the data says (see antennaLight): where nothing is known there's no
// light, and a still picture shows them steady.

export type Lamp = { id: string; at: THREE.Vector3; light: NonNullable<AntennaLight> };

const LARGER = { up: 1, info: 1, attention: 1.25, down: 1.5 } as const;

// How bright a light is at a moment, from 0 to 1. The calm ones breathe, the others flash.
function brightness(t: number, every: number, phase: number, flashes: boolean): number {
  const wave = ((t / every + phase) % 1) * Math.PI * 2;
  const up = 0.5 + 0.5 * Math.sin(wave);
  return flashes ? 0.12 + 0.88 * up * up * up : 0.72 + 0.28 * up;
}

export function createLamps(kit: Kit, env: Env) {
  const group = new THREE.Group();
  const geometry = kit.keep(new THREE.BufferGeometry());
  let lamps: { every: number; phase: number; flashes: boolean }[] = [];
  let key = "";

  // Sizes are a picture's pixels at a given distance, and never smaller than can be seen.
  function material(blending: THREE.Blending, smallest: number): THREE.PointsMaterial {
    const m = kit.keep(new THREE.PointsMaterial({ map: kit.glow, vertexColors: true, transparent: true, depthWrite: false, blending, fog: false, toneMapped: false, sizeAttenuation: true }));
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "attribute float larger;\n#include <common>")
        .replace("gl_PointSize = size;", "gl_PointSize = size * larger;")
        .replace("#include <fog_vertex>", `gl_PointSize = max(gl_PointSize, ${smallest.toFixed(1)});\n#include <fog_vertex>`);
    };
    m.customProgramCacheKey = () => `lamp-${smallest}`;
    return m;
  }
  const glow = material(THREE.AdditiveBlending, 16);
  const point = material(THREE.NormalBlending, 9);
  const glowing = new THREE.Points(geometry, glow);
  const lit = new THREE.Points(geometry, point);
  glowing.frustumCulled = lit.frustumCulled = false;
  group.add(glowing, lit);

  function set(next: Lamp[]) {
    const nextKey = `${env.dusk}|${next.map((l) => `${l.id}:${l.light.tone}:${l.light.every}:${l.at.x},${l.at.y},${l.at.z}`).join(";")}`;
    // Light adds up against a dark sky. In daylight it would wash out, so it's painted on.
    glow.blending = env.dusk ? THREE.AdditiveBlending : THREE.NormalBlending;
    glow.size = env.dusk ? 3.6 : 2.6;
    point.size = env.dusk ? 1.1 : 1.5;
    glow.opacity = env.dusk ? 1 : 0.65;
    if (nextKey === key) return;
    key = nextKey;
    const places = new Float32Array(next.length * 3);
    const colors = new Float32Array(next.length * 4);
    const larger = new Float32Array(next.length);
    next.forEach((lamp, i) => {
      places.set([lamp.at.x, lamp.at.y, lamp.at.z], i * 3);
      const c = env.status[lamp.light.tone];
      colors.set([c.r, c.g, c.b, 1], i * 4);
      larger[i] = LARGER[lamp.light.tone];
    });
    geometry.setAttribute("position", new THREE.BufferAttribute(places, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
    geometry.setAttribute("larger", new THREE.BufferAttribute(larger, 1));
    lamps = next.map((lamp) => ({ every: lamp.light.every, phase: hash(lamp.id, 77), flashes: lamp.light.tone === "attention" || lamp.light.tone === "down" }));
    group.visible = next.length > 0;
  }

  return {
    group,
    set,
    tick(t: number) {
      const colors = geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
      if (!colors) return;
      lamps.forEach((lamp, i) => colors.setW(i, t === 0 ? 1 : brightness(t, lamp.every, lamp.phase, lamp.flashes)));
      colors.needsUpdate = true;
    },
  };
}

export type Lamps = ReturnType<typeof createLamps>;
