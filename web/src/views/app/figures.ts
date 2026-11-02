import { CONNECTIONS, isHostType, mainSite } from "../../../../shared/catalog.ts";
import { lastPushHint } from "../../../../shared/fleet.ts";
import { duration } from "../../../../shared/format.ts";
import type { AppHistory, AppStatus, CiRun, Connection } from "../../../../shared/types.ts";
import { h } from "../../dom.ts";
import { formatPct, shortSha } from "../../format.ts";
import { PUSH, figure, lamp, timeAgo } from "../../ui.ts";
import type { LampState } from "../../ui.ts";
import { detailsOf } from "./details.ts";
import type { Details } from "./details.ts";

// ── The figures strip: the four answers ─────────────────────────────────

// What to do to see a figure: a sentence, so it wraps rather than being cut
// off mid-word like a long commit message would be.
const hint = (text: string) => h("span", { class: "figure-hint" }, text);

// CI right now: the newest run of each workflow. Failing CI needs
// attention, it isn't an outage: the app still serves (red is for down).
export function ciState(runs: CiRun[]): { lamp: LampState; text: string } {
  const seen = new Set<string>();
  const current = runs.filter((r) => !seen.has(r.name) && seen.add(r.name));
  if (current.length === 0) return { lamp: "none", text: "No CI" };
  if (current.some((r) => r.state === "failing")) return { lamp: "attention", text: "Failing" };
  if (current.some((r) => r.state === "running")) return { lamp: "info", text: "Running" };
  return { lamp: "up", text: "Passing" };
}

export function figuresStrip(app: { url: string; connections: Connection[]; live: boolean }, s: AppStatus | undefined, hist: AppHistory | undefined, details: Details) {
  const site = mainSite(app);
  const check = site && s?.checks[site.id];
  const hasSource = app.connections.some((c) => CONNECTIONS[c.type]?.role === "source");
  const hasHost = app.connections.some((c) => isHostType(c.type));
  const gh = detailsOf(details, "commits");

  const uptime = !app.live
    ? figure("Uptime · 30 days", "—", "not live yet", true)
    : hist?.uptimePct !== undefined
      ? figure("Uptime · 30 days", formatPct(hist.uptimePct), `watched ${duration(hist.watchedMin * 60_000)}`)
      : figure("Uptime · 30 days", "—", "not watched yet", true);

  const response =
    check?.state === "up" && check.ms !== undefined
      ? figure("Response", [h("span", null, String(check.ms)), h("span", { class: "meta" }, "ms")], ["status check · ", timeAgo(check.at)])
      : check
        ? figure("Response", [lamp(check.state === "down" ? "down" : "unknown"), check.state === "down" ? "Down" : "—"], check.detail ?? "", check.state !== "down")
        : figure("Response", "—", !app.live ? "not live yet" : site ? "checking…" : "no status check", true);

  const push = s?.deploy;
  const pushCommit = push && (push.state === "live" ? push.live : push.latest);
  const lastPush = push
    ? figure("Last push", [lamp(PUSH[push.state].lamp), PUSH[push.state].text], pushCommit ? `${shortSha(pushCommit.sha)} · ${pushCommit.message}` : push.detail)
    : figure("Last push", "—", hint(lastPushHint(hasSource, hasHost)), true);

  const ci = gh
    ? (() => {
        const c = ciState(gh.runs);
        return c.lamp === "none"
          ? figure("CI", c.text, `no workflows on ${gh.branch}`, true)
          : figure("CI", [lamp(c.lamp), c.text], `on ${gh.branch}`);
      })()
    : figure("CI", "—", hint(hasSource ? "checking…" : "connect GitHub"), true);

  return h("div", { class: "figures", role: "group", "aria-label": "Key figures" }, uptime, response, lastPush, ci);
}
