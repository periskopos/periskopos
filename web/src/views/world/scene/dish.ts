import * as THREE from "three";
import { DISH_DOOR } from "../../../../../shared/valley/hill.ts";
import type { ValleyPlan } from "../../../../../shared/valley/plan.ts";
import { hash, heightAt } from "../../../../../shared/valley/terrain.ts";
import { canvasTexture } from "./kit.ts";
import type { Kit } from "./kit.ts";
import type { Selection } from "./types.ts";

// The watcher: a radio dish on its hill, looking over the valley. It turns only while your
// apps are really being checked, and the vans leave from the door of its shed. It sends out
// no visible light, as a real one doesn't: the turning is what says it's working.
//
// Built as the real thing is: a true parabola, a sub-reflector at its focus on four struts,
// a frame of ribs and hoops behind it, a fork that tilts it, and a turntable on a pedestal.

const RADIUS = 1.5;
const FOCUS = 1.14;
const VERTEX = 0.36; // the bowl's lowest point, above the axle it tilts on
const TILT = 0.95; // back from straight up, towards the horizon
const PAD = 0.03; // the slab is nearly flush, so the vans can drive onto it
const PEDESTAL = 1.52;
const AXLE = 0.72; // above the turntable
const TURN_SPEED = 0.00038;

const bowlAt = (r: number) => VERTEX + (r * r) / (4 * FOCUS);
const UP = new THREE.Vector3(0, 1, 0);
type Point = [number, number, number];

