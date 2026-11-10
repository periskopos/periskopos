import * as THREE from "three";
import { hash } from "../../../../../shared/valley/terrain.ts";
import type { Plot } from "../../../../../shared/world.ts";
import { FLOOR_H } from "./effects.ts";
import type { Env, Kit } from "./kit.ts";

// An app's offices: wide and low where few things are watched, a floor for each one. Its
// shape and colours come from its name, so each one is recognisably itself. Valley
// offices are mostly glass and pale concrete.

export type Mode = "lit" | "off" | "frozen";

const WALLS = ["#d9d6cd", "#e4ddd0", "#c9bfae", "#cfd3d4", "#b9bfc2", "#ddd0bb"];
const ROOFS = ["#7d8187", "#6f6a62", "#6a747c", "#878279"];

export function createBuildings(kit: Kit, env: Env) {
  const { unit, tower, plain, mesh, keep, cached } = kit;

  // A floor's bay of wall and window, repeated across a building's face. Only a serving
  // app has any lights on.
  function facade(wall: string, seed: string, cols: number, rows: number, mode: Mode, kind: number): THREE.MeshStandardMaterial {
    return cached(`f:${wall}:${seed}:${cols}:${rows}:${mode}:${env.dusk}:${kind}`, () => {
      const W = 48 * cols;
      const H = 72 * rows;
      // Punched windows in a wall, bands of window, or a wall that's nearly all glass.
      const opening = kind === 1 ? { x: 0, y: 20, w: 48, h: 36 } : kind === 2 ? { x: 2, y: 5, w: 44, h: 62 } : { x: 8, y: 16, w: 32, h: 42 };
      const paint = (c: CanvasRenderingContext2D, emissive: boolean) => {
        const sharp = emissive ? 1 : 2; // the glow doesn't need the detail, so it costs less
        c.canvas.width = W * sharp;
        c.canvas.height = H * sharp;
        c.scale(sharp, sharp);
        c.fillStyle = emissive ? "#000000" : wall;
        c.fillRect(0, 0, W, H);
        for (let r = 0; r < rows; r++) {
          for (let k = 0; k < cols; k++) {
            const on = mode === "lit" && hash(seed, r * 31 + k) > 0.42;
            const x = k * 48 + opening.x;
            const y = r * 72 + opening.y;
            const { w, h } = opening;
            if (emissive) {
              if (!on) continue;
              c.fillStyle = hash(seed, r * 7 + k + 500) > 0.8 ? "#bcd8ff" : "#ffd38f";
              c.fillRect(x + 1, y + 1, w - 2, h - 2);
              continue;
            }
            c.fillStyle = "rgba(0,0,0,0.38)";
            c.fillRect(x - 1.5, y - 1.5, w + 3, h + 3);
            const glass = c.createLinearGradient(x, y, x, y + h);
            const [top, bottom] = mode === "frozen" ? ["#c4d2dc", "#8fa2b0"] : mode === "off" ? ["#11151a", "#1c2229"] : kind === 2 ? ["#8ab9d6", "#2c4a62"] : ["#9fc4dc", "#3e5a70"];
            glass.addColorStop(0, top!);
            glass.addColorStop(1, bottom!);
            c.fillStyle = glass;
            c.fillRect(x, y, w, h);
            if (mode !== "off") {
              // The sky caught across the glass.
              c.save();
              c.beginPath();
              c.rect(x, y, w, h);
              c.clip();
              c.fillStyle = "rgba(255,255,255,0.16)";
              const slant = hash(seed, r * 13 + k + 900) * 20;
              c.beginPath();
              c.moveTo(x + slant, y + h);
              c.lineTo(x + slant + h * 0.6, y);
              c.lineTo(x + slant + h * 0.6 + 12, y);
              c.lineTo(x + slant + 12, y + h);
              c.fill();
              c.restore();
            }
            c.fillStyle = "rgba(24,28,33,0.75)";
            c.fillRect(x + w / 2 - 0.75, y, 1.5, h);
            if (kind !== 1) c.fillRect(x, y + h * 0.34, w, 1.25);
          }
          if (emissive) continue;
          // The line between floors: each floor is one thing watched, so it should read.
          c.fillStyle = kind === 2 ? "rgba(14,17,21,0.7)" : "rgba(255,255,255,0.13)";
          c.fillRect(0, r * 72, W, kind === 2 ? 3 : 2.5);
          c.fillStyle = "rgba(0,0,0,0.14)";
          c.fillRect(0, r * 72 + (kind === 2 ? 3 : 2.5), W, 1.5);
        }
        if (!emissive) {
          const shade = c.createLinearGradient(0, 0, 0, H);
          shade.addColorStop(0, "rgba(0,0,0,0)");
          shade.addColorStop(1, "rgba(0,0,0,0.18)");
          c.fillStyle = shade;
          c.fillRect(0, 0, W, H);
        }
      };
      const map = keep(new THREE.CanvasTexture(document.createElement("canvas")));
      paint(map.image.getContext("2d")!, false);
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = 8;
      const glowMap = keep(new THREE.CanvasTexture(document.createElement("canvas")));
      paint(glowMap.image.getContext("2d")!, true);
      glowMap.colorSpace = THREE.SRGBColorSpace;
      return new THREE.MeshStandardMaterial({ map, roughness: 0.55, metalness: 0.08, emissive: 0xffffff, emissiveMap: glowMap, emissiveIntensity: mode !== "lit" ? 0 : env.dusk ? 0.55 : 0.12 });
    });
  }

  // Where the sign can stand on this roof, how high that is, and how big the roof is.
  function building(plot: Plot, group: THREE.Group, mode: Mode): { top: number; x: number; z: number; w: number; d: number } {
    const seed = plot.slug;
    const glassy = hash(seed, 14);
    const kind = glassy < 0.5 ? 2 : glassy < 0.78 ? 1 : 0;
    const wall = mode === "frozen" ? "#a9b4bf" : mode === "off" ? "#54575c" : kind === 2 ? "#39434e" : WALLS[Math.floor(hash(seed, 11) * WALLS.length)]!;
    const roof = mode === "frozen" ? "#e8eef3" : mode === "off" ? "#25282c" : ROOFS[Math.floor(hash(seed, 12) * ROOFS.length)]!;
    const roofM = plain(roof, 0.9);
    const edge = plain(mode === "frozen" ? "#f2f6f9" : `#${new THREE.Color(wall).multiplyScalar(0.82).getHexString()}`, 0.85);
    const lobby = mode === "lit" ? plain(0xffd9a0, 0.35, 0, 0xffc27a, env.dusk ? 1.5 : 0.25) : mode === "frozen" ? plain(0xb7c6d1, 0.4) : plain(0x1a2026, 0.35);

    const body = (w: number, d: number, floors: number, base: number, x: number, z: number) => {
      const front = facade(wall, seed, Math.max(2, Math.round(w * 3)), floors, mode, kind);
      const side = facade(wall, `${seed}s`, Math.max(2, Math.round(d * 3)), floors, mode, kind);
      const height = floors * FLOOR_H;
      const roofAt = base + 0.05 + height;
      group.add(mesh(tower, [side, roofM, front], x, base + 0.05, z, w, height, d));
      // A raised edge round the roof, with the roof showing inside it.
      const rim = 0.045;
      group.add(mesh(unit, edge, x, roofAt - 0.01, z + d / 2, w + 0.05, 0.07, rim, false));
      group.add(mesh(unit, edge, x, roofAt - 0.01, z - d / 2, w + 0.05, 0.07, rim, false));
      group.add(mesh(unit, edge, x + w / 2, roofAt - 0.01, z, rim, 0.07, d + 0.05, false));
      group.add(mesh(unit, edge, x - w / 2, roofAt - 0.01, z, rim, 0.07, d + 0.05, false));
      if (base === 0) {
        // Where it meets the ground: a plinth and a glazed lobby all round.
        group.add(mesh(unit, plain(0x8d8c86, 0.9), x, 0.02, z, w + 0.09, 0.05, d + 0.09, false));
        for (const face of [-1, 1]) {
          group.add(mesh(unit, lobby, x, 0.07, z + (face * d) / 2, w * 0.86, 0.2, 0.02, false));
          group.add(mesh(unit, lobby, x + (face * w) / 2, 0.07, z, 0.02, 0.2, d * 0.86, false));
        }
      }
      return roofAt;
    };

    const style = Math.floor(hash(seed, 13) * 4);
    if (style === 1 && plot.floors >= 3) {
      // Set back above the lower floors.
      const low = Math.ceil(plot.floors / 2);
      const under = body(1.7, 1.3, low, 0, 0, -0.08);
      return { top: body(1.15, 1, plot.floors - low, under - 0.05, 0, -0.08), x: 0, z: -0.08, w: 1.15, d: 1 };
    }
    if (style === 2) {
      // A long block with a lower wing.
      const top = body(1.15, 1.45, plot.floors, 0, -0.36, -0.08);
      body(0.74, 1.05, Math.max(1, plot.floors - 2), 0, 0.6, -0.2);
      return { top, x: -0.36, z: -0.08, w: 1.15, d: 1.45 };
    }
    if (style === 3 && plot.floors >= 2) {
      // Four wings round a courtyard, the back one the tallest and deep enough for its sign.
      const top = body(1.72, 0.8, plot.floors, 0, 0, -0.46);
      const low = Math.max(1, plot.floors - 1);
      body(1.72, 0.32, low, 0, 0, 0.5);
      body(0.34, 0.68, low, 0, -0.69, -0.05);
      body(0.34, 0.68, low, 0, 0.69, -0.05);
      return { top, x: 0, z: -0.46, w: 1.72, d: 0.8 };
    }
    return { top: body(1.75, 1.3, plot.floors, 0, 0, -0.08), x: 0, z: -0.08, w: 1.75, d: 1.3 };
  }

  return { building };
}

export type Buildings = ReturnType<typeof createBuildings>;
