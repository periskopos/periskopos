import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AuditResult, FindingDraft } from "../shared/types.ts";
import { auditApp, configReport, lastAuditAt, mergeOverlaps, setIgnored } from "../server/audits/audit.ts";
import { openDb } from "../server/db.ts";
import * as store from "../server/store.ts";
import { configDetail } from "../mcp/shape.ts";

// Configuration checks (server/audits/audit.ts): what each source found is kept,
// recognised the next day, ignored for good when asked, and gone once fixed.
// The site and DNS checks are stand-ins here; nothing reaches the network.

const finding = (key: string, severity: FindingDraft["severity"] = "medium"): FindingDraft => ({
  key,
  severity,
  title: `Problem ${key}`,
  why: `Why ${key} matters.`,
  fix: { steps: `Fix ${key}.`, code: `fix ${key}` },
});

function setup() {
  const db = openDb(":memory:");
  const user = store.createUser(db, "Me");
  const app = store.createApp(db, user.id, { name: "Star-Map", url: "https://example.org/" });
  let site: AuditResult | Error = { findings: [] };
  let dns: AuditResult | Error = { findings: [] };
  const checks = {
    site: async () => {
      if (site instanceof Error) throw site;
      return site;
    },
    dns: async () => {
      if (dns instanceof Error) throw dns;
      return dns;
    },
  };
  return {
    db,
    app,
    set: (s: AuditResult | Error, d: AuditResult | Error = { findings: [] }) => {
      site = s;
      dns = d;
    },
    run: (at = "2026-10-29T10:00:00.000Z") => auditApp(db, store.getAppById(db, app.id)!, checks, new Date(at)),
  };
}

describe("configuration checks: what's kept", () => {
  test("findings are kept worst first, with where they came from; the first check tells about none", async () => {
    const t = setup();
    t.set({ findings: [finding("hsts", "medium"), finding("x-content-type", "low")] }, { findings: [finding("dmarc-missing", "high")] });
    const { report, fresh } = await t.run();
    assert.deepEqual(report.findings.map((f) => [f.id, f.severity, f.sourceLabel]), [
      ["dns:dmarc-missing", "high", "DNS"],
      ["site:hsts", "medium", "The site"],
      ["site:x-content-type", "low", "The site"],
    ]);
    assert.equal(report.checkedAt, "2026-10-29T10:00:00.000Z");
    assert.deepEqual(fresh, [], "an app's first check has nothing to compare with");
    assert.equal(lastAuditAt(t.db, t.app.id), Date.parse("2026-10-29T10:00:00.000Z"));
  });

  test("found again: keeps its first-seen date; new: is fresh; no longer found: fixed and gone", async () => {
    const t = setup();
    t.set({ findings: [finding("hsts"), finding("csp")] });
    await t.run("2026-10-28T10:00:00.000Z");
    t.set({ findings: [finding("hsts"), finding("git-exposed", "high")] });
    const { report, fresh } = await t.run("2026-10-29T10:00:00.000Z");
    assert.deepEqual(report.findings.map((f) => f.id), ["site:git-exposed", "site:hsts"]);
    const hsts = report.findings.find((f) => f.id === "site:hsts")!;
    assert.equal(hsts.firstSeen, "2026-10-28T10:00:00.000Z");
    assert.equal(hsts.lastSeen, "2026-10-29T10:00:00.000Z");
    assert.deepEqual(fresh.map((f) => f.id), ["site:git-exposed"]);
  });

  test("a source that couldn't be read keeps what it found, and says why", async () => {
    const t = setup();
    t.set({ findings: [finding("hsts")] }, { findings: [finding("spf-missing")] });
    await t.run("2026-10-28T10:00:00.000Z");
    t.set(new Error("The site didn't answer"), { findings: [] });
    const { report } = await t.run("2026-10-29T10:00:00.000Z");
    assert.deepEqual(report.findings.map((f) => f.id), ["site:hsts"], "the site's stays; DNS's was fixed");
    assert.deepEqual(report.notes, [{ source: "The site", text: "Couldn't check: The site didn't answer" }]);
  });

  test("ignored stays ignored when found again, and isn't told about", async () => {
    const t = setup();
    t.set({ findings: [finding("csp")] });
    await t.run("2026-10-28T10:00:00.000Z");
    assert.equal(setIgnored(t.db, t.app.id, "site:csp", true), true);
    const { report } = await t.run("2026-10-29T10:00:00.000Z");
    assert.equal(report.findings[0]!.ignored, true);
    assert.equal(setIgnored(t.db, t.app.id, "site:nope", true), false);
  });

  test("an app not live yet has no site to check", async () => {
    const t = setup();
    store.updateApp(t.db, store.getAppById(t.db, t.app.id)!, { live: false });
    t.set({ findings: [finding("hsts")] });
    const { report } = await t.run();
    assert.deepEqual(report.findings, []);
    assert.equal(report.checkedAt, "2026-10-29T10:00:00.000Z");
  });

  test("what a source the app no longer has found goes with it", async () => {
    const t = setup();
    t.set({ findings: [finding("hsts")] }, { findings: [finding("spf-missing")] });
    await t.run("2026-10-28T10:00:00.000Z");
    // Taken off the air: the site and its DNS aren't checked any more, so their findings can't stand.
    store.updateApp(t.db, store.getAppById(t.db, t.app.id)!, { live: false });
    const { report } = await t.run("2026-10-29T10:00:00.000Z");
    assert.deepEqual(report.findings, []);
  });

  test("an assistant gets what to fix, what to paste, and what was ignored", async () => {
    const t = setup();
    t.set({ findings: [finding("csp"), finding("hsts", "high")] });
    await t.run();
    setIgnored(t.db, t.app.id, "site:csp", true);
    const out = configDetail(store.getAppById(t.db, t.app.id)!, configReport(t.db, store.getAppById(t.db, t.app.id)!));
    assert.equal(out.toFix.length, 1);
    assert.deepEqual(out.toFix[0], { severity: "high", where: "The site", problem: "Problem hsts", why: "Why hsts matters.", fix: "Fix hsts.", paste: "fix hsts", since: "2026-10-29T10:00:00.000Z" });
    assert.deepEqual(out.ignoredByYou, ["The site: Problem csp"]);
  });
});

