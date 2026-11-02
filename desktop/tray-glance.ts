import path from "node:path";
import { summarize } from "../shared/fleet.ts";
import type { AppState, AppStatus } from "../shared/types.ts";
import type { Tone } from "./menu-icons.ts";

// The tray's glance (the landscape notes §5.2): every app in the tray menu,
// problems first, each with its state or its newest problem, and a tray icon
// that turns red or amber when something is wrong. Kept free of Electron so
// the wording, the order and the choice of icon can be tested.

// An app the server listed but hasn't checked yet shows as "checking", as on
// the Apps page.
export type GlanceState = AppState | "checking";

// What needs me first: the Apps page's order (web/src/format.ts STATE_RANK).
// The page's code isn't imported into the shell, so it is repeated here; a
// test holds the two to the same order.
export const STATE_RANK: Record<GlanceState, number> = {
  down: 0,
  attention: 1,
  unknown: 2,
  checking: 3,
  up: 4,
  prelaunch: 5,
  none: 6,
};

const STATE_LABEL: Record<GlanceState, string> = {
  up: "Up",
  down: "Down",
  attention: "Needs attention",
  unknown: "Unknown",
  none: "No checks",
  prelaunch: "Not live yet",
  checking: "Checking…",
};

// The coloured dot beside each line, drawn like the page's lamps: filled for
// up, down, attention and in progress, a ring for unknown, a dashed ring for
// not live yet, a dash for nothing to check.
export type Dot = "up" | "down" | "attention" | "info" | "unknown" | "prelaunch" | "none";
export const DOTS: Dot[] = ["up", "down", "attention", "info", "unknown", "prelaunch", "none"];

// The status colours of web/src/tokens.css: the light theme's on a light menu
// ("dark" tone, as for the menu glyphs), the dark theme's on a dark one.
const DOT_COLOUR: Record<Tone, Record<Exclude<Dot, "none">, string>> = {
  dark: { up: "#1a7f37", down: "#c9252d", attention: "#b5480b", info: "#0b62d6", unknown: "#5d6673", prelaunch: "#5d6673" },
  light: { up: "#3fb950", down: "#ff6b61", attention: "#f0883e", info: "#58a6ff", unknown: "#8b949e", prelaunch: "#8b949e" },
};

export function dotSvg(dot: Dot, tone: Tone): string {
  const shape =
    dot === "none"
      ? `<rect x="6" y="11" width="12" height="2" rx="1" fill="${DOT_COLOUR[tone].unknown}"/>`
      : dot === "unknown"
        ? `<circle cx="12" cy="12" r="5.5" fill="none" stroke="${DOT_COLOUR[tone].unknown}" stroke-width="2"/>`
        : dot === "prelaunch"
          ? `<circle cx="12" cy="12" r="5.5" fill="none" stroke="${DOT_COLOUR[tone].prelaunch}" stroke-width="2" stroke-dasharray="3 2.2"/>`
          : `<circle cx="12" cy="12" r="6.5" fill="${DOT_COLOUR[tone][dot]}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${shape}</svg>`;
}

export const dotIconName = (dot: Dot, tone: Tone) => `dot-${dot}-${tone}.png`;

// A Mac would recolour a template image and lose the colour, so dots are
// never templates: the tone always follows the menu's colour.
export const dotIconFile = (dir: string, dot: Dot, darkMenus: boolean): string =>
  path.join(dir, dotIconName(dot, darkMenus ? "light" : "dark"));

// Without the dot images (a checkout that never ran prepare-icon) a menu
// can't colour its text, so each state gets a marker that differs in shape.
export const TEXT_MARKER: Record<Dot, string> = {
  down: "✕",
  attention: "!",
  info: "↻",
  unknown: "?",
  up: "✓",
  prelaunch: "○",
  none: "–",
};

// ── Lines ───────────────────────────────────────────────────────────────

export type GlanceApp = { slug: string; name: string };
export type GlanceLine = { label: string; dot: Dot; route: string };
export type Glance = {
  headline: { label: string; dot: Dot };
  lines: GlanceLine[];
  more?: { label: string; route: string }; // "and 3 more…", opening the Apps page
};

export const MAX_LINES = 10;
const MAX_DETAIL = 60; // a menu line as long as the screen helps nobody

const shortSha = (sha: string) => sha.slice(0, 7);
const clip = (text: string) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_DETAIL ? `${one.slice(0, MAX_DETAIL - 1).trimEnd()}…` : one;
};

const DOT_OF: Record<GlanceState, Dot> = {
  up: "up",
  down: "down",
  attention: "attention",
  unknown: "unknown",
  checking: "unknown",
  prelaunch: "prelaunch",
  none: "none",
};