export function createDish(kit: Kit) {
  const { unit, cylinder, sphere, plain, mesh, own, sprite, glow, bake } = kit;

  // A shape turned on a lathe, from [radius, height] pairs. Going up and outwards faces
  // outwards; going back the other way faces in.
  const turned = (sides: number, ...points: [number, number][]) => own(new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), sides));
  const hoop = (radius: number, tube: number, sides = 72) => {
    const shape = own(new THREE.TorusGeometry(radius, tube, 8, sides));
    shape.rotateX(Math.PI / 2);
    return shape;
  };
  const rod = (from: Point, to: Point, thick: number, material: THREE.Material, shadow = false) => {
    const a = new THREE.Vector3(...from);
    const along = new THREE.Vector3(...to).sub(a);
    const m = mesh(cylinder, material, a.x, a.y, a.z, thick, along.length(), thick, shadow);
    m.quaternion.setFromUnitVectors(UP, along.normalize());
    return m;
  };
  const round = (angle: number, r: number, y: number): Point => [Math.cos(angle) * r, y, Math.sin(angle) * r];

  // The bowl's inside: panels bolted together, each a slightly different age. Its top edge
  // is the middle of the bowl and its bottom edge the rim.
  function panels() {
    const texture = own(
      canvasTexture(1024, (c, s) => {
        c.fillStyle = "#f2f0e9";
        c.fillRect(0, 0, s, s);
        const bands: [number, number, number][] = [[0, 0.42, 12], [0.42, 0.72, 24], [0.72, 1, 24]];
        bands.forEach(([from, to, count], band) => {
          const w = s / count;
          for (let i = 0; i < count; i++) {
            c.fillStyle = `rgba(60,58,50,${(hash("dish", band * 50 + i) * 0.05).toFixed(3)})`;
            c.fillRect(i * w, from * s, w, (to - from) * s);
            c.fillStyle = "rgba(70,72,76,0.5)";
            c.fillRect(i * w - 1, from * s, 2, (to - from) * s);
          }
          c.fillRect(0, to * s - 1.5, s, 3);
        });
      }),
    );
    texture.anisotropy = 8;
    return texture;
  }

  function tiltingPart(white: THREE.Material, frame: THREE.Material, steel: THREE.Material, dark: THREE.Material) {
    const tilt = new THREE.Group();
    tilt.position.y = AXLE;
    tilt.rotation.x = TILT;

    // The bowl: a pale face in front and a shell behind, with a rim where they meet.
    const rows = 18;
    const face = Array.from({ length: rows + 1 }, (_, i) => {
      const r = RADIUS * (1 - i / rows);
      return [r, bowlAt(r)] as [number, number];
    });
    const inside = own(new THREE.MeshStandardMaterial({ map: panels(), roughness: 0.62, metalness: 0.05 }));
    const faceOf = mesh(turned(72, ...face), inside, 0, 0, 0, 1, 1, 1, false);
    faceOf.receiveShadow = false; // its own shell, a hair behind it, would only smudge it
    tilt.add(faceOf);
    tilt.add(mesh(turned(72, ...face.map(([r, y]) => [r, y - 0.03] as [number, number]).reverse()), white));
    tilt.add(mesh(hoop(RADIUS, 0.032, 96), white, 0, bowlAt(RADIUS) - 0.012, 0, 1, 1, 1, false));

    // The frame behind it: a hub, ribs out to the rim, hoops round them, and braces.
    const hubLow = VERTEX - 0.32;
    tilt.add(mesh(turned(32, [0, hubLow], [0.33, hubLow], [0.34, hubLow + 0.01], [0.34, VERTEX]), frame));
    const back = (r: number) => bowlAt(r) - 0.05;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
      const stops = [0.3, 0.72, 1.12, RADIUS - 0.03];
      for (let k = 1; k < stops.length; k++) tilt.add(rod(round(a, stops[k - 1]!, back(stops[k - 1]!)), round(a, stops[k]!, back(stops[k]!)), 0.04, frame));
      tilt.add(rod(round(a, 0.28, hubLow + 0.04), round(a, 1.12, back(1.12)), 0.03, frame));
    }
    for (const r of [0.72, 1.12]) tilt.add(mesh(hoop(r, 0.016, 48), frame, 0, back(r), 0, 1, 1, 1, false));

    // What it hears with: a horn up from the middle, and a small reflector at the focus.
    // None of it casts a shadow: at this size they'd only be smudges on the bowl.
    const apex = VERTEX + FOCUS * 0.96;
    tilt.add(mesh(turned(24, [0.2, VERTEX - 0.01], [0.2, VERTEX + 0.06], [0.125, VERTEX + 0.56], [0.15, VERTEX + 0.58], [0.15, VERTEX + 0.62], [0, VERTEX + 0.625]), white, 0, 0, 0, 1, 1, 1, false));
    tilt.add(mesh(cylinder, dark, 0, VERTEX + 0.62, 0, 0.2, 0.012, 0.2, false));
    tilt.add(mesh(turned(28, [0, apex - 0.07], [0.12, apex - 0.045], [0.22, apex], [0.225, apex + 0.03], [0.1, apex + 0.08], [0, apex + 0.09]), white, 0, 0, 0, 1, 1, 1, false));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      tilt.add(rod(round(a, 1.12, bowlAt(1.12)), round(a, 0.13, apex + 0.01), 0.032, steel));
      tilt.add(mesh(unit, steel, ...round(a, 1.12, bowlAt(1.12) - 0.012), 0.07, 0.024, 0.07, false)); // its foot on the bowl
    }

    // The axle it tilts on, and what carries the bowl on it.
    tilt.add(rod([-0.6, 0, 0], [0.6, 0, 0], 0.16, frame));
    tilt.add(mesh(unit, frame, 0, -0.08, 0, 0.56, 0.16, 0.26));
    bake(tilt);

    // A red light on the very top, for aircraft, on only while it's working.
    tilt.add(mesh(sphere, plain(0x8e2a22, 0.4), 0, apex + 0.11, 0, 0.032, 0.032, 0.032, false));
    const lamp = sprite(glow, 0xff4a3a, 0.44, 0.9);
    lamp.position.y = apex + 0.11;
    tilt.add(lamp);
    return { tilt, lamp };
  }

  function turningPart(white: THREE.Material, frame: THREE.Material, steel: THREE.Material, dark: THREE.Material) {
    const pivot = new THREE.Group();
    pivot.position.y = PAD + PEDESTAL;
    pivot.add(mesh(turned(40, [0, 0], [0.43, 0], [0.45, 0.012], [0.45, 0.085], [0.43, 0.1], [0, 0.1]), steel));
    for (let i = 0; i < 12; i++) pivot.add(mesh(cylinder, frame, ...round((i / 12) * Math.PI * 2, 0.39, 0.1), 0.035, 0.014, 0.035, false)); // bolts, so the turning shows
    pivot.add(mesh(unit, white, 0, 0.1, 0, 1.16, 0.12, 0.62)); // the fork's foot

    const shape = new THREE.Shape();
    shape.moveTo(-0.3, 0);
    shape.lineTo(0.3, 0);
    shape.lineTo(0.14, AXLE - 0.22);
    shape.absarc(0, AXLE - 0.22, 0.14, 0, Math.PI, false);
    shape.closePath();
    const arm = own(new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false, curveSegments: 10 }));
    arm.translate(0, 0, -0.04);
    arm.rotateY(Math.PI / 2);
    for (const side of [-1, 1]) {
      pivot.add(mesh(arm, white, side * 0.5, 0.22, 0));
      pivot.add(rod([side * 0.54, AXLE, 0], [side * 0.63, AXLE, 0], 0.26, steel)); // the bearing
    }

    const { tilt, lamp } = tiltingPart(white, frame, steel, dark);
    // The jack that holds the tilt, from the fork's foot to the frame under the bowl.
    tilt.updateMatrix();
    const held = new THREE.Vector3(0, bowlAt(0.78) - 0.06, 0.78).applyMatrix4(tilt.matrix);
    pivot.add(rod([0, 0.2, 0.28], [held.x, held.y, held.z], 0.075, steel));
    bake(pivot);
    pivot.add(tilt);
    return { pivot, lamp };
  }

  function build(plan: ValleyPlan) {
    const base = heightAt(plan, plan.watcher.x, plan.watcher.y);
    const group = new THREE.Group();
    group.position.set(plan.watcher.x, base, plan.watcher.y);
    group.userData.pick = { kind: "tower", id: "watcher" } satisfies Selection;
    const white = plain(0xe6e4dc, 0.62, 0.08);
    const frame = plain(0xa4a8ab, 0.6, 0.25);
    const steel = plain(0x7f8488, 0.5, 0.35);
    const dark = plain(0x2c3034, 0.75);

    // The slab, and the pedestal bolted to it.
    group.add(mesh(turned(56, [1.72, -0.14], [1.72, PAD - 0.015], [1.7, PAD], [0, PAD]), plain(0x9c9a91, 0.95), 0, 0, 0, 1, 1, 1, false));
    group.add(mesh(turned(40, [0.64, PAD], [0.64, PAD + 0.07], [0.62, PAD + 0.085], [0.5, PAD + 0.1], [0.48, PAD + 0.14], [0.3, PEDESTAL - 0.06 + PAD], [0.38, PEDESTAL - 0.05 + PAD], [0.39, PEDESTAL + PAD]), white));
    for (let i = 0; i < 16; i++) group.add(mesh(cylinder, steel, ...round((i / 16) * Math.PI * 2, 0.57, PAD + 0.075), 0.04, 0.02, 0.04, false));
    // Its hatch.
    const hatch = mesh(unit, plain(0x8f9396, 0.55, 0.2), 0, PAD + 0.17, 0.485, 0.2, 0.46, 0.02, false);
    hatch.rotation.x = -0.135;
    group.add(hatch);

    // The shed the vans leave from, with its door to the road, and a cable to the pedestal.
    const shedX = DISH_DOOR.x - 0.55;
    group.add(mesh(unit, plain(0xcfccc1, 0.85), shedX, PAD, DISH_DOOR.z, 0.7, 0.46, 0.56));
    group.add(mesh(unit, plain(0x75787a, 0.8), shedX, PAD + 0.46, DISH_DOOR.z, 0.78, 0.035, 0.64));
    group.add(mesh(unit, plain(0x6d7276, 0.6, 0.3), DISH_DOOR.x - 0.2, PAD, DISH_DOOR.z, 0.014, 0.34, 0.34, false));
    group.add(mesh(unit, dark, shedX + 0.12, PAD + 0.2, DISH_DOOR.z + 0.281, 0.24, 0.14, 0.008, false));
    group.add(mesh(unit, steel, shedX - 0.14, PAD + 0.495, DISH_DOOR.z, 0.2, 0.08, 0.2));
    group.add(rod([DISH_DOOR.x - 0.2, PAD + 0.04, DISH_DOOR.z + 0.2], [-0.2, PAD + 0.04, -0.45], 0.05, dark));

    bake(group);

    const { pivot, lamp } = turningPart(white, frame, steel, dark);
    group.add(pivot);
    group.userData.top = base + 4.2;

    let watching = false;
    let yaw = 0.9;
    return {
      group,
      base,
      setWatching(on: boolean) {
        watching = on;
        lamp.visible = on;
      },
      tick(t: number) {
        if (watching && t) yaw = t * TURN_SPEED;
        pivot.rotation.y = yaw;
        lamp.material.opacity = t ? 0.35 + 0.55 * Math.max(0, Math.sin(t * 0.003)) : 0.9;
      },
      yaw: () => (watching ? yaw : null),
    };
  }

  return { build };
}

export type Dish = ReturnType<ReturnType<typeof createDish>["build"]>;
