// periskopos:// links -> a route in the page.
//
// This comes from outside. Any web page or document on the machine can ask the
// OS to open a periskopos:// URL, and the result goes to the page's
// router. So it is parsed strictly into a small fixed set of routes and
// anything unrecognised is refused, never passed through.
//
//   periskopos://fleet                     -> #/
//   periskopos://status | services | settings
//                                              -> #/status | #/services | #/settings
//   periskopos://settings/<tab>            -> #/settings/<tab> (notifications, assistants, data)
//   periskopos://apps/<slug>[/<tab>]        -> #/apps/<slug>[/<tab>]
//                                                 (deploys, traffic, actions, history, settings)
//   periskopos://apps/<slug>/settings/<part> -> #/apps/<slug>/settings/<part> (connections, protocol)
export const PROTOCOL = "periskopos";

// What slugify() in the server produces: lowercase letters, digits, hyphens.
const SLUG = /^[a-z0-9-]{1,40}$/;
const SUBPAGES = new Set(["deploys", "traffic", "actions", "history", "settings"]);
const SETTINGS_TABS = new Set(["notifications", "assistants", "data"]);
// The parts of an app's Settings (its side menu).
const SETTINGS_PARTS = new Set(["connections", "protocol"]);

export function parseDeepLink(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${PROTOCOL}:`) return undefined;

  // periskopos://apps/star-map parses with host "apps" and path "/star-map".
  const segments = [parsed.hostname, ...parsed.pathname.split("/")].filter((s) => s.length > 0);
  const [kind, slug, sub, part, ...rest] = segments;
  if (rest.length > 0) return undefined;
  if (part !== undefined && !(kind === "apps" && sub === "settings" && SETTINGS_PARTS.has(part))) return undefined;

  // The apps page: periskopos://apps, or its old name periskopos://fleet.
  if ((kind === "apps" || kind === "fleet" || kind === "") && segments.length === 1) return "#/";
  if ((kind === "status" || kind === "services" || kind === "settings") && segments.length === 1) return `#/${kind}`;
  if (kind === "settings" && segments.length === 2) return SETTINGS_TABS.has(slug!) ? `#/settings/${slug}` : undefined;
  if (kind === "apps" && slug !== undefined) {
    let id: string;
    try {
      id = decodeURIComponent(slug);
    } catch {
      return undefined;
    }
    if (!SLUG.test(id)) return undefined;
    if (sub === undefined) return `#/apps/${id}`;
    if (!SUBPAGES.has(sub)) return undefined;
    return part ? `#/apps/${id}/${sub}/${part}` : `#/apps/${id}/${sub}`;
  }
  return undefined;
}

// Windows and Linux deliver the URL as an argument to the launch (or to the
// second instance), so those have to be scanned for one.
export function findDeepLinkInArgv(argv: readonly string[]): string | undefined {
  for (const arg of argv) {
    if (!arg.toLowerCase().startsWith(`${PROTOCOL}:`)) continue;
    const route = parseDeepLink(arg);
    if (route) return route;
  }
  return undefined;
}

// A route the shell sends to the page (from a notification or a link): only
// ever a hash route, never a URL.
export const isSafeRoute = (route: string): boolean => /^#\/[a-z0-9\-/]{0,120}$/.test(route);
