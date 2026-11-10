import * as THREE from "three";
import type { Rig } from "./rig.ts";
import type { Selection } from "./types.ts";
import { wheelZoom } from "./zoomFeel.ts";

// Pointing: what's under the pointer, and dragging the map. A vehicle wins if it's in front
// of whatever else is there, because vehicles are small.

export type PointerDeps = {
  canvas: HTMLCanvasElement;
  camera: THREE.Camera;
  rig: Rig;
  pickables(): THREE.Object3D[];
  tripAt(x: number, y: number): { id: string; distance: number } | null;
  onSelect(selection: Selection): void;
  onHover(selection: Selection): void;
  redraw(): void;
};

const DRAG_FROM_PX = 5;
const IN_FRONT_MARGIN = 1; // a van at the foot of a wall is still in front of it

export function createPointer({ canvas, camera, rig, pickables, tripAt, onSelect, onHover, redraw }: PointerDeps) {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let drag: { id: number; x: number; y: number; from: THREE.Vector3; moved: boolean } | null = null;
  let hoverKey = "";

  function pick(event: MouseEvent): Selection {
    const box = canvas.getBoundingClientRect();
    const trip = tripAt(event.clientX - box.left, event.clientY - box.top);
    pointer.set(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    for (const hit of raycaster.intersectObjects(pickables(), true)) {
      let o: THREE.Object3D | null = hit.object;
      if (o instanceof THREE.Sprite) continue;
      while (o) {
        const found = o.userData.pick as Selection | undefined;
        if (found) return trip && trip.distance <= hit.distance + IN_FRONT_MARGIN ? { kind: "trip", id: trip.id } : found;
        o = o.parent;
      }
    }
    return trip ? { kind: "trip", id: trip.id } : null;
  }

  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, from: rig.goal().clone(), moved: false };
    canvas.setPointerCapture(event.pointerId); // let go over a card, and it's still let go
  };
  const onMove = (event: PointerEvent) => {
    if (drag?.id === event.pointerId) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_FROM_PX) return;
      if (!drag.moved) {
        drag.moved = true;
        canvas.classList.add("is-dragging");
      }
      rig.panBy(dx, dy, drag.from);
      redraw();
      return;
    }
    const hovered = pick(event);
    const key = hovered ? `${hovered.kind}:${hovered.id}` : "";
    if (key !== hoverKey) {
      hoverKey = key;
      canvas.classList.toggle("is-pointing", Boolean(hovered));
      onHover(hovered);
    }
  };
  const onUp = (event: PointerEvent) => {
    if (drag?.id !== event.pointerId) return;
    const wasDrag = drag.moved;
    drag = null;
    canvas.classList.remove("is-dragging");
    if (!wasDrag) onSelect(pick(event));
  };
  const onCancel = () => {
    drag = null;
    canvas.classList.remove("is-dragging");
  };
  const onLeave = () => {
    if (!hoverKey) return;
    hoverKey = "";
    canvas.classList.remove("is-pointing");
    onHover(null);
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    rig.zoomBy(wheelZoom(event.deltaY, event.deltaMode, event.ctrlKey));
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  return {
    dragging: () => drag !== null,
    destroy() {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
    },
  };
}
