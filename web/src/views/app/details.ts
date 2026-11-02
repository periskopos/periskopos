import type { Commit, CommitsDetails, ConnectionDetails, Deploy, DeploysDetails } from "../../../../shared/types.ts";
import { h } from "../../dom.ts";
import { shortSha } from "../../format.ts";
import { duration } from "../../../../shared/format.ts";
import { empty, errorBox, ext, lamp, timeAgo } from "../../ui.ts";
import type { LampState } from "../../ui.ts";

// What a source and a host show of themselves: commits, CI, deploys.
// (A domain's traffic and a site's search results have their own panels:
// traffic.ts, search.ts.)

export type Details = Map<string, ConnectionDetails | Error>;

// The first connection that shows this shape, if it has loaded.
export const detailsOf = <S extends ConnectionDetails["shape"]>(details: Details, shape: S) => {
  for (const d of details.values()) if (!(d instanceof Error) && d.shape === shape) return d as Extract<ConnectionDetails, { shape: S }>;
  return undefined;
};

export function commitLine(c: Commit) {
  const hash = h("span", { class: "hash" }, shortSha(c.sha));
  return h(
    "span",
    { class: "commit" },
    c.url ? h("a", { href: c.url, target: "_blank", rel: "noopener noreferrer", title: "Open the commit" }, hash) : hash,
    h("span", { class: "commit-msg", title: c.message }, c.message),
  );
}

// ── Deploys and commits ─────────────────────────────────────────────────

const PHASE: Record<Deploy["phase"], LampState> = { live: "up", "in-progress": "info", failed: "down", other: "none" };

export function deploysList(d: DeploysDetails, limit = 5) {
  if (d.deploys.length === 0) return empty("No deploys yet.");
  return h(
    "ul",
    { class: "list" },
    d.deploys.slice(0, limit).map((x) =>
      h(
        "li",
        { class: "item" },
        lamp(PHASE[x.phase], { label: x.status.replace(/_/g, " ") }),
        h(
          "div",
          { class: "item-main" },
          x.commit ? commitLine(x.commit) : h("span", { class: "hash" }, x.id),
          h(
            "span",
            { class: "meta" },
            ext(x.url, x.status.replace(/_/g, " ")),
            " · ",
            timeAgo(x.startedAt, "started "),
            x.finishedAt ? ` · took ${duration(Date.parse(x.finishedAt) - Date.parse(x.startedAt))}` : "",
          ),
        ),
      ),
    ),
  );
}

export function commitsList(d: CommitsDetails, limit = 5) {
  if (d.commits.length === 0) return empty("No commits found in these folders.");
  return h(
    "ul",
    { class: "list" },
    d.commits.slice(0, limit).map((c) =>
      h("li", { class: "item" }, h("div", { class: "item-main" }, commitLine(c), h("span", { class: "meta" }, timeAgo(c.at)))),
    ),
  );
}

export function detailsError(err: Error) {
  return h("div", { class: "section-body" }, errorBox(err));
}
