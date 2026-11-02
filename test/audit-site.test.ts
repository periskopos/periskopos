import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { auditDns, auditSite, caaNameFor, cookieProblems, dohResolver, fallbackResolver, looksLikeEnv } from "../server/audits/site.ts";
import type { DnsResolver, Fetcher } from "../server/audits/site.ts";
import type { App, AuditResult } from "../shared/types.ts";

// The keyless configuration checks, against a fake site and fake DNS whose
// answers each test controls. No network.

const app = (url = "https://app.example.com/"): App => ({ id: "a1", slug: "x", ownerId: "u", name: "X", url, live: true, checkIntervalMin: 5, connections: [] });

const PAGE = "<!doctype html><html><body>app</body></html>";
const GOOD_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  server: "nginx",
};

type Answer = { status?: number; headers?: Record<string, string> | [string, string][]; body?: string | Uint8Array } | "fail";

// A site from a table of URL → answer; anything not in it is a 404 (or,
// with `spa`, the app page).
function site(table: Record<string, Answer>, opts: { spa?: boolean } = {}): Fetcher & { seen: string[] } {
  const seen: string[] = [];
  const f = (async (url: string) => {
    seen.push(url);
    let a = table[url];
    if (a === undefined) a = opts.spa && url.startsWith("https://") ? { headers: GOOD_HEADERS, body: PAGE } : { status: 404, body: "not found" };
    if (a === "fail") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return new Response((a.body ?? "") as BodyInit, { status: a.status ?? 200, headers: a.headers ?? {} });
  }) as unknown as Fetcher & { seen: string[] };
  f.seen = seen;
  return f;
}

const goodSite = (extra: Record<string, Answer> = {}, opts?: { spa?: boolean }) =>
  site({ "https://app.example.com/": { headers: GOOD_HEADERS, body: PAGE }, "http://app.example.com/": { status: 301, headers: { location: "https://app.example.com/" } }, ...extra }, opts);

const keys = (r: AuditResult) => r.findings.map((f) => f.key).sort();
const find = (r: AuditResult, key: string) => r.findings.find((f) => f.key === key);

