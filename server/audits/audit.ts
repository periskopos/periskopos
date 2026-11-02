import type { DatabaseSync } from "node:sqlite";
import { connectionLabel } from "../../shared/catalog.ts";
import type { App, AuditResult, ConfigReport, Finding, FindingFix, FindingSeverity } from "../../shared/types.ts";
import { auditDns, auditSite } from "./site.ts";
import { integrations } from "../integrations/index.ts";
import { authFor } from "../keys/secrets.ts";
import * as store from "../store.ts";

// Configuration checks: what's set up wrong around an app, and how to put it
// right. Each source (the site, its DNS, each connected account that knows
// how) says what it found; what a source finds again keeps its first-seen
// date and whether it's ignored, and what it no longer finds is fixed and
// goes. A source that couldn't be read keeps what it found last time: an
// unreachable API isn't a fix.

export const AUDIT_EVERY_MS = 24 * 60 * 60_000;
const SEVERITY_ORDER: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

type Source = { source: string; label: string; connectionId?: string; run: () => Promise<AuditResult> };
export type Checks = { site?: (app: App) => Promise<AuditResult>; dns?: (app: App) => Promise<AuditResult> };

type Row = {
  id: string;
  source: string;
  connection_id: string | null;
  severity: FindingSeverity;
  key: string;
  title: string;
  why: string;
  fix: string;
  first_seen: string;
  last_seen: string;
  ignored: number;
};

// The site and its DNS only once the app is live: before that there's
// nothing at the address to judge.
function sourcesOf(db: DatabaseSync, app: App, checks: Checks): Source[] {
  const out: Source[] = [];
  if (app.live && /^https?:\/\//.test(app.url)) {
    out.push({ source: "site", label: "The site", run: () => (checks.site ?? auditSite)(app) });
    out.push({ source: "dns", label: "DNS", run: () => (checks.dns ?? auditDns)(app) });
  }
  for (const conn of app.connections) {
    const integration = integrations[conn.type];
    if (!integration?.audit) continue;
    const service = conn.serviceId ? store.getService(db, app.ownerId, conn.serviceId) : undefined;
    if (integration.needsService && !service) continue;
    out.push({ source: conn.type, label: connectionLabel(conn), connectionId: conn.id, run: () => integration.audit!(conn, service ? authFor(service) : undefined, app) });
  }
  return out;
}

function findingOf(r: Row, labels: Map<string, string>): Finding {
  return {
    id: r.id,
    key: r.key,
    source: r.source,
    sourceLabel: labels.get(r.source) ?? r.source,
    ...(r.connection_id ? { connectionId: r.connection_id } : {}),
    severity: r.severity,
    title: r.title,
    why: r.why,
    fix: JSON.parse(r.fix) as FindingFix,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    ignored: r.ignored === 1,
  };
}

// (The app's status check is a connection of type "site" too: the site's
// own label wins.)
const labelsOf = (app: App) =>
  new Map<string, string>([...app.connections.map((c) => [c.type, connectionLabel(c)] as [string, string]), ["site", "The site"], ["dns", "DNS"]]);

export function configReport(db: DatabaseSync, app: App): ConfigReport {
  const labels = labelsOf(app);
  const rows = db.prepare("SELECT * FROM findings WHERE app_id = ?").all(app.id) as Row[];
  const audit = db.prepare("SELECT checked_at, notes FROM audits WHERE app_id = ?").get(app.id) as { checked_at: string; notes: string } | undefined;
  return {
    findings: rows.map((r) => findingOf(r, labels)).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.sourceLabel.localeCompare(b.sourceLabel) || a.title.localeCompare(b.title)),
    notes: audit ? (JSON.parse(audit.notes) as ConfigReport["notes"]) : [],
    ...(audit ? { checkedAt: audit.checked_at } : {}),
  };
}

export function lastAuditAt(db: DatabaseSync, appId: string): number | undefined {
  const row = db.prepare("SELECT checked_at FROM audits WHERE app_id = ?").get(appId) as { checked_at: string } | undefined;
  return row ? Date.parse(row.checked_at) : undefined;
}

export function setIgnored(db: DatabaseSync, appId: string, id: string, ignored: boolean): boolean {
  return db.prepare("UPDATE findings SET ignored = ? WHERE app_id = ? AND id = ?").run(ignored ? 1 : 0, appId, id).changes > 0;
}

// Every source at once; what each found, kept. `fresh` is what no check had
// found before, for the watcher to tell about (not on an app's first check,
// whose findings are all new).
const running = new Map<string, Promise<{ report: ConfigReport; fresh: Finding[] }>>();
export function auditApp(db: DatabaseSync, app: App, checks: Checks = {}, now = new Date()): Promise<{ report: ConfigReport; fresh: Finding[] }> {
  let pending = running.get(app.id);
  if (!pending) {
    pending = runAudit(db, app, checks, now).finally(() => running.delete(app.id));
    running.set(app.id, pending);
  }
  return pending;
}

