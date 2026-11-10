import * as THREE from "three";
import { FOOTPRINT } from "../../../../../shared/valley/growth.ts";
import { CAMPUS_SCALE } from "../../../../../shared/valley/plan.ts";
import { riseAt } from "../../../../../shared/valley/lay.ts";
import { screenBack, shareFor } from "../../../../../shared/valley/screen.ts";
import { hash } from "../../../../../shared/valley/terrain.ts";
import type { Plot, Utility } from "../../../../../shared/world.ts";
import { antennaLight, campusSize, carsFor } from "../../../../../shared/world.ts";
import type { Buildings, Mode } from "./buildings.ts";
import type { Effects } from "./effects.ts";
import type { Animate, Env, Kit } from "./kit.ts";
import type { Signs } from "./signs.ts";
import type { Selection } from "./types.ts";

// Campuses and service plants: everything that stands on a block.

export type Built = { group: THREE.Group; animate: Animate[] };

const LOGOS = import.meta.glob("../../../logos/*.svg", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
// The same logos as the Accounts page; a brand that's black or nearly is white here,
// on a dark screen. Logos: Simple Icons, CC0.
const LOGO_COLORS: Record<string, string> = {
  cloudflare: "#f38020", supabase: "#3fcf8e", digitalocean: "#2f96ff", netlify: "#00c7b7", fly: "#9d6bff", stripe: "#8780ff", paddle: "#fddd35", gitlab: "#fc6d26",
  aws: "#ff9900", neon: "#00e599", mongodb: "#47a248", sendgrid: "#3b9bf0", "google-analytics": "#e37400", clerk: "#9478ff", "search-console": "#4285f4",
};
const PARKED = [0xd9dce1, 0x2c3440, 0xb5403a, 0x3a6ea5, 0xe0b23c, 0x5c6670, 0xeeeeea];
const BAYS = 8;
const CAMPUS_HALF = 1.24;
const OVER_SIGN = 0.2; // how far above the sign's top edge its light is, on a short mast
const SCAFFOLD_DECK = 1.28; // the top deck of a building going up
const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? "?";

export function createPlaces(kit: Kit, env: Env, { building }: Buildings, effects: Effects, { face, sign }: Signs) {
  const { unit, cylinder, plain, mesh, bake } = kit;
  // A headquarters' grounds. All scenery: only its size and how full the car park is say
  // anything.
  function grounds(group: THREE.Group, footprint: number) {
    group.add(mesh(unit, plain(0xa4a49c, 0.95), 0, 0, 0, CAMPUS_HALF * 2 + 0.1, 0.05, CAMPUS_HALF * 2 + 0.1, false)); // kerb
    group.add(mesh(unit, plain(0x7c8f4d, 1), 0, 0.012, 0, CAMPUS_HALF * 2, 0.05, CAMPUS_HALF * 2, false));
    const court = 0.98 * footprint;
    const stone = plain(0xc6bfad, 0.95);
    group.add(mesh(unit, stone, 0, 0.05, -0.1, court * 2, 0.016, court * 1.7, false));
    group.add(mesh(unit, stone, 0, 0.05, 0.8, 0.3, 0.016, 0.2, false)); // the walk to the car park
    const asphalt = plain(0x4d5054, 0.95);
    group.add(mesh(unit, asphalt, 0, 0.05, 1.02, 2.3, 0.016, 0.38, false));
    group.add(mesh(unit, asphalt, 1.3, 0.05, 1.02, 0.5, 0.016, 0.16, false)); // the driveway, out to the avenue
    const line = plain(0xd8d5c8, 0.9);
    for (let i = 0; i <= BAYS; i++) group.add(mesh(unit, line, -1.04 + i * 0.26, 0.066, 1.02, 0.012, 0.002, 0.34, false));
  }

  // The car park fills with the app's traffic: no traffic known to be there, no cars.
  // Which bays are taken comes from its name.
  function parkedCars(group: THREE.Group, seed: string, count: number) {
    const bays = Array.from({ length: BAYS }, (_, i) => i).sort((a, b) => hash(seed, a + 900) - hash(seed, b + 900));
    for (const i of bays.slice(0, count)) {
      const color = PARKED[Math.floor(hash(seed, i + 910) * PARKED.length)]!;
      const x = -0.91 + i * 0.26;
      group.add(mesh(unit, plain(color, 0.4, 0.3), x, 0.066, 1.02, 0.13, 0.05, 0.25));
      group.add(mesh(unit, plain(0x1f2730, 0.3, 0.4), x, 0.116, 1.02, 0.1, 0.035, 0.14));
    }
  }

  // On top of the sign, in the middle: the logo and its light in one place. Lines end at its tip.
  function aerial(group: THREE.Group, x: number, signTop: number, z: number, on = group) {
    const tip = signTop + OVER_SIGN;
    effects.antenna(on, x, signTop, z, tip);
    group.updateMatrix();
    group.userData.antenna = new THREE.Vector3(x, tip, z).applyMatrix4(group.matrix);
    return tip;
  }

  // The screen behind the logo says what the light says, in the theme's own status colours.
  const backOf = (light: ReturnType<typeof antennaLight>) => (light ? screenBack(`#${env.status[light.tone].getHexString()}`, shareFor(light.tone)) : screenBack(null));

  function campus(plot: Plot): Built {
    const group = new THREE.Group();
    const animate: Animate[] = [];
    group.position.set(plot.x, riseAt(plot.x, plot.y), plot.y);
    group.rotation.y = plot.turn;
    group.scale.setScalar(CAMPUS_SCALE);
    group.userData.pick = { kind: "app", id: plot.slug } satisfies Selection;
    group.userData.light = antennaLight(plot.look);
    const footprint = FOOTPRINT[campusSize(plot)];
    const logo = face(initial(plot.name), plot.icon, undefined, backOf(group.userData.light as ReturnType<typeof antennaLight>));
    if (plot.look === "empty" || plot.look === "scaffold") {
      group.add(mesh(unit, plain(0xa4a49c, 0.95), 0, 0, 0, CAMPUS_HALF * 2 + 0.1, 0.05, CAMPUS_HALF * 2 + 0.1, false));
      group.add(mesh(unit, plain(plot.look === "empty" ? 0x8f9a5e : 0xa5a59e, 0.96), 0, 0.012, 0, CAMPUS_HALF * 2, 0.05, CAMPUS_HALF * 2, false));
      if (plot.look === "empty") effects.fencedPlot(group);
      const under = plot.look === "scaffold" ? effects.scaffold(group, plot) : 0.03;
      const signTop = sign(group, logo, false, 0, under, 0, plot.look === "scaffold" ? 0.8 : 0.72, plot.look === "scaffold" ? SCAFFOLD_DECK : CAMPUS_HALF * 2, animate);
      group.userData.top = signTop + 0.12;
      aerial(group, 0, signTop, 0);
      bake(group);
    } else {
      grounds(group, footprint);
      parkedCars(group, plot.slug, Math.min(BAYS, carsFor(plot) * 2));
      const mode: Mode = plot.look === "dark" || plot.look === "fog" ? "off" : plot.look === "frozen" ? "frozen" : "lit";
      // What comes up out of the ground when it grows: everything but its grounds.
      const rising = new THREE.Group();
      rising.userData.owner = group;
      rising.userData.footprint = footprint;
      group.add(rising);
      const hq = new THREE.Group();
      hq.scale.set(footprint, 1, footprint);
      const { top, x, z, w, d } = building(plot, hq, mode);
      bake(hq);
      rising.add(hq);
      const signTop = sign(rising, logo, plot.look === "lit" || plot.look === "warning", x * footprint, top, z * footprint, 0.8, Math.min(w, d) * footprint, animate);
      const tip = aerial(group, x * footprint, signTop, z * footprint, rising);
      bake(group);
      bake(rising);
      rising.userData.height = tip + 0.1;
      group.userData.rising = rising;
      group.userData.top = signTop + 0.32;
      const over = new THREE.Group(); // over the sign, wherever that stands on this roof
      over.position.set(x * footprint, 0, z * footprint);
      rising.add(over);
      if (plot.look === "dark") {
        effects.smoke(over, plot.slug, top, animate);
        effects.groundRing(group, env.status.down, animate);
        effects.redGlow(group, animate);
      }
      if (plot.look === "fog") effects.fogBank(group, plot.slug, top, 2, animate);
      if (plot.work === "deploying") effects.crane(rising, top, animate);
      if (plot.work === "waiting") effects.stoppedTruck(group);
    }
    group.userData.top = (group.userData.top as number) * CAMPUS_SCALE + group.position.y;
    group.userData.standingTop = group.userData.top;
    return { group, animate };
  }

  // A provider: a long windowless-looking hall with its plant beside it, as a data
  // centre has. What's beside it differs from one provider to the next.
  function plant(u: Utility): Built {
    const group = new THREE.Group();
    const animate: Animate[] = [];
    group.position.set(u.x, riseAt(u.x, u.y), u.y);
    group.rotation.y = u.turn;
    group.scale.setScalar(CAMPUS_SCALE);
    group.userData.pick = { kind: "provider", id: u.id } satisfies Selection;
    group.userData.light = antennaLight(u.look);
    const seed = u.id;
    group.add(mesh(unit, plain(0xa4a49c, 0.95), 0, 0, 0, CAMPUS_HALF * 2 + 0.1, 0.05, CAMPUS_HALF * 2 + 0.1, false));
    group.add(mesh(unit, plain(0x9c9c94, 0.96), 0, 0.012, 0, CAMPUS_HALF * 2, 0.05, CAMPUS_HALF * 2, false));
    const wall = u.look === "unknown" ? "#6f7780" : ["#c2c0b6", "#aebbc2", "#c6b9a6", "#b3bfae"][Math.floor(hash(seed, 1) * 4)]!;
    const side = hash(seed, 2) > 0.5 ? 1 : -1;
    const kind = Math.floor(hash(seed, 3) * 3);
    const HALL = 1.02;
    const hx = -0.32 * side;
    group.add(mesh(unit, plain(wall, 0.85), hx, 0.05, -0.2, 1.3, HALL, 1.5));
    group.add(mesh(unit, plain(0x6d7277, 0.8), hx, 0.05 + HALL, -0.2, 1.36, 0.05, 1.56));
    group.add(mesh(unit, plain(0x34383c, 0.7), hx, 0.05, 0.56, 0.3, 0.3, 0.02, false));
    // A band of windows, lit only while it's known to be running.
    const running = u.look === "ok" || u.look === "maintenance";
    const band = running ? (env.dusk ? plain(0xffd9a0, 0.4, 0, 0xffb066, 0.45) : plain(0x6f8a99, 0.3, 0.2)) : plain(0x20262c, 0.4);
    for (const at of [0.42, 0.74]) group.add(mesh(unit, band, hx, at, -0.2, 1.32, 0.13, 1.52, false));
    const px = 0.72 * side;
    if (kind === 0) {
      for (let i = 0; i < 3; i++) {
        const z = -0.7 + i * 0.5;
        group.add(mesh(cylinder, plain(0xc0c4c8, 0.45, 0.45), px, 0.05, z, 0.34, 0.42, 0.34));
        group.add(mesh(cylinder, plain(0xd3d6d9, 0.4, 0.4), px, 0.47, z, 0.1, 0.1, 0.1));
      }
    } else if (kind === 1) {
      for (let i = 0; i < 4; i++) {
        const z = -0.8 + i * 0.42;
        group.add(mesh(unit, plain(0xb4b8bb, 0.6, 0.3), px, 0.05, z, 0.46, 0.22, 0.3));
        group.add(mesh(cylinder, plain(0x4b5157, 0.5, 0.5), px, 0.27, z, 0.22, 0.015, 0.22, false));
      }
    } else {
      // A cooling stack, wider at its foot, with a dark mouth.
      group.add(mesh(cylinder, plain(0xb4b8bb, 0.6, 0.3), px, 0.05, -0.3, 0.42, 0.26, 0.42));
      group.add(mesh(cylinder, plain(0xc0c4c8, 0.45, 0.45), px, 0.31, -0.3, 0.26, 0.74, 0.26));
      group.add(mesh(cylinder, plain(0x2b2f33, 0.8), px, 1.05, -0.3, 0.2, 0.012, 0.2, false));
      group.add(mesh(unit, plain(0xb4b8bb, 0.6, 0.3), px, 0.05, 0.3, 0.42, 0.2, 0.5));
    }
    const logo = LOGOS[`../../../logos/${u.id}.svg`];
    const signTop = sign(group, face(initial(u.label), logo, logo ? (LOGO_COLORS[u.id] ?? "#f4f7fb") : undefined, backOf(group.userData.light as ReturnType<typeof antennaLight>)), running, hx, 0.1 + HALL, -0.2, 0.7, 1.3, animate);
    aerial(group, hx, signTop, -0.2);
    bake(group);
    group.userData.top = (signTop + 0.3) * CAMPUS_SCALE + group.position.y;
    if (u.look === "unknown") effects.fogBank(group, seed, 1, 1.5, animate);
    if (u.look === "trouble") effects.groundRing(group, env.status.down, animate);
    return { group, animate };
  }

  return { campus, plant };
}

export type Places = ReturnType<typeof createPlaces>;