describe("auditSite", () => {
  test("a well-configured site has no findings", async () => {
    const r = await auditSite(app(), { fetch: goodSite() });
    assert.deepEqual(r.findings, []);
    assert.equal(r.notes, undefined);
  });

  test("a well-configured single-page app (200 for every path) has no findings", async () => {
    const r = await auditSite(app(), { fetch: goodSite({}, { spa: true }) });
    assert.deepEqual(r.findings, []);
  });

  test("an unreachable site throws", async () => {
    await assert.rejects(auditSite(app(), { fetch: site({ "https://app.example.com/": "fail" }) }), /didn't answer: Connection refused/);
  });

  test("http:// served without a redirect is high", async () => {
    const r = await auditSite(app(), { fetch: goodSite({ "http://app.example.com/": { body: PAGE } }) });
    assert.deepEqual(keys(r), ["http-no-redirect"]);
    assert.equal(find(r, "http-no-redirect")!.severity, "high");
  });

  test("http:// redirecting through www to https is fine; http:// not answering at all is fine", async () => {
    const chain = goodSite({
      "http://app.example.com/": { status: 301, headers: { location: "http://www.app.example.com/" } },
      "http://www.app.example.com/": { status: 302, headers: { location: "https://app.example.com/" } },
    });
    assert.deepEqual((await auditSite(app(), { fetch: chain })).findings, []);
    assert.deepEqual((await auditSite(app(), { fetch: goodSite({ "http://app.example.com/": "fail" }) })).findings, []);
  });

  test("http:// redirecting to another http:// page is flagged", async () => {
    const r = await auditSite(app(), {
      fetch: goodSite({ "http://app.example.com/": { status: 301, headers: { location: "/home" } }, "http://app.example.com/home": { body: PAGE } }),
    });
    assert.deepEqual(keys(r), ["http-no-redirect"]);
  });

  test("the app's own redirect chain is followed to the final page", async () => {
    const f = goodSite({
      "https://example.com/": { status: 308, headers: { location: "https://app.example.com/" } },
      "http://example.com/": { status: 301, headers: { location: "https://example.com/" } },
    });
    const r = await auditSite(app("https://example.com/"), { fetch: f });
    assert.ok(f.seen.includes("https://app.example.com/.env"), "probes go to the final origin");
    assert.deepEqual(r.findings, []);
  });

  test("an http:// app that stays on http notes that HTTPS checks were skipped", async () => {
    const r = await auditSite(app("http://app.example.com/"), { fetch: site({ "http://app.example.com/": { headers: { "content-type": "text/html" }, body: PAGE } }) });
    assert.deepEqual(r.findings, []);
    assert.match(r.notes![0], /http:\/\//);
  });

  test("each missing header gives its finding", async () => {
    const r = await auditSite(app(), { fetch: goodSite({ "https://app.example.com/": { headers: { "content-type": "text/html" }, body: PAGE } }) });
    assert.deepEqual(keys(r), ["clickjacking", "csp-missing", "hsts-missing", "nosniff-missing"]);
    assert.equal(find(r, "hsts-missing")!.severity, "medium");
    assert.equal(find(r, "csp-missing")!.severity, "medium");
    assert.equal(find(r, "clickjacking")!.severity, "medium");
    assert.equal(find(r, "nosniff-missing")!.severity, "low");
    assert.match(find(r, "hsts-missing")!.fix.code!, /^Strict-Transport-Security: max-age=/);
  });

  test("short HSTS, report-only CSP, X-Frame-Options and revealing versions", async () => {
    const headers = {
      "content-type": "text/html",
      "strict-transport-security": "max-age=86400",
      "content-security-policy-report-only": "default-src 'self'",
      "x-frame-options": "SAMEORIGIN",
      "x-content-type-options": "nosniff",
      server: "nginx/1.18.0",
      "x-powered-by": "PHP/8.1.2",
    };
    const r = await auditSite(app(), { fetch: goodSite({ "https://app.example.com/": { headers, body: PAGE } }) });
    assert.deepEqual(keys(r), ["csp-report-only", "hsts-short", "version-header"]);
    for (const f of r.findings) assert.equal(f.severity, "low");
    assert.match(find(r, "hsts-short")!.why, /1 day/);
    assert.match(find(r, "version-header")!.why, /nginx\/1\.18\.0.*PHP\/8\.1\.2/);
  });

  test("a JSON endpoint isn't asked for a CSP or frame protection", async () => {
    const headers = { ...GOOD_HEADERS, "content-type": "application/json" } as Record<string, string>;
    delete headers["content-security-policy"];
    const r = await auditSite(app("https://app.example.com/"), { fetch: goodSite({ "https://app.example.com/": { headers, body: "{}" } }) });
    assert.deepEqual(r.findings, []);
  });

  test("cookies without Secure, HttpOnly or SameSite are named, never their value", async () => {
    const headers: [string, string][] = [
      ...Object.entries(GOOD_HEADERS),
      ["set-cookie", "sid=supersecretvalue; Path=/"],
      ["set-cookie", "theme=dark; Path=/; Secure; HttpOnly; SameSite=Lax"],
      ["set-cookie", "csrf=abc; Secure; SameSite=Strict"],
    ];
    const r = await auditSite(app(), { fetch: goodSite({ "https://app.example.com/": { headers, body: PAGE } }) });
    assert.deepEqual(keys(r), ["cookie:csrf", "cookie:sid"]);
    const sid = find(r, "cookie:sid")!;
    assert.equal(sid.severity, "medium");
    assert.match(sid.title, /Secure, HttpOnly and SameSite/);
    assert.match(find(r, "cookie:csrf")!.title, /missing HttpOnly$/);
    assert.ok(!JSON.stringify(r).includes("supersecretvalue"));
  });

  test("cookie parsing", () => {
    assert.deepEqual(cookieProblems("a=1; secure; httponly; samesite=none", true), { name: "a", missing: [] });
    assert.deepEqual(cookieProblems("a=1", false), { name: "a", missing: ["HttpOnly", "SameSite"] });
    assert.deepEqual(cookieProblems("a=; Max-Age=0", true), { name: "a", missing: [] });
    assert.equal(cookieProblems("garbage", true), undefined);
  });

  test("an exposed .git, .env and .DS_Store are found", async () => {
    const ds = new Uint8Array([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31, 0, 0, 16, 0]);
    const r = await auditSite(app(), {
      fetch: goodSite({
        "https://app.example.com/.git/HEAD": { headers: { "content-type": "text/plain" }, body: "ref: refs/heads/main\n" },
        "https://app.example.com/.env": { headers: { "content-type": "text/plain" }, body: "# prod\nDATABASE_URL=postgres://x\nSTRIPE_KEY=sk_live_x\n" },
        "https://app.example.com/.DS_Store": { headers: { "content-type": "application/octet-stream" }, body: ds },
      }),
    });
    assert.deepEqual(keys(r), ["exposed-ds-store", "exposed-env", "exposed-git"]);
    assert.equal(find(r, "exposed-git")!.severity, "high");
    assert.equal(find(r, "exposed-env")!.severity, "high");
    assert.equal(find(r, "exposed-ds-store")!.severity, "low");
    assert.ok(!JSON.stringify(r).includes("sk_live_x"));
  });

  test("an SPA answering its page for /.env and /.git/HEAD isn't flagged, even when the page varies a little", async () => {
    const f = goodSite(
      {
        // Same page as the fallback.
        "https://app.example.com/.env": { headers: GOOD_HEADERS, body: PAGE },
        // A different HTML page: still not a .env or a git HEAD.
        "https://app.example.com/.git/HEAD": { headers: GOOD_HEADERS, body: "<!doctype html><title>Not found</title>ref: refs/" },
      },
      { spa: true },
    );
    assert.deepEqual((await auditSite(app(), { fetch: f })).findings, []);
  });

  test("a site answering every path with the same text isn't flagged, even text that reads like a .env or a git HEAD", async () => {
    // Whatever a made-up path gets is the site's fallback, not the file.
    for (const body of ["status=ok\n", "ref: refs/heads/main\n"]) {
      const good = goodSite();
      const f = (async (url: string) =>
        url === "https://app.example.com/" || url.startsWith("http://") ? good(url, {}) : new Response(body, { headers: { "content-type": "text/plain" } })) as unknown as Fetcher;
      assert.deepEqual((await auditSite(app(), { fetch: f })).findings, [], body);
    }
  });

  test("a 200 with text that isn't KEY=VALUE isn't a .env", () => {
    assert.equal(looksLikeEnv("Hello there.\nThis is a page."), false);
    assert.equal(looksLikeEnv("<html>A=1</html>"), false);
    assert.equal(looksLikeEnv("export API_KEY=1\nB = 2"), true);
  });

  test("probes failing leave a note, not a throw", async () => {
    const r = await auditSite(app(), { fetch: goodSite({ "https://app.example.com/.env": "fail" }) });
    assert.deepEqual(r.findings, []);
    assert.match(r.notes![0], /exposed files/);
  });
});

// ---------------------------------------------------------------- DNS

const err = (code: string) => Object.assign(new Error(`query ${code}`), { code });
type Zone = { txt?: Record<string, string[][] | Error>; mx?: Record<string, unknown[] | Error>; caa?: Record<string, unknown[] | Error> };

function resolver(zone: Zone): DnsResolver & { asked: string[] } {
  const asked: string[] = [];
  const answer = async <T>(table: Record<string, T | Error> | undefined, name: string, kind: string): Promise<T> => {
    asked.push(`${kind} ${name}`);
    const a = table?.[name];
    if (a === undefined) throw err("ENODATA");
    if (a instanceof Error) throw a;
    return a;
  };
  return {
    asked,
    resolveTxt: (n) => answer(zone.txt, n, "txt"),
    resolveMx: (n) => answer(zone.mx, n, "mx") as Promise<{ exchange: string; priority: number }[]>,
    resolveCaa: (n) => answer(zone.caa, n, "caa"),
  };
}

const MX = { "example.com": [{ exchange: "mx.example.com", priority: 10 }] };
const GOOD_ZONE: Zone = {
  txt: { "example.com": [["v=spf1 include:_spf.google.com ", "-all"], ["google-site-verification=x"]], "_dmarc.example.com": [["v=DMARC1; p=reject; rua=mailto:d@example.com"]] },
  mx: MX,
  caa: { "example.com": [{ critical: 0, issue: "letsencrypt.org" }] },
};

describe("auditDns", () => {
  test("a well-configured domain has no findings; mail records are read on the registrable domain", async () => {
    const r = resolver(GOOD_ZONE);
    const result = await auditDns(app(), { resolver: r });
    assert.deepEqual(result.findings, []);
    assert.equal(result.notes, undefined);
    assert.ok(r.asked.includes("txt example.com") && r.asked.includes("txt _dmarc.example.com") && r.asked.includes("mx example.com"));
    assert.ok(r.asked.includes("caa app.example.com") && r.asked.includes("caa example.com"));
  });

  test("country endings: app.shop.co.uk reads shop.co.uk", async () => {
    const r = resolver({});
    await auditDns(app("https://app.shop.co.uk/"), { resolver: r });
    assert.ok(r.asked.includes("txt shop.co.uk"));
    assert.ok(!r.asked.includes("caa co.uk"));
  });

  test("CAA on the host itself counts", async () => {
    const zone = { ...GOOD_ZONE, caa: { "app.example.com": [{ issue: "pki.goog" }] } };
    assert.deepEqual((await auditDns(app(), { resolver: resolver(zone) })).findings, []);
  });

  test("nothing at all, with mail: SPF and DMARC medium, CAA low", async () => {
    const r = await auditDns(app(), { resolver: resolver({ mx: MX }) });
    assert.deepEqual(keys(r), ["caa-missing", "dmarc-missing", "spf-missing"]);
    assert.equal(find(r, "spf-missing")!.severity, "medium");
    assert.equal(find(r, "dmarc-missing")!.severity, "medium");
    assert.equal(find(r, "caa-missing")!.severity, "low");
    assert.match(find(r, "dmarc-missing")!.fix.code!, /^v=DMARC1; p=none; rua=mailto:dmarc@example\.com$/);
    assert.match(find(r, "dmarc-missing")!.fix.steps, /quarantine/);
    assert.match(find(r, "caa-missing")!.fix.code!, /example\.com\. CAA 0 issue "letsencrypt\.org"/);
  });

  test("the CAA example names the authority behind the site's certificate today", async () => {
    const r = await auditDns(app(), { resolver: resolver({ mx: MX }), certIssuer: async () => "Google Trust Services" });
    assert.match(find(r, "caa-missing")!.fix.code!, /example\.com\. CAA 0 issue "pki\.goog"/);
    assert.match(find(r, "caa-missing")!.fix.steps, /from Google Trust Services today/);
    assert.deepEqual(caaNameFor("Let's Encrypt"), { name: "letsencrypt.org", label: "Let's Encrypt" });
    assert.equal(caaNameFor("ZeroSSL")?.name, "sectigo.com");
    assert.equal(caaNameFor("Some Other CA"), undefined);
  });

  test("nothing at all, no mail: SPF and DMARC low, SPF fix is v=spf1 -all", async () => {
    const r = await auditDns(app(), { resolver: resolver({ txt: { "example.com": err("ENOTFOUND") } }) });
    assert.equal(find(r, "spf-missing")!.severity, "low");
    assert.equal(find(r, "spf-missing")!.fix.code, "v=spf1 -all");
    assert.equal(find(r, "dmarc-missing")!.severity, "low");
  });

  test("SPF with +all is high", async () => {
    const zone = { ...GOOD_ZONE, txt: { ...GOOD_ZONE.txt, "example.com": [["v=spf1 include:x.com +all"]] } };
    const r = await auditDns(app(), { resolver: resolver(zone) });
    assert.deepEqual(keys(r), ["spf-plus-all"]);
    assert.equal(find(r, "spf-plus-all")!.severity, "high");
    assert.equal(find(r, "spf-plus-all")!.fix.code, "v=spf1 include:x.com -all");
  });

  test("two SPF records is high", async () => {
    const zone = { ...GOOD_ZONE, txt: { ...GOOD_ZONE.txt, "example.com": [["v=spf1 include:a.com -all"], ["v=spf1 include:b.com ~all"]] } };
    const r = await auditDns(app(), { resolver: resolver(zone) });
    assert.deepEqual(keys(r), ["spf-multiple"]);
    assert.equal(find(r, "spf-multiple")!.severity, "high");
  });

  test("DMARC p=none with mail is low monitoring-only; without mail it's fine", async () => {
    const zone = { ...GOOD_ZONE, txt: { ...GOOD_ZONE.txt, "_dmarc.example.com": [["v=DMARC1; p=none; rua=mailto:d@example.com"]] } };
    const r = await auditDns(app(), { resolver: resolver(zone) });
    assert.deepEqual(keys(r), ["dmarc-monitoring"]);
    assert.equal(find(r, "dmarc-monitoring")!.severity, "low");
    assert.equal(find(r, "dmarc-monitoring")!.fix.code, "v=DMARC1; p=quarantine; rua=mailto:d@example.com");
    const noMail = await auditDns(app(), { resolver: resolver({ ...zone, mx: {} }) });
    assert.deepEqual(noMail.findings, []);
  });

  test("a partial DNS failure is a note, and the rest is still checked", async () => {
    const zone = { ...GOOD_ZONE, txt: { "example.com": GOOD_ZONE.txt!["example.com"], "_dmarc.example.com": err("ESERVFAIL") }, caa: {} };
    const r = await auditDns(app(), { resolver: resolver(zone) });
    assert.deepEqual(keys(r), ["caa-missing"]);
    assert.equal(r.notes!.length, 1);
    assert.match(r.notes![0], /DMARC.*ESERVFAIL/);
  });

  test("mail servers that can't be read count as sending mail", async () => {
    const r = await auditDns(app(), { resolver: resolver({ mx: { "example.com": err("ESERVFAIL") } }) });
    assert.equal(find(r, "spf-missing")!.severity, "medium");
    assert.equal(find(r, "dmarc-missing")!.severity, "medium");
    assert.match(r.notes![0], /MX.*ESERVFAIL/);
  });

  test("a CAA lookup failing with none found is a note, not a finding", async () => {
    const zone = { ...GOOD_ZONE, caa: { "app.example.com": err("ETIMEOUT") } };
    const r = await auditDns(app(), { resolver: resolver(zone) });
    assert.deepEqual(r.findings, []);
    assert.match(r.notes![0], /CAA.*ETIMEOUT/);
  });

  test("every lookup failing throws", async () => {
    const down = err("ECONNREFUSED");
    const r: DnsResolver = { resolveTxt: async () => Promise.reject(down), resolveMx: async () => Promise.reject(down), resolveCaa: async () => Promise.reject(down) };
    await assert.rejects(auditDns(app(), { resolver: r }), /ECONNREFUSED/);
  });

  test("an IP address or localhost has no DNS to check", async () => {
    for (const url of ["http://127.0.0.1:3000/", "http://localhost:5173/"]) {
      const r = await auditDns(app(url), { resolver: resolver({}) });
      assert.deepEqual(r.findings, []);
      assert.equal(r.notes!.length, 1);
    }
  });
});

describe("DNS when the PC's own resolver can't be asked", () => {
  const refused = () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:53"), { code: "ECONNREFUSED" }));
  const absent = () => Promise.reject(Object.assign(new Error("no data"), { code: "ENODATA" }));
  const doh = (answers: Record<string, { type: number; data: string }[] | "nx">) =>
    (async (url: string) => {
      const u = new URL(url);
      const a = answers[`${u.searchParams.get("name")} ${u.searchParams.get("type")}`];
      return new Response(JSON.stringify(a === "nx" ? { Status: 3 } : { Status: 0, Answer: a ?? [] }), { headers: { "content-type": "application/dns-json" } });
    }) as Fetcher;

  test("refused: asked over HTTPS instead; quoted TXT pieces, MX and CAA read", async () => {
    const r = fallbackResolver(
      { resolveTxt: refused, resolveMx: refused, resolveCaa: refused },
      dohResolver(doh({ "x.com TXT": [{ type: 16, data: '"v=spf1 " "-all"' }], "x.com MX": [{ type: 15, data: "10 mail.x.com." }], "x.com CAA": [{ type: 257, data: '0 issue "letsencrypt.org"' }] })),
    );
    assert.deepEqual(await r.resolveTxt("x.com"), [["v=spf1 ", "-all"]]);
    assert.deepEqual(await r.resolveMx("x.com"), [{ priority: 10, exchange: "mail.x.com" }]);
    assert.equal((await r.resolveCaa("x.com")).length, 1);
  });

  test("an answer of 'no such record' isn't asked again; absent over HTTPS is absent too", async () => {
    let asked = 0;
    const r = fallbackResolver({ resolveTxt: absent, resolveMx: absent, resolveCaa: absent }, { resolveTxt: async () => (asked++, []), resolveMx: async () => [], resolveCaa: async () => [] });
    await assert.rejects(r.resolveTxt("x.com"), { code: "ENODATA" });
    assert.equal(asked, 0);
    await assert.rejects(dohResolver(doh({ "x.com TXT": "nx" })).resolveTxt("x.com"), { code: "ENODATA" });
    await assert.rejects(dohResolver(doh({})).resolveMx("x.com"), { code: "ENODATA" });
  });
});
