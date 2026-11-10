// How zooming feels, apart from any picture. The wheel counts how far it was scrolled, not
// how many events came, as a trackpad sends dozens where a mouse sends one. The camera then
// glides there: it picks up speed and slows down again, however many steps came in on the way.

export const ZOOM_STEP = 1.25; // a click of + or −, or a press of the key

const PER_PIXEL = Math.log(1.08) / 100; // a mouse wheel's notch is about 100 pixels
const PINCH_BOOST = 6; // a pinch reports far smaller numbers than a scroll
const LINE_PX = 40;
const PAGE_PX = 800;
const MOST_AT_ONCE = Math.log(1.25);
const GLIDE_MS = 280;

export function wheelZoom(deltaY: number, deltaMode: number, pinch: boolean): number {
  const pixels = deltaY * (deltaMode === 1 ? LINE_PX : deltaMode === 2 ? PAGE_PX : 1);
  const amount = -pixels * PER_PIXEL * (pinch ? PINCH_BOOST : 1);
  return Math.exp(Math.max(-MOST_AT_ONCE, Math.min(MOST_AT_ONCE, amount)));
}

// One step towards the goal, moving as a well-damped spring does: it starts gently, never
// overshoots, and comes out the same at any frame rate. Speed is per millisecond.
export function glide(at: number, goal: number, speed: number, ms: number): { at: number; speed: number } {
  const omega = 2 / GLIDE_MS;
  const x = omega * ms;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const off = at - goal;
  const push = (speed + omega * off) * ms;
  return { at: goal + (off + push) * decay, speed: (speed - omega * push) * decay };
}
