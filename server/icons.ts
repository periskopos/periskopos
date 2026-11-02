import type { DatabaseSync } from "node:sqlite";
import type { App } from "../shared/types.ts";
import * as store from "./store.ts";
import { APP_USER_AGENT } from "./config.ts";

// Each app's own favicon, for its card and page. The server fetches it, not
// the window: the page loads images only from Periskopos (the CSP's
// img-src 'self'), so a site never sees the window and a broken or hostile
// icon never reaches it as anything but a checked image.

export type Icon = { type: string; data: Uint8Array };

const PAGE_LIMIT = 512 * 1024; // the <head> is near the top
const ICON_LIMIT = 256 * 1024;
const TIMEOUT_MS = 10_000;
// Found: look again daily, in case the site changed it. Not found: sooner,
// in case the site was only down.
export const ICON_EVERY_MS = 24 * 60 * 60_000;
export const MISSING_EVERY_MS = 6 * 60 * 60_000;
const SWEEP_MS = 30 * 60_000;

// What the bytes are, whatever the server called them: a site that answers
// /favicon.ico with its HTML page (most single-page apps) has no icon.
export function sniff(bytes: Uint8Array): string | undefined {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if ((head.startsWith("<svg") || head.startsWith("<?xml")) && head.includes("<svg")) return "image/svg+xml";
  return undefined;
}

const attr = (tag: string, name: string) =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);

// The icons a page names, best first: an SVG, then the sizes nearest a
// card's (32 to 64 px), then any other icon, then the Apple touch icon,
// and /favicon.ico last, which most sites have without saying so.
export function iconCandidates(html: string, pageUrl: string): string[] {
  const found: { url: string; rank: number; order: number }[] = [];
  for (const [i, tag] of (html.match(/<link\b[^>]*>/gi) ?? []).entries()) {
    const rel = (attr(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    const href = attr(tag, "href");
    if (!href) continue;
    let url: string;
    try {
      url = new URL(href.trim(), pageUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:/.test(url)) continue;
    if (rel.includes("icon")) {
      const sizes = (attr(tag, "sizes") ?? "").toLowerCase();
      const px = Math.max(0, ...[...sizes.matchAll(/(\d+)x\d+/g)].map((m) => Number(m[1])));
      const svg = (attr(tag, "type") ?? "").includes("svg") || /\.svg(\?|$)/i.test(url) || sizes === "any";
      found.push({ url, order: i, rank: svg ? 0 : px >= 32 && px <= 64 ? 1 : px > 64 ? 2 : 3 });
    } else if (rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed")) {
      found.push({ url, order: i, rank: 4 });
    }
  }
  found.sort((a, b) => a.rank - b.rank || a.order - b.order);
  const urls = found.map((f) => f.url);
  try {
    urls.push(new URL("/favicon.ico", pageUrl).href);
  } catch {
    // not a URL: nothing to add
  }
  return [...new Set(urls)];
}

async function readLimited(res: Response, limit: number): Promise<Uint8Array | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const get = (url: string, accept: string) =>
  fetch(url, { headers: { accept, "user-agent": APP_USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });

// The site's icon, or undefined when it has none I can show.
export async function fetchIcon(pageUrl: string): Promise<Icon | undefined> {
  let html = "";
  let base = pageUrl;
  try {
    const res = await get(pageUrl, "text/html");
    base = res.url || pageUrl;
    // Only the start: a huge page is cut, not refused.
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader && size < PAGE_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    await reader?.cancel().catch(() => {});
    html = new TextDecoder().decode(Buffer.concat(chunks));
  } catch {
    // no page: /favicon.ico may still answer
  }
  for (const url of iconCandidates(html, base)) {
    try {
      const res = await get(url, "image/*");
      if (!res.ok) continue;
      const data = await readLimited(res, ICON_LIMIT);
      const type = data && sniff(data);
      if (data && type) return { type, data };
    } catch {
      // try the next one
    }
  }
  return undefined;
}

// Keeps every live app's icon fresh: on a timer, and at once for an app just
// added or pointed at a new URL.
export class AppIcons {
  #db: DatabaseSync;
  #fetch: (url: string) => Promise<Icon | undefined>;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = new Map<string, Promise<void>>();

  constructor({ db, fetchIcon: fetchFn = fetchIcon }: { db: DatabaseSync; fetchIcon?: (url: string) => Promise<Icon | undefined> }) {
    this.#db = db;
    this.#fetch = fetchFn;
  }

  start() {
    this.#timer = setInterval(() => void this.sweep(), SWEEP_MS);
    void this.sweep();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async sweep(now = Date.now()) {
    const user = store.getLocalUser(this.#db);
    if (!user) return;
    await Promise.all(store.listApps(this.#db, user.id).map((app) => this.refresh(app, now)));
  }

  isDue(app: App, now = Date.now()): boolean {
    if (!app.live) return false; // no site to ask yet
    const known = store.getAppIcon(this.#db, app.id);
    if (!known || known.pageUrl !== app.url) return true;
    return now - Date.parse(known.fetchedAt) >= (known.data ? ICON_EVERY_MS : MISSING_EVERY_MS);
  }

  // Looks again if it's due; one look per app at a time.
  refresh(app: App, now = Date.now()): Promise<void> {
    if (!this.isDue(app, now)) return Promise.resolve();
    const running = this.#running.get(app.id);
    if (running) return running;
    const pending = this.#refresh(app, now).finally(() => this.#running.delete(app.id));
    this.#running.set(app.id, pending);
    return pending;
  }

  async #refresh(app: App, now: number) {
    let icon: Icon | undefined;
    try {
      icon = await this.#fetch(app.url);
    } catch (err) {
      console.error(`Couldn't fetch ${app.name}'s icon: ${(err as Error).message}`);
    }
    // The app was deleted while its site was asked: nothing to keep.
    if (!store.getAppById(this.#db, app.id)) return;
    const known = store.getAppIcon(this.#db, app.id);
    // Not found this time but found before, for the same site: the site is
    // probably just down, so the icon stays.
    const keep = !icon && known?.data && known.pageUrl === app.url;
    store.setAppIcon(this.#db, app.id, {
      pageUrl: app.url,
      fetchedAt: new Date(now).toISOString(),
      ...(icon ? icon : keep ? { type: known.type!, data: known.data! } : {}),
    });
  }
}
