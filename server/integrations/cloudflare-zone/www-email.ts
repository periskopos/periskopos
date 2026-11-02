import type { Connection } from "../../../shared/types.ts";
import { AUDIT_PERMISSION } from "./api.ts";
import type { CfDnsRecord, CfEmailRouting, Found, Read } from "./api.ts";
import { pageGet } from "./page.ts";

// The domain's other doors: its www name, and mail sent to it through
// Email Routing.

// A www name with a record goes through Cloudflare; without a redirect
// rule or a route for it, visitors who type it get an error page.
export async function wwwFindings(www: string, wwwRecords: Read<CfDnsRecord[]> | undefined, { findings, notes }: Found) {
  if (wwwRecords && !wwwRecords.ok) notes.push(wwwRecords.refused ? AUDIT_PERMISSION.www : `www not checked: ${wwwRecords.message}`);
  if (!wwwRecords?.ok || !wwwRecords.value.some((r) => r.name === www && ["A", "AAAA", "CNAME"].includes(r.type))) return;
  try {
    const res = await pageGet(`https://${www}/`, "manual");
    await res.body?.cancel().catch(() => {});
    if (res.status >= 400) {
      findings.push({
        key: "www-broken",
        severity: "medium",
        title: `${www} doesn't work`,
        why: `${www} has a DNS record, so people who type it reach Cloudflare, but it answers ${res.status} instead of the site or a redirect to it.`,
        fix: {
          steps: `In the Cloudflare dashboard, open this domain → Rules → Overview → Create rule → Redirect Rule, choose the template "Redirect from WWW to root", keep 301 and turn on Preserve query string, then Deploy. If nobody should use ${www}, delete its DNS record instead.`,
        },
      });
    }
  } catch (err) {
    notes.push(`${www} has a DNS record but didn't answer: ${(err as Error).message}`);
  }
}

export function emailRoutingFindings(conn: Connection, email: Read<CfEmailRouting>, { findings, notes }: Found) {
  if (!email.ok) notes.push(email.refused ? AUDIT_PERMISSION.email : `Email Routing not checked: ${email.message}`);
  else if (email.value.enabled === true && /misconfigured/i.test(email.value.status ?? "")) {
    findings.push({
      key: "email-routing-records",
      severity: "medium",
      title: "Email Routing is on, but its DNS records aren't right",
      why: `Cloudflare forwards mail for ${conn.resource} only while its MX, SPF and DKIM records are in place. Some are missing or have been replaced, so mail to your addresses may bounce or go elsewhere.`,
      fix: { steps: "In the Cloudflare dashboard, open Compute → Email Service → Email Routing → this domain. It lists the records that are missing and offers to add them; delete any other MX records on the domain." },
    });
  }
}
