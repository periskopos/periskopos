import type { Connection } from "../../../shared/types.ts";
import { AUDIT_PERMISSION, dashboardOf } from "./api.ts";
import type { CfHsts, Found, Read } from "./api.ts";

// How the zone handles HTTPS: the encryption to the origin, redirects, TLS
// versions, HSTS, and DNSSEC.

export type HttpsReads = {
  ssl: Read<string>;
  alwaysHttps: Read<string>;
  minTls: Read<string>;
  hsts: Read<CfHsts>;
  rewrites: Read<string>;
  dnssec: Read<{ status: string }>;
};

export function httpsFindings(conn: Connection, { ssl, alwaysHttps, minTls, hsts, rewrites, dnssec }: HttpsReads, { findings, notes }: Found) {
  const dash = dashboardOf(conn);
  const page = (path: string, label: string) => (dash ? { link: { url: `${dash}/${path}`, label } } : {});
  const sslPage = page("ssl-tls", "Open SSL/TLS on Cloudflare");
  const edgePage = page("ssl-tls/edge-certificates", "Open Edge Certificates on Cloudflare");
  const zone = conn.resource;

  if (ssl.ok && (ssl.value === "off" || ssl.value === "flexible")) {
    findings.push({
      key: "ssl-mode",
      severity: "high",
      title: ssl.value === "off" ? `HTTPS is off for ${zone}` : "Cloudflare reaches your server over plain HTTP",
      why:
        ssl.value === "off"
          ? "Cloudflare serves the site over plain HTTP only, so everything visitors send and receive can be read and changed on the way."
          : "The SSL/TLS mode is Flexible: visitors see a padlock, but traffic between Cloudflare and your server is unencrypted, logins and cookies included.",
      fix: {
        steps: "In the Cloudflare dashboard, open this domain → SSL/TLS → Overview → Configure, choose Full (strict), and save. Your server needs a valid certificate first: your host's own, or a free Cloudflare Origin CA certificate (SSL/TLS → Origin Server).",
        ...sslPage,
      },
    });
  } else if (ssl.ok && ssl.value === "full") {
    findings.push({
      key: "ssl-mode",
      severity: "medium",
      title: "Cloudflare doesn't check your server's certificate",
      why: "The SSL/TLS mode is Full, not Full (strict): traffic to your server is encrypted, but Cloudflare accepts any certificate, even an expired or forged one, so someone in between could pose as your server.",
      fix: {
        steps: "In the Cloudflare dashboard, open this domain → SSL/TLS → Overview → Configure, choose Full (strict), and save. If your server's certificate isn't valid yet, install your host's own or a free Cloudflare Origin CA certificate (SSL/TLS → Origin Server) first.",
        ...sslPage,
      },
    });
  }

  // With HTTPS off altogether, the rest has nothing to act on.
  const httpsOn = !(ssl.ok && ssl.value === "off");
  if (httpsOn && alwaysHttps.ok && alwaysHttps.value === "off") {
    findings.push({
      key: "always-use-https",
      severity: "medium",
      title: "Visitors can stay on plain HTTP",
      why: `Always Use HTTPS is off, so http://${zone} is served as is instead of redirecting to HTTPS, and what's sent there can be read on the way.`,
      fix: { steps: "In the Cloudflare dashboard, open this domain → SSL/TLS → Edge Certificates and turn on Always Use HTTPS.", ...edgePage },
    });
  }
  if (httpsOn && minTls.ok && (minTls.value === "1.0" || minTls.value === "1.1")) {
    findings.push({
      key: "min-tls-version",
      severity: "medium",
      title: `TLS ${minTls.value} is still accepted`,
      why: `The minimum TLS version is ${minTls.value}. TLS 1.0 and 1.1 have known weaknesses, and every current browser supports 1.2.`,
      fix: { steps: "In the Cloudflare dashboard, open this domain → SSL/TLS → Edge Certificates, and set Minimum TLS Version to TLS 1.2.", ...edgePage },
    });
  }
  if (httpsOn && hsts.ok && hsts.value?.strict_transport_security?.enabled !== true) {
    findings.push({
      key: "hsts",
      severity: "low",
      title: "HSTS isn't set in Cloudflare",
      why: "Without HSTS, a browser may try plain HTTP first on each visit. Cloudflare can send the header for the whole domain, so your app doesn't have to.",
      fix: {
        steps: "In the Cloudflare dashboard, open this domain → SSL/TLS → Edge Certificates → HTTP Strict Transport Security (HSTS) → Enable HSTS. Start with a Max Age of 6 months; turn on Include subdomains only if every subdomain serves HTTPS.",
        ...edgePage,
      },
    });
  }
  if (httpsOn && rewrites.ok && rewrites.value === "off") {
    findings.push({
      key: "automatic-https-rewrites",
      severity: "low",
      title: "Automatic HTTPS Rewrites is off",
      why: "Pages that link images or scripts over http:// get mixed-content warnings or break. With this on, Cloudflare rewrites those links to HTTPS.",
      fix: { steps: "In the Cloudflare dashboard, open this domain → SSL/TLS → Edge Certificates and turn on Automatic HTTPS Rewrites.", ...edgePage },
    });
  }

  if (!dnssec.ok) notes.push(dnssec.refused ? AUDIT_PERMISSION.dnssec : `DNSSEC not checked: ${dnssec.message}`);
  else if (dnssec.value.status !== "active") {
    const pending = dnssec.value.status === "pending";
    findings.push({
      key: "dnssec",
      severity: "low",
      title: pending ? "DNSSEC is waiting on your registrar" : "DNSSEC is off",
      why: pending
        ? `DNSSEC is on in Cloudflare, but the DS record hasn't been added at ${zone}'s registrar, so it isn't protecting anything yet.`
        : `Without DNSSEC, a resolver can't tell a forged answer for ${zone} from a real one, so visitors could be sent elsewhere.`,
      fix: {
        steps: pending
          ? "In the Cloudflare dashboard, open this domain → DNS → Settings, copy the DS record shown under DNSSEC, and add it at your domain registrar."
          : "In the Cloudflare dashboard, open this domain → DNS → Settings → Enable DNSSEC, then add the DS record it shows at your domain registrar (done for you if the domain is registered with Cloudflare).",
        ...page("dns/settings", "Open DNS settings on Cloudflare"),
      },
    });
  }
}
