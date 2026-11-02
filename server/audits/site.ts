import * as dns from "node:dns/promises";
import tls from "node:tls";
import { hostnameOf } from "../../shared/format.ts";
import type { App, AuditResult, FindingDraft } from "../../shared/types.ts";
import { registrableDomain } from "../integrations/domain.ts";
import { APP_USER_AGENT } from "../config.ts";

// The checks every app gets from its address alone, no account needed: the
// site's own setup (HTTPS, security headers, cookies, files it shouldn't
// serve) and its domain's DNS (email authentication, certificate
// authorities). Each finding says what's wrong, why it matters and how to fix
// it.

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type DnsResolver = {
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
  resolveCaa(name: string): Promise<unknown[]>;
};
// certIssuer: who issued the site's certificate now (its organisation), for
// the CAA example; read from the site itself unless a resolver is given
// (the tests), so they never go out on the network.
export type AuditDeps = { fetch?: Fetcher; resolver?: DnsResolver; certIssuer?: (host: string) => Promise<string | undefined> };

function liveCertIssuer(host: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: TIMEOUT_MS }, () => {
      const issuer = socket.getPeerCertificate()?.issuer?.O;
      socket.end();
      resolve(Array.isArray(issuer) ? issuer[0] : issuer);
    });
    socket.on("error", () => resolve(undefined));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(undefined);
    });
  });
}

