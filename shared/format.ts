// A URL's hostname, lowercased; "" when it isn't a URL.
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// Is `host` this domain, or a name under it?
export const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

// "14 min", "2 h 5 min", "1 d 3 h": used by notifications and the UI alike.
// Under a minute says so, rather than rounding a 20 s deploy up to "1 min".
export function duration(ms: number): string {
  if (!(ms >= 30_000)) return "under a minute";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

// A key's expiry, warned about this many days ahead, like an SSL
// certificate's (server/integrations/ssl.ts).
export const KEY_WARN_DAYS = 14;

// Whole days left until `expiresAt`, rounded up (13 days 23 hours is "14
// days"); 0 or less once it has passed.
export function daysLeft(expiresAt: string, now = Date.now()): number {
  return Math.ceil((Date.parse(expiresAt) - now) / 86_400_000);
}
