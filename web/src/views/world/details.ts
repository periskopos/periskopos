import type { App, AppStatus, ProviderStatus } from "../../../../shared/types.ts";
import type { Trip } from "../../../../shared/valley/trips.ts";
import { notRunningNote } from "../../../../shared/valley/trips.ts";
import type { ValleyStats } from "../../../../shared/valley/trips.ts";
import type { Plot, Utility } from "../../../../shared/world.ts";
import { h } from "../../dom.ts";
import { formatUptime, thinUptime } from "../../format.ts";
import { lamp, status, timeAgo } from "../../ui.ts";
import { factsOf } from "../fleet.ts";
import { moment } from "./replay.ts";
import type { Standing } from "./scene/types.ts";

// What the panel says about the thing that was clicked, and the figures across the top.

const head = (title: string, close: Node) => h("div", { class: "world-detail-head" }, h("h2", null, title), close);
const appLink = (slug: string, text = "Open app", path = "") => h("a", { class: "btn btn--primary", href: `#/apps/${encodeURIComponent(slug)}${path}` }, text);

export function plotDetail(plot: Plot, app: App, appStatus: AppStatus | undefined, providers: ProviderStatus[], replayAt: number | null, close: Node) {
  if (replayAt !== null) {
    return [head(plot.name, close), status(plot.state), h("p", { class: "meta" }, `At ${moment(replayAt)}`), plot.reason && h("div", null, plot.reason), appLink(plot.slug, "Open its history", "/history")];
  }
  const f = factsOf(app, appStatus);
  const needs = providers.filter((p) => p.apps.some((a) => a.slug === plot.slug)).map((p) => p.label);
  const figure = (label: string, value: Node | string | undefined) => value && h("div", { class: "card-figure" }, h("dt", { class: "label" }, label), h("dd", { class: "mono" }, value));
  return [
    head(plot.name, close),
    status(plot.state),
    h("div", null, f.reason),
    h(
      "dl",
      { class: "card-figures" },
      figure("Response", f.response),
      figure("Uptime 30 days", f.uptime),
      figure("Last push", f.pushed),
      figure("Requests, 24 h", plot.requests === undefined ? undefined : plot.requests.toLocaleString()),
      figure("Checked", f.latest ? timeAgo(f.latest.at) : undefined),
    ),
    needs.length > 0 && h("p", { class: "meta" }, `Depends on ${needs.join(", ")}`),
    appLink(plot.slug),
  ];
}

export function utilityDetail(u: Utility, close: Node) {
  return [
    head(u.label, close),
    u.look === "past" ? h("p", { class: "meta" }, "A replay has no record of how a provider was.") : u.look === "unknown" ? h("p", { class: "meta" }, "Its status page hasn't been read lately, so it can't be called fine.") : h("p", null, u.description),
    h("p", { class: "meta" }, `${u.apps.length} of your apps depend${u.apps.length === 1 ? "s" : ""} on it:`),
    h("ul", { class: "world-apps" }, u.apps.map((a) => h("li", null, h("a", { href: `#/apps/${encodeURIComponent(a.slug)}` }, a.name)))),
    h("a", { class: "btn", href: "#/status" }, "Open Status"),
  ];
}