// A certificate authority's name, as its certificates give it, to the name
// a CAA record uses for it.
const CAA_NAMES: [RegExp, string, string][] = [
  [/let's encrypt/i, "letsencrypt.org", "Let's Encrypt"],
  [/google trust services/i, "pki.goog", "Google Trust Services"],
  [/digicert/i, "digicert.com", "DigiCert"],
  [/sectigo|comodo|zerossl/i, "sectigo.com", "Sectigo"],
  [/amazon/i, "amazon.com", "Amazon"],
  [/globalsign/i, "globalsign.com", "GlobalSign"],
  [/ssl\.com|ssl corporation/i, "ssl.com", "SSL.com"],
];
export function caaNameFor(issuer: string | undefined): { name: string; label: string } | undefined {
  const hit = issuer ? CAA_NAMES.find(([re]) => re.test(issuer)) : undefined;
  return hit ? { name: hit[1], label: hit[2] } : undefined;
}

const TIMEOUT_MS = 10_000;
const MAX_HOPS = 10;
// A probed file is read this far: enough to tell a .env from a web page.
const MAX_PROBE_BYTES = 64_000;
const SIX_MONTHS_S = 15_552_000; // 180 days
const USER_AGENT = `${APP_USER_AGENT} (configuration check)`;

const systemResolver: DnsResolver = { resolveTxt: dns.resolveTxt, resolveMx: dns.resolveMx, resolveCaa: dns.resolveCaa };

// DNS over HTTPS (Cloudflare's public resolver), for a PC whose own DNS
// can't be asked directly: Node asks the DNS servers itself, and some setups
// (a VPN, a local DNS filter) only answer the browser's way. Only public
// domain names are sent, and only when the PC's own lookup failed.
const DOH = "https://cloudflare-dns.com/dns-query";
const DNS_TYPE = { TXT: 16, MX: 15, CAA: 257 } as const;

const noRecord = () => Object.assign(new Error("No such record"), { code: "ENODATA" });

// TXT data comes as one or more quoted strings: "v=spf1 " "include:…".
export function txtChunks(data: string): string[] {
  const chunks = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1"));
  return chunks.length ? chunks : [data];
}

export function dohResolver(fetcher: Fetcher = fetch): DnsResolver {
  const ask = async (name: string, type: keyof typeof DNS_TYPE): Promise<string[]> => {
    const res = await fetcher(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, { method: "GET", headers: { accept: "application/dns-json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw Object.assign(new Error(`DNS over HTTPS answered ${res.status}`), { code: `HTTP${res.status}` });
    const body = (await res.json()) as { Status?: number; Answer?: { type: number; data: string }[] };
    if (body.Status === 3) throw noRecord(); // NXDOMAIN
    if (body.Status !== 0) throw Object.assign(new Error(`DNS answered status ${body.Status}`), { code: "ESERVFAIL" });
    const data = (body.Answer ?? []).filter((a) => a.type === DNS_TYPE[type]).map((a) => a.data);
    if (data.length === 0) throw noRecord();
    return data;
  };
  return {
    resolveTxt: async (name) => (await ask(name, "TXT")).map(txtChunks),
    resolveMx: async (name) =>
      (await ask(name, "MX")).map((d) => {
        const [priority, exchange] = d.split(/\s+/);
        return { priority: Number(priority), exchange: (exchange ?? "").replace(/\.$/, "") };
      }),
    resolveCaa: async (name) => ask(name, "CAA"),
  };
}

// The PC's own DNS first; DNS over HTTPS when that can't be asked at all
// (refused, timed out), not when it answered "no such record".
export function fallbackResolver(first: DnsResolver, second: DnsResolver): DnsResolver {
  async function either<T>(a: () => Promise<T>, b: () => Promise<T>): Promise<T> {
    try {
      return await a();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENODATA" || code === "ENOTFOUND") throw err;
      return b();
    }
  }
  return {
    resolveTxt: (name) => either(() => first.resolveTxt(name), () => second.resolveTxt(name)),
    resolveMx: (name) => either(() => first.resolveMx(name), () => second.resolveMx(name)),
    resolveCaa: (name) => either(() => first.resolveCaa(name), () => second.resolveCaa(name)),
  };
}

const realResolver: DnsResolver = fallbackResolver(systemResolver, dohResolver());
const mdn = (header: string) => ({ url: `https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/${header}`, label: `${header} on MDN` });

// ---------------------------------------------------------------- the site

type Hop = { url: string; res: Response };

// One request, no redirect followed: the chain is read hop by hop.
function get(fetcher: Fetcher, url: string): Promise<Response> {
  return fetcher(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": USER_AGENT } });
}

// Every response from `url` to the page it ends on. The last one's body is
// left unread; the others are cancelled.
async function follow(fetcher: Fetcher, start: string): Promise<Hop[]> {
  const hops: Hop[] = [];
  let url = start;
  for (let i = 0; i <= MAX_HOPS; i++) {
    const res = await get(fetcher, url);
    hops.push({ url, res });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return hops;
    await res.body?.cancel();
    url = new URL(location, url).toString();
  }
  throw new Error(`More than ${MAX_HOPS} redirects`);
}

function describe(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e.name === "TimeoutError") return `No answer within ${TIMEOUT_MS / 1000} s`;
  switch (e.cause?.code) {
    case "ENOTFOUND":
      return "Domain not found (DNS)";
    case "ECONNREFUSED":
      return "Connection refused";
    case "ECONNRESET":
      return "Connection reset";
  }
  return e.cause?.code ?? e.message ?? "Request failed";
}

async function readCapped(res: Response, max = MAX_PROBE_BYTES): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    bytes += value.byteLength;
    if (bytes >= max) {
      await reader.cancel();
      break;
    }
  }
  const out = new Uint8Array(Math.min(bytes, max));
  let at = 0;
  for (const p of parts) {
    const take = p.subarray(0, out.length - at);
    out.set(take, at);
    at += take.length;
    if (at >= out.length) break;
  }
  return out;
}

export async function auditSite(app: App, deps: AuditDeps = {}): Promise<AuditResult> {
  const fetcher = deps.fetch ?? fetch;
  const findings: FindingDraft[] = [];
  const notes: string[] = [];

  let hops: Hop[];
  try {
    hops = await follow(fetcher, app.url);
  } catch (err) {
    throw new Error(`The site didn't answer: ${describe(err)}`);
  }
  const final = hops[hops.length - 1];
  const finalUrl = new URL(final.url);
  const https = finalUrl.protocol === "https:";
  await final.res.body?.cancel();

  // Plain http:// should only ever send people on to https://.
  if (new URL(app.url).protocol === "https:") {
    const plain = new URL(app.url);
    plain.protocol = "http:";
    const problem = await httpProblem(fetcher, plain.toString());
    if (problem) findings.push(problem);
  }

  if (!https) {
    notes.push("The site ends up on http://, so its HTTPS setup (security headers, secure cookies) wasn't checked.");
  } else {
    findings.push(...headerFindings(final.res.headers));
  }

  // Cookies set on the way to the first page.
  const cookies = new Map<string, string[]>();
  for (const hop of hops) for (const line of hop.res.headers.getSetCookie()) {
    const parsed = cookieProblems(line, https);
    if (parsed && parsed.missing.length) cookies.set(parsed.name, parsed.missing);
  }
  for (const [name, missing] of cookies) findings.push(cookieFinding(name, missing));

  const exposed = await exposedFiles(fetcher, finalUrl.origin);
  findings.push(...exposed.findings);
  notes.push(...(exposed.notes ?? []));

  return { findings, ...(notes.length ? { notes } : {}) };
}

// Does http:// end on https://? A server that doesn't answer http:// at all
// is fine: there's nothing there to leak.
async function httpProblem(fetcher: Fetcher, url: string): Promise<FindingDraft | undefined> {
  let hops: Hop[];
  try {
    hops = await follow(fetcher, url);
  } catch {
    return undefined;
  }
  const last = hops[hops.length - 1];
  await last.res.body?.cancel();
  if (new URL(last.url).protocol === "https:") return undefined;
  const host = new URL(url).host;
  return {
    key: "http-no-redirect",
    severity: "high",
    title: "http:// doesn't redirect to https://",
    why: `Someone who types ${host} or follows an old http:// link gets the site unencrypted. Anyone on the same network can read or change what they see and send.`,
    fix: {
      steps: "Turn on \"redirect HTTP to HTTPS\" at your host or CDN (most have a switch for it), or have the server answer every http:// request with a 301 to the same address on https://.",
    },
  };
}

function headerFindings(h: Headers): FindingDraft[] {
  const out: FindingDraft[] = [];
  const html = (h.get("content-type") ?? "").toLowerCase().includes("text/html");

  const hsts = h.get("strict-transport-security");
  if (!hsts) {
    out.push({
      key: "hsts-missing",
      severity: "medium",
      title: "No Strict-Transport-Security header",
      why: "Without it, a browser will still try http:// first when someone types the address, and that first request can be intercepted. The header tells browsers to always use HTTPS for this site.",
      fix: { steps: "Send this header on every HTTPS response (start with a short max-age if you're unsure every subdomain has HTTPS, then raise it).", link: mdn("Strict-Transport-Security"), code: "Strict-Transport-Security: max-age=31536000; includeSubDomains" },
    });
  } else {
    const maxAge = Number(/max-age\s*=\s*"?(\d+)/i.exec(hsts)?.[1] ?? 0);
    if (maxAge < SIX_MONTHS_S) {
      const days = Math.floor(maxAge / 86_400);
      out.push({
        key: "hsts-short",
        severity: "low",
        title: "Strict-Transport-Security expires quickly",
        why: `Browsers only remember to use HTTPS for ${days} day${days === 1 ? "" : "s"} after a visit (max-age=${maxAge}). Six months or more is the usual minimum.`,
        fix: { steps: "Raise max-age to a year.", link: mdn("Strict-Transport-Security"), code: "Strict-Transport-Security: max-age=31536000; includeSubDomains" },
      });
    }
  }

  const csp = h.get("content-security-policy");
  if (html && !csp) {
    const reportOnly = h.has("content-security-policy-report-only");
    out.push(
      reportOnly
        ? {
            key: "csp-report-only",
            severity: "low",
            title: "Content-Security-Policy is report-only",
            why: "The policy only reports what it would block; it doesn't stop anything. If a script gets injected into a page, it still runs.",
            fix: { steps: "Once the reports show nothing you need is being blocked, send the same policy as Content-Security-Policy instead of Content-Security-Policy-Report-Only.", link: mdn("Content-Security-Policy") },
          }
        : {
            key: "csp-missing",
            severity: "medium",
            title: "No Content-Security-Policy header",
            why: "A Content-Security-Policy says where scripts and other files may load from. Without one, a script injected into a page (through a comment, a URL or a bad dependency) runs with full access to the page.",
            fix: {
              steps: "Add a policy that allows only your own origin and the services you use. Start with Content-Security-Policy-Report-Only to see what it would block, then switch to enforcing.",
              link: mdn("Content-Security-Policy"),
              code: "Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
            },
          },
    );
  }

  if ((h.get("x-content-type-options") ?? "").trim().toLowerCase() !== "nosniff") {
    out.push({
      key: "nosniff-missing",
      severity: "low",
      title: "No X-Content-Type-Options: nosniff",
      why: "Without it, a browser may guess a file's type from its contents, so an uploaded text file could be run as a script.",
      fix: { steps: "Send this header on every response.", link: mdn("X-Content-Type-Options"), code: "X-Content-Type-Options: nosniff" },
    });
  }

  if (html && !h.has("x-frame-options") && !/frame-ancestors/i.test(csp ?? "")) {
    out.push({
      key: "clickjacking",
      severity: "medium",
      title: "Other sites can put this site in a frame",
      why: "A hostile page can show your site in an invisible frame and trick people into clicking buttons on it (clickjacking): changing settings, confirming payments.",
      fix: {
        steps: "Add frame-ancestors to your Content-Security-Policy, or send X-Frame-Options. Use 'self' instead of 'none' if your own pages frame the site.",
        link: mdn("X-Frame-Options"),
        code: "Content-Security-Policy: frame-ancestors 'none'\nX-Frame-Options: DENY",
      },
    });
  }

  const revealing = ["server", "x-powered-by"]
    .map((name) => [name, h.get(name)] as const)
    .filter((pair): pair is readonly [string, string] => !!pair[1] && /\d+\.\d+/.test(pair[1]));
  if (revealing.length) {
    const shown = revealing.map(([name, value]) => `${name === "server" ? "Server" : "X-Powered-By"}: ${value.slice(0, 80)}`).join(", ");
    out.push({
      key: "version-header",
      severity: "low",
      title: "Headers reveal software versions",
      why: `The site says exactly what it runs (${shown}). That makes it easy for someone to look up known holes in that version.`,
      fix: { steps: "Turn off the version in the server's settings (for example server_tokens off in nginx, app.disable(\"x-powered-by\") in Express, poweredByHeader: false in Next.js)." },
    });
  }
  return out;
}

// A cookie's name and which of Secure, HttpOnly, SameSite it lacks. The
// value is never kept.
export function cookieProblems(line: string, https: boolean): { name: string; missing: string[] } | undefined {
  const [pair, ...attrs] = line.split(";");
  const eq = pair.indexOf("=");
  if (eq <= 0) return undefined;
  const name = pair.slice(0, eq).trim();
  const have = new Set(attrs.map((a) => a.split("=")[0].trim().toLowerCase()));
  // A cookie being deleted (expired, or Max-Age=0) is no risk.
  if (/(^|;)\s*max-age\s*=\s*0\s*(;|$)/i.test(line)) return { name, missing: [] };
  const missing: string[] = [];
  if (https && !have.has("secure")) missing.push("Secure");
  if (!have.has("httponly")) missing.push("HttpOnly");
  if (!have.has("samesite")) missing.push("SameSite");
  return { name, missing };
}

function cookieFinding(name: string, missing: string[]): FindingDraft {
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  const risks: string[] = [];
  if (missing.includes("Secure")) risks.push("it can be sent over plain http:// and read on the way");
  if (missing.includes("HttpOnly")) risks.push("any script on the page can read it, including an injected one");
  if (missing.includes("SameSite")) risks.push("other sites can make requests that carry it");
  const flags = ["Secure", "HttpOnly", "SameSite=Lax"].filter((f) => missing.includes(f.split("=")[0]));
  return {
    key: `cookie:${name}`,
    severity: "medium",
    title: `Cookie “${name}” is missing ${list}`,
    why: `The site sets a cookie called “${name}”, and ${risks.join("; ")}. If it holds a session, that's a way to take over someone's account.`,
    fix: {
      steps: `Wherever the app sets “${name}”, add ${flags.join(", ")}. Leave HttpOnly off only if your own scripts really need to read it.`,
      link: { url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies#security", label: "Cookie security on MDN" },
      code: `Set-Cookie: ${name}=…; Path=/; ${["Secure", "HttpOnly", "SameSite=Lax"].join("; ")}`,
    },
  };
}

const looksLikeHtml = (text: string) => /^\s*(<!doctype|<html|<head|<body|<\?xml|<!--)/i.test(text) || /<(html|body|script|div)[\s>]/i.test(text.slice(0, 2000));
const DS_STORE_MAGIC = [0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31]; // "\0\0\0\1Bud1"

// Is this a .env file? Mostly KEY=VALUE lines, a few comments, no markup.
export function looksLikeEnv(text: string): boolean {
  if (looksLikeHtml(text)) return false;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!lines.length) return false;
  const pairs = lines.filter((l) => /^(export\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*=/.test(l)).length;
  return pairs >= 1 && pairs / lines.length >= 0.8;
}

// Files that should never be served. A site that answers every path with
// its app page (a single-page app's fallback) mustn't count as serving
// them: each answer is compared with what a made-up path gets.
async function exposedFiles(fetcher: Fetcher, origin: string): Promise<AuditResult> {
  const probe = async (path: string): Promise<Uint8Array | undefined> => {
    const res = await get(fetcher, origin + path);
    if (res.status !== 200) {
      await res.body?.cancel();
      return undefined;
    }
    return readCapped(res);
  };
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  const nonce = `periskopos-${Math.random().toString(36).slice(2, 10)}-missing`;

  let results: (Uint8Array | undefined)[];
  try {
    results = await Promise.all([`/${nonce}`, "/.git/HEAD", "/.env", "/.DS_Store"].map(probe));
  } catch (err) {
    return { findings: [], notes: [`Couldn't check for exposed files (.git, .env): ${describe(err)}`] };
  }
  const [fallback, git, env, dsStore] = results;
  const fallbackText = fallback ? decode(fallback).trim() : undefined;
  const sameAsFallback = (b: Uint8Array) => fallbackText !== undefined && decode(b).trim() === fallbackText;

  const findings: FindingDraft[] = [];
  if (git && !sameAsFallback(git)) {
    const text = decode(git).trim();
    if (/^ref: refs\//.test(text) || /^[0-9a-f]{40}$/.test(text)) {
      findings.push({
        key: "exposed-git",
        severity: "high",
        title: "The .git folder is public",
        why: `${origin}/.git/HEAD answers with the repository's own data. With the .git folder, anyone can download the whole source code and its history, including any password or key ever committed.`,
        fix: {
          steps: "Stop deploying the .git folder (deploy a build output, or exclude .git), or block every path starting with /.git at the server. Then rotate any secret that was ever committed to the repository.",
          code: "# nginx\nlocation ~ /\\.git { deny all; }",
        },
      });
    }
  }
  if (env && !sameAsFallback(env) && looksLikeEnv(decode(env))) {
    findings.push({
      key: "exposed-env",
      severity: "high",
      title: "The .env file is public",
      why: `${origin}/.env answers with KEY=VALUE settings. That file usually holds database passwords and API keys, and bots look for it on every site.`,
      fix: {
        steps: "Remove .env from the folder the site is served from (or block /.env at the server), then rotate every key and password in it: assume they've been copied.",
        code: "# nginx\nlocation ~ /\\.env { deny all; }",
      },
    });
  }
  if (dsStore && !sameAsFallback(dsStore) && DS_STORE_MAGIC.every((b, i) => dsStore[i] === b)) {
    findings.push({
      key: "exposed-ds-store",
      severity: "low",
      title: "A .DS_Store file is public",
      why: "macOS leaves .DS_Store files in folders. Served on the web, it lists the names of files in that folder, which can point to things that aren't linked anywhere.",
      fix: { steps: "Delete .DS_Store from the deployed files and add it to .gitignore (and your deploy's ignore list)." },
    });
  }
  return { findings };
}

// ---------------------------------------------------------------- DNS

type Lookup<T> = { ok: true; value: T } | { ok: false; why: string };

// "No such record" is an answer (none); anything else is a failed lookup.
async function lookup<T>(run: () => Promise<T>, none: T): Promise<Lookup<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENODATA" || code === "ENOTFOUND") return { ok: true, value: none };
    return { ok: false, why: code ?? (err as Error).message };
  }
}

const joined = (records: string[][]) => records.map((chunks) => chunks.join(""));
const isIp = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");

export async function auditDns(app: App, deps: AuditDeps = {}): Promise<AuditResult> {
  const r = deps.resolver ?? realResolver;
  const host = hostnameOf(app.url);
  if (!host || isIp(host) || !host.includes(".") || host.endsWith(".localhost") || host.endsWith(".local")) {
    return { findings: [], notes: [`${host || app.url} isn't a public domain name, so there's no DNS to check.`] };
  }
  const domain = registrableDomain(host);
  // CAA counts on the host or any name above it, up to the domain.
  const caaNames: string[] = [];
  for (let name = host; ; name = name.slice(name.indexOf(".") + 1)) {
    caaNames.push(name);
    if (name === domain || !name.includes(".")) break;
  }

  const issuerOf = deps.certIssuer ?? (deps.resolver ? undefined : liveCertIssuer);
  const [issuer, txt, mx, dmarc, ...caa] = await Promise.all([
    issuerOf ? issuerOf(host).catch(() => undefined) : Promise.resolve(undefined),
    lookup(() => r.resolveTxt(domain), [] as string[][]),
    lookup(() => r.resolveMx(domain), [] as { exchange: string; priority: number }[]),
    lookup(() => r.resolveTxt(`_dmarc.${domain}`), [] as string[][]),
    ...caaNames.map((name) => lookup(() => r.resolveCaa(name), [] as unknown[])),
  ]);
  const all: Lookup<unknown>[] = [txt, mx, dmarc, ...caa];
  if (all.every((l) => !l.ok)) {
    throw new Error(`DNS lookups for ${domain} failed (${(txt as { why: string }).why})`);
  }

  const findings: FindingDraft[] = [];
  const notes: string[] = [];
  // Unknown MX counts as "sends mail": the safer guess.
  const hasMx = mx.ok ? mx.value.length > 0 : true;
  if (!mx.ok) notes.push(`Couldn't read the MX (mail server) records of ${domain}: ${mx.why}`);

  if (txt.ok) findings.push(...spfFindings(domain, joined(txt.value), hasMx));
  else notes.push(`Couldn't read the TXT records of ${domain}, so SPF wasn't checked: ${txt.why}`);

  if (dmarc.ok) findings.push(...dmarcFindings(domain, joined(dmarc.value), hasMx));
  else notes.push(`Couldn't read the DMARC record (_dmarc.${domain}): ${dmarc.why}`);

  const caaFound = caa.some((l) => l.ok && l.value.length > 0);
  const caaFailed = caa.filter((l): l is { ok: false; why: string } => !l.ok);
  if (!caaFound && caaFailed.length) notes.push(`Couldn't read the CAA records, so they weren't checked: ${caaFailed[0].why}`);
  else if (!caaFound) {
    const ca = caaNameFor(issuer);
    findings.push({
      key: "caa-missing",
      severity: "low",
      title: "No CAA record",
      why: `Any certificate authority may issue an HTTPS certificate for ${domain}. A CAA record limits that to the ones you use, so a mistake or trick at another authority can't produce a valid certificate for your site.`,
      fix: {
        steps: ca
          ? `Add a CAA record on ${domain} naming the certificate authority you use. Your site's certificate is from ${ca.label} today, so the example names it; add a line for any other authority your host may switch to (your host's docs say which). Cloudflare adds the ones it uses by itself.`
          : `Add a CAA record on ${domain} naming the certificate authority you actually use (your host's docs say which: Let's Encrypt, Google Trust Services, Amazon, DigiCert…). Add one line per authority. The example is for Let's Encrypt.`,
        link: { url: "https://letsencrypt.org/docs/caa/", label: "CAA at Let's Encrypt" },
        code: `${domain}. CAA 0 issue "${ca?.name ?? "letsencrypt.org"}"`,
      },
    });
  }
  return { findings, ...(notes.length ? { notes } : {}) };
}

function spfFindings(domain: string, records: string[], hasMx: boolean): FindingDraft[] {
  const spf = records.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  const link = { url: "https://www.cloudflare.com/learning/dns/dns-records/dns-spf-record/", label: "SPF records explained" };
  if (spf.length === 0) {
    return [
      hasMx
        ? {
            key: "spf-missing",
            severity: "medium",
            title: "No SPF record",
            why: `${domain} receives mail but doesn't say which servers may send mail as it. Anyone can send email that claims to come from @${domain}, and your own mail is more likely to land in spam.`,
            fix: {
              steps: `Add a TXT record on ${domain} listing the services that send your mail. Your email provider's docs give the include: to use (the example is Google Workspace). Keep just one SPF record.`,
              link,
              code: "v=spf1 include:_spf.google.com -all",
            },
          }
        : {
            key: "spf-missing",
            severity: "low",
            title: "No SPF record",
            why: `${domain} sends no mail, but doesn't say so. Without an SPF record, someone can send email that claims to come from @${domain} and it's more likely to be believed.`,
            fix: { steps: `Add this TXT record on ${domain}: it says no server sends mail for the domain. If you start sending mail later, replace it with your provider's.`, link, code: "v=spf1 -all" },
          },
    ];
  }
  if (spf.length > 1) {
    return [
      {
        key: "spf-multiple",
        severity: "high",
        title: "More than one SPF record",
        why: `${domain} has ${spf.length} SPF records. That's invalid: mail servers then treat the domain as having no SPF at all, so your mail can be rejected or marked as spam, and spoofing isn't stopped.`,
        fix: { steps: "Merge them into a single TXT record that starts with v=spf1, with every include: in it, ending in one -all or ~all. Delete the others.", link, code: spf.join("\n") },
      },
    ];
  }
  if (/(^|\s)\+all(\s|$)/i.test(spf[0])) {
    return [
      {
        key: "spf-plus-all",
        severity: "high",
        title: "SPF allows every server (+all)",
        why: `The SPF record ends in +all, which tells mail servers that any server in the world may send mail as @${domain}. That's the same as inviting spoofing.`,
        fix: { steps: "Change +all to -all (or ~all while you check nothing legitimate breaks).", link, code: spf[0].replace(/(^|\s)\+all(\s|$)/i, "$1-all$2") },
      },
    ];
  }
  return [];
}

function dmarcFindings(domain: string, records: string[], hasMx: boolean): FindingDraft[] {
  const dmarc = records.filter((t) => /^v=DMARC1\s*(;|$)/i.test(t.trim()));
  const link = { url: "https://support.google.com/a/answer/2466580", label: "Setting up DMARC" };
  const starter = `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`;
  if (dmarc.length === 0) {
    return [
      {
        key: "dmarc-missing",
        severity: hasMx ? "medium" : "low",
        title: "No DMARC record",
        why: hasMx
          ? `Nothing tells mail servers what to do with mail that fails SPF or DKIM checks for @${domain}, so spoofed mail can still get through, and you never hear about it.`
          : `${domain} sends no mail, but without DMARC, mail servers aren't told to reject mail that pretends to come from it.`,
        fix: hasMx
          ? {
              steps: `Add a TXT record named _dmarc.${domain}. Change the rua address to a mailbox you read: reports of who sends mail as your domain arrive there. Once they show only your own services, change p=none to p=quarantine (then p=reject).`,
              link,
              code: starter,
            }
          : {
              steps: `Add a TXT record named _dmarc.${domain} telling mail servers to reject anything claiming to be from the domain.`,
              link,
              code: "v=DMARC1; p=reject",
            },
      },
    ];
  }
  if (dmarc.length > 1) {
    return [
      {
        key: "dmarc-multiple",
        severity: "medium",
        title: "More than one DMARC record",
        why: `_dmarc.${domain} has ${dmarc.length} DMARC records. Mail servers then ignore DMARC for the domain altogether.`,
        fix: { steps: `Keep a single TXT record on _dmarc.${domain} and delete the others.`, link, code: dmarc.join("\n") },
      },
    ];
  }
  const policy = /(^|;)\s*p\s*=\s*(\w+)/i.exec(dmarc[0])?.[2]?.toLowerCase();
  if (hasMx && policy === "none") {
    return [
      {
        key: "dmarc-monitoring",
        severity: "low",
        title: "DMARC is monitoring only (p=none)",
        why: "Mail that fails the checks is still delivered; the policy only produces reports. That's the right first step, but it doesn't stop spoofing.",
        fix: {
          steps: "When the reports show only your own services sending as the domain, change p=none to p=quarantine (failing mail goes to spam), and later to p=reject.",
          link,
          code: dmarc[0].replace(/(^|;)(\s*)p\s*=\s*none/i, "$1$2p=quarantine"),
        },
      },
    ];
  }
  return [];
}
