import * as THREE from "three";
import { SIGN_BASE_PAST_DISK, signFit } from "../../../../../shared/valley/plan.ts";
import { SCREEN } from "../../../../../shared/valley/screen.ts";
import { hash } from "../../../../../shared/valley/terrain.ts";
import { canvasTexture } from "./kit.ts";
import type { Animate, Env, Kit } from "./kit.ts";

// A digital sign on a turntable: a square base fixed to the roof and clear of its raised
// edge, a collar on that, and a disk that carries the posts and the screen round to face the
// camera, a moment behind it, as a motor would. All of it is sized to the roof it's on.
// It only ever turns because the view did. Lit only while the place is known to be
// running, like its windows: dimmed, it still says whose it is.

const BASE_H = 0.05; // with the collar, it lifts the disk clear of the roof's raised edge
const COLLAR_H = 0.03;

export function createSigns(kit: Kit, env: Env) {
  const { unit, cylinder, signFace, plain, mesh, keep, own, bake } = kit;
  const faces = new Map<string, THREE.CanvasTexture>();

  // The logo on a dark screen, tinted by what the light over it says (shared/valley/screen.ts).
  // The letter shows until the logo has loaded, and stays if there's none, or it won't load.
  function face(letter: string, url: string | undefined, tint?: string, back = SCREEN): THREE.CanvasTexture {
    const key = `${url ?? ""}|${letter}|${tint ?? ""}|${back}`;
    const had = faces.get(key);
    if (had) return had;
    const screen = (c: CanvasRenderingContext2D, s: number) => {
      c.fillStyle = back;
      c.fillRect(0, 0, s, s);
      c.fillStyle = "rgba(255,255,255,0.05)";
      for (let y = 0; y < s; y += 6) c.fillRect(0, y, s, 2);
    };
    const texture = keep(
      canvasTexture(
        128,
        (c, s) => {
          screen(c, s);
          c.fillStyle = tint ?? "#e8f0ff";
          c.font = "600 72px system-ui, sans-serif";
          c.textAlign = "center";
          c.textBaseline = "middle";
          c.fillText(letter, s / 2, s / 2 + 4);
        },
        false,
      ),
    );
    faces.set(key, texture);
    if (url) {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => {
        if (env.stopped) return;
        const canvas = texture.image as HTMLCanvasElement;
        const c = canvas.getContext("2d")!;
        const s = canvas.width;
        const scale = (s - 40) / Math.max(image.naturalWidth || 1, image.naturalHeight || 1);
        const w = (image.naturalWidth || 1) * scale;
        const h = (image.naturalHeight || 1) * scale;
        screen(c, s);
        let source: CanvasImageSource = image;
        if (tint) {
          const painted = document.createElement("canvas");
          painted.width = Math.ceil(w);
          painted.height = Math.ceil(h);
          const p = painted.getContext("2d")!;
          p.drawImage(image, 0, 0, w, h);
          p.globalCompositeOperation = "source-in";
          p.fillStyle = tint;
          p.fillRect(0, 0, w, h);
          source = painted;
        }
        c.drawImage(source, (s - w) / 2, (s - h) / 2, w, h);
        texture.needsUpdate = true;
        env.redraw();
      };
      image.src = url;
    }
    return texture;
  }

  // Room is the short side of what it stands on. Returns the height of its top.
  function sign(group: THREE.Group, texture: THREE.Texture, lit: boolean, x: number, y: number, z: number, wanted: number, room: number, animate: Animate[]): number {
    const { size, radius } = signFit(room, wanted);
    const steel = plain(0x3a3f46, 0.5, 0.6);
    const base = (radius + SIGN_BASE_PAST_DISK) * 2;
    group.add(mesh(unit, plain(0x4a4f56, 0.75, 0.3), x, y, z, base, BASE_H, base));
    group.add(mesh(cylinder, plain(0x565b62, 0.6, 0.5), x, y + BASE_H, z, radius * 2.06, COLLAR_H, radius * 2.06));
    const head = new THREE.Group();
    const on = y + BASE_H + COLLAR_H;
    head.position.set(x, on, z);
    head.add(mesh(cylinder, plain(0x8b9199, 0.35, 0.75), 0, 0, 0, radius * 2, 0.022, radius * 2, false));
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      head.add(mesh(cylinder, steel, Math.cos(angle) * radius * 0.84, 0.02, Math.sin(angle) * radius * 0.84, 0.04, 0.012, 0.04, false)); // bolts, so the turning shows
    }
    for (const side of [-0.3, 0.3]) head.add(mesh(unit, steel, side * size, 0.02, 0, 0.03, 0.14, 0.03, false));
    const board = size + 0.06;
    // Centred on the line it turns round, so the mast on its top edge stays put as it turns.
    head.add(mesh(unit, plain(0x1a1e24, 0.5, 0.4), 0, 0.15, 0, board, board, 0.04, false));
    const screen = new THREE.Mesh(signFace, own(new THREE.MeshBasicMaterial({ map: texture, color: lit ? 0xffffff : 0x9c9c9c, toneMapped: false })));
    screen.position.set(0, 0.15 + board / 2, 0.032);
    screen.scale.set(size, size, 1);
    head.add(screen);
    bake(head);
    // The building may stand turned to its street, and the sign turns with it.
    const owner = (group.userData.owner as THREE.Group | undefined) ?? group; // it may stand on a part of the place
    const towardCamera = () => Math.atan2(env.camDir.x, env.camDir.z) - owner.rotation.y;
    const lag = 200 + hash(`${owner.position.x},${owner.position.z}`, 40) * 130; // no two motors quite alike
    let yaw = towardCamera();
    let before = 0;
    head.rotation.y = yaw;
    animate.push((t) => {
      const goal = towardCamera();
      const late = Math.atan2(Math.sin(goal - yaw), Math.cos(goal - yaw)); // the short way round
      yaw = t === 0 || !before ? goal : yaw + late * (1 - Math.exp(-Math.max(0, t - before) / lag)); // a still picture has no time to turn in
      before = t;
      head.rotation.y = yaw;
    });
    group.add(head);
    return on + 0.15 + board;
  }

  return { face, sign };
}

export type Signs = ReturnType<typeof createSigns>;
