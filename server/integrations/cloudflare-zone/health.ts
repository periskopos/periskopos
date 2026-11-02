import type { CheckResult, Connection } from "../../../shared/types.ts";
import type { ServiceAuth } from "../types.ts";
import { PERMISSION, SETUP_TTL_MS, cf, hostOf, refused, zoneIdOf } from "./api.ts";
import type { CfCertPack, CfDnsRecord, CfZone } from "./api.ts";
import { compact, errorSpike, hourly, totalsOf } from "./traffic.ts";

// The status check: is Cloudflare serving the domain (active, not paused),
// does the app's name resolve, is the edge certificate fine, and are
// requests failing? DNS and certificate reads are optional: when the token
// lacks them the check says which permission to add, and never turns the
// app red over it.

// Does a certificate host ("example.com", "*.example.com") cover this name?
export const covers = (pattern: string, host: string) =>
  pattern === host || (pattern.startsWith("*.") && host.endsWith(pattern.slice(1)) && !host.slice(0, -(pattern.length - 1)).includes("."));

type Finding = { problems: string[]; notes: string[] };

async function dnsFinding(conn: Connection, auth: ServiceAuth, f: Finding): Promise<{ proxied?: boolean }> {
  const host = hostOf(conn);
  try {
    const records = await cf<CfDnsRecord[]>(auth, `/zones/${zoneIdOf(conn)}/dns_records?name=${encodeURIComponent(host)}&per_page=50`, SETUP_TTL_MS);
    const web = records.filter((r) => r.name === host && ["A", "AAAA", "CNAME"].includes(r.type));
    if (web.length === 0) {
      f.problems.push(`${host} has no A, AAAA or CNAME record in Cloudflare DNS, so it doesn't resolve`);
      return {};
    }
    const proxied = web.some((r) => r.proxied === true);
    f.notes.push(`DNS: ${host} ${proxied ? "proxied" : "DNS only"}`);
    return { proxied };
  } catch (err) {
    f.notes.push(refused(err) ? PERMISSION.dns : `DNS not checked: ${(err as Error).message}`);
    return {};
  }
}

async function certFinding(conn: Connection, auth: ServiceAuth, f: Finding) {
  const host = hostOf(conn);
  try {
    const packs = await cf<CfCertPack[]>(auth, `/zones/${zoneIdOf(conn)}/ssl/certificate_packs?status=all&per_page=50`, SETUP_TTL_MS);
    const mine = packs.filter((p) => (p.hosts ?? []).some((h) => covers(h, host)));
    if (mine.some((p) => p.status === "active")) {
      f.notes.push("Edge certificate active");
    } else if (mine.length > 0) {
      f.problems.push(`Cloudflare's edge certificate for ${host} is ${mine[0].status.replace(/_/g, " ")}, not active`);
    } else {
      f.problems.push(`No Cloudflare edge certificate covers ${host}`);
    }
  } catch (err) {
    f.notes.push(refused(err) ? PERMISSION.ssl : `Certificate not checked: ${(err as Error).message}`);
  }
}

export async function checkZone(conn: Connection, auth: ServiceAuth, at: string): Promise<CheckResult> {
  let zone: CfZone;
  try {
    zone = await cf<CfZone>(auth, `/zones/${zoneIdOf(conn)}`);
  } catch (err) {
    return { state: "unknown", at, detail: (err as Error).message };
  }
  const f: Finding = { problems: [], notes: [] };
  if (zone.paused) f.problems.push(`Cloudflare is paused on ${zone.name}: visitors reach your server directly, without its cache or protection`);
  if (zone.status !== "active") {
    f.problems.push(
      zone.status === "pending"
        ? `${zone.name} is pending: its nameservers at the registrar don't point to Cloudflare yet`
        : `${zone.name} is ${zone.status} on Cloudflare, not active`,
    );
  }
  const devLeft = zone.development_mode ?? 0;
  const devNote = devLeft > 0 ? `Development mode on: cache bypassed for another ${Math.max(1, Math.round(devLeft / 60))} min` : undefined;

  const [{ proxied }, hours] = await Promise.all([
    dnsFinding(conn, auth, f),
    hourly(conn, auth).catch((err: unknown) => {
      f.notes.push(refused(err) ? PERMISSION.analytics : `Traffic not read: ${(err as Error).message}`);
      return undefined;
    }),
  ]);
  // A DNS-only name is served by the app's own certificate, not Cloudflare's.
  if (proxied !== false) await certFinding(conn, auth, f);

  const spike = hours && errorSpike(hours);
  if (spike) f.problems.push(spike.reason);
  const day = hours && totalsOf(hours);
  const trafficNote = day && `${compact(day.requests)} requests in 24 h${day.errorPct !== undefined ? ` · ${day.errorPct}% 5xx` : ""}`;

  if (f.problems.length > 0) {
    return {
      state: "down",
      at,
      detail: f.problems.join("; "),
      summary: f.problems[0],
    };
  }
  return {
    state: "up",
    at,
    summary: [devNote ?? `${zone.name} active`, trafficNote, ...f.notes].filter(Boolean).join(" · "),
  };
}
