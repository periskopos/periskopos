import type { AuditResult, CheckResult, Connection, Deploy, FindingDraft } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { ProviderError, getJson, postJson } from "../http.ts";
import { requiredText } from "../validate.ts";
import { firstLine } from "./github.ts";
import { deployHealth, deployNotice, short } from "./render.ts";
import { described, deploysDetails } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";

// Netlify as a host: a site's production deploys, each with the commit it
// built, so "is my last push live?" and failed-deploy alerts work as they
// do for Render; Redeploy (a new production build) when actions are allowed.

const API = "https://api.netlify.com/api/v1";

type NDeploy = {
  id: string;
  state: string; // new, enqueued, building, uploading, processing, ready, error, skipped…
  commit_ref?: string | null;
  title?: string | null; // the commit's message
  error_message?: string | null;
  created_at: string;
  published_at?: string | null;
  updated_at?: string;
};
type NSite = {
  id: string;
  name: string;
  url?: string;
  ssl_url?: string;
  custom_domain?: string | null;
  admin_url?: string;
  published_deploy?: { id?: string } | null;
  ssl?: boolean; // HTTPS is on: the site has a certificate
  build_settings?: { repo_url?: string; stop_builds?: boolean } | null;
};

async function api<T>(auth: ServiceAuth, path: string, ttlMs?: number): Promise<T> {
  return getJson<T>(`${API}${path}`, { token: await auth.token(), provider: "Netlify", ...(ttlMs !== undefined ? { ttlMs } : {}) });
}

const IN_PROGRESS = new Set(["new", "pending_review", "accepted", "enqueued", "building", "uploading", "uploaded", "preparing", "prepared", "processing", "processed", "retrying"]);

// The published deploy is live; other ready ones were replaced. Netlify
// reports a canceled build as an error, which says nothing about deploys.
export function toDeploy(d: NDeploy, publishedId: string | undefined, adminUrl: string | undefined): Deploy {
  const canceled = d.state === "error" && /cancel/i.test(d.error_message ?? "");
  let phase: Deploy["phase"] = "other";
  let status = canceled ? "canceled" : d.state;
  if (IN_PROGRESS.has(d.state)) phase = "in-progress";
  else if (d.state === "error" && !canceled) phase = "failed";
  else if (d.state === "ready") {
    if (d.id === publishedId) {
      phase = "live";
      status = "live";
    } else status = "superseded";
  }
  const sha = d.commit_ref && /^[0-9a-f]{7,40}$/i.test(d.commit_ref) ? d.commit_ref : undefined;
  const finished = d.published_at ?? d.updated_at;
  return {
    id: d.id,
    status,
    phase,
    ...(sha ? { commit: { sha, message: firstLine(d.title ?? "") || `commit ${sha.slice(0, 7)}`, at: d.created_at } } : {}),
    startedAt: d.created_at,
    ...(phase !== "in-progress" && finished ? { finishedAt: finished } : {}),
    ...(adminUrl ? { url: `${adminUrl}/deploys/${encodeURIComponent(d.id)}` } : {}),
  };
}

const adminOf = (conn: Connection) => {
  const url = conn.settings?.adminUrl;
  return typeof url === "string" && url.startsWith("https://app.netlify.com/") ? url : undefined;
};

async function production(conn: Connection, auth: ServiceAuth, limit: number, ttlMs?: number): Promise<Deploy[]> {
  const id = encodeURIComponent(conn.resource);
  const [site, list] = await Promise.all([api<NSite>(auth, `/sites/${id}`, ttlMs), api<NDeploy[]>(auth, `/sites/${id}/deploys?production=true&per_page=${limit}`, ttlMs)]);
  return list.map((d) => toDeploy(d, site.published_deploy?.id, adminOf(conn) ?? site.admin_url));
}