// A vehicle says what it stands for, in so many words: that's the point of it.
export function tripDetail(trip: Trip, appStatus: AppStatus | undefined, close: Node) {
  const { facts } = trip;
  if (facts.kind === "check") {
    const result = [facts.httpStatus ? `HTTP ${facts.httpStatus}` : "", facts.ms !== undefined ? `${facts.ms} ms` : ""].filter(Boolean).join(" · ");
    return [
      head("A patrol van", close),
      h("p", null, `One real check: the watcher looked at ${trip.name}'s ${facts.what}.`),
      h("div", { class: "world-tower-word" }, lamp(facts.state), facts.state === "up" ? "It answered" : facts.state === "down" ? "It failed" : "It couldn't tell"),
      result && h("div", { class: "mono" }, result),
      facts.detail && h("p", { class: "meta" }, facts.detail),
      h("p", { class: "meta" }, ["Checked ", timeAgo(facts.at), "."]),
      appLink(trip.slug, "Open its history", "/history"),
    ];
  }
  if (facts.kind === "deploy") {
    const latest = appStatus?.deploy?.latest;
    return [
      head("A delivery truck", close),
      h("p", null, `A deploy to ${trip.name} is under way${facts.from ? `, on its way from ${facts.from}` : ""}.`),
      latest && h("div", { class: "mono" }, latest.sha),
      latest && h("p", { class: "meta" }, latest.message),
      appLink(trip.slug),
    ];
  }
  return [
    head("Traffic", close),
    facts.requests === undefined
      ? h("p", null, `${trip.name}'s traffic can't be read here, so ${facts.cars === 1 ? "its one car says" : `its ${facts.cars} cars say`} only that it's serving.`)
      : h("p", null, `${trip.name} served ${facts.requests.toLocaleString()} requests in the last 24 hours. ${facts.cars === 1 ? "This is its one car on the road." : `This is one of the ${facts.cars} cars on the road for it.`} More requests means more cars, as far as the road has room.`),
    appLink(trip.slug),
  ];
}

// A short name for what's under the pointer.
export function tripTitle(trip: Trip): string {
  const { facts } = trip;
  if (facts.kind === "check") return `A check of ${trip.name}: ${facts.what}`;
  return facts.kind === "deploy" ? `A deploy to ${trip.name}` : `Traffic to ${trip.name}`;
}

// Each figure is a fact, and where there's something to go and see, it takes you there.
export function statsRow(stats: ValleyStats, lastCheck: { value: string; note?: string }, goTo: (target: { kind: Standing; id: string }) => void) {
  const stat = (label: string, value: string, note?: string, go?: { hint: string; to: { kind: Standing; id: string } }) => {
    const parts = [h("span", { class: "world-stat-label" }, label), h("span", { class: "world-stat-value" }, value), note && h("span", { class: "world-stat-note" }, note)];
    if (!go) return h("div", { class: "world-stat" }, parts);
    // Named, so focus stays on it when its figure changes ("1 min ago", "2 min ago").
    return h("button", { type: "button", class: "world-stat", name: `stat:${label}`, title: go.hint, onclick: () => goTo(go.to) }, parts);
  };
  const app = (slug: string) => ({ kind: "app" as const, id: slug });
  const worst = stats.notRunning[0];
  const firstDeploy = stats.deploying[0];
  const lowest = stats.lowestUptimeApp;
  const over30 = stats.lowestUptime !== undefined && !thinUptime(stats.lowestUptimeWatchedMs);
  return [
    stat("Running", `${stats.running} of ${stats.total}`, notRunningNote(stats.notRunning), worst && { hint: "Show the one most in need of a look", to: app(worst.slug) }),
    firstDeploy && stat("Deploying", String(stats.deploying.length), stats.deploying.length === 1 ? firstDeploy.name : `${firstDeploy.name} and ${stats.deploying.length - 1} more`, { hint: `Show ${firstDeploy.name}`, to: app(firstDeploy.slug) }),
    stat("Requests, 24 h", stats.requests === undefined ? "Not read" : stats.requests.toLocaleString(), stats.requests !== undefined && stats.requestsFrom < stats.total ? `from ${stats.requestsFrom} of ${stats.total} apps` : undefined),
    stat("Lowest uptime", stats.lowestUptime === undefined ? "Not known" : formatUptime(stats.lowestUptime, stats.lowestUptimeWatchedMs), lowest && (over30 ? `${lowest.name}, 30 days` : lowest.name), lowest && { hint: `Show ${lowest.name}`, to: app(lowest.slug) }),
    stat("Last check", lastCheck.value, lastCheck.note, { hint: "Open the watcher's radar and log", to: { kind: "tower", id: "watcher" } }),
  ];
}
