import type { Connection } from "../../../shared/types.ts";
import { AUDIT_PERMISSION, hostOf } from "./api.ts";
import type { CfBots, CfRumSite, Found, Read } from "./api.ts";
import { cspAllows, headOfPage, pageGet, pagePolicies } from "./page.ts";

// What Cloudflare adds to the site's pages. Rocket Loader, Email Address
// Obfuscation, Bot Fight Mode and Web Analytics' automatic setup each put
// Cloudflare's scripts into the pages it serves. A Content-Security-Policy
// that doesn't allow them blocks them, and with Rocket Loader that stops the
// page's own scripts too. The policy is read from the page itself (headers
// and <meta>), and only when one of them is on.

const BEACON_HOST = "static.cloudflareinsights.com";

export type InjectedReads = {
  rocket: Read<string>;
  obfuscation: Read<string>;
  bots: Read<CfBots>;
  rum: Read<CfRumSite[]> | undefined; // undefined without an account id
};

export async function injectedScriptFindings(conn: Connection, zoneId: string, { rocket, obfuscation, bots, rum }: InjectedReads, { findings, notes }: Found) {
  const zone = conn.resource;
  const rocketOn = rocket.ok && rocket.value === "on";
  const obfuscationOn = obfuscation.ok && obfuscation.value === "on";
  if (!bots.ok) notes.push(bots.refused ? AUDIT_PERMISSION.bots : `Bot Fight Mode not checked: ${bots.message}`);
  const botsOn = bots.ok && bots.value.fight_mode === true;
  if (rum && !rum.ok) notes.push(rum.refused ? AUDIT_PERMISSION.rum : `Web Analytics not checked: ${rum.message}`);
  const beaconOn =
    rum?.ok === true && rum.value.some((s) => s.auto_install === true && s.ruleset?.enabled !== false && (s.ruleset?.zone_tag === zoneId || s.ruleset?.zone_name === zone));
  if (!(rocketOn || obfuscationOn || botsOn || beaconOn)) return;

  const host = hostOf(conn);
  try {
    const res = await pageGet(`https://${host}/`, "follow");
    const { header, meta } = pagePolicies(res.headers, (res.headers.get("content-type") ?? "").includes("html") ? await headOfPage(res) : "");
    if (!res.bodyUsed) await res.body?.cancel().catch(() => {});
    const all = [...header, ...meta];
    if (rocketOn && !cspAllows(all, "inline")) {
      findings.push({
        key: "rocket-loader-csp",
        severity: "high",
        title: "Rocket Loader is blocked by the site's Content-Security-Policy",
        why: `Rocket Loader rewrites the scripts on ${host}'s pages so that an inline script of its own starts them. The site's policy doesn't allow inline scripts, so that script is blocked, and the page's own scripts may never run.`,
        fix: { steps: "In the Cloudflare dashboard, open this domain → Speed → Settings → Content Optimization and turn Rocket Loader off." },
      });
    }
    if (obfuscationOn && !cspAllows(all, "self")) {
      findings.push({
        key: "email-obfuscation-csp",
        severity: "medium",
        title: "Email addresses on the site show as [email protected]",
        why: `Email Address Obfuscation hides addresses on ${host}'s pages behind a script Cloudflare serves from the site itself. The site's policy doesn't allow scripts from its own address, so visitors see "[email protected]" instead of the address.`,
        fix: { steps: "In the Cloudflare dashboard, open this domain → Security → Settings (filter Client-side abuse) and turn Email Address Obfuscation off, or allow 'self' in the policy's script-src." },
      });
    }
    // Cloudflare copies a nonce from the policy header onto its own script,
    // never one from a <meta> policy.
    const nonced = header.some((p) => /'nonce-/i.test(p));
    if (botsOn && !cspAllows(all, "inline") && !nonced) {
      findings.push({
        key: "bot-fight-mode-csp",
        severity: "medium",
        title: "Bot Fight Mode's checks are blocked by the site's Content-Security-Policy",
        why: `Bot Fight Mode adds Cloudflare's JavaScript detections to ${host}'s pages, including an inline script, and they can't be turned off while it's on. The site's policy blocks inline scripts, so visitors' consoles show errors and the detections can't tell people from bots. On the free plan it can't be skipped for some pages either.`,
        fix: { steps: "In the Cloudflare dashboard, open this domain → Security → Settings (filter Bot traffic) and turn Bot Fight Mode off. Cloudflare's free managed rules and DDoS protection still apply. Or send a nonce in the policy header, which Cloudflare adds to its script." },
      });
    }
    if (beaconOn && !cspAllows(all, { host: BEACON_HOST })) {
      findings.push({
        key: "web-analytics-csp",
        severity: "low",
        title: "Web Analytics can't count visits",
        why: `Web Analytics' automatic setup adds a script from ${BEACON_HOST} to ${host}'s pages. The site's policy doesn't allow that address, so the script is blocked, nothing is counted, and visitors' consoles show an error.`,
        fix: {
          steps: "Either allow Cloudflare's beacon in the policy, or turn the automatic setup off: in the Cloudflare dashboard, Web Analytics → this site → Manage site → Disable.",
          code: `script-src … https://${BEACON_HOST}; connect-src … https://cloudflareinsights.com`,
        },
      });
    }
  } catch (err) {
    notes.push(`The site's Content-Security-Policy wasn't read, so Cloudflare's added scripts weren't checked against it: ${(err as Error).message}`);
  }
}