type Ran = { s: Source; result?: AuditResult; error?: string };
const RANK: Record<FindingSeverity, number> = { high: 3, medium: 2, low: 1 };

// The same problem seen from two sides, said once. The site and DNS checks
// read what the world actually gets, so they decide whether it's a problem;
// when Cloudflare's setting is the cause, its finding stays (it names the
// switch to flip), at the severity of the two that's higher. Done before
// anything is kept, so a merged finding isn't "new" every day.
const OVERLAPS: { live: string; liveKey: string; cfKey: (k: string) => boolean }[] = [
  { live: "site", liveKey: "http-no-redirect", cfKey: (k) => k === "always-use-https" },
  { live: "site", liveKey: "hsts-missing", cfKey: (k) => k === "hsts" },
];
export function mergeOverlaps(results: Ran[]) {
  const answered = (source: string) => results.find((r) => r.s.source === source && r.result)?.result;
  const site = answered("site");
  const dns = answered("dns");
  for (const cf of results.filter((r) => r.s.source === "cloudflare-zone" && r.result)) {
    const cfResult = cf.result!;
    for (const o of OVERLAPS) {
      const live = o.live === "site" ? site : undefined;
      if (!live) continue;
      const liveFinding = live.findings.find((f) => f.key === o.liveKey);
      const cfFinding = cfResult.findings.find((f) => o.cfKey(f.key));
      if (!cfFinding) continue;
      if (!liveFinding) {
        cfResult.findings = cfResult.findings.filter((f) => f !== cfFinding); // fine as the world sees it
        continue;
      }
      if (RANK[liveFinding.severity] > RANK[cfFinding.severity]) cfFinding.severity = liveFinding.severity;
      live.findings = live.findings.filter((f) => f !== liveFinding);
    }
    // Cloudflare's Security Insights also report SPF and DMARC, from a scan
    // that may be days old: once the DNS check answered, its live reading wins.
    if (dns) cfResult.findings = cfResult.findings.filter((f) => !(f.key.startsWith("insight:") && /spf|dmarc/i.test(f.key)));
  }
}

async function runAudit(db: DatabaseSync, app: App, checks: Checks, now: Date) {
  const at = now.toISOString();
  const firstTime = lastAuditAt(db, app.id) === undefined;
  const sources = sourcesOf(db, app, checks);
  const results = await Promise.all(
    sources.map(async (s) => {
      try {
        return { s, result: await s.run() };
      } catch (err) {
        return { s, error: (err as Error).message };
      }
    }),
  );

  // The app may have gone while the checks ran.
  if (!store.getAppById(db, app.id)) return { report: { findings: [], notes: [] }, fresh: [] };
  mergeOverlaps(results);

  const before = new Set((db.prepare("SELECT id FROM findings WHERE app_id = ?").all(app.id) as { id: string }[]).map((r) => r.id));
  const notes: ConfigReport["notes"] = [];
  const freshIds: string[] = [];
  const upsert = db.prepare(
    `INSERT INTO findings (app_id, id, source, connection_id, key, severity, title, why, fix, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (app_id, id) DO UPDATE SET severity = excluded.severity, title = excluded.title, why = excluded.why, fix = excluded.fix, connection_id = excluded.connection_id, last_seen = excluded.last_seen`,
  );
  db.exec("BEGIN");
  try {
    const answered = new Set<string>();
    for (const { s, result, error } of results) {
      if (error !== undefined || !result) {
        notes.push({ source: s.label, text: `Couldn't check: ${error}` });
        continue;
      }
      answered.add(s.source);
      // Two connections to the same repository say the same thing once.
      for (const text of result.notes ?? []) if (!notes.some((n) => n.source === s.label && n.text === text)) notes.push({ source: s.label, text });
      for (const f of result.findings) {
        const id = `${s.source}:${f.key}`;
        upsert.run(app.id, id, s.source, s.connectionId ?? null, f.key, f.severity, f.title, f.why, JSON.stringify(f.fix), at, at);
        if (!before.has(id)) freshIds.push(id);
      }
    }
    // Fixed: found before by a source that answered, not found now. And
    // whatever came from a source the app no longer has.
    const have = new Set(sources.map((s) => s.source));
    for (const r of db.prepare("SELECT id, source, last_seen FROM findings WHERE app_id = ?").all(app.id) as { id: string; source: string; last_seen: string }[]) {
      if ((answered.has(r.source) && r.last_seen !== at) || !have.has(r.source)) db.prepare("DELETE FROM findings WHERE app_id = ? AND id = ?").run(app.id, r.id);
    }
    db.prepare("INSERT INTO audits (app_id, checked_at, notes) VALUES (?, ?, ?) ON CONFLICT (app_id) DO UPDATE SET checked_at = excluded.checked_at, notes = excluded.notes").run(
      app.id,
      at,
      JSON.stringify(notes),
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  const report = configReport(db, app);
  // Only what this audit found for the first time: a new finding can't be ignored yet.
  return { report, fresh: firstTime ? [] : report.findings.filter((f) => freshIds.includes(f.id)) };
}
