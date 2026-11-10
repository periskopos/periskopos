import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { hash } from "../../../../../shared/valley/terrain.ts";

// What every part of the picture shares: the shapes and materials there's only ever one
// of, and the book-keeping that frees it all on leaving the page.

export type Disposable = { dispose(): void };

export type Status = Record<"down" | "attention" | "info" | "up" | "unknown" | "focus", THREE.Color>;

// What's true of the picture as a whole, read by whatever is being built or animated.
export type Env = {
  dusk: boolean;
  status: Status;
  camDir: THREE.Vector3; // from what's looked at towards the camera
  inFront: THREE.Vector3; // a little way towards the camera, to lift flat puffs off walls
  stopped: boolean;
  redraw(): void;
};

export type Animate = (t: number) => void;

export function canvasTexture(size: number, paint: (c: CanvasRenderingContext2D, size: number) => void, repeat = true): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  paint(canvas.getContext("2d")!, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

export function createKit() {
  const made = new Set<Disposable>();
  const keep = <T extends Disposable>(thing: T): T => {
    made.add(thing);
    return thing;
  };

  // What one campus or one stretch of land made for itself alone, freed when it's rebuilt.
  // Cached materials are shared, so they stay until the page is left.
  let owner: Set<Disposable> | null = null;
  const own = <T extends Disposable>(thing: T): T => {
    owner?.add(thing);
    return keep(thing);
  };
  function scope<T>(make: () => T): { value: T; owned: Set<Disposable> } {
    const before = owner;
    const owned = new Set<Disposable>();
    owner = owned;
    try {
      return { value: make(), owned };
    } finally {
      owner = before;
    }
  }
  function free(owned: Set<Disposable>) {
    for (const thing of owned) {
      thing.dispose();
      made.delete(thing);
    }
  }

  const unit = keep(new THREE.BoxGeometry(1, 1, 1));
  unit.translate(0, 0.5, 0); // a box stands on the ground
  // The same box in three draws: walls either side, roof, front and back.
  const tower = keep(unit.clone());
  tower.clearGroups();
  tower.addGroup(0, 12, 0);
  tower.addGroup(12, 6, 1);
  tower.addGroup(24, 12, 2);
  const cylinder = keep(new THREE.CylinderGeometry(0.5, 0.5, 1, 14));
  cylinder.translate(0, 0.5, 0);
  const cone = keep(new THREE.ConeGeometry(0.5, 1, 7));
  cone.translate(0, 0.5, 0);
  const sphere = keep(new THREE.IcosahedronGeometry(1, 2));
  const signFace = keep(new THREE.PlaneGeometry(1, 1));

  const glow = keep(
    canvasTexture(
      128,
      (c, s) => {
        const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        g.addColorStop(0, "rgba(255,255,255,1)");
        g.addColorStop(0.3, "rgba(255,255,255,0.45)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        c.fillStyle = g;
        c.fillRect(0, 0, s, s);
      },
      false,
    ),
  );
  const puff = keep(
    canvasTexture(
      128,
      (c, s) => {
        for (let i = 0; i < 26; i++) {
          const x = s * (0.28 + hash("puff", i) * 0.44);
          const y = s * (0.28 + hash("puff", i + 40) * 0.44);
          const r = s * (0.1 + hash("puff", i + 80) * 0.16);
          const g = c.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, "rgba(255,255,255,0.3)");
          g.addColorStop(1, "rgba(255,255,255,0)");
          c.fillStyle = g;
          c.fillRect(0, 0, s, s);
        }
      },
      false,
    ),
  );

  const materials = new Map<string, THREE.Material>();
  function cached<T extends THREE.Material>(key: string, make: () => T): T {
    let m = materials.get(key);
    if (!m) {
      m = keep(make());
      materials.set(key, m);
    }
    return m as T;
  }
  function plain(color: THREE.ColorRepresentation, roughness = 0.85, metalness = 0, emissive?: THREE.ColorRepresentation, emissiveIntensity = 1): THREE.MeshStandardMaterial {
    const key = `p:${new THREE.Color(color).getHex()}:${roughness}:${metalness}:${emissive === undefined ? "" : new THREE.Color(emissive).getHex()}:${emissiveIntensity}`;
    return cached(key, () => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...(emissive !== undefined ? { emissive, emissiveIntensity } : {}) }));
  }

  function mesh(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, shadow = true): THREE.Mesh {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.castShadow = shadow;
    m.receiveShadow = true;
    return m;
  }

  function sprite(texture: THREE.Texture, color: THREE.ColorRepresentation, size: number, opacity: number, additive = true): THREE.Sprite {
    const material = own(new THREE.SpriteMaterial({ map: texture, color, opacity, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending }));
    const s = new THREE.Sprite(material);
    s.scale.set(size, size, size);
    return s;
  }

  // Draws everything in a group that never moves and shares a material as one thing.
  // Call it before adding anything that moves later.
  function bake(group: THREE.Object3D) {
    const sets = new Map<string, THREE.Mesh[]>();
    for (const child of group.children) {
      if ((child.constructor as unknown) !== THREE.Mesh || child.children.length) continue;
      const m = child as THREE.Mesh;
      if (!(m.material instanceof THREE.MeshStandardMaterial) || m.material.transparent) continue;
      const key = `${m.material.uuid}|${m.castShadow}|${m.receiveShadow}`;
      const set = sets.get(key);
      if (set) set.push(m);
      else sets.set(key, [m]);
    }
    for (const meshes of sets.values()) {
      if (meshes.length < 2) continue;
      const parts = meshes.map((m) => {
        m.updateMatrix();
        const part = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        for (const name of Object.keys(part.attributes)) if (!["position", "normal", "uv"].includes(name)) part.deleteAttribute(name);
        part.clearGroups();
        part.applyMatrix4(m.matrix);
        return part;
      });
      const merged = mergeGeometries(parts);
      for (const part of parts) part.dispose();
      if (!merged) continue;
      const first = meshes[0]!;
      const baked = new THREE.Mesh(own(merged), first.material);
      baked.castShadow = first.castShadow;
      baked.receiveShadow = first.receiveShadow;
      group.remove(...meshes);
      group.add(baked);
    }
  }

  return { keep, own, scope, free, disposeAll: () => { for (const thing of made) thing.dispose(); }, unit, tower, cylinder, cone, sphere, signFace, glow, puff, cached, plain, mesh, sprite, bake };
}

export type Kit = ReturnType<typeof createKit>;
