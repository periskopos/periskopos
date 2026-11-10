// The colour behind the logo on a roof's sign. It says the same as the light over it, by the
// same rule (antennaLight in shared/world.ts): running, needing attention, down, maintenance.
// Where the light says nothing (not known, stale, not live yet, a replay), nor does the
// screen. A dark tint, not the colour itself: logos are coloured too, and a green logo would
// vanish on a green screen, and a calm valley would glow.

export const SCREEN = "#0b1220";
export const TINT_SHARE = 0.32;
// Trouble shows more of its colour than calm does: amber that faint reads as brown, and what
// needs a look should stand out from a valley of quiet green.
export const WARNING_SHARE = 0.46;
export const shareFor = (tone: "up" | "attention" | "down" | "info") => (tone === "attention" || tone === "down" ? WARNING_SHARE : TINT_SHARE);

const channels = (hex: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
};

// The screen's colour for a status colour, or the plain screen for none (or one not read).
export function screenBack(status: string | null | undefined, share = TINT_SHARE): string {
  const tone = status ? channels(status) : null;
  const base = channels(SCREEN)!;
  if (!tone) return SCREEN;
  const mixed = base.map((b, i) => Math.round(b + (tone[i]! - b) * share));
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