describe("configuration checks: the same problem said once", () => {
  const src = (source: string) => ({ source, label: source, run: async () => ({ findings: [] }) });
  const ran = (source: string, ...keys: [string, FindingDraft["severity"]][]) => ({ s: src(source), result: { findings: keys.map(([k, sev]) => finding(k, sev)) } });

  test("http:// not redirecting and Always Use HTTPS off: Cloudflare's finding stays, at the higher severity", () => {
    const results = [ran("site", ["http-no-redirect", "high"], ["csp-missing", "medium"]), ran("cloudflare-zone", ["always-use-https", "medium"], ["dnssec", "low"])];
    mergeOverlaps(results);
    assert.deepEqual(results[0]!.result.findings.map((f) => f.key), ["csp-missing"]);
    assert.deepEqual(results[1]!.result.findings.map((f) => [f.key, f.severity]), [["always-use-https", "high"], ["dnssec", "low"]]);
  });

  test("Cloudflare's HSTS off while the site sends the header anyway: not a problem", () => {
    const results = [ran("site"), ran("cloudflare-zone", ["hsts", "low"])];
    mergeOverlaps(results);
    assert.deepEqual(results[1]!.result.findings, []);
  });

  test("the site unreachable: Cloudflare's findings stand on their own", () => {
    const results: { s: ReturnType<typeof src>; result?: AuditResult; error?: string }[] = [{ s: src("site"), error: "no answer" }, ran("cloudflare-zone", ["hsts", "low"])];
    mergeOverlaps(results);
    assert.equal(results[1]!.result!.findings.length, 1);
  });

  test("SPF and DMARC from Security Insights give way to the live DNS check", () => {
    const results = [ran("dns", ["dmarc-missing", "medium"]), ran("cloudflare-zone", ["insight:email_security:spf", "medium"], ["insight:exposed_infrastructure:x", "high"])];
    mergeOverlaps(results);
    assert.deepEqual(results[1]!.result.findings.map((f) => f.key), ["insight:exposed_infrastructure:x"]);
  });
});