// What one line says after the name: the open problem first (its reason is
// the newest thing wrong), then a deploy worth knowing about (one under way,
// or a push that isn't live), else just the state.
export function lineDetail(status: AppStatus | undefined): { text: string; dot: Dot } {
  const state: GlanceState = status?.state ?? "checking";
  if (status?.incident) return { text: clip(status.incident.reason), dot: DOT_OF[state] };
  // Down before an outage is opened for it: what the failing check said, as
  // the Apps page shows.
  const failing = Object.values(status?.checks ?? {})
    .filter((c) => c.state === "down" && c.detail)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  if (state === "down" && failing?.detail) return { text: clip(failing.detail), dot: "down" };
  const deploy = status?.deploy;
  if (deploy?.state === "deploying" && state !== "down") {
    return { text: deploy.latest ? `Deploying ${shortSha(deploy.latest.sha)}` : "Deploying", dot: "info" };
  }
  if (deploy?.state === "not-deployed" && state !== "down") {
    return { text: deploy.latest ? `Not live: ${shortSha(deploy.latest.sha)}` : "Last push not live", dot: state === "up" ? "attention" : DOT_OF[state] };
  }
  return { text: STATE_LABEL[state], dot: DOT_OF[state] };
}

// Windows reads "&" in a menu label as the next letter's shortcut and hides
// it; "&&" shows one.
export const menuText = (text: string, platform: string = process.platform) => (platform === "win32" ? text.replace(/&/g, "&&") : text);

export function appRoute(slug: string): string {
  return `#/apps/${encodeURIComponent(slug)}`;
}

// The whole glance: every app the server listed (and any status it reported
// for an app not yet in that list, by its slug), problems first and then by
// name, capped with an "and N more…" that opens the Apps page.
export function buildGlance(apps: GlanceApp[], statuses: AppStatus[], max: number = MAX_LINES): Glance {
  const bySlug = new Map(statuses.map((s) => [s.slug, s]));
  const names = new Map(apps.map((a) => [a.slug, a.name]));
  for (const s of statuses) if (!names.has(s.slug)) names.set(s.slug, s.slug);

  const stateOf = (slug: string): GlanceState => bySlug.get(slug)?.state ?? "checking";
  const slugs = [...names.keys()].sort(
    (a, b) => STATE_RANK[stateOf(a)] - STATE_RANK[stateOf(b)] || (names.get(a) ?? a).localeCompare(names.get(b) ?? b),
  );

  const lines = slugs.slice(0, max).map((slug) => {
    const detail = lineDetail(bySlug.get(slug));
    return { label: `${names.get(slug) ?? slug} — ${detail.text}`, dot: detail.dot, route: appRoute(slug) };
  });
  const hidden = slugs.length - lines.length;

  const fleet = summarize(statuses);
  const headline: Glance["headline"] = { label: fleet.text, dot: fleet.state };
  return { headline, lines, ...(hidden > 0 ? { more: { label: `and ${hidden} more…`, route: "#/" } } : {}) };
}

// Two glances that would draw the same menu: rebuilt only when this changes,
// so a quiet minute doesn't make the open menu flicker.
export const glanceKey = (g: Glance): string => JSON.stringify(g);

// ── The tray icon ───────────────────────────────────────────────────────

export type TrayVariant = "normal" | "down" | "attention";
export const TRAY_VARIANTS: Exclude<TrayVariant, "normal">[] = ["down", "attention"];

// Red when any app is down, amber when one needs attention, otherwise the
// plain icon. Apps not live yet never colour it: they're quiet on purpose.
export function trayVariant(statuses: AppStatus[]): TrayVariant {
  if (statuses.some((s) => s.state === "down")) return "down";
  if (statuses.some((s) => s.state === "attention")) return "attention";
  return "normal";
}

export const trayIconName = (variant: Exclude<TrayVariant, "normal">) => `tray-${variant}.png`;

// The app mark with its green status lamp laid over in the state's
// colour, so the lamp that says "all well" is the one that says what's
// wrong. Same place and size as in icon.svg, so it reads at 16 px.
export function trayIconSvg(baseSvg: string, variant: Exclude<TrayVariant, "normal">): string {
  const colour = DOT_COLOUR.light[variant];
  const dot = `<circle cx="349" cy="163" r="72" fill="${colour}"/>`;
  const end = baseSvg.lastIndexOf("</svg>");
  if (end < 0) throw new Error("trayIconSvg: the base icon isn't an SVG");
  return `${baseSvg.slice(0, end)}${dot}${baseSvg.slice(end)}`;
}
