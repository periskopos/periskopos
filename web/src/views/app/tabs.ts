import type { App } from "../../../../shared/types.ts";
import { h } from "../../dom.ts";
import { empty, section } from "../../ui.ts";
import { actionsSection, activityList } from "../actionsParts.ts";
import { commitsList, deploysList } from "./details.ts";
import { toFix } from "./config.ts";
import { errorsSection } from "./errors.ts";
import { logsSection } from "./logs.ts";
import type { AppPage, AppTab } from "./page.ts";
import { searchSection } from "./search.ts";
import { linkOf, listOf, shapesOf } from "./shapes.ts";
import { trafficSection } from "./traffic.ts";

// The tabs an app has: Overview, History and Settings always; Deploys,
// Traffic and Actions once something of the app's fills them.
export function tabsOf(page: AppPage, a: App): { key: AppTab; label: string }[] {
  const s = shapesOf(page, a);
  const actions = page.actions;
  return [
    { key: "overview" as const, label: "Overview", on: true },
    { key: "deploys" as const, label: "Deploys", on: Boolean(s.deploys || s.commits || s.errors || s.logs) },
    { key: "traffic" as const, label: "Traffic", on: Boolean(s.traffic || s.search) },
    { key: "config" as const, label: toFix(page.config instanceof Error ? undefined : page.config) ? `Configuration (${toFix(page.config instanceof Error ? undefined : page.config)})` : "Configuration", on: true },
    { key: "actions" as const, label: "Actions", on: Boolean(actions?.actions.length || actions?.blocked.length || page.activity.length) },
    { key: "history" as const, label: "History", on: true },
    { key: "settings" as const, label: "Settings", on: true },
  ].filter((t) => t.on || t.key === page.tab);
}

// Deploys: what went out and when, the commits behind it, and the errors
// since: the error tracker's, and the host's logs.
export function deploysTab(page: AppPage, a: App) {
  const { deploys, commits, errors, logs } = shapesOf(page, a);
  if (!deploys && !commits && !errors && !logs) return [nothingYet(page, "Connect GitHub and your host to see deploys and commits here.")];
  return [
    (deploys || commits) &&
      h(
        "div",
        { class: "columns" },
        deploys && section("Deploys", { action: linkOf(deploys), list: listOf(deploys, deploysList) }),
        commits && section("Commits", { action: linkOf(commits), list: listOf(commits, commitsList) }),
      ),
    errors && errorsSection(errors.d, deploys?.d instanceof Error ? undefined : deploys?.d),
    logs && logsSection(logs.d),
  ];
}

// Traffic: visitors and requests from the app's domain, and search.
export function trafficTab(page: AppPage, a: App) {
  const { traffic, search } = shapesOf(page, a);
  if (!traffic && !search) return [nothingYet(page, "Connect the app's Cloudflare domain or Google Search Console to see its traffic here.")];
  return [
    traffic &&
      trafficSection(traffic.d, page.trafficRange, (r) => {
        page.trafficRange = r;
        page.draw();
      }),
    search &&
      searchSection(search.d, page.searchRange, (r) => {
        page.searchRange = r;
        page.draw();
      }),
  ];
}

// Actions: what can be done, and everything run so far.
export function actionsTab(page: AppPage) {
  return [
    actionsSection(page.actions, page.outcome, [], { services: "#/services" }, {
      open: page.openAction,
      dismiss: () => {
        page.outcome = undefined;
        page.draw();
      },
    }) ?? nothingYet(page, "Nothing can be done from Periskopos on this app yet: connect its host, or add the protocol for its own buttons."),
    section("Actions run", {
      list: page.activity.length ? activityList(page.activity) : undefined,
      body: page.activity.length ? undefined : [empty("Nothing has been run from Periskopos on this app yet.")],
    }),
  ];
}

function nothingYet(page: AppPage, text: string) {
  return section("Nothing here yet", {
    body: [h("p", { class: "secondary" }, text, " ", h("a", { href: `${page.base}/settings/connections` }, "Connect to an account"))],
  });
}
