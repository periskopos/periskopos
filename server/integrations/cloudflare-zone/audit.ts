import type { AuditResult, Connection } from "../../../shared/types.ts";
import type { ServiceAuth } from "../types.ts";
import { AUDIT_PERMISSION, SETUP_TTL_MS, cf, hostOf, readOrNote, settingOf, zoneIdOf } from "./api.ts";
import type { CfBots, CfDnsRecord, CfEmailRouting, CfHsts, CfRumSite, CfSetting, Found } from "./api.ts";
import { httpsFindings } from "./https.ts";
import { injectedScriptFindings } from "./injected-scripts.ts";
import { addInsights, zoneInsights } from "./insights.ts";
import { emailRoutingFindings, wwwFindings } from "./www-email.ts";

// The configuration audit: every read at once, then each concern's checks
// in turn (HTTPS and DNSSEC, Cloudflare's scripts against the site's
// policy, www, Email Routing, Security Insights).

export async function auditZone(conn: Connection, auth: ServiceAuth): Promise<AuditResult> {
  const zoneId = zoneIdOf(conn);
  const setting = <V>(id: string) => readOrNote(() => cf<CfSetting<V>>(auth, `/zones/${zoneId}/settings/${id}`, SETUP_TTL_MS).then((s) => s.value));
  const account = settingOf(conn, "accountId");
  const www = `www.${conn.resource}`;
  const [ssl, alwaysHttps, minTls, hsts, rewrites, dnssec, insights, rocket, obfuscation, bots, rum, email, wwwRecords] = await Promise.all([
    setting<string>("ssl"),
    setting<string>("always_use_https"),
    setting<string>("min_tls_version"),
    setting<CfHsts>("security_header"),
    setting<string>("automatic_https_rewrites"),
    readOrNote(() => cf<{ status: string }>(auth, `/zones/${zoneId}/dnssec`, SETUP_TTL_MS)),
    readOrNote(() => zoneInsights(auth, zoneId)),
    setting<string>("rocket_loader"),
    setting<string>("email_obfuscation"),
    readOrNote(() => cf<CfBots>(auth, `/zones/${zoneId}/bot_management`, SETUP_TTL_MS)),
    account ? readOrNote(() => cf<CfRumSite[]>(auth, `/accounts/${account}/rum/site_info/list?per_page=100`, SETUP_TTL_MS)) : undefined,
    readOrNote(() => cf<CfEmailRouting>(auth, `/zones/${zoneId}/email/routing`, SETUP_TTL_MS)),
    hostOf(conn) === www ? undefined : readOrNote(() => cf<CfDnsRecord[]>(auth, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(www)}&per_page=50`, SETUP_TTL_MS)),
  ]);

  const found: Found = { findings: [], notes: [] };

  // The zone settings share one permission: one note for a refusal, and one
  // per setting that failed some other way.
  const reads = [ssl, alwaysHttps, minTls, hsts, rewrites, rocket, obfuscation];
  const names = ["SSL/TLS mode", "Always Use HTTPS", "Minimum TLS version", "HSTS", "Automatic HTTPS Rewrites", "Rocket Loader", "Email Address Obfuscation"];
  if (reads.some((r) => !r.ok && r.refused)) found.notes.push(AUDIT_PERMISSION.settings);
  reads.forEach((r, i) => {
    if (!r.ok && !r.refused) found.notes.push(`${names[i]} not checked: ${r.message}`);
  });

  httpsFindings(conn, { ssl, alwaysHttps, minTls, hsts, rewrites, dnssec }, found);
  await injectedScriptFindings(conn, zoneId, { rocket, obfuscation, bots, rum }, found);
  await wwwFindings(www, wwwRecords, found);
  emailRoutingFindings(conn, email, found);
  addInsights(
    insights,
    {
      zone: conn.resource,
      account,
      read: { ssl: ssl.ok, alwaysHttps: alwaysHttps.ok, minTls: minTls.ok, hsts: hsts.ok },
    },
    found,
  );

  return { findings: found.findings, notes: [...new Set(found.notes)] };
}
