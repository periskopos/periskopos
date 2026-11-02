import type { DeploysDetails, ErrorIssue, ErrorsDetails } from "../../../../shared/types.ts";
import { h } from "../../dom.ts";
import { empty, ext, lamp, section, timeAgo } from "../../ui.ts";
import { detailsError } from "./details.ts";
import { compactCount } from "./traffic.ts";

// ── Errors: what an error tracker (Sentry) has seen go wrong ────────────
// Errors first seen after the live deploy went out are marked: "this
// started with that deploy" is the question an error list exists for.

// When the deploy now live went out, if the app has a host that says.
export function liveSince(deploys: DeploysDetails | undefined): number | undefined {
  const live = deploys?.deploys.find((d) => d.phase === "live");
  const at = live && Date.parse(live.finishedAt ?? live.startedAt);
  return at && Number.isFinite(at) ? at : undefined;
}

function issueItem(i: ErrorIssue, deployedAt: number | undefined) {
  const sinceDeploy = deployedAt !== undefined && Date.parse(i.firstSeen) >= deployedAt;
  return h(
    "li",
    { class: "item" },
    lamp(sinceDeploy ? "attention" : i.level === "fatal" || i.level === "error" ? "down" : "none", { label: sinceDeploy ? "new since the last deploy" : i.level }),
    h(
      "div",
      { class: "item-main" },
      h("span", { class: "item-title truncate", title: i.title }, i.title),
      h(
        "span",
        { class: "meta" },
        ext(i.url, i.shortId),
        i.culprit ? ` · ${i.culprit}` : "",
        " · ",
        timeAgo(i.firstSeen, "first "),
        sinceDeploy ? " · new since the last deploy" : "",
      ),
    ),
    h("div", { class: "item-end meta mono" }, `${compactCount(i.count)} events${i.users ? ` · ${compactCount(i.users)} users` : ""}`),
  );
}

export function errorsSection(d: ErrorsDetails | Error | undefined, deploys: DeploysDetails | undefined) {
  const deployedAt = liveSince(deploys);
  const fresh = d && !(d instanceof Error) && deployedAt !== undefined ? d.issues.filter((i) => Date.parse(i.firstSeen) >= deployedAt).length : 0;
  const loaded = d && !(d instanceof Error) ? d : undefined;
  return section("Errors", {
    action: loaded ? ext(loaded.link.url, loaded.link.label) : undefined,
    body: loaded?.issues.length
      ? [
          h(
            "p",
            { class: "secondary" },
            `Unresolved, most frequent in the last 24 h first · ${loaded.newIn24h} new in 24 h`,
            deployedAt !== undefined ? ` · ${fresh} since the last deploy` : "",
          ),
        ]
      : undefined,
    list:
      d instanceof Error
        ? detailsError(d)
        : !loaded
          ? empty("Loading…")
          : loaded.issues.length === 0
            ? empty("No unresolved errors.")
            : h("ul", { class: "list" }, loaded.issues.map((i) => issueItem(i, deployedAt))),
  });
}
