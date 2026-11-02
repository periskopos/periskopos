import { checkEvery, connectionLabel, isOutageType } from "../../../../shared/catalog.ts";
import type { App, CheckResult, Connection } from "../../../../shared/types.ts";
import { h, safeHref } from "../../dom.ts";
import { STATE_LABEL, hostOf } from "../../format.ts";
import { empty, ext, lamp, section, timeAgo } from "../../ui.ts";
import { metricsSection } from "../protocolParts.ts";
import { paymentsSection } from "./payments.ts";
import { figuresStrip } from "./figures.ts";
import { getMoreSection } from "./getMore.ts";
import { incidentList } from "./incidents.ts";
import type { AppPage } from "./page.ts";
import { shapesOf } from "./shapes.ts";

// Overview: how the app is doing right now, and what it's made of. Deploys,
// traffic and actions have tabs of their own.
export function overview(page: AppPage, a: App) {
  const { base, status, hist, details, protocol, suggestions } = page;
  const checks = a.connections.filter((c) => c.type !== "link");
  const links = a.connections.filter((c) => c.type === "link");
  const { deploys, commits, payments } = shapesOf(page, a);

  // What it's made of on the left, what happened to it on the right, when
  // the page has the room for both (.overview-grid); one under the other
  // when it hasn't.
  const main = [
    section("Checks", {
      list: h("ul", { class: "list" }, checks.map((c) => (!a.live && SITE_CHECKS.has(c.type) ? waitingItem(c) : checkItem(c, status?.checks[c.id], a.checkIntervalMin)))),
      body: checks.length === 0 ? [empty("Nothing is checked.")] : undefined,
    }),

    getMoreSection(suggestions, `${base}/settings/connections`, page.connectSuggested),

    payments && paymentsSection(payments.d),

    !(deploys || commits) &&
      !suggestions?.length &&
      section("Deploys and commits", {
        body: [
          h(
            "p",
            { class: "secondary" },
            "Connect GitHub and your host to see what's live, recent deploys and commits. ",
            h("a", { href: `${base}/settings/connections` }, "Connect to an account"),
          ),
        ],
      }),
  ];

  const side = [
    section("Recent incidents", {
      action: h("a", { href: `${base}/history` }, "History"),
      list: hist && hist.incidents.length > 0 ? incidentList(hist.incidents.slice(0, 3)) : undefined,
      body: hist && hist.incidents.length === 0 ? [empty("None in the last 30 days.")] : undefined,
    }),

    links.length > 0 &&
      section("Links", {
        action: h("a", { href: `${base}/settings` }, "Edit"),
        body: [h("div", { class: "chips" }, links.map((l) => h("a", { class: "chip", href: safeHref(l.resource), target: "_blank", rel: "noopener noreferrer" }, String(l.settings?.label ?? hostOf(l.resource)), h("span", { "aria-hidden": "true" }, "↗"))))],
      }),
  ];

  return [
    figuresStrip(a, status, hist, details),

    protocol?.configured && metricsSection(protocol, `${base}/settings/protocol`),

    h("div", { class: "overview-grid" }, h("div", { class: "stack" }, main), h("div", { class: "stack" }, side)),
  ];
}

// The checks of the running site, which wait until the app is live.
const SITE_CHECKS = new Set(["site", "ssl"]);

function waitingItem(conn: Connection) {
  return h(
    "li",
    { class: "item" },
    lamp("prelaunch", { label: "not live yet" }),
    h(
      "div",
      { class: "item-main" },
      h("span", { class: "item-title" }, connectionLabel(conn), h("span", { class: "meta mono truncate" }, conn.type === "site" ? hostOf(conn.resource) : conn.resource)),
      h("span", { class: "meta" }, "Not checked until the app is live (Settings)"),
    ),
  );
}

function checkItem(conn: Connection, result: CheckResult | undefined, everyMin: number) {
  // A failed deploy or red CI is "needs attention": the app still serves.
  const state = !result ? "checking" : result.state === "down" && !isOutageType(conn.type) ? "attention" : result.state;
  return h(
    "li",
    { class: "item" },
    lamp(state, { label: STATE_LABEL[state] }),
    h(
      "div",
      { class: "item-main" },
      h("span", { class: "item-title" }, connectionLabel(conn), h("span", { class: "meta mono truncate" }, conn.type === "site" ? hostOf(conn.resource) : String(conn.settings?.name ?? conn.resource))),
      h("span", { class: result?.state === "down" ? `reason reason--${state === "attention" ? "attention" : "down"}` : "meta" }, result?.state !== "up" && result?.detail ? result.detail : (result?.summary ?? (result?.httpStatus ? `HTTP ${result.httpStatus}` : ""))),
      // Where to see why: the failed run or build.
      result?.link && h("span", { class: "meta" }, ext(result.link.url, result.link.label)),
    ),
    h(
      "div",
      { class: "item-end meta" },
      result?.state === "up" && result.ms !== undefined && h("span", { class: "mono" }, `${result.ms} ms`),
      h("span", null, result ? timeAgo(result.at) : "checking…", ` · ${checkEvery(conn.type, everyMin)}`),
    ),
  );
}
