import type { ConfigReport, Finding, FindingSeverity } from "../../../../shared/types.ts";
import { api } from "../../api.ts";
import { h } from "../../dom.ts";
import { busyButton, empty, errorBox, ext, lamp, section, timeAgo, toast } from "../../ui.ts";
import type { LampState } from "../../ui.ts";
import { codeBlock, copyButton } from "../protocolParts.ts";
import type { AppPage } from "./page.ts";

// Configuration: what's set up wrong around the app (its site, its DNS, the
// accounts it's connected to), worst first, each with why it matters and how
// to fix it. Checked daily; "Check again" after fixing something. A finding
// that's fine as it is can be ignored, and stays ignored.

const SEVERITY: Record<FindingSeverity, { label: string; lamp: LampState }> = {
  high: { label: "High", lamp: "down" },
  medium: { label: "Medium", lamp: "attention" },
  low: { label: "Low", lamp: "info" },
};

export const toFix = (r: ConfigReport | undefined) => r?.findings.filter((f) => !f.ignored && f.severity !== "low").length ?? 0;

export function configTab(page: AppPage) {
  const r = page.config;
  if (r instanceof Error) return [section("Configuration", { body: [errorBox(r)] })];
  if (!r) return [section("Configuration", { body: [empty("Loading…")] })];

  const open = r.findings.filter((f) => !f.ignored);
  const ignored = r.findings.filter((f) => f.ignored);
  const count = (s: FindingSeverity) => open.filter((f) => f.severity === s).length;
  const again = busyButton(r.checkedAt ? "Check again" : "Check now", "Checking…", async () => {
    try {
      ({ report: page.config } = await api<{ report: ConfigReport }>("POST", `${page.apiBase}/config/check`));
      toast(toFix(page.config) ? "Checked: see what's left to fix" : "Checked");
    } catch (err) {
      toast((err as Error).message, "down");
    }
    page.draw();
  }, "btn btn--sm");

  const summary = !r.checkedAt
    ? "Checking its site, its DNS and its accounts for the first time…"
    : open.length === 0
    ? "Nothing to fix."
    : [count("high") && `${count("high")} high`, count("medium") && `${count("medium")} medium`, count("low") && `${count("low")} low`].filter(Boolean).join(" · ");

  return [
    section("Configuration", {
      action: again,
      body: [
        h(
          "p",
          { class: "key-line" },
          lamp(!r.checkedAt ? "unknown" : count("high") ? "down" : count("medium") ? "attention" : "up"),
          summary,
          r.checkedAt ? h("span", { class: "meta" }, timeAgo(r.checkedAt, " · checked ")) : null,
        ),
        h("p", { class: "secondary" }, "Its site, its DNS and the accounts it's connected to, checked once a day. Periskopos only reads: each fix is yours to make."),
        r.notes.length > 0 && h("ul", { class: "event-list config-notes" }, r.notes.map((n) => h("li", { class: "meta" }, h("strong", null, `${n.source}: `), n.text))),
      ],
    }),
    open.length > 0 && section("To fix", { list: h("ul", { class: "finding-list" }, open.map((f) => findingItem(page, f))) }),
    ignored.length > 0 &&
      h(
        "details",
        { class: "section provider-details config-ignored" },
        h("summary", null, `Ignored: ${ignored.length}`),
        h("ul", { class: "finding-list" }, ignored.map((f) => findingItem(page, f))),
      ),
  ];
}

function findingItem(page: AppPage, f: Finding) {
  const sev = SEVERITY[f.severity];
  const toggle = busyButton(f.ignored ? "Stop ignoring" : "Ignore", "…", async () => {
    try {
      ({ report: page.config } = await api<{ report: ConfigReport }>("PATCH", `${page.apiBase}/config/findings/${encodeURIComponent(f.id)}`, { ignored: !f.ignored }));
      toast(f.ignored ? "Back on the list" : "Ignored: it won't count any more");
    } catch (err) {
      toast((err as Error).message, "down");
    }
    page.draw();
  }, "btn btn--sm btn--ghost");
  return h(
    "li",
    { class: `finding finding--${f.severity}`, "aria-labelledby": `finding-${cssId(f.id)}` },
    h(
      "div",
      { class: "finding-head" },
      h("span", { class: `tag tag--${f.severity === "high" ? "down" : f.severity === "medium" ? "attention" : "info"}` }, sev.label),
      h("h3", { class: "finding-title", id: `finding-${cssId(f.id)}` }, f.title),
      h("span", { class: "meta finding-source" }, f.sourceLabel),
    ),
    h("p", { class: "secondary" }, f.why),
    h("div", { class: "finding-fix" }, h("span", { class: "label" }, "How to fix"), h("p", null, f.fix.steps)),
    f.fix.code && codeBlock("Copy this", f.fix.code, copyButton(f.fix.code)),
    h(
      "div",
      { class: "finding-foot" },
      f.fix.link ? ext(f.fix.link.url, f.fix.link.label) : null,
      h("span", { class: "meta" }, timeAgo(f.firstSeen, "found ")),
      toggle,
    ),
  );
}

const cssId = (id: string) => id.replace(/[^\w-]/g, "_");
