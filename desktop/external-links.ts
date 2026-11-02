// Where a navigation in the window may go. The window stays on
// Periskopos's own address; anything on the web belongs in the system browser
// (the app's links to GitHub, Render and the apps themselves), never in a
// bare Electron window with no address bar.

const EXTERNAL_SCHEMES = new Set(["http:", "https:"]);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// Whether a page is the app's own: exactly its origin, never one that merely
// starts the same (http://127.0.0.1:41000 is not http://127.0.0.1:4100).
export const isAppPage = (url: string, appOrigin: string): boolean => decideLink(url, appOrigin) === "internal";

export type LinkDecision = "internal" | "external" | "block";

// internal: navigate in place. external: hand to the system browser. block:
// neither (never pass file:, javascript: or a custom scheme to the OS).
export function decideLink(url: string, appOrigin: string): LinkDecision {
  const target = parse(url);
  const origin = parse(appOrigin);
  if (!target) return "block";
  if (origin && target.origin === origin.origin) return "internal";
  return EXTERNAL_SCHEMES.has(target.protocol) ? "external" : "block";
}