// What a site object shows set up wrong: a custom domain without a
// certificate, builds that never run, or no Git repository behind it.
// (force_ssl isn't judged: Netlify redirects to HTTPS once a site has a
// certificate, and the site check sees what the address really does.)
export function auditNetlifySite(site: NSite): FindingDraft[] {
  const base = `https://app.netlify.com/projects/${encodeURIComponent(site.name)}`;
  const out: FindingDraft[] = [];
  if (site.custom_domain && site.ssl !== true) {
    out.push({
      key: `no-certificate:${site.custom_domain.toLowerCase()}`,
      severity: "high",
      title: `No HTTPS certificate for ${site.custom_domain}`,
      why: "Visitors on your domain get a browser warning or plain HTTP, and anything they send (logins, forms) can be read or changed on the way.",
      fix: {
        steps: "In Netlify, open the project's Domain management → HTTPS and click Verify DNS configuration, then Provision certificate. If it fails, the domain's DNS doesn't point at Netlify yet: fix the records Netlify shows, then try again.",
        link: { url: `${base}/domain-management#https`, label: "Open Domain management" },
      },
    });
  }
  const repo = site.build_settings?.repo_url;
  if (!repo) {
    out.push({
      key: "not-linked-to-git",
      severity: "low",
      title: "Not connected to a Git repository",
      why: "Production deploys come from whoever runs the Netlify CLI or drags in a folder, so pushes don't deploy and there's no record of which commit is live.",
      fix: {
        steps: "In Netlify, open Project configuration → Developer settings → Continuous deployment, click Link repository and pick the app's repository.",
        link: { url: `${base}/configuration/developer-settings`, label: "Open Continuous deployment" },
      },
    });
  } else if (site.build_settings?.stop_builds) {
    out.push({
      key: "builds-stopped",
      severity: "low",
      title: "Builds are stopped: pushes don't deploy",
      why: "Netlify never builds the site, so a push to the repository changes nothing live until someone deploys by hand.",
      fix: {
        steps: "In Netlify, open Project configuration → Developer settings → Continuous deployment → Build settings, click Configure, set Build status to Active builds and save.",
        link: { url: `${base}/configuration/developer-settings#build-settings`, label: "Open Build settings" },
      },
    });
  }
  return out;
}

export const netlify: Integration = {
  ...described("netlify"),

  parse({ resource, settings }) {
    const id = requiredText(resource, "Netlify site", 64);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw badRequest("Pick the site from the list: a Netlify site id looks like 3970e0fe-8564-4903-9a55-c5f8de49fb8b");
    const s = (settings ?? {}) as Record<string, unknown>;
    return {
      resource: id,
      settings: {
        ...(typeof s.name === "string" ? { name: s.name.slice(0, 100) } : {}),
        ...(typeof s.adminUrl === "string" && s.adminUrl.startsWith("https://app.netlify.com/") ? { adminUrl: s.adminUrl } : {}),
      },
    };
  },

  async testService(auth) {
    const user = await api<{ full_name?: string; email?: string }>(auth, "/user", 0);
    return { message: `Connected to ${user.full_name || user.email || "Netlify"}` };
  },

  async listResources(auth) {
    const sites = await api<NSite[]>(auth, "/sites?filter=all&per_page=100");
    if (!sites.length) throw new Error("This Netlify account has no sites, or the token can't see them.");
    return sites.map((s) => ({
      id: s.id,
      label: s.name,
      // Its addresses: a host serving the app's URL is its match.
      detail: [s.custom_domain, s.ssl_url ? new URL(s.ssl_url).hostname : s.url ? new URL(s.url).hostname : undefined].filter(Boolean).join(" · "),
      settings: { name: s.name, ...(s.admin_url ? { adminUrl: s.admin_url } : {}) },
    }));
  },

  async deploys(conn, auth) {
    return production(conn, auth, 20);
  },

  // Down when the newest deploy failed, or has run far longer than usual.
  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No Netlify account connected" };
    try {
      return deployHealth(await this.deploys!(conn, auth), at);
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  async details(conn, auth) {
    return deploysDetails(await this.deploys!(conn, auth), adminOf(conn), "Netlify");
  },

  actions: () => [
    {
      id: "redeploy",
      label: "Redeploy",
      description: "Starts a new production build of the site on Netlify, from its latest commit. The live site keeps serving until the new deploy is published.",
    },
  ],

  async run(conn, auth, actionId) {
    if (actionId !== "redeploy") throw new Error(`Netlify has no action "${actionId}"`);
    // Never stack a second build on one that's already running; look fresh.
    const running = (await production(conn, auth, 5, 0)).find((d) => d.phase === "in-progress");
    if (running) return { ok: false, message: `A deploy is already running (${short(running)}, ${running.status}). Wait for it to finish.` };
    const build = await postJson<{ id?: string; deploy_id?: string }>(`${API}/sites/${encodeURIComponent(conn.resource)}/builds`, {}, { token: await auth.token(), provider: "Netlify" });
    const id = build.deploy_id ?? build.id;
    return { ok: true, message: `Redeploy started${id ? ` (${id})` : ""}. It will show under Deploys.` };
  },

  async audit(conn, auth): Promise<AuditResult> {
    if (!auth) return { findings: [], notes: ["No Netlify account connected"] };
    let site: NSite;
    try {
      site = await api<NSite>(auth, `/sites/${encodeURIComponent(conn.resource)}`);
    } catch (err) {
      if (err instanceof ProviderError && err.status === 403) return { findings: [], notes: ["The Netlify token can't read this site's settings, so its HTTPS and build settings weren't checked."] };
      throw err;
    }
    return { findings: auditNetlifySite(site) };
  },

  notice: deployNotice,
};
