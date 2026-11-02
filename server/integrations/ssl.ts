import tls from "node:tls";
import { badRequest } from "../errors.ts";
import type { CheckResult } from "../../shared/types.ts";
import { requiredText } from "../validate.ts";
import { described } from "./types.ts";
import type { Integration } from "./types.ts";

// SSL certificate expiry (PRD §7.4): the days left on the certificate the
// site actually serves. Warns at 14 days (FR-W4), and checks once a day.

export const SSL_WARN_DAYS = 14;
const DAY_MS = 86_400_000;

export type Cert = { validTo: string; issuer?: string; authorized: boolean; error?: string };

function realFetchCert(host: string, port: number): Promise<Cert> {
  return new Promise((resolve, reject) => {
    // rejectUnauthorized is off so an expired or mismatched certificate can
    // still be read and reported; `authorized` says whether it's trusted.
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      resolve({
        validTo: new Date(cert.valid_to).toISOString(),
        issuer: [cert.issuer?.O ?? cert.issuer?.CN].flat()[0],
        authorized: socket.authorized,
        error: socket.authorizationError ? String(socket.authorizationError) : undefined,
      });
      socket.end();
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("No answer within 10 s"));
    });
    socket.on("error", reject);
  });
}

let fetchCert = realFetchCert;
// Tests replace the network call.
export function setCertFetcher(fn: typeof realFetchCert | undefined) {
  fetchCert = fn ?? realFetchCert;
}

// How long ago something expired, in whole days: within the last day is
// "today", not "1 day ago".
export function expiredAgo(ms: number): string {
  const days = Math.floor(ms / DAY_MS);
  return days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`;
}

export function evaluate(cert: Cert, now = Date.now()): CheckResult {
  const at = new Date(now).toISOString();
  const left = Date.parse(cert.validTo) - now;
  const date = cert.validTo.slice(0, 10);
  if (left <= 0) {
    return { state: "down", at, detail: `Certificate expired ${expiredAgo(-left)} (${date})`, summary: "Expired" };
  }
  // Whole days left, rounded up: 13 days and 23 hours is "14 days", and the
  // warning still means "14 or fewer days left".
  const days = Math.ceil(left / DAY_MS);
  if (!cert.authorized) {
    return { state: "down", at, detail: `Certificate isn't trusted: ${cert.error ?? "unknown reason"}`, summary: "Not trusted" };
  }
  if (days <= SSL_WARN_DAYS) {
    return { state: "down", at, detail: `Certificate expires in ${days} day${days === 1 ? "" : "s"} (${date})`, summary: `Expires in ${days} d` };
  }
  return { state: "up", at, summary: `Valid until ${date} · ${days} days left${cert.issuer ? ` · ${cert.issuer}` : ""}` };
}

export const ssl: Integration = {
  ...described("ssl"),
  needsLiveApp: true,
  confirmFailures: 1, // checked daily (shared/catalog.ts): a warning isn't held back a day

  parse({ resource }) {
    const raw = requiredText(resource, "Host", 260);
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(raw)) throw badRequest("Host must look like example.com");
    return { resource: raw };
  },

  async check(conn): Promise<CheckResult> {
    const [host, port] = conn.resource.split(":");
    try {
      return evaluate(await fetchCert(host, port ? Number(port) : 443));
    } catch (err) {
      return { state: "unknown", at: new Date().toISOString(), detail: `Couldn't read the certificate: ${(err as Error).message}` };
    }
  },

  notice(event, app, reason) {
    return event === "down"
      ? { title: `${app}: SSL certificate`, body: reason }
      : { title: `${app}: SSL certificate is fine again`, body: "It was renewed." };
  },
};
